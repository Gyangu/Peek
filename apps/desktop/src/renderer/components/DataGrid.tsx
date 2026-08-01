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
import { useT, type TFunction } from '../i18n'
import { getCell, isRowLoaded, setViewport } from '../state/resultCache'
import { useResult } from '../state/useResult'
import { cellClass, cellText, formatCount, formatMs, isExpandable } from '../util/format'
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
  type ContextTarget,
  type RowSelection,
} from './context-actions'
import {
  columnWindowKey,
  useColumnModel,
  type ColumnSizing,
  type GridColumn,
} from './columnModel'
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
  /** Overlay text shown when there is no result set. Already localized by the caller. */
  emptyHint?: string
}

interface CellPos {
  row: number
  col: number
}

export function DataGrid(props: DataGridProps): ReactElement {
  const { connId, view, resultId, sort, onSortColumn, emptyHint } = props
  const t = useT()
  const snap = useResult(resultId)
  /** The horizontal scroll container (.grid). Vertical is hidden, so it only scrolls scrollLeft. */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * The overlay anchor that does not move with horizontal scrolling (.grid-wrap).
   *
   * The custom scrollbar and the overlay **must** live here rather than inside
   * .grid: .grid is a horizontal scroll container, so its absolutely positioned
   * descendants count as scrollable content and translate with scrollLeft
   * (measured: at scrollLeft=1000 the .grid-vsb x range moves from [889,900] to
   * [-111,-100]). Add .grid's `contain: layout paint` clipping on top and a single
   * horizontal scroll makes the scrollbar both invisible and unclickable.
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

  // New result set: drop the widths the user dragged and the selection, scroll to top
  useEffect(() => {
    setSizing({})
    setSelected(null)
    setExpanded(null)
    // Row indexes address positions in *this* result set. Carrying them into the
    // next one would attach rows the user never looked at.
    setRowSelection(EMPTY_SELECTION)
    setMenu(null)
    // The vertical position lives in the driver alone; never write el.scrollTop —
    // that element has no vertical scrolling any more.
    driver.reset()
    const el = scrollRef.current
    if (el) el.scrollLeft = 0
    // Cleanup runs before the next resultId takes effect, so the captured resultId
    // is still the **previous** result set — exactly the one to release.
    return () => {
      releaseViewport(resultId)
    }
  }, [resultId, driver, releaseViewport])

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

  /* --- wheel must be attached by hand: React registers wheel as passive, so
   * preventDefault inside onWheel is a no-op. It goes on the wrap rather than on
   * .grid because the scrollbar and the overlay are .grid's siblings — with the
   * pointer over the scrollbar, wheel events never reach .grid. */
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
    [driver, rowCount],
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
  if (!resultId) overlay = emptyHint ?? t('grid.notRun')
  else if (!schema && snap.status === 'running') overlay = t('grid.running')
  else if (rowCount === 0 && snap.status === 'done') overlay = t('grid.noRows')

  const expandedValue = expanded ? getCell(resultId, expanded.row, expanded.col) : null
  const expandedColumn = expanded && schema ? (schema[expanded.col] ?? null) : null

  const rows: ReactElement[] = []
  for (let i = geom.renderFirst; i <= geom.renderLast; i += 1) {
    rows.push(
      <GridRow
        key={i}
        resultId={resultId}
        schema={schema}
        rowIndex={i}
        // Only changes when the origin does, i.e. every 4096 rows, so memo keeps
        // bailing out wholesale
        top={rowTopIn(i, geom.origin)}
        width={totalWidth}
        cols={stableCols}
        dataVersion={isRowLoaded(resultId, i) ? 0 : snap.version}
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

  const contextTarget: ContextTarget = {
    view,
    ...(resultId === undefined ? {} : { resultId }),
    ...(selectionSize(rowSelection) > 0 ? { selectedRows: selectedIndexes(rowSelection) } : {}),
    ...(menu?.cell && schema?.[menu.cell.col]
      ? { cell: { rowIndex: menu.cell.row, column: schema[menu.cell.col].name } }
      : {}),
    rowCount,
  }

  return (
    <>
      {/* Overlay anchor: only the .grid inside it scrolls horizontally, so the
          scrollbar and the overlay stay put. tabIndex sits on this level so that
          clicking the scrollbar keeps keyboard focus. */}
      <div className="grid-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid" ref={scrollRef}>
          {/* Height is always 100%: no dimension in the DOM is derived from
              rowCount any more, so the 16,777,214px wall simply does not exist */}
          <div className="grid-inner" style={{ width: totalWidth }}>
            <div className="grid-head" style={{ width: totalWidth }}>
              <div className="grid-corner" />
              {stableCols.map((vc) => {
                const header = headers[vc.index]
                const col = schema ? schema[vc.index] : undefined
                if (!header || !col) return null
                const s = sort?.find((x) => x.column === col.name)
                return (
                  <div
                    key={header.id}
                    className="grid-head-cell"
                    style={{ left: GUTTER_W + vc.start, width: vc.size }}
                    onClick={onSortColumn ? () => onSortColumn(col.name) : undefined}
                    title={
                      col.primaryKey
                        ? t('grid.columnTitlePk', { name: col.name, type: col.nativeType })
                        : t('grid.columnTitle', { name: col.name, type: col.nativeType })
                    }
                  >
                    <span className="cname">{col.name}</span>
                    <span className="ctype">{col.nativeType}</span>
                    {s ? <span className="csort">{s.dir === 'asc' ? '▲' : '▼'}</span> : null}
                    <span
                      className={header.isResizing ? 'col-resizer active' : 'col-resizer'}
                      onClick={stopClick}
                      {...header.resize}
                    />
                  </div>
                )
              })}
            </div>

            <div className="grid-surface" ref={setSurface}>
              {rows}
            </div>
          </div>
        </div>

        {/* The next three are **siblings** of .grid, not descendants: they have to
            stay pinned to the panel. The action bar is `position: absolute`, so
            inside .grid it would slide away with scrollLeft exactly as the
            scrollbar once did. */}
        {overlay !== null ? <div className="grid-overlay">{overlay}</div> : null}

        <SelectionActionBar
          viewId={view.id}
          resultId={resultId}
          selection={rowSelection}
          onClear={clearRowSelection}
        />

        <GridScrollbar driver={driver} snap={geom} thumbRef={setThumb} />
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} target={contextTarget} onClose={closeMenu} /> : null}

      <GridFooter
        rowCount={rowCount}
        status={snap.status}
        elapsedMs={snap.done?.elapsedMs}
        truncated={snap.done?.truncated === true}
        pausedReason={snap.paused?.message ?? null}
        evicted={snap.evictedChunks}
      />

      {expanded && expandedColumn ? (
        <ValueModal
          connId={connId}
          resultId={resultId}
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

  const cells: ReactElement[] = []
  for (const vc of cols) {
    const value = getCell(resultId, rowIndex, vc.index)
    const logical = schema ? schema[vc.index]?.logical : undefined
    const base = cellClass(value, logical)
    cells.push(
      <div
        key={vc.index}
        className={vc.index === selectedCol ? `${base} selected` : base}
        data-col={vc.index}
        style={{ left: GUTTER_W + vc.start, width: vc.size }}
      >
        {cellText(value)}
      </div>,
    )
  }

  const rowClass =
    (rowIndex % 2 === 1 ? 'grid-row odd' : 'grid-row') + (rowSelected ? ' row-selected' : '')

  return (
    <div className={rowClass} style={style} onClick={onClick} onContextMenu={onContextMenu}>
      {/* `data-gutter` is what tells a plain click "this is a selection", the
          same delegation trick `data-col` uses for cells. */}
      <div className="grid-rownum" data-gutter="" title={ROWNUM_TITLE}>
        {rowIndex + 1}
      </div>
      {cells}
    </div>
  )
})

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
    <div className="toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
      {/* `count` selects the plural form, `rows` carries the grouped number —
          t() never formats numbers itself. */}
      <span className="mono">{t('grid.rows', { count: p.rowCount, rows: formatCount(p.rowCount) })}</span>
      <span className="sep" />
      <span className={p.status === 'paused' ? 'paused-tag' : undefined}>
        {statusLabel(t, p.status)}
      </span>
      {p.elapsedMs !== undefined ? (
        <>
          <span className="sep" />
          <span className="mono">{formatMs(p.elapsedMs)}</span>
        </>
      ) : null}
      {p.pausedReason !== null ? (
        <>
          <span className="sep" />
          {/* The reason comes from main and is canonical English, the same text
              MCP reads; only the sentence around it is localized. */}
          <span className="paused-tag" title={t('grid.pausedTitle', { reason: p.pausedReason })}>
            {t('grid.paused')}
          </span>
        </>
      ) : null}
      {p.truncated ? (
        <>
          <span className="sep" />
          <span title={t('grid.truncatedTitle')}>{t('grid.truncated')}</span>
        </>
      ) : null}
      {p.evicted > 0 ? (
        <>
          <span className="sep" />
          <span title={t('grid.evictedTitle')}>{t('grid.evicted', { count: p.evicted })}</span>
        </>
      ) : null}
      <span className="grow" />
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
