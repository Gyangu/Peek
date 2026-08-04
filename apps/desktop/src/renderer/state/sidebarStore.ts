import { create } from 'zustand'
import { readFlag, writeFlag } from './persistedFlag'

/**
 * Whether the connection sidebar is collapsed.
 *
 * ## Why this is renderer-local and not part of the Workspace
 *
 * Same reason the conversation rail's is — `design/2026-08-02-chat-sessions-side-rail.md`
 * §2.3. Workspace is main's source of truth and the thing MCP reads; a sidebar
 * being open or shut is a fact about this window's chrome, not about the data.
 * Putting it there would make main aware of how the window is laid out and turn
 * "collapse the sidebar" into a revision bump the AI has to reason about.
 *
 * It lives in `state/` rather than next to `Sidebar.tsx` the way `railStore`
 * lives next to its rail: `components/chat/` is a directory with a published
 * face (`index.ts`), a single component file is not.
 *
 * Design record: docs/design/2026-08-04-sidebar-collapse.md
 */

const STORAGE_KEY = 'peek.sidebar.collapsed'

interface SidebarState {
  collapsed: boolean
}

/** Starts expanded when nothing is stored: the connection list is how peek is used. */
export const useSidebarStore = create<SidebarState>(() => ({ collapsed: readFlag(STORAGE_KEY) }))

export function setSidebarCollapsed(collapsed: boolean): void {
  if (useSidebarStore.getState().collapsed === collapsed) return
  useSidebarStore.setState({ collapsed })
  writeFlag(STORAGE_KEY, collapsed)
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!useSidebarStore.getState().collapsed)
}

/** Test seam: re-reads storage, which module init did once. */
export function resetSidebarForTest(): void {
  useSidebarStore.setState({ collapsed: readFlag(STORAGE_KEY) })
}
