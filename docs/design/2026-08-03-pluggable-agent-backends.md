# Pluggable agent backends: ACP (Claude Code / Codex) + a self-configured LLM endpoint

## 1. What this fixes

### 1.1 Where things stand

The chat panel can only run Claude Code, and it is welded in:

| site | what is welded |
| --- | --- |
| `AGENT_PACKAGE_ENTRY` in `acp/agent-process.ts` | the constant `@agentclientprotocol/claude-agent-acp/dist/index.js` |
| `start()` in `acp/agent-process.ts` | `spawn(process.execPath, [entryPath])` + `ELECTRON_RUN_AS_NODE=1` — assumes the agent is a Node entry module |
| `buildAgentSessionMeta()` in `acp/session-config.ts` | `_meta.claudeCode.options` — the Claude Code SDK's own sandbox switches |
| `acp/manager.ts` | `PEEK_CLAUDE_CODE_EXECUTABLE`, `AcpHostConfig.claudeCodeExecutable` |
| the copy in `agent-process.ts` / `errors.ts` | "The Claude agent process exited" |
| `docs/PLAN.md:31` | "Embedded agent \| @agentclientprotocol/sdk + a claude-agent-acp subprocess" |

The user has no configuration entry point at all: `config/settings.ts` holds only `mcpPort` /
`executionTimeouts` / `uiZoom`. `agentEntryPath` is an internal field, and only the tests use it, to
point at `__tests__/stub-agent.mjs`.

### 1.2 The problem

1. **The agent cannot be swapped.** Running Codex means editing the constant, the `_meta`, the way
   it is spawned, and the copy.
2. **Bringing your own model is a hard gate.** peek is a database viewer, yet its chat panel demands
   the user first install and log into Claude Code. A user may already have an OpenAI-compatible
   endpoint on hand (self-hosted vLLM, a company gateway, OpenRouter, Ollama) with no way to plug it
   in.

### 1.3 Boundary

**Done:** two agent backends, with the shared layer pushed down.

- **The ACP backend** — an external subprocess, supporting Claude Code and Codex, each with its own
  profile.
- **The endpoint backend** — an in-process agent loop (`pi-agent-core` + `pi-ai`) talking directly
  to the LLM the user configured.
- Agent configuration in the settings panel; credentials into `SecretVault`.

**Not done:**

- No concurrent agents, and no resuming a session's history across backends.
- No model-list fetching for the endpoint (the first version has the model id typed in by hand).
- Permission gate semantics, attachment parsing and rendering, and the MCP tool surface are all
  untouched — those three are shared by both backends, and are exactly what this change pushes down.
- `CommandSource` is untouched: commands from either backend are `source: 'agent'`.

---

## 2. Conflicts with the existing design

Per the repository's convention, the conflicts come first. **A has an answer already; B and C need
confirming.**

### Conflict A — the sandbox guarantee's grounds have to be written three times (answered already, awaiting ratification)

The guarantee in `2026-08-02-agent-source-and-permission-scope.md` §2.2 is: the external MCP token
sits in `~/.peek/mcp.json`, an agent session is `tools: []` and so has no file-reading tool, and
therefore the agent cannot forge `source: 'agent'`. The **grounds** for that guarantee are the
Claude Code SDK's `_meta` switches.

The three backends' grounds differ, and so does their strength:

| backend | sandbox grounds | strength |
| --- | --- | --- |
| Claude Code | `_meta.claudeCode.options`: `settingSources: []`, `tools: []`, `disallowedTools` | verified by `verify-chat-security.mjs` |
| Codex | the environment variable `INITIAL_AGENT_MODE=read-only` (a `codex-acp` runtime option) | the semantics line up, but **an equivalent probe has to be written for it** before it counts |
| endpoint | peek registers only its own tools — **no file or shell tool implementation exists in the process at all** | the strongest: not "please, SDK, restrain yourself", but "the capability does not exist" |

So §2.2's phrasing has to change from "because `tools: []`" to "each backend's grounds are in this
table". The endpoint backend, if anything, is what makes that guarantee real.

