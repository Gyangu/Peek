/**
 * The keyboard map, as a pure function.
 *
 * `resolveShortcut` takes the parts of a `KeyboardEvent` that matter and returns
 * the intent, or `null` for "not ours". Keeping the decision separate from the
 * listener is what makes the conflict rules — above all "the text editor wins
 * the arrow keys" — testable without a DOM, and it keeps the hook down to
 * translating an intent into a Command.
 *
 * **Where the chords themselves live.** In `keys/registry.ts`, with every other
 * shortcut in the app, and the user's overrides on top of them (`keys/bindings`).
 * This file used to hold them as a chain of `if`s; it now holds only the half
 * that a table cannot express — which id means which `ShortcutAction`, and what
 * `⌘9` means that `⌘8` does not. The chords below are the defaults, and a user
 * who has rebound one will not see them here.
 *
 *   ⌘\            split the focused panel left/right   (empty panel, unchanged)
 *   ⌘⇧\           split the focused panel top/bottom   (empty panel, unchanged)
 *   ⌘W            close the visible tab (an empty panel has none: closes it)
 *   ⌘⇧W           close the focused panel and everything in it
 *   ⌘1 … ⌘8       show the Nth tab of the focused panel
 *   ⌘9            show its last tab
 *   ⌃Tab / ⌃⇧Tab  cycle forwards / backwards through that panel's tabs
 *   ⌘⌥1 … ⌘⌥9     focus the Nth panel in visual order
 *   ⌘⌥ ← ↑ ↓ →    move focus geometrically
 *   ⌘⇧ ← ↑ ↓ →    move the focused view into the panel that way
 *   ⌘⌥⇧ ← ↑ ↓ →   move the focused view *past* that panel, into a new one
 *   ⌘,            open settings
 *   ⌘/            show every shortcut
 *   Esc           leave the text editor, so the chords above become reachable again
 *
 * ## Two chords changed meaning when panels grew tabs
 *
 * `⌘1 … ⌘9` used to address **panels** and now addresses **tabs**; panels moved
 * to `⌘⌥1 … ⌘⌥9`. This is not a preference. In every tabbed application a user
 * has — browser, terminal, editor — a bare modifier and a digit selects a tab,
 * and peek now has tabs. Leaving the digits on panels would make peek the one
 * program where `⌘2` jumps somewhere else entirely. The replacement is not
 * arbitrary either: `⌘⌥` is already the panel family (`⌘⌥`+arrow moves focus
 * between panels), so panel addressing lands where the rest of panel navigation
 * already lives. `⌘9` selects the *last* tab rather than the ninth, for the same
 * reason every browser does it — with up to `MAX_PANEL_TABS` (12) tabs the digits
 * cannot reach them all, and the last one is the reachable one worth having.
 *
 * `⌘W` used to close the panel and now closes the visible tab, again because
 * that is what `⌘W` means everywhere else. Destroying a panel holding a dozen
 * views on the chord that elsewhere discards one of them would be the worst kind
 * of surprise. Closing a panel is `⌘⇧W`. The one exception keeps a two-year-old
 * reflex working: on an **empty** panel — what `⌘\` leaves behind — there is no
 * tab to close, so `⌘W` closes the panel, and `⌘\` `⌘W` still undoes itself.
 *
 * ## What the editor keeps
 *
 * On the arrow families: CodeMirror's default keymap binds both `Mod-Alt-Arrow`
 * (add cursor above/below) and `Mod-Shift-Arrow` (extend selection), so while a
 * text entry has focus every arrow chord here stands down — an editor that
 * cannot select a line because the window stole the key is a broken editor.
 * That stand-down is `standDownInTextEntry` on the registry entry now, rather
 * than a branch here. `Esc` is the way back out: it drops focus (and only when
 * nothing else already handled it, so closing an autocomplete popup still just
 * closes the popup).
 *
 * The tab chords deliberately do **not** stand down inside the editor, and that
 * is the point of them. CodeMirror binds none of `Mod`+digit, `Ctrl-Tab` or
 * `Mod-W`; more importantly, "I am typing a query and want the other tab" is the
 * single most common thing a user will want to do from inside the editor, and a
 * tab switch that only works after clicking out of the text box is a tab switch
 * nobody uses. (Plain `Tab` is untouched — CodeMirror keeps it.)
 *
 * ⌘⏎ is absent on purpose: the query view's own keymap owns it.
 */

