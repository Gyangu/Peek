# The second and a half spent opening a stored conversation: the snapshot paints first, the real thing overwrites it

> 2026-08-06. The trigger: a user reported that "loading a conversation is a bit slow". The
> investigation found that the slow stretch is entirely outside peek — but what peek displays during
> that second and a half is wrong, and there is more it can do than it does. This document is the
> reconciliation's conclusion and the grounds for the implementation.

## 1. What this fixes

### 1.1 What that second and a half is, measured

The user is configured on the ACP backend (`agent.backend` in `~/.peek/settings.json` is `acp`, and
the agent is Claude Code). From clicking a stored conversation in the session rail to its content
appearing, measured stage by stage:

| stage | elapsed |
|---|---|
| spawning the agent process + `initialize` | ~190–220 ms (paid once, only on a cold agent start) |
| `session/list` | ~17 ms |
| **`session/load` (this session's first time within this agent process)** | **1480–1988 ms** |
| `session/load` (the same session a second time) | 1 ms |
| `session/set_mode` | 1 ms |
| replaying history (31–57 `session/update`s) | 0–3 ms |

Three facts, all measured rather than reasoned:

**① It has nothing to do with the size of the history.** A 4.9KB session takes 1606ms, a 302KB one
1519ms. The replay itself is only 3ms — the agent sends not one byte of history during that second
and a half, and then fires all 57 messages out at once within 3 milliseconds.

**② The time goes into building the session, not into fetching the history.** `session/resume` is
the knife that separates them, since by ACP's definition it "resumes a session but **does not return
history messages**":

```
session/resume  51021004               1568 ms   ← builds the session, hands over no history at all
session/load    51021004 (after resume)   3 ms   ← only the history replay is left
session/list                             17 ms   ← builds no session at all
```

**Fetching the history is worth 3 milliseconds; building the session is worth a second and a half.**

**③ That second and a half is spawning a subprocess plus one network round trip.** Inside the agent,
`loadSession` is `getOrCreateSession()` + `replaySessionHistory()`. The former reaches
`await q.initializationResult()`, which is the Claude Agent SDK starting a native `claude` binary and
waiting for its handshake. Catching the process and its CPU:

- 150ms: `pgrep` catches the subprocess
  `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
- 150→400ms: the cumulative mean CPU climbs to 48%, the binary initialising itself;
- 400→1350ms: the cumulative mean CPU falls all the way to 2.2%, the process state is `S` (sleeping),
  and the TCP connection is ESTABLISHED throughout — **it is waiting on the network**;
- 1350ms: the state turns `R`, the response arrives; it returns at 1460ms.

The decisive check: point the proxy at a port that refuses immediately, and `session/load` goes from
1.5 seconds to **17.5 seconds** (retrying until timeout). That ruled out two suspects along the way —
without `HTTP_PROXY` it is 1456ms, no different from 1461ms through the proxy, so the proxy is not
the cause; and `claude --version` takes only 50ms, so the binary's startup is not the cause either.

**Conclusion: that second and a half is inside the agent, and peek has no way at the protocol level
to make it shorter.** ACP's complete set of session methods is `cancel` / `close` / `delete` /
`fork` / `list` / `load` / `new` / `prompt` / `request_permission` / `resume` / `set_config_option` /
`set_mode` / `update`, and "read the transcript only" is not among them: `session/list` builds no
session but hands over metadata only (`sessionId` / `cwd` / `title` / `updatedAt`), `session/load`
hands over the body but building a session is part of its semantics, and `session/resume` builds the
session but explicitly hands over no body. The protocol welds "the body" and "a live session"
together.

### 1.2 The real defect: during that second and a half the screen tells a lie

`ChatView`'s empty-state branch is conditioned on `messageCount === 0`
(`components/chat/ChatView.tsx:247`), and during `loading` there is not one message in the mirror. So
the user opens a stored conversation that **plainly has content** in it, and dead centre on the
screen it says:

> **Ask about the data you are looking at**
> (`chat.empty.title`, the guidance for a new conversation)

This is not "slow", this is **stating something false**. What the user reads is "this conversation is
gone", not "it is being read". The `loading` dot on the status bar and one line of small type do not
counteract that sentence in the middle of the screen.

Compare Zed: for the same second and a half, it replaces the whole panel with a centred line of
`Loading…`, with a 2-second breathing animation (`crates/agent_ui/src/conversation_view.rs`, the
`ServerState::Loading` branch). **It optimised nothing at all, but it does not lie.** On this point,
peek is currently worse than it.

### 1.3 What Zed does, and what it does not

The source has been checked, and the conclusion is plain: click a history item →
`ServerState::Loading` → send `session/load` directly → wait. Grepping `conversation_view.rs`,
`agent_connection_store.rs` and `agent_servers/src/acp.rs` for `prefetch` / `preload` / `warm` gives
zero hits. No warming up, and no painting a local copy first.

peek already has equivalents of the two things it does right:

- **ref_count reuse** (`open_or_create_session` in `acp.rs`): an already-open session is returned
  directly, and concurrent loads share one pending task. On peek's side this is the agent-side cache
  plus `closeChat` not sending `session/close` (`acp/manager.ts:588`), which has the same effect —
  1ms the second time it is opened.
- **Registering the session before sending the request**, because the history replay's notifications
  arrive before the RPC has returned. peek's `#replay` has exactly the same handling and exactly the
  same reason in its comment (`acp/manager.ts:997`). Both sides walked into the same hole
  independently.

**A mature product accepted this latency**, and that is this design's floor: as long as it does not
lie, waiting a second and a half is shippable. What this document does is go one step beyond that
floor.

### 1.4 Boundary (explicitly not done)

- **No hover warm-up.** The argument is in §3.3.
- **No copying the agent's `.jsonl`.** That is model context, not a screen projection; the reasoning
  is in §3.2.
- **The snapshot is not used for search, export, forking or renaming.** Following
  `2026-08-03-chat-history-ownership.md` §1.3's boundary.
- **No fighting Claude Code's 30-day cleanup on its behalf.** Following the same document's §3.1, and
  see §2.6.
- **The endpoint backend is untouched.** Its body store (`agent/endpoint/thread-store.ts`) is the
  single source of truth, its semantics are the opposite of this document's snapshot, and the two do
  not merge; the reasoning is in §2.2.

## 2. The plan

Two steps, of which the first stands on its own.

### 2.1 Step one: the empty state is not allowed during `loading`

`ChatView`'s branch changes from "no messages in the mirror → the guidance" to three states:

```
agentStatus === 'loading'  → the loading state: the session title + "reading this conversation from <agent>"
messageCount === 0         → the guidance (it really is an empty conversation)
otherwise                  → MessageList
```

Where the title comes from: `session/list` already returns `title`, the session rail is already using
it (`ChatSessionsRail`), and it is already on the `view` when the view is opened. Where it cannot be
had, say only "reading this conversation" — **better to say less than to say something wrong**.

This step does not depend on step two, does not depend on any storage, and should stay even if
everything after it is overturned.

### 2.2 Step two: a read-only snapshot for the ACP backend

`~/.peek/chat/snapshots/<sessionId>.json`, one file per session.

```ts
interface AcpSnapshotFile {
  version: 1
  sessionId: string
  /** The copy that was once shown on screen. That is all. */
  transcript: ChatMessage[]
  updatedAt: number
}
```

**There is no model context in this structure, and that is deliberate.** The endpoint backend's body
store (`EndpointThreadFile`) stores two copies — `transcript` (the UI) and `messages` (the model's
memory) — because there peek *is* the agent, and not storing it means storing zero copies. Here it is
the reverse: the model's memory belongs to Claude Code, and all peek stores is the screen projection.
**A file with no model context in it is structurally incapable of answering "what does the model
remember"**; it can only answer "what was shown on screen". This is §3.1's boundary made a technical
guarantee inside this plan — not a promise, but an inability.

The directory chosen is `snapshots/` rather than reusing `endpoint/`: what lives there is the single
source of truth, what lives here is a projection, and mixing them in one directory means somebody
eventually writes code treating the two as the same kind of thing.

**Where the body comes from.** ACP's `ChatSession` currently keeps no transcript — deltas are
translated and sent straight out, and the main process does not store them (the structure at
`acp/manager.ts:148` has no such field), which is exactly the status quo of "peek does not store ACP
bodies". A main-process-side projection is now needed, and the tool is off the shelf:
`applyChatDeltaToMessages` (`packages/core/src/chat.ts:222`) is the very one the endpoint backend
uses in `#emit` to maintain `session.transcript` (`agent/endpoint/loop.ts:656`). Adding the same fold
to ACP's `#emit` is enough.

**When it is written to disk.** At the end of a turn, and when a `session/load` replay completes
(the moment the snapshot is refreshed by the real thing is when it is most accurate). Not per token —
the reason is the same as the endpoint backend's: landing on disk once per delta during streaming is
precisely the overhead that moving the transcript out of the Workspace set out to dodge.

### 2.3 The new sequence for opening a stored conversation

```
click a session row
  │
  ├─ the main process reads the snapshot ──→ present: transcriptToDeltas assembles deltas and sends them to the render layer (0ms, the user starts reading)
  │                                          at the same time patch status = 'loading', and hang a "snapshot" notice at the top of the transcript
  │                                      └ absent: take §2.1's loading state
  │
  └─ session/load in the background (~1.5s)
        ├─ succeeds → reset + the agent's real replay overwrites it → the notice comes off → status = 'ready'
        └─ fails → see §2.4
```

The overwrite channel does not need building: a `reset` delta plus a replay is exactly the road
`reloadChat` already takes (`acp/manager.ts:463`), and the render layer's `applyOne` already handles
both `reset` and an id-idempotent `message.start`. **The render layer does not need to know whether
the body came from the snapshot or from the agent** — which is the whole point of the `ChatDelta`
abstraction, and the same reason as `2026-08-03-chat-history-ownership.md` §2.4.

In the few seconds the user spends reading the history, the second and a half is long past. That is
the entirety of where this plan's benefit comes from: **it did not make load faster, it made the user
not have to stare at load and wait.**

**The first time each conversation is opened still waits.** A snapshot is something that exists only
after peek has seen it — the write points are the end of a turn or the completion of a `session/load`
replay — so a stored conversation that has never been opened in peek (including all history from
before this change lands) takes the old road the first time it is clicked: wait 1.5 seconds, the
replay completes, and a snapshot is left behind in passing; from the second time on, content appears
immediately.

This is not a regret, it is this design's definition: peek paints only what it has seen itself.
Making the first time fast too would mean reading the agent's `.jsonl` — which is precisely the road
§3.2 refuses.

### 2.4 The failure path: a snapshot may never impersonate the real thing

This is the plan's one hard bone, and the thing §3.1 is genuinely worried about.

When `session/load` fails — an unreachable network takes 17.5 seconds to fail, and `loadSessionMs`
caps at 120 seconds (`acp/types.ts:211`) — the snapshot is already on screen. At that point it is
mandatory to:

1. change the notice at the top of the transcript from "reading" to **an explicit statement of
   failure**: this is peek's local snapshot, Claude Code could not read this conversation back, and
   **it is not live**;
2. **disable the composer**, with a "retry" button attached.

Item 2 is this section's point, and the one most easily written loosely. Sending a message on top of
a snapshot means letting the model answer without being able to see this history — the user reads a
screen full of history, and the model answers as if nothing had happened. That is the scenario
`2026-08-03-chat-history-ownership.md` §3.1 warns of word for word: "what a restored session displays
and what the model remembers are not the same thing". Allowing a message to be sent in the failure
state is building that bug with one's own hands.

Compare §2.5's existing handling — when a session is deleted by the agent's 30-day cleanup, an
explanation is presented on the transcript. That path does not change, only that there may now be a
snapshot underneath it, so the explanatory copy has to merge into one sentence saying two things: why
the history cannot be read back, and what the things on screen are.

### 2.5 Stale snapshots

peek's snapshot covers **only the part peek has seen**. If the user has continued the same session in
a terminal with `claude`, the snapshot is out of date. On the normal path this is harmless — the
moment `session/load` returns it is overwritten wholesale — but in the failure state, what is on
screen may be neither live nor current. §2.4's notice therefore cannot be written as "this is this
conversation's history"; it can only say "this is how peek last saw it".

### 2.6 The snapshot's lifecycle

- `chat.sessions.delete` deletes the snapshot along with the session, in the order agent, then
  snapshot, then routing — the reverse would leave an orphan file nobody could attribute, on the same
  reasoning as `AcpManager.deleteSession`.
- When `session/load` fails outright **and** the session has disappeared from `session/list` (that
  is, `explainLoadFailure` judges it already cleaned up), delete the snapshot. This is not "fighting
  the cleanup", quite the opposite: the agent has already deleted it, keeping an orphan projection in
  peek is pointless, and deleting is following rather than fighting.
- `closeChat` does not touch the snapshot, on the same reasoning as it not touching the agent
  session.

## 3. Trade-offs

### 3.1 How that §3.1 boundary is revised

`2026-08-03-chat-history-ownership.md` §1.3 says "**do not land ACP bodies on disk**", and its §3.1
argues it out over a whole section: the agent's `.jsonl` is the context the model actually saw, the
copy peek made is a projection for display, and once they fork, "what a restored session displays and
what the model remembers are not the same thing".

This change conflicts with that head on. The reconciliation's conclusion: **not overturned,
narrowed.**

What §3.1 opposes is "peek's copy becoming a second **truth**". Its chain of reasoning is: both
copies can answer "what does the model remember" → the two will fork → on restore nobody knows which
to believe. This plan cuts the first link:

- the snapshot **contains no model context** (§2.2), and is structurally incapable of answering that
  question;
- the snapshot's role is confined to **a placeholder until load completes**, overwritten wholesale
  the moment the real thing arrives (§2.3);
- on failure it **may not impersonate a live session**, and the composer is disabled (§2.4).

The first two of the three are design and the third is discipline — so the third must be pinned by a
test, see §4.

Accordingly, `2026-08-03-chat-history-ownership.md` §1.3's "do not land ACP bodies on disk" is
revised to "do not store **model context** for the ACP backend; a read-only snapshot containing only
the screen projection is allowed, with its use confined to being a placeholder until load completes".
The revision note is written back into that document, and this one is that clause's new source of
truth.

### 3.2 A snapshot, rather than reading the agent's `.jsonl`

**Chosen**: peek's own projection, written in its own directory.
**Not chosen**: reading `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` directly.

Reading the `.jsonl` achieves the same 0ms and requires storing nothing. There are three reasons
against it, and the third is decisive:

1. it is the agent's private format, with no compatibility promise whatsoever, and one Claude Code
   revision can make that path fail silently;
2. it is sharded by the agent's cwd, so peek would have to reproduce the slug rule to find the file —
   reproducing somebody else's private convention;
3. **what it stores is model context**, which is precisely the thing §3.1 is there to stop. A screen
   projection reverse-engineered out of it would read "what the model remembers" into peek along with
   it, and this plan's technical guarantee would be void on the spot.

### 3.3 No hover warm-up

**Chosen**: not doing it.
**Not chosen**: sending `session/resume` ahead of time on hover or keyboard selection of a row (which
builds the session without replaying, so the 1.5s runs out in the background and produces not one
delta), and then `session/load` (3ms) on click.

This plan is very pretty against the measurements — it pays the expensive half ahead of time,
precisely — and Zed does not take this road (it uses `resume` only as the fallback branch when `load`
is unavailable). It is not chosen because the sums do not add up:

- **the benefit is uncertain**: hover to click is usually only a few hundred milliseconds, which does
  not eat most of a second and a half, so the result is "wait 0.9 seconds" rather than "no waiting";
- **the cost is definite and heavy**: the agent starts a `claude` subprocess **per session** (the one
  §1.1 caught), so warming one up means one more resident subprocess, at hundreds of MB. A user
  sweeping past 10 rows is 10 of them, and peek deliberately does not send `session/close`, so they
  will not leave on their own;
- once §2.2 is done it is unnecessary: the user is already reading history, and the second and a half
  passes in the background.

Noted for reserve: if §2.2 is ever overturned for some other reason, this is the second choice, and it
would need an LRU cap and `session/close` reclamation to go with it.

### 3.4 Is step one alone enough

**Yes**, and step one lands first. §2.1 fixes "the screen is telling a lie", which is a defect; §2.2
addresses "having to wait a second and a half", which is experience. The former has to be done; the
latter can be decided on results.

Splitting it in two has one practical benefit as well: only once step one has landed is it known
whether "an honest loading notice" is enough. Zed stops right here, and it is a mature product.

## 4. Verification

### 4.1 Automated

- **`ChatView`'s three states** (§2.1): when `loading` and the mirror is empty, render the loading
  state and **not** the guidance — this one is the regression lock for this defect; when `idle` and
  the mirror is empty it is still the guidance (an empty conversation must not be described as
  loading either).
- **Snapshot round trip** (§2.2): write then read, with a tool-call block; a missing file / bad JSON
  / an unknown version all degrade to `null` rather than throwing; a bad file is not repaired in
  place; a rewrite leaves no `.tmp`; an illegal `sessionId` cannot assemble a path. The shape is
  copied from `endpoint/__tests__/thread-store.test.ts`, which has already proved itself.
- **The main-process projection** (§2.2): the `transcript` folded out by ACP's `#emit` is compared
  against the render layer's mirror **delta by delta** — not just the end state, because a divergence
  that appears midway and heals itself is invisible to an end-state comparison, and midway is exactly
  when the main process decides whether to write to disk. This follows the comparison method
  `chat.test.ts` already has.
- **Overwrite order** (§2.3): after the snapshot is on screen, run a `session/load`; the first delta
  is `reset`, the replayed text does not double, and the end state equals the agent's real thing.
- **No sending messages in the failure state** (§2.4): after `session/load` fails, the composer is
  disabled, and **no path can send a prompt in that state**. This is §3.1's disciplinary clause, and
  it must be pinned by a test rather than held up by a comment. The stub agent needs a `session/load`
  failure switch — the one `2026-08-03-chat-history-ownership.md` §4.2 recorded as "not done", to be
  filled in this time.

### 4.2 End to end

`scripts/verify-chat-restore.mjs` currently runs only the endpoint backend. The ACP half of it gets
one case with the stub agent: open a session, send a turn, close the tab, reopen → the snapshot is on
screen immediately (content is read out of the DOM **before** `session/load` returns), and after load
returns the content does not double.

"Before load returns" is the only assertion in that case that means anything — comparing end states
alone would be equally green whether this plan was implemented or not.

### 4.3 Verification not done

- **A real agent's 30-day cleanup path**: producing it would mean deleting the user's real `.jsonl`;
  following `2026-08-03-chat-history-ownership.md` §4.4's reasoning, the stub covers it.
- **A stale snapshot** (§2.5): producing it would mean continuing the same session outside peek.
  Verifiable by hand, not going into automation.

## 5. Implementation order

1. ✅ **§2.1's three states.** Stands on its own, lands first.
2. ✅ **§2.2's main-process projection and snapshot file.** Writing before reading — a snapshot
   nobody reads has no consequences, whereas the reverse does.
3. ✅ **§2.3's painting and overwriting.**
4. ✅ **§2.4's failure state**, along with its tests. **This step may not be deferred to "later"**:
   the moment step 3 lands, the failure path is already reachable.
5. ✅ Write the revision notes back into `2026-08-03-chat-history-ownership.md` §1.3 / §3.1.

## 6. Implementation record: departures from this document's draft

Six of them, all hit while writing the code, all landed, recorded here rather than quietly edited
into the text above.

### 6.1 The session title is not on the view; the rail has to pass it across

§2.1 says "`session/list` already returns `title` … it is already on the `view` when the view is
opened". **Not true**: `ChatSessionsRail` passes only `resumeSessionId` when opening the view, the
title stays on the list's side, and with no title on a chat view `viewTitleOf` gives the generic
"Chat".

The fix is to have `openRow` pass the title along in `view.open`'s spec (`buildChatViewState` already
accepts `title`). A side effect is that the tab also shows the session title rather than "Chat" — this
goes beyond what this document originally scoped, but it points the same way, so it stays.