**Implemented (awaiting ratification):** Codex's profile is marked `sandbox: 'unverified'`, and the
settings panel says outright that peek has not verified that backend's sandbox.
`2026-08-02-agent-source-and-permission-scope.md` §2.2 has already been changed to this
three-backend table.

### Conflict B — PLAN.md's technology-choice line (settled: neutral phrasing)

PLAN.md:31 writes `claude-agent-acp` in as a settled choice, and §324's narrative is likewise
"Claude Code runs as a subprocess behind ACP". After this it becomes one of two backends.

**Conclusion: change it to neutral phrasing.** The choice line becomes "pluggable agent backends: an
ACP subprocess / a built-in endpoint loop", §324's narrative becomes "the chat panel runs on a
pluggable agent backend", and Claude Code is demoted to one profile among them. PLAN.md does not
carry any particular profile's details; those stay in this document.

### Conflict C — the granularity of "one session = one agent" (settled: fixed per session)

In `2026-08-02-chat-session-management.md` a session's identity is `agentSessionId`, which is the key
to the history on the agent's side. The three backends store history in completely different places
(Claude and Codex each under their own cwd, and the endpoint backend has to be stored by peek
itself), so restoring across backends is impossible.

**Conclusion: each session fixes its backend at creation; the list interleaves them and each is
resumable on its own.** Changing the agent in settings affects **new** sessions only; an existing
session keeps opening with the backend it was created with. The design consequences are in §3.5.

---

## 3. The plan

### 3.1 Where to cut

`translate.ts` already translates ACP's `SessionUpdate` into core's neutral types (`ChatDelta` +
`ChatAgentStatePatch`), and the render layer, the batcher and the permission prompt all know nothing
but those two. **The abstraction is cut here**, with no need to raise it further.

```
UI ◄── ChatDelta ◄── DeltaBatcher ◄── ChatAgentStatePatch ◄── PermissionBroker
                              ▲  shared by both backends, reused as is
              ┌───────────────┴────────────────┐
       AcpBackend (subprocess)          EndpointBackend (in-process)
       JSON-RPC over stdio               the pi-agent-core loop
       translate.ts                      pi events → ChatDelta
              │                                │
    Claude Code / Codex          the LLM endpoint the user configured (pi-ai)
```

New directories:

The structure as it actually landed (the differences from the first draft are in each step's
"result" under §5):

```
main/agent/                 # shared by both backends
  index.ts                  # the façade
  types.ts                  # DeltaBatchBudget and other backend-independent types
  batcher.ts                # moved in from acp/ unchanged
  permissions.ts            # moved in from acp/; toPermissionOptions stays here too (see §3.2)
  redact.ts                 # the general half, cut out of acp/errors.ts
  session-index.ts          # the session → backend routing index (see §3.5)
  context/                  # moved in from acp/context/ unchanged
  endpoint/
    provider.ts             # the user's endpoint config → a pi-ai Model
    tools.ts                # the MCP registry → pi's AgentTool (no HTTP loopback)
    gate.ts                 # the permission gate, stateless and independently testable
    events.ts               # pi events → ChatDelta
    loop.ts                 # EndpointManager: assembling pi-agent-core's Agent

main/acp/                   # ACP-only, not moved
  profiles.ts               # new: one profile per ACP agent
  manager.ts                # not split apart, see step 2's result
  agent-process.ts          # spawn generalised to { command, args, runAsNode }
  session-config.ts         # only cwd and peek's MCP descriptor are left; the sandbox moved into profiles
  translate.ts / errors.ts  # ACP-specific
```

### 3.2 Pushing the shared layer down: the actual coupling surface, module by module

Every file has been checked, not estimated:

