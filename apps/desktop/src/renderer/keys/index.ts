/**
 * The keyboard system.
 *
 * Four modules, and the split between them is the same one `hooks/` uses: pure
 * logic that can be unit-tested with no DOM (`chord`, `registry`, `bindings`)
 * and the one piece of React glue that holds the live table (`store`).
 *
 * What is deliberately *not* here: the translation from a shortcut to something
 * happening. That is `hooks/shortcuts.ts` (which id means which intent) and
 * `hooks/useGlobalKeys.ts` (which intent sends which Command). A registry that
 * also knew what a shortcut *did* would be a second dispatcher.
 *
 * Design record: docs/design/2026-08-15-keyboard-system.md
 */

export {
  ARROW_TOKEN,
  DIGIT_TOKEN,
  MAX_DIGIT,
  chordOf,
  chordText,
  formatChord,
  formatMods,
  formatToken,
  matchChord,
  parseChord,
  recordChord,
  sameChord,
  toAccelerator,
  type ChordMatch,
  type ChordPattern,
  type KeyChord,
} from './chord'

export {
  DEFAULT_PATTERNS,
  SHORTCUTS,
  shortcutById,
  type ShortcutDef,
  type ShortcutId,
  type ShortcutScope,
  type WindowShortcutId,
} from './registry'

export {
  DEFAULT_BINDINGS,
  buildBindings,
  conflictsWith,
  findConflicts,
  overlaps,
  toOverrides,
  type BindingOverrides,
  type BindingTable,
  type Conflict,
} from './bindings'

export {
  loadBindings,
  readBindings,
  rebind,
  resetAllBindings,
  resetBinding,
  setBindings,
  subscribeBindings,
  useBindings,
} from './store'
