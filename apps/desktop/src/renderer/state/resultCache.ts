import type {
  ChunkDone,
  ChunkFrame,
  ColumnDef,
  ConnId,
  PeekError,
  ResultId,
  ResultPause,
  ResultStreamAck,
  ResultStreamMessage,
} from '@peek/core'
import { RESULT_CACHE_MAX_BYTES, isTruncatedValue, peekError } from '@peek/core'

/* ====================================================================
 * 结果集缓存：数据面的落点。
 *
 * 设计要点（PLAN 第 8 节红线）：
 * - **列式原样保留**：chunk 帧里的 cols 数组直接持有，不做列转行、不做拷贝。
 *   取值按 (row, col) 二分定位 chunk 后直接下标访问，O(log n) 且零分配。
 * - **LRU 淘汰**：总字节超过 ~200MB 时，按 touched 时间淘汰远离视口的 chunk。
 *   被淘汰的 chunk 只丢数据、保留 startRow/rowCount 元信息，行号映射不会错位。
 * - **ack 背压**：每帧落地即 ack；缓存逼近上限或视口远远落后时压住 ack，
 *   host 侧未确认帧达到 ACK_WINDOW 就会自动停拉。
 * - 这是**纯 TS 模块，不是 React 状态**。组件通过 useSyncExternalStore 订阅，
 *   chunk 到达只 bump 一个版本号（rAF 合帧），不重建任何数据结构。
 * ==================================================================== */

/** 超过这个水位开始淘汰 */
const EVICT_HIGH_WATER = Math.floor(RESULT_CACHE_MAX_BYTES * 0.85)
/** 淘汰到这个水位为止 */
const EVICT_TARGET = Math.floor(RESULT_CACHE_MAX_BYTES * 0.7)
/**
 * 淘汰之后仍然超过这个水位就压住 ack。
 *
 * **不要把它当成通用兜底**。判定发生在 enforceBudget 之后，而 enforceBudget 每帧
 * 都会把总量压回 EVICT_TARGET（140MB），所以它只在"淘汰腾不出空间"时才响——
 * 也就是**受保护集（视口 ±VIEWPORT_MARGIN_ROWS 行）自己就超过 180MB**。
 * 驱动侧单格超 VALUE_PREVIEW_BYTES(4KB) 一律截断成预览，因此这需要很宽的行：
 * 40 列 × 4KB 预览 ≈ 324KB/行，几百行就能撞上（resultCache.test.ts 里按这个
 * 真实约束构造）；而常见的窄表几千行连零头都到不了。
 * 结论：字节闸只管"宽行撑爆受保护集"这一种情形，
 * "视口不再推进"必须由下面的行数闸负责，不能指望它来兜。
 */
const ACK_HOLD_BYTES = Math.floor(RESULT_CACHE_MAX_BYTES * 0.9)
/** 视口前方最多预留这么多行，超出就压住 ack（滚动时会自动放行） */
const AHEAD_ROWS = 200_000
/** 视口上下各保护这么多行不被淘汰 */
const VIEWPORT_MARGIN_ROWS = 3000
/**
 * atBottom 的保鲜期：超过这么久没有新的视口上报，就不再相信"视口贴在末端"。
 *
 * atBottom 会关掉行数闸（理由见 Viewport.atBottom），所以它必须是**会自己失效的信号**，
 * 不能是只进不出的闩：表格卸载（onViewport 置 null）、渲染进程被 backgroundThrottling
 * 掐掉 rAF、主线程长时间卡死——这三种情况下上报都会停，而 entry.viewport 会永远冻结在
 * 最后一次上报值。若那一次恰好是 atBottom:true，孤儿流就会全速扫完整张表
 * （内存有 LRU 兜底，但 PG 侧的 READ ONLY 事务与游标要一直开到扫完）。
 *
 * 取值理由：真正活着的表格每来一批数据就会重算几何并同步上报（rAF 级，~16ms），
 * 3 秒的余量足够扛住 GC 抖动与一次长任务；而且"上报新鲜的 atBottom"本身就意味着
 * vp.end ≈ rowCount，行数闸对它是恒不成立的——所以这条规则只可能压住已经停止消费的流，
 * 不会误伤正在看数据的人。
 */