| module | disposition | grounds |
| --- | --- | --- |
| `batcher.ts` | **moved as is** | it eats only `ChatDelta`, its constructor parameters are `chatId/budget/sink/timers`, and it has zero ACP references |
| `permissions.ts` | **moved wholesale** | `PermissionBroker` is pure (`open()` returns `{ pending, decision: Promise }`). Its one ACP coupling is `toPermissionOptions`'s parameter type — generalising it to the structural type `RawPermissionOption` is enough, and **the function itself stays in the shared layer**: its "an unknown kind degrades to `reject_once`" is safety logic, and the endpoint backend needs it just as much when it builds its own options |
| `context/{budget,serialize,resolve,store,uri}.ts` | **moved as is** | `planRowFit`, `renderCsv`, `estimateTokens` and `AttachmentStore` are all neutral |
| `context/blocks.ts` | **not split for now** | the only place that produces an ACP `ContentBlock`. The endpoint backend currently splices attachments into the prompt as plain text (`buildPrompt` in `loop.ts`) and has no use for a second output yet; when it does need splitting, the render functions do not move, only the exit does |
| `translate.ts` | **stays in acp/** | an ACP-specific adapter, whose comments are ACP-specific traps bought with packet captures |
| `manager.ts` | **not split** | the plan was to lift the session table and the restart backoff up. Abandoned after actually reading the code: they are tangled up with the ACP connection (`#openAgentSession` *is* `session/new`), and the endpoint backend has no process to restart and no handshake to perform. The two managers are siblings, and the shared surface is the few lines above |
| `agent-process.ts` / `session-config.ts` | **stay in acp/** | the endpoint backend has no subprocess and no `_meta` |

### 3.3 The ACP backend: an agent profile

Collect the Claude-specific knowledge scattered across three places into a profile. Note that
`spawn` has to be generalised — the two agents have different process shapes:

```ts
export interface AcpAgentProfile {
  id: 'claude-code' | 'codex'
  displayName: string
  /**
   * How to bring it up. Returns a complete command rather than a path — the current
   * start() knows only one shape, "Electron running an entry module as Node", and
   * should not assume every agent is isomorphic to it.
   * (Measured: codex-acp's bin also points at dist/index.js, so the two happen to be
   * isomorphic and runAsNode is true for both.)
   */
  resolveSpawn: (cfg: AcpAgentUserConfig) => { command: string; args: string[]; runAsNode?: boolean }
  /** This agent's subdirectory under ~/.peek/chat. Claude Code leaves it empty to stay compatible with existing sessions, see §3.5. */
  workdirSegment?: string
  /** The _meta for session/new. Codex returns {}; its switches are in env. */
  buildSessionMeta: (cfg: AcpAgentUserConfig) => Record<string, unknown>
  /** Extra environment variables. Codex's sandbox switch is here. */
  env: (cfg: AcpAgentUserConfig) => Record<string, string>
  /** See conflict A. The UI warns from this, and constrains permissionMode. */
  sandbox: 'enforced' | 'unverified'
}
```

**The Claude Code profile** — the existing `_meta` from `session-config.ts` moves over without a
character changed, spawn stays `process.execPath + [entry]` + `ELECTRON_RUN_AS_NODE=1`, `env`
handles `CLAUDE_CODE_EXECUTABLE`, and `sandbox: 'enforced'`.

**The Codex profile** — the package `@agentclientprotocol/codex-acp`:

- `resolveSpawn` → resolves `@agentclientprotocol/codex-acp/dist/index.js`. It starts the Codex App
  Server itself, internally.
- `buildSessionMeta` → `{}`.
- `env` → `INITIAL_AGENT_MODE: 'read-only'` (the sandbox), `NO_BROWSER: '1'` (peek has no terminal
  in which to run a browser login flow), and an optional `CODEX_PATH` overriding the Codex
  executable.
- `sandbox: 'unverified'`, until the probe is written.

**Authentication follows the existing strategy**: the comment at `manager.ts:650` already settles it
— do not declare the `auth.terminal` capability, take the optimistic path, and on failure tell the
user to log in through the CLI; peek never touches credentials. The same goes for Codex (the user
first logs into ChatGPT with the `codex` CLI, or sets `OPENAI_API_KEY` themselves). **A non-empty
`authMethods` does not mean not logged in** — that trap is written into the comment, and it applies
on the Codex side too.

**The MCP loop closes**: codex-acp supports client-provided MCP servers over HTTP, and the
descriptor `buildPeekMcpServer()` produces can go straight into `session/new`.

"Claude" in the error copy becomes `profile.displayName`.

### 3.4 The endpoint backend: pi-agent-core + pi-ai

**This section's conclusion is the reverse of this document's first version; the reasoning is in
§4.1.**

Use `@earendil-works/pi-agent-core` for the loop and `@earendil-works/pi-ai` for provider adaptation.
peek supplies only four things:

**① The permission gate hangs off `beforeToolCall`.** This is the cleanest part of the whole plan —
what `PermissionBroker` returns is already a `Promise<PermissionDecision>`, and `beforeToolCall` is
async and may return `{ block: true, reason }`:

```ts
beforeToolCall: async ({ toolCall, args }) => {
  const { pending, decision } = broker.open({ chatId, toolCallId: toolCall.id, ... })
  announce(pending)                   // the same order as the existing code: announce, then await
  const d = await decision
  if (d.kind !== 'selected' || isReject(d.optionId)) {
    return { block: true, reason: rejectReason(d) }
  }
}
```

The announcement order, the timeout, `cancelAll` and "only ever accept an optionId that was offered"
are all existing guarantees, and all of them are kept.

**② Tool definitions are generated from the MCP registry, with no HTTP loopback.** peek's MCP server
is in the same process, so the endpoint backend takes the tools' JSON Schema and handlers directly
and wraps them as pi `AgentTool`s. One network hop fewer, one bearer token's exposure surface fewer,
and the external token in `~/.peek/mcp.json` is entirely unrelated to the endpoint backend —
conflict A's guarantee holds automatically.

**③ An event translation layer.** pi's 11 event kinds → `ChatDelta`. Two things to watch:

- `ChatDelta`'s `tool.upsert` is **merge** semantics (`translate.ts` merges on `toolCallId` and
  replaces `rawInput` wholesale), while pi has three separate events,
  `tool_execution_start/update/end`, so the translation layer has to keep the upsert id table
  itself. The good news is pi has already accumulated the fragmented JSON for us.
- part of the logic in `translate.ts` is patching over ACP's holes (`content` is a single block
  rather than an array, and updates often drop `title`/`kind`), and **copying that into the endpoint
  backend is wasted work**.

**④ Session persistence.** pi's SQLite backend is in a separate package
(`pi-storage-sqlite-node`) that core does not pull in. `agent.state.messages` is just an array, and
peek stores it in `~/.peek/chat/sessions/<id>.json` as before.

**The context budget.** The `transformContext` hook calls the existing `context/budget.ts`:
`contextWindow` minus the system prompt, the tool schemas and the attachments, and what is left goes
to history, dropped oldest first.

**User configuration** (a new `agent` section in `settings.json`):

```jsonc
{
  "agent": {
    "backend": "endpoint",              // acp | endpoint
    "permissionMode": "default",        // a new conversation's starting permission, see §3.6
    "acp": { "profile": "claude-code" },
    "endpoint": {
      "provider": "openai-compatible",  // or a provider id built into pi-ai
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen3-coder",
      "maxTokens": 8192,
      "contextWindow": 128000,
      "thinkingLevel": "off"
    }
  }
}
```

`apiKey` **does not go into settings.json**; it goes through `config/secrets.ts`'s `SecretVault`
(Electron `safeStorage`), under the key `agent.endpoint.apiKey`. Where the vault is unavailable
(Linux without a keyring) it degrades to requiring the value from an environment variable, and never
lands in plaintext on disk. The key has to be added to `errors.ts`'s `redact` list.

**Capabilities that come along free** (all of which would have to be implemented again by anyone
writing their own loop): steering (speaking up while a tool runs), follow-up (appending when the
agent is about to stop), parallel/sequential tool execution, `abort()`, thinking budget conversion,
switching model midway, and an awaitable `agent_end` closing barrier. Of these, steering is a real
requirement for the chat panel.

### 3.5 Binding a session to a backend (the consequence of conflict C)

"Each session fixes its backend, and the list interleaves them" has one direct consequence, and it
**corrects a core trade-off in `2026-08-02-chat-session-management.md`**, so it has to be written
out.

**The problem.** Today's session list comes from `manager.listSessions()` →
`connection.listSessions({ cwd })`, i.e. **enumerated from the agent's side**. That is exactly that
document's "no new persistence layer" approach: the history lies under the agent's cwd and peek
merely pipes it out. With three backends that road is closed:

- Claude Code's history is under its own cwd and Codex's under its own, and neither format
  recognises the other;
- the endpoint backend **does not exist at all** on the agent side — there is no agent process, so
  there is no `session/list` to call;
- interleaving demands one unified enumeration exit, and one of the three sources is peek itself.

**The plan: an index storing routing information only.** `~/.peek/chat/sessions.json`:

```jsonc
{
  "sess_abc": {
    "backend": "acp", "profile": "claude-code",
    "agentSessionId": "…",           // the key to that backend's history, semantics unchanged
    "createdAt": 1754…, "title": "…"
  },
  "sess_def": { "backend": "endpoint", "provider": "openai-compatible", "model": "…", … }
}
```

Listing = reading the index; opening a session = routing to the corresponding backend by `backend`,
with the ACP backend still going through `session/load` and the endpoint backend reading
`sessions/<id>.json`.

**Why this still counts as the minimal breach of "no new persistence layer".** What that trade-off
opposes is **keeping a copy of the transcript** — two histories fork, and the one on the agent's
side is the real one. This index stores no transcript, only "who to ask for this session". There is
still exactly one transcript, still in its own source.

**cwd has to be split per profile.** Today every ACP session shares `~/.peek/chat`. The two agents'
history formats do not recognise each other, and sharing one cwd would let each one's `session/list`
see the other's files. It becomes `~/.peek/chat/<profileId>/` (one more parameter on
`ensureChatWorkdir()`), and the endpoint backend uses `~/.peek/chat/endpoint/sessions/`.

**The UI.** Each row in the session rail marks its backend (Claude Code / Codex / the model name).
Changing the agent in settings affects **new** sessions only; an existing session keeps opening with
its own backend. When a session's backend is no longer available (Codex uninstalled, the endpoint
configuration deleted), the row stays in the list and stays readable, but cannot be continued —
which is a different thing from deletion.

**`verify-chat-sessions.ts` has to grow with it.** PLAN.md §M7 already said it has caught bugs the
unit tests could not, and that a change to the ACP layer runs it first; now it also has to cover "an
interleaved list, routed by backend".

### 3.6 A new conversation's starting permission

> **2026-08-15: this section's exclusion has been overturned.** Settings can now be set to any of
> the modes, `dontAsk` and `bypassPermissions` included. The argument below ("the same value, one a
> decision and one a forgetting") is not itself wrong, but it refused on the user's behalf something
> the user explicitly wanted — "set it once and then forget it" is precisely the effect he is after,
> not the failure mode he is guarding against. What replaces the exclusion is **visibility**: the
> panel's dropdown marks a mode as inherited from settings, so "this conversation will not ask you"
> is visible before it starts to matter. `2026-08-14-agent-write-switch.md` §2.6 has already applied
> the same measure once, to the write switch. See `2026-08-15-chat-panel-full-capability.md` §2.1.
> The rest of this section (the six modes' semantics, why `auto` is on the list, and the README
> promise being unchanged) still holds.

The panel's permission dropdown has six modes (`CHAT_PERMISSION_MODES`), and settings allow only
four of them as a **default**: `default` (ask every time), `auto` (the agent decides for itself),
`acceptEdits` and `plan`.

**`dontAsk` and `bypassPermissions` are excluded, because the two sites mean different things.**
Reaching over and clicking one of them in the panel is saying, to the one conversation in front of
you, "this time I know what I am doing"; writing it into `settings.json` is setting it once, then
forgetting it, and quietly applying it to every conversation from then on. The same value: one a
decision, one a forgetting. They can still be switched per conversation, temporarily, in the panel;
that road is not closed.

`auto` stays on the list. It hands the approval to the agent's own classifier rather than to a
person — peek does not make that choice for anybody (the default is still `default`), but a user who
has already thought it through for their own read-only database viewer should not have to click it
again every time they open a new conversation.

When the file is read it is validated against **this subset**, so a hand-edited
`"permissionMode": "bypassPermissions"` reads as "not set" rather than quietly taking the gate off
its hinges.

The README's promise ("an agent tool call that has not been **pre-authorised** renders as a prompt
and blocks") is already worded to include mode switching, so this does not change it.

### 3.7 The settings panel

`config/settings.ts` gains an `agent` section. The settings panel gets one segmented control to pick
a backend, and renders per backend below it:

- **The ACP backend:** an agent dropdown (Claude Code / Codex) plus an optional executable path
  override. An agent with `sandbox: 'unverified'` carries an explicit note beside it, and the
  auto-allow modes are disabled.
- **The endpoint backend:** provider, base URL, model id, api key (written to the vault, never
  echoed back), and optional max tokens / context window. With a "test connection" button that sends
  one minimal request.

---

## 4. Trade-offs

### 4.1 Why the endpoint backend uses pi-agent-core rather than a hand-written loop

This document's first version judged that it should "use pi-ai only and write the loop by hand", on
the grounds that "tool execution must pass through `permissions.ts` first and cannot be handed to an
external library". **That reason does not hold** — `beforeToolCall` runs after argument validation
and before execution, and returning `{ block: true }` stops the call, which is exactly the insertion
point the permission gate wants.

Two other reasons still hold but are both avoidable: the event stream does not match → write a
translation layer (far thinner than `translate.ts`, pure functions and easy to test); session storage
→ its SQLite backend is a separate package, so simply do not use it.

What a hand-written loop buys is "the event shapes match natively", and it costs implementing
steering, the context compaction hook, parallel tools, abort semantics and the thinking budget all
over again. Not worth it.

Inside `pi` ([earendil-works/pi](https://github.com/earendil-works/pi), MIT, 82k stars, still
actively committed to), `pi-ai`'s value is equally clear: it has a long list of built-in providers
plus "Any OpenAI-compatible API" (Ollama / vLLM / LM Studio) and `createProvider()`, and it papers
over the vendor-by-vendor differences in streaming, fragmented tool-call JSON, thinking blocks, stop
reasons and token accounting — this layer's whole value is in the traps already walked into. It only
lists models that support tool calling, which for peek is a feature and not a limitation.

### 4.2 The rest

**Why not the endpoint backend alone.** The ACP backend already works, and that pile of comments in
`translate.ts` was bought with packet captures against a real agent; on top of that, Claude Code's
and Codex's subscription login (no API key) is the least trouble for a great many users, and the
endpoint backend cannot offer it.

**Why not several ACP backends only, leaving self-configured endpoints to each agent.** That way
peek loses all control over "what models can be used" — it becomes whatever CLI the user installed —
and every agent's configuration format is different, so the settings panel cannot offer one unified
entry point.

**Why not disguise the endpoint backend as a local ACP agent too.** One code path for everything,
but paying the full cost of a process boundary (serialisation, crash recovery, stdio framing) to buy
only a unified interface — and the interface is already unified at the `ChatDelta` layer. Staying in
one process additionally buys the security benefit of "tools connect directly, with no HTTP
loopback".

**Why apiKey does not land in settings.json.** That is a file the user will hand-edit, will paste
into an issue, and will have carried off by a sync tool. `SecretVault` is already there, serving
connection passwords, and an agent key is the same thing.

**Why the first version does not fetch the model list.** The shape of each vendor's `/models` and
their authentication differ more than one would expect, and self-hosted endpoints often have none.
Typed in by hand plus "test connection" covers more ground with less code.

**New dependencies:** `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
`@agentclientprotocol/codex-acp`. The first two are MIT, have no native dependencies and are
tree-shakeable (registering providers on demand rather than `builtinModels()`); the third is only
started when the user picks Codex, and making it an optional dependency is under consideration. All
three go through `2026-08-03-driver-package-boundary.md`'s dependency discipline.

