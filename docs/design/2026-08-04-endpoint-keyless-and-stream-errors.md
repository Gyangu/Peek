# Two holes in the endpoint backend: keyless cannot send, and failures are swallowed

`docs/design/2026-08-03-chat-history-ownership.md` §6.3 recorded two defects it
deliberately did not fix at the time. This document fixes them, and along the way
settles `#onAgentEvent`'s event contract — which is the thing §6.3 said "deserves
being checked over on its own".

---

## 1. What this fixes

### 1.1 Defect one: an endpoint with no API key cannot send a request

In `createProvider` in `endpoint/provider.ts`:

```ts
resolve: () => Promise.resolve(apiKey === null || apiKey === '' ? { auth: {} } : { auth: { apiKey } })
```

`{ auth: {} }` was meant to say "this endpoint needs no authentication". But both
of pi-ai's api implementations carry a precondition that **throws outright** when
there is neither an `apiKey` nor an authentication header:

| file | function | headers accepted |
| --- | --- | --- |
| `api/openai-completions.js:31` | `getClientApiKey` | `authorization`, `cf-aig-authorization` |
| `api/anthropic-messages.js:158` | `assertRequestAuth` | `authorization`, `x-api-key`, `cf-aig-authorization` |

Both are `throw new Error('No API key for provider: ...')`.

The consequence is that the scenario `provider.ts`'s header states it supports —
"vLLM on a workstation, Ollama on a laptop", which is also what
`2026-08-03-pluggable-agent-backends.md` §1 lists as a founding reason and §5 step
4 has as the first item on its verification list — **cannot be used even when
configured**.

### 1.2 Defect two: a failure is collected into an empty assistant bubble

`#onAgentEvent` in `endpoint/loop.ts` recognises four kinds of event and takes
`default: return` for the rest. The throw above never becomes a rejection of
`prompt()`, so `#fail` never fires and `#settle` collects the turn into an
**empty assistant message**, with the state returning to `idle`. The user sees the
model "answer with nothing", and the log holds not a word.

### 1.3 A correction: §6.3 described the failure's arrival wrongly

§6.3 says "pi-ai pushes it into the stream as an `error` event
(`{type:'error', reason:'error', error:{errorMessage}}`), where `#onAgentEvent`
discards it". Having read both libraries' implementations, the second half of that
chain does not hold. The full chain as measured:

1. pi-ai's `stream()` `catch` (`openai-completions.js:442`) writes the exception
   into the assistant message itself:
   `output.stopReason = signal.aborted ? 'aborted' : 'error'`,
   `output.errorMessage = formatProviderError(...)`, then
   `stream.push({ type: 'error', reason: output.stopReason, error: output })`.
2. That `error` is an **`AssistantMessageEvent`**, not an agent event.
   pi-agent-core's `streamAssistantResponse` (`agent-loop.js:229`) merges `done`
   and `error` **into one branch consumed internally**: `await response.result()` —
   and `AssistantMessageEventStream.result()` **resolves `event.error` for an
   `error` event rather than rejecting** — then emits `message_start` (if it has
   not already) and `message_end`, returning that message.
3. `runLoop` (`agent-loop.js:108`) sees
   `message.stopReason === 'error' || 'aborted'`, emits `turn_end` and `agent_end`,
   and **returns normally**.
4. `Agent.prompt()` therefore resolves normally.

Which is to say: **a top-level event with `type === 'error'` cannot appear in
`#onAgentEvent` at all** — `pi-agent-core`'s `AgentEvent` union has no such member
(`types.d.ts:368`). The only form in which a failure reaches peek is **an assistant
message on `message_end` with `stopReason === 'error'` and an `errorMessage`**.

This correction has practical consequences: adding a `case 'error':` branch
literally as §6.3 describes leaves the empty bubble exactly as it is.

### 1.4 A third thing established along the way: `message_start` is not only an assistant's

`agent-loop.js` emits `message_start` / `message_end` for the user prompt (:52),
steering messages (:98) **and** tool result messages (`emitToolResultMessage`,
:545). Today `#onAgentEvent` translates every `message_start` into
`assistant_start`, and duplicate bubbles are avoided only because
`EndpointTranslator.#startMessage` returns `EMPTY` for a message that is already
open.

