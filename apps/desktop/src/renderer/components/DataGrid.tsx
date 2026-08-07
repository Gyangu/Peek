import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import type { ColumnDef, ConnId, ResultId, SortSpec, ViewState } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { tStatic, useT, type TFunction } from '../i18n'
import { notify } from '../state/notifyStore'
import { getCell, isRowLoaded, setViewport } from '../state/resultCache'
import { useResult } from '../state/useResult'
import { copyText } from '../util/clipboard'
import {
  cellClass,
  cellSurfaceClass,
  cellText,
  formatCount,
  formatMs,
  isExpandable,
} from '../util/format'
import { columnMenuNodes } from './columnMenu'
import { Menu } from '../ui/Menu'
import { useContextMenu } from '../ui/useContextMenu'
import {
  ContextMenu,
  EMPTY_SELECTION,
  MAX_SELECTION_SPAN,
  SelectionActionBar,
  applyRowClick,
  isRowSelected,
  selectAllRows,
  selectedIndexes,
  selectionSize,
  type ContextMenuExtraItem,
  type ContextTarget,
  type RowSelection,
} from './context-actions'
import { copyCellPlan, copyRowsPlan, type CopyPlan, type GridCopySource } from './gridCopy'
import {
  columnWindowKey,
  useColumnModel,
  type ColumnSizing,
  type GridColumn,
} from './columnModel'
import { fetchShapeKey } from './views/fetchShape'
import { GridScrollbar } from './GridScrollbar'
import { ValueModal } from './ValueModal'
import { HEAD_H, ROW_H, VScrollDriver, rowTopIn } from './vscroll'

/* ==================================================================
 * The virtualized grid — the performance core of the renderer.
 *
 * Division of labour:
 * - **columnModel.ts** owns the column axis only (headers, widths, resizing).
 *   It replaced TanStack Table, which was being handed `data: []` on purpose —
 *   running a million-row result set through getCoreRowModel would materialize a
 *   million Row objects, breaking the "never hold the whole table in memory"
 *   rule outright. Paying ~106 kB of general-purpose table engine for three
 *   arithmetic operations on the column axis was the rest of the argument; the
 *   details are at the top of columnModel.ts.
 * - TanStack **Virtual** is kept for column virtualization only (the horizontal
 *   axis is still native scrollLeft, untouched). The row axis uses the in-house
 *   VScrollDriver instead; the reason is at the top of vscroll.ts: a spacer's
 *   height is silently clamped by Chromium at ~16.7M px on Retina, so anything
 *   past ~700k rows can never be reached. It also removes virtual-core's
 *   O(rowCount) cost of rebuilding a Float64Array(count*2) on every chunk.
 * - Cell reads go straight into the columnar cache by (row, col) index —
 *   **zero copies, no intermediate row objects**.
 * - Rows are memo components and cells are plain divs (not components), so the
 *   visible window is a few hundred nodes. Fixed row height plus the block origin
 *   keeps row props constant while scrolling, so re-renders are skipped wholesale.
 * ================================================================== */

const GUTTER_W = 54
const COL_OVERSCAN = 3

export interface DataGridProps {
  connId: ConnId
  /**
   * The view this grid belongs to.
   *
   * Required only because of "add this to the chat": a `ChatAttachment` is a
   * descriptor naming a view and a result, so without the view the grid can
   * build no descriptor and the whole gesture is unreachable — which is exactly
   * how the feature shipped inert the first time.
   */
  view: ViewState
  resultId: ResultId | undefined
  /** Current sort (passed by the table view, drives the header indicator). */
  sort?: SortSpec[] | undefined
  /** Header click handler; headers are inert without it. Must be a stable reference. */
  onSortColumn?: ((column: string) => void) | undefined
  /**
   * Set a column's sort outright, rather than advancing the click's cycle.
   *
   * The header menu needs to name each state — in particular "unsorted", which
   * a cycling click can only reach by passing through a sort nobody asked for.
   * Optional for the same reason `onSortColumn` is: a view that cannot sort
   * (a query result, a vector search) passes neither, and the menu then offers
   * only what is always true of a column.
   */
  onSetSort?: ((column: string, dir: 'asc' | 'desc' | null) => void) | undefined
  /** Overlay text shown when there is no result set. Already localized by the caller. */
  emptyHint?: string
}

interface CellPos {
  row: number
  col: number
}

