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
 * The result cache: where the data plane lands.
 *
 * Design rules (PLAN §8, the hard lines):
 * - **Columnar, kept as received**: the `cols` arrays of a chunk frame are held
 *   directly — no pivot to rows, no copy. A value is found by binary-searching
 *   the chunk for (row, col) and indexing into it: O(log n) and zero allocation.
 * - **LRU eviction**: once the total passes ~200MB, chunks far from the viewport
 *   are evicted by `touched` time. An evicted chunk drops its data but keeps its
 *   startRow/rowCount metadata, so row numbering never shifts.
 * - **ack backpressure**: every frame is acked as it lands; the ack is held back
 *   when the cache nears its ceiling or the viewport falls far behind, and the
 *   host stops pulling by itself once ACK_WINDOW frames are unacknowledged.
 * - This is a **plain TS module, not React state**. Components subscribe through
 *   useSyncExternalStore, and an arriving chunk only bumps a version number
 *   (coalesced per animation frame) — no data structure is ever rebuilt.
 * ==================================================================== */

/** Eviction starts above this watermark. */
const EVICT_HIGH_WATER = Math.floor(RESULT_CACHE_MAX_BYTES * 0.85)
/** Eviction stops once the total is back under this one. */
const EVICT_TARGET = Math.floor(RESULT_CACHE_MAX_BYTES * 0.7)
/**
 * Still above this watermark after eviction? Hold the ack.
 *
 * **This is not a general-purpose safety net.** The check runs after
 * enforceBudget, which pushes the total back down to EVICT_TARGET (140MB) on
 * every frame, so it can only fire when eviction has nothing left to free — that
 * is, when the **protected set alone (the viewport ±VIEWPORT_MARGIN_ROWS rows)
 * exceeds 180MB**. Since the driver truncates any cell over VALUE_PREVIEW_BYTES
 * (4KB) to a preview, that takes genuinely wide rows: 40 columns × a 4KB preview
 * is ~324KB per row, which a few hundred rows already reach (resultCache.test.ts
 * builds its fixture from exactly that constraint), while an ordinary narrow
 * table would not get close with thousands of rows.
 * Conclusion: the byte gate covers one case only — wide rows blowing out the
 * protected set. "The viewport has stopped advancing" is the row-count gate's
 * job below, and must never be left to this one.
 */
const ACK_HOLD_BYTES = Math.floor(RESULT_CACHE_MAX_BYTES * 0.9)
/** How many rows may pile up ahead of the viewport before the ack is held (a
 *  scroll releases it automatically). */
const AHEAD_ROWS = 200_000
/** How many rows above and below the viewport are protected from eviction. */
const VIEWPORT_MARGIN_ROWS = 3000
/**
 * How long an `atBottom` report stays believable. Past this, "the viewport is
 * pinned to the end" is no longer trusted.
 *
 * `atBottom` disables the row-count gate (see Viewport.atBottom), so it has to be
 * a **signal that expires on its own** rather than a latch that only ever closes:
 * an unmounted grid (onViewport set to null), a renderer whose rAF was starved by
 * backgroundThrottling, a main thread wedged for a long time — in all three cases
 * reporting simply stops and `entry.viewport` freezes on whatever came last. If
 * that last report happened to say `atBottom: true`, an orphaned stream would
 * scan the entire table at full speed (memory is covered by the LRU, but the
 * PostgreSQL READ ONLY transaction and its cursor would stay open until the scan
 * finished).
 *
 * Why three seconds: a grid that is actually alive recomputes its geometry and
 * reports synchronously on every batch of data (frame-rate, ~16ms), so 3s of slack
 * absorbs GC jitter and one long task. And a *fresh* atBottom implies
 * vp.end ≈ rowCount, which the row-count gate can never trip on anyway — so this
 * rule can only ever hold back a stream nobody is consuming, never someone who is
 * still reading.
 */
const VIEWPORT_FRESH_MS = 3_000

export type CacheStatus = 'idle' | 'running' | 'done' | 'paused' | 'error'

/** Sentinel for a cell that is not loaded: not arrived yet, or LRU-evicted. */
export const PENDING_CELL = Symbol('peek.pendingCell')

export function isPendingCell(v: unknown): boolean {
  return v === PENDING_CELL
}

interface ChunkSlot {
  seq: number
  /** Global start row within the result set. */
  startRow: number
  rowCount: number
  /** The columnar data itself; null means the chunk was evicted. */
  cols: unknown[][] | null
  bytes: number
  /** LRU timestamp (a global monotonic counter). */
  touched: number
  owner: ResultEntry
}

