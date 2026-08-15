/**
 * The registry plus whatever the user changed.
 *
 * A `BindingTable` is what `resolveShortcut` reads and what the settings form
 * writes. Building it is a pure function of the defaults and the overrides, so
 * the interesting behaviour — a bad override is dropped, a `null` disables, an
 * id nobody knows is forgotten — is asserted directly rather than through a
 * rendered form and a settings file.
 *
 * ## Why an override can be `null`
 *
 * `null` is "this chord is off", which is a different state from "never
 * changed". Users who bind ⌘W in a terminal muscle-memory-sensitive way, or who
 * simply want peek to stop reacting to a key, need somewhere between the default
 * and an invented chord that does nothing. It survives round-trips: the settings
 * file keeps the `null`, and only *reset to default* removes the key.
 */

import type { ChordPattern } from './chord'
import { chordText, parseChord, sameChord } from './chord'
import type { ShortcutDef, ShortcutId, ShortcutScope } from './registry'
import { DEFAULT_PATTERNS, SHORTCUTS } from './registry'

/** A chord per shortcut; `null` means the user turned it off. */
export type BindingTable = ReadonlyMap<ShortcutId, ChordPattern | null>

/** What `settings.json` stores: only what the user changed. */
export type BindingOverrides = Readonly<Record<string, string | null>>

/* ================================================================== */
/* 1. Building the table                                              */
/* ================================================================== */

/**
 * The defaults, with the user's overrides applied.
 *
 * Every rejection is silent and per-entry, which is the same rule the rest of
 * `settings.json` follows: one hand-typed mistake reads as "that one is not
 * set", never as a factory reset of the whole keyboard.
 *
 * Rejected: an id this build does not know (an override left by a newer peek),
 * a chord that does not parse, and any override of a shortcut the registry
 * marks unrebindable — the last one matters because the file is hand-editable,
 * so "the form will not let you" is not enforcement.
 */
export function buildBindings(overrides?: BindingOverrides): BindingTable {
  const table = new Map<ShortcutId, ChordPattern | null>(DEFAULT_PATTERNS)
  if (!overrides) return table

  for (const [id, value] of Object.entries(overrides)) {
    const def = SHORTCUTS.find((entry) => entry.id === id)
    if (!def || !def.rebindable) continue
    if (value === null) {
      table.set(def.id, null)
      continue
    }
    const pattern = parseChord(value)
    if (pattern) table.set(def.id, pattern)
  }
  return table
}

/** The default table, for callers with no user settings to hand. */
export const DEFAULT_BINDINGS: BindingTable = buildBindings()

/**
 * The overrides a table implies — what gets written back to `settings.json`.
 *
 * Only differences are kept. A binding the user set back to its default
 * disappears from the file rather than being written out as a literal copy of
 * the default, so retuning a default later still reaches everyone who never
 * disagreed with it.
 */
export function toOverrides(table: BindingTable): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [id, pattern] of table) {
    const fallback = DEFAULT_PATTERNS.get(id)
    if (!fallback) continue
    if (pattern === null) out[id] = null
    else if (!sameChord(pattern, fallback)) out[id] = chordText(pattern)
  }
  return out
}

/* ================================================================== */
/* 2. Conflicts                                                        */
/* ================================================================== */

export interface Conflict {
  scope: ShortcutScope
  chord: string
  ids: ShortcutId[]
}

/**
 * Chords that two shortcuts both claim.
 *
 * Scope is the namespace, with one join: `menu` is checked against `window`.
 * That join is the whole reason menu items are in the registry — an application
 * menu accelerator is resolved before the keystroke reaches the web contents, so
 * a menu item that happens to carry a window chord takes it away silently and
 * for good. Every other scope stands alone: `⌘C` in the grid and `⌘C` in a text
 * field are the same key doing the analogous thing to whatever has focus, which
 * is a feature.
 *
 * Key families collide when they overlap at all — `Mod+<digit>` and `Mod+Digit3`
 * are a conflict, because pressing ⌘3 cannot do both.
 */
export function findConflicts(table: BindingTable = DEFAULT_BINDINGS): Conflict[] {
  const byScope = new Map<string, ShortcutDef[]>()
  for (const def of SHORTCUTS) {
    const key = def.scope === 'menu' ? 'window' : def.scope
    const bucket = byScope.get(key)
    if (bucket) bucket.push(def)
    else byScope.set(key, [def])
  }

  const conflicts: Conflict[] = []
  for (const defs of byScope.values()) {
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const a = defs[i] as ShortcutDef
        const b = defs[j] as ShortcutDef
        const one = table.get(a.id)
        const two = table.get(b.id)
        if (!one || !two || !overlaps(one, two)) continue
        conflicts.push({ scope: a.scope, chord: chordText(one), ids: [a.id, b.id] })
      }
    }
  }
  return conflicts
}

/** Whether two patterns can be produced by one keystroke. */
export function overlaps(a: ChordPattern, b: ChordPattern): boolean {
  if (a.mod !== b.mod || a.ctrl !== b.ctrl || a.alt !== b.alt || a.shift !== b.shift) return false
  return tokensOverlap(a.token, b.token)
}

function tokensOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const wide = a.startsWith('<') ? a : b.startsWith('<') ? b : null
  if (wide === null) return false
  const narrow = wide === a ? b : a
  if (narrow.startsWith('<')) return false // two different families never overlap
  if (wide === '<digit>') return /^(?:Digit|Numpad)[1-9]$/.test(narrow)
  return /^Arrow(?:Left|Right|Up|Down)$/.test(narrow)
}

/**
 * What a proposed chord would collide with, for the settings form.
 *
 * Excludes the shortcut being edited, so rebinding something to the chord it
 * already has is not reported as a conflict with itself.
 */
export function conflictsWith(id: ShortcutId, pattern: ChordPattern, table: BindingTable): ShortcutId[] {
  const def = SHORTCUTS.find((entry) => entry.id === id)
  if (!def) return []
  const namespace = def.scope === 'menu' ? 'window' : def.scope
  const hits: ShortcutId[] = []
  for (const other of SHORTCUTS) {
    if (other.id === id) continue
    if ((other.scope === 'menu' ? 'window' : other.scope) !== namespace) continue
    const bound = table.get(other.id)
    if (bound && overlaps(pattern, bound)) hits.push(other.id)
  }
  return hits
}