export function DataGrid(props: DataGridProps): ReactElement {
  const { connId, view, resultId, sort, onSortColumn, onSetSort, emptyHint } = props
  const t = useT()
  /**
   * The result the data plane is working on right now — always `props.resultId`.
   *
   * Kept apart from `shownResultId` below because the two answer different
   * questions during a refresh, and both answers have to be right: viewport
   * reporting, LRU protection and ack backpressure all belong to the stream that
   * is actually arriving, while the cells on screen belong to whatever the reader
   * can currently see.
   */
  const liveSnap = useResult(resultId)

  /* ------------------------------------------------------------------
   * The result swap, decided during render
   *
   * Two questions have to be answered before the first paint of a new result,
   * which is why this is render-phase bookkeeping rather than an effect: by the
   * time an effect runs, the blank frame it was meant to prevent has already
   * been shown.
   *
   * 1. **Is this a new question?** `fetchShapeKey` says which fields decide what
   *    comes back; everything else — the result id itself, the status, the
   *    auto-refresh interval — is the same question asked again. A new question
   *    clears the column widths and goes back to the top; the same one keeps the
   *    arrangement the reader made.
   * 2. **What do we show meanwhile?** A new result set starts at zero rows, so
   *    binding to it immediately blanks the grid for the length of the fetch —
   *    tolerable once, a strobe when a timer presses Refresh every five seconds.
   *    The outgoing rows are still in the renderer cache (main keeps 200 result
   *    metas, and `pruneResults` only collects what main has forgotten), so they
   *    stay on screen until the new result has a schema, a row, or a verdict.
   *
   * Held across a same-shape swap only: after a new sort the old rows are an
   * answer to a question nobody is asking, and leaving them up would be a lie.
   * ------------------------------------------------------------------ */
  const shapeKey = fetchShapeKey(view)
  const heldRef = useRef<ResultId | undefined>(undefined)
  const prevRef = useRef<{ shapeKey: string; resultId: ResultId | undefined }>({ shapeKey, resultId })
  /** What the swap was, for the layout effect that has to act on it. */
  const swapRef = useRef<'same' | 'new' | null>(null)

  if (prevRef.current.shapeKey !== shapeKey || prevRef.current.resultId !== resultId) {
    const sameShape = prevRef.current.shapeKey === shapeKey
    swapRef.current = sameShape ? 'same' : 'new'
    heldRef.current = sameShape ? prevRef.current.resultId : undefined
    prevRef.current = { shapeKey, resultId }
  }
  if (
    heldRef.current !== undefined
    && (liveSnap.schema !== undefined || liveSnap.rowCount > 0 || liveSnap.status !== 'running')
  ) {
    heldRef.current = undefined
  }

  const shownResultId = heldRef.current ?? resultId
  const snap = useResult(shownResultId)
  /** The horizontal scroll container (.grid-scroll). Vertical is hidden, so it
   *  only scrolls scrollLeft. */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * The overlay anchor that does not move with horizontal scrolling (.grid-wrap).
   *
   * The custom scrollbar and the overlay **must** live here rather than inside
   * .grid-scroll: it is a horizontal scroll container, so its absolutely
   * positioned descendants count as scrollable content and translate with
   * scrollLeft (measured: at scrollLeft=1000 the .grid-vsb x range moves from
   * [889,900] to [-111,-100]). Add .grid-scroll's `contain: layout paint`
   * clipping on top and a single horizontal scroll makes the scrollbar both
   * invisible and unclickable.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [sizing, setSizing] = useState<ColumnSizing>({})
  const [selected, setSelected] = useState<CellPos | null>(null)
  const [expanded, setExpanded] = useState<CellPos | null>(null)
  /**
   * Rows highlighted for "add these to the chat".
   *
   * Distinct from `selected`, which is a single *cell* and drives the value
   * inspector. Both exist because they answer different questions: the cell is
   * "what am I looking at", the row set is "what do I want to send".
   */
  const [rowSelection, setRowSelection] = useState<RowSelection>(EMPTY_SELECTION)
  const [menu, setMenu] = useState<{ x: number; y: number; cell: CellPos | null } | null>(null)

  const schema = snap.schema
  const rowCount = snap.rowCount

  /* --- Vertical scroll driver: one instance for the component's whole life --- */
  const driverRef = useRef<VScrollDriver | null>(null)
  if (driverRef.current === null) driverRef.current = new VScrollDriver()
  const driver = driverRef.current
  const geom = useSyncExternalStore(driver.subscribe, driver.getSnapshot)
  const [viewportH, setViewportH] = useState(0)

  /* --- Column model: rebuilt only when the schema changes --- */
  const columns = useMemo<GridColumn[]>(() => {
    if (!schema) return []
    // The index is part of the id because a result set may repeat a column name
    // (`SELECT a.id, b.id …`); the name alone would make two columns share one
    // width and one React key.
    return schema.map((c, i) => ({
      id: `${i}:${c.name}`,
      size: defaultWidth(c),
      minSize: 44,
      maxSize: 1200,
    }))
  }, [schema])

  /**
   * Report one last `atBottom=false` viewport when we stop consuming a result set.
   *
   * `atBottom` disables the row-count gate of the ack backpressure, and this
   * component is its only source. Once the grid stops reporting (unmount, or a
   * switch to another result set) the viewport stored in resultCache freezes at
   * whatever came last; if that happened to be `atBottom: true`, the stream can
   * never be held again — the PostgreSQL cursor and its read-only transaction
   * would stay open until the scan finishes. resultCache does have a staleness
   * fallback (VIEWPORT_FRESH_MS), but that only bounds the damage to a few
   * seconds; anything we can state outright should not be left to a timeout.
   */
  const releaseViewport = useCallback(
    (id: ResultId | undefined): void => {
      if (!id) return
      const m = driver.metrics
      const last = m.visibleLast >= m.visibleFirst ? m.visibleLast : m.visibleFirst
      setViewport(id, m.visibleFirst, last, false)
    },
    [driver],
  )

  /**
   * Carry out the swap the render phase decided on.
   *
   * The **same-shape** branch saves the reader's position, because holding the
   * old rows is not always enough to keep it: the moment the new result binds
   * with fewer rows than the old — or with none at all, if the hold has already
   * been released — the driver's `maxTop` shrinks, `commit` clamps `top` against
   * it, and the position is gone. It is saved as a **row index** rather than a
   * pixel offset (rows above may have come and gone) with "was at the bottom"
   * kept separately, because someone parked at the end of an append-only table is
   * following the tail rather than sitting at a row.
   *
   * Row selection is dropped either way. It means "send these rows to the agent",
   * and after a refresh row 7 may be a different row entirely; carrying it over
   * would attach rows nobody looked at.
   *
   * `useLayoutEffect`, and declared **above** the `setGeometry` one: layout
   * effects run in declaration order, and `setGeometry` is what would flatten the
   * position against the new row count before this ever read it. The replay sits
   * on the other side of `setGeometry`, for the mirror-image reason.
   */
  const restoreRef = useRef<{ anchor: number; atBottom: boolean } | null>(null)
  useLayoutEffect(() => {
    const swap = swapRef.current
    swapRef.current = null

    if (swap !== null) {
      setSelected(null)
      setExpanded(null)
      setRowSelection(EMPTY_SELECTION)
      setMenu(null)
    }

    if (swap === 'same') {
      const m = driver.metrics
      restoreRef.current = { anchor: m.visibleFirst, atBottom: m.atBottom }
    } else if (swap === 'new') {
      restoreRef.current = null
      setSizing({})
      // The vertical position lives in the driver alone; never write el.scrollTop —
      // that element has no vertical scrolling any more.
      driver.reset()
      const el = scrollRef.current
      if (el) el.scrollLeft = 0
    }

    // Cleanup runs before the next resultId takes effect, so the captured
    // resultId is still the **previous** result set — exactly the one to release.
    return () => {
      releaseViewport(resultId)
    }
  }, [resultId, shapeKey, driver, releaseViewport])

  const { headers, widths } = useColumnModel(columns, sizing, setSizing)
  const widthKey = widths.join(',')
  let totalWidth = GUTTER_W
  for (const w of widths) totalWidth += w

  /* --- Column virtualization: still native scrollLeft, unchanged --- */
  const colVirt = useVirtualizer({
    horizontal: true,
    count: widths.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i],
    overscan: COL_OVERSCAN,
  })

  // Widths changed: re-measure, or the translateX offsets drift
  useEffect(() => {
    colVirt.measure()
  }, [widthKey, colVirt])

  const virtualCols = colVirt.getVirtualItems()

  /* --- Viewport reporting: LRU protection plus ack release ---
   * The driver calls back **synchronously**; this no longer goes through an
   * effect. The old useEffect had to wait for a React commit, which made
   * "does backpressure engage at all" a function of render timing: with 600k rows
   * arriving in a second the viewport stayed null and the row-count rule never
   * ran once. */
  const resultIdRef = useRef(resultId)
  resultIdRef.current = resultId
  useLayoutEffect(() => {
    driver.onViewport = (first, last, atBottom): void => {
      setViewport(resultIdRef.current, first, last, atBottom)
    }
    return () => {
      driver.onViewport = null
      // Nobody reports the viewport after unmount: hand back `atBottom`, the
      // signal that would otherwise keep acks flowing forever.
      releaseViewport(resultIdRef.current)
    }
  }, [driver, releaseViewport])

  /* --- Geometry has to be recomputed on size, row count or dpr changes --- */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = (): void => setViewportH(el.clientHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    driver.setGeometry(viewportH, rowCount, window.devicePixelRatio || 1)
  }, [driver, viewportH, rowCount])

  /**
   * Replay the position captured above, once the refreshed result has rows to
   * land on.
   *
   * Declared **after** `setGeometry` on purpose: layout effects run in
   * declaration order, and until the driver has been told the new row count its
   * `maxTop` is still 0 — a restore run before it would clamp straight back to
   * the top, which is the very thing being avoided.
   */
  useLayoutEffect(() => {
    const pending = restoreRef.current
    if (!pending || rowCount === 0) return
    restoreRef.current = null
    if (pending.atBottom) driver.scrollTo(driver.maxTop)
    else if (pending.anchor > 0) driver.scrollToRow(Math.min(pending.anchor, rowCount - 1))
  }, [rowCount, driver])

  /* --- wheel must be attached by hand: React registers wheel as passive, so
   * preventDefault inside onWheel is a no-op. It goes on the wrap rather than on
   * .grid-scroll because the scrollbar and the overlay are its siblings — with
   * the pointer over the scrollbar, wheel events never reach .grid-scroll. */
  useLayoutEffect(() => {
    const el = scrollRef.current
    const wrap = wrapRef.current
    if (!el || !wrap) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // pinch zoom belongs to the browser
      const unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? Math.max(1, el.clientHeight) : 1
      const dy = e.deltaY * unit
      if (dy === 0) return // purely horizontal gesture: leave it native, keep rubber-banding and inertia
      if (driver.maxTop <= 0) return // nothing to scroll, do not swallow the event (let it chain up)
      e.preventDefault()
      driver.scrollBy(dy)
      // preventDefault also cancelled the native horizontal scroll; redo it here
      if (e.deltaX !== 0) el.scrollLeft += e.deltaX * unit
    }
    /*
     * scrollTop must stay pinned at 0.
     *
     * `overflow-y: hidden` only takes away *user* scrolling; the element still has
     * a scroll range, because the overscan rows below the viewport (up to ~10 rows
     * ≈ 246px, measured) count towards scrollHeight. If Chromium's scroll
     * anchoring, an automatic focus scroll, or a stray scrollIntoView ever pushes
     * it off 0, the whole table shifts up with no way for the user to get it back
     * — and it does so silently. `overflow-anchor: none` blocks the first case;
     * this guard blocks every other one.
     */
    const onScroll = (): void => {
      if (el.scrollTop !== 0) el.scrollTop = 0
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      wrap.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
    }
  }, [driver])

  /* --- Copying out ---
   * The grid is not text: `body` sets `user-select: none` and the cells never
   * opted out, so there is no native selection for ⌘C to act on and no way to
   * drag-select a value. That is the right call — a drag over cells is the row
   * selection gesture — but it means the copy path has to be built rather than
   * inherited, and until now it simply was not there. See gridCopy.ts. */
  const copySource = useMemo<GridCopySource>(
    () => ({ columns: schema ?? [], read: (row, col) => getCell(shownResultId, row, col) }),
    [schema, shownResultId],
  )

  const runCopy = useCallback((plan: CopyPlan, done: string): void => {
    void navigator.clipboard.writeText(plan.text).then(
      () => {
        // tStatic, not `t`: a toast is worded once, when it is raised.
        notify(
          'info',
          plan.truncated > 0
            ? `${done} ${tStatic('grid.copy.previewOnly', { count: plan.truncated })}`
            : done,
        )
      },
      () => {
        // The clipboard can be refused outright; a button that looks like it
        // worked is worse than a warning that it did not.
        notify('warn', tStatic('grid.copy.failed'))
      },
    )
  }, [])

  const copyRows = useCallback(
    (rows: readonly number[]): void => {
      if (rows.length === 0) return
      runCopy(copyRowsPlan(copySource, rows), tStatic('grid.copy.rowsDone', { count: rows.length }))
    },
    [copySource, runCopy],
  )

  const copyCell = useCallback(
    (row: number, col: number): void => {
      runCopy(copyCellPlan(copySource, row, col), tStatic('grid.copy.cellDone'))
    },
    [copySource, runCopy],
  )

  /* --- Keyboard: with overflow-y hidden there is no native scrolling left, so
   * arrows, page keys, Home and End all have to be handled here --- */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const m = driver.metrics
      const page = Math.max(ROW_H, m.bodyH - ROW_H)
      if (e.key === 'Escape') {
        setRowSelection(EMPTY_SELECTION)
        setMenu(null)
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        // Bounded by the same span the attachment will accept. Selecting a
        // million rows would build a million-entry Set to produce a selection
        // `resolveAttachment` refuses anyway — a gesture that cannot lead
        // anywhere is worse than one that is simply absent.
        if (rowCount > MAX_SELECTION_SPAN) return
        setRowSelection(selectAllRows(rowCount))
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // Rows win over the cell: a row set is something the user built on
        // purpose, while the selected cell is wherever they last clicked to
        // read something. Neither one present means there is nothing to copy,
        // and the event is left alone rather than swallowed.
        const rows = selectedIndexes(rowSelection)
        if (rows.length > 0) copyRows(rows)
        else if (selected !== null) copyCell(selected.row, selected.col)
        else return
      } else if (e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        driver.scrollTo(e.key === 'ArrowUp' ? 0 : m.maxTop)
      } else if (e.key === 'ArrowDown') driver.scrollBy(ROW_H)
      else if (e.key === 'ArrowUp') driver.scrollBy(-ROW_H)
      else if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) driver.scrollBy(page)
      else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) driver.scrollBy(-page)
      else if (e.key === 'Home') driver.scrollTo(0)
      else if (e.key === 'End') driver.scrollTo(m.maxTop)
      else return
      e.preventDefault()
    },
    [driver, rowCount, rowSelection, selected, copyRows, copyCell],
  )

  const setSurface = useCallback(
    (node: HTMLDivElement | null): void => {
      driver.surface = node
      driver.paint()
    },
    [driver],
  )

  /* --- Write the block origin back: the surface transform and the row tops must
   * always come from the same origin. Rows are laid out against geom.origin (see
   * rowTopIn below), and geom only reaches the DOM once React commits. So the
   * origin is reported from here rather than guessed by the driver from its latest
   * snapshot — on the frame that crosses a 4096-row boundary the two would differ
   * by a full block (98,304px) and the screen would go blank. */
  useLayoutEffect(() => {
    driver.syncDomOrigin(geom.origin)
  }, [driver, geom.origin])

  const setThumb = useCallback(
    (node: HTMLDivElement | null): void => {
      driver.thumb = node
      driver.paint()
    },
    [driver],
  )

  /* --- Keep the column window as a stable reference, so row components can bail
   * out wholesale while scrolling vertically --- */
  const colWindowKey = columnWindowKey(virtualCols, widthKey)
  const colsRef = useRef<VirtualItem[]>(virtualCols)
  const colKeyRef = useRef(colWindowKey)
  if (colKeyRef.current !== colWindowKey) {
    colKeyRef.current = colWindowKey
    colsRef.current = virtualCols
  }
  const stableCols = colsRef.current

  const handleCellClick = useCallback((row: number, col: number, expand: boolean) => {
    setSelected({ row, col })
    if (expand) setExpanded({ row, col })
  }, [])

  /**
   * Row selection, from the two gestures a table is expected to have.
   *
   * `gutter` is what separates "I clicked a row number" from "I clicked a cell".
   * A plain click on a cell must not replace the row selection: people click
   * cells constantly to read them, and popping the action bar up every time —
   * or worse, silently discarding a selection they built — makes the feature
   * something to fight. So a plain cell click is inspection only, while the row
   * number is the selection handle and shift/⌘ work from anywhere on the row.
   */
  const handleRowSelect = useCallback(
    (row: number, mods: { shift: boolean; toggle: boolean; gutter: boolean }): void => {
      if (!mods.gutter && !mods.shift && !mods.toggle) return
      setRowSelection((prev) => applyRowClick(prev, row, { shift: mods.shift, toggle: mods.toggle }))
    },
    [],
  )

  const clearRowSelection = useCallback(() => {
    setRowSelection(EMPTY_SELECTION)
  }, [])

  /** The column headers' own menu; the rows' is `menu`/`ContextMenu` below. */
  const headerMenu = useContextMenu<string>()

  const handleRowContextMenu = useCallback((row: number, col: number, x: number, y: number): void => {
    setSelected({ row, col })
    setMenu({ x, y, cell: col < 0 ? null : { row, col } })
  }, [])

  const closeMenu = useCallback(() => {
    setMenu(null)
  }, [])

  const closeModal = useCallback(() => {
    setExpanded(null)
  }, [])

  /* --- Overlay hint --- */
  let overlay: string | null = null
  if (!shownResultId) overlay = emptyHint ?? t('grid.notRun')
  else if (!schema && snap.status === 'running') overlay = t('grid.running')
  else if (rowCount === 0 && snap.status === 'done') overlay = t('grid.noRows')

  const expandedValue = expanded ? getCell(shownResultId, expanded.row, expanded.col) : null
  const expandedColumn = expanded && schema ? (schema[expanded.col] ?? null) : null

  const rows: ReactElement[] = []
  for (let i = geom.renderFirst; i <= geom.renderLast; i += 1) {
    rows.push(
      <GridRow
        key={i}
        resultId={shownResultId}
        schema={schema}
        rowIndex={i}
        // Only changes when the origin does, i.e. every 4096 rows, so memo keeps
        // bailing out wholesale
        top={rowTopIn(i, geom.origin)}
        width={totalWidth}
        cols={stableCols}
        dataVersion={isRowLoaded(shownResultId, i) ? 0 : snap.version}
        selectedCol={selected && selected.row === i ? selected.col : -1}
        // A boolean, not the Set: `GridRow` is memoized on its props, and
        // handing every row the same Set identity would defeat that for the
        // whole window on every selection change.
        rowSelected={isRowSelected(rowSelection, i)}
        onCellClick={handleCellClick}
        onRowSelect={handleRowSelect}
        onRowContextMenu={handleRowContextMenu}
      />,
    )
  }

  /* The clipboard half of the right-click menu. Built here rather than inside
   * `contextActionsFor` because these produce no `ChatAttachment` — see the note
   * on `ContextMenuProps.extraItems`. */
  const copyItems: ContextMenuExtraItem[] = []
  if (menu?.cell) {
    const cell = menu.cell
    copyItems.push({
      id: 'copy-cell',
      label: t('grid.copy.cell'),
      title: t('grid.copy.cellTitle'),
      onSelect: () => {
        copyCell(cell.row, cell.col)
      },
    })
  }
  const selectedRowIndexes = selectedIndexes(rowSelection)
  if (selectedRowIndexes.length > 0) {
    copyItems.push({
      id: 'copy-rows',
      label: t('grid.copy.rows', { count: selectedRowIndexes.length }),
      title: t('grid.copy.rowsTitle'),
      onSelect: () => {
        copyRows(selectedRowIndexes)
      },
    })
  }

  const contextTarget: ContextTarget = {
    view,
    ...(shownResultId === undefined ? {} : { resultId: shownResultId }),
    ...(selectionSize(rowSelection) > 0 ? { selectedRows: selectedIndexes(rowSelection) } : {}),
    ...(menu?.cell && schema?.[menu.cell.col]
      ? { cell: { rowIndex: menu.cell.row, column: schema[menu.cell.col].name } }
      : {}),
    rowCount,
  }

  return (
    <>
      {/* Overlay anchor: only the .grid-scroll inside it scrolls horizontally, so the
          scrollbar and the overlay stay put. **Not scrollable**, and for a table
          with more columns than fit — the normal case for a database viewer —
          that had to be structural rather than a z-index; the measurements are
          on wrapRef above. tabIndex sits on this level so that clicking the
          scrollbar keeps keyboard focus.

          The `grid-*` names below survive alongside their utilities, and that is
          not leftovers. A utility says what a node looks like; it cannot say
          *which* node it is, and each of these four is addressed by that
          identity from outside this file: base.css draws the grid's focus ring
          through `.layout-root .grid-wrap:focus-visible`, grid-layout.test.ts
          guards who is whose descendant by name, and PLAN §8's acceptance run
          counts `.grid-surface`'s children on a real machine.

          All four are `grid-`-prefixed, and the prefix is load-bearing. The
          scroll container below was plain `grid` until it was measured: `grid`
          is also a live Tailwind utility, grid.css is unlayered, and unlayered
          beats layered — so the rule meant for *this* node was landing on every
          element that wore `grid` meaning `display: grid`. Migration record
          §12.9. An identity name must never be a bare utility name. */}
      <div
        className="grid-wrap relative flex flex-1 min-h-0 min-w-0 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div
          className="grid-scroll relative flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden overscroll-y-contain overflow-anchor-none bg-bg contain-layout contain-paint outline-none"
          ref={scrollRef}
        >
          {/* Height is always 100%: no dimension in the DOM is derived from
              rowCount any more, so the 16,777,214px wall simply does not exist */}
          <div className="grid-inner relative h-full" style={{ width: totalWidth }}>
            <div
              className="sticky top-0 z-4 h-head bg-bg-2 shadow-rule-b-strong"
              style={{ width: totalWidth }}
            >
              <div className="sticky left-0 z-5 inline-block align-top w-gutter h-head bg-bg-2 shadow-rule-r-strong" />
              {stableCols.map((vc) => {
                const header = headers[vc.index]
                const col = schema ? schema[vc.index] : undefined
                if (!header || !col) return null
                const s = sort?.find((x) => x.column === col.name)
                return (
                  <div
                    key={header.id}
                    className="absolute top-0 h-head flex items-center gap-tight px-cell shadow-rule-r text-fg-dim text-micro overflow-hidden whitespace-nowrap hover:text-fg hover:bg-bg-3"
                    style={{ left: GUTTER_W + vc.start, width: vc.size }}
                    onClick={onSortColumn ? () => onSortColumn(col.name) : undefined}
                    onContextMenu={headerMenu.open(col.name)}
                    title={
                      col.primaryKey
                        ? t('grid.columnTitlePk', { name: col.name, type: col.nativeType })
                        : t('grid.columnTitle', { name: col.name, type: col.nativeType })
                    }
                  >
                    {/* One class for the same three declarations: `truncate` is
                        overflow-hidden plus the ellipsis plus a `white-space:
                        nowrap` this span already inherits from the header cell,
                        so the computed style is unchanged. */}
                    <span className="truncate">{col.name}</span>
                    <span className="text-fg-faint text-micro flex-none">{col.nativeType}</span>
                    {s ? (
                      <span className="text-accent flex-none">{s.dir === 'asc' ? '▲' : '▼'}</span>
                    ) : null}
                    {/* The 7px drag bar. `opacity-70` is unconditional and that
                        is not a shortcut: at rest the bar has no background at
                        all, and 70% of nothing is nothing — so the alpha only
                        ever applies to the accent it wears while hovered or
                        dragged, which is what it always meant. Stating it once
                        also keeps it a single entry in the ALPHA_SITES census;
                        restating the same alpha under a hover variant, beside
                        the plain `opacity-70`, would be one fact filed twice.
                        (Written that way round on purpose: the hover spelling
                        does not appear on any element, and a comment naming it
                        would mint a rule nobody wears — see
                        `scripts/audit-shipped-css.mjs`.) */}
                    <span
                      className={
                        header.isResizing
                          ? 'absolute -right-0.75 top-0 w-1.75 h-full cursor-col-resize z-6 opacity-70 bg-accent'
                          : 'absolute -right-0.75 top-0 w-1.75 h-full cursor-col-resize z-6 opacity-70 hover:bg-accent'
                      }
                      onClick={stopClick}
                      {...header.resize}
                    />
                  </div>
                )
              })}
            </div>

            {/* Height 0, so it contributes nothing to any scroll dimension; the
                driver writes its transform once per frame (magnitude < 98,304px,
                composited, no layout and no repaint). */}
            <div className="grid-surface absolute top-0 left-0 w-0 h-0 will-change-transform" ref={setSurface}>
              {rows}
            </div>
          </div>
        </div>

        {/* The next three are **siblings** of .grid-scroll, not descendants: they have to
            stay pinned to the panel. The action bar is `position: absolute`, so
            inside .grid-scroll it would slide away with scrollLeft exactly as the
            scrollbar once did. */}
        {overlay !== null ? (
          <div className="grid-overlay absolute inset-0 flex items-center justify-center text-fg-faint pointer-events-none">
            {overlay}
          </div>
        ) : null}

        <SelectionActionBar
          viewId={view.id}
          resultId={shownResultId}
          selection={rowSelection}
          onClear={clearRowSelection}
        />

        <GridScrollbar driver={driver} snap={geom} thumbRef={setThumb} />
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          target={contextTarget}
          onClose={closeMenu}
          extraItems={copyItems}
        />
      ) : null}

      {/* The header's menu is a different menu on a different subject: the rows'
          one is about *this data*, and offers to send it somewhere; this one is
          about the column as a thing to order and name. Sharing one menu would
          mean a target union whose two halves have nothing in common. */}
      {headerMenu.state ? (
        <Menu
          label={t('menu.column.label')}
          at={headerMenu.state.at}
          nodes={columnMenuNodes(
            headerMenu.state.payload,
            sort,
            t,
            {
              setSort: (dir) => {
                onSetSort?.(headerMenu.state?.payload ?? '', dir)
              },
              copyName: () => {
                copyText(headerMenu.state?.payload ?? '')
              },
            },
            { sortable: onSetSort !== undefined },
          )}
          onClose={headerMenu.close}
        />
      ) : null}

      {/* The footer follows the **live** stream while the held rows are still on
          screen: "running" is the true answer to "what is happening", and saying
          "done" because the rows you can see finished a moment ago would make a
          refresh invisible. */}
      <GridFooter
        rowCount={rowCount}
        status={liveSnap.status}
        elapsedMs={liveSnap.done?.elapsedMs}
        truncated={liveSnap.done?.truncated === true}
        pausedReason={liveSnap.paused?.message ?? null}
        evicted={snap.evictedChunks}
      />

      {expanded && expandedColumn ? (
        <ValueModal
          connId={connId}
          resultId={shownResultId}
          row={expanded.row}
          col={expanded.col}
          column={expandedColumn}
          value={expandedValue}
          onClose={closeModal}
        />
      ) : null}
    </>
  )
}

