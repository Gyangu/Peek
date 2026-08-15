import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  VALUE_PREVIEW_BYTES,
  asConnId,
  asResultId,
  peekError,
  truncatedValue,
  type ChunkFrame,
  type ColumnDef,
  type ResultId,
} from '@peek/core'

/* ==================================================================
 * The regression net for BLOCKER 2 / MAJOR / MINOR.
 *
 * resultCache is a plain TS module (not React state) and touches exactly two DOM
 * surfaces: requestAnimationFrame and MessagePort. Minimal stand-ins for those
 * two are enough to drive the entire ack backpressure chain frame by frame from
 * node:test.
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

interface Posted {
  t: string
  seq?: number
  resultId?: string
}

/** Fake data-plane port: records the acks and cancels the renderer sends back. */
class FakePort {
  readonly posted: Posted[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  started = false

  postMessage(msg: unknown): void {
    this.posted.push(msg as Posted)
  }

  start(): void {
    this.started = true
  }

  close(): void {}

  /** Simulate the host pushing one data-plane message. */
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }

  acks(): number[] {
    return this.posted.filter((m) => m.t === 'ack').map((m) => m.seq ?? -1)
  }
}

const cache = await import('../resultCache')

const SCHEMA: ColumnDef[] = [
  { name: 'i', logical: 'number', nativeType: 'int4' },
  { name: 'label', logical: 'string', nativeType: 'text' },
]

let seqCounter = 0

function frame(resultId: ResultId, rows: number, opts: { first?: boolean; done?: boolean } = {}): ChunkFrame {
  const seq = seqCounter++
  const ints: number[] = []
  const labels: string[] = []
  for (let i = 0; i < rows; i += 1) {
    ints.push(i)
    labels.push('x')
  }
  return {
    resultId,
    seq,
    ...(opts.first ? { schema: SCHEMA } : {}),
    cols: [ints, labels],
    rowCount: rows,
    ...(opts.done ? { done: { rows, elapsedMs: 5 } } : {}),
  }
}

interface Rig {
  port: FakePort
  id: ResultId
  /** Push n chunks of 1000 rows each. */
  push(n: number): void
}

function rig(): Rig {
  const connId = asConnId(`conn_${Math.random().toString(36).slice(2)}`)
  const id = asResultId(`res_${Math.random().toString(36).slice(2)}`)
  const port = new FakePort()
  seqCounter = 0
  cache.attachResultPort(connId, port as unknown as MessagePort)
  return {
    port,
    id,
    push(n: number): void {
      for (let k = 0; k < n; k += 1) {
        port.deliver({ t: 'chunk', frame: frame(id, 1000, { first: seqCounter === 0 }) })
      }
      flushRaf()
    },
  }
}

beforeEach(() => {
  rafQueue.length = 0
})

/** Run `fn` with Date.now shifted forward by `ms` — simulating "viewport reports
 *  stopped this long ago" — then put the clock back. */
function withClockSkew<T>(ms: number, fn: () => T): T {
  const real = Date.now
  Date.now = (): number => real.call(Date) + ms
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

/* ================================================================== */

describe('MINOR — backpressure is decoupled from React render timing', () => {
  it('a result set has a definite default viewport from the start, without waiting for the grid', () => {
    const r = rig()
    // setViewport is never called: the old implementation left viewport === null
    // here and skipped the row-count rule entirely
    r.push(250) // 250k rows, past AHEAD_ROWS = 200k
    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.rowCount, 250_000)
    // The default viewport {0, 0, atBottom: false} means 250k rows nobody is
    // looking at, so the stream must be held
    assert.ok(
      r.port.acks().length < 250,
      `the ack should have been held partway; every one was released instead (${r.port.acks().length})`,
    )
    const held = r.port.acks().length
    assert.ok(
      held > 0 && held < 250,
      `held partway rather than deadlocked from the start (acked ${held} times)`,
    )
    cache.dropResult(r.id)
  })

  it('where it holds depends on the row count alone, and is predictable: the frame that crosses AHEAD_ROWS', () => {
    const r = rig()
    r.push(250)
    const acks = r.port.acks()
    const lastAck = acks[acks.length - 1]
    // AHEAD_ROWS = 200_000 at 1000 rows per frame, so frame 201 (seq=200) lands
    // with rowCount = 201000. 201000 - 0 > 200000 holds from that frame onwards.
    assert.equal(lastAck, 199, `should stop at seq=199 (exactly 200k rows), got ${lastAck}`)
    cache.dropResult(r.id)
  })
})