---

## 5. Implementation plan

Five steps, each a committable change on its own, with the tests green at the end of each.

**Status (2026-08-03): all five have landed**, tests up from 1301 to 1339, all green; `tsc` passes
in full. Each step's "done when" is kept verbatim, with the actual result appended after it.

### Step 1 — push the shared layer down (pure moving, zero behaviour change)

Build `main/agent/` per §3.2's table, move `batcher.ts`, `permissions.ts` and `context/*`, and split
`manager.ts` apart. `context/blocks.ts` exports only `toAcpBlock()` for now.

*Done when:* the existing ACP tests are all green with not a single assertion changed.
`verify-chat-security.mjs` passes.

*Result:* achieved. `batcher.ts` / `permissions.ts` / `context/*` were moved into `agent/` with
`git mv`, and `errors.ts` was cut at line 268 — the general `redact` / `sanitizeLine` /
`previewInput` pushed down into `agent/redact.ts`, with the ACP-specific error classification staying
where it was and re-exporting. `toPermissionOptions`'s `AcpPermissionOption` was generalised to the
structural type `RawPermissionOption`, and **the function stayed in the shared layer** rather than
staying in `acp/` as planned: its "an unknown kind degrades to `reject_once`" is safety logic, and
both backends need it. 1301 → 1301.

