import type { AttachmentId, ChatAttachment, ChatAttachmentSpec, ViewId, Workspace } from '@peek/core'
import { collectPanels, findPanel } from '@peek/core'
import { readWorkspace } from '../../state/workspaceStore'
import { setContextActionPort } from '../context-actions/port'
import { attachToChat, detachFromChat } from './chatCommands'

/**
 * Wiring the *other* context path — "attach what I have selected" — into this
 * panel.
 *
 * `components/context-actions/` owns the gesture: it knows which rows are
 * highlighted, which cell the pointer is over, and what the driver can describe,
 * and it turns that into a `ChatAttachment`. It deliberately does **not** know
 * how to dispatch, and left a `ContextActionPort` to be registered instead — so
 * that neither side has to import the other's internals and neither had to wait
 * for the other to exist.
 *
 * This is that registration, and it does exactly what the port's own note asks:
 * dispatch, and nothing else. No optimistic state — a staged attachment appears
 * on the chip strip when main's patch lands and `ChatViewState.attachments`
 * changes, like everything else in this renderer.
 *
 * ## One conversion happens here
 *
 * The port hands over a `ChatAttachment` (it derives a localized `label` for the
 * chip). `chat.attach` takes a `ChatAttachmentSpec` — the same descriptor
 * without an `id`, because main mints that. Dropping the renderer's provisional
 * id is the whole of the conversion, and it is the correct direction: two
 * processes minting ids for the same object is how a detach ends up targeting
 * something that is not there.
 */

/** `ChatAttachment` → `ChatAttachmentSpec`: drop the provisional id, keep the label. */
export function toAttachmentSpec(attachment: ChatAttachment): ChatAttachmentSpec {
  const { id: _id, ...spec } = attachment
  return spec as ChatAttachmentSpec
}

/**
 * Which chat view an attachment goes to when the user did not name one.
 *
 * Ordered by how likely the user is to mean it:
 *
 *  1. the chat in the focused panel — they were just looking at it;
 *  2. any chat that is the *visible* tab of some panel — it is on screen;
 *  3. any chat at all, so a conversation in a background tab still receives;
 *  4. null, which is what lets the menu offer "open a chat" instead of failing
 *     silently.
 */
export function defaultChatViewId(ws: Workspace | null = readWorkspace()): ViewId | null {
  if (!ws) return null

  const isChat = (viewId: ViewId | null): viewId is ViewId =>
    viewId !== null && ws.views[viewId]?.kind === 'chat'

  const focused = ws.focusedPanel ? findPanel(ws.layout, ws.focusedPanel) : null
  if (focused && isChat(focused.activeViewId)) return focused.activeViewId

  const panels = collectPanels(ws.layout)
  for (const panel of panels) {
    if (isChat(panel.activeViewId)) return panel.activeViewId
  }
  for (const panel of panels) {
    for (const viewId of panel.viewIds) {
      if (isChat(viewId)) return viewId
    }
  }
  return null
}

let installed = false

/**
 * Install the port. Idempotent, and called at module scope from `index.ts` —
 * not from an effect, because StrictMode would run it twice.
 */
export function installContextActionPort(): void {
  if (installed) return
  installed = true
  setContextActionPort({
    attach: (chatViewId: ViewId, attachment: ChatAttachment): Promise<boolean> =>
      attachToChat(chatViewId, [toAttachmentSpec(attachment)]),
    detach: (chatViewId: ViewId, attachmentId: AttachmentId): Promise<boolean> =>
      detachFromChat(chatViewId, [attachmentId]),
    defaultChatViewId: () => defaultChatViewId(),
  })
}
