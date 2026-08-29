# Who owns the conversation history: who stores the transcript, who may delete it, and where it is read back from after a refresh

> 2026-08-03. Trigger: the user reported "the agent chat loses its content after a
> refresh". Digging in, the refresh turns out to be only the most superficial
> symptom, with two heavier things underneath it: **the endpoint backend has no
> session identity at all, and no transcript storage either**; and on the ACP
> backend the transcript belongs to the agent, which deletes it by its own rules.
> The user's call was "follow what Zed does", and this document is the reconciled
> conclusion and the basis for the implementation.

## 1. What this fixes

### 1.1 Three facts, ordered by severity

**① The endpoint backend's conversations are entirely volatile.**
`main/agent/endpoint/loop.ts`'s `Session` structure has no `sessionId` field, and
across the whole codebase `sessionIndex.record()` has exactly one call site, at
`acp/manager.ts:944`. The knock-on effects form a chain:

- `createEndpointChatRuntime.listSessions()` filters on
  `route.backend === 'endpoint'`, and nobody has ever written such a route, so it
  **always returns an empty list**;
- `sessions.delete` goes through `sessionIndex.remove()`, always returns false, and
  always reports "that conversation is already gone";
- `closeChat` does `this.#sessions.delete(chatId)` outright, and the `Agent`
  instance holding all the context is collected right after. **Closing the tab
  deletes permanently, immediately** — no need to wait for the app to quit.

`chat-host.ts:478`'s comment reads "the route is peek's own record, and so is the
transcript" — as of today that is a bad cheque; the whole `agent/endpoint/`
directory has not imported `node:fs` once.

**② One refresh of the renderer process and the transcript vanishes from the
screen.** The complete transcript exists only in the single in-memory mirror at
`renderer/components/chat/transcriptStore.ts`, fed incrementally by `onChatDelta`.
The interface for re-fetching it is written but not wired: `getChatTranscript`,
which `loadChatTranscript()` depends on, exists neither in preload nor in
`PeekBridge` (`core/ipc.ts` declares only the one-way `onChatDelta`), and nobody in
the repository calls it. The `⚠️ Contract gap` comment at the top of that file is
about exactly this.

After a refresh the workspace realigns via `getSnapshot`, so the tabs, the titles
and the message counts all come back — **only the transcript is empty**. It looks
like "the content was lost" rather than "the window was reset", which is more
confusing than a blank screen.

The main process is none the wiser: `watchChatViews`'s `known` Map still holds this
`chatId` (`bus/handlers/chat.ts:1002` simply `continue`s), so nothing is replayed.
Neither side errors. Silent loss.

**③ On the ACP backend the agent deletes the transcript behind peek's back.** This
is measured; see §4.1.

### 1.2 Conflicts with existing design documents (reconciled)

`2026-08-02-chat-session-management.md` §1.3 lists **"no transcript of peek's own on
disk"** as an explicit boundary, and §3.1 argues it out over a whole section. The
2026-08-03 amendment relaxed it only as far as "an index carrying nothing but
routes", and stressed again "no transcript of any kind".

This change gives the **endpoint backend** a transcript on disk, which is a
head-on conflict with that boundary. The reconciled conclusion:

§3.1's argument holds like this — "building our own immediately produces two
histories. The agent-side `.jsonl` is the context the model actually sees, and
peek's copy is a projection for display; the moment the two disagree, a restored
conversation shows something other than what the model remembers."

**That argument has a premise: that the agent side has that copy.** The endpoint
backend has no agent process, no `.jsonl`, no second candidate truth. There, "no
disk" does not mean "only one history", it means **zero**. So the old conclusion is
not overturned; its scope never covered the endpoint backend in the first place, and
at the time the endpoint backend did not exist, so nobody had to draw the
distinction.

Zed's approach confirms this dividing line, and it was arrived at independently
inside the same ACP ecosystem: Zed stores not one byte of an external ACP agent's
transcript (`threads.db` measures 0 rows), whereas its own native agent's
transcript is written dutifully into SQLite. **Layer by "does this conversation's
transcript have another owner", not by a blanket "should we persist at all".**

Accordingly, `2026-08-02-chat-session-management.md` §1.3 and §3.1 are revised by
this document, a revision note is written back into that one, and this document is
the new source of truth for this point.