### Step 2 — the ACP profile abstraction + generalising spawn

Introduce `AcpAgentProfile`, with Claude Code's profile being the current behaviour.
`AgentProcess.start()` generalises from "a Node entry module" to `{ command, args }`. The error copy
switches to `displayName`.

*Done when:* one stub agent configured with two different profiles delivers the right `_meta` and env
for each.

*Result:* achieved, in `acp/__tests__/profiles.test.ts`. One assertion had to change:
`session-config.test.ts` had a **source-level grep** assertion for
`const _meta = buildAgentSessionMeta()`, and that is precisely the line the refactor removed —
changed to grep for `this.#config.profile.buildSessionMeta(`, with the guarantee unchanged (`_meta`
must come from a single source, and both the `session/new` and `session/load` paths must carry it).

**`manager.ts` was not split apart as planned.** Only reading the code made it clear: the session
table, the restart backoff and the ACP connection are tangled together (`#openAgentSession` *is*
`session/new`), and the endpoint backend has no process to restart and no handshake to perform.
Forcing them to share would have produced a bad abstraction. The two managers are therefore
**siblings** rather than one class with a strategy hole in it, and the shared surface is what step 1
pushed down. See §3.1.

### Step 2.5 — the session index and per-profile cwd

Build the `~/.peek/chat/sessions.json` index per §3.5, add a profile parameter to
`ensureChatWorkdir()`, and change the session list from "ask the agent" to "read the index and route
by backend". At this point there is only the Claude Code backend, and every entry in the index looks
the same — **this step's value is precisely that there is no second backend yet, so the behaviour can
be lined up against the status quo entry by entry**.

