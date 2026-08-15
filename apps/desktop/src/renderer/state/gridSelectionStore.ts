import { create } from 'zustand'
import type { ChatAttachmentSpec, ViewId } from '@peek/core'

/**
 * What the user has selected in a grid right now, for the parts of the window
 * that are not inside that grid.
 *
 * ## Why this channel has to exist
 *
 * A row selection and a cell rectangle are `useState` inside `DataGrid`. The
 * context menu can read them because it is rendered inside that subtree; the
 * composer is in a different one, so `@` structurally could not see the
 * selection at all, and neither could a global shortcut. This is the one place
 * that fact is published.
 *
 * ## Why it is not Workspace state
 *
 * Same reasoning as the composer's draft (`Composer.tsx`): a drag passes through
 * dozens of intermediate selections, and every one of them would become a patch
 * broadcast. `read_workspace`'s readers have no use for which cells are
 * highlighted this instant — by the time it matters, it has been sent as an
 * attachment descriptor — and nothing here should survive a restart.
 *
 * ## One slot, not a map
 *
 * Only the grid that most recently changed its selection is held. `@选区` /
 * `@selection` is a phrase that means something only while it refers to one
 * thing; addressing a *particular* view's data is what `@items` already does.
 *
 * A grid clearing its selection only clears the store when the value there is
 * still its own — otherwise two grids taking turns would wipe each other.
 *
 * Design record: docs/design/2026-08-15-cell-range-attachment.md §2.5
 */

/**
 * The selection, already in the shape it would be attached in.
 *
 * Stored as a spec rather than as grid coordinates so there is nothing to
 * translate later: row selections and rectangles differ here and nowhere
 * downstream. The two kinds are mutually exclusive by construction — the grid
 * establishes one by clearing the other (design/2026-08-14-grid-drag-selection.md
 * §2.1) — which is why a single slot can hold either.
 */
export type GridSelectionSpec = Extract<ChatAttachmentSpec, { kind: 'rows' | 'cells' }>

interface GridSelectionState {
  selection: GridSelectionSpec | null
}

export const useGridSelectionStore = create<GridSelectionState>(() => ({ selection: null }))

/** Read once, for callers outside React (a shortcut handler). */
export function currentGridSelection(): GridSelectionSpec | null {
  return useGridSelectionStore.getState().selection
}

export function publishGridSelection(selection: GridSelectionSpec): void {
  useGridSelectionStore.setState({ selection })
}

/**
 * Drop the selection, if the one on record is this view's.
 *
 * The guard is what makes the single slot safe: a grid that unmounts, re-runs
 * its query or has its selection cleared says so unconditionally, and the ones
 * that are not the current holder are ignored.
 */
export function clearGridSelection(viewId: ViewId): void {
  const { selection } = useGridSelectionStore.getState()
  if (selection?.viewId !== viewId) return
  useGridSelectionStore.setState({ selection: null })
}

/** How many rows the selection covers — the number every label wants. */
export function selectionRowCount(selection: GridSelectionSpec): number {
  return selection.kind === 'rows' ? selection.rowIndexes.length : selection.r1 - selection.r0 + 1
}

/**
 * How many columns, or null when the selection carries whole rows.
 *
 * Null rather than "all of them" because the count is not the point: the label
 * reading off this has to say *whether* columns were narrowed, and a number
 * equal to the schema width would not say that.
 */
export function selectionColumnCount(selection: GridSelectionSpec): number | null {
  return selection.kind === 'cells' ? selection.columns.length : null
}