### 1.3 Boundary (explicitly not done)

- **No transcript on disk for the ACP backend.** It has an owner; see §3.1.
  > **2026-08-06 revision** (`2026-08-06-opening-a-stored-conversation.md` §3.1):
  > this narrows to "no **model context** stored for the ACP backend". A read-only
  > snapshot holding only `ChatMessage[]` (the screen projection) is allowed, for
  > use as a placeholder until `session/load` completes. The snapshot has no
  > `AgentMessage[]` and no field to put one in, so structurally it cannot answer
  > "what does the model remember" — what §3.1 opposes is a second **truth**, not a
  > second file.
- **No SQLite.** peek does not have this dependency, and the endpoint backend's
  volume does not need it; see §3.2.
- **No cross-backend migration.** An ACP session cannot become an endpoint session,
  or the other way round.
- **No full-text search, no fork, no rename.** `2026-08-02-chat-session-management.md`
  §1.3's boundary carries; nothing moves here.
- **peek does not keep Claude Code's history for it.** peek will not copy the
  `.jsonl` in order to fight the 30-day cleanup; the reasoning is in §3.1.

## 2. The plan

Zed's layering, two tables plus one restore channel.

### 2.1 Table one: routes and metadata, shared by both backends (exists; needs fields)

`~/.peek/chat/sessions.json`, `agent/session-index.ts`. It corresponds to Zed's
`sidebar_threads` (`crates/agent_ui/src/thread_metadata_store.rs`), whose doc
comment reads "Lightweight metadata for any thread (native or ACP), enough to
populate the sidebar list and **route to the correct load path when clicked**" —
word for word this table's job.

The four existing fields `sessionId / backend / agentId / createdAt` stay as they
are. **Two are added, written only for the endpoint backend**:

```ts
/** The session title. Not written for ACP: the agent's session/list supplies one, and keeping a stale copy only picks a fight. */
title?: string
/** Time of last activity (epoch millis). As above, not written for ACP. */
updatedAt?: number
```

This does not violate the principle "do not store what the backend can derive"; it
is that principle applied. The ACP backend can ask the agent, so nothing is stored;
the endpoint backend **has nobody to ask** — peek *is* that backend, and if it does
not store it, there is no second place that knows. Zed's `sidebar_threads` stores
`title` and `updated_at` for both kinds of agent because its native agent likewise
is the only thing that knows.

`SessionRoute.record()` is idempotent today (an existing entry is returned
unchanged); a `touch(sessionId, patch)` is needed for `title`/`updatedAt` that
updates only those two fields and leaves `createdAt` alone.

### 2.2 Table two: the transcript store, endpoint backend only

`~/.peek/chat/endpoint/<sessionId>.json`, one file per session. It corresponds to
Zed's `threads.db` / `DbThread`.

Picking the `endpoint/` directory is the same disposition as `codex/`: one
subdirectory per backend, so `session/list` calls do not wander into each other's
territory (`acp/profiles.ts`'s `workdirSegment` set this rule already). The
endpoint backend has no notion of a cwd, but the reason for directory isolation is
the same.

One file per session rather than one big file: a corrupted conversation corrupts
only itself, a write touches only one file, and combined with `SessionIndex`'s
existing temp + rename atomic write that is enough. The reason for not bringing in
SQLite is in §3.2.

The file's contents:

```ts
interface EndpointThreadFile {
  version: 1
  sessionId: string
  /** The copy that is on the screen. This is what the user sees after a restore. */
  transcript: ChatMessage[]
  /** The model context. pi-agent-core's AgentMessage[], poured back into initialState.messages on restore. */
  messages: AgentMessage[]
  /** The model id this conversation was started with, matching the route's agentId; redundant, kept for diagnosis. */
  modelId: string
  updatedAt: number
}
```

**Why two copies rather than one** is in §3.3.

When it is written: at the end of a turn (`agent_end`), and after a `clear`. Not
per token — a disk write per delta during streaming is the same overhead the move
of the transcript out of Workspace was dodging in the first place.

### 2.3 Session identity for the endpoint backend

`Session` gains `sessionId: string`, generated in `#ensure()` (`randomUUID()`), and
the route is written **there and then** — the same moment and the same reason as the
ACP backend calling `record()` immediately after `session/new` returns: a
conversation the user opened and never spoke in still has to be attributable.

The title: the endpoint backend has no agent to summarise, so it takes the **first
few characters of the first user message** and `touch()`es it into the route at the
end of the first turn. That is a plain approach, but it is an honest one — it does
not pretend to a summarising ability it does not have. The row still goes through
`core/untrusted-text.ts`, treated exactly like an agent-generated title.

`closeChat`'s semantics change to **detach** accordingly, matching the ACP
backend's §2.3 wording: release the batcher and the `Agent` instance, **do not
delete the file**. Real deletion goes only through `chat.sessions.delete`, which
has to delete both the route and the transcript file — file first, route second,
for the same reason `AcpManager.deleteSession` goes agent first, route second: the
other order leaves an orphan file nobody can attribute.

Restore: when `session.open` carries `resumeSessionId`, read from the transcript
store, pour `transcript` back into the renderer as a series of `message.start`
deltas, and feed `messages` into `new Agent({ initialState })`. The endpoint
backend's `session.open` branch is currently empty (`chat-host.ts:431` returns
outright); this fills it in.

