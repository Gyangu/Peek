import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  VALUE_PREVIEW_BYTES,
  asConnId,
  asResultId,
  truncatedValue,
  type ChunkFrame,
  type ColumnDef,
  type ResultId,
} from '@peek/core'

/* ==================================================================
 * M6 — an LRU-evicted range must announce itself.
 *
 * The cache evicts the chunks furthest from the viewport once it passes ~200MB
 * (PLAN section 8), keeping each chunk's startRow/rowCount so row numbering never
 * shifts. Scrolling back into an evicted range therefore produced *correct row
 * numbers over blank cells, with no explanation* — indistinguishable, from the
 * outside, from data loss or a stalled stream (README, Known limitations).
 *
 * The fix does not refill (it cannot: the cursor those rows came from is closed).
 * It makes the hole legible, so a view can offer the one refill that exists —
 * running the request again. These tests pin the signal that decides when that
 * offer is shown: `evictedInViewport`, which is true only while the viewport
 * actually overlaps a dropped chunk.
 * ================================================================== */

/* ---- DOM stand-ins: must be installed before resultCache is imported ---- */
const rafQueue: (() => void)[] = []
;(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (
  cb: () => void,
): number => {
  rafQueue.push(cb)
  return rafQueue.length
}
function flushRaf(): void {
  const q = rafQueue.splice(0, rafQueue.length)
  for (const cb of q) cb()
}

class FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  postMessage(): void {}
  start(): void {}
  close(): void {}
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const cache = await import('../resultCache')

/**
 * Wide rows, sized exactly as the sibling suite sizes them: the driver truncates
 * any cell over VALUE_PREVIEW_BYTES to a preview, so ~40 columns of 4KB preview is
 * about the widest a row can honestly be — and it is what makes eviction reachable
 * within a test instead of needing hundreds of megabytes of narrow rows.
 */
const WIDE_COLUMNS = 40
const ROWS_PER_CHUNK = 200

const WIDE_SCHEMA: ColumnDef[] = Array.from({ length: WIDE_COLUMNS }, (_, i) => ({
  name: `c${i}`,
  logical: 'string' as const,
  nativeType: 'text',
}))

let seqCounter = 0

function wideFrame(resultId: ResultId): ChunkFrame {
  const seq = seqCounter++
  const preview = 'x'.repeat(VALUE_PREVIEW_BYTES)
  const cols: unknown[][] = []
  for (let c = 0; c < WIDE_COLUMNS; c += 1) {
    const col: unknown[] = []
    for (let r = 0; r < ROWS_PER_CHUNK; r += 1) {
      col.push(truncatedValue(preview, 'utf8', { byteLength: VALUE_PREVIEW_BYTES * 4 }))
    }
    cols.push(col)
  }
  return {
    resultId,
    seq,
    ...(seq === 0 ? { schema: WIDE_SCHEMA } : {}),
    cols,
    rowCount: ROWS_PER_CHUNK,
  }
}

interface Rig {
  id: ResultId
  push(chunks: number): void
}

function rig(): Rig {
  const connId = asConnId(`conn_${Math.random().toString(36).slice(2)}`)
  const id = asResultId(`res_${Math.random().toString(36).slice(2)}`)
  const port = new FakePort()
  seqCounter = 0
  cache.attachResultPort(connId, port as unknown as MessagePort)
  return {
    id,
    push(chunks: number): void {
      for (let k = 0; k < chunks; k += 1) port.deliver({ t: 'chunk', frame: wideFrame(id) })
      flushRaf()
    },
  }
}

beforeEach(() => {
  // Drained, not discarded. The cache keeps an internal "a frame is already
  // scheduled" handle that only clears when the callback runs, so throwing the
  // queue away would leave it permanently scheduled and every later markDirty
  // would silently coalesce into a frame that never fires.
  flushRaf()
})

/* ================================================================== */

describe('an evicted range the user is looking at', () => {
  it('starts false and stays false for a result nothing has evicted', () => {
    const r = rig()
    r.push(3)
    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.evictedChunks, 0, 'nothing near the budget, so nothing is dropped')
    assert.equal(snap.evictedInViewport, false)
    cache.dropResult(r.id)
  })

  it('the empty snapshot reports no gap, so a view with no result draws no notice', () => {
    assert.equal(cache.getResultSnapshot(null).evictedInViewport, false)
    assert.equal(cache.getResultSnapshot(asResultId('res_missing')).evictedInViewport, false)
  })

  it('turns true when the viewport moves back over rows the cache dropped, and false again on the way out', () => {
    const r = rig()
    // Enough wide rows to push the total past the eviction high-water mark. The
    // viewport is pinned to the tail as the data arrives, which is what leaves the
    // head unprotected and therefore evictable.
    for (let k = 0; k < 400; k += 1) {
      r.push(1)
      const rows = cache.getResultSnapshot(r.id).rowCount
      cache.setViewport(r.id, Math.max(0, rows - 50), rows, true)
    }

    const afterStream = cache.getResultSnapshot(r.id)
    assert.ok(
      afterStream.evictedChunks > 0,
      `the fixture must actually reach eviction, otherwise this test proves nothing (evicted ${afterStream.evictedChunks})`,
    )
    assert.equal(
      afterStream.evictedInViewport,
      false,
      'the tail is fully loaded: eviction happened far from where the user is',
    )

    // Scroll back to row 0 — the range that was dropped.
    cache.setViewport(r.id, 0, 40, false)
    const atHead = cache.getResultSnapshot(r.id)
    assert.equal(atHead.evictedInViewport, true, 'this is the moment the grid would show blank cells')
    // And the cells really are unavailable — the flag is not describing something
    // that is merely stale.
    assert.equal(cache.isRowLoaded(r.id, 0), false)
    assert.equal(cache.getCell(r.id, 0, 0), cache.PENDING_CELL)

    // Back to the tail: the notice must go away rather than latch on.
    const rows = atHead.rowCount
    cache.setViewport(r.id, rows - 50, rows, true)
    assert.equal(cache.getResultSnapshot(r.id).evictedInViewport, false)

    cache.dropResult(r.id)
  })

  it('the change bumps the snapshot, so a subscribed view actually re-renders', () => {
    const r = rig()
    for (let k = 0; k < 400; k += 1) {
      r.push(1)
      const rows = cache.getResultSnapshot(r.id).rowCount
      cache.setViewport(r.id, Math.max(0, rows - 50), rows, true)
    }
    assert.ok(cache.getResultSnapshot(r.id).evictedChunks > 0)

    let notified = 0
    const unsubscribe = cache.subscribeResult(r.id, () => {
      notified += 1
    })
    const before = cache.getResultSnapshot(r.id)

    cache.setViewport(r.id, 0, 40, false)
    flushRaf()

    const after = cache.getResultSnapshot(r.id)
    assert.notEqual(after, before, 'a new snapshot object, or useSyncExternalStore sees nothing')
    assert.ok(after.version > before.version)
    assert.ok(notified > 0, 'subscribers were told')

    unsubscribe()
    cache.dropResult(r.id)
  })
})
