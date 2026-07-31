import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef as TanstackColumnDef,
  type ColumnSizingState,
} from '@tanstack/react-table'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import type { ColumnDef, ConnId, ResultId, SortSpec } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { getCell, isRowLoaded, setViewport } from '../state/resultCache'
import { useResult } from '../state/useResult'
import { cellClass, cellText, formatCount, formatMs, isExpandable } from '../util/format'
import { GridScrollbar } from './GridScrollbar'
import { ValueModal } from './ValueModal'
import { HEAD_H, ROW_H, VScrollDriver, rowTopIn } from './vscroll'

/* ==================================================================
 * 虚拟化表格 —— renderer 的性能核心。
 *
 * 分工：
 * - TanStack **Table** 只负责列模型（表头、列宽、列宽拖拽）。
 *   刻意不喂 data：百万行结果集若走 getCoreRowModel 会生成百万个 Row 对象，
 *   直接违背"表格无整表驻留"的红线。
 * - TanStack **Virtual** 只留列虚拟化（横轴仍是原生 scrollLeft，零改动）。
 *   行轴改用自研 VScrollDriver，原因见 vscroll.ts 顶部：
 *   spacer 高度会被 Chromium 静默钳到 ~1677 万 px（Retina），
 *   70 万行以后的数据在界面上永远看不到；顺带这也拔掉了 virtual-core 每来一个
 *   chunk 就重建一条 Float64Array(count*2) 的 O(rowCount) 开销。
 * - 单元格取值直接从列式缓存按 (row, col) 下标读，**零拷贝、无中间行对象**。
 * - 行是 memo 组件、单元格是纯 div（不是组件）：可视窗口只有几百个节点；
 *   行高固定 + 分块原点 ⇒ 滚动时行 props 几乎恒定，整片跳过重渲染。
 * ================================================================== */

const GUTTER_W = 54
const COL_OVERSCAN = 3

/** 只用列模型、不喂数据；这个占位类型给泛型一个落点 */
type RowStub = Record<string, never>
const EMPTY_DATA: RowStub[] = []

export interface DataGridProps {
  connId: ConnId
  resultId: ResultId | undefined
  /** 当前排序（table 视图传入，用于列头指示） */
  sort?: SortSpec[] | undefined
  /** 点击列头的回调；不传则列头不可点。必须是稳定引用。 */
  onSortColumn?: ((column: string) => void) | undefined
  /** 没有结果集时的提示语 */
  emptyHint?: string
}

interface CellPos {
  row: number
  col: number
}