function stopClick(e: ReactMouseEvent): void {
  e.stopPropagation()
}

/* ------------------------------------------------------------------ */
/* Row component: memo plus a fixed row height means props stay constant   */
/* while scrolling, so re-renders are skipped entirely.                    */
/* ------------------------------------------------------------------ */

interface GridRowProps {
  resultId: ResultId | undefined
  schema: readonly ColumnDef[] | null
  rowIndex: number
  top: number
  width: number
  cols: VirtualItem[]
  /** 0 once the row is loaded; otherwise it tracks the result version, so the
   *  row refreshes by itself when its data arrives. */
  dataVersion: number
  selectedCol: number
  /** Part of the row set staged for "add these to the chat". */
  rowSelected: boolean
  onCellClick: (row: number, col: number, expand: boolean) => void
  onRowSelect: (row: number, mods: { shift: boolean; toggle: boolean; gutter: boolean }) => void
  /** `col` is -1 when the pointer was over the row-number gutter. */
  onRowContextMenu: (row: number, col: number, x: number, y: number) => void
}

const GridRow = memo(function GridRow(props: GridRowProps): ReactElement {
  const {
    resultId,
    schema,
    rowIndex,
    top,
    width,
    cols,
    selectedCol,
    rowSelected,
    onCellClick,
    onRowSelect,
    onRowContextMenu,
  } = props

  // Cells carry no handlers of their own: the event is delegated to the row and
  // the column index is read back off data-col
  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const gutter = (e.target as HTMLElement).dataset['gutter'] !== undefined
    onRowSelect(rowIndex, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey, gutter })
    const raw = (e.target as HTMLElement).dataset['col']
    if (raw === undefined) return
    const col = Number(raw)
    const value = getCell(resultId, rowIndex, col)
    // A truncated value expands on a single click (fetching the rest via
    // valuePeek); everything else expands on a double click. A modified click is
    // a selection gesture, never an expand — otherwise ⌘-clicking to build a
    // row set keeps opening the value modal.
    const modified = e.shiftKey || e.metaKey || e.ctrlKey
    const expand = !modified && (isTruncatedValue(value) || (e.detail >= 2 && isExpandable(value)))
    onCellClick(rowIndex, col, expand)
  }

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const raw = (e.target as HTMLElement).dataset['col']
    onRowContextMenu(rowIndex, raw === undefined ? -1 : Number(raw), e.clientX, e.clientY)
  }

  const style: CSSProperties = {
    transform: `translateY(${top}px)`,
    width,
    height: ROW_H,
  }

  const odd = rowIndex % 2 === 1

  // One background for the whole row, computed once; the focused cell is the
  // only one that differs, and it differs by replacing this rather than by
  // layering over it. See cellSurfaceClass in util/format.ts.
  const rowSurface = cellSurfaceClass(odd, rowSelected, false)
  const selectedSurface = cellSurfaceClass(odd, rowSelected, true)

  const cells: ReactElement[] = []
  for (const vc of cols) {
    const value = getCell(resultId, rowIndex, vc.index)
    const logical = schema ? schema[vc.index]?.logical : undefined
    const base = cellClass(value, logical)
    cells.push(
      <div
        key={vc.index}
        className={`${base} ${vc.index === selectedCol ? selectedSurface : rowSurface}`}
        data-col={vc.index}
        style={{ left: GUTTER_W + vc.start, width: vc.size }}
      >
        {cellText(value)}
      </div>,
    )
  }

  return (
    <div
      className={ROW_CLASS}
      style={style}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* `data-gutter` is what tells a plain click "this is a selection", the
          same delegation trick `data-col` uses for cells. */}
      <div
        className={rowSelected ? ROWNUM_SELECTED_CLASS : ROWNUM_CLASS}
        data-gutter=""
        title={ROWNUM_TITLE}
      >
        {rowIndex + 1}
      </div>
      {cells}
    </div>
  )
})

