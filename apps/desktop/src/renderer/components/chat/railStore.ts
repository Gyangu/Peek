import { create } from 'zustand'

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
 * Storage is wrapped both ways because production loads the renderer from
 * `file://`, and a file-origin document can be denied storage outright depending
 * on how Chromium partitions it. Losing the preference is acceptable; throwing
 * during module init and taking the window down with it is not.
 */
function readStored(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeStored(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
    // Best-effort: the session still honours the toggle.
  }
}

interface ChatRailState {
  collapsed: boolean
}

/**
 * Starts expanded when nothing is stored. This whole design exists because the
 * catalogue was too far out of reach; defaulting to collapsed would put it back.
 */
export const useChatRailStore = create<ChatRailState>(() => ({ collapsed: readStored() }))

export function setChatRailCollapsed(collapsed: boolean): void {
  if (useChatRailStore.getState().collapsed === collapsed) return
  useChatRailStore.setState({ collapsed })
  writeStored(collapsed)
}

export function toggleChatRail(): void {
  setChatRailCollapsed(!useChatRailStore.getState().collapsed)
}

/** Test seam: re-reads storage, which module init did once. */
export function resetChatRailForTest(): void {
  useChatRailStore.setState({ collapsed: readStored() })
}