describe('the parked-viewport map: a view mounting before the first frame must leave no litter', () => {
  it('reclaiming a result set that never saw a frame also clears its parked viewport', () => {
    const connId = asConnId('conn_ghost')
    const ghost = asResultId('res_ghost')
    const port = new FakePort()
    cache.attachResultPort(connId, port as unknown as MessagePort)

    // The view reports its viewport as it mounts, when the result set has no entry
    // yet, so the report is parked
    cache.setViewport(ghost, 0, 26, true)
    // The view is closed again; main's results never knew about it
    cache.dropResult(ghost)
    cache.pruneResults(new Set())

    // Should frames really arrive for that id later, the stale atBottom viewport
    // must not be picked back up — a long-void record would otherwise switch off
    // the row-count backpressure without a sound
    seqCounter = 0
    for (let seq = 0; seq < 250; seq += 1) {
      port.deliver({ t: 'chunk', frame: frame(ghost, 1000, { first: seq === 0 }) })
    }
    flushRaf()
    assert.ok(
      port.acks().length < 250,
      `the parked viewport is void, so the default viewport's row-count rule must apply again (released ${port.acks().length}/250)`,
    )
    cache.dropResult(ghost)
  })
})

describe('BLOCKER 2 — advancing the viewport releases the ack', () => {
  it('a viewport that moves forward releases the held ack immediately', () => {
    const r = rig()
    r.push(250)
    const before = r.port.acks().length
    // The user scrolls to row 100,000
    cache.setViewport(r.id, 100_000, 100_026, false)
    assert.ok(r.port.acks().length > before, 'moving the viewport forward must release the ack')
    cache.dropResult(r.id)
  })

  it('a viewport pinned to the end stops holding by row count — "cannot advance" must not starve the stream', () => {
    const r = rig()
    r.push(250)
    assert.ok(r.port.acks().length < 250, 'premise: the stream really is held right now')

    // The grid is already on the last row and physically cannot advance.
    // Note that `end` is still far behind rowCount (the viewport is 27 rows), so
    // `rowCount - end > AHEAD_ROWS` still holds on its own — only atBottom saves it.
    cache.setViewport(r.id, 0, 26, true)
    const released = r.port.acks().length
    assert.ok(released > 0)

    // Keep pushing: while atBottom holds, every frame is released and nothing wedges
    r.push(50)
    const acks = r.port.acks()
    assert.equal(acks[acks.length - 1], 299, 'the final frame was acked too')
    assert.equal(acks.filter((s) => s >= 250).length, 50, 'every frame during atBottom was acked')
    cache.dropResult(r.id)
  })

  it('the byte gate is reachable even under the 4KB truncation rule — wide rows blow out the protected set', () => {
    /*
     * This fixture is deliberately built from a shape that **exists end to end**,
     * rather than a fake 15,000-character cell (the driver truncates any cell over
     * VALUE_PREVIEW_BYTES = 4KB to a preview, so such a value never reaches the
     * renderer):
     *   - every cell is a TruncatedValue with a preview of exactly 4KB — the
     *     largest single cell the driver can emit;
     *   - 40 columns (a wide table, common in jsonb/text-heavy databases) gives
     *     40 × (4096×2 + 96) ≈ 324KB per row;
     *   - 3 rows per chunk ≈ 974KB, inside PLAN's 256KB–1MB chunk target.
     * So ~190 chunks push the viewport's protected range (±3000 rows, which covers
     * all 720 rows here) past ACK_HOLD_BYTES = 180MB. enforceBudget cannot free a
     * single byte, and the byte gate has to hold the ack on its own.
     *
     * It also shows how narrow that gate's reach is: a narrow table would not come
     * close with thousands of rows, so "the viewport stopped advancing" is the job
     * of the row-count gate plus the atBottom freshness window, never this one.
     */
    const connId = asConnId('conn_bytes')
    const id = asResultId('res_bytes')
    const port = new FakePort()
    cache.attachResultPort(connId, port as unknown as MessagePort)
    cache.setViewport(id, 0, 26, true) // atBottom: the row-count rule is off

    const wide: ColumnDef[] = []
    for (let c = 0; c < 40; c += 1) wide.push({ name: `t${c}`, logical: 'string', nativeType: 'text' })
    // The largest single cell the driver can emit: a preview cut at exactly VALUE_PREVIEW_BYTES
    const cell = truncatedValue('z'.repeat(VALUE_PREVIEW_BYTES), 'utf8', { byteLength: 9_000_000 })
    const col = [cell, cell, cell]
    const cols = wide.map(() => col)

    const CHUNKS = 240
    for (let seq = 0; seq < CHUNKS; seq += 1) {
      port.deliver({
        t: 'chunk',
        frame: {
          resultId: id,
          seq,
          ...(seq === 0 ? { schema: wide } : {}),
          cols,
          rowCount: 3,
        } satisfies ChunkFrame,
      })
    }
    flushRaf()
    const acked = port.acks().length
    assert.ok(acked > 0, 'the early frames, nowhere near the watermark, must be released')
    assert.ok(
      acked < CHUNKS,
      `once the protected set passes 180MB the byte watermark must hold the ack on its own (released ${acked}/${CHUNKS})`,
    )
    // Where it holds is predictable: 180MB over ~974KB per chunk is around frame 190
    assert.ok(acked > 150 && acked < 230, `held at the watermark and not somewhere else (got ${acked})`)
    cache.dropResult(id)
  })
})