/**
 * The row, the gutter, and the gutter again while the row is staged for the
 * chat. Three complete strings, not a base plus a patch — see the note above
 * `cellSurfaceClass`, which is the same argument for the cells.
 *
 * `group` is the only thing on the row that is not the row's own appearance: it
 * is what lets a cell say "while the row I am in is hovered", which used to be
 * `.grid-row:hover .grid-cell` and is now a variant on the cell. `grid-row`
 * itself stays a real selector — one declaration is still in components/grid.css
 * and cannot be anything else. The row's height is deliberately stated twice,
 * once here and once as an inline pixel value from `ROW_H`: both resolve to
 * --spacing-row, which is what vscroll.ts does its arithmetic in.
 */
const ROW_CLASS = 'grid-row group absolute top-0 left-0 block h-row whitespace-nowrap'

const ROWNUM_CLASS = 'grid-rownum sticky left-0 z-2 inline-block align-top w-gutter h-row leading-row pr-control-x text-right font-mono text-micro text-fg-faint bg-bg-1 shadow-rule-r overflow-hidden cursor-pointer'

/* Hue and shape, and the shape is the half that survives a colour-vision
   difference: --shadow-gutter-sel is a 2px accent rule down the one column that
   is still on screen however far right a wide table is scrolled. Inset, so it
   costs no layout — a left border would eat 2px out of the 54px gutter and shove
   the number sideways. */
