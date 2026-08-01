import assert from 'node:assert/strict'
import { isTruncatedValue, type ChunkFrame, type Cursor, type TruncatedValue } from '@peek/core'

/**
 * Shared assertions for the two integration suites.
 *
 * They live in one file on purpose: the point of `driver-sql` is that MySQL and
 * SQLite go through the same session, cursor and peeker, so anything asserted for
 * one has to hold for the other. A helper that only one suite could use would be
 * a sign the shared code is not actually shared.
 *
 * (Not a `*.test.ts` file, so `node --test` does not pick it up on its own.)
 */

/**
 * Drain a cursor, failing fast if it never finishes.
 *
 * A cursor that hangs is a real failure mode here — MySQL emits `fields` as
 * `undefined` for a statement with no result set, and a listener that throws
 * there aborts mysql2's own `done()`, so the readable never ends and `next()`
 * waits forever. Without a deadline that regression does not fail a test, it
 * times the whole suite out with no useful message.
 */
export async function drainWithin(cursor: Cursor, ms: number, label: string): Promise<ChunkFrame[]> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`cursor never finished within ${ms}ms: ${label}`)), ms)
  })
  try {
    return await Promise.race([drain(cursor), expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Drain a cursor, collecting every frame */
export async function drain(cursor: Cursor): Promise<ChunkFrame[]> {
  const frames: ChunkFrame[] = []
  for (;;) {
    const frame = await cursor.next()
    if (frame === null) break
    frames.push(frame)
    if (frame.done) break
  }
  return frames
}

/** Check the frame sequence itself: seq contiguous, schema only on the first frame, done on the last */
export function assertFrameProtocol(frames: ChunkFrame[]): void {
  assert.ok(frames.length > 0, 'there has to be at least one frame')
  const schema = frames[0]?.schema
  assert.ok(schema, 'the first frame must carry the schema')
  frames.forEach((f, i) => {
    assert.equal(f.seq, i, 'seq must increment from 0 with no gaps')
    if (i > 0) assert.equal(f.schema, undefined, 'later frames must not repeat the schema')
    assert.equal(f.cols.length, schema.length, 'the number of cols must equal the number of columns')
    for (const col of f.cols) assert.equal(col.length, f.rowCount, 'every column must be rowCount long')
  })
  const last = frames[frames.length - 1]
  assert.ok(last?.done, 'the last frame must carry done')
  for (const f of frames.slice(0, -1)) assert.equal(f.done, undefined, 'only the last frame may carry done')
  const total = frames.reduce((n, f) => n + f.rowCount, 0)
  assert.equal(last.done.rows, total, 'done.rows must equal the rows actually emitted')
}

/** Every row of a drained result, row-major, so a test can read cells by name */
export function rowsOf(frames: ChunkFrame[]): Map<string, unknown>[] {
  const schema = frames[0]?.schema ?? []
  const out: Map<string, unknown>[] = []
  for (const frame of frames) {
    for (let r = 0; r < frame.rowCount; r += 1) {
      const row = new Map<string, unknown>()
      schema.forEach((col, c) => {
        row.set(col.name, frame.cols[c]?.[r])
      })
      out.push(row)
    }
  }
  return out
}

export function cell(rows: Map<string, unknown>[], index: number, column: string): unknown {
  const row = rows[index]
  assert.ok(row, `row ${index} exists`)
  assert.ok(row.has(column), `column ${column} exists`)
  return row.get(column)
}

/** Narrow a cell to a TruncatedValue, failing the test when it is not one */
export function requireTruncated(value: unknown): TruncatedValue {
  assert.ok(isTruncatedValue(value), 'the cell must have travelled as a TruncatedValue')
  return value
}
