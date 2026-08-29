# Permission prompts for parallel tool calls: queue them, and ask about one at a time

## 1. What this fixes

### 1.1 The symptom

The agent requests three tools in parallel within one turn, the user authorises,
and **the chat panel hangs**: the status bar says "replying…", the input box says
"stop", two tool rows sit at `pending` forever, and the third has finished.
Nothing in the interface offers a way to answer the other two, so the only
options are to wait five minutes for the timeout or cancel by hand.

### 1.2 The cause

`ChatViewState.pendingPermission` is **singular**, and parallel requests are
plural.

```
Claude sends 3 session/request_permission in parallel
  ├─ #1 open() → #patch({ pendingPermission: A })
  ├─ #2 open() → #patch({ pendingPermission: B })   ← overwrites A
  └─ #3 open() → #patch({ pendingPermission: C })   ← overwrites B

The user sees only C, and answers C
  └─ #3 finishes → #patch({ pendingPermission: null })  ← no prompt left in the UI

#1 and #2's tickets are still open → the agent blocks on them → hung until
permissionMs (5 minutes) expires
```

`ChatView.tsx:201` renders one `view.pendingPermission`, so A and B become
unanswerable the instant they are overwritten.

### 1.3 Half of this bug was already known

In `#onRequestPermission` in `acp/manager.ts`, `session.permissionIds` is a
**Set** with a comment reading "An agent may have more than one prompt
outstanding", and the watchdog's pausing and resuming (`#disarmIdle` /
`#pauseMax`, and only restarting the clock when `permissionIds.size === 0`) is
handled carefully.

**The clock half was done right; the presentation half never caught up.** This
document supplies the latter.

### 1.4 The endpoint backend has it too, and hits it more easily

`gate.ts` in `agent/endpoint/` takes the same route: `announce(chatId, pending)`
is also singular. And `pi-agent-core`'s `toolExecution` **defaults to
`'parallel'`**, so that backend does not need an especially eager model to trigger
it. The fix has to cover both.

### 1.5 Boundary

**Done:** queue parallel requests, show one at a time, and show the next
automatically once one is answered.

**Not done:**

- `PendingPermission`'s shape does not change, and it does not become an array —
  see §4.1.
- No bulk operations such as "allow all". Asking one at a time is precisely so
  that each one is seen.
- Tool execution concurrency does not change. Whether the agent wants to call in
  parallel is its business; peek only decides the rhythm of the **asking**.
- Permission semantics do not change: who may answer, what counts as an answer,
  and a timeout counting as a refusal are all as they were.

---

## 2. Conflicts with the existing design

**None.** Checked point by point:

- `2026-08-02-agent-source-and-permission-scope.md` is about **who** may answer
  (`chat.respondPermission` refusing `source === 'agent'`). Queueing changes none
  of it, and a queued request is still answerable only by a person.
- `2026-08-02-control-spec.md`'s prompt control is unchanged — it drew one at a
  time to begin with.
- `2026-08-03-pluggable-agent-backends.md` §3.4 says "one gate, two backends, no
  second implementation". Putting the queue inside that shared gate continues to
  honour that sentence.

The only thing needing to be written down is a **new invariant** (§3.4), which no
document has stated before, because before now there was no second prompt to
violate it.

---

## 3. The plan

### 3.1 The queue goes in the broker, not in the two managers

`PermissionBroker` (`agent/permissions.ts`) is already the shared layer, already
keeps books per `chatId`, and already owns the timer and the settle. A queue is
something it should own anyway: fix it in one place and both backends benefit.

Putting it in each manager means writing it twice, and two copies cannot stay
consistent for long — which is exactly what splitting the backends set out to
avoid.

### 3.2 From "the caller announces" to "the broker says who to show"

The API today has the caller take `ticket.pending` and patch it out itself. With a
queue, "which one should be shown now" is no longer something the caller can know
on its own: it depends on whether anyone else in the same chat is queued.

So the broker takes one more constructor dependency:

```ts
export interface PermissionBrokerDeps {
  /**
   * The prompt this chat should currently show, or null (there is none).
   *
   * Called by the broker, and called exactly once whenever the active item
   * changes — the first one entering the queue, switching to the next after an
   * answer, and the queue emptying. The caller still writes it into
   * `pendingPermission`, but no longer decides when.
   */
  onActive(chatId: ChatId, pending: PendingPermission | null): void
  now?: () => number
}
```

`open()`'s return value stays `{ pending, decision }` — the caller still needs
`pending.requestId` (recorded into `permissionIds`) and `decision` (to block the
ACP response). All that changes is that **it no longer patches**.

### 3.3 The clock starts when shown, not when queued

This is the one real trap in a queueing design, and has to be written down.

`permissionMs` is five minutes, and it is **the budget for a person to read and
decide**. If three requests all queue at once and all start their clocks
immediately, the third could time out before ever being shown — and the user would
see a tool they never saw refused "because you did not answer". That punishes the
user for not doing something they had no opportunity to do.

