import { useCallback, useState, useSyncExternalStore } from 'react'
import type { AttachmentId, ChatAttachment, ViewId } from '@peek/core'
import { tStatic } from '../../i18n'
import { notify } from '../../state/notifyStore'
import { hasContextConsent, subscribeContextConsent } from './consent'
import { getContextActionPort } from './port'

/**
 * The one place an attachment actually gets staged.
 *
 * Everything else in this directory is either pure (`descriptors`, `selection`)
 * or presentational. This hook is where the three concerns meet:
 *
 * 1. **the disclosure gate.** The first attachment of a user's life goes through
 *    `ConsentDialog` first. Crucially the requested attachment is *held*, not
 *    dropped — the user says "add these rows", reads the disclosure, accepts, and
 *    the rows they asked for are added. Making them repeat the gesture after
 *    reading a wall of text is how a disclosure becomes something people learn to
 *    dismiss before reading;
 * 2. **routing.** An attachment needs a chat view to live on. When none is open
 *    the caller is told, rather than the Command failing somewhere out of sight;
 * 3. **dispatch**, through `ContextActionPort`, which is a Command and nothing
 *    else — no optimistic local state (see `port.ts`).
 */

export interface ContextActionsApi {
  /**
   * Stage an attachment. Returns false when it did not happen — no chat view, no
   * consent yet (the dialog is now up), or the Command failed.
   *
   * A `null` chat view id means "wherever the user is chatting", resolved by the
   * port.
   */
  add(attachment: ChatAttachment, chatViewId?: ViewId | null): Promise<boolean>
  remove(chatViewId: ViewId, attachmentId: AttachmentId, label: string): Promise<boolean>
  /** True while the disclosure is on screen. Render `ConsentDialog` when set. */
  consentPending: boolean
  /** Wire these to `ConsentDialog`. */
  acceptConsent(): void
  cancelConsent(): void
  /** Whether a chat view exists to attach to; drives the menu's disabled state. */
  hasChatTarget: boolean
}

export function useContextActions(): ContextActionsApi {
  const consented = useSyncExternalStore(subscribeContextConsent, hasContextConsent, hasContextConsent)
  // The attachment the user asked for while the disclosure was up.
  const [held, setHeld] = useState<{ attachment: ChatAttachment; chatViewId: ViewId | null } | null>(null)

  const port = getContextActionPort()
  const hasChatTarget = port.defaultChatViewId() !== null

  const send = useCallback(
    async (attachment: ChatAttachment, chatViewId: ViewId | null): Promise<boolean> => {
      const target = chatViewId ?? getContextActionPort().defaultChatViewId()
      if (target === null) {
        notify('warn', tStatic('context.menu.noChat'), tStatic('context.menu.noChatTitle'))
        return false
      }
      const ok = await getContextActionPort().attach(target, attachment)
      // `tStatic` and not `t`: a toast fixes its wording at push time, which is
      // the convention notifyStore documents.
      if (ok) notify('info', tStatic('context.added', { label: attachment.label }))
      else notify('error', tStatic('context.addFailed', { label: attachment.label }))
      return ok
    },
    [],
  )

  const add = useCallback(
    async (attachment: ChatAttachment, chatViewId: ViewId | null = null): Promise<boolean> => {
      if (!hasContextConsent()) {
        // Hold it rather than dropping it: the user's gesture survives the dialog.
        setHeld({ attachment, chatViewId })
        return false
      }
      return send(attachment, chatViewId)
    },
    [send],
  )

  const acceptConsent = useCallback((): void => {
    const pending = held
    setHeld(null)
    // `grantContextConsent` has already run inside the dialog by this point, so
    // the held attachment goes straight through.
    if (pending) void send(pending.attachment, pending.chatViewId)
  }, [held, send])

  const cancelConsent = useCallback((): void => {
    setHeld(null)
  }, [])

  const remove = useCallback(
    async (chatViewId: ViewId, attachmentId: AttachmentId, label: string): Promise<boolean> => {
      const ok = await getContextActionPort().detach(chatViewId, attachmentId)
      if (ok) notify('info', tStatic('context.removed', { label }))
      return ok
    },
    [],
  )

  return {
    add,
    remove,
    consentPending: held !== null && !consented,
    acceptConsent,
    cancelConsent,
    hasChatTarget,
  }
}