### 2.4 The restore channel: where the transcript is read back from after a refresh

Zed does not have this problem — it is a native app, a thread lives in process
memory, and "restart" is its only restore occasion. peek's renderer refresh is an
intermediate state Zed does not have: **the main process is still alive and the
renderer starts over**. There is no ready-made approach to copy here; this is the
one original part of the design.

Fill in the interface that `transcriptStore.ts`'s `Contract gap` comment reserved,
but **with different semantics**: not "return a transcript" but "please deliver it
again".

```
core/ipc.ts   new CHAT_RESTORE: 'peek:chat:restore'
PeekBridge    new restoreChat(chatId): Promise<void>
```

The return value is `void`; the transcript travels over the existing `CHAT_DELTA`
channel as before. That way both backends share one path: ACP's `session/load`
already replays history as ordinary `session/update`s, and the endpoint backend can
just as well assemble a delta sequence out of what it read from a file. **The
renderer does not need to know where the transcript came from**, which is precisely
what the `ChatDelta` abstraction is for.

The trigger is `ChatView` mounting: if this `chatId` is empty in the mirror, ask
once. Not a push from `did-finish-load` — after a refresh the user is not
necessarily looking at the chat panel, and replaying a whole history for a tab
nobody has opened is spent for nothing; Zed's lazy loading has the same rationale.

The main process dispatches by backend:

- **Endpoint backend** → read from the transcript store, assemble deltas, send them
  back.
- **ACP backend** → trigger `session/load` again to replay. Two traps have to be
  handled here:
  1. `AcpManager.openChat` has a short circuit,
     `if (session.agentSessionId === resumeSessionId) return`; after a refresh the
     main-process session is still alive with its id already set, so it returns
     immediately and replays nothing. This needs an explicit force path rather than
     deleting that short circuit — what it blocks is "the same tab opened twice",
     and that protection still has to be there.
  2. `translator.reset()` is mandatory before a replay. The translator is stateful
     (`#currentMessageId`, `#calls`, `#messageCount`), and without clearing it the
     replay appends onto the old state, so the replayed messages' ids and counts are
     both wrong.

### 2.5 A dead session has to say so in plain words

This is one step beyond Zed, and it costs only one error branch.

The ACP backend's `session/load` fails when the agent has already deleted the
`.jsonl` (§4.1, measured: 97% of the rows in Zed's sidebar are in this state).
Today that path lands in `chat-host.ts:245`'s `fail()`, which reports the agent's
error verbatim, and the user cannot read what happened out of it.

Change to: when `session/load` fails and the session is also no longer in
`session/list`, put an explicit statement in the transcript — this conversation's
history has been deleted by the agent's automatic cleanup (Claude Code's
`cleanupPeriodDays` defaults to 30 days) and peek has no copy. And take that row
out of the session rail.

What is not done is keeping it for the agent: see §3.1.

## 3. Trade-offs

### 3.1 The ACP backend still stores nothing, in full knowledge that the agent deletes