import type { BindingTable } from '../keys/bindings'
import { DEFAULT_BINDINGS } from '../keys/bindings'
import type { ChordPattern, KeyChord } from '../keys/chord'
import { formatChord, formatMods, formatToken, matchChord } from '../keys/chord'
import type { ShortcutId } from '../keys/registry'
import { SHORTCUTS } from '../keys/registry'
import type { Direction } from './layout-nav'

export { chordOf, type KeyChord } from '../keys/chord'

/** Where the keystroke landed. */
export interface ShortcutContext {
  /** Focus is inside a text editor, an input or a contenteditable. */
  textEntry: boolean
}

/* ================================================================== */
/* Output                                                              */
/* ================================================================== */

export type ShortcutAction =
  | { kind: 'split'; dir: 'row' | 'col' }
  /** Close the whole focused panel, tabs and all. */
  | { kind: 'closePanel' }
  /** Close the focused panel's visible tab; on an empty panel, the panel. */
  | { kind: 'closeTab' }
  | { kind: 'focusIndex'; index: number }
  | { kind: 'focusDirection'; dir: Direction }
  /** Move the focused view into the neighbouring panel, swapping with whatever is there. */
  | { kind: 'moveViewDirection'; dir: Direction }
  /** Move the focused view past that neighbour, into a panel split off beyond it. */
  | { kind: 'splitWithViewDirection'; dir: Direction }
  /** Show the Nth tab of the focused panel; `'last'` for the rightmost one. */
  | { kind: 'activateTab'; index: number | 'last' }
  /** Step through the focused panel's tabs, wrapping at both ends. */
  | { kind: 'cycleTab'; delta: 1 | -1 }
  /** Drop DOM focus so the window's chords are reachable again. */
  | { kind: 'leaveTextEntry' }
  /** Open the settings dialog. Not a Command; see `settingsDialogStore`. */
  | { kind: 'openSettings' }
  /** Open the shortcut sheet. Not a Command either, and for the same reason. */
  | { kind: 'openShortcuts' }

/** Highest panel index reachable by a digit; ⌘⌥1 … ⌘⌥9. */
export const MAX_PANEL_DIGIT = 9

/**
 * Highest tab digit that is bound. Only 1…8 address a tab by position — the
 * ninth is spent on "last", which is worth more once a panel can hold twelve.
 */
export const MAX_TAB_DIGIT = 9

/* ================================================================== */
/* The map                                                             */
/* ================================================================== */

/** The window-scope entries, resolved once: the listener runs this per keystroke. */
const WINDOW_SHORTCUTS = SHORTCUTS.filter((def) => def.scope === 'window')

/**
 * What this keystroke means, under these bindings.
 *
 * `bindings` defaults to the registry, so a caller with no user settings to hand
 * — every test, and the window's first frames before `settings.read` answers —
 * gets peek's own keyboard rather than an empty one.
 */
export function resolveShortcut(
  chord: KeyChord,
  ctx: ShortcutContext,
  bindings: BindingTable = DEFAULT_BINDINGS,
): ShortcutAction | null {
  // Someone downstream already handled it. Never fires twice on one key.
  if (chord.defaultPrevented === true) return null

  for (const def of WINDOW_SHORTCUTS) {
    if (def.standDownInTextEntry && ctx.textEntry) continue
    const pattern = bindings.get(def.id)
    if (!pattern) continue // unbound: the user turned this one off
    const hit = matchChord(pattern, chord)
    if (!hit) continue
    const action = actionFor(def.id, hit, ctx)
    if (action) return action
  }
  return null
}

/**
 * The id, plus whatever the placeholder resolved to, as an intent.
 *
 * This is the part a table cannot hold: `⌘9` is the last tab rather than the
 * ninth, `⌘⌥1` is a zero-based index, and Esc means nothing outside a text
 * entry. Returning `null` here is "matched the chord, meant nothing" — which is
 * why `resolveShortcut` keeps looking rather than stopping at the first match.
 */