The title is sanitised through `metaText` at the moment it is passed out, with the same handling as
when the list displays it: this string, written by the agent, may quote a cell from the database
verbatim, and it is about to go into the Workspace and be read by the tab bar, drag labels, the status
bar and MCP.

### 6.2 The decisions were extracted into pure functions: `components/chat/panelState.ts`

§4.1 requires that both "the empty state is not allowed during `loading`" and "no sending messages in
the failure state" be pinned by tests, and the project has no DOM rendering test infrastructure (no
jsdom / happy-dom / React testing library; the tests are pure logic plus source scanning).

So both the three-state decision and the composer decision were extracted into pure functions —
`transcriptState`, `strandedOnSnapshot`, `composerDisabled` — with `ChatView` calling them and the
tests testing them. This is a pattern the project already has (`permissionOptions.ts` is tested by
`chat.test.ts` in exactly this way).

### 6.3 `lastMessagePreview` was lifted into `agent/preview.ts`

Painting the snapshot means giving the Workspace a `lastMessagePreview`, and the endpoint backend
already has an identical implementation (`lastPreview` in `endpoint/loop.ts`). It was lifted into
`agent/preview.ts` for both backends to share rather than copied a second time — the same extraction
as §6.1's `buildReceipts`, for the same reason: this rule is about the **transcript**, not about the
agent.

