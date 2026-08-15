/**
 * Every keyboard shortcut in peek, in one table.
 *
 * The table is the answer to a question that used to need a grep: *what are the
 * keyboard shortcuts?* Before this file the window's chords lived in
 * `hooks/shortcuts.ts`, the menu's accelerators in `main/menu.ts`, and the rest
 * — the grid's ⌘C, the composer's Enter, the arrow keys that move a highlight
 * through a menu — nowhere at all, as `onKeyDown` handlers written where they
 * were needed. Nothing was wrong with any of them individually. What was missing
 * was the sum: no cheat sheet could be complete, no conflict could be detected,
 * and no user could rebind a chord they did not like.
 *
 * ## Registered is not the same as dispatched
 *
 * Only `scope: 'window'` entries are matched by `resolveShortcut` and acted on
 * by `useGlobalKeys`. Everything else is **declared here and handled where it
 * always was**, and that is a deliberate limit rather than an unfinished job.
 * The component chords are entangled with component state — the composer's Enter
 * has to know whether an IME is composing and whether the mention menu is open;
 * its Backspace has to know whether the caret sits on an atomic mention — and
 * routing them through a central dispatcher would mean exporting that state as
 * dispatch context to buy nothing but a tidier diagram. Declaring them buys the
 * three things that were actually missing: they appear in the cheat sheet, they
 * are checked for conflicts, and they are written down.
 *
 * ## Rebindable is not the same as registered
 *
 * `⌘\` splitting a panel and `⌘⌥1` focusing the first one are peek's own
 * inventions, and a user may reasonably find them wrong. `Enter` sending a
 * message, `⌘C` copying a selection and `↑` moving through a list are things the
 * user learned from their operating system, not from peek; letting them be
 * rebound only offers a way to build an app that disagrees with every other app
 * on the machine. Those rows are read-only in settings.
 *
 * ## The menu is in here for one reason
 *
 * A menu accelerator is resolved *before* the keystroke reaches the web
 * contents, so an accelerator that collides with a window chord silently wins.
 * `main/menu.ts` says so in prose at the top of the file; `scope: 'menu'`
 * entries make it checkable, because `findConflicts` treats menu and window as
 * one namespace.
 */

import type { ChordPattern } from './chord'
import { parseChord } from './chord'

/* ================================================================== */
/* 1. Identity                                                         */
/* ================================================================== */

/**
 * Where a chord is heard.
 *
 * The scope is also the conflict namespace: two chords collide only inside one
 * scope, because `⌘C` in the grid and `⌘C` in a text field are not a conflict —
 * they are the same key doing the analogous thing to whatever has focus.
 */
export type ShortcutScope =
  /** Heard on `window`, wherever focus is. Dispatched by `useGlobalKeys`. */
  | 'window'
  /** An application-menu accelerator, resolved by the OS before the window sees it. */
  | 'menu'
  /** The result grid, while it has focus. */
  | 'grid'
  /** The chat composer's textarea. */
  | 'composer'
  /** Roving focus inside a tab strip, menu or segmented control. */
  | 'nav'
  /** A modal dialog, while it is the top of the modal stack. */
  | 'modal'

export interface ShortcutDef {
  id: ShortcutId
  scope: ShortcutScope
  /** The chord, in `chord.ts` syntax. */
  default: string
  /**
   * Whether the user may rebind it. See the file comment: peek's own chords are
   * rebindable, chords the user learned from their OS are not.
   */
  rebindable: boolean
  /**
   * Whether it stands down while focus is in a text entry.
   *
   * Only meaningful for `window` scope. The arrow families set it because
   * CodeMirror binds `Mod-Alt-Arrow` (multi-cursor) and `Mod-Shift-Arrow`
   * (extend selection), and an editor that cannot select a line because the
   * window stole the key is a broken editor. The tab chords deliberately do
   * **not** set it — "I am writing a query and want the other tab" is the single
   * most common thing to want from inside the editor.
   */
  standDownInTextEntry: boolean
  /** Message key for the one-line description in the cheat sheet and settings. */
  labelKey: string
}

/* ================================================================== */
/* 2. The table                                                        */
/* ================================================================== */