*Done when:* `verify-chat-sessions.ts` passes; old sessions (created before the cwd move) still open,
or there is an explicit one-time migration.

*Result:* achieved, via a third road — **no migration**. `AcpAgentProfile.workdirSegment` leaves
Claude Code in the `~/.peek/chat` root (it is the only agent with existing sessions) and Codex uses
`chat/codex/`. `listSessions` filters on the exact `cwd`, so the two are naturally invisible to each
other and the migration risk is zero. The index is `agent/session-index.ts`, with 8 tests covering
corruption / a future version / malformed entries / storing routing but no transcript.

### Step 3 — the Codex profile

Add `@agentclientprotocol/codex-acp` and write the Codex profile (`INITIAL_AGENT_MODE=read-only`,
`NO_BROWSER=1`). Add the agent dropdown to the settings panel.

*Done when:* Codex has actually been run once, confirming peek's MCP descriptor arrives, that a tool
call raises a permission prompt, and that in `read-only` mode it cannot get write capability. Write
the sandbox probe for it (the precondition for leaving `unverified`).

*Result:* the code and the dependency are in place (`@agentclientprotocol/codex-acp@1.1.9`, the
profile, the settings panel dropdown, and the asar unpack list in `package-mac.mjs`). **Two things
are not done, and both need a person**: actually running Codex once needs a logged-in Codex, and the
sandbox probe needs it to run for real first. The profile is therefore still `unverified` — which is
exactly what that field exists for.

