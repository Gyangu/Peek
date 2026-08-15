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

  /* ================================================================
   * The registry's labels.
   *
   * One line per entry in `keys/registry.ts`, read by the shortcut sheet and by
   * the keyboard section of settings. They describe what the shortcut *does*,
   * never which keys it is — the keys come from the binding, which the user may
   * have changed, and a description that named them would be the one string in
   * the catalog that can become false.
   * ================================================================ */
  'keys.sheet.title': 'Keyboard shortcuts',

  'keys.scope.window': 'Window',
  'keys.scope.grid': 'Results grid',
  'keys.scope.composer': 'Chat composer',
  'keys.scope.nav': 'Lists, tabs and menus',
  'keys.scope.modal': 'Dialogs',
  'keys.scope.menu': 'Application menu',

  'keys.panel.splitRow': 'Split the panel left and right',
  'keys.panel.splitCol': 'Split the panel top and bottom',
  'keys.panel.close': 'Close the panel and every tab in it',
  'keys.panel.focusIndex': 'Focus the Nth panel',
  'keys.panel.focusDirection': 'Move focus to the panel that way',

  'keys.tab.close': 'Close the visible tab',
  'keys.tab.select': 'Show the Nth tab (the last digit shows the last tab)',
  'keys.tab.cycleNext': 'Show the next tab',
  'keys.tab.cyclePrev': 'Show the previous tab',

  'keys.view.moveDirection': 'Move the view into the panel that way',
  'keys.view.splitDirection': 'Move the view past that panel, into a new one',

  'keys.app.settings': 'Open settings',
  'keys.app.shortcuts': 'Show the keyboard shortcuts',
  'keys.app.leaveTextEntry': 'Leave the text editor',

  'keys.menu.zoomActual': 'Actual size',
  'keys.menu.zoomIn': 'Zoom in',
  'keys.menu.zoomOut': 'Zoom out',

  'keys.grid.selectAll': 'Select every row',
  'keys.grid.copy': 'Copy the selection',
  'keys.grid.jumpEdge': 'Jump to the first or last row',
  'keys.grid.clearSelection': 'Clear the selection',

  'keys.composer.send': 'Send the message',
  'keys.composer.newline': 'Start a new line',
  'keys.composer.mention': 'Mention a table, a view or a file',

  'keys.nav.move': 'Move through the items',
  'keys.nav.activate': 'Open the highlighted item',

  'keys.modal.close': 'Close the dialog',
  'keys.modal.cycleFocus': 'Move to the next control',

  /* The keyboard section of settings. */
  'keys.settings.record': 'Change the shortcut for {name}',
  'keys.settings.recording': 'Press a chord…',
  'keys.settings.reset': 'Reset',
  'keys.settings.resetAll': 'Reset every shortcut',
  'keys.settings.showSheet': 'Show the shortcut sheet',
  'keys.settings.off': 'Off',
  'keys.settings.conflict': 'Also bound to: {others}',
  'keys.settings.readOnly': 'These come from the system. They cannot be changed.',
} as const

export type KeyboardMessages = typeof keyboard