function actionFor(id: ShortcutId, hit: ReturnType<typeof matchChord>, ctx: ShortcutContext): ShortcutAction | null {
  if (!hit) return null
  switch (id) {
    case 'panel.splitRow':
      return { kind: 'split', dir: 'row' }
    case 'panel.splitCol':
      return { kind: 'split', dir: 'col' }
    case 'panel.close':
      return { kind: 'closePanel' }
    case 'tab.close':
      return { kind: 'closeTab' }
    case 'panel.focusIndex':
      return hit.kind === 'digit' ? { kind: 'focusIndex', index: hit.digit - 1 } : null
    case 'tab.select':
      if (hit.kind !== 'digit') return null
      return { kind: 'activateTab', index: hit.digit === MAX_TAB_DIGIT ? 'last' : hit.digit - 1 }
    case 'tab.cycleNext':
      return { kind: 'cycleTab', delta: 1 }
    case 'tab.cyclePrev':
      return { kind: 'cycleTab', delta: -1 }
    case 'panel.focusDirection':
      return hit.kind === 'arrow' ? { kind: 'focusDirection', dir: hit.dir } : null
    case 'view.moveDirection':
      return hit.kind === 'arrow' ? { kind: 'moveViewDirection', dir: hit.dir } : null
    case 'view.splitDirection':
      return hit.kind === 'arrow' ? { kind: 'splitWithViewDirection', dir: hit.dir } : null
    case 'app.settings':
      return { kind: 'openSettings' }
    case 'app.shortcuts':
      return { kind: 'openShortcuts' }
    case 'app.leaveTextEntry':
      // Esc outside a text entry belongs to whatever else is listening — the
      // modal stack, the grid's selection. Blurring the body achieves nothing
      // and would consume a key three other things want.
      return ctx.textEntry ? { kind: 'leaveTextEntry' } : null
    default:
      return null
  }
}

/* ================================================================== */
/* Chord labels for the UI                                             */
/* ================================================================== */

/**
 * Modifier symbols for a hint line.
 *
 * These are never translated: `⌘⌥` and `Ctrl+Alt` are what is printed on the
 * keys in front of the user, and a translated modifier name would not match the
 * hardware. The arrow glyphs are language-neutral for the same reason.
 *
 * Derived from the live bindings rather than written out, which is the point of
 * the registry: a hint that outlived its chord is worse than no hint, and a user
 * who rebound the panel family needs the status bar to say so.
 */
export interface ShortcutHints {
  /** Move focus between panels. */
  focus: string
  /** Move the focused view. */
  move: string
  /** Focus the Nth panel. */
  panelDigit: string
  /** Show the Nth tab. */
  tabDigit: string
  /** Show the last tab. */
  lastTab: string
  /** Cycle through the tabs. */
  cycleTab: string
  /** Close the visible tab. */
  closeTab: string
  /** Close the whole panel. */
  closePanel: string
}

export function shortcutHints(mac: boolean, bindings: BindingTable = DEFAULT_BINDINGS): ShortcutHints {
  const hint = (id: ShortcutId): string => {
    const pattern = bindings.get(id)
    // An unbound chord gets an empty hint rather than its default: advertising a
    // key the window no longer answers to is the one thing worse than silence.
    return pattern ? formatChord(pattern, mac) : ''
  }
  return {
    focus: hint('panel.focusDirection'),
    move: hint('view.moveDirection'),
    panelDigit: hint('panel.focusIndex'),
    tabDigit: hint('tab.select'),
    lastTab: lastTabHint(bindings.get('tab.select') ?? null, mac),
    cycleTab: hint('tab.cycleNext'),
    closeTab: hint('tab.close'),
    closePanel: hint('panel.close'),
  }
}

/**
 * `⌘9`, spelled out of the tab family it belongs to.
 *
 * The last-tab chord is not its own binding — it is the ninth member of
 * `tab.select`, given a different meaning by `actionFor`. Writing it by hand
 * would be the one hint that could survive a rebinding of the family it is part
 * of.
 */
function lastTabHint(family: ChordPattern | null, mac: boolean): string {
  if (!family) return ''
  const mods = formatMods(family, mac)
  const digit = formatToken(`Digit${String(MAX_TAB_DIGIT)}`)
  if (mods === '') return digit
  return `${mods}${mac ? '' : '+'}${digit}`
}

/** Whether the window is running on macOS, for the hint above. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  // `userAgentData` is not in every lib.dom yet, and `platform` is deprecated but
  // still the reliable read inside Electron. Both are wrapped so a headless test
  // never touches them.
  return /mac/i.test(navigator.userAgent)
}