const VIEWPORT_FRESH_MS = 3_000

export type CacheStatus = 'idle' | 'running' | 'done' | 'paused' | 'error'

/** 单元格未加载（尚未到达 / 已被 LRU 淘汰）的哨兵值 */
export const PENDING_CELL = Symbol('peek.pendingCell')

export function isPendingCell(v: unknown): boolean {
  return v === PENDING_CELL
}

interface ChunkSlot {
  seq: number
  /** 结果集内的全局起始行号 */
  startRow: number
  rowCount: number
  /** 列式数据本体；null 表示已被 LRU 淘汰 */
  cols: unknown[][] | null
  bytes: number
  /** LRU 时间戳（全局单调计数） */
  touched: number
  owner: ResultEntry
}

interface Viewport {
  start: number
  end: number
  /**
   * 视口已经贴到可滚动范围的**末端**，再往前推不动了。
   *
   * 这是 ack 背压的兜底信号：`rowCount - end > AHEAD_ROWS` 这条规则的前提是
   * "视口还能往前走，只是用户没走"。一旦视口物理上到顶（全部内容都装得下、
   * 或已经滚到最后一行），继续按行数压 ack 就是**把流饿死**——谁也没法再推进它。
   *
   * 只有**新鲜**的 atBottom 才作数（见 VIEWPORT_FRESH_MS / isAtBottomNow）：
   * 一份陈旧的 atBottom:true 等于把背压整个关掉，那不是降级而是失效。
   */
  atBottom: boolean
  /** 这条视口是什么时候上报的（Date.now）；atBottom 的保鲜判定用它 */
  at: number
}

/**
 * 结果集建立时的保守默认视口。
 *
 * 早先 viewport 初值是 null，而 shouldHoldAck 对 null 直接跳过行数规则，于是
 * "背压压不压得住"完全取决于 React 什么时候把表格渲染出来并上报视口——
 * 60 万行 1 秒跑完的场景里背压从未介入，只剩 180MB 字节水位一道兜底。
 * 给一个确定的初值之后，"什么时候压、压在哪"只取决于 rowCount，可预测可测试。
 */
const DEFAULT_VIEWPORT: Viewport = { start: 0, end: 0, atBottom: false, at: 0 }

interface ResultEntry {
  id: ResultId
  connId: ConnId | null
  schema: ColumnDef[] | null
  chunks: ChunkSlot[]
  rowCount: number
  bytes: number
  status: CacheStatus
  done: ChunkDone | null
  error: PeekError | null
  paused: ResultPause | null
  version: number
  nextSeq: number
  evictedChunks: number
  firstFrameAt: number
  lastHit: number
  /** 永远非 null（建立时给 DEFAULT_VIEWPORT），背压行为因此与渲染时序解耦 */
  viewport: Viewport
  port: MessagePort | null
  /** 被背压压住、等待放行的 ack seq */
  heldAck: number | null
  snapshot: ResultSnapshot | null
}

export interface ResultSnapshot {
  readonly version: number
  readonly rowCount: number
  readonly schema: readonly ColumnDef[] | null
  readonly status: CacheStatus
  readonly done: ChunkDone | null
  readonly error: PeekError | null
  /** status === 'paused' 时的描述；已加载的行仍然完全有效 */
  readonly paused: ResultPause | null
  readonly bytes: number
  readonly evictedChunks: number
  readonly firstFrameAt: number
}

export const EMPTY_SNAPSHOT: ResultSnapshot = {
  version: 0,
  rowCount: 0,
  schema: null,
  status: 'idle',
  done: null,
  error: null,
  paused: null,
  bytes: 0,
  evictedChunks: 0,
  firstFrameAt: 0,
}

