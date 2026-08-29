# ask: letting the agent ask you something, and then wait

> The mirror image of the same day's `2026-08-15-notifications.md`. That one lets
> the agent **say** something while you are not watching; this one lets it **ask**
> something, and actually stop and wait.

## 1. What this fixes

### 1.1 What happens today when the agent reaches a fork

Three routes, none of them good:

1. **It guesses.** "Do you want this grouped by day or by week?" — a wrong guess
   is ten minutes of wasted work, and usually the wrongness only shows at the end.
2. **It asks in the conversation, and the turn ends.** This one works today, at
   the cost of **breaking its reasoning**: the model writes the question out as a
   paragraph, wraps up the turn, waits for you to type, and then starts a fresh
   round of reasoning from scratch. The context it was halfway through building is
   not gone, but it has to be assembled again.
3. **An external Claude Code cannot reach a person at all.** An agent running in a
   terminal drives Peek's window over MCP, but what it faces is a stdout, and the
   person sitting in front of the Peek window is out of its reach. PLAN §7 says
   "an external client can watch and drive the embedded one" — it can read the
   conversation, send messages, even answer permission prompts for the operator;
   the one thing it cannot do is **ask something and wait for the answer**.

### 1.2 Peek already has half of it

"An agent stops and waits for a person" is something Peek does thoroughly; there
is just one way to trigger it today:

| what exists | where |
|---|---|
| a broker with a queue, a timeout, and a guarantee of settling exactly once | `main/agent/permissions.ts` |
| a Workspace field for "this conversation is waiting on you" | `ChatViewState.pendingPermission` |
| the prompt panel above the composer, with focus and a11y worked out | `renderer/components/chat/PermissionPrompt.tsx` |
| the command a human answers with, which **refuses to let the agent answer** | `chat.respondPermission` |
| "it is waiting on you" also sends a system notification | `turnNotice` in `chat-host.ts` |

What is missing is **the trigger**. The existing one is **protocol-initiated**:
ACP's `session/request_permission` asks "may I call this tool". The answer is a
**permission**.

ask is **agent-initiated**: "which direction should I take". The answer is
**information**, and it goes straight into the model's next step of reasoning. One
skeleton, two meanings — and §2.6's rule about who may answer is harder than
permission's precisely because of that difference.

### 1.3 Boundary

Doing: one MCP tool, `ask`, one question at a time, 2–4 options, with Peek adding
an "other" so the person can write their own; the question is drawn in the chat
panel (in the same place as the permission prompt); the agent hangs there waiting
until somebody answers or it times out.

Not doing:

- **No asking several questions at once.** Claude Code allows up to four; Peek does
  one first. The reason is not laziness: the permission prompt speaks the language
  of "one at a time, the rest queued" (`2026-08-03-concurrent-permission-prompts.md`
  is about nothing else), and four questions on screen at once would fight with
  it. A queue already handles asking several in a row.
- **No "remember my choice".** That is permission's `allow_always`, and what it
  remembers is an **authorisation rule**. The answer to a question is not a rule —
  "by week this time" does not imply "by week from now on".
- **Nothing is pushed into the transcript.** The transcript belongs to the agent
  (`2026-08-03-chat-history-ownership.md`) and Peek cannot push into it. Nor does
  it need to: this is a tool call, and the panel already draws it as a
  `ToolCallCard`, question and answer inside.
- **No input form other than free text** (no date picker, no slider). Options plus
  one text field.

## 2. The plan

### 2.1 The shape in the Workspace

`ChatViewState` grows a second "waiting on you" field:

```ts
interface PendingQuestion {
  /** ties `chat.answer` back to the suspended tool call. */
  requestId: string
  /** the question itself. One line, because it is the largest line of text on the panel. */
  question: string
  /** a 3–12 character category label, as in Claude Code's header. Optional. */
  header?: string
  options: QuestionOption[]
  /** allow multiple selection. Single by default. */
  multiSelect: boolean
  askedAt: number
}

interface QuestionOption {
  optionId: string
  label: string
  /** what this option means / what it costs. */
  description?: string
}
```

**"Other" is not in `options`**; it is an entry point the UI adds
unconditionally. The reason: it is not an option the agent supplied, it is **this
mechanism admitting it may not have thought of everything**. Putting it in
`options` would make the agent feel it can decide whether to offer that exit — and
that decision is not its to make.