That luck runs out in this change: once `message_end` is recognised, it must be
filtered by `role` first, or a tool result's `message_end` closes the assistant
bubble early.

### 1.5 Boundary (explicitly not done)

- **The ACP backend is untouched.** Its event contract is in `acp/translate.ts`,
  and all this change borrows from it is a **style** of disposition.
- **`message_end` does not close the assistant message**; closing stays with
  `#settle` / `#fail`. Reasoning in §3.3.
- **No configuration for the endpoint's authentication scheme** (bearer /
  `x-api-key` / a custom header). The first version still has just two states,
  "has a key" and "has no key".
- **The settings panel does not change**, and no "this endpoint needs no
  authentication" checkbox is added. An empty key is that checkbox.
- **No retrying.** A failure is reported once, and whether to retry is the user's
  business.

---

## 2. The plan

### 2.1 Defect one: a sentinel `authorization` header when there is no key

`endpoint/provider.ts`:

```ts
/** The sentinel pi-ai itself uses for "a header but no key" is "unused". */
const KEYLESS_AUTHORIZATION = 'Bearer unused'

resolve: () =>
  Promise.resolve(
    apiKey === null || apiKey === ''
      ? { auth: { headers: { authorization: KEYLESS_AUTHORIZATION } }, source: 'keyless endpoint' }
      : { auth: { apiKey }, source: 'Chat endpoint API key' },
  ),
```

`ModelAuth` (`pi-ai/dist/auth/types.d.ts`) has a `headers` field already, which is
pi-ai's opening for providers whose authentication cannot be expressed as an
apiKey. Both apis' preconditions accept `authorization`, so one header covers both
`openai-completions` and `anthropic-messages`.

`hasHeader` is case-insensitive and requires a non-empty string, so a lowercase key
and `'Bearer unused'` are both legal.

What actually goes out on each path once this is in:

- **openai-completions**: `getClientApiKey` sees the header and returns the string
  `"unused"` as the apiKey, so the OpenAI SDK writes
  `Authorization: Bearer unused`; then `createClient` `Object.assign`s
  `optionsHeaders` into `defaultHeaders` last, and our header overwrites it. The
  two values are identical, so it does not matter which wins.
- **anthropic-messages**: `assertRequestAuth` only asserts and does not fill in, so
  `apiKey` stays `undefined`, `createClient` receives `apiKey ?? null`, and the
  Anthropic SDK writes no `x-api-key`. Only our `authorization` header goes out.

### 2.2 Defect two: the event contract goes from "recognise four" to "enumerate ten"

A new pure function, in `endpoint/events.ts` — already this backend's home for
translation, and doing no I/O, so tests can feed it literals:

```ts
export type AgentEventOutcome =
  /** One peek event to feed the translator. */
  | { kind: 'event'; event: EndpointEvent }
  /** Upstream declared this turn dead. `message` is pi-ai's errorMessage, unsanitised. */
  | { kind: 'failed'; message: string }
  /** The stream was aborted. cancel() has usually closed up already; this is the backstop. */
  | { kind: 'aborted' }
  /** An event peek knows it does not render. For diagnosis only; never throws. */
  | { kind: 'ignored'; reason: string }

export function classifyAgentEvent(raw: unknown): AgentEventOutcome
```

All ten members of `AgentEvent` are named individually, with no `default` to fall
silent into:

| event | disposition |
| --- | --- |
| `message_start` | `role === 'assistant'` → `assistant_start`; otherwise `ignored` (one each for the user prompt, steering and tool results) |
| `message_update` | `text_delta` → `text`; `thinking_delta` → `thinking`; anything else `ignored` |
| `message_end` | `role === 'assistant'` and `stopReason === 'error'` → `failed`; `'aborted'` → `aborted`; otherwise `ignored` |
| `tool_execution_start` | `tool_start` |
| `tool_execution_end` | `tool_end` |
| `agent_start` / `turn_start` / `turn_end` / `agent_end` / `tool_execution_update` | `ignored`, each carrying its own name |

`turn_end` carries the same `stopReason === 'error'` message, but it is emitted
after `message_end`; recognising the earlier one is enough, and recognising both
reports the error twice.

### 2.3 `loop.ts`'s `#onAgentEvent` becomes thin