> **2026-08-06 revision.** This section's conclusion still holds, but its scope has
> narrowed by one layer; see `2026-08-06-opening-a-stored-conversation.md` §3.1.
>
> That change gave the ACP backend a read-only snapshot (`acp/snapshot-store.ts`).
> The cause was the measurement that opening an old conversation takes ~1.5 seconds,
> and that all 1.5 seconds go into **establishing the session** —
> `session/resume` (establish the session, give no history) also takes 1.5 seconds,
> while `session/load` takes 3 milliseconds once the session is up. The protocol has
> no "read-only transcript" method, so the only way to make a click show content
> immediately is for peek to keep a copy of its own.
>
> The part of this section's argument that is kept: peek does not store the **model
> context**. The snapshot holds only `ChatMessage[]`, has no `AgentMessage[]` and no
> field to put one in, so it does not constitute a second answer to "what does the
> model remember" — the fork this section worries about requires both copies to be
> able to answer that question, and the snapshot cannot.
>
> The part that has narrowed: "a projection for display" no longer means "must not
> be stored". It may be stored, on the condition that it **must not impersonate a
> live session**: it is overwritten wholesale the moment `session/load` returns, and
> on failure it is explicitly labelled a snapshot with the composer disabled (that
> document's §2.4, pinned by `panelState.ts`'s `composerDisabled` and its test).
>
> This whole section below is about "peek does not keep history on the agent's
> behalf", and that one **has not changed**: the snapshot is only the picture peek
> saw, not a copy of the agent's `.jsonl`, and it does not fight the 30-day cleanup
> — when a session is cleaned up the snapshot is deleted with it.

**Chosen**: the transcript belongs to the agent, and peek only says clearly what
happened once the agent has deleted it.
**Not chosen**: peek copies the `.jsonl`, or stores the replay's result into its own
transcript store.

The cost is real and already quantified: of the 713 ACP conversations in Zed on the
user's machine, only 19 still have a transcript (§4.1). One copy would bring them
back.

The reason not to is the same as `2026-08-02-chat-session-management.md` §3.1's, and
it is sharper here: the agent-side `.jsonl` is **the context the model actually
sees**, and peek's copy is a projection for display. Claude Code compacts, forks,
and gets changed by the user through the `claude` CLI without peek's knowledge. Once
the two fork, a restored conversation "shows something other than what the model
remembers" — the hardest class of bug to diagnose, and all it buys is a few
conversations that were supposed to expire.

And the 30-day cleanup is **the agent's policy, not a bug**. The user can change
`cleanupPeriodDays` in `~/.claude/settings.json` themselves; that is their authority
over their own history. peek quietly defeating it behind their back is making a data
retention decision on their behalf. §2.5's message is the correct place to
intervene: tell them the fact, and let them decide.

The endpoint backend's situation is **exactly the reverse**, so the conclusion is
reversed too: there is no agent there, peek *is* the agent, and not storing means
zero copies.

### 3.2 JSON files, not SQLite