const ROWNUM_SELECTED_CLASS = 'grid-rownum sticky left-0 z-2 inline-block align-top w-gutter h-row leading-row pr-control-x text-right font-mono text-micro text-accent bg-rownum-sel shadow-gutter-sel overflow-hidden cursor-pointer'

/**
 * Tooltip on the row number.
 *
 * Key notation only, and identical in every language — the same rule the query
 * editor's shortcut hints follow. It is the one place the selection gesture is
 * discoverable without trying it.
 */
const ROWNUM_TITLE = 'click · ⇧ range · ⌘/ctrl toggle'

/* ------------------------------------------------------------------ */

interface GridFooterProps {
  rowCount: number
  status: string
  elapsedMs: number | undefined
  truncated: boolean
  /** Non-null means the stream paused by design (not an error). */
  pausedReason: string | null
  evicted: number
}

function GridFooter(p: GridFooterProps): ReactElement {
  const t = useT()
  return (
    /*
     * The same strip as a view's toolbar, with the rule on the other edge — it
     * closes the grid rather than opening it.
     *
     * The two borders were an inline `style` here until this round, and the note
     * that stood in this place said why: the strip was a named rule in an
     * unlayered sheet declaring a bottom border, an unlayered rule outranks every
     * `@layer`, so a top border written as a utility would have lost silently and
     * this footer would have kept a line under it and gained none above. Inline
     * was the only writing that won the argument.
     *
     * The strip is a class list now, so this element states its own edge and the
     * argument is over. Nothing above this footer changed: the grid's row
     * geometry is computed in `vscroll.ts` from the row height, and a pixel lost
     * here would accumulate over a million rows.
     */
    <div className="flex h-bar flex-none items-center gap-tight overflow-hidden shadow-rule-t bg-bg-1 px-snug text-fg-dim">
      {/* `count` selects the plural form, `rows` carries the grouped number —
          t() never formats numbers itself. */}
      <span className="font-mono tabular-nums">{t('grid.rows', { count: p.rowCount, rows: formatCount(p.rowCount) })}</span>
      <span className="h-divider w-px flex-none bg-border-strong" />
      <span className={p.status === 'paused' ? 'text-warn' : undefined}>
        {statusLabel(t, p.status)}
      </span>
      {p.elapsedMs !== undefined ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          <span className="font-mono tabular-nums">{formatMs(p.elapsedMs)}</span>
        </>
      ) : null}
      {p.pausedReason !== null ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          {/* The reason comes from main and is canonical English, the same text
              MCP reads; only the sentence around it is localized. */}
          <span className="text-warn" title={t('grid.pausedTitle', { reason: p.pausedReason })}>
            {t('grid.paused')}
          </span>
        </>
      ) : null}
      {p.truncated ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          <span title={t('grid.truncatedTitle')}>{t('grid.truncated')}</span>
        </>
      ) : null}
      {p.evicted > 0 ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          <span title={t('grid.evictedTitle')}>{t('grid.evicted', { count: p.evicted })}</span>
        </>
      ) : null}
      <span className="flex-1" />
    </div>
  )
}

function statusLabel(t: TFunction, s: string): string {
  switch (s) {
    case 'running':
      return t('grid.status.running')
    case 'done':
      return t('grid.status.done')
    case 'paused':
      return t('grid.status.paused')
    case 'error':
      return t('grid.status.error')
    default:
      return t('grid.status.idle')
  }
}

/* ------------------------------------------------------------------ */

function defaultWidth(c: ColumnDef): number {
  const byName = Math.min(280, c.name.length * 7 + 46)
  switch (c.logical) {
    case 'boolean':
      return Math.max(66, byName)
    case 'number':
      return Math.max(96, byName)
    case 'bigint':
      return Math.max(110, byName)
    case 'date':
      return Math.max(104, byName)
    case 'time':
      return Math.max(96, byName)
    case 'timestamp':
      return Math.max(172, byName)
    case 'uuid':
      return Math.max(250, byName)
    case 'json':
    case 'array':
    case 'vector':
    case 'geo':
      return Math.max(240, byName)
    case 'bytes':
      return Math.max(160, byName)
    default:
      return Math.max(150, byName)
  }
}

export { HEAD_H, ROW_H }