```ts
#onAgentEvent(session: Session, raw: unknown): void {
  const outcome = classifyAgentEvent(raw)
  switch (outcome.kind) {
    case 'event':
      if (outcome.event.type === 'tool_end' && session.blocked.delete(outcome.event.id)) return
      this.#feed(session, outcome.event)
      return
    case 'failed':
      if (!session.streaming) return
      this.#fail(session, this.#endpointError(outcome.message))
      return
    case 'aborted':
      this.#settle(session, 'cancelled')
      return
    case 'ignored':
      return
  }
}
```

The `blocked` check stays with the host, because "who refused which call" is the
host's state and a pure function should not know it.

There is no race in the sequencing: `#fail` sets `session.streaming` false
synchronously, so when `prompt()` later resolves into `.then(() => this.#settle(...))`,
`#settle`'s `if (!session.streaming) return` makes it a no-op. `aborted` likewise —
`cancel()` closed up long before, and this `#settle` is an idempotent backstop.

### 2.4 `#endpointError`: turning upstream's sentence into a peek error

```ts
#endpointError(raw: string): PeekError {
  const message = raw.trim() || 'The chat endpoint returned an error.'
  // The endpoint is configured keyless and the far side is talking about auth — say so.
  const hint = this.#config.apiKey === null && LOOKS_LIKE_AUTH.test(message)
  return {
    code: 'CONNECTION_FAILED',
    message: 'The chat endpoint could not answer.',
    detail: hint ? `${message}\n\nThis endpoint is configured without an API key.` : message,
  }
}
```

`#fail` already handles `redact` plus `sanitizeLine`, so handing over the original
text is enough here.

That hint is the antidote to §2.1's cost: `Bearer unused` turns a third-party
endpoint that **does** need authentication from "pi-ai says you have no key
configured" into "the far side returned 401", which would drop the diagnostic
quality by a step. This line restores it, and not by guessing — "the user did not
fill in a key" is a fact peek knows for certain, and only the wording leans on a
regular expression.

---

## 3. Trade-offs

### 3.1 Why a sentinel header rather than something else

- **Not an empty apiKey.** `provider.ts`'s existing comment is right: some servers
  reject `Authorization: Bearer `. And `getClientApiKey` tests with `if (apiKey)`,
  so an empty string throws anyway.
- **No fork and no patch of pi-ai.** That precondition is its deliberate design,
  and the header is the opening it left.
- **Not deciding whether to inject by whether the baseUrl is a loopback address.**
  "Keyless can only happen on localhost" is false — a company gateway on the LAN,
  or a self-hosted inference machine on Tailscale, may equally need no
  authentication, and choosing by address would make those configurations fail as
  "pi-ai says you have no key configured", which is harder to diagnose than today.

### 3.2 Does that fake credential harm a real third-party endpoint

Three separate things:

1. **Zero disclosure risk.** `"unused"` is a sentinel literal in pi-ai's public
   source, not anybody's secret.
2. **It is sent exactly to the URL the user typed.** That same request already
   carries the whole conversation, and a bearer whose value is `unused` is the
   least sensitive byte in it.
3. **The one real cost is diagnostic quality**: an endpoint that genuinely needs
   authentication goes from "refused locally" to "the far side returned 401/403".
   §2.4's hint exists for exactly this, and it has nowhere to be said until defect
   two is fixed and errors can reach the user — the two holes converge here.

Conclusion: it can be sent, but §2.4's line has to ship with it. Fixing defect one
alone is a net loss.

### 3.3 Why `message_end` does not close the assistant message

