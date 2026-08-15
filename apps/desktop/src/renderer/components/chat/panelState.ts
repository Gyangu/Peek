import type { ChatAgentStatus, ChatViewState } from '@peek/core'

/*
 * The decisions `ChatView` makes about what state the panel is in.
 *
 * They live here rather than as ternaries inside the component because each one
 * is a rule with a reason, and a rule with a reason should be executable by a
 * test. Two of them got their ordering wrong at some point, and only one of
 * those was ever noticed by a human. See
 * `design/2026-08-06-opening-a-stored-conversation.md` §1.2, §2.4 and §4.1.
 */

/**
 * Which of the three things the transcript area shows.
 */
export type TranscriptState = 'messages' | 'loading' | 'empty'

/**
 * Decide what the transcript area renders.
 *
 * `count` is the **mirror's** message count, not `ChatViewState.messageCount`.
 * The two disagree for a whole frame at a time — the Workspace patch and the
 * delta stream are different channels — and what this decides is whether there
 * is something on screen, which only the mirror knows.
 *
 * ## The order of the tests is the design
 *
 * **Messages beat everything, including `loading`.** A replay arrives as deltas
 * *before* the status patch that ends it: `AcpManager.#replay` emits the whole
 * transcript and only then does `#ensureSession` move the view to `ready`.
 * Testing `loading` first would therefore blank a transcript that has already
 * landed, for one frame, on every single load.
 *
 * **`loading` beats the empty state.** This is the bug this module exists for.
 * The empty state used to be the sole alternative to a message list, so a
 * conversation opened from the rail — one the user picked *because* it has
 * history in it — rendered "Ask about the data you are looking at" for the
 * second and a half `session/load` takes. That is not a slow screen, it is a
 * screen stating the conversation is gone while it is on its way. Main already
 * distinguished the case (`buildChatViewState` sets `loading` the instant the
 * view is built, with a comment saying why); only this side threw it away.
 *
 * `starting` and `authenticating` deliberately do **not** land here. They are
 * bringup states of a *new* conversation, where the empty state's invitation to
 * type is exactly right — nothing is being fetched and nothing is missing.
 */
export function transcriptState(status: ChatAgentStatus, count: number): TranscriptState {
  if (count > 0) return 'messages'
  return status === 'loading' ? 'loading' : 'empty'
}

/**
 * The transcript on screen is peek's stored picture, and the agent's copy is not
 * coming.
 *
 * Both halves are required, and neither alone means this:
 *
 *  - `showingSnapshot` on its own is the ordinary case, which resolves in the
 *    second and a half `session/load` takes;
 *  - `error` on its own is a crashed agent, where the composer must stay **live**
 *    because sending a message is what reconnects it (see `ChatView`'s note on
 *    why `error` is not a `notReady` state).
 *
 * Together they mean something neither says: what the user is reading is real,
 * and the model has never seen it.
 */
export function strandedOnSnapshot(
  view: Pick<ChatViewState, 'agentStatus' | 'showingSnapshot'>,
): boolean {
  return view.agentStatus === 'error' && view.showingSnapshot === true
}

/**
 * Whether the composer refuses input.
 *
 * The stranded-snapshot clause is the one that is a **rule** rather than a
 * courtesy, and it is why this is a function with a test rather than a boolean
 * expression in JSX. Everything else here is about the agent being busy or not
 * yet up; that clause is about correctness. A message sent on top of a snapshot
 * reaches an agent that does not have the conversation behind it, so the user
 * reads a full transcript and the model answers as though none of it happened —
 * precisely the failure `2026-08-03-chat-history-ownership.md` §3.1 refuses to
 * ship, arriving by a different door.
 *
 * Deliberately **not** disabled on `error` alone: see `strandedOnSnapshot`.
 */
export function composerDisabled(
  view: Pick<ChatViewState, 'agentStatus' | 'pendingPermission' | 'pendingQuestion' | 'showingSnapshot'>,
): boolean {
  if (strandedOnSnapshot(view)) return true
  if (view.pendingPermission !== undefined) return true
  // A question locks the composer for a reason a permission prompt does not
  // share: the agent is waiting on *this answer*, and a message typed past the
  // prompt would be a second, unrelated turn queued behind a suspended one. The
  // free-text box on the prompt is where words go while a question is standing.
  if (view.pendingQuestion !== undefined) return true
  return (
    view.agentStatus === 'starting' ||
    view.agentStatus === 'authenticating' ||
    view.agentStatus === 'awaiting-permission' ||
    view.agentStatus === 'awaiting-answer' ||
    view.agentStatus === 'loading'
  )
}
