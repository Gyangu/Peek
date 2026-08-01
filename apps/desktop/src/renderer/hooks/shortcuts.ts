/**
 * The keyboard map, as a pure function.
 *
 * `resolveShortcut` takes the parts of a `KeyboardEvent` that matter and returns
 * the intent, or `null` for "not ours". Keeping the decision separate from the
 * listener is what makes the conflict rules — above all "the text editor wins
 * the arrow keys" — testable without a DOM, and it keeps the hook down to
 * translating an intent into a Command.
 *
 * The chords:
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
 *   ⌘⇧ ← ↑ ↓ →    move the focused view into the panel that way (swap on arrival)
 *   ⌘⌥⇧ ← ↑ ↓ →   move the focused view *past* that panel, into a new one
 *   ⌘,            open settings
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
 * `Esc` is the way back out: it drops focus (and only when nothing else already
 * handled it, so closing an autocomplete popup still just closes the popup).
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

import { arrowDirection, type Direction } from './layout-nav'

/* ================================================================== */
/* 1. Input                                                            */
/* ================================================================== */

/** The bits of a `KeyboardEvent` the map reads. */
export interface KeyChord {
  key: string
  /** `KeyboardEvent.code`; layout-independent, which `key` is not. */
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Another handler already claimed this event (CodeMirror calls `preventDefault`). */
  defaultPrevented?: boolean
}

export function chordOf(e: KeyboardEvent): KeyChord {
  return {
    key: e.key,
    code: e.code,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    defaultPrevented: e.defaultPrevented,
  }
}

/** Where the keystroke landed. */
export interface ShortcutContext {
  /** Focus is inside a text editor, an input or a contenteditable. */
  textEntry: boolean
}

/* ================================================================== */
/* 2. Output                                                           */
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
  /** Open the settings dialog. The one action here that is not a Command. */
  | { kind: 'openSettings' }

/** Highest panel index reachable by a digit; ⌘⌥1 … ⌘⌥9. */
export const MAX_PANEL_DIGIT = 9

/**
 * Highest tab digit that is bound. Only 1…8 address a tab by position — the
 * ninth is spent on "last", which is worth more once a panel can hold twelve.
 */
export const MAX_TAB_DIGIT = 9

/* ================================================================== */
/* 3. The map                                                          */
/* ================================================================== */

export function resolveShortcut(chord: KeyChord, ctx: ShortcutContext): ShortcutAction | null {
  // Someone downstream already handled it. Never fires twice on one key.
  if (chord.defaultPrevented === true) return null

  const mod = chord.meta || chord.ctrl

  if (!mod) {
    // The only unmodified chord: Esc as the way out of a text editor.
    if (chord.key === 'Escape' && !chord.alt && !chord.shift && ctx.textEntry) {
      return { kind: 'leaveTextEntry' }
    }
    return null
  }

  // Ctrl+Tab is bound to the *real* Ctrl on both platforms, not to `mod`: macOS
  // cycles tabs with ⌃Tab too (Safari, Chrome, Terminal all do), and ⌘Tab is the
  // OS application switcher, which must never reach us.
  if (chord.key === 'Tab' && chord.ctrl && !chord.meta && !chord.alt) {
    return { kind: 'cycleTab', delta: chord.shift ? -1 : 1 }
  }

  const dir = arrowDirection(chord.key)
  if (dir !== null) {
    // Arrows belong to the editor while it has focus; see the file comment.
    if (ctx.textEntry) return null
    if (chord.alt && chord.shift) return { kind: 'splitWithViewDirection', dir }
    if (chord.alt) return { kind: 'focusDirection', dir }
    if (chord.shift) return { kind: 'moveViewDirection', dir }
    return null
  }

  // ⌘, / Ctrl+, — settings, as in every desktop application. By `code` for the
  // same reason as Backslash below, and deliberately **not** standing down
  // inside a text editor: CodeMirror binds nothing on Mod+Comma, and "open
  // settings" is not an editing operation that a query editor could own.
  if (chord.code === 'Comma' && !chord.alt && !chord.shift) {
    return { kind: 'openSettings' }
  }

  // Backslash by `code`, not by `key`: with Shift held a US layout reports '|',
  // and on other layouts the character moves around entirely.
  if (chord.code === 'Backslash' && !chord.alt) {
    return { kind: 'split', dir: chord.shift ? 'col' : 'row' }
  }

  if ((chord.key === 'w' || chord.key === 'W') && !chord.alt) {
    return chord.shift ? { kind: 'closePanel' } : { kind: 'closeTab' }
  }

  const digit = digitOf(chord)
  if (digit !== null && !chord.shift) {
    if (chord.alt) return { kind: 'focusIndex', index: digit - 1 }
    return { kind: 'activateTab', index: digit === MAX_TAB_DIGIT ? 'last' : digit - 1 }
  }

  return null
}

/**
 * The digit 1…9 a chord names, or `null`.
 *
 * Read off `code` first, because `key` is not a digit once ⌥ is held on macOS —
 * ⌥1 arrives as `'¡'` — and the panel digits are an ⌥ chord. The `key` fallback
 * is what keeps synthetic events (and any keyboard that reports no `code`)
 * working, and it is only consulted with ⌥ up, where `key` is trustworthy.
 */
function digitOf(chord: KeyChord): number | null {
  const physical = /^(?:Digit|Numpad)([1-9])$/.exec(chord.code)
  if (physical) return Number(physical[1])
  if (!chord.alt && chord.key.length === 1 && chord.key >= '1' && chord.key <= '9') {
    return chord.key.charCodeAt(0) - '0'.charCodeAt(0)
  }
  return null
}

/* ================================================================== */
/* 4. Chord labels for the UI                                          */
/* ================================================================== */

/**
 * Modifier symbols for a hint line.
 *
 * These are never translated: `⌘⌥` and `Ctrl+Alt` are what is printed on the
 * keys in front of the user, and a translated modifier name would not match the
 * hardware. The arrow glyphs are language-neutral for the same reason.
 *
 * The status-bar tooltips are the only written record of the keyboard model, and
 * two of these chords changed meaning when panels grew tabs — so the digit
 * families are spelled out here rather than left to be rediscovered.
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

const ARROWS = '←↑↓→'
const DIGITS = '1…9'

export function shortcutHints(mac: boolean): ShortcutHints {
  return mac
    ? {
        focus: `⌘⌥ ${ARROWS}`,
        move: `⌘⇧ ${ARROWS}`,
        panelDigit: `⌘⌥${DIGITS}`,
        tabDigit: `⌘${DIGITS}`,
        lastTab: '⌘9',
        cycleTab: '⌃Tab',
        closeTab: '⌘W',
        closePanel: '⌘⇧W',
      }
    : {
        focus: `Ctrl+Alt ${ARROWS}`,
        move: `Ctrl+Shift ${ARROWS}`,
        panelDigit: `Ctrl+Alt+${DIGITS}`,
        tabDigit: `Ctrl+${DIGITS}`,
        lastTab: 'Ctrl+9',
        cycleTab: 'Ctrl+Tab',
        closeTab: 'Ctrl+W',
        closePanel: 'Ctrl+Shift+W',
      }
}

/** Whether the window is running on macOS, for the hint above. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  // `userAgentData` is not in every lib.dom yet, and `platform` is deprecated but
  // still the reliable read inside Electron. Both are wrapped so a headless test
  // never touches them.
  return /mac/i.test(navigator.userAgent)
}
