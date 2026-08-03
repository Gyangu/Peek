import { AUTO_REFRESH_PRESETS_MS, type AutoRefreshStopReason } from '@peek/core'
import type { MenuNode } from '../../ui/menuModel'

/**
 * The interval menu behind the toolbar's `auto` button.
 *
 * A pure function for the same reason `browseControls.ts` and `treeMenu.ts` are:
 * this is where the business of the control lives, and a `.tsx` file is out of a
 * unit test's reach.
 *
 * The check mark is a label prefix rather than a menu feature. `MenuItemNode` has
 * no "checked" concept, and inventing one for a single caller would widen the
 * primitive for a decoration — see `ui/Menu.tsx` on what it deliberately does not
 * do.
 */
export interface AutoRefreshMenuOptions {
  /** The interval in force, or null when off. */
  currentMs: number | null
  /** Set when auto-refresh turned *itself* off, so the menu can say why. */
  stoppedBy?: AutoRefreshStopReason
  labels: {
    off: string
    /** Formats one preset, e.g. `5s` / `10 min`. */
    interval: (ms: number) => string
    /** One line explaining `stoppedBy`. */
    stoppedNote: (reason: AutoRefreshStopReason) => string
  }
  onSelect: (ms: number | null) => void
}

export function autoRefreshMenuNodes(options: AutoRefreshMenuOptions): MenuNode[] {
  const { currentMs, stoppedBy, labels, onSelect } = options
  const mark = (active: boolean, text: string): string => (active ? `✓ ${text}` : `   ${text}`)

  const nodes: MenuNode[] = []
  // The explanation goes first, because the state it explains — the control
  // reading "off" when the user last set it to five seconds — is what sent them
  // into this menu.
  if (stoppedBy !== undefined) {
    nodes.push({ kind: 'note', id: 'stopped', text: labels.stoppedNote(stoppedBy) })
  }
  nodes.push({
    kind: 'item',
    id: 'off',
    label: mark(currentMs === null, labels.off),
    onSelect: () => {
      onSelect(null)
    },
  })
  nodes.push({ kind: 'sep', id: 'sep' })
  for (const ms of AUTO_REFRESH_PRESETS_MS) {
    nodes.push({
      kind: 'item',
      id: `ms-${ms}`,
      label: mark(currentMs === ms, labels.interval(ms)),
      onSelect: () => {
        onSelect(ms)
      },
    })
  }
  return nodes
}

/**
 * `5s` / `30s` / `1 min` / `1 h`, from the raw interval.
 *
 * Formatting lives next to the menu rather than in the message catalogue because
 * the unit is derived from the number, and a catalogue entry per preset would be
 * nine strings that must stay in step with one array.
 */
export function formatInterval(ms: number, units: { s: string; min: string; h: string }): string {
  if (ms < 60_000) return `${ms / 1000}${units.s}`
  if (ms < 3_600_000) return `${ms / 60_000}${units.min}`
  return `${ms / 3_600_000}${units.h}`
}
