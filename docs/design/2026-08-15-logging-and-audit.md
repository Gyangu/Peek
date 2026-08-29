# Logging, audit and agent observability: a terminus for what is already being computed

## 1. What this fixes

### 1.1 What exists today

Counted out, peek has three records, they do not know about one another, and
**not one of them can be taken away by the user**:

| | location | capacity | what it collects | has a UI | on disk |
|---|---|---|---|---|---|
| Command log | `main/bus/command-log.ts` | 500-entry ring | per command: source / redacted input / ok / rev / elapsed | ❌ | ❌ |
| Error centre | `renderer/components/error-center/errorLog.ts` | 100-entry ring | failures only: toasts, plus the result sets and connections sitting in an error state in the Workspace mirror | ✅ | ❌ |
| `McpLogger` | declared at `core/mcp-tools.ts:193` | — | free text from the MCP / agent subsystems | ❌ | ❌ |

Beyond that there are **73 loose `console.*` calls**, densest in `main/index.ts`
(26) and `main/chat-host.ts` (7). No levels, no switch, no agreed prefix —
`[peek/mcp]` `[peek/agent]` `[peek/acp]` `[peek/renderer:*]` are four
hand-written coincidences, not a convention.

`McpLogger`'s **implementation** is copied out three times: `main/index.ts:842`
(`[peek/mcp]`), `main/index.ts:1213` (`[peek/agent]`),
`core/package-host.ts:339` (writes stderr). All three are the same
`if (level === 'error') console.error…`.

`getPath('logs')` / `appendFile` / `*.log` across the whole repository: **zero
hits**.

### 1.1bis But "73 loose console calls" understates the situation

Opening each one up, the picture is not the one the previous section leaves you
with, and the difference decides how much work this is:

**Four structured log channels already exist, and every one of them terminates
at `console`.**

| channel | structure | terminus |
|---|---|---|
| driver host | `{ connId, level, message, detail }` | `main/index.ts:651` → `console.log('[peek/driver]', …)` |
| ACP | `{ level, message, detail }` | `main/index.ts:1320` → `console.*('[peek/acp]', …)` |
| MCP / endpoint agent | `McpLogger.log(level, message, detail)` | `main/index.ts:842` / `:1213` |
| package host | same as above | `core/package-host.ts:339` → stderr → forwarded by main |

Which is to say: **the levels are there, the namespaces are there (driver host
even supplies a correlation key in connId), the emission points are there** —
what is missing is only the last hop: `console` instead of a sink that can reach
disk, be filtered, and be read by a UI.

That turns this change from "design a logging system" into "give the four
existing lines one shared terminus, and clean up the last of the hand-copying".
Every section below rests on that fact.

### 1.1ter Agent internals: not unrecorded — computed, then thrown away

This section was added in the design's second round, because the user
specifically asked to "be able to observe execution errors inside the agent".
Opening it up, the problem is both more specific and easier to fix than
expected:

**`classifyAgentEvent` (`agent/endpoint/events.ts:135`) computes a `reason`
string for each of 11 discard paths, and then one line at `loop.ts:586`,
`case 'ignored': return`, throws all of them away.**

The 11 reasons look like this:

```
non-object event                      message_start:user
message_end:unknown                   message_update:toolcall_delta
tool_execution_start without an id    tool_execution_end without an id
agent_start / agent_end / turn_start / turn_end / tool_execution_update
unknown:${event.type}                 ← this is the one that matters
```

The last one means "the SDK or the model sent an event type peek does not
recognise". That is the crime scene for "an execution error inside the agent" —
**and today it leaves no trace anywhere**. An upstream SDK upgrade, a model that
changed an event's shape, a tool call that never got displayed because it was
missing an id: the symptom in every case is "something is missing from the chat
panel", and every cause is silent.

`events.ts`'s own header comment says "an unrecognised shape is **reported**".
Today it is not.

Three more of the same kind:

- **An ACP external agent's stderr loses half of itself by default**
  (`acp/manager.ts:758`): `if (noise && !verbose) return`. And the last few lines
  before an agent process crashes are very often in the pile judged to be noise.