describe('BLOCKER 2, continued — atBottom expires; it is not a one-way latch', () => {
  it('only a fresh atBottom releases; once reports stop past the freshness window the row-count gate takes over again', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true) // the viewport is pinned to the end
    r.push(250) // 250k rows: atBottom is fresh, so everything is released
    assert.equal(
      r.port.acks().length,
      250,
      'premise: a fresh atBottom really does switch off the row-count gate',
    )

    // Grid unmounted / rAF starved by backgroundThrottling / main thread wedged:
    // reporting simply stops. The old implementation froze the viewport at
    // atBottom: true and let this stream scan the whole table at full speed.
    withClockSkew(10_000, () => {
      r.push(50)
    })
    assert.equal(
      r.port.acks().length,
      250,
      `after 10 seconds without a report, not one more frame may be released (got ${r.port.acks().length})`,
    )

    // The consumer is back (window visible again, user scrolling): the held ack is
    // released at once and the stream can continue
    cache.setViewport(r.id, 0, 26, true)
    const acks = r.port.acks()
    assert.equal(acks[acks.length - 1], 299, 'resuming reports must deliver the last held seq')
    cache.dropResult(r.id)
  })

  it('a repeated report at an unchanged position still renews the freshness window (no early return just because the value is the same)', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true)
    r.push(250)
    // Ten seconds later, the **identical** viewport is reported again: the value
    // did not change, but the consumer is demonstrably alive
    withClockSkew(10_000, () => {
      cache.setViewport(r.id, 0, 26, true)
    })
    withClockSkew(11_000, () => {
      r.push(20)
    })
    assert.equal(
      r.port.acks().length,
      270,
      'only one second since the last report, still inside the freshness window',
    )
    cache.dropResult(r.id)
  })

  it('explicitly revoking atBottom (what DataGrid sends on unmount) restores the row-count gate at once, without waiting out the window', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true)
    r.push(250)
    assert.equal(r.port.acks().length, 250)

    cache.setViewport(r.id, 0, 26, false) // ← the report DataGrid sends on unmount / result switch
    r.push(50)
    assert.equal(r.port.acks().length, 250, 'after the revocation not one more frame may be released')
    cache.dropResult(r.id)
  })
})

describe('MAJOR — paused is a terminal state, not an error', () => {
  it('on t:paused the status becomes paused, not one landed row is lost, and error stays empty', () => {
    const r = rig()
    r.push(10)
    const rowsBefore = cache.getResultSnapshot(r.id).rowCount

    r.port.deliver({
      t: 'paused',
      resultId: r.id,
      paused: {
        rows: rowsBefore,
        elapsedMs: 1234,
        reason: 'idleAck',
        message:
          'Result stream paused: no consumption ack for 60s,' +
          ' the server-side cursor and connection have been released',
        resumable: true,
      },
    })
    flushRaf()

    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.status, 'paused')
    assert.equal(snap.error, null, 'pausing must never slip an error in alongside')
    assert.equal(snap.rowCount, rowsBefore, 'the rows already loaded must be kept exactly as they were')
    assert.equal(snap.paused?.resumable, true)
    assert.equal(snap.paused?.rows, rowsBefore)
    // The data is still readable
    assert.equal(cache.getCell(r.id, 5, 0), 5)
    assert.equal(cache.isRowLoaded(r.id, 9999), true)
    cache.dropResult(r.id)
  })

  it('a real error still lands in error; the two paths never mix', () => {
    const r = rig()
    r.push(2)
    r.port.deliver({
      t: 'error',
      resultId: r.id,
      error: peekError('QUERY_FAILED', 'relation "nope" does not exist'),
    })
    flushRaf()
    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.status, 'error')
    assert.equal(snap.paused, null)
    assert.equal(snap.error?.code, 'QUERY_FAILED')
    cache.dropResult(r.id)
  })

  it('a done/paused arriving after the pause does not change the state back', () => {
    const r = rig()
    r.push(2)
    const pause = {
      rows: 2000,
      elapsedMs: 1,
      reason: 'idleAck' as const,
      message: 'x',
      resumable: true as const,
    }
    r.port.deliver({ t: 'paused', resultId: r.id, paused: pause })
    r.port.deliver({ t: 'paused', resultId: r.id, paused: { ...pause, rows: 99 } })
    flushRaf()
    assert.equal(cache.getResultSnapshot(r.id).paused?.rows, 2000, 'the first pause is the one that counts')
    cache.dropResult(r.id)
  })
})
