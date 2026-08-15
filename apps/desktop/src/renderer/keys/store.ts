import { create } from 'zustand'
import { dispatch } from '../state/dispatch'
import type { BindingOverrides, BindingTable } from './bindings'
import { DEFAULT_BINDINGS, buildBindings, toOverrides } from './bindings'
import type { ChordPattern } from './chord'
import type { ShortcutId } from './registry'
import { DEFAULT_PATTERNS } from './registry'

/**
 * The bindings currently in force.
 *
 * A store rather than a module constant because the table can change while the
 * window is open — the settings form rebinds a chord and the keyboard has to
 * follow on the next keystroke, not on the next launch. `useGlobalKeys`
 * subscribes; so does the cheat sheet, so that a chord it is displaying cannot
 * be one the window has stopped answering to.
 *
 * **Why the renderer holds it at all, when `settings.json` is main's.** The same
 * split the zoom uses in reverse: main persists, the renderer applies. Every one
 * of these chords is resolved inside the window (menu accelerators excepted, and
 * those are not rebindable), so main has no use for the parsed table — it stores
 * the strings and hands them back on `settings.read`.
 *
 * Until that read comes back the defaults are in force, which is the right
 * failure mode: a window whose keyboard was dead for the first frames after
 * launch would be worse than one that briefly answers to a chord the user
 * rebound.
 */
interface BindingsState {
  table: BindingTable
  /** False until `settings.read` has answered once. */
  loaded: boolean
}

const useBindingsStore = create<BindingsState>(() => ({
  table: DEFAULT_BINDINGS,
  loaded: false,
}))

/** The live table, for a component that re-renders when it changes. */
export function useBindings(): BindingTable {
  return useBindingsStore((s) => s.table)
}

/** The live table, for the keyboard listener, which is not a component. */
export function readBindings(): BindingTable {
  return useBindingsStore.getState().table
}

export function subscribeBindings(listener: (table: BindingTable) => void): () => void {
  return useBindingsStore.subscribe((state) => {
    listener(state.table)
  })
}

/** Tests, and the app's own start-up path. */
export function setBindings(overrides: BindingOverrides | undefined): void {
  useBindingsStore.setState({ table: buildBindings(overrides), loaded: true })
}

/**
 * Read the user's bindings out of `settings.json`.
 *
 * Called once on mount. A failure leaves the defaults standing rather than
 * retrying: the keyboard is not worth a retry loop, and the next launch reads
 * the file again anyway.
 */
export async function loadBindings(): Promise<void> {
  const res = await dispatch('settings.read', {})
  if (res) setBindings(res.keybindings)
}

/**
 * Rebind one shortcut and persist it.
 *
 * The store updates first and the write follows, unlike the Commands that move
 * views around. Those wait for main's patch because main owns the layout; this
 * one does not, because the renderer owns the keyboard — waiting would only add
 * a round-trip between pressing a key in the recorder and seeing it appear.
 *
 * `pattern === null` disables the shortcut; `reset` puts it back to the default,
 * which is a third state and not the same as binding it to its default value —
 * see `toOverrides`.
 */
export function rebind(id: ShortcutId, pattern: ChordPattern | null): void {
  writeTable(new Map(readBindings()).set(id, pattern))
}

export function resetBinding(id: ShortcutId): void {
  const fallback = DEFAULT_PATTERNS.get(id)
  if (!fallback) return
  writeTable(new Map(readBindings()).set(id, fallback))
}

export function resetAllBindings(): void {
  writeTable(new Map(DEFAULT_PATTERNS))
}

function writeTable(table: BindingTable): void {
  useBindingsStore.setState({ table })
  void dispatch('settings.write', { keybindings: toOverrides(table) })
}
