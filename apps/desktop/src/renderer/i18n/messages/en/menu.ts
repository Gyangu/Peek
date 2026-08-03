/**
 * The popup menu primitive, and the handful of acts that exist *only* in a menu.
 *
 * Deliberately thin. Almost every line in peek's context menus offers an act
 * that already had a label somewhere — `sidebar.action.disconnect`,
 * `chat.sessions.delete`, `panel.splitRow` — and a menu is a second way to reach
 * the same act, not a second act. Restating those strings here would be two
 * catalogue entries for one thing, which is how a translation drifts against
 * itself. Only what has no home elsewhere is below.
 */
export const menu = {
  /* The cancel line a `confirm` item swaps in. Shared by every menu, because
     "the second press must land somewhere harmless" is the primitive's promise
     rather than any one caller's. */
  'menu.cancel': 'Cancel',

  'menu.tree.label': 'Object actions',
  'menu.tree.open': 'Open',
  'menu.tree.copyName': 'Copy name',
  'menu.tree.refreshNode': 'Reload this level',

  'menu.tab.label': 'Tab actions',
  'menu.tab.close': 'Close tab',
  'menu.tab.closeOthers': 'Close other tabs',

  'menu.conn.label': 'Connection actions',
  'menu.session.label': 'Conversation actions',


  /* ---------------- Second batch: the rest of the window ---------------- */

  'menu.error.label': 'Error actions',
  'menu.error.copyEntry': 'Copy this entry',
  'menu.error.copyAll': 'Copy the whole log',
  'menu.error.clear': 'Clear the log',

  'menu.column.label': 'Column actions',
  'menu.column.sortAsc': 'Sort ascending',
  'menu.column.sortDesc': 'Sort descending',
  'menu.column.sortClear': 'Remove sort',
  'menu.column.copyName': 'Copy column name',

  'menu.message.label': 'Message actions',
  'menu.message.copy': 'Copy message',

  'menu.tool.label': 'Tool call actions',
  'menu.tool.copyInput': 'Copy arguments',
  'menu.tool.copyOutput': 'Copy result',

  'menu.chip.label': 'Attachment actions',
  'menu.chip.copyLabel': 'Copy label',
  'menu.chip.remove': 'Remove',

  'menu.kv.label': 'Entry actions',
  'menu.kv.copyKey': 'Copy key',
  'menu.kv.copyValue': 'Copy value',

  'menu.code.label': 'Code actions',
  'menu.code.copy': 'Copy code',

  'menu.divider.label': 'Split actions',
  'menu.divider.even': 'Even split',

  /* The one thing the right-click menu costs: it is invisible until tried. Said
     in the row's tooltip rather than as visible chrome — see the design record's
     §3.2, which takes the trade knowingly. */
  'menu.hint': 'Right-click for actions',
} as const

export type MenuMessages = typeof menu
