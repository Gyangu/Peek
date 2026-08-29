# Chat session management: the entry point, the lifecycle, and restoring history

> 2026-08-02. Trigger: the user could not find the "New conversation" button, and
> asked "is there some kind of chat management?".
> Both questions stand; the second conflicts substantively with the existing
> design in `docs/PLAN.md` sections 5 and 9, which was checked face to face, and
> the user settled on **full session management** (sessions decoupled from views +
> history that can be restored), with the entry point in the **status bar**.

## 1. What this fixes

### 1.1 Where things stand

**The entry point exists only in "empty" contexts.** Two places in the whole
codebase can open a `chat` view:

- `EmptyPanel` in `renderer/components/Panel.tsx` — rendered only when a panel has
  no tabs at all;
- `renderer/components/FirstRunGuide.tsx` — rendered only when there is not a
  single connection.

The sidebar header holds ⚙ and ＋ (new connection), the tab strip holds "split
left/right / split top/bottom / close panel", and `hooks/shortcuts.ts`'s key table
has no entry for it. Which is to say: **once a database is connected and something
is open in a panel, there is nowhere left in the interface to start a new
conversation**; the only way is `⌘\` to split off an empty panel and then click
the button inside it.

**A session's lifecycle is nailed to a view.** `chatId` is minted on the spot by
`buildChatViewState` when the view opens (`main/bus/handlers/chat.ts`); the moment
`watchChatViews` finds a `chatId` outside the `live` set it emits `session.close`.
The transcript's source of truth is a `ChatId`-keyed store in main — process
memory, never written to disk. The result: **no session list, no renaming, closing
the tab is permanent, and so is a restart**.

### 1.2 The conflict with PLAN (checked)

PLAN section 5 makes `chat` "the sixth view kind", and section 9 writes that it
"runs as a subprocess inside the `chat` view". In that model a session **is** a
view; it has no second identity. "Session management" requires a session to exist
while no view holds it — a view is merely one window onto it. This is a
substantive extension of PLAN; this document is the new source of truth, and PLAN
sections 5 and 9 are updated accordingly.

### 1.3 Boundary (explicitly not done)

- **No session search or full-text search.** The list is sorted by time, which is
  enough.
- **No fork / branching conversations.** `session/fork` exists, but it solves a
  different problem.
- **No cross-window session sharing.** peek is still single-window.
- **peek does not persist transcripts of its own.** The reasoning is in section 3;
  this is the design's most important trade-off.
  > **2026-08-03 revision**: this one **splits by backend**. For the ACP profile it
  > still holds, word for word; for the endpoint profile it no longer does — there
  > is no agent-side copy there, so not persisting means zero copies. See the
  > revision note at the end of §3.1 and
  > [`2026-08-03-chat-history-ownership.md`](2026-08-03-chat-history-ownership.md).
- **No session-deleting tool for the embedded agent.** See 2.7.

## 2. The plan

### 2.1 The decisive premise: the history is already on disk

`@agentclientprotocol/claude-agent-acp@0.64.0` advertises this unconditionally in
`initialize`:

```js
loadSession: true,
sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
```

And `loadSession(params)` is implemented as `getOrCreateSession(params)` +
**`replaySessionHistory(sessionId)`** — the history is replayed to the client as
ordinary `session/update` notifications, so `acp/translate.ts`'s existing
translation path works as it stands and no new data format is needed.

`listSessions({ cwd })` returns `{ sessionId, cwd, title, updatedAt }[]`, where
`title` is `customTitle ?? summary`, the SDK's own generated summary.

And peek's agent cwd is fixed at `~/.peek/chat` (`ensureChatWorkdir` in
`acp/session-config.ts`), so filtering by cwd naturally yields only peek's own
sessions and never mixes in the Claude Code sessions the user ran elsewhere.

**Measured**: the directory under `~/.claude/projects/` that corresponds to
`~/.peek/chat` (the SDK swaps the cwd's path separators for `-` to make the
directory name) already holds 27 `.jsonl` session files. `AcpManager.closeChat`
has never called ACP's `session/close` — it only cleans up locally — so every
"close the chat tab" has left a complete history on disk, and peek simply has no
path that reads it.

**Conclusion: peek does not need a history store of its own; it needs to wire up
what already exists.**

### 2.2 Sessions decoupled from views: identity lands on `agentSessionId`

What this introduces is not new storage but a new **identity**:

| concept | what it is | lifetime |
|---|---|---|
| `agentSessionId` | the agent-side session's real identity, and the key to that history on disk | across views, across app restarts |
| `chatId` | peek's runtime id for *this mounting*, and the key to the transcript mirror | lives and dies with the view |
| `ViewId` | one tab in the window | ends when the user closes it |

`chatId` is demoted from "the session's identity" to "a handle on this mounting".
That keeps the change surface as small as it goes: the transcript store, the delta
channel and `read_chat` are all indexed by `chatId` and not a line of them moves;
the only place that has to branch is "when a chat view opens, is this
`session/new` or `session/load`".

`ChatViewState` gains one optional field:

```ts
/** When this view is restoring an existing session, which one it is restoring. */
resumeSessionId?: string
```

`view.open`'s spec is extended to match: `{ kind: 'chat', resumeSessionId?: string }`.

### 2.3 Closing is detaching, not destroying

`watchChatViews`'s semantics become: a vanishing view still emits the
`session.close` effect, but `AcpManager.closeChat`'s documented contract is
rewritten as **detach** — release this process's batcher, timers and pending
permissions, and **leave the agent-side session alone**. In code this is very
nearly nothing (it never called `session/close` in the first place), but it turns
"a cleanup that happens not to be implemented" into "a guarantee that is written
down", locked by a test.

Actual deletion goes through a command of its own; see 2.5.

### 2.4 Restoring a session

```
the user clicks a row in the session list
  → dispatch('view.open', { spec: { kind: 'chat', resumeSessionId } })
  → buildChatViewState mints a new chatId, carrying resumeSessionId
  → watchChatViews reports session.open
  → before the first send, #ensureSession takes session/load rather than session/new
  → the agent replays the history → session/update notifications → translate.ts → ChatDelta → the transcript mirror