/* ------------------------------------------------------------------ */
/* 模块级状态                                                           */
/* ------------------------------------------------------------------ */

const entries = new Map<ResultId, ResultEntry>()
/** 视图先于首帧挂载时暂存的视口，结果集建立时补进去 */
const pendingViewports = new Map<ResultId, Viewport>()
const portsByConn = new Map<ConnId, MessagePort>()
const listeners = new Map<ResultId, Set<() => void>>()
const globalListeners = new Set<() => void>()

let totalBytes = 0
let tick = 0

/* ------------------------------------------------------------------ */
/* 订阅（useSyncExternalStore 用）                                       */
/* ------------------------------------------------------------------ */

export function subscribeResult(id: ResultId, cb: () => void): () => void {
  let set = listeners.get(id)
  if (!set) {
    set = new Set()
    listeners.set(id, set)
  }
  set.add(cb)
  return () => {
    const s = listeners.get(id)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) listeners.delete(id)
  }
}

/** 订阅"缓存总体"变化（状态栏用） */
export function subscribeCacheStats(cb: () => void): () => void {
  globalListeners.add(cb)
  return () => {
    globalListeners.delete(cb)
  }
}

export interface CacheStats {
  readonly bytes: number
  readonly results: number
  readonly chunks: number
  readonly version: number
}

let statsSnapshot: CacheStats = { bytes: 0, results: 0, chunks: 0, version: 0 }
let statsVersion = 0

export function getCacheStats(): CacheStats {
  if (statsSnapshot.version !== statsVersion) {
    let chunks = 0
    for (const e of entries.values()) chunks += e.chunks.length
    statsSnapshot = { bytes: totalBytes, results: entries.size, chunks, version: statsVersion }
  }
  return statsSnapshot
}

/* --- 变更通知：chunk 到达按 rAF 合帧，终止事件立即广播 --- */

const dirty = new Set<ResultId>()
let rafHandle = 0

function markDirty(e: ResultEntry): void {
  e.version += 1
  e.snapshot = null
  statsVersion += 1
  dirty.add(e.id)
  if (rafHandle === 0) {
    rafHandle = requestAnimationFrame(flushDirty)
  }
}

function flushDirty(): void {
  rafHandle = 0
  const ids = [...dirty]
  dirty.clear()
  for (const id of ids) emit(id)
  for (const cb of globalListeners) cb()
}

function emitNow(e: ResultEntry): void {
  dirty.delete(e.id)
  emit(e.id)
  for (const cb of globalListeners) cb()
}

function emit(id: ResultId): void {
  const set = listeners.get(id)
  if (!set) return
  for (const cb of set) cb()
}

/* ------------------------------------------------------------------ */
/* 读取接口                                                             */
/* ------------------------------------------------------------------ */

export function getResultSnapshot(id: ResultId | null | undefined): ResultSnapshot {
  if (!id) return EMPTY_SNAPSHOT
  const e = entries.get(id)
  if (!e) return EMPTY_SNAPSHOT
  if (!e.snapshot) {
    e.snapshot = {
      version: e.version,
      rowCount: e.rowCount,
      schema: e.schema,
      status: e.status,
      done: e.done,
      error: e.error,
      paused: e.paused,
      bytes: e.bytes,
      evictedChunks: e.evictedChunks,
      firstFrameAt: e.firstFrameAt,
    }
  }
  return e.snapshot
}

function findChunk(e: ResultEntry, row: number): ChunkSlot | null {
  const chunks = e.chunks
  const n = chunks.length
  if (n === 0 || row < 0 || row >= e.rowCount) return null
  // 顺序扫描的局部性：先试上次命中的 chunk
  if (e.lastHit < n) {
    const hint = chunks[e.lastHit]
    if (row >= hint.startRow && row < hint.startRow + hint.rowCount) return hint
  }
  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = chunks[mid]
    if (row < c.startRow) hi = mid - 1
    else if (row >= c.startRow + c.rowCount) lo = mid + 1
    else {
      e.lastHit = mid
      return c
    }
  }
  return null
}