export const SHORTCUTS = [
  /* ---------------- Panels ---------------- */
  {
    id: 'panel.splitRow',
    scope: 'window',
    default: 'Mod+Backslash',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.panel.splitRow',
  },
  {
    id: 'panel.splitCol',
    scope: 'window',
    default: 'Mod+Shift+Backslash',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.panel.splitCol',
  },
  {
    id: 'panel.close',
    scope: 'window',
    default: 'Mod+Shift+KeyW',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.panel.close',
  },
  {
    id: 'panel.focusIndex',
    scope: 'window',
    default: 'Mod+Alt+<digit>',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.panel.focusIndex',
  },
  {
    id: 'panel.focusDirection',
    scope: 'window',
    default: 'Mod+Alt+<arrow>',
    rebindable: true,
    standDownInTextEntry: true,
    labelKey: 'keys.panel.focusDirection',
  },

  /* ---------------- Tabs ---------------- */
  {
    id: 'tab.close',
    scope: 'window',
    default: 'Mod+KeyW',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.tab.close',
  },
  {
    id: 'tab.select',
    scope: 'window',
    default: 'Mod+<digit>',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.tab.select',
  },
  /* Two entries rather than one with a Shift flag, so that Shift is matched
   * exactly and ⌃⌥Tab stays nobody's. */
  {
    id: 'tab.cycleNext',
    scope: 'window',
    default: 'Ctrl+Tab',
    // Not rebindable: ⌃Tab is what every browser and terminal on the machine
    // uses, and ⌘Tab — the chord a recorder would most likely capture instead —
    // is the OS application switcher and never reaches the window at all.
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.tab.cycleNext',
  },
  {
    id: 'tab.cyclePrev',
    scope: 'window',
    default: 'Ctrl+Shift+Tab',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.tab.cyclePrev',
  },

  /* ---------------- Moving a view ---------------- */
  {
    id: 'view.moveDirection',
    scope: 'window',
    default: 'Mod+Shift+<arrow>',
    rebindable: true,
    standDownInTextEntry: true,
    labelKey: 'keys.view.moveDirection',
  },
  {
    id: 'view.splitDirection',
    scope: 'window',
    default: 'Mod+Alt+Shift+<arrow>',
    rebindable: true,
    standDownInTextEntry: true,
    labelKey: 'keys.view.splitDirection',
  },

  /* ---------------- The application ---------------- */
  {
    id: 'app.settings',
    scope: 'window',
    default: 'Mod+Comma',
    rebindable: true,
    // CodeMirror binds nothing on Mod+Comma, and opening settings is not an
    // editing operation a query editor could plausibly own.
    standDownInTextEntry: false,
    labelKey: 'keys.app.settings',
  },
  {
    id: 'app.shortcuts',
    scope: 'window',
    default: 'Mod+Slash',
    rebindable: true,
    standDownInTextEntry: false,
    labelKey: 'keys.app.shortcuts',
  },
  {
    id: 'app.leaveTextEntry',
    scope: 'window',
    default: 'Escape',
    // Escape's meaning is layered across the whole window (the modal stack, the
    // grid's selection, CodeMirror's autocomplete). Rebinding the bottom layer
    // of that stack would be a way to break the other three from a form.
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.app.leaveTextEntry',
  },

  /* ---------------- The application menu ----------------
   * Resolved by the OS before the window sees the key; here so that
   * `findConflicts` can see them. `main/menu.ts` owns the behaviour. */
  {
    id: 'menu.zoomActual',
    scope: 'menu',
    default: 'Mod+Digit0',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.menu.zoomActual',
  },
  {
    id: 'menu.zoomIn',
    scope: 'menu',
    default: 'Mod+Equal',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.menu.zoomIn',
  },
  {
    id: 'menu.zoomOut',
    scope: 'menu',
    default: 'Mod+Minus',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.menu.zoomOut',
  },

  /* ---------------- The result grid ---------------- */
  {
    id: 'grid.selectAll',
    scope: 'grid',
    default: 'Mod+KeyA',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.grid.selectAll',
  },
  {
    id: 'grid.copy',
    scope: 'grid',
    default: 'Mod+KeyC',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.grid.copy',
  },
  {
    id: 'grid.jumpEdge',
    scope: 'grid',
    default: 'Mod+<arrow>',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.grid.jumpEdge',
  },
  {
    id: 'grid.clearSelection',
    scope: 'grid',
    default: 'Escape',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.grid.clearSelection',
  },

  /* ---------------- The chat composer ---------------- */
  {
    id: 'composer.send',
    scope: 'composer',
    default: 'Enter',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.composer.send',
  },
  {
    id: 'composer.newline',
    scope: 'composer',
    default: 'Shift+Enter',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.composer.newline',
  },
  {
    id: 'composer.mention',
    scope: 'composer',
    default: 'Shift+Digit2',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.composer.mention',
  },

  /* ---------------- Roving focus ---------------- */
  {
    id: 'nav.move',
    scope: 'nav',
    default: '<arrow>',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.nav.move',
  },
  {
    id: 'nav.activate',
    scope: 'nav',
    default: 'Enter',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.nav.activate',
  },

  /* ---------------- Modal dialogs ---------------- */
  {
    id: 'modal.close',
    scope: 'modal',
    default: 'Escape',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.modal.close',
  },
  {
    id: 'modal.cycleFocus',
    scope: 'modal',
    default: 'Tab',
    rebindable: false,
    standDownInTextEntry: false,
    labelKey: 'keys.modal.cycleFocus',
  },
] as const satisfies readonly RawShortcutDef[]

/** Pre-`satisfies` shape, so `SHORTCUTS` can stay a literal and still be checked. */
interface RawShortcutDef extends Omit<ShortcutDef, 'id'> {
  id: string
}

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** The ids `useGlobalKeys` can be asked to act on. */
export type WindowShortcutId = Extract<
  (typeof SHORTCUTS)[number],
  { scope: 'window' }
>['id']

/**
 * One entry, by id.
 *
 * Returns the literal element type rather than the `ShortcutDef` interface, so
 * `labelKey` stays the message-key literal it was written as — which is what
 * makes `t(shortcutById(id).labelKey)` a checked call instead of a string
 * looked up at runtime.
 */
export function shortcutById(id: ShortcutId): (typeof SHORTCUTS)[number] {
  const found = SHORTCUTS.find((def) => def.id === id)
  // Unreachable through the type, but this function is also the one a
  // hand-edited settings file reaches through a string.
  if (!found) throw new Error(`unknown shortcut id: ${id}`)
  return found
}

/**
 * The parsed default for every entry.
 *
 * Parsed once at module load rather than per keystroke, and a default that fails
 * to parse is a programming error rather than a user one — so unlike the user's
 * overrides, it throws. A table with a typo in it would otherwise ship as a
 * chord that silently does nothing.
 */
export const DEFAULT_PATTERNS: ReadonlyMap<ShortcutId, ChordPattern> = new Map(
  SHORTCUTS.map((def) => {
    const pattern = parseChord(def.default)
    if (!pattern) throw new Error(`shortcut ${def.id} has an unparseable default: ${def.default}`)
    return [def.id, pattern]
  }),
)