`ChatAgentStatus` gains a member, `'awaiting-answer'`. That union is closed, so
adding a member makes every `switch` fail to compile — which is exactly what is
wanted: the status bar's colour, the composer's lock, the i18n copy,
`turnNotice`'s criterion, each has to be looked at once.

**Why not reuse `awaiting-permission`**: those two states say different things on
screen ("waiting for you to confirm" against "waiting for you to answer"), and a
reader of `read_workspace` — another agent included — has to be able to tell "the
window is stuck on an authorisation" from "the window is stuck on a question". The
former it may be able to answer for the operator (`control_chat`); the latter,
never (§2.6).

### 2.2 Two commands

```
chat.ask     { viewId, question, header?, options[], multiSelect? } → { requestId, answered, selected[], other?, reason? }
chat.answer  { viewId, requestId?, optionIds[], other? }            → { requestId, answered }
```

**Both are `read` handlers**, one that suspends and one that does not. This only
became clear during implementation and is worth writing down: neither changes the
Workspace directly. The question **goes up on screen and comes off it through the
broker's `onActive` callback** (§2.4), the same event path permission takes today
— `chat.answer` only settles the broker, and the callback does the field's removal
and the status's restoration. Having `chat.answer` `reduce` as well would give one
event two write points.

`viewId` **is required at the command layer**, even though the `ask` tool allows
it to be omitted: opening a new panel **mints** an id, and a single command cannot
both mint and use one in the same call. The tool dispatches a `view.open` first in
`toCommands` and then passes the id down — `send_chat` already does this, and the
comment is right there. That is usually the situation an external Claude Code is
in when it asks: it has no panel, and the question needs somewhere to land.

### 2.3 Why `chat.ask` may suspend when `chat.send` may not

The header comment on `bus/handlers/chat.ts` states a discipline explicitly:

> Chat effects do **not** go through `EffectIntent` / `runIntents`, and that is not a
> shortcut. […] a command that blocks until the turn ends is a deadlock waiting for a
> slow enough tool call.

That **has not been overturned, and `chat.ask` does not violate it**, because the
operative words in it are *until the turn ends*. Put side by side, the difference
is structural:

| | who waits | for what | who can move meanwhile |
|---|---|---|---|
| `chat.send` if it blocked | **Peek's command** | a whole turn to end | inside the turn the agent calls back into MCP, and those calls go through the bus too — Peek waits on the agent, the agent waits on Peek |
| `chat.ask` blocking | **the agent's own tool call** | one person clicking once | the bus as usual. The user clicks the interface, runs queries, even opens another conversation, all unaffected |

The bus does not serialise across commands in the first place (the first section
of the same header comment is about exactly this: `A.reduce → A.effects (await) →
B.reduce → …`). A suspended `chat.ask` occupies nothing — **the waiting party is
the agent itself**, and waiting is precisely what it should be doing.

That `chat.ask` uses `read` rather than `reduce` is a direct consequence of the
same discipline: `reduce` runs inside a synchronous immer `produce` and can never
await. So how does the question get on screen? See below.

### 2.4 `QuestionBroker`: the question reaches the screen by the event path, not by a command

Exactly the same structure as `PermissionBroker`: register → write
`pendingQuestion` into the store through the `onActive` callback → the caller
awaits `ticket.answer`.

"The broker writes to the store directly" is not a shortcut; it is a rule Peek has
already set. The header comment on `createChatStateApplier` in `chat-host.ts`
argues it:

> these patches are **events from a subprocess reporting what already happened**, not
> requests to change something […] `createResultEventSink` — driver-host events write
> straight into the store rather than round-tripping through the bus.

"A question is now hanging on the screen" is a fact of the same kind.

**Where it lives: in neither agent backend.** There are two `PermissionBroker`
instances, one in `AcpManager` and one in `EndpointManager`, because a permission
request comes from the **backend protocol**. ask does not: the asker is an MCP
tool call, which may come from the embedded agent or from a Claude Code in a
terminal, and neither belongs to any backend. So there is **one `QuestionBroker`
per window**, assembled in `main/index.ts`, and `chat.ask`'s handler receives it by
injection — the same wiring as `createChatHandlers(runtime)` and
`createAppHandlers(notifier)`.

**Why `PermissionBroker` is not generalised into a shared parent of the two**, even
though the queue, the timeout and the settle-once are genuinely the same
machinery:

1. **The timeout means the opposite.** A permission timeout must answer
   `cancelled` — "nobody agreed" is semantically not authorised, which is
   `permissions.ts`'s header comment, "An absent user is not a consenting user". A
   question's timeout answers "nobody answered", and the agent **should decide for
   itself** whether to continue or stop — a flat refusal is wrong here, because
   there is nothing to refuse.
2. **The cancellation-reason sets differ.** Permission has `turn-cancelled` /
   `agent-gone` / `shutdown`; a question has one more, "the tool call that asked it
   went away".
3. **Rule of three.** The permission path has a design document of its own and a
   whole test suite pinning it. Touching it to save about sixty lines buys an
   abstraction that has to satisfy two sets of semantics at once — abstract when the
   third "stop and wait for a person" turns up, because only then is it clear what
   to abstract.

### 2.5 The MCP tool `ask` (the 15th)

```
ask { question, header?, options[], multiSelect?, viewId? }
  → { answered: true, selected: [{optionId, label}], other?: string }
  → { answered: false, reason: 'timeout' | 'cancelled' }
```

`annotations`: `readOnlyHint: false` (it changes the window, and it occupies a
person's attention), `idempotentHint: false` (asking twice is interrupting twice),
`openWorldHint: true`.

Three things the description has to make clear, the same class of work as
`notify`'s — what decides "when should I ask" is the model:

- **Do ask**: at a fork where both routes are defensible and the wrong one means
  redoing the work; a fact only the user knows ("which one is production").
- **Do not ask**: what you could find out yourself (`read_workspace` is right
  there); confirmation out of politeness ("may I start?"); splitting one decision
  into five small questions in a row.
- **It will suspend you**: this tool call waits for a person to actually look up,
  and times out after five minutes with nobody answering. When you are unsure,
  picking a route and saying which one you picked is better than stopping here to
  wait.

### 2.6 Who may answer: the third `source` policy on the bus

`chat.answer` **refuses `source === 'agent'` unconditionally**.

`2026-08-02-agent-source-and-permission-scope.md` §3.2 explicitly rejected "add a
`HUMAN_ONLY_COMMANDS` table", on the grounds that it "disguises a policy as a
table, which invites whoever comes next to add rows, and every row is a policy
decision made without an argument". So this is not a row added to a table, it is a
third place where a policy is written out with its reason — the reason follows,
and it is harder than permission's:

An agent answering a permission prompt leaks an **authorisation**. An agent
answering a question forges **a person's judgement**: what the user will see is a
decision marked "the person was asked", when in fact nobody ever looked at it. Every
step the model takes afterwards rests on that answer, and it is itself the answer's
author.

An external operator (`source: 'mcp'`) **may** answer, consistent with permission
and for the same reason: PLAN §7 says the token amounts to full control over the
window and every connection in it, so there is nothing to gain by restricting a
client that holds the token. The embedded agent uses a different credential
(`agentToken`), which is the entire purpose of that document's §2 establishing
`source: 'agent'`.

### 2.7 How this joins up with notifications

`turnNotice` (`chat-host.ts`) recognises two kinds of "it is your move" today: a
turn ended, and stuck waiting for permission. `awaiting-answer` is a third, and it
is the one of the three that most deserves to call for a person — learning five
minutes late that a turn ended costs five minutes, while learning five minutes
late that it is stuck on a **question with a timeout** means the question expired
and the agent carried on holding "nobody answered".

The copy: `${label}：agent 在问你一个问题`, with the question itself as the body.

## 3. Trade-offs

**Why a tool rather than a kind of message.** The embedded agent can already write
"which one do you want?" inside a turn. But then the answer can only come back as
the next user input, which means **this turn has to end first**. A tool call's
answer goes straight back into the model's hands and the reasoning does not break.
It is also the only possible shape this feature could take for an external Claude
Code — there is no such thing as "the next user input" there.

**Why "other" is always there.** A question that only allows a pick from three
options, when none of them is right, forces a person to pick the least bad one,
after which the agent confidently does the wrong thing holding that answer. The
cost of providing an exit is one text field.

**Why a five-minute timeout rather than none.** The same budget as `permissionMs`,
for the same reason: a tool call that hangs and never returns ties up the agent's
session, and the person may have gone home. What a timeout returns is
`answered: false`, not a fabricated answer.

**Why not "Peek itself can ask questions too".** For instance "this query will run
for 40 seconds, continue?". Tempting, but a completely different thing: it has to
hold with no agent present, whereas this whole chain (the tool call suspends, the
answer returns to the model) is built on there being an agent waiting.

**Known limitation: the language of the question's text is the agent's decision.**
Peek only draws it. The same thing the notify document records — main has no
language. The difference is that it matters even less here: the question and the
options are written by the agent, in the language it is already speaking to you.

## 4. Relationship to the existing design

| document | what changes |
|---|---|
| PLAN §6's command table | 37 → 39 (`chat.ask` / `chat.answer`), two verbs added to the `chat.*` line |
| PLAN §7's tool roster | 14 → 15, one line added for `ask` |
| `2026-08-02-agent-source-and-permission-scope.md` | a section added after §2.3: `chat.answer` is the third source policy, argued in §2.6 here. §3.2's "no table" conclusion is unchanged |
| `bus/handlers/chat.ts`'s header comment | "effects are always fire-and-forget" gains a sentence bounding the exception: a `read` may suspend for **its own caller**, see §2.3 here |
| `2026-08-15-notifications.md` §2.4 | `turnNotice`'s criterion goes from two kinds to three |

## 5. Verification

**Unit tests** — `bus/__tests__/ask.test.ts`, 19 of them, all green. Against a real
Command Bus, not a mocked one.

| what it tests | how |
|---|---|
| the question reaches the screen | after `chat.ask`, `pendingQuestion` is in the Workspace and the status is `awaiting-answer` |
| the answer reaches the caller | after `chat.answer` the suspended `chat.ask` resolves, carrying the option's label back and not only its id |
| answering hands the panel back | the field is cleared and the status is no longer `awaiting-answer` |
| "other" | with only `other` filled, `selected` is empty and the free text comes back verbatim |
| an option plus a condition | "the second one, but only for the EU part" — both come back together, not one or the other |
| **the agent cannot answer for you** | `source: 'agent'` is refused with `BAD_REQUEST`, **and the prompt is still standing** (the refusal did not swallow the question) |
| an external operator can answer | `source: 'mcp'` passes — the reverse case, without which that rule is untested in the direction that matters |
| an unknown option | an id not in `options` is refused, the prompt does not move |
| single select refuses two answers / multi select accepts them | one case each |
| a stale answer | a mismatched `requestId` gives `CONFLICT` |
| answering when nothing was asked | `CONFLICT` |
| a duplicate optionId | refused before it reaches the screen |
| the turn is cancelled | after `chat.cancel` the suspended call returns `answered: false` and the field is cleared |
| the view is closed | as above |
| timeout | run with a 5 ms budget, get `answered: false, reason: 'timeout'` |
| the queue | ask twice in a row: the second does not reach the screen; it takes over only once the first is answered (a **replacement**, not a clear) |
| a queued question is not on the clock | a broker unit test: advance the clock 8 seconds and the one at the back of the queue has still not started timing |
| settling exactly once | a second `resolve` and a subsequent `cancel` both return false |
| shutdown | `cancelAll(null, 'shutdown')` settles the ones on both chats |
| the status union is closed | with `awaiting-answer` added, every `switch` still compiles (enforced by TS) |
| every control on the prompt is human-only | a new case in `control-spec.test.ts`, alongside the one for the permission prompt — and asserting more strictly: **every** button must say `human-only` explicitly, not merely lack `agent-ok` |

**A real bug found and fixed during implementation**: `chat.cancel` looked only at
`pendingPermission` when deciding whether there was anything to stop. A
conversation hanging on a question has no `streamingMessageId` and is not in a busy
state, so **pressing stop reported that there was nothing to stop** — exactly when
the user most wants out. The criterion now reads "something is waiting on a
person", and both kinds of prompt count.

**By hand**

1. Have the embedded agent ask a question ("use ask to ask me whether I want it by
   day or by week") → the options appear on the panel, the composer locks, and after
   a click the agent carries on without starting a new turn.
2. The same thing, switched to another app → a system notification says it is
   asking you something; clicking the notification returns to that panel.
3. Fill in only "other" → what the agent gets is the sentence you wrote.
4. Ignore it for five minutes → the prompt disappears and the agent says nobody
   answered.
5. An external `claude` calls `ask` over MCP with no chat panel open in Peek → one
   is opened, and the question is drawn in it.
