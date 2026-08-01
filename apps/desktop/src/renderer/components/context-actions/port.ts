/**
 * Where "attach this" becomes a Command.
 *
 * The architecture is not in question: the renderer never changes state locally,
 * so attaching goes through the Command Bus like everything else, as
 * `chat.attach` / `chat.detach` against a chat view. What this file provides is
 * the **seam**, so that this directory and the chat panel could be built in
 * parallel without either importing the other's internals.
 *
 * The chat panel registers the real implementation at start-up
 * (`components/chat/contextPort.ts`). Until it does, every surface here is fully
 * built and inert, and says so once in the console. That is deliberately better
 * than casting a command name to make it compile: an unwired feature that
 * announces itself is recoverable, one that silently dispatches into nothing is
 * not.
 *
 * ## Why the port carries `ChatAttachment` and not `ChatAttachmentSpec`
 *
 * `chat.attach` takes a spec — the same descriptor without an id, because main
 * mints ids. The port hands over a `ChatAttachment` with a **provisional** id
 * that the implementation drops on the way to the Command.
 *
 * That looks redundant and is not. `label` is required on `ChatAttachment` and
 * optional on the spec, and the label is the whole reason this directory exists
 * on the renderer side: it is localized, and it is built from the same view state
 * that decided the descriptor's shape. Carrying the full object keeps the label
 * non-optional across the seam. The provisional id is never persisted, never
 * shown and never compared — main's id is the only one that addresses anything,
 * which is exactly why two processes must not both mint one.
 *
 * ## No optimistic state
 *
 * An implementation dispatches and reports whether the Command landed. The chip
 * appears when main's patch updates `ChatViewState.attachments`, the same way
 * every other piece of state in this renderer moves.
 */

import type { AttachmentId, ChatAttachment, ViewId } from '@peek/core'

export interface ContextActionPort {
  /** Stage an attachment on a chat view. Resolves true when the Command landed. */
  attach(chatViewId: ViewId, attachment: ChatAttachment): Promise<boolean>
  /** Remove a staged attachment. */
  detach(chatViewId: ViewId, attachmentId: AttachmentId): Promise<boolean>
  /**
   * The chat view an attachment should go to when the user did not pick one —
   * the visible chat, or the most recently focused one. Null when no chat view is
   * open, which is what makes the UI offer "open a chat" instead of failing.
   */
  defaultChatViewId(): ViewId | null
}

let warned = false

const UNWIRED: ContextActionPort = {
  attach() {
    warnOnce()
    return Promise.resolve(false)
  },
  detach() {
    warnOnce()
    return Promise.resolve(false)
  },
  defaultChatViewId() {
    return null
  },
}

function warnOnce(): void {
  if (warned) return
  warned = true
  // An English literal, not a catalog key: this is a wiring mistake only a
  // developer will ever see, and it names the function to call to fix it.
  console.warn(
    '[peek] context-actions: no ContextActionPort registered, so attachments go nowhere. '
    + 'The chat panel must call setContextActionPort() during start-up.',
  )
}

let port: ContextActionPort = UNWIRED

/** Install the real implementation. Called once, by the chat panel, at start-up. */
export function setContextActionPort(next: ContextActionPort): void {
  port = next
}

export function getContextActionPort(): ContextActionPort {
  return port
}

/** Restore the unwired default. For tests. */
export function resetContextActionPort(): void {
  port = UNWIRED
  warned = false
}
