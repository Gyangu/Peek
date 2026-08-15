import { useCallback, useMemo, useRef, useState } from 'react'
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'

/* ==================================================================
 * The grid's column model.
 *
 * ## Why this is not TanStack Table
 *
 * The grid used `useReactTable` for the column axis alone — headers, widths,
 * and drag-to-resize — and deliberately fed it `data: []`, because running a
 * million-row result set through `getCoreRowModel` would materialize a million
 * Row objects and break the "never hold the whole table in memory" rule outright.
 *
 * So the renderer was paying for a general-purpose table engine (row models,
 * grouping, sorting, filtering, pagination, faceting, expansion, pinning, the
 * whole feature registry — ~106 kB of `@tanstack/table-core` unminified) to get
 * three things it can compute itself:
 *
 *   1. `size` per column, defaulting from the column definition;
 *   2. a user override for that size, keyed by column id;
 *   3. a pointer drag that writes (2).
 *
 * That is what this file is. Everything the grid actually called —
 * `getFlatHeaders()`, `header.getSize()`, `header.getResizeHandler()` — has a
 * direct counterpart below.
 *
 * ## What it deliberately does not do
 *
 * No row model of any kind. No column visibility, ordering, pinning, or
 * grouping. The grid has none of those features, and the day it grows one,
 * adding it here is a smaller change than the one needed to make a general
 * engine hold a hundred million rows.
 *
 * ## Shape: a DOM-free core plus a thin hook
 *
 * `resolveHeaders` and `ColumnResizer` never touch the DOM or React, the same
 * split vscroll.ts uses — so the width arithmetic, the clamping and the drag
 * state machine are all reachable from node:test, and `useColumnModel` is left
 * with nothing but wiring.
 * ================================================================== */

/** A column as the grid declares it. Widths are CSS pixels. */
export interface GridColumn {
  /** Stable across renders of the same schema; used as the sizing key and the React key. */
  readonly id: string
  /** Width to use until the user drags it. */
  readonly size: number
  readonly minSize: number
  readonly maxSize: number
}

/** User-dragged widths by column id. Absent means "use the column's own size". */
export type ColumnSizing = Readonly<Record<string, number>>

export const clampWidth = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * The width a column renders at: the user's override if there is one, else the
 * column's own default.
 *
 * The override is re-clamped rather than trusted. It is state that outlives the
 * gesture that produced it, and `minSize` / `maxSize` are derived from the
 * schema — so a stored width can legitimately fall outside the current bounds,
 * and a 1200px column in a model that now caps at 400 should render at 400.
 */
export function resolveWidth(column: GridColumn, sizing: ColumnSizing): number {
  const override = sizing[column.id]
  return override === undefined ? column.size : clampWidth(override, column.minSize, column.maxSize)
}

export function resolveWidths(columns: readonly GridColumn[], sizing: ColumnSizing): number[] {
  return columns.map((column) => resolveWidth(column, sizing))
}

/* ------------------------------------------------------------------ */
/* The resize gesture                                                  */
/* ------------------------------------------------------------------ */

interface DragState {
  readonly pointerId: number
  readonly columnId: string
  readonly startX: number
  /**
   * The column's width when the gesture began.
   *
   * Every move is `startSize + dx`, never "current width + delta since the last
   * move". Accumulating deltas would drift whenever the browser coalesces moves
   * or a clamp swallows one, and it would make the move handler depend on the
   * current sizing — which would change its identity on every pointermove.
   */
  readonly startSize: number
  readonly minSize: number
  readonly maxSize: number
}

/** What a move resolved to; `null` from `moveTo` means "nothing to write". */
export interface ResizeUpdate {
  readonly columnId: string
  readonly width: number
}

/**
 * The drag state machine, DOM-free.
 *
 * Exactly one gesture at a time: a second pointer going down mid-drag is
 * ignored rather than allowed to hijack the first, which is what a trackpad
 * generates when a second finger lands.
 */
export class ColumnResizer {
  private drag: DragState | null = null

  /** The column being dragged, or null. Drives the drag bar's accent in DataGrid. */
  get activeId(): string | null {
    return this.drag?.columnId ?? null
  }

  /** @returns true if this pointer took the gesture. */
  begin(column: GridColumn, pointerId: number, clientX: number, startSize: number): boolean {
    if (this.drag !== null) return false
    this.drag = {
      pointerId,
      columnId: column.id,
      startX: clientX,
      startSize,
      minSize: column.minSize,
      maxSize: column.maxSize,
    }
    return true
  }

  /** @returns the new width, or null if this pointer is not the one dragging. */
  moveTo(pointerId: number, clientX: number): ResizeUpdate | null {
    const drag = this.drag
    if (!drag || drag.pointerId !== pointerId) return null
    return {
      columnId: drag.columnId,
      width: clampWidth(drag.startSize + (clientX - drag.startX), drag.minSize, drag.maxSize),
    }
  }

  /** @returns true if this pointer ended the gesture. */
  end(pointerId: number): boolean {
    if (!this.drag || this.drag.pointerId !== pointerId) return false
    this.drag = null
    return true
  }
}

/**
 * Fold one resize into the sizing map, returning the **same object** when the
 * width did not change.
 *
 * A pointermove stream produces many events at the same integer width — the
 * pointer moves sub-pixel, or the drag is pinned against a clamp. Returning
 * `prev` unchanged is what lets React bail out instead of re-rendering the whole
 * header row and every visible cell for each of them.
 */
