import { create } from 'zustand'
import { readFlag, writeFlag } from '../../state/persistedFlag'

/**
 * Whether the conversation rail is collapsed.
 *
 * ## Why this is renderer-local and not part of the Workspace
 *
 * Recorded in `design/2026-08-02-chat-sessions-side-rail.md` §2.3/§3.2. Workspace
 * is main's source of truth and the thing MCP reads; a rail being open or shut is
 * a fact about this window's chrome, not about the data. Putting it there would
 * make main aware of how the window is laid out, and would turn "collapse the
 * rail" into a revision bump the AI has to reason about. The language switch
 * stayed in the renderer for exactly this reason — see `i18n/store.ts`.
 *
 * It is a store rather than a `useState` in the rail because two components own
 * the gesture: the rail's own header button and the status bar's toggle.
 */

const STORAGE_KEY = 'peek.chatRail.collapsed'

/**
 * Storage access is wrapped both ways — see `state/persistedFlag.ts`, which is
 * where that wrapping and the reason for it now live. The sidebar's collapse
 * state needed the same thing, and a caveat about `file://` origins written out
 * three times is a caveat that will eventually be right in only two of them.
 */

interface ChatRailState {
  collapsed: boolean
}

/**
 * Starts expanded when nothing is stored. This whole design exists because the
 * catalogue was too far out of reach; defaulting to collapsed would put it back.
 */
export const useChatRailStore = create<ChatRailState>(() => ({ collapsed: readFlag(STORAGE_KEY) }))

export function setChatRailCollapsed(collapsed: boolean): void {
  if (useChatRailStore.getState().collapsed === collapsed) return
  useChatRailStore.setState({ collapsed })
  writeFlag(STORAGE_KEY, collapsed)
}

export function toggleChatRail(): void {
  setChatRailCollapsed(!useChatRailStore.getState().collapsed)
}

/** Test seam: re-reads storage, which module init did once. */
export function resetChatRailForTest(): void {
  useChatRailStore.setState({ collapsed: readFlag(STORAGE_KEY) })
}