export function DataGrid(props: DataGridProps): ReactElement {
  const { connId, resultId, sort, onSortColumn, emptyHint } = props
  const snap = useResult(resultId)
  /** 横向滚动容器（.grid）。纵轴 hidden，所以它只滚 scrollLeft */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * 不随横向滚动移动的浮层容器（.grid-wrap）。
   *
   * 自绘滚动条与覆盖层**必须**挂在这里而不是 .grid 里：.grid 是横向滚动容器，
   * 它的 absolute 后代属于"可滚动内容"，会随 scrollLeft 一起平移
   * （实测 scrollLeft=1000 时 .grid-vsb 的 x 从 [889,900] 变成 [-111,-100]），
   * 再叠加 .grid 的 contain:layout paint 裁切，横向一滚滚动条就既看不见也点不到。
   */
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [sizing, setSizing] = useState<ColumnSizingState>({})
  const [selected, setSelected] = useState<CellPos | null>(null)
  const [expanded, setExpanded] = useState<CellPos | null>(null)

  const schema = snap.schema
  const rowCount = snap.rowCount

  /* --- 纵向滚动驱动器：整个组件生命周期内同一个实例 --- */
  const driverRef = useRef<VScrollDriver | null>(null)
  if (driverRef.current === null) driverRef.current = new VScrollDriver()
  const driver = driverRef.current
  const geom = useSyncExternalStore(driver.subscribe, driver.getSnapshot)
  const [viewportH, setViewportH] = useState(0)

  /* --- 列模型：schema 变了才重建 --- */
  const columns = useMemo<TanstackColumnDef<RowStub>[]>(() => {
    if (!schema) return []
    return schema.map((c, i) => ({
      id: `${i}:${c.name}`,
      header: c.name,
      size: defaultWidth(c),
      minSize: 44,
      maxSize: 1200,
    }))
  }, [schema])

  /**
   * 停止消费某个结果集时，显式补一条 `atBottom=false` 的视口。
   *
   * atBottom 会关掉 ack 背压的行数闸，而它只有这一个上报口。表格一旦不再上报
   * （卸载、换结果集），resultCache 里的视口就冻结在最后一次上报值上；若那次恰好
   * 是 atBottom:true，这条流就再也压不住了——PG 侧的游标与只读事务要一直开到扫完。
   * resultCache 那边还有一道保鲜期兜底（VIEWPORT_FRESH_MS），但那是"最多再跑几秒"，
   * 能当场说清楚的事就不要留给超时。
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

  // 换结果集：清掉用户拖过的列宽、选中态，滚回顶部
  useEffect(() => {
    setSizing({})
    setSelected(null)
    setExpanded(null)
    // 纵向位置只活在驱动器里，绝不能再写 el.scrollTop（那条路已经没有纵向滚动了）
    driver.reset()
    const el = scrollRef.current
    if (el) el.scrollLeft = 0
    // 清理跑在下一个 resultId 之前，闭包里的 resultId 还是**上一个**结果集——正是要撤的那个
    return () => {
      releaseViewport(resultId)
    }
  }, [resultId, driver, releaseViewport])

  const table = useReactTable<RowStub>({
    data: EMPTY_DATA,
    columns,
    state: { columnSizing: sizing },
    onColumnSizingChange: setSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  const headers = table.getFlatHeaders()
  const widths = headers.map((h) => h.getSize())
  const widthKey = widths.join(',')
  let totalWidth = GUTTER_W
  for (const w of widths) totalWidth += w

  /* --- 列虚拟化：横轴仍是原生 scrollLeft，这里一个字节都没改 --- */
  const colVirt = useVirtualizer({
    horizontal: true,
    count: widths.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i],
    overscan: COL_OVERSCAN,
  })

  // 列宽改变后必须重新量，否则 translateX 错位
  useEffect(() => {
    colVirt.measure()
  }, [widthKey, colVirt])

  const virtualCols = colVirt.getVirtualItems()

  /* --- 视口上报：LRU 保护 + ack 背压放行 ---
   * 由驱动器**同步**回调，不再经过 useEffect。
   * 从前那条 useEffect 要等 React commit，于是"背压生效与否"取决于渲染时序：
   * 60 万行 1 秒跑完的场景里 viewport 一直是 null，行数规则从未介入。 */
  const resultIdRef = useRef(resultId)
  resultIdRef.current = resultId
  useLayoutEffect(() => {
    driver.onViewport = (first, last, atBottom): void => {
      setViewport(resultIdRef.current, first, last, atBottom)
    }
    return () => {
      driver.onViewport = null
      // 卸载之后再没有人上报视口了：把 atBottom 这个"放行 ack"的信号交回去
      releaseViewport(resultIdRef.current)
    }
  }, [driver, releaseViewport])

  /* --- 尺寸 / 行数 / dpr 变化都要重算几何 --- */
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

  /* --- wheel 必须手挂：React 把 wheel 注册成 passive，onWheel 里 preventDefault 是空操作 ---
   * 挂在 wrap 上而不是 .grid 上：滚动条与覆盖层已经是 .grid 的兄弟节点，
   * 鼠标停在滚动条上时滚轮事件不会经过 .grid。 */
  useLayoutEffect(() => {
    const el = scrollRef.current
    const wrap = wrapRef.current
    if (!el || !wrap) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) return // 捏合缩放交给浏览器
      const unit = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? Math.max(1, el.clientHeight) : 1
      const dy = e.deltaY * unit
      if (dy === 0) return // 纯横向手势：完全交给原生，保留橡皮筋与惯性
      if (driver.maxTop <= 0) return // 没什么可滚的，别吞事件（滚动链继续往上传）
      e.preventDefault()
      driver.scrollBy(dy)
      // preventDefault 之后原生横向滚动也被取消了，自己补上
      if (e.deltaX !== 0) el.scrollLeft += e.deltaX * unit
    }
    /*
     * 纵向 scrollTop 必须恒为 0。
     *
     * overflow-y:hidden 只是**关掉用户滚动**，元素本身仍有滚动范围：
     * 视口下沿之外的 overscan 行（最多 ~10 行 ≈ 246px，实测）照样算进 scrollHeight。
     * 一旦 Chromium 的 scroll anchoring、focus 自动滚动、或某处 scrollIntoView
     * 把它推离 0，整张表会整体上移且用户没有任何办法滚回来——而且悄无声息。
     * overflow-anchor:none 挡掉第一种，这里的守卫挡掉其余所有种。
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

  /* --- 键盘：overflow-y:hidden 之后原生滚动没了，方向键/翻页/Home/End 全要自己接 --- */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const m = driver.metrics
      const page = Math.max(ROW_H, m.bodyH - ROW_H)
      if (e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
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
    [driver],
  )

  const setSurface = useCallback(
    (node: HTMLDivElement | null): void => {
      driver.surface = node
      driver.paint()
    },
    [driver],
  )

  /* --- 分块原点回写：画布位移与行 top 必须永远出自同一个原点 ---
   * 行是按 geom.origin 排的（见下面的 rowTopIn），而 geom 只在 React 提交之后
   * 才真正落到 DOM 上。所以原点要在这里回写，不能让驱动器自己按最新 snap 猜——
   * 跨 4096 行边界那一帧会错开 98,304px，屏幕直接全白。 */
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

  /* --- 列窗口做成稳定引用：纵向滚动时行组件才能整片 bail out --- */
  const colWindowKey =
    virtualCols.length > 0
      ? `${virtualCols[0].index}:${virtualCols[virtualCols.length - 1].index}:${widthKey}`
      : `empty:${widthKey}`
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

  const closeModal = useCallback(() => {
    setExpanded(null)
  }, [])

  /* --- 覆盖层提示 --- */
  let overlay: string | null = null
  if (!resultId) overlay = emptyHint ?? '尚未执行'
  else if (!schema && snap.status === 'running') overlay = '执行中…'
  else if (rowCount === 0 && snap.status === 'done') overlay = '0 行'

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
        // 只在跨 4096 行边界（origin 变化）时才变 ⇒ memo 照旧整片 bail out
        top={rowTopIn(i, geom.origin)}
        width={totalWidth}
        cols={stableCols}
        dataVersion={isRowLoaded(resultId, i) ? 0 : snap.version}
        selectedCol={selected && selected.row === i ? selected.col : -1}
        onCellClick={handleCellClick}
      />,
    )
  }

  return (
    <>
      {/* 浮层锚点：只有它下面的 .grid 会横向滚动，滚动条与覆盖层不会跟着跑 。
          tabIndex 挂这一层，点滚动条也能保住键盘焦点。 */}
      <div className="grid-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid" ref={scrollRef}>
          {/* 高度恒为 100%：DOM 里再没有任何与 rowCount 相关的尺寸，
              那条 16,777,214px 的墙从根上不存在了 */}
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
                    title={`${col.name} · ${col.nativeType}${col.primaryKey ? ' · 主键' : ''}`}
                  >
                    <span className="cname">{col.name}</span>
                    <span className="ctype">{col.nativeType}</span>
                    {s ? <span className="csort">{s.dir === 'asc' ? '▲' : '▼'}</span> : null}
                    <span
                      className="col-resizer"
                      onMouseDown={header.getResizeHandler()}
                      onClick={stopClick}
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

        {/* 以下两个是 .grid 的**兄弟**，不是后代：它们必须钉在面板上不动 */}
        {overlay !== null ? <div className="grid-overlay">{overlay}</div> : null}

        <GridScrollbar driver={driver} snap={geom} thumbRef={setThumb} />
      </div>

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
/* 行组件：memo + 固定行高 ⇒ 滚动时 props 恒定，直接跳过重渲染             */
/* ------------------------------------------------------------------ */

interface GridRowProps {
  resultId: ResultId | undefined
  schema: readonly ColumnDef[] | null
  rowIndex: number
  top: number
  width: number
  cols: VirtualItem[]
  /** 该行已加载时恒为 0；未加载时跟随结果集 version，等数据到了自动刷新 */
  dataVersion: number
  selectedCol: number
  onCellClick: (row: number, col: number, expand: boolean) => void
}

const GridRow = memo(function GridRow(props: GridRowProps): ReactElement {
  const { resultId, schema, rowIndex, top, width, cols, selectedCol, onCellClick } = props

  // 单元格不挂各自的 handler：事件委托到行，从 data-col 反查列下标
  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const raw = (e.target as HTMLElement).dataset['col']
    if (raw === undefined) return
    const col = Number(raw)
    const value = getCell(resultId, rowIndex, col)
    // 截断值单击即展开（走 valuePeek 拉全量），其余值双击展开
    const expand = isTruncatedValue(value) || (e.detail >= 2 && isExpandable(value))
    onCellClick(rowIndex, col, expand)
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

  return (
    <div
      className={rowIndex % 2 === 1 ? 'grid-row odd' : 'grid-row'}
      style={style}
      onClick={onClick}
    >
      <div className="grid-rownum">{rowIndex + 1}</div>
      {cells}
    </div>
  )
})

/* ------------------------------------------------------------------ */

interface GridFooterProps {
  rowCount: number
  status: string
  elapsedMs: number | undefined
  truncated: boolean
  /** 非 null 表示流已按设计暂停（不是错误） */
  pausedReason: string | null
  evicted: number
}

function GridFooter(p: GridFooterProps): ReactElement {
  return (
    <div className="toolbar" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
      <span className="mono">{formatCount(p.rowCount)} 行</span>
      <span className="sep" />
      <span className={p.status === 'paused' ? 'paused-tag' : undefined}>
        {statusLabel(p.status)}
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
          <span
            className="paused-tag"
            title={`${p.pausedReason}。已加载的行是完整有效的数据；重新执行可继续取数。`}
          >
            已暂停 · 数据有效，重新执行可继续
          </span>
        </>
      ) : null}
      {p.truncated ? (
        <>
          <span className="sep" />
          <span title="达到 maxRows 上限，后面还有数据">已截断</span>
        </>
      ) : null}
      {p.evicted > 0 ? (
        <>
          <span className="sep" />
          <span title="超出 200MB 缓存预算，远端 chunk 已按 LRU 淘汰；滚回去会显示占位符">
            淘汰 {p.evicted} 块
          </span>
        </>
      ) : null}
      <span className="grow" />
    </div>
  )
}

function statusLabel(s: string): string {
  switch (s) {
    case 'running':
      return '接收中…'
    case 'done':
      return '完成'
    case 'paused':
      return '已暂停'
    case 'error':
      return '出错'
    default:
      return '空闲'
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