```

Two details that have to be handled:

1. **The state during a replay**. A history replay floods in a large number of
   deltas within tens of milliseconds, and throughout it `agentStatus` must be a
   "loading" state and not a "generating" one — otherwise the Composer is locked by
   `busy` and a stop button appears on a session with no turn to stop. A new
   `ChatAgentStatus` member `'loading'` joins `'starting'` in `notReady`.
2. **The exception to lazy creation**. The current policy is "opening a panel
   creates no session; the first prompt does" (`chat-host.ts`'s `session.open`
   branch says so explicitly). Restoring has to break it: a user who opens a
   historical session expects to see history, not an empty panel waiting for them
   to speak first. So when `resumeSessionId` is present, the `session.open` effect
   triggers a load immediately. **Only this branch connects early**; lazy creation
   is unchanged for new sessions.

### 2.5 New commands

| command | what it does | shape |
|---|---|---|
| `chat.sessions.list` | passes `session/list({ cwd })` through and returns the session list | `read` (async) |
| `chat.sessions.delete` | passes `session/delete` through | `reduce` + effect |

The precedent is `conn.book.list` — a command that changes no Workspace state and
only answers a question, which the Command Bus already accommodates. **No
renaming**: ACP exposes no method for changing a title (the SDK has only the
agent→client `session_info_update` notification), and a title peek stored itself
would immediately fight the agent's generated one; leaving `view.update` to change
`title` as a local "this tab only" rename is enough.

Two details settled during implementation and worth writing down:

**`CommandReader` may return a Promise; `CommandReducer` still may not.** The
session list has to ask the agent, whereas the `conn.book.list` precedent reads a
local file and is synchronous by nature, so a read-only command doing I/O arises
here for the first time. Opening up the reader is safe: a reducer's synchrony is
what makes every check-and-set race-free (`chat.send`'s "is a turn already
running" rests on it), while a reader changes nothing and has no window to
protect. The bus awaits only when the return value really is a Promise, so no
other command spends even a microtask.

**Deleting a session that is currently open is a CONFLICT, not "close that view
while we are at it".** The original plan had delete close the view holding the
session; that was rejected during implementation, for two reasons. First, `chat.ts`
deliberately does not import `shared.ts` (the direction is `shared.ts` →
`chat.ts`), so it cannot reach `closeView`, and copying the close logic means
redoing `removePanelTab`'s tree surgery. Second, and more fundamentally: one click
does two things, and the one it does quietly throws something away. The window
saying "close it first" is one sentence, not an accident.

### 2.6 UI: a status-bar button plus a session list

> **This section's presentation has been revised by
> `2026-08-02-chat-sessions-side-rail.md`**: the session list moves from a modal
> dialog to a permanent right-hand rail, and the status bar's "Conversations"
> button becomes a toggle for that rail. What follows about **the entry point
> being in the status bar**, **what each row shows**, and **the data staying out of
> the Workspace** still holds.

Per the alignment, the entry point goes in the status bar (`StatusBar.tsx`), as
two things:

- **a "New conversation" button** — `view.open { kind: 'chat' }`, landing in the
  currently focused panel;
- **a "Conversations" button** — toggles the session list.

The session list is **not a seventh view kind**. It lists what `session/list`
returns, and each row shows the title, a relative time, and an "already open"
marker (when its `agentSessionId` matches a live view). Behaviour: click a row →
open or focus it; delete → `chat.sessions.delete` after a second confirmation.

> The **shape** of that second confirmation has been hardened by
> `2026-08-02-ui-legibility-baseline.md` §2.5: the confirming state is
> `[Cancel] [Confirm delete]`, with "Cancel" occupying the original button's
> position. Still two clicks, still no modal.

The data is pulled on demand by command; it does not enter the Workspace mirror.

### 2.7 The security boundary

The MCP tool surface is registered explicitly (`mcp/registry.ts` collects
`tools/*.ts` with `import.meta.glob`, one tool per file), so a new command does
**not** automatically become a tool. This design states:

- **No `list_sessions` / `delete_session` tools are added.** An embedded agent able
  to delete its own history and its neighbours' is a destructive surface with no
  corresponding benefit.
- The `title` in the session list comes from an agent-generated summary and **is
  untrusted text**: it renders through `core/untrusted-text.ts`'s existing path,
  treated exactly like a result cell.

## 3. Trade-offs

### 3.1 Leaning on the agent's storage, rather than persisting transcripts ourselves

**Chosen**: wire up `session/list` + `session/load`.
**Not chosen**: peek writing `ChatTranscript` into `~/.peek/chats/` itself.

The reason: doing it ourselves immediately produces two histories. The agent-side
`.jsonl` is **the context the model actually sees**, while peek's copy is only a
projection for display; the moment the two disagree — after the agent compacts,
say — a restored session shows "what is on screen is not what the model
remembers", which is the hardest class of bug to chase. And `core/chat.ts`'s
contract already says "persistence (if any) is a separate concern"; it never
promised that peek is that persistence layer.

The costs, written down here so they are not chased as bugs later:

- **A different agent means no history.** For any ACP agent that does not advertise
  `loadSession`, the session management panel shows an empty list and says why,
  rather than raising an error. The degraded path has to be written.
- **peek cannot delete cleanly.** `chat.sessions.delete` deletes the agent's
  session file; peek has no say over the rest of `~/.claude/`, and should not have
  one.
- **Change the cwd and the history is out of reach.** Change `PEEK_CONFIG_DIR` and
  the cwd follows, and `session/list` naturally sees only the sessions under the
  new cwd. This is correct behaviour (test isolation depends on it), but the UI has
  to say so.

> **2026-08-03 correction: an index that holds nothing but routing.**
>
> Once the chat panel became multi-backend
> (`2026-08-03-pluggable-agent-backends.md`), "ask the agent for the list" stopped
> working: Claude Code's and Codex's history formats do not recognise each other,
> and the endpoint profile **does not exist at all** on the agent side — there is
> no process to ask. A mixed list demands one unified outlet, and one of its
> sources is peek itself.
>
> Hence `~/.peek/chat/sessions.json`: **routing only** (which profile this session
> belongs to, what its `agentSessionId` is, when it was created), and **no
> transcript whatsoever**. What is objected to above is keeping a second copy of
> the history — two copies diverge, and the agent's is the real one; the index
> answers only "who do I ask", and there is still exactly one transcript, still in
> its own source. Each agent also gets its own cwd subdirectory
> (`~/.peek/chat/<profileId>/`) so that one `session/list` does not see another's
> files; Claude Code keeps the root directory, so that its existing sessions do not
> vanish.

> **2026-08-03, revised again: the endpoint profile must store its own, because
> there is no second candidate for the truth there.**
>
> The correction above left the index at "routing only", on the grounds that "the
> agent's copy is the real one". **That sentence does not hold for the endpoint
> profile**: there is no agent process there, no `.jsonl`, no `session/list`. "Not
> persisting" there is not "only one history", it is **zero** — measured, the
> consequences are that `listSessions()` always returns an empty list,
> `sessions.delete` always reports the session is already gone, and `closeChat`
> simply drops the `Agent` instance holding the entire context: **closing the tab
> deletes it permanently, on the spot**.
>
> So the dividing line is not "should peek persist", it is **whether this
> conversation's body has another owner**:
>
> - **The ACP profile**: it has an owner. Still not one byte stored; it replays
>   through `session/load`. The cost is that the agent deletes by its own rules
>   (Claude Code's `cleanupPeriodDays` defaults to 30 days), and peek's answer is to
>   say so clearly when a load fails, rather than to take custody on its behalf.
> - **The endpoint profile**: peek *is* that agent. The body is stored in
>   `~/.peek/chat/endpoint/<sessionId>.json`, holding both "the transcript on
>   screen" and "the model's context" — both land in one file in one write, so there
>   is no window in which they can diverge, and neither can be derived from the
>   other. The routing index therefore also gains `title`/`updatedAt` for the
>   endpoint profile: the ACP profile does not store those two fields because it can
>   ask the agent, and the endpoint profile has **nobody to ask**.
>
> Zed drew the same line independently inside the same ACP ecosystem — an external
> agent's body does not enter its database, its own agent's does — with the
> measurements in
> [`2026-08-03-chat-history-ownership.md`](2026-08-03-chat-history-ownership.md) §4.1.

### 3.2 Not a seventh view kind

> This trade-off **still stands**. Where it landed at the time was a dialog, later
> changed to a permanent right-hand rail
> (`2026-08-02-chat-sessions-side-rail.md`) — which is equally outside
> `VIEW_KINDS`, and the argument below is unchanged, word for word.

**Chosen**: an interface that does not belong to `VIEW_KINDS` (a dialog at first,
a right-hand rail now).
**Not chosen**: a `{ kind: 'chats' }` view.

A seventh view kind costs globally: `VIEW_KINDS`, `describeView`, `summarizeView`,
`ViewHost`, `StatusBar`, `descriptors.ts` and MCP's `open_view` schema all need a
new branch, for a view that binds to no connection, holds no results, and takes no
part in drag semantics. PLAN section 5's six view kinds share one property —
**each of them is a window onto data** — and a session list is not. Putting it in
a dialog preserves that property.

Conversely, if the session list later has to be openable by an AI and pinnable
beside a data view, promoting it to a view then costs one dialog's worth of
migration, which is affordable.

### 3.3 `agentSessionId` as the identity, rather than an id peek mints

**Chosen**: use the agent's session id directly.
**Not chosen**: peek generating a stable id and maintaining a
`peekSessionId → agentSessionId` mapping table itself.

The table has to be persisted, has to handle orphans (deleted agent-side by the
`claude` CLI while peek still holds a row), and has to handle the reverse orphans.
The only thing it buys is "peek's id is not affected by the agent" — and in a
design that entrusts the history entirely to the agent, that independence is fake.

## 4. Verification

### 4.1 Automated

All landed and passing (1,264 tests, `pnpm -r test`; the `db-postgres` failure is
PG not running on this machine and is unrelated to this change). `stub-agent.mjs`
gains two switches: `STUB_NO_HISTORY` (advertise neither `loadSession` nor
`sessionCapabilities`) and `STUB_SESSIONS` (which sessions `session/list`
reports).

- `acp/__tests__/manager.test.ts` (9 new): `session/load` when `resumeSessionId`
  is present and `session/new` when it is not; **a replay lands in the transcript**
  (locking the ordering "the reverse index is registered before the request", see
  2.4); the `loading` state is reported and `starting` is not; opening the same
  session twice in one view does not replay twice; `closeChat` sends **neither**
  `session/close` **nor** `session/delete` (locking 2.3); the catalogue filters by
  cwd and reports the cwd back; an agent with no history support answers
  `supported: false` and **never sends** `session/list` at all; a load aimed at
  such an agent is refused up front with no request sent; a delete reaches the
  agent.
- `bus/__tests__/chat-commands.test.ts` (6 new): the initial shape of `view.open`
  carrying `resumeSessionId` (`resumeSessionId` sticks, `agentStatus: 'loading'`,
  `agentSessionId` still null); the `session.open` effect carries the resume id
  while an ordinary new session does not; delete's effect and its CONFLICT path;
  list spends no revision.
- `mcp/__tests__/tool-surface.test.ts` (new file): no file under `tools/` mentions
  `chat.sessions.delete`, and no tool name contains `session` (locking 2.7).
  Complementary in direction to `verify-chat-security.mjs` — that one checks "every
  tool the server offers corresponds to a file", this one checks "those files
  contain none of these commands".
- `acp/__tests__/session-config.test.ts`: it used to check only that `session/new`
  carries the sandbox, and now **checks both paths** — a resumed session runs the
  same tools with the same permissions, and without the sandbox it inherits the
  user's global Claude Code configuration just the same.
- `renderer/components/chat/__tests__/chat.test.ts` (2 new): `'loading'` is in
  `notReady` but not in `busy` (input disabled, no stop button drawn); every member
  of `ChatAgentStatus` has copy in both en and zh-CN — a gap there is silent, the
  new state renders as the key itself, and it shows up only in the state that is
  hardest to reproduce.

### 4.2 The script that runs against a real agent

```bash
node --import ./src/main/bus/__tests__/ts-resolve.hooks.mjs scripts/verify-chat-sessions.ts
```

A new `apps/desktop/scripts/verify-chat-sessions.ts`, of the same kind as
`verify-chat-security.mjs`: it spends no tokens (`session/list` reads a directory,
`session/load` is a replay, and not one prompt is sent), it reads the user's real
`~/.peek/chat`, and it neither writes nor deletes.

**It caught a bug the unit tests could not, so the rule is written here: a change
to the ACP layer is not verified until this script has run.** A unit test can only
corroborate the fixture sitting next to it — the stub replayed only
`agent_message_chunk` at the time, so it was perfectly self-consistent with a
translator that discarded `user_message_chunk` unconditionally. A real agent
replays both sides. §5 has the detail.

Measured (2026-08-02, with 27 real historical sessions): the catalogue is
complete, the cwd filter is correct, `loading → ready`, the 42KB session replays
into 4 messages / 1041 characters / 6 tool calls / both roles present / opens and
closes balanced, and the session is still in the catalogue after its view is
closed.

### 4.3 UI (CDP, needing no screen control)

Start the build output (with its own `--user-data-dir` and MCP port, to avoid
fighting an installed peek for the single-instance lock), attach
`--remote-debugging-port`, and use `Runtime.evaluate` to read the DOM and click
its own handlers. Measured and passing:

1. The status bar holds both a `New conversation` and a `Conversations` button —
   still there when panels fill the window.
2. Clicking "New conversation" brings up a chat panel with a usable Composer (with
   no need to clear an empty panel first).
3. "Conversations" opens the dialog, listing **27** real sessions whose titles are
   agent-generated summaries.
4. Clicking a row's `Open` → the dialog closes itself, one more tab appears in the
   same panel (`.chat-view` renders only the visible tab, so count tabs and not
   views), not an empty state, `Ready`, and the transcript's roles read
   `You,Claude,Claude,Claude`.
5. That row immediately becomes `Already open` (disabled), with `Delete` disabled
   too — 2.5's CONFLICT is blocked in the UI before it can happen.

"Survives a restart" needs no separate step: the above ran across three
independent app instances, and each listed the same 27.

**One thing not verified**: deletion against a real agent. The only thing there is
to delete is the user's own history, and it is not worth destroying for one
verification — the stub side (`manager.test.ts`) covers that path, and its
transcripts are disposable.

### 4.4 The degraded path

`STUB_NO_HISTORY=1` covers it in the unit tests: an agent that does not advertise
`loadSession` gets `supported: false` (and `session/list` is **never sent**), and
a load aimed at it is refused up front. In the UI that is the sentence "this agent
does not keep conversation history", rather than an empty list that reads as "you
have never had a conversation".

## 5. A bug found and fixed during implementation

`translate.ts` used to discard `user_message_chunk` unconditionally, with a
comment saying peek had already recorded it when the command ran, so replaying it
would draw two bubbles. **That sentence holds for a live conversation and not for
a replay** — during a replay peek has recorded nothing, because that conversation
happened in a previous run's process, possibly on a previous day. The result was
that opening a historical conversation showed Claude talking alone, answering
questions nobody had asked.

The fix is not to delete that branch but to let it know which situation it is in:
`TranscriptTranslator` gains `beginReplay()` / `endReplay()`, bracketed around
`session/load` by the manager — **said by the one that knows, because it is the
one that made the request** — rather than guessed from the shape of a message.
`#ensureMessage` also gains a role parameter: a change of speaker must start a new
message, or a replay carrying no `messageId` would run "question, answer, question
again" into a single bubble.

Both directions are locked: a replay keeps the user's words (`user,agent`, each
closed off), and a live turn is still recorded once (one user bubble, not two).
