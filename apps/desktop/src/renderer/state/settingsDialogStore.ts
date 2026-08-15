import { create } from 'zustand'

/**
 * Whether the settings dialog is open, and on which section.
 *
 * **Why this is a store and not `useState` in `App`.** The dialog has two
 * openers that cannot both reach a `useState` setter: the titlebar gear (inside
 * the React tree) and `⌘,` (a `window` keydown listener installed by
 * `useGlobalKeys`, outside it). Threading a setter down to the hook, or wrapping
 * the tree in a context to reach it, would be more machinery than the two lines
 * here.
 *
 * **Why it is not a Command.** Every other action `useGlobalKeys` translates
 * leaves as a Command, deliberately — the keyboard is the accessible twin of
 * dragging, so both go through the same path. This one does not, because "a
 * dialog is open" is not Workspace state: it changes no persistent fact, and MCP
 * neither can nor should read it. A model that wants a different MCP port sends
 * `mcp.configure`; it has no use for the panel a human would have used. Same
 * reasoning as the locale, and the note atop `i18n/store.ts` spells it out.
 */
export const SETTINGS_SECTIONS = [
  'mcp',
  'agent',
  'packages',
  'appearance',
  'notifications',
  'keyboard',
  'timeouts',
  'about',
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** The section a bare `⌘,` lands on. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'mcp'

interface SettingsDialogState {
  /** `null` means closed. */
  section: SettingsSection | null
  open: (section: SettingsSection) => void
  close: () => void
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  section: null,
  open: (section) => {
    set({ section })
  },
  close: () => {
    set({ section: null })
  },
}))

/**
 * Open the dialog, optionally on a named section.
 *
 * Callable from anywhere — the keyboard hook, the first-run guide, a toast —
 * which is the whole point of it not living in a component.
 */
export function openSettings(section: SettingsSection = DEFAULT_SETTINGS_SECTION): void {
  useSettingsDialogStore.getState().open(section)
}

export function closeSettings(): void {
  useSettingsDialogStore.getState().close()
}

/** The open section, or `null` when the dialog is closed. */
export function useSettingsSection(): SettingsSection | null {
  return useSettingsDialogStore((s) => s.section)
}