/**
 * 取单元格。**热路径**：不分配对象、不做类型转换，
 * 未加载（未到达或已淘汰）时返回 PENDING_CELL 哨兵。
 */
export function getCell(id: ResultId | null | undefined, row: number, col: number): unknown {
  if (!id) return PENDING_CELL
  const e = entries.get(id)
  if (!e) return PENDING_CELL
  const c = findChunk(e, row)
  if (!c || c.cols === null) return PENDING_CELL
  const column = c.cols[col]
  if (column === undefined) return PENDING_CELL
  return column[row - c.startRow]
}

/** 这一行的数据在不在内存里（决定行组件要不要跟着 version 重渲染） */
export function isRowLoaded(id: ResultId | null | undefined, row: number): boolean {
  if (!id) return false
  const e = entries.get(id)
  if (!e) return false
  const c = findChunk(e, row)
  return c !== null && c.cols !== null
}

/* ------------------------------------------------------------------ */
/* 视口 → LRU 保护 + 背压放行                                            */
/* ------------------------------------------------------------------ */

/**
 * 表格上报当前视口。**每次上报都会刷新保鲜时间戳**，哪怕位置一个字节都没变——
 * atBottom 能不能继续关掉行数闸，靠的就是"上报还在继续"这件事本身。
 *
 * @param atBottom 视口已贴到可滚动范围末端、无法再前移。滚动层是唯一知道这件事的人
 *                 （它掌握 maxTop），所以必须由它带上来，不能在这里从行号猜。
 *                 消费者停止消费时（表格卸载/换结果集）必须显式补一条 atBottom=false。
 */
export function setViewport(
  id: ResultId | null | undefined,
  start: number,
  end: number,
  atBottom = false,
): void {
  if (!id) return
  const at = Date.now()
  const e = entries.get(id)
  if (!e) {
    // 视图往往先于首帧挂载：先记下来，等结果集建立时补上，
    // 否则整段流都会以"没有视口"的姿态跑，背压永远不生效。
    // 时间戳一并记下：结果集建立时若这条已经放了很久，它的 atBottom 就不该再作数。
    pendingViewports.set(id, { start, end, atBottom, at })
    return
  }
  const vp = e.viewport
  const moved = vp.start !== start || vp.end !== end
  e.viewport = { start, end, atBottom, at }
  if (moved) {
    // 触碰视口范围内的 chunk，抬高它们的 LRU 时间戳（位置没变就不必再扫一遍 chunk 表）
    const lo = start - VIEWPORT_MARGIN_ROWS
    const hi = end + VIEWPORT_MARGIN_ROWS
    for (const c of e.chunks) {
      if (c.startRow + c.rowCount >= lo && c.startRow <= hi) c.touched = ++tick
    }
  }
  flushHeldAck(e)
}

/* ------------------------------------------------------------------ */
/* 背压                                                                */
/* ------------------------------------------------------------------ */

/** atBottom 现在还作不作数：必须是"刚刚上报过"的 atBottom */
function isAtBottomNow(e: ResultEntry): boolean {
  const vp = e.viewport
  return vp.atBottom && Date.now() - vp.at <= VIEWPORT_FRESH_MS
}

/**
 * 要不要压住 ack。两道闸，语义严格分开：
 *
 * 1. **字节水位**：受保护集自己就撑爆了 180MB（宽行才够得着，见 ACK_HOLD_BYTES 上的注释）。
 * 2. **视口前瞻**（主力）：视口前方堆了 AHEAD_ROWS 行没人看。
 *
 * 第 2 条要给"视口贴到末端"让路，否则是死结：视口物理上推不动了却还压着 ack →
 * 60 秒空闲 → 收摊，用户什么都没做错，数据却停在半路。
 * 但这个让路必须**新鲜**（isAtBottomNow）：一条过期的 atBottom 意味着消费者已经不在了
 * （表格卸载 / rAF 被掐 / 主线程卡死），此时让路等于把背压整个关掉——那是失效，不是降级。
 * 顺带一提，新鲜的 atBottom 恒有 `vp.end ≈ rowCount`，行数闸对它本来也不成立，
 * 所以这条规则只会压住"上报已经停了、前方却越堆越多"的流。
 */
