/**
 * A chord, as text.
 *
 * One syntax carries a key binding through four places that have no other type
 * in common: the registry next door, `settings.json` (which users hand-edit),
 * the settings form (which records a keystroke and writes one back) and an
 * Electron menu accelerator. Anything less than a shared spelling means four
 * conversions and four chances to disagree about what `⌘⇧\` is.
 *
 *   Mod+Backslash        Mod+Shift+KeyW      Ctrl+Tab        Escape
 *   Mod+<digit>          Mod+Alt+<arrow>     Mod+Alt+Shift+<arrow>
 *
 * ## Three rules the syntax exists to enforce
 *
 * **`Mod` is not `Ctrl`.** `Mod` is ⌘ on macOS and Ctrl elsewhere; a literal
 * `Ctrl` is the real Ctrl key on both. peek needs both spellings, because
 * `⌃Tab` cycles tabs on macOS *as well* — ⌘Tab is the OS application switcher
 * and must never reach the window.
 *
 * **The main key is a `KeyboardEvent.code`, never a `key`.** This is not
 * pedantry, it is two bugs already paid for: with Shift held a US layout reports
 * `'|'` for the backslash key, and with ⌥ held macOS reports `'¡'` for the 1
 * key — and the panel digits are an ⌥ chord. `code` is the physical key in both
 * cases. `matchChord` still consults `key` as a fallback, because synthetic
 * events (and the tests below) carry no `code`.
 *
 * **Two placeholders keep the key families whole.** `<digit>` stands for 1…9 and
 * `<arrow>` for the four arrows. They exist so that "the panel family is ⌘⌥ plus
 * a digit" is one binding a user can rebind by pressing one chord, rather than
 * nine bindings that can drift apart into a keyboard model nobody can state.
 */

import { arrowDirection, type Direction } from '../hooks/layout-nav'

/* ================================================================== */
/* 1. The shape                                                        */
/* ================================================================== */

export interface ChordPattern {
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean
  /** The real Ctrl key, on every platform. */
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** A `KeyboardEvent.code`, or one of the two placeholders. */
  token: string
}

export const DIGIT_TOKEN = '<digit>'
export const ARROW_TOKEN = '<arrow>'

/** Highest digit a `<digit>` chord reaches. Nine, because there are nine fingers' worth. */
export const MAX_DIGIT = 9

/** What a chord resolved to, once a placeholder has been filled in. */
export type ChordMatch =
  | { kind: 'plain' }
  | { kind: 'digit'; digit: number }
  | { kind: 'arrow'; dir: Direction }

/* ================================================================== */
/* 2. Parsing                                                          */
/* ================================================================== */

const MODIFIER_ALIASES: Record<string, 'mod' | 'ctrl' | 'alt' | 'shift'> = {
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  '⌘': 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  '⌃': 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  '⇧': 'shift',
}

/**
 * Punctuation and the names Electron uses, mapped onto `code`.
 *
 * The Electron spellings (`Plus`, `Return`, `Esc`) are in here so an accelerator
 * copied out of `main/menu.ts` parses as written. `Plus` becomes `Equal`
 * because that is the physical key ⌘+ is pressed on.
 */
const TOKEN_ALIASES: Record<string, string> = {
  '\\': 'Backslash',
  ',': 'Comma',
  '/': 'Slash',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ' ': 'Space',
  plus: 'Equal',
  return: 'Enter',
  esc: 'Escape',
  spacebar: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

/** Named `code` values a binding may use. Anything else is rejected, typos included. */
const NAMED_TOKENS = new Set([
  'Backslash',
  'Comma',
  'Slash',
  'Period',
  'Semicolon',
  'Quote',
  'Minus',
  'Equal',
  'Backquote',
  'BracketLeft',
  'BracketRight',
  'Space',
  'Tab',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
])

/**
 * A chord, or `null` for "that is not one".
 *
 * `null` rather than a throw because the two callers that matter are a
 * hand-edited settings file and an MCP-visible command: both need one bad entry
 * to read as "not set" while the rest of the file survives, which is the same
 * rule `config/settings.ts` applies to every other preference.
 */
export function parseChord(text: string): ChordPattern | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const parts = text.split('+').map((part) => part.trim())
  // A trailing `+` is how somebody spells the plus key; `Mod++` splits into
  // ['Mod', '', ''] and the empty tail is the key they meant.
  const pattern: ChordPattern = { mod: false, ctrl: false, alt: false, shift: false, token: '' }
  let token: string | null = null

  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier !== undefined && !isLast) {
      if (pattern[modifier]) return null // the same modifier twice is a typo, not emphasis
      pattern[modifier] = true
      continue
    }
    if (!isLast) return null // a non-modifier before the end: two keys, which is not a chord
    token = normalizeToken(part === '' ? '+' : part)
  }

  if (token === null) return null
  pattern.token = token
  return pattern
}

