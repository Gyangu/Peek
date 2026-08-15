import { create } from 'zustand'

/**
 * Whether the shortcut sheet is showing.
 *
 * Same shape and same reasoning as `settingsDialogStore`: two openers that
 * cannot share a `useState` — `⌘/` arrives at a `window` listener outside the
 * React tree, and the sheet is also reachable from the settings dialog — and
 * "a sheet is open" is not Workspace state, so it is not a Command.
 */
interface ShortcutSheetState {
  open: boolean
}

const useShortcutSheetStore = create<ShortcutSheetState>(() => ({ open: false }))

export function openShortcutSheet(): void {
  useShortcutSheetStore.setState({ open: true })
}

export function closeShortcutSheet(): void {
  useShortcutSheetStore.setState({ open: false })
}

/** Toggles, because `⌘/` is the chord that closes it as well as opens it. */
export function toggleShortcutSheet(): void {
  useShortcutSheetStore.setState((s) => ({ open: !s.open }))
}

export function useShortcutSheetOpen(): boolean {
  return useShortcutSheetStore((s) => s.open)
}
