/**
 * Keyboard navigation: the focused-panel and visible-tab readouts in the status
 * bar.
 *
 * Its own domain file rather than lines in `grid.ts` (where the rest of the
 * status bar lives) because the surface being translated is the keyboard model,
 * and it is being written alongside the drag work in `panel.ts`.
 *
 * The chords themselves are **not** in here. `⌘⌥` and `←↑↓→` are what is printed
 * on the keys in front of the reader; translating a modifier would name
 * something their keyboard does not have. They arrive as `{focusKeys}` /
 * `{moveKeys}` / `{tabDigitKeys}` / … from `shortcutHints()`, which also picks
 * the Ctrl/Alt spelling off macOS.
 *
 * These two tooltips are the only place in the window where the chords are
 * written down, which matters more now than it did: tabs moved `⌘1 … ⌘9` off
 * panels and onto tabs, so a user with the old habit needs somewhere to find out
 * that panels answer to `⌘⌥1 … ⌘⌥9` now.
 */
export const keyboard = {
  'keyboard.panelPosition': 'Panel {index}/{total}',
  'keyboard.panelPositionTitle':
    'Focused panel · {focusKeys} move focus · {panelDigitKeys} focus the Nth panel · {moveKeys} move the view (add ⌥ to split off a new panel)',

  /* Shown only when the focused panel holds more than one tab — "Tab 1/1" says
   * nothing the view name beside it does not already say. */
  'keyboard.tabPosition': 'Tab {index}/{total}',
  'keyboard.tabPositionTitle':
    'Visible tab · {tabDigitKeys} select the Nth tab ({lastTabKey} is the last) · {cycleKeys} cycle · {closeTabKey} close',
} as const

export type KeyboardMessages = typeof keyboard