One fact is corrected along the way: `codex-acp`'s `bin` points at `dist/index.js`, so it **is** a
Node entry module, isomorphic to Claude, with `runAsNode: true`. The first draft's "it is a Rust
binary and its spawn shape differs" was wrong; having `resolveSpawn` return a complete command is
still a generalisation worth keeping, but the reason is "one should not assume every agent is
isomorphic", not "these two are not isomorphic today".

### Step 4 — the endpoint backend

Add pi's two dependencies, write `endpoint/{provider,tools,events,loop}.ts`, hang the permission gate
on `beforeToolCall` and the budget on `transformContext`, and persist sessions to
`~/.peek/chat/sessions/`. Add the endpoint form plus "test connection" to the settings panel.

*Done when:* the automated and manual items in §6.

*Result:* the code all landed — `endpoint/{provider,tools,gate,events,loop}.ts`, the settings panel's
endpoint form, and a two-way choice in the assembly on `settings.agent.backend`. The API key goes
through `SecretVault` and is sealed into a ciphertext field in `settings.json` (following
`connection-book.ts`'s existing pattern, rather than the first draft's "keychain KV" —
`SecretVault` is a seal/open encryptor, not a key-value store).

**The permission gate was extracted into its own module**, `endpoint/gate.ts`, rather than left as a
private method on the manager: writing the tests found that it forced the tests to poke at private
members, which is a design signal. `requestToolPermission()` is now stateless and directly testable,
with 10 tests covering approve / reject / cancel / timeout / close / bypass / only ever accepting an
optionId that was offered.