export function applyResize(prev: ColumnSizing, update: ResizeUpdate): ColumnSizing {
  if (prev[update.columnId] === update.width) return prev
  return { ...prev, [update.columnId]: update.width }
}

/* ------------------------------------------------------------------ */
/* The rendered column window                                          */
/* ------------------------------------------------------------------ */

/** The part of a virtual column the grid actually renders against. */
export interface ColumnWindowItem {
  readonly index: number
  readonly start: number
  readonly end: number
}

/**
 * Identity of the currently rendered column window.
 *
 * The grid keeps the virtual-column array referentially stable so that `GridRow`
 * (memoized on its props) can bail out wholesale while the user scrolls
 * vertically — the column window does not move on that axis, so handing rows a
 * fresh array every frame would defeat the memo for the entire visible window.
 * This key is what decides when that cached array may be replaced.
 *
 * ## The bug this signature exists to prevent
 *
 * The key used to be `first.index : last.index : widthKey`, where `widthKey`
 * came from the *column model* — the intent. But what gets rendered is the
 * *virtualizer's* measurements, and those trail the model by one commit:
 * `setSizing` renders with the new `widthKey` (so the key changed, and the still
 * unmeasured items were cached), then a layout effect calls `measure()` and
 * renders again with correct items — at which point `first.index`,
 * `last.index` and `widthKey` are all unchanged, the key does not move, and
 * **the corrected measurements are dropped on the floor**.
 *
 * Live effect, measured over CDP on a real drag: the column follows the pointer
 * one gesture-step behind and settles on the second-to-last width. Dragging a
 * header from 110px out to 200px, in to the 44px minimum, then back to 110px
 * left the column sitting at 44px. Pre-existing, and reproduced identically
 * against the TanStack Table version, so it is not a regression from replacing
 * it — the old engine fed the same stale `widthKey` into the same key.
 *
 * The fix is that the key describes **what is on screen** (the items' own
 * geometry) rather than what the model intended. `widthKey` stays in it only to
 * close the one case the geometry cannot see: two interior columns changing by
 * equal and opposite amounts, which leaves `last.end` untouched.
 */
export function columnWindowKey(cols: readonly ColumnWindowItem[], widthKey: string): string {
  const first = cols[0]
  const last = cols[cols.length - 1]
  if (!first || !last) return `empty:${widthKey}`
  return `${String(first.index)}:${String(first.start)}:${String(last.index)}:${String(last.end)}:${String(cols.length)}:${widthKey}`
}

/* ------------------------------------------------------------------ */
/* The React binding                                                   */
/* ------------------------------------------------------------------ */

/** Props to spread onto the resize grip. */
export interface ResizeHandleProps {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface GridHeader {
  readonly id: string
  /** Position in the column list, i.e. the index the column virtualizer works in. */
  readonly index: number
  readonly size: number
  /** True while this column is the one being dragged. */
  readonly isResizing: boolean
  readonly resize: ResizeHandleProps
}

export interface ColumnModel {
  readonly headers: readonly GridHeader[]
  /** `headers.map(h => h.size)`, precomputed because the grid needs it twice. */
  readonly widths: readonly number[]
}

/**
 * Resolve every column's rendered width and hand back a resize gesture per column.
 *
 * `sizing` is owned by the caller — the grid resets it to `{}` on a new result
 * set — which keeps this hook free of any lifecycle of its own.
 *
 * ## Pointer events, not mouse events
 *
 * The old grip was `onMouseDown` plus TanStack's window-level move/up listeners.
 * Pointer events cover mouse, pen and touch in one path, and
 * `setPointerCapture` routes every later event for that pointer back to the grip
 * itself — so the drag survives the pointer leaving the 7px strip without any
 * window-level listener to register, tear down, or leak on unmount.
 */
export function useColumnModel(
  columns: readonly GridColumn[],
  sizing: ColumnSizing,
  setSizing: Dispatch<SetStateAction<ColumnSizing>>,
): ColumnModel {
  const resizer = useRef<ColumnResizer | null>(null)
  if (resizer.current === null) resizer.current = new ColumnResizer()
  const gesture = resizer.current

  /** Only the *identity* of the dragged column reaches render, twice per gesture. */
  const [resizingId, setResizingId] = useState<string | null>(null)

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const update = gesture.moveTo(event.pointerId, event.clientX)
      if (!update) return
      setSizing((prev) => applyResize(prev, update))
    },
    [gesture, setSizing],
  )

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (!gesture.end(event.pointerId)) return
      setResizingId(null)
      // Chromium releases capture implicitly on pointerup, so this only matters
      // on the pointercancel path; releasing twice throws and means nothing.
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [gesture],
  )

  return useMemo<ColumnModel>(() => {
    const headers: GridHeader[] = columns.map((column, index) => {
      const size = resolveWidth(column, sizing)
      return {
        id: column.id,
        index,
        size,
        isResizing: resizingId === column.id,
        resize: {
          onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
            if (!gesture.begin(column, event.pointerId, event.clientX, size)) return
            // The grip lives inside the header cell, whose own click sorts the
            // column. Without this, every resize also re-sorts.
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizingId(column.id)
          },
          onPointerMove,
          onPointerUp: onPointerEnd,
          onPointerCancel: onPointerEnd,
        },
      }
    })
    return { headers, widths: headers.map((h) => h.size) }
  }, [columns, sizing, resizingId, gesture, onPointerMove, onPointerEnd])
}