So: **the clock does not start on queueing, it starts on activation.** A request
that has waited four minutes in the queue still has a full five minutes when its
turn comes.

The cost is that a turn's total permission phase is bounded by
`N × permissionMs`. That is acceptable: the watchdog is already stopped while
somebody is being asked (`#disarmIdle` / `#pauseMax`), and `promptMaxMs` means
"agent time", which should never have counted a person's thinking time anyway.

### 3.4 The new invariant

> **Within one chat, at most one prompt is active at any moment; the active one is
> the one in `pendingPermission`.**

Guaranteed by the broker, not by the caller's diligence. It did not exist before,
because before now there could be no second prompt to violate it.

A corollary worth stating separately, because it is the direct inverse of §1.2's
bug: **after answering one, `pendingPermission` is not cleared but replaced with
the next in the queue.** It is null only when the queue is genuinely empty.

### 3.5 Cancellation semantics

`cancelAll(chatId, reason)` has to clear **both the active one and the queued
ones**. A cancelled turn should not leave prompts in the queue waiting for
somebody to activate them by accident later. After the cancel, `onActive(chatId,
null)` is called exactly once.

A single `cancel(requestId)` against a queued item removes it quietly from the
queue and does not affect whichever is currently active.

### 3.6 Files involved

| file | change |
| --- | --- |
| `agent/permissions.ts` | the queue, `onActive`, and the delayed clock. The bulk of this change |
| `acp/manager.ts` | `#onRequestPermission` no longer patches `pendingPermission` itself; the broker is constructed with `onActive` |
| `agent/endpoint/gate.ts` | as above: `announce` moves from a parameter to the broker's responsibility |
| `agent/endpoint/loop.ts` | the broker is constructed with `onActive` |

`ChatView.tsx`, `PermissionPrompt` and core's contract: **no changes at all**.

---

## 4. Trade-offs

### 4.1 Why `pendingPermission` does not become an array

Considered, and it has one real advantage: three requests on one screen, which
makes "allow all" possible.

Rejected, for three reasons in order of weight:

1. **Asking one at a time is harder to misclick.** Three prompts crowded onto one
   screen have buttons in similar positions with similar copy, and a misclick costs
   "I approved a tool call I did not read". The entire point of this control is
   that a person sees clearly.
2. **A far larger change surface**: core's contract, the UI, and both managers.
   And core's `PendingPermission` is part of `ChatViewState`, which is part of
   every patch broadcast and every `read_workspace`.
3. **It does not solve the underlying problem**, it only raises the ceiling from 1
   to N. The N+1th prompt still needs an answer. A queue has no ceiling.

### 4.2 Why not "refuse a new one automatically when a pending one exists"

The minimal stopgap, one line to write. Rejected: it trades a hang for "tools fail
at random". The agent retries, the user sees inexplicably refused calls, and
**parallel calling is legitimate to begin with** — three read-only
`read_workspace` calls have no reason to be serialised. What peek should do is ask
in an orderly way, not refuse.

### 4.3 Why not just make the endpoint backend execute tools serially

One line of `pi-agent-core`'s `toolExecution: 'sequential'` stops the endpoint
backend from going parallel. But it **fixes half** — the ACP backend cannot
control how many requests Claude decides to send in parallel, which is the agent's
own decision. And it pays with "tools run a bit slower" to buy "prompts do not
overlap", which is the wrong price: the problem was never execution concurrency,
it was presentation.

---

## 5. Verification

**Automated** (`agent/__tests__/permissions.test.ts`, extended):

1. Three requests queued in sequence → `onActive` has been called once, for the
   first; `pendingPermission` is the first.
2. Answer the first → `onActive` is called again immediately with the second,
   **not null**. This is the direct regression test for §1.2's bug.
3. Answer them all → only the last `onActive` is null.
4. **No clock while queued**: advance the fake clock past `timeoutMs` and the
   second in the queue must not time out; only after activation does another
   `timeoutMs` expire it.
5. `cancelAll` clears both the active and the queued, with `onActive(null)`
   exactly once.
6. Different chats' queues do not interfere.
7. A queued item cancelled on its own disappears quietly, and the active one is
   unaffected.

**By hand**:

1. Have the agent call three tools in parallel ("what data structures are here"
   from the screenshot triggers it across three connections). Approve them one by
   one, and confirm all three complete and the panel returns to ready, **with no
   five minutes of silence**.
2. In the same scenario refuse the middle one, and confirm the other two remain
   answerable with correct results each.
3. Press "stop" while a prompt is up, and confirm the queue is cleared with it and
   nothing is left behind.
4. Repeat item 1 on the endpoint backend (a self-configured endpoint) — it is
   parallel by default, and the easier of the two to trigger.
