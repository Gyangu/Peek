/**
 * The chat panel's public surface. Nothing outside this directory should import
 * from any other file in it.
 *
 * ## How it is wired in (two edits, both in files this directory does not own)
 *
 * 1. `ViewHost.tsx` has the `case 'chat': return <ChatView view={view} />`
 *    branch the compiler demands once `kind: 'chat'` exists;
 * 2. `main.tsx` calls `startChat()` at module scope, next to
 *    `startWorkspaceSync()`. Not from an effect: StrictMode would run it twice.
 *    That one call subscribes to the delta channel *and* registers the
 *    `ContextActionPort` that `components/context-actions/` needs, which is what
 *    makes the grid's "add this selection to the chat" surfaces live rather than
 *    inert. `DataGrid` mounts those surfaces; the port is what lets them
 *    dispatch.
 *
 * Both are safe before the backend exists. Without a delta channel the panel
 * renders, states plainly that it is not connected, and still shows the
 * control-plane fields (status, mode, staged attachments, permission prompt)
 * that arrive through the ordinary Workspace patch stream.
 *
 * ## What the panel expects from the other side
 *
 * - **Commands** — `chat.send` / `chat.cancel` / `chat.clear` / `chat.attach` /
 *   `chat.detach` / `chat.respondPermission` / `chat.setMode`, exactly as
 *   `packages/core/src/commands.ts` defines them. Already in the registry;
 *   nothing here invents a payload.
 * - **Transcript** — `ChatDelta`s, batched, over a channel preload exposes as
 *   `onChatDelta(handler)` (plus an optional `getChatTranscript(chatId)` for
 *   re-sync). `core/ipc.ts` does not declare either yet; `transcriptStore.ts`
 *   probes for them at runtime and degrades visibly when they are missing,
 *   rather than showing an empty conversation that looks like a working one.
 * - **i18n** — ordinary `useT()` from `../../i18n`, against `chat.*` keys in
 *   `i18n/messages/{en,zh-CN}/chat.ts`. The panel used to carry a private
 *   catalog and a `useChatT` of its own, to keep parallel work from colliding in
 *   the shared index while it was being built; that has been folded in, and the
 *   panel now has no i18n machinery of its own.
 */

export { ChatView } from './ChatView'
/**
 * The catalogue rail down the right-hand side of the window. `App.tsx` mounts it
 * as a sibling of the work area; the status bar only toggles it, through
 * `toggleChatRail` — the collapse state is shared, so it cannot be a `useState`
 * in either place.
 */
export { ChatSessionsRail } from './ChatSessionsRail'
export { toggleChatRail, setChatRailCollapsed, useChatRailStore } from './railStore'

import { installContextActionPort } from './contextPort'
import { startChatSync } from './transcriptStore'

/**
 * Start the panel's two subscriptions. Call once, at module scope, from
 * `main.tsx`.
 *
 * Both halves are safe to run before the backend exists: the delta channel is
 * probed and skipped when absent, and the context port only ever dispatches
 * Commands that are already in the registry.
 */
export function startChat(): void {
  startChatSync()
  installContextActionPort()
}

export { defaultChatViewId, toAttachmentSpec } from './contextPort'

export {
  startChatSync,
  applyChatDelta,
  applyChatDeltas,
  enqueueChatDelta,
  enqueueChatDeltas,
  flushChatDeltas,
  setChatTranscript,
  loadChatTranscript,
  forgetChat,
  readChatMessages,
  type ChatBridgeChannel,
} from './transcriptStore'

/** For the data views: they own the "attach what is selected" gesture. */
export { attachToChat, detachFromChat } from './chatCommands'