### 6.4 "Clear before replaying" moved into `#replay`

`reloadChat` used to call `translator.reset()` itself and then replay, while `openChat` did not need
to — the window was empty when it started. With the snapshot, that premise is gone: `openChat` now
paints a screenful of things first.

So the clearing moved into `#replay`, shared by both entry points. This is exactly why `#replay` was
extracted in the first place (its own comment reads "a second copy of them would eventually only have
two"), except that this time it is a third thing's turn.

### 6.5 Retry goes through `reloadChat`, which therefore gained a path

§2.4 requires a "retry" button in the failure state but does not say how it is implemented.
`reloadChat` used to require a non-empty `agentSessionId`, and a failed bringup happens to clear it to
null, so retry had nowhere to go.

It gained a branch: with no live session but with a `resumeSessionId`, run a full `#ensureSession`.
Semantically it is still "get this conversation back on the screen", except that this time the session
has to be built first — which is the 1.5 seconds that failed.

The render layer gained a `retryLoad`, whose only difference from `restoreChat` is that it bypasses
the "each session automatically requests only once" deduplication set. That deduplication guards
against an automatic request becoming a loop, and a person pressing a button is not a loop.

### 6.6 That stub switch in §4.1 is still not done

§4.1 says "the stub agent needs a `session/load` failure switch … to be filled in this time".
**Not filled in.**

The "no sending messages in the failure state" discipline is instead pinned by `composerDisabled`'s
unit tests (§6.2), which is where that rule actually takes effect, and pinning it there is more direct
than pinning one end-to-end run. But the main-process-side stretch, "`showingSnapshot` is still true
after load fails", currently has only the code guaranteeing it and no test that has run it —
`#drawSnapshot` sets it and `#replay`'s clearing cancels it, and the failure path does not go through
the latter, which is something read rather than tested.

Equally not done is §4.2's end-to-end case. `scripts/verify-chat-restore.mjs` still runs only the
endpoint backend.

Both are recorded here rather than deleted from §4.