**Not done**: persisting sessions to `~/.peek/chat/endpoint/sessions/` (`agent.state.messages` is
currently in memory only, and closing the panel loses it), and the `transformContext` budget hook.
Neither affects a single-turn conversation, but the endpoint backend's session resumption waits on
them.

### Step 5 — closing the documentation

*Result:* achieved. PLAN.md's choice line and §324 have been changed to neutral phrasing, and §M7's
"no new persistence layer" has had the correction added; `2026-08-02-agent-source-and-permission-scope.md`
§2.2 has been swapped for the three-backend grounds table; `2026-08-02-chat-session-management.md`
§3.1 has had the session index correction block added.

- PLAN.md: the choice line and §324 change to neutral phrasing (conflict B); §M7's "**no new
  persistence layer**" sentence gains §3.5's correction and its reasoning.
- `2026-08-02-agent-source-and-permission-scope.md` §2.2: swapped for §2's three-backend grounds
  table.
- `2026-08-02-chat-session-management.md`: a section added on the session index and per-profile cwd.

**Prerequisites:** steps 1 → 2 → 2.5 are one chain, and the precondition for everything else. Steps
3 and 4 have no dependency on each other and can be reordered or run in parallel, but both depend on
2.5 (otherwise each grows its own temporary session enumeration, to be torn out twice afterwards).

---

## 6. Verification

**Automated:**

1. The existing `acp/__tests__/` all green (steps 1 and 2 are pure moving and abstraction, and the
   assertions should not change).
2. Profile tests: two profiles → two sets of spawn arguments, `_meta` and env.
3. `endpoint/__tests__/`, driven by pi-ai's faux provider:
   - a plain-text reply → the `ChatDelta` sequence has the same shape as the ACP backend's;
   - one tool call → **`requestPermission` fires first; on a rejection the tool handler is not
     called**;
   - cancellation → the stream breaks off and the state patches close out correctly;
   - over the context budget → old messages are dropped and attachments are not;
   - steering → a message inserted while a tool runs takes effect on the next turn.
4. `verify-chat-security.mjs` extended to three backends: Claude, Codex, endpoint. For the endpoint
   backend, assert that the visible tool set is exactly the one the MCP registry exports, with not
   one extra.
5. The session index: an interleaved list routes correctly by `backend`; a session whose backend is
   unavailable stays readable and cannot be continued; where the index and the actual history
   disagree (somebody deleted the agent-side file by hand) it does not crash and produces an error.

**By hand:**

1. Point the endpoint backend at a local Ollama, ask "what is in the current window", and confirm the
   answer comes through `mcp__peek__*` and that every call raises a permission prompt.
2. Run the same question on the Codex backend, and confirm that under `read-only` it cannot get write
   capability.
3. Switch back to the Claude Code backend and confirm old sessions still resume from the rail
   (adjusting expectations per conflict C's conclusion).
4. Fill in a deliberately wrong base URL, and confirm the error lands in the error centre and that
   the copy does not contain the api key.