**Chosen**: one JSON file per session, reusing `SessionIndex`'s atomic write.
**Not chosen**: SQLite (Zed's approach).

Zed uses SQLite because it already has sqlez, has a workspace database, and has
hundreds or thousands of threads to retrieve by time and by worktree. peek has not a
single dependency for it (there is no sqlite anywhere in `apps/desktop/package.json`),
the endpoint backend's session count is in the dozens, and the only retrieval need is
"list newest first" — which the route index has already sorted in memory.

Bringing a native module in for a store that needs no queries, and then handling
Electron's ABI rebuild and packaging/unpacking on top, does not add up. On the day
retrieval really is needed, the migration cost is one pass over a directory.

Zed's `data_type` column (`"json" | "zstd"`) is worth noting: **compression is an
optional path it left itself, not the default**. This version of peek does not
compress; that can be revisited when needed.

### 3.3 The endpoint backend's transcript store holds two copies of the content

**Chosen**: `transcript` (the UI's `ChatMessage[]`) and `messages` (the model's
`AgentMessage[]`) in the same file, written in the same operation.
**Not chosen**: store only the model messages, and have the UI derive the bubbles
back from them.

Deriving is feasible but lossy: a tool call's `title`/`kind`/`status`, the boundary
between a thinking block and the body, `attachmentReceipts`, `stopReason`, and each
message's `createdAt` are either absent from `AgentMessage` or shaped differently.
Writing a second translator to save one copy of storage — and a translator that only
runs on the restore path, unverified the rest of the time — does not pay.

This looks like the "two histories" §3.1 opposes, but it is not the same thing:
there, the two belong to **two processes**, are written at **different moments**, and
follow **their own rules**; here the two are written by the same code at the same
`agent_end` moment into the same file, so there is no window in which one is updated
and the other is not. Nor are they two copies of the same thing — one is the model's
memory, the other is the record on the screen, and after the model compacts they
*should* differ. Zed's `DbThread` likewise stores scroll position and draft input,
pure UI state, alongside the messages.

### 3.4 The restore request comes from the renderer, not a push from the main process

**Chosen**: `ChatView` asks on mount when it finds the mirror empty.
**Not chosen**: on `did-finish-load`, the main process replays for every live chat
view.

The trouble with pushing is that it does not know what the user is looking at. For a
chat tab that is not opened after a refresh, replaying the whole history is pure
waste; and the ACP backend's replay means actually running a `session/load`, which is
a process round trip. Letting whoever needs it speak up is a pattern peek has already
used several times, on result rows and on the namespace cache.

## 4. Verification

### 4.1 Done: a controlled experiment (Zed's real data)

The basis for the design is measurement rather than documentation, recorded here so
it is not later taken for speculation:

- Zed's `sidebar_threads` in
  `~/Library/Application Support/Zed/db/0-stable/db.sqlite`: 713 rows, every
  `agent_id` is `claude-acp`, the columns include `session_id`/`folder_paths`/`archived`,
  and there is **no transcript field of any kind**;
- Zed's transcript store, `threads/threads.db`: `select count(*) from threads` →
  **0**. 713 conversations, and Zed has kept not one byte of them;
- the transcripts live at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, sharded
  by the project directory Zed opened, and **mixed into the same directory** as the
  history of the user running `claude` in a terminal under the same project (measured:
  one non-peek project's slug directory holds 22 files mixing three origins,
  `claude-desktop`/`claude-vscode`/`cli`). peek pinning the cwd to `~/.peek/chat` is
  exactly so as not to get stirred into that pot;
- scanning all 713 `session_id`s across `~/.claude/projects/*/*.jsonl`: **19 hits,
  693 misses**. The oldest surviving file stops at July 5–6, consistent with
  `cleanupPeriodDays`'s 30-day default. Which is to say 97% of the rows in Zed's
  sidebar will open empty, and it has no way at all to notice.

### 4.2 Automated

Once landed, `pnpm test` is 1459 cases all green (1430 before the change). The 29
added:

- `agent/__tests__/session-index.test.ts` (+4): `touch()` moves only
  `title`/`updatedAt`, the title is taken only the first time, the timestamp moves
  every time, and `createdAt` never resets; **`touch` is refused for the ACP
  backend** (those two fields belong to the agent); `list()` sorts by
  `updatedAt ?? createdAt`, and that holds across a restart.
- `agent/endpoint/__tests__/thread-store.test.ts` (new file, 8): a write-read round
  trip carrying a tool-call block (exactly the part that storing only model messages
  loses); a missing file / bad JSON / unknown version / either half missing all
  degrade to `null` rather than throwing; a bad file **is not repaired in place**; a
  rewrite leaves no `.tmp`; `remove` is idempotent; an illegal `sessionId` cannot be
  assembled into a path (this path writes to disk, so traversal equals arbitrary
  write).
- `agent/endpoint/__tests__/lifecycle.test.ts` (new file, 12): the whole file goes
  neither over the network nor through a turn — `buildEndpointModel` only assembles
  objects, and nothing leaves before `prompt`. Pinned: opening a session writes the
  route; on restore both the transcript **and the model's memory** come back
  (restoring only the former gives "shows the history but answers as if none of it
  happened"); when the file cannot be read, it opens empty rather than broken;
  **the file is still there after `closeChat`** (that one is the regression lock for
  "closing the tab deletes permanently"); a repeated open does not stack; `restore`
  begins with a `reset` and gives the same result called twice in a row; deletion
  goes file first then route, and a session currently open refuses to be deleted;
  `clear` rewrites to empty rather than deleting the file.
- `acp/__tests__/manager.test.ts` (+2): `reloadChat` **really does send another
  `session/load`** in the case where `openChat` would short-circuit, the first delta
  is `reset`, and the replayed text does not double (pinning §2.4's two traps, the
  second of which is the one more likely to regress silently); with no session it
  answers `false`, sends no request, and **does not start an agent process** (proved
  by the absence of the log file).
- `renderer/components/chat/__tests__/chat.test.ts` (+3): the main process's flat
  projection and the renderer's `{order, byId}` mirror are compared **delta by
  delta** — not just their end states, because a divergence that appears mid-stream
  and heals itself is invisible to an end-state comparison, and mid-stream is exactly
  when the main process decides whether to write to disk; `transcriptToDeltas` round
  trips, and pouring it in twice produces no duplicate messages; `reset` agrees on
  both sides.

**Not done**: a `STUB_LOAD_FAILS` switch in `stub-agent.mjs` (automated coverage for
§2.5). That path currently has manual verification only (§4.3 item 5). It is left
because the stub's `session/load` succeeds unconditionally today, and adding a
failure branch means changing its session-table model along with it; whether that is
worth it can wait until the path actually causes trouble.

### 4.3 End to end: `scripts/verify-chat-restore.mjs`

This was originally a list of manual steps, and became a script. Because this time
the bug is precisely **not inside any one component** — `EndpointManager`, the IPC
channel, preload and the renderer's mirror are each correct on their own; what is
missing is the wire connecting them, and unit tests mock that stretch away entirely.
So verification has to drive the real build output.

```bash
node scripts/verify-chat-restore.mjs [--verbose]
```

It spends no tokens and touches no user data: the model is a locally started stub
(the streaming shape of OpenAI completions), `PEEK_CONFIG_DIR` and `--user-data-dir`
are both temporary directories, and the user's own `~/.peek` is never opened. It
reads the **real DOM** over CDP and reads no internal store — a transcript that is in
the mirror but not painted on the screen does not count as restored, and this bug has
lived in that gap once already.

Four steps, all green as measured:

1. Open a conversation and send a line → the transcript **has the user's own
   message** as well as the answer (the first is the regression lock for §6.1's bug).
2. `Page.reload` to refresh the renderer → both messages come back. **This is the
   problem the user reported.**
3. Close the tab → the session is still in the rail, its title is the first sentence
   → open it → the history comes back → ask one more question, and **the prompt the
   stub model receives carries the previous round**. That last half sentence is the
   crux: restoring only the screen and not `messages` still passes the earlier steps,
   while the model has amnesia.
4. Restart the whole app → the session is still in the directory.

The ACP half of this is in `manager.test.ts`'s two `reloadChat` cases, using the stub
agent, needing no login and spending no tokens.

~~There is one piece of grubby work in the script worth recording: it has to seal a
fake API key with Electron's `safeStorage` first.~~ That scaffolding went with §6.3:
once the defect was fixed the script was changed to run **with no key configured**,
and so it doubles as the regression test for a keyless endpoint — passing means "an
endpoint with no key can send a request".

### 4.4 Verification not done

- **A real agent's deletion path**, for the same reason as
  `2026-08-02-chat-session-management.md` §4.3: the only thing it can delete is the
  user's own history. The stub side covers it.
- **The ACP backend's dead-session message** (§2.5). Producing it means deleting the
  user's real `.jsonl`, and destroying real history for one verification does not pay.
  As it stands this path has neither automated nor manual verification, and it is the
  one branch of this change that has never been executed.

## 5. Implementation order

Four steps, each usable on its own. Step 1 matters more than step 2, even though what
the user reported is step 2's symptom — a refresh loses what is on the screen, closing
a tab loses the conversation itself. All four have landed:

1. ✅ **Identity and a transcript store for the endpoint backend** (§2.1's added
   fields, §2.2, §2.3).
2. ✅ **The restore channel** (§2.4).
3. ✅ **The dead-session message** (§2.5).
4. ✅ Write back to `2026-08-02-chat-session-management.md` §1.3 / §3.1 and
   `docs/PLAN.md` M7.

## 6. Three bugs hit during implementation

The first two were fixed on the spot; the third was not fixed at the time and was
fixed separately later, see §6.3. All three share one cause: **the endpoint backend
had never actually been run before this** (§6.2), so nothing on its path had ever
been executed.

### 6.1 The endpoint backend never put the user's own message into the transcript

`EndpointTranslator` has a `countUserMessage()` that only increments `messageCount`
and emits no delta, with a comment in `loop.ts` alongside it: "the user's own message
is recorded by the caller".

`EndpointTranslator` has a `countUserMessage()` that only increments `messageCount`
and emits no delta, with a comment in `loop.ts` alongside it: "the user's own message
is recorded by the caller". **No caller does this.** The ACP backend has always
emitted it itself (`TranscriptTranslator.appendUserMessage` produces `message.start` +
`message.end`), and the endpoint backend inherited the sentence without inheriting the
code.

The consequence is that an endpoint conversation has only the model talking, answering
questions invisible on the screen; meanwhile Workspace's `messageCount` counts a
message that does not exist in the transcript, and the two numbers have long
disagreed.

This was hit while building persistence for the endpoint backend: a transcript missing
every user message is not a transcript, and storing it is pointless. The fix is to
implement ACP's `appendUserMessage` again for the endpoint backend (attachment
descriptors and receipts along with it), with `send()` emitting it before going to the
model.

`buildReceipts` is lifted from `acp/manager.ts` to `agent/context/resolve.ts` while
here — both backends need it, and the rule it states is about attachments, not about
the agent. Its parameter is narrowed to the three fields it actually reads, so both
backends' slightly differently shaped payloads satisfy it and neither has to widen to
accommodate the other.

### 6.2 The endpoint backend could not be selected at all: assembly order

In `bootstrap()`, `wireChatHost(commandBus, rows)` comes **before**
`settingsStore = createSettingsStore(...)`. And the first thing `wireChatHost` does is
read `settingsStore?.read().agent` to decide who answers — at that point it is still
`undefined`, so `chosen` is permanently undefined and **whatever `settings.json` says,
it always goes to the ACP backend**.

This bug is silent, because falling back to the ACP backend is also the normal
appearance of "never configured": the panel works as usual, it just never used the
endpoint the user selected. It also explains how §6.1 and §6.3 survived so long — the
endpoint backend's code path had never executed in a real process, and only the
translator and the permission gate were covered by unit tests.

The fix is to swap the two lines and note in a comment that this order has meaning. It
was exposed the first time the end-to-end script ran: the log said
`[peek/acp] agent ready: claude-agent-acp` while the configuration said endpoint.

### 6.3 An endpoint with no API key cannot send a request (not fixed at the time; fixed by 2026-08-04)

> **The fix is in `2026-08-04-endpoint-keyless-and-stream-errors.md`.** The record
> from the time is kept below, but **its description of how the failure arrives is
> wrong**; that document's §1.3 corrects it — adding a `case 'error':` branch as this
> section literally describes leaves the empty bubble exactly as it was.

`pi-ai`'s `getClientApiKey` **throws outright** with `No API key for provider` when
there is neither a key nor an `authorization` header. `provider.ts`'s `resolve()`
returns `{ auth: {} }` for an empty key, meaning "this endpoint needs no
authentication", but it never gets that far.

The consequence is that the scenario `provider.ts`'s file header states it supports —
"vLLM on a workstation, Ollama on a laptop" — **cannot be used even when configured**.
And the failure is silent: `loop.ts`'s `#onAgentEvent` recognises four kinds of event
and takes `default: return`, so this error is discarded, `agent.prompt()` resolves
normally, and `#settle` collects the message into an **empty assistant bubble** with
the state returning to `idle`. What the user sees is the model "answering with
nothing", and the log holds not a word.

(Written at the time as "`pi-ai` pushes it into the stream as an `error` event". That
`error` event does exist, but it belongs to `AssistantMessageEvent` and is consumed
internally by `pi-agent-core`; the `AgentEvent` union has no `error` member. The form
in which a failure actually reaches peek is that assistant message on `message_end`
with `stopReason === 'error'`.)

Not fixed, for two reasons: one, it has nothing to do with this document's subject
(who owns the history); two, it has two independent holes — "a keyless endpoint cannot
send" and "a failure in the stream is swallowed" — and the correct fix for the second
disturbs `#onAgentEvent`'s event contract, which deserves being reconciled on its own.
The way the end-to-end script worked around it at the time was to seal a fake key;
once the defect was fixed that scaffolding was deleted, the script was changed to run
without a key, and it thereby became the regression test for the keyless path.