function shouldHoldAck(e: ResultEntry): boolean {
  if (totalBytes > ACK_HOLD_BYTES) return true
  if (e.rowCount - e.viewport.end <= AHEAD_ROWS) return false
  return !isAtBottomNow(e)
}

function postAck(e: ResultEntry, seq: number): void {
  const port = e.port
  if (!port) return
  const msg: ResultStreamAck = { t: 'ack', resultId: e.id, seq }
  port.postMessage(msg)
}

function ackOrHold(e: ResultEntry, seq: number): void {
  if (shouldHoldAck(e)) {
    e.heldAck = seq
    return
  }
  postAck(e, seq)
}

function flushHeldAck(e: ResultEntry): void {
  if (e.heldAck === null) return
  if (shouldHoldAck(e)) return
  const seq = e.heldAck
  e.heldAck = null
  postAck(e, seq)
}

function flushAllHeldAcks(): void {
  for (const e of entries.values()) flushHeldAck(e)
}

/* ------------------------------------------------------------------ */
/* 写入：MessagePort 数据面                                              */
/* ------------------------------------------------------------------ */

function ensureEntry(id: ResultId, connId: ConnId | null, port: MessagePort | null): ResultEntry {
  let e = entries.get(id)
  if (!e) {
    e = {
      id,
      connId,
      schema: null,
      chunks: [],
      rowCount: 0,
      bytes: 0,
      status: 'running',
      done: null,
      error: null,
      paused: null,
      version: 0,
      nextSeq: 0,
      evictedChunks: 0,
      firstFrameAt: 0,
      lastHit: 0,
      viewport: DEFAULT_VIEWPORT,
      port,
      heldAck: null,
      snapshot: null,
    }
    const pendingVp = pendingViewports.get(id)
    if (pendingVp) {
      e.viewport = pendingVp
      pendingViewports.delete(id)
    }
    entries.set(id, e)
    statsVersion += 1
  }
  if (port && e.port !== port) e.port = port
  if (connId && !e.connId) e.connId = connId
  return e
}

function onFrame(frame: ChunkFrame, port: MessagePort, connId: ConnId | null): void {
  const e = ensureEntry(frame.resultId, connId, port)
  if (e.firstFrameAt === 0) e.firstFrameAt = Date.now()

  if (frame.seq < e.nextSeq) return // 重复帧，忽略
  if (frame.seq > e.nextSeq) {
    e.error = peekError(
      'INTERNAL',
      `结果流丢帧：期望 seq ${e.nextSeq}，实际收到 ${frame.seq}`,
    )
    e.status = 'error'
    markDirty(e)
    emitNow(e)
    return
  }
  e.nextSeq = frame.seq + 1

  if (frame.schema && !e.schema) e.schema = frame.schema

  if (frame.rowCount > 0) {
    const bytes = estimateFrameBytes(frame)
    const slot: ChunkSlot = {
      seq: frame.seq,
      startRow: e.rowCount,
      rowCount: frame.rowCount,
      cols: frame.cols,
      bytes,
      touched: ++tick,
      owner: e,
    }
    e.chunks.push(slot)
    e.rowCount += frame.rowCount
    e.bytes += bytes
    totalBytes += bytes
    statsVersion += 1
  }

  if (frame.done) {
    e.done = frame.done
    e.status = 'done'
  }

  enforceBudget()
  markDirty(e)
  ackOrHold(e, frame.seq)
  if (frame.done) emitNow(e)
}

function onStreamError(resultId: ResultId, err: PeekError, port: MessagePort, connId: ConnId | null): void {
  const e = ensureEntry(resultId, connId, port)
  e.error = err
  e.status = 'error'
  markDirty(e)
  emitNow(e)
}