interface Viewport {
  start: number
  end: number
  /**
   * The viewport is pinned to the **end** of the scrollable range and cannot
   * advance any further.
   *
   * This is the escape hatch of the ack backpressure. The rule
   * `rowCount - end > AHEAD_ROWS` assumes "the viewport could move forward, the
   * user just has not moved it". Once the viewport physically cannot advance —
   * everything fits, or it is already on the last row — holding the ack by row
   * count **starves the stream**, because nobody can push it any further.
   *
   * Only a **fresh** atBottom counts (see VIEWPORT_FRESH_MS / isAtBottomNow): a
   * stale `atBottom: true` disables backpressure entirely, which is not
   * degradation but failure.
   */
  atBottom: boolean
  /** When this viewport was reported (Date.now); drives the freshness check. */
  at: number
}

/**
 * The conservative viewport a result set starts with.
 *
 * The viewport used to start as null, and shouldHoldAck skipped the row-count
 * rule entirely for null — which made "does backpressure hold" depend on when
 * React got around to rendering the grid and reporting a viewport. With 600k rows
 * arriving in a second, backpressure never engaged at all and the 180MB byte
 * watermark was the only thing left. With a definite initial value, when and
 * where the stream is held depends on rowCount alone: predictable, and testable.
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
  /** Never null (DEFAULT_VIEWPORT at creation), which is what decouples
   *  backpressure from render timing. */
  viewport: Viewport
  port: MessagePort | null
  /** The ack seq being held back by backpressure, waiting for release. */
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
  /** Why the stream paused, when status is 'paused'. The rows already loaded
   *  remain entirely valid. */
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
/* Module state                                                          */
/* ------------------------------------------------------------------ */

const entries = new Map<ResultId, ResultEntry>()
/** Viewports parked here when the view mounts before the first frame arrives;
 *  they are folded in when the result set is created. */
const pendingViewports = new Map<ResultId, Viewport>()
const portsByConn = new Map<ConnId, MessagePort>()
const listeners = new Map<ResultId, Set<() => void>>()
const globalListeners = new Set<() => void>()

let totalBytes = 0
let tick = 0

/* ------------------------------------------------------------------ */
/* Subscriptions (for useSyncExternalStore)                               */
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

/** Subscribe to cache-wide changes (used by the status bar). */
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

/* --- Change notification: arriving chunks are coalesced per animation frame,
   terminal events are broadcast immediately --- */

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
/* Read API                                                              */
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
  // Sequential scans have locality: try the chunk that hit last time first
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
 * Read one cell. **Hot path**: no allocation, no conversion. Returns the
 * PENDING_CELL sentinel when the value is not loaded (not arrived, or evicted).
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

/** Whether this row's data is in memory — decides whether the row component has
 *  to re-render along with the version. */
export function isRowLoaded(id: ResultId | null | undefined, row: number): boolean {
  if (!id) return false
  const e = entries.get(id)
  if (!e) return false
  const c = findChunk(e, row)
  return c !== null && c.cols !== null
}

/* ------------------------------------------------------------------ */
/* Viewport → LRU protection + backpressure release                       */
/* ------------------------------------------------------------------ */

/**
 * The grid reporting its current viewport. **Every report refreshes the freshness
 * timestamp**, even when the position has not moved by a single pixel — whether
 * atBottom may keep the row-count gate open rests on the fact that reports are
 * still coming in at all.
 *
 * @param atBottom The viewport is pinned to the end of the scrollable range and
 *                 cannot advance. Only the scroll layer knows this (it owns
 *                 maxTop), so it has to be passed in; guessing it from row numbers
 *                 here is not possible. A consumer that stops consuming (grid
 *                 unmounted, result set swapped) must explicitly send a final
 *                 report with atBottom=false.
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
    // The view usually mounts before the first frame: park the report and fold it
    // in when the result set is created. Otherwise the whole stream runs as if it
    // had no viewport and backpressure never engages.
    // The timestamp is parked with it: if this report has been sitting here for a
    // while by the time the result set exists, its atBottom must no longer count.
    pendingViewports.set(id, { start, end, atBottom, at })
    return
  }
  const vp = e.viewport
  const moved = vp.start !== start || vp.end !== end
  e.viewport = { start, end, atBottom, at }
  if (moved) {
    // Touch the chunks within the viewport range to raise their LRU timestamps
    // (an unchanged position needs no second pass over the chunk list)
    const lo = start - VIEWPORT_MARGIN_ROWS
    const hi = end + VIEWPORT_MARGIN_ROWS
    for (const c of e.chunks) {
      if (c.startRow + c.rowCount >= lo && c.startRow <= hi) c.touched = ++tick
    }
  }
  flushHeldAck(e)
}

/* ------------------------------------------------------------------ */
/* Backpressure                                                          */
/* ------------------------------------------------------------------ */