function normalizeToken(raw: string): string | null {
  if (raw === DIGIT_TOKEN || raw === ARROW_TOKEN) return raw
  const alias = TOKEN_ALIASES[raw] ?? TOKEN_ALIASES[raw.toLowerCase()]
  if (alias !== undefined) return alias
  if (NAMED_TOKENS.has(raw)) return raw
  if (/^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F[1-9]|F1[0-2])$/.test(raw)) return raw
  if (/^[a-zA-Z]$/.test(raw)) return `Key${raw.toUpperCase()}`
  if (/^[0-9]$/.test(raw)) return `Digit${raw}`
  return null
}

/** The canonical text of a pattern; `parseChord(chordText(p))` is `p`. */
export function chordText(pattern: ChordPattern): string {
  const parts: string[] = []
  if (pattern.mod) parts.push('Mod')
  if (pattern.ctrl) parts.push('Ctrl')
  if (pattern.alt) parts.push('Alt')
  if (pattern.shift) parts.push('Shift')
  parts.push(pattern.token)
  return parts.join('+')
}

/** Two patterns are the same chord. Cheap because `chordText` is canonical. */
export function sameChord(a: ChordPattern, b: ChordPattern): boolean {
  return chordText(a) === chordText(b)
}

/* ================================================================== */
/* 3. Matching                                                         */
/* ================================================================== */

/** The bits of a `KeyboardEvent` a chord is matched against. */
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

/**
 * What this keystroke is, under this pattern — or `null`.
 *
 * `Mod` accepts either ⌘ or Ctrl on every platform rather than the one the OS
 * calls its own. A Mac user with an external PC keyboard, a remote desktop
 * session and a synthetic event in a test all press the chord they think they
 * are pressing, and no chord in peek distinguishes the two anyway: where the
 * real Ctrl has to be meant, the pattern says `Ctrl` and this refuses ⌘.
 *
 * `alt` and `shift` are matched **exactly**. That is what keeps `⌘\` and `⌘⇧\`
 * two different chords, and what leaves `⌘⌥W` free for something later.
 */
export function matchChord(pattern: ChordPattern, chord: KeyChord): ChordMatch | null {
  if (pattern.mod) {
    if (!chord.meta && !chord.ctrl) return null
  } else if (pattern.ctrl) {
    // The real Ctrl. ⌘ held as well means the user pressed something else.
    if (!chord.ctrl || chord.meta) return null
  } else if (chord.meta || chord.ctrl) {
    return null
  }
  if (pattern.alt !== chord.alt) return null
  if (pattern.shift !== chord.shift) return null

  if (pattern.token === DIGIT_TOKEN) {
    const digit = digitOf(chord)
    return digit === null ? null : { kind: 'digit', digit }
  }
  if (pattern.token === ARROW_TOKEN) {
    const dir = arrowDirection(chord.key.length > 0 ? chord.key : chord.code)
    return dir === null ? null : { kind: 'arrow', dir }
  }
  return matchesToken(pattern.token, chord) ? { kind: 'plain' } : null
}

/**
 * Whether the physical key matches.
 *
 * `code` decides when the event carries one. The `key` fallback is for events
 * that do not — synthetic ones, and the odd input method — and it is deliberately
 * only trusted for letters and named keys, never for punctuation: `key` is
 * exactly where `Shift+Backslash` turns into `'|'`, which is the bug `code`
 * exists to avoid.
 */
function matchesToken(token: string, chord: KeyChord): boolean {
  if (chord.code !== '') return chord.code === token
  const letter = /^Key([A-Z])$/.exec(token)
  if (letter) return chord.key.toUpperCase() === letter[1]
  return NAMED_TOKENS.has(token) && chord.key === token
}

/**
 * The digit 1…9 a chord names, or `null`.
 *
 * `code` first, because `key` is not a digit once ⌥ is held on macOS — ⌥1
 * arrives as `'¡'` — and the panel digits are an ⌥ chord. The `key` fallback is
 * what keeps synthetic events working, and it is only consulted with ⌥ up,
 * where `key` is trustworthy.
 */
function digitOf(chord: KeyChord): number | null {
  const physical = /^(?:Digit|Numpad)([1-9])$/.exec(chord.code)
  if (physical) return Number(physical[1])
  if (!chord.alt && chord.key.length === 1 && chord.key >= '1' && chord.key <= String(MAX_DIGIT)) {
    return chord.key.charCodeAt(0) - '0'.charCodeAt(0)
  }
  return null
}

/* ================================================================== */
/* 4. Writing a chord down                                             */
/* ================================================================== */

const MAC_SYMBOLS = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' } as const
const PC_NAMES = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const