/**
 * 背压把流停住了。**不是错误**：已落地的 chunk 一行都不丢，也不清 error 之外的任何东西。
 * 表格照常可看可滚，只是footer 从"接收中…"变成"已暂停"。
 */
function onStreamPaused(
  resultId: ResultId,
  pause: ResultPause,
  port: MessagePort,
  connId: ConnId | null,
): void {
  const e = ensureEntry(resultId, connId, port)
  if (e.status !== 'running') return
  e.paused = pause
  e.status = 'paused'
  e.heldAck = null // 游标已关，再放行也没人收
  markDirty(e)
  emitNow(e)
}

/** 结构校验：MessagePort 上来的东西一律当 unknown 收，收窄后再用 */
function asStreamMessage(data: unknown): ResultStreamMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const rec = data as Record<string, unknown>
  if (rec['t'] === 'chunk') {
    const frame = rec['frame']
    if (typeof frame !== 'object' || frame === null) return null
    const f = frame as Record<string, unknown>
    if (typeof f['resultId'] !== 'string') return null
    if (typeof f['seq'] !== 'number') return null
    if (!Array.isArray(f['cols'])) return null
    if (typeof f['rowCount'] !== 'number') return null
    return { t: 'chunk', frame: frame as unknown as ChunkFrame }
  }
  if (rec['t'] === 'error') {
    if (typeof rec['resultId'] !== 'string') return null
    const err = rec['error']
    if (typeof err !== 'object' || err === null) return null
    return { t: 'error', resultId: rec['resultId'] as ResultId, error: err as PeekError }
  }
  if (rec['t'] === 'paused') {
    if (typeof rec['resultId'] !== 'string') return null
    const p = rec['paused']
    if (typeof p !== 'object' || p === null) return null
    return { t: 'paused', resultId: rec['resultId'] as ResultId, paused: p as ResultPause }
  }
  return null
}

/**
 * 接上某个连接的数据面端口。由 preload 的 onResultPort 移交。
 * 同一 connId 重复移交时，旧端口关闭。
 */
export function attachResultPort(connId: ConnId, port: MessagePort): void {
  const old = portsByConn.get(connId)
  if (old && old !== port) {
    try {
      old.close()
    } catch {
      /* 端口可能已被对端关闭，忽略 */
    }
  }
  portsByConn.set(connId, port)
  port.onmessage = (ev: MessageEvent): void => {
    const msg = asStreamMessage(ev.data)
    if (!msg) return
    if (msg.t === 'chunk') onFrame(msg.frame, port, connId)
    else if (msg.t === 'paused') onStreamPaused(msg.resultId, msg.paused, port, connId)
    else onStreamError(msg.resultId, msg.error, port, connId)
  }
  port.start()
}

export function detachResultPort(connId: ConnId): void {
  const port = portsByConn.get(connId)
  if (!port) return
  portsByConn.delete(connId)
  try {
    port.close()
  } catch {
    /* ignore */
  }
  for (const e of entries.values()) {
    if (e.port === port) e.port = null
  }
}

/**
 * 数据面主动取消（关游标）。控制面的取消走 query.cancel 命令，
 * 两条路互不冲突：这条只是让 host 尽快停止吐数据。
 */
export function cancelResultStream(id: ResultId): void {
  const e = entries.get(id)
  const port = e?.port ?? (e?.connId ? (portsByConn.get(e.connId) ?? null) : null)
  if (!port) return
  const msg: ResultStreamAck = { t: 'cancel', resultId: id }
  port.postMessage(msg)
}

/* ------------------------------------------------------------------ */
/* LRU 淘汰与生命周期                                                    */
/* ------------------------------------------------------------------ */

function isProtected(e: ResultEntry, c: ChunkSlot): boolean {
  const vp = e.viewport
  return c.startRow + c.rowCount >= vp.start - VIEWPORT_MARGIN_ROWS
    && c.startRow <= vp.end + VIEWPORT_MARGIN_ROWS
}