/** Does atBottom still count? Only if it was reported just now. */
function isAtBottomNow(e: ResultEntry): boolean {
  const vp = e.viewport
  return vp.atBottom && Date.now() - vp.at <= VIEWPORT_FRESH_MS
}

/**
 * Whether to hold the ack. Two gates, with strictly separate meanings:
 *
 * 1. **Byte watermark**: the protected set alone has blown past 180MB (only wide
 *    rows can reach this — see the note on ACK_HOLD_BYTES).
 * 2. **Viewport lookahead** (the workhorse): AHEAD_ROWS rows are stacked up ahead
 *    of a viewport nobody is moving.
 *
 * Rule 2 has to yield to "the viewport is pinned to the end", or it deadlocks: a
 * viewport that physically cannot advance, still holding the ack → 60 seconds idle
 * → the stream is torn down, and the user's data stops halfway through without
 * anyone having done anything wrong.
 * But that concession must be **fresh** (isAtBottomNow): an expired atBottom means
 * the consumer is gone (grid unmounted, rAF starved, main thread wedged), and
 * yielding then disables backpressure outright — failure, not degradation.
 * Note also that a fresh atBottom always implies `vp.end ≈ rowCount`, which the
 * row-count gate could not trip on in the first place. So this rule only ever
 * holds back a stream whose reports have stopped while the backlog keeps growing.
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
/* Writes: the MessagePort data plane                                     */
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

  if (frame.seq < e.nextSeq) return // duplicate frame, ignore
  if (frame.seq > e.nextSeq) {
    // A plain English literal, not a catalog key: this is an internal invariant
    // breaking, the text is evidence for whoever debugs the data plane, and the
    // error catalog in @peek/core has no key for it.
    e.error = peekError(
      'INTERNAL',
      `Result stream dropped a frame: expected seq ${e.nextSeq}, received ${frame.seq}`,
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
 * Backpressure stopped the stream. **This is not an error**: not one landed row is
 * lost and nothing but `error` is left untouched. The grid stays readable and
 * scrollable; only the footer changes from "Receiving…" to "Paused".
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
  e.heldAck = null // the cursor is closed; releasing an ack now would reach nobody
  markDirty(e)
  emitNow(e)
}

/** Structural validation: anything off a MessagePort arrives as unknown and is
 *  narrowed before use. */
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
 * Attach a connection's data-plane port, handed over by preload's onResultPort.
 * A second handover for the same connId closes the previous port.
 */
export function attachResultPort(connId: ConnId, port: MessagePort): void {
  const old = portsByConn.get(connId)
  if (old && old !== port) {
    try {
      old.close()
    } catch {
      /* The other end may already have closed it; ignore. */
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
 * Cancel from the data plane (closing the cursor). Control-plane cancellation goes
 * through the `query.cancel` command; the two do not conflict, since this one only
 * asks the host to stop emitting as soon as it can.
 */
export function cancelResultStream(id: ResultId): void {
  const e = entries.get(id)
  const port = e?.port ?? (e?.connId ? (portsByConn.get(e.connId) ?? null) : null)
  if (!port) return
  const msg: ResultStreamAck = { t: 'cancel', resultId: id }
  port.postMessage(msg)
}

/* ------------------------------------------------------------------ */
/* LRU eviction and lifecycle                                             */
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
  // Space has been freed, so release whatever acks were being held
  flushAllHeldAcks()
}

export function dropResult(id: ResultId): void {
  // Clear the parked viewport first: a result set whose view was opened and closed
  // before a single frame arrived has no entry at all, and skipping this along with
  // the early return below would leave the record in the map forever
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
 * Reclaim cache entries for result sets main's `results` table no longer knows.
 *
 * `graceMs` gives a brand-new result set — one whose first frame just landed while
 * main's patch may still be in flight — a window in which it is not collected, so
 * "data first, metadata second" cannot delete it by mistake.
 */
export function pruneResults(alive: ReadonlySet<string>, graceMs = 5000): void {
  const now = Date.now()
  let changed = false
  // Result sets that only ever reported a viewport have no entry, so they are
  // reclaimed separately
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
/* Byte estimation — sampled, so sizing does not mean walking the data again */
/* ------------------------------------------------------------------ */

const SAMPLE_ROWS = 24
/** Fixed per-value overhead: a rough estimate of a reference plus an object header. */
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
      return 320 // rough estimate for a plain object (jsonb and friends)
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