/**
 * The modifiers, spelled the way the keyboard in front of the reader spells them.
 *
 * Never translated, in any locale: `⌘⌥` and `Ctrl+Alt` are what is printed on
 * the keys, and a translated modifier names something the hardware does not
 * have. `Mod` leads rather than following macOS's own ⌃⌥⇧⌘ order, because every
 * chord peek owns is a ⌘ chord and reading them all left-aligned on the same
 * symbol is worth more here than matching the Apple style guide.
 */
export function formatMods(pattern: ChordPattern, mac: boolean): string {
  const names = mac ? MAC_SYMBOLS : PC_NAMES
  const parts: string[] = []
  if (pattern.mod) parts.push(names.mod)
  if (pattern.ctrl && !(pattern.mod && !mac)) parts.push(names.ctrl)
  if (pattern.alt) parts.push(names.alt)
  if (pattern.shift) parts.push(names.shift)
  return mac ? parts.join('') : parts.join('+')
}

const TOKEN_LABELS: Record<string, string> = {
  Backslash: '\\',
  Comma: ',',
  Slash: '/',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Minus: '−',
  Equal: '=',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  [DIGIT_TOKEN]: `1…${String(MAX_DIGIT)}`,
  [ARROW_TOKEN]: '←↑↓→',
}

/** The key alone, without modifiers. */
export function formatToken(token: string): string {
  const label = TOKEN_LABELS[token]
  if (label !== undefined) return label
  const letter = /^Key([A-Z])$/.exec(token)
  if (letter) return letter[1] as string
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(token)
  if (digit) return digit[1] as string
  return token
}

/**
 * The whole chord, as one string.
 *
 * The separator is not decoration. macOS prints chords solid (`⌘⇧W`), Windows
 * and Linux print them joined (`Ctrl+Shift+W`) — and an arrow *family* takes a
 * space on both, because `⌘⌥←↑↓→` runs together into something unreadable while
 * `⌘⌥ ←↑↓→` reads as "this modifier, then any of these".
 */
export function formatChord(pattern: ChordPattern, mac: boolean): string {
  const mods = formatMods(pattern, mac)
  const token = formatToken(pattern.token)
  if (mods === '') return token
  const separator = pattern.token === ARROW_TOKEN ? ' ' : mac ? '' : '+'
  return `${mods}${separator}${token}`
}

/**
 * The Electron accelerator for a pattern, or `null` when there is none.
 *
 * Placeholders have no accelerator — a menu item is one key, not a family — and
 * that is exactly why the menu never carries the digit or arrow chords.
 */
export function toAccelerator(pattern: ChordPattern): string | null {
  if (pattern.token === DIGIT_TOKEN || pattern.token === ARROW_TOKEN) return null
  const parts: string[] = []
  if (pattern.mod) parts.push('CmdOrCtrl')
  if (pattern.ctrl) parts.push('Control')
  if (pattern.alt) parts.push('Alt')
  if (pattern.shift) parts.push('Shift')
  const letter = /^Key([A-Z])$/.exec(pattern.token)
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(pattern.token)
  parts.push(letter ? (letter[1] as string) : digit ? (digit[1] as string) : ACCELERATOR_KEYS[pattern.token] ?? pattern.token)
  return parts.join('+')
}

/** Where Electron's accelerator names differ from `code`. */
const ACCELERATOR_KEYS: Record<string, string> = {
  Backslash: '\\',
  Comma: ',',
  Slash: '/',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Enter: 'Return',
  Escape: 'Esc',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
}

/**
 * The chord a keystroke *is*, for the settings form's record button.
 *
 * `null` while only modifiers are down: holding ⌘ on the way to ⌘⇧W is not a
 * chord, and a recorder that committed on the first key down would record ⌘
 * every time. Digits and arrows are recorded as their family, because that is
 * the unit the registry binds.
 */
export function recordChord(chord: KeyChord): ChordPattern | null {
  if (MODIFIER_KEYS.has(chord.key)) return null
  const mod = chord.meta || (chord.ctrl && !chord.meta)
  const pattern: ChordPattern = {
    // A recorded Ctrl is spelled `Mod` — Ctrl is the modifier a PC user presses
    // for the same chord a Mac user presses ⌘ for, and recording it literally
    // would produce a binding that only works on the machine it was made on.
    // The literal-Ctrl chords are not rebindable, so nothing is lost here.
    mod,
    ctrl: false,
    alt: chord.alt,
    shift: chord.shift,
    token: '',
  }
  const arrow = arrowDirection(chord.key)
  if (arrow !== null) {
    pattern.token = ARROW_TOKEN
    return pattern
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(chord.code)
  if (digit) {
    pattern.token = DIGIT_TOKEN
    return pattern
  }
  const token = chord.code !== '' ? normalizeToken(chord.code) : normalizeToken(chord.key)
  if (token === null) return null
  pattern.token = token
  return pattern
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Dead'])