- **`toParameters` falls back silently to an empty schema**
  (`agent/endpoint/tools.ts:118`): when zod cannot produce a JSON Schema, the
  model gets a tool that takes "no parameters". Its own comment argues the danger
  of silence ("would leave the agent unable to see part of the window with
  nothing anywhere saying why") — and then this fallback is itself silent: the
  model will call with the empty schema, fail, and the reason for the failure was
  already known at the moment of conversion.
- **`applyState` swallows its own failures** (`loop.ts:672`, whose comment says
  "the applier swallows its own failures by contract; this is the belt").
  Contract or not, that belt has no counter on it.

**None of these needs a new mechanism.** What they need is somewhere to write.

### 1.2 The problem

**Something breaks on the user's side and nothing can be handed over.** The
error centre's 100 entries have to be copied and pasted by hand, and they are
failures only; the command log and every console output are visible only with
devtools open, or by launching the app from a terminal. The troubleshooting loop
for a local database tool is therefore broken: repro steps come from asking, and
the scene of the crime comes from guessing.

**One sentence in PLAN §6 is not true today.** It says "the Command log is
naturally an operation recording, replayable and testable" — replayable presumes
it is still there, and it lives in an array that zeroes the moment the process
exits.

**"Who did this" is recorded, and nobody can see it.** `CommandSource` is
finely divided (`ui` / `mcp` / `agent` / `system`), `command-bus.ts:105` records
it on every entry, `command-origin.test.ts` watches it — and the only way that
distinction gets out today is a label on the failed entries in the error centre.
A query a human clicked, one sent by the Claude in the panel, one sent by an
external MCP client — the successful ones are invisible to everybody.

**The agent is a black box, and it is the part of this app that most needs to be
seen.** The shared consequence of the four silences in §1.1ter is that when the
chat panel misbehaves, the only evidence is "the things in the panel look
wrong". The model says it called a tool and the transcript has no such call; a
turn ends empty; the agent process quietly exits — all three symptoms point at
the same debugging starting point today, which is no starting point.

The `debug` level matters here in particular: it is not "noise that only means
something during development", it is **the only thing that can reconstruct what
that turn actually received**. So the level has to be openable on the spot — see
§3.4.

### 1.3 Boundary: what this does not do

- **No remote reporting / crash-collection service.** Logs stay on the machine,
  and the user decides who to send them to.
- **No log encryption.** File permissions (0600) are this version's entire
  protection, same specification as `mcp.json`.
- **No structured query.** The panel is "a tail plus a filter", not ELK.
- **The error centre's data source is not touched.** It subscribes to toasts and
  the Workspace mirror, which is the attribution path that took real effort to
  get right on 2026-08-02 (`ResultMeta.origin`); changing it to read a log file
  would break it, see §4.4.
- **No separate sink for child processes.** stdio already forwards to main, see
  §3.2.
- **No live push.** The panel is pull-based, for the reasons in §3.5.
- **Conversation content does not reach disk.** The agent's log records event
  shape, not content, see §3.6 item 4.
- **No agent behaviour analysis / evaluation.** What this delivers is the raw
  record of "what happened inside that turn", not token counts, cost statistics
  or a success-rate dashboard. Those come up after the raw record exists;
  reversing the order means designing reports with no data.

## 2. First, three places that do not line up with the existing documents

Per CLAUDE.md's rule, the conflicts go on the table before any work starts;
already reconciled with the user.

### 2.1 PLAN §10 rejected "send the command log to the renderer" — reopened here, minus the cost

The original text ("Settled · the error centre's `source` attribution") says
that route was "both expensive and insufficient: it requires adding an IPC
channel + a preload member".

**What was rejected was the use, not the route itself.** At the time the idea
was to use the command log for **failure attribution**, and attribution is
better served in one step by "record the initiator on the thing being created at
the moment it is created" — that judgement still holds today, and
`ResultMeta.origin` / `ConnectionState.origin` do not move.

"Let a human see what just happened" is a different use, and that rejection does
not apply to it.

And **the cost does not have to be paid this time**: reading the log goes
through the Command Bus itself (`log.read`), `PeekBridge` gains no member, and
not one line of preload changes. See §3.5.

### 2.2 This answers PLAN §10's third open question on writes, early

That item listed three options for the audit trail: **written to disk and
visible in the UI / list "recent writes" beside the error centre only / leave it
as it is**. This design picks **the first**, and picks it before the write path
lands.

That is not jumping the gun: the write path is stuck on two decisions only a
human can make — what "Read-only, always" becomes, and whether an MCP client can
write — while the audit trail is the only one of the three that is **pure
engineering**. Doing it first means one fewer decision when the write path
lands, and by then the audit trail is not freshly built — it is one that has
been running a while and has already been read by a human.

The corresponding item in PLAN §10 changes with it, see §6.

### 2.3 PLAN §7's "the token does not go into logs" is a constraint, not a conflict

The original reasoning is worth carrying over verbatim: stdout's audience is
wider than it looks — terminal scrollback, CI logs, crash reports, and whatever
`PEEK_FORWARD_CONSOLE` forwards to. **Writing to disk adds one more audience,
and a persistent one.**

So redaction is a section in this design rather than a sentence, see §3.6; the
verification is nailed to `verify-chat-security.mjs`, see §5.

## 3. The plan

### 3.1 Three streams, not one bag

Three, because they **differ in format, in lifetime and in audience**, and
mashing them together lets them pollute each other:

| stream | lands where | format | for whom |
|---|---|---|---|
| **diagnostic trail** | `~/.peek/logs/peek.log` | one line per entry, human-readable | whoever is troubleshooting (pasted into an issue) |
| **command audit** | `~/.peek/logs/commands.jsonl` | JSONL, one `CommandLogEntry` per line | machines (replay, tests) + the panel |
| **failures** | not on disk | memory | the user, in real time |

The third one is today's error centre, **untouched**.

### 3.2 One logger: do not invent a second

An interface already exists — `McpLogger` (`core/mcp-tools.ts:193`), shaped
`log(level, message, detail)`, with three implementations and four call sites
already pointed at it. **Promote it into a general `Logger`** rather than
inventing a better one beside it.

New file `packages/core/src/logger.ts`:

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Namespaces. The four hand-written `[peek/xxx]` prefixes, collapsed into one closed table. */
export type LogNamespace =
  | 'bus' | 'store' | 'conn' | 'driver' | 'package'
  | 'mcp' | 'agent' | 'acp' | 'renderer' | 'app'

export interface LogRecord {
  ts: number
  level: LogLevel
  ns: LogNamespace
  message: string
  detail?: unknown
  /**
   * Correlation key: one of `chatId` / `connId` / `resultId`, carried through as-is.
   *
   * This field exists because the driver host row in §1.1bis's table **is
   * already passing connId**, and the first question when diagnosing an agent
   * problem is "what happened during this turn" — a key that collapses thirty
   * lines of log down to the five belonging to one session is the entire basis
   * of the panel's filter. A free string rather than a union type: it is for
   * humans and for grep, not for the compiler.
   */
  tag?: string
}

export interface Logger {
  log(level: LogLevel, message: string, detail?: unknown): void
}

export type LogSink = (record: LogRecord) => void

export function createLogger(ns: LogNamespace, sink: LogSink, minLevel: LogLevel): Logger
export function formatLogLine(record: LogRecord): string
```

`McpLogger` becomes an alias of `Logger` and keeps its re-export — that type in
`mcp-tools.ts` is **part of the frozen contract** (packages' `contrib.mjs` is
written against it), so renaming it either breaks packages or leaves an alias
behind, and the alias is cheaper.

**Not one line in this file touches fs, and that is a hard constraint rather
than a style**: `packages/core`'s tsconfig is `types: []`, and production code
is not allowed to see the node runtime (PLAN §11.2 records that "adding a single
`process.env` was measured to fail compilation"). The interface, the formatting
and the level filter are pure, so they can go there; the half that writes files
goes in `apps/desktop/src/main/logging/`.

### 3.3 How six kinds of process converge on one place: not one cross-process protocol is invented

**A verified fact** — every child process's output already reaches main:

| process | where it goes today | source |
|---|---|---|
| driver host (one per connection) | stdout/stderr collected by main | `main/connections/host-process.ts:230` |
| package host (one per package) | stdout/stderr collected by main | `main/packages/host-process.ts:247` |
| renderer | `console-message` events forwarded to main | `main/index.ts:760` |
| preload (3 console calls) | via the renderer's `console-message` | same as above |
| ACP agent | stderr collected by the manager | `main/acp/manager.ts:756` |
| main | already local | — |

Therefore: **child processes go on using `console.*`, and main is the only sink
host.** No log IPC protocol, no writer installed in every utilityProcess, no
handling of several processes appending to the same file — **there is exactly
one writer**, which incidentally settles the thing home-grown rotation fears
most in §4.1.

**But one gap needs fixing.** `main/index.ts:761` today reads:

```ts
const forwardAll = isDev || process.env['PEEK_FORWARD_CONSOLE'] === '1'
win.webContents.on('console-message', (details) => {
  if (!forwardAll && details.level !== 'error') return   // ← here
  console.log(`[peek/renderer:${details.level}]`, details.message)
})
```

In a non-dev build the renderer's warn / info **never reach main at all**, so
there is nothing to write to disk — and the warn lines just before the crash are
exactly what a user's bug report most wants to show. The fix: **forward
everything to main and let the sink's level filter decide what is written**,
rather than dropping it at the point of forwarding. `forwardAll` stays, but from
now on it only governs "should this also go to main's own stdout" — terminal
noise and disk are two things, and one switch should not govern both.

### 3.4 On disk

`main/config/paths.ts` gains:

```ts
export const LOGS_DIR_NAME = 'logs'
export function logsDir(configDir: string): string
```

`~/.peek/logs/`, **directory 0700 / files 0600**, same specification as
`mcp.json` (`main/mcp/token.ts` is the template). The reason is the same as for
that file: logs will contain fragments of connection strings, database and table
names, and query text.

| file | per-file ceiling | retained | total |
|---|---|---|---|
| `peek.log` → `peek.1.log` … `peek.4.log` | 2 MiB | 5 | 10 MiB |
| `commands.jsonl` → `commands.1.jsonl` `commands.2.jsonl` | 4 MiB | 3 | 12 MiB |

**Write strategy: buffered append, flushed at 16 KiB or 200ms, whichever comes
first.** A scrolling stream of debug lines should not put a `write` on main's
event loop per line. Normal exit is covered by a synchronous flush on
`before-quit` + `process.on('exit')`; **a hard crash loses the last 200ms**,
which is a stated cost — and what it buys is main not being slowed down by
logging, since not one line of the performance budget in §8 left headroom for
it.

### 3.4bis The level has to be openable on the spot — three routes

`debug` is not developer-only noise — §1.2 said it: it is the only thing that
can reconstruct what that agent turn actually received. And the moment it is
needed ("why did that last turn come back empty") is precisely **afterwards**,
so "edit the config and restart" as the only route is not enough: restarting
destroys the scene. Three routes, covering three moments:

| route | when | takes effect |
|---|---|---|
| `logLevel` in `~/.peek/settings.json` | the everyday default (defaults to `'info'`, `'debug'` in dev) | next launch |
| `PEEK_LOG_LEVEL=debug` | repro scripts, CI, integrations like `smoke-drivers.mjs` | this launch |
| the level selector at the top right of the panel | **afterwards**, without restarting | immediately |

The environment variable **overrides only, and does not write back to user
preferences** — copied from `PEEK_MCP_PORT`'s rule (set in PLAN §7), for the same
reason: one integration run should not change the user's settings.

The third is the only new mechanism among the three, and the most important one:
the sink's `minLevel` is mutable, the panel changes it through `settings.write`
(already in `COMMAND_NAMES`), and main swaps it the moment it arrives.
**Lowering the level does not clear what has already been written**, so "switch
to debug, then reproduce it again" is a workable flow rather than "switch it and
find the previous run is gone".

`logLevel` goes into `PeekSettings` alongside `mcpPort` / `uiZoom` /
`executionTimeouts`.

### 3.5 Getting it to the UI: through the Command Bus, with no IPC channel added

`COMMAND_NAMES` (`core/commands.ts`, 36 entries today) gains two **read-only**
commands:

```
log.read           // tail of the diagnostic trail: { limit?, minLevel?, ns? } → LogRecord[]
log.readCommands   // tail of the audit: { limit?, source? } → CommandLogEntry[]
```

**This does not violate §6's "this table stays closed on purpose"**: that
sentence is addressed to **packages** ("a package cannot add verbs to it"), and
its reason is that all 36 names are kernel-generic. `log.*` is kernel-generic
too, in the same category as `state.read` / `settings.read` / `mcp.read`, which
are already in the table.

So the renderer reads through the existing `bridge.invoke('log.read', …)` —
**`PeekBridge` gains no member, and not one line of preload changes**. The whole
cost argument behind the rejection in §2.1 does not arise on this route.

An incidental benefit: these two commands are **open to MCP clients at the same
time** (they go through the same Command Bus, which is the entire point of §6).
An agent can therefore read what it just did, and read what the human just did.

**The self-reference has to be handled**: `state.read` is an ordinary command
and gets pushed into the log by `command-bus.ts:105` (verified) — and so would
`log.read`. Opening the panel once would put an entry in the audit, refreshing
every 2 seconds would put one in every 2 seconds, and the audit would drown in
its own reads. The handling: `CommandLog.push` skips `log.*`. **Only those
two**; `state.read` is not skipped — that one is an external client genuinely
reading state, which is a fact worth recording.

**Pull-based rather than push-based, deliberately.** The log panel is something
opened occasionally, and broadcasting every log line as a matter of course means
paying an IPC tax for a panel nobody is looking at. One read on open, and a 2s
poll of the tail while it is open.

The honest cost: **the panel is not real-time.** But the real-time property of
"it just blew up" does not depend on this route — the error centre subscribes to
toasts and the Workspace mirror, and that route is untouched. The only thing
that is not real-time is scrolling back through history, and scrolling back
never needed to be.

### 3.6 Redaction: four layers, the first three from strong to weak — do not mistake the second for a guarantee

1. **The audit stream: already correct.** `redactCommandInput`
   (`command-log.ts:103`) runs before the push, `conn.open`'s config goes through
   `redactConnectionConfig` + `redactRulesFor`, and `chat.send`'s prompt is
   truncated to 500 characters. Writing to disk reuses it and **does not write a
   second copy**.

2. **The diagnostic stream: one pass of `scrubSecrets(line)` at the sink.** Free
   text has no schema, so there is nothing for redaction to grip, and all that is
   left here is pattern matching: bearer-token shapes, `password=`,
   `Authorization:` headers, and the literal value of the token in
   `~/.peek/mcp.json` (main knows it, so it can be matched exactly).

   **This is a backstop, not a guarantee.** Written down here so that nobody in
   the next round assumes it makes anything safe to print — a pattern matcher
   cannot stop a shape it has not seen, and the persistent audience §2.3 talks
   about is real.

3. **The rule: a call site must not stuff a whole config object into `detail`.**
   Use the existing `redactConnectionConfig`. This one rests on review and on
   §5's verification, with no compiler enforcing it — if it is ever violated, the
   answer is to narrow `detail`'s type, not to add a comment.

4. **The agent's log records shape, not content.** The lines added in §3.7 share
   one constraint: write an event's **type, id, count and length**; do not write
   delta text, tool arguments or tool results.

   The reason is not fastidiousness. `chat.send`'s prompt is already truncated to
   500 characters in the audit stream (`redactCommandInput`, whose comment is
   explicit: "the untruncated version turns a debugging aid into a multi-megabyte
   retention of whatever the user typed") — and an agent debug log that took
   `text_delta` in wholesale would route around that limit through the back door,
   **token by token**. A file on disk that continuously records the entire
   conversation between user and model should not be a side effect of "turn on
   the debug level".

   Nor does this cost any debuggability: all four gaps in §1.1ter are gaps in
   shape — which event type went unrecognised, which tool call was missing an id,
   which tool's schema would not convert. **Not one of them needs content.**

### 3.7 Agent internals: connect what is already computed, rather than build something new

The four places from §1.1ter, one at a time. **What they have in common is that
none of them needs a new mechanism** — what they lack is somewhere to write, and
§3.2 through §3.4 have now built that somewhere.

#### (a) `ignored`'s reason goes into the debug log

`loop.ts:586` changes from

```ts
case 'ignored':
  return
```

to writing `outcome.reason` at the **debug** level in the `agent` namespace,
with `tag` set to `chatId`.

**Why debug rather than warn**: 6 of those 11 are **entirely normal** everyday
events (`message_start:user`, `turn_start`, `tool_execution_update`… several per
turn). Recording the normal path as warn turns the log into something nobody
reads within two minutes — PLAN's line about the error centre, "padding it with
successes is how a log stops being read", is making the same point.

**But one gets promoted on its own: `unknown:${type}` (and `non-object event`)
is recorded as `warn`.** Because its meaning differs from the other ten: those
ten say "I recognise it and I chose not to display it", this one says "**I do
not recognise it**" — the upstream SDK changed, the model sent a new shape, and
that is genuinely something somebody should know. The distinction is already
available inside `classifyAgentEvent` (it is the `default:` branch), so no new
test has to be written.

By the same reasoning, the two `without an id` cases are promoted to `warn` as
well: a tool call vanished from the transcript entirely, and the user can see the
consequence (a call is missing) without being able to see the cause.

#### (b) ACP stderr stops losing half of itself by default

`acp/manager.ts:758`'s `if (noise && !this.#config.verbose) return` is deleted.
The `noise` judgement stays, but its role is demoted from **discarding** to
**grading**: noise is recorded at debug, non-noise at info.

The reason is the same as for fixing the renderer forwarding gap in §3.3: **the
decision to discard does not belong at the point of collection, it belongs at
the sink's level filter.** Whatever is discarded at collection cannot be
recovered by any means, and the last few lines before an agent process crashes
are, under the current `noise` judgement, very likely in the pile being
discarded.

`verbose` stays, with its meaning narrowed to "also print to the terminal" —
consistent with how §3.3 handles `PEEK_FORWARD_CONSOLE`; one switch should not
govern both "record or not" and "print or not".

#### (c) `toParameters`'s fallback speaks

The empty catch at `tools.ts:118` gains a line of `warn`: the tool name plus
zod's error.

This one is worth calling out separately, because its comment has already made
half the argument — it says that silently **dropping** the tool would leave the
agent "unable to see part of the window with nothing anywhere saying why", which
is why it falls back to an empty schema. The direction is right, but **the
fallback itself equally has nothing anywhere saying why**: the model gets a tool
that takes "no parameters", calls it, fails, and the root cause was known the
moment `z.toJSONSchema` threw. With this line added, the symptom (a tool call
fails inexplicably) and the cause (this tool's schema will not convert) connect
for the first time.

#### (d) A counter on `applyState`'s belt

`loop.ts:672`'s `.catch(() => {})` becomes an `error`-level record. The contract
allows the applier to swallow its own failures, but "allowed to happen by
contract" and "happened and nobody knows" are two different things. This one is
error rather than warn: state not landing means the transcript and the real state
have diverged, and that is an error the user will see.

`thread-store.ts` belongs to the same family. **Implementation found this
description inaccurate; corrected against the facts**: it is not "three empty
catches", it is three different things, and conflating them gets two of them
wrong.

| location | what it is | handling |
|---|---|---|
| `read`'s first catch | the file does not exist | **not recorded**. A conversation nobody ever restored having no file is the normal path, and recording it means flooding the log with normal operations |
| `read`'s second catch | the file is corrupt | recorded as `warn`. This is the real silent failure — history that was there this morning is gone, and `null` looks exactly like "there never was such a conversation" from the caller's side |
| `write` / `remove`'s catch | already has `console.warn('[peek/chat]', …)` | not empty, its terminus is just console. Rewired to the sink |

The discrepancy itself is worth recording: **"three empty catches" was an
impression from grep, not a fact from reading.**

#### (e) One correlation key running through it

Every place above carries `tag: chatId` when it writes (§3.2). That is the step
that turns them from "scattered lines" into "an internal recording of one
conversation": once the panel filters by tag, a turn that went wrong is a
contiguous dozen lines — from the `prompt` going out, to which events came back,
to which of them were ignored, to the tool calls, to how the turn ended.

**This is the actual deliverable behind the requirement "observe execution errors
inside the agent"**, and its entire cost is writing an already-computed string to
an already-existing sink.

### 3.8 The UI: the error centre grows two tabs, and is renamed

Reuse `ErrorCenter.tsx`'s shell (293 lines) — the status bar anchor, the badge,
copy, clear and the context menu are all there — and add tabs:

| tab | data source | filters | real-time |
|---|---|---|---|
| **Errors** | today's `useErrorLog`, unchanged | today's | ✅ subscribed |
| **Log** | `log.read` | level / namespace / **`tag`** | on open + 2s poll |
| **Commands** | `log.readCommands` | `source` | same as above |

**The badge is driven by the Errors tab only**, unchanged — the badge counts
failures, and a growing log should not flash a red dot.

The top right of the Log tab holds the **level selector** (§3.4bis's third
route); changing it takes effect immediately, without restarting, and without
clearing what has already been written.

**The `tag` filter is where the agent requirement actually lands.** Going from a
turn in the chat panel to "that turn's internal log" should be one click — so
the context menu on each message in the chat panel gains an item, "show this
conversation's log", which opens the panel, switches to the Log tab, and fills
`tag` with that `chatId`. Without that step, what the user gets is a text box
they have to recognise ids for, which amounts to not having done it.

**Rename**: `错误中心` / "Error centre" → `日志` / "Logs". The name is one key in
i18n (one place each in `en/*.ts` and `zh-CN/*.ts`), and calling something with a
Commands tab in it an error centre is wrong. The badge's semantics do not change,
so only the title does. This decision is small and reversible; if the wording
turns out during implementation to reach further than expected, reverting to the
old name affects no other section.

**The Commands tab is the only new capability here**: `CommandSource` divides
into four, every command records it, and `command-origin.test.ts` has been
watching all along — and today that distinction surfaces on one label on failed
entries only. This tab is the first time it is fully visible: what the human
clicked, what the Claude in the panel sent, what an external MCP client sent —
including the ones that succeeded.

### 3.9 Change list

**New**

- `packages/core/src/logger.ts` — interface / levels / formatting, zero fs
- `apps/desktop/src/main/logging/sink.ts` — buffered writing + rotation, mutable
  `minLevel` (§3.4bis)
- `apps/desktop/src/main/logging/scrub.ts` — §3.6's second layer
- `apps/desktop/src/main/logging/index.ts` — assembly: read the level from
  settings / the environment variable, build the two writers, export a bound
  version of `createLogger`
- panel: view components for the two new tabs plus the level selector, under
  `error-center/`

**Changed (infrastructure)**

- `core/mcp-tools.ts` — `McpLogger` becomes an alias of `Logger`
- `core/commands.ts` — add `log.read` / `log.readCommands` (schema + result type
  + handler table)
- `main/bus/command-log.ts` — `CommandLog` gains a sink callback; `push` skips
  `log.*`
- `main/index.ts` — four things: delete the two hand-copied logger
  implementations at `:842` / `:1213`; rewire the two `on('log')` subscriptions
  at `:651` and `:1320` from `console` to the sink (two of the four channels in
  §1.1bis); fix §3.3's renderer forwarding gap; assemble the sink at startup
- `core/package-host.ts:339` — the third hand-copy (it writes stderr, forwarded
  by main, behaviour unchanged)
- `main/acp/manager.ts:1637` — the fourth
- `main/config/paths.ts` — `logsDir`
- `main/config/settings.ts` — `logLevel`
- i18n: one set of strings each in `en` / `zh-CN`, one title changed

**Changed (agent observability, §3.7)**

- `main/agent/endpoint/loop.ts:586` — `ignored`'s reason goes to debug,
  `unknown:*` and the two `without an id` cases go to warn
- `main/agent/endpoint/loop.ts:672` — `applyState`'s empty catch records error
- `main/agent/endpoint/tools.ts:118` — `toParameters`'s fallback records warn
- `main/agent/endpoint/thread-store.ts:113/132/157` — three empty catches record
  warn
- `main/acp/manager.ts:758` — `noise` demoted from "discard" to "record at debug"
- every one of the above carries `tag: chatId`
- the context menu on chat panel messages — add "show this conversation's log"

**Out of scope**

Of the 73 `console.*` calls, the ones in child processes are not all converted.
stdio forwarding already gets them onto disk (§3.3), and converting them to
`createLogger` only sharpens their level and namespace — diminishing returns. The
ones in main go first; they are the sink's immediate neighbours.

## 4. Trade-offs

### 4.1 Why not electron-log or pino

**pino**: JSON-first, whereas the diagnostic trail's first reader is a human (to
be pasted into an issue). Its value is in transport processes and high
throughput, and peek's log volume is nowhere near that order of magnitude.

**electron-log**: it installs its own renderer→main IPC forwarding — and §3.3's
forwarding chain **is already running**, so installing it means introducing a
second route that does the same thing, and two routes each handling the renderer
console at that. This kind of duplication is exactly what the run of items in
PLAN §11.2 cleans up after the fact.

The home-grown volume is small: sink + rotation + formatting, about 200 lines.

**But be honest about this trade's cost**: rotation's edge cases (the file
deleted from underneath, a full disk, concurrent appends) are precisely where
such a library earns its keep, and home-grown means handling them yourself. The
mitigation is §3.3's structural fact — **only main writes**, a single writer, so
the hardest of the three boundary cases does not exist; the other two (external
deletion, write failure) are nailed down by §5's tests.

### 4.2 Why not push-based live logging

See §3.5. In one sentence: paying a permanent IPC tax for a panel that is opened
occasionally, when the real-time property it wants already exists elsewhere.

### 4.3 Why the diagnostic trail and the audit are not one file

The formats fight — one is for humans (alignment, indentation, multi-line
detail), one is for machines (JSONL, for replay). The lifetimes differ too: the
audit should be kept longer, and the diagnostic trail is the fastest-rolling of
the two, so merging would let debug noise crowd the audit out.

The single benefit of merging is "send me one file". That need is better served
by an **"export a diagnostic bundle"** button — packing the two files plus
version, platform and the installed-package list beats making the user find two
files by hand. Not done this time, but the file layout leaves room for it (one
directory, not two scattered places).

### 4.4 Why the error centre is not switched to reading the log file

It looks like unification, and it is in fact breaking something that was done
right:

- It would make a UI concern depend on whether main's writing to disk succeeded
  — and when the disk is full, the error centre is the last thing that should go
  mute along with it.
- It would lose `origin` attribution. The error centre's `source` comes from
  `ResultMeta.origin` / `ConnectionState.origin`, written by the Command Bus **at
  the moment of creation**; the log has no such correlation, and rebuilding it
  means walking back into the heuristic that 2026-08-02 replaced.

So the error centre does not move, and it shares only a shell with the two new
tabs.

### 4.5 Why the audit is not written into SQLite

Considered. Queryable, indexable, and the write-path audit will want it one day.
The reason not to is that it introduces a new persistence dependency and a schema
migration story into main, while the question this version has to answer ("take
away what just happened") is fully answered by a JSONL tail. Switch when the
write path actually lands and "who changed this table last month" is actually
needed — and when that day comes, JSONL is a ready-made import source.

## 5. Verification

### By hand

1. Launch → `~/.peek/logs/peek.log` exists, file 0600, directory 0700
2. Open a connection → run a query → open the chat panel: the log has lines in
   all four namespaces `conn` / `driver` / `bus` / `agent`; `commands.jsonl` has
   the corresponding commands, with `source` reading `ui` and `agent`
   respectively
3. An external MCP client calls `run_query` once → an entry with
   `source: 'mcp'` appears in the audit, and the panel's Commands tab can
   separate it from step 2's by source
4. Connect to a database that does not exist → 1 entry in the error centre
   (**behaviour unchanged**), an error line in `peek.log`, and an `ok:false`
   entry with `errorCode` in `commands.jsonl`
5. Fill it to 2 MiB → `peek.1.log` appears, `peek.log` starts over, nothing old
   is lost
6. Leave the panel open and untouched for 30 seconds → `commands.jsonl` **does
   not grow** (§3.5's self-reference skip is working)
7. In a non-dev build, emit a `console.warn` in the renderer → it lands in
   `peek.log` (§3.3's gap is fixed)

### By hand: the agent half (§3.7)

These are the second round's deliverables, listed separately because they are the
acceptance criteria for the "observe the agent's internals" requirement.

8. Set the level to `debug` (top right of the panel, **without restarting**) →
   send one turn → the `ns=agent`, `tag=<chatId>` lines in `peek.log` read as an
   internal recording of that turn: which events arrived, which were `ignored`
   and why, tool calls' start/end, and how the turn ended
9. **Feed it a fake event**: push a `{ type: 'brand_new_thing' }` into
   `classifyAgentEvent` → a **warn** line `unknown:brand_new_thing` appears in
   `peek.log` (not debug, and not nothing)
10. **Kill the ACP agent process** → the last few lines of its stderr are in
    `peek.log`, including the ones judged `noise` (§3.7(b))
11. Right-click a message in the chat panel → "show this conversation's log" →
    the panel opens, switches to the Log tab, `tag` already filled in, only that
    turn's lines left
12. **Privacy regression**: after running step 8, grep `peek.log` — **zero hits**
    for conversation body and tool arguments (§3.6 item 4). This one matters more
    than the rest, because getting it wrong produces no symptom at all

### Automated

- `core/__tests__/logger.test.ts` — level filtering, `formatLogLine`'s stable
  format, the namespace table being closed
- `main/logging/__tests__/rotation.test.ts` — rolls when full, retention count,
  **recovers after the file is deleted from underneath it**, and a write failure
  does not throw at the caller (a logging system should not become a new source
  of crashes)
- `main/logging/__tests__/scrub.test.ts` — bearer / `password=` /
  `Authorization:` / the literal value of the token in mcp.json
- `main/bus/__tests__/command-log.test.ts` — one case added: `log.read` does not
  enter the log, `state.read` does
- `agent/endpoint/__tests__/events.test.ts` — **one level assertion for each of
  the 11 `ignored` branches**: the 6 everyday events are `debug`, `unknown:*` and
  the two `without an id` cases are `warn`. This test's value is not "is the
  level right", it is that **it is a list that changes along with
  `classifyAgentEvent`**: add a new discard branch in the future without having
  thought about what level it should be, and this goes red.
- `agent/endpoint/__tests__/log-privacy.test.ts` — run a fake session with
  `text_delta` and tool calls, and assert that **not one** of the resulting
  `LogRecord[]` contains delta text or tool arguments (§3.6 item 4)
- **a section added to `apps/desktop/scripts/verify-chat-security.mjs`**: after
  the run, grep every file under `~/.peek/logs/`; zero hits for the token.

  That last one is the only assertion in this design nailed to **something that
  ships** — the standard set by 'guards nailed to shipped code' on 2026-08-12: an
  assertion nailed to something that does not ship leaves nobody knowing whether
  to care when it goes red. When the token leaking into a log goes red, somebody
  has to care.

## 6. Documents that change along with this

- **PLAN §6**: "the Command log is naturally an operation recording, replayable
  and testable" — add a sentence saying it really is written to disk now, and
  point here.
- **PLAN §7**: add `~/.peek/logs/` to the audience list on "the token does not go
  into logs", and point at §3.6.
- **PLAN §10 "Settled"**: add a sentence to "the error centre's `source`
  attribution" — the rejected route was reopened this time for **a different
  use**, and the cost (an IPC channel + a preload member) was not paid, because
  reading goes through the Command Bus.
- **PLAN §10 "Still open · writes", item 3**: the audit's three options are
  settled as "written to disk and visible in the UI", for the reasons in §2.2.
- **PLAN §3**: in the bullets under the process-model diagram, add "logging
  converges on main in one place, over the existing stdio forwarding".
- **`2026-08-04-endpoint-keyless-and-stream-errors.md`**: that document solves how
  **upstream errors** reach the user (the `stopReason: 'error'` route on
  `message_end`, which this design does not touch). Add a sentence pointing back
  at §3.7: the `ignored` branch right beside it had no way out until now — the two
  together are the complete answer to "what can be seen when the endpoint goes
  wrong".
- **PLAN §11.2**: `ignored`'s reason being discarded, ACP stderr losing half by
  default, `toParameters` falling back silently — these three are textbook
  "structural issue" entries, and once fixed they get an entry in that section's
  format (what it was, why it looked reasonable at the time, what it is now).
