import type { AttachmentId, ChatAttachmentSpec, ChatPermissionMode, ViewId } from '@peek/core'
import { dispatch } from '../../state/dispatch'

/**
 * Every state change the chat panel can cause, in one place.
 *
 * These are thin on purpose. `dispatch` already validates with zod at the door,
 * turns a `PeekError` into a toast, and re-aligns the mirror if a patch goes
 * missing — so there is nothing for this layer to add beyond naming the
 * intentions the UI has.
 *
 * The rule this file exists to keep visible: **the chat panel never writes
 * state**. Typing into the box is local (it is not state until it is sent), and
 * everything else — sending, cancelling, staging context, answering a permission
 * prompt, changing the mode — goes through the Command Bus and comes back as a
 * patch. The transcript arrives on its own delta channel for the reasons in
 * `chat.ts`, but that channel is also main → renderer only.
 *
 * Commands are addressed by **view id**, not chat id: that is what
 * `read_workspace` publishes, so a caller can always name its target from what it
 * has already read.
 */

/** Returns false when the command was refused; `dispatch` has already toasted the reason. */
async function ok(promise: Promise<unknown>): Promise<boolean> {
  return (await promise) !== null
}

export function sendChat(viewId: ViewId, text: string, attachments?: ChatAttachmentSpec[]): Promise<boolean> {
  return ok(
    dispatch('chat.send', {
      viewId,
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  )
}

/**
 * Stop the turn in flight.
 *
 * A no-op when nothing is running is reported as `cancelled: false`, not as an
 * error — so the stop button never needs to guard against being pressed twice.
 */
export function cancelChat(viewId: ViewId): Promise<boolean> {
  return ok(dispatch('chat.cancel', { viewId }))
}

export function clearChat(viewId: ViewId): Promise<boolean> {
  return ok(dispatch('chat.clear', { viewId }))
}

export function attachToChat(viewId: ViewId, attachments: ChatAttachmentSpec[]): Promise<boolean> {
  if (attachments.length === 0) return Promise.resolve(true)
  return ok(dispatch('chat.attach', { viewId, attachments }))
}

/** Omit `attachmentIds` to unstage everything. */
export function detachFromChat(viewId: ViewId, attachmentIds?: AttachmentId[]): Promise<boolean> {
  return ok(dispatch('chat.detach', { viewId, ...(attachmentIds ? { attachmentIds } : {}) }))
}

/**
 * Answer the permission prompt.
 *
 * `requestId` is passed whenever the view has one: without it, an answer that
 * lands after the prompt it was meant for has been replaced would silently
 * approve whatever is being asked *now*. A turn really can raise a second
 * request while a human is still reading the first.
 *
 * `optionId` is the agent's own id and is **not** the same string as the
 * option's `kind` (`allow` vs `allow_once`) — the UI localizes the label but
 * always sends back the id it was given.
 */
export function respondPermission(viewId: ViewId, optionId: string, requestId?: string): Promise<boolean> {
  return ok(
    dispatch('chat.respondPermission', {
      viewId,
      optionId,
      ...(requestId ? { requestId } : {}),
    }),
  )
}

/**
 * Answer the question the agent is blocked on.
 *
 * `requestId` travels for the same reason it does above, and against the same
 * race: a turn can ask a second question while the first is still being read,
 * and an unqualified answer would then answer the wrong one.
 *
 * `other` is the free-text box peek always offers. It may travel **with** chosen
 * options or instead of them — "the second one, but only for the EU rows" is a
 * real answer, and forcing it to be one or the other would throw away half of it.
 */
export function answerQuestion(
  viewId: ViewId,
  optionIds: string[],
  other?: string,
  requestId?: string,
): Promise<boolean> {
  return ok(
    dispatch('chat.answer', {
      viewId,
      optionIds,
      ...(other === undefined || other === '' ? {} : { other }),
      ...(requestId ? { requestId } : {}),
    }),
  )
}

export function setChatMode(viewId: ViewId, mode: ChatPermissionMode): Promise<boolean> {
  return ok(dispatch('chat.setMode', { viewId, mode }))
}