function enforceBudget(): void {
  if (totalBytes <= EVICT_HIGH_WATER) return
  const candidates: ChunkSlot[] = []
  for (const e of entries.values()) {
    for (const c of e.chunks) {
      if (c.cols !== null && !isProtected(e, c)) candidates.push(c)
    }
  }
  candidates.sort((a, b) => a.touched - b.touched)
  const touchedOwners = new Set<ResultEntry>()
  for (const c of candidates) {
    if (totalBytes <= EVICT_TARGET) break
    c.cols = null
    totalBytes -= c.bytes
    c.owner.bytes -= c.bytes
    c.owner.evictedChunks += 1
    touchedOwners.add(c.owner)
  }
  statsVersion += 1
  for (const e of touchedOwners) markDirty(e)
  // 腾出空间后放行被压住的 ack
  flushAllHeldAcks()
}

export function dropResult(id: ResultId): void {
  // 先清暂存视口：视图开了又关、一帧都没到过的结果集根本没有 entry，
  // 若跟着下面的早退一起跳过，这条记录就永远留在 map 里了
  pendingViewports.delete(id)
  const e = entries.get(id)
  if (!e) return
  for (const c of e.chunks) {
    if (c.cols !== null) totalBytes -= c.bytes
    c.cols = null
  }
  entries.delete(id)
  listeners.delete(id)
  statsVersion += 1
  flushAllHeldAcks()
}

/**
 * main 的 results 表里已经不存在的结果集，缓存也一并回收。
 * graceMs：刚到首帧、main 的 patch 可能还没广播过来的新结果集给一段宽限期，
 * 避免"数据先到、元信息后到"时被误删。
 */
export function pruneResults(alive: ReadonlySet<string>, graceMs = 5000): void {
  const now = Date.now()
  let changed = false
  // 只上报过视口、一帧都没到过的结果集不在 entries 里，得单独回收
  for (const id of [...pendingViewports.keys()]) {
    if (!alive.has(id) && !entries.has(id)) pendingViewports.delete(id)
  }
  for (const [id, e] of [...entries.entries()]) {
    if (alive.has(id)) continue
    if (e.firstFrameAt !== 0 && now - e.firstFrameAt < graceMs) continue
    if (e.firstFrameAt === 0 && e.status === 'running') continue
    dropResult(id)
    changed = true
  }
  if (changed) for (const cb of globalListeners) cb()
}

/* ------------------------------------------------------------------ */
/* 字节估算（抽样，避免为了算大小把数据再遍历一遍）                          */
/* ------------------------------------------------------------------ */

const SAMPLE_ROWS = 24
/** 每个值的固定开销（引用 + 对象头的粗估） */
const VALUE_OVERHEAD = 16

function estimateValueBytes(v: unknown): number {
  if (v === null || v === undefined) return 8
  switch (typeof v) {
    case 'number':
      return 8
    case 'boolean':
      return 4
    case 'bigint':
      return 16
    case 'string':
      return v.length * 2 + VALUE_OVERHEAD
    case 'object': {
      if (isTruncatedValue(v)) return v.preview.length * 2 + 96
      if (v instanceof Date) return 24
      if (ArrayBuffer.isView(v)) return v.byteLength + 48
      if (Array.isArray(v)) return v.length * 24 + 48
      return 320 // 普通对象（jsonb 等）的粗估
    }
    default:
      return VALUE_OVERHEAD
  }
}

function estimateFrameBytes(frame: ChunkFrame): number {
  let perRow = 0
  for (const col of frame.cols) {
    const n = Math.min(SAMPLE_ROWS, col.length)
    if (n === 0) continue
    let sum = 0
    for (let i = 0; i < n; i += 1) sum += estimateValueBytes(col[i])
    perRow += sum / n
  }
  return Math.max(128, Math.round(perRow * frame.rowCount) + frame.cols.length * 64)
}