It looks "more correct" — each assistant message closing itself. But
`agent-loop`'s order is `message_end` (assistant) → run the tools →
`message_start`/`message_end` (tool result) → the next turn. If `message_end`
closed the message, `tool_execution_start` would open a **second** assistant
bubble, and the tool rows would land in a bubble separated from the answer they
belong to; `EndpointTranslator.#finish` would also clear `#calls`, so the later
`tool_end` would be lost entirely for lack of an existing record
(`#settleTool`'s `if (!existing) return EMPTY`).

Closing stays with `#settle` / `#fail` — the semantics already in use today, and
untouched here.

### 3.4 Unknown events: reported as `ignored`, never thrown

Aligned with `acp/translate.ts`, whose `handle()` comment reads "Never throws: a
shape peek does not know is reported through `ignored`, not raised", and whose
`default` branch names each known-but-not-yet-rendered update individually. The
same reasoning weighs more here: this is a subscription callback, and throwing lands
it in `pi-agent-core`'s event dispatch, where whether it is caught is not peek's
decision.

The difference is **exhaustiveness**. `translate.ts`'s `default` is "name it and
return the name"; here there are ten explicit branches, because `AgentEvent` is a
closed union of ten members, and exhaustiveness lets TypeScript complain when a
library upgrade adds a member, whereas a `default` lets a new member fall quietly
into `ignored` — which is where both of this document's defects came from.

### 3.5 Why the classification is a pure function in `events.ts`

Consistent with `acp/`'s division of labour: `translate.ts` pure, `manager.ts`
dirty. Today this decision lives in a private method of `EndpointManager`, and
testing it means constructing an `Agent` first. Moved into `events.ts`, the
contract — which events are recognised, and how an unknown one is disposed of — can
be asserted against ten literals. And that contract is precisely what §6.3 said
needed checking over on its own; it deserves a test watching it.

---

## 4. Verification

### 4.1 Unit: `endpoint/__tests__/events.test.ts`

Against `classifyAgentEvent`:

- an assistant's `message_start` → `assistant_start`; a user's or a tool result's
  `message_start` → `ignored` (this case is the retirement certificate for §1.4's
  luck).
- `message_end` with `stopReason: 'error'` and an `errorMessage` →
  `{kind:'failed'}`, carrying the original text unaltered.
- `message_end` with `stopReason: 'aborted'` → `{kind:'aborted'}`.
- a normally finished `message_end`, and a tool result's `message_end` → `ignored`,
  **not** `failed`.
- `agent_start` / `turn_start` / `turn_end` / `agent_end` /
  `tool_execution_update` each `ignored` with their own name as the `reason`.
- entirely unfamiliar shapes (`{type:'brand_new'}`, `null`, `42`) → `ignored`,
  without throwing.

### 4.2 Unit: `endpoint/__tests__/lifecycle.test.ts`

- keyless (`apiKey: null`), and the provider `buildEndpointModel` constructs has
  `auth.apiKey.resolve()` handing back `headers` carrying `authorization`; with a
  key it hands back `apiKey` and **no** such header.
- after one turn against an unreachable endpoint (`http://localhost:1`, nothing
  listening): `status` is `error` (not `idle`), `notify` received one entry at
  `level: 'error'`, the assistant message in the transcript has
  `stopReason === 'error'`, and the user's own message is still there. This one runs
  the real pi-ai stack and pins the "empty bubble" symptom directly.
- a stub server stood up on the spot that only ever returns 401: the error detail
  carries both the far side's original text (`Incorrect API key provided.`) and
  §2.4's hint. This is the receipt for §3.2's trade.
- the negative: the unreachable endpoint does **not** carry that hint — it has
  nothing to do with keys, and attaching it would point in the wrong direction.

### 4.3 End to end: `scripts/verify-chat-restore.mjs` drops `sealKey`

That script currently seals a fake key with `sealKey()` to work around defect one,
with a comment on the helper pointing straight at §6.3. Once fixed, that whole
passage goes: `writeSettings` no longer writes `endpointApiKeySealed`, and the
script no longer needs a second Electron start just to produce a `safeStorage`
ciphertext.

Once deleted, it becomes defect one's regression test in itself — the script
passing means a keyless endpoint can send a request.

```bash
cd apps/desktop && npm run build && node scripts/verify-chat-restore.mjs --verbose
```

Measured: all four steps green, with no key anywhere in `settings.json`
throughout.

### 4.4 Verification not done

No end-to-end script is added for the `anthropic-messages` path. The stub model
speaks only the OpenAI-compatible protocol, and building a second stub speaking the
Anthropic protocol for one assertion does not pay for itself; both paths share the
one header from §2.1, and that `assertRequestAuth` accepts it was confirmed by
reading the source, recorded here.

---

## 5. Written back

- `2026-08-03-chat-history-ownership.md` §6.3's heading loses "**not fixed**", its
  body points at this document, and §1.3's correction to how the failure arrives is
  applied — that document is a decision record of its time, and leaving the wrong
  mechanism in it would lead the next person to add a `case 'error':` from it.
- The long comment on `sealKey` in `scripts/verify-chat-restore.mjs` is deleted with
  the function.
