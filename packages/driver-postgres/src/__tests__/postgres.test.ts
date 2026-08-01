import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  encodeScanCursor,
  isPeekError,
  isTruncatedValue,
  newResultId,
  rowOffsetCursor,
  type ChunkFrame,
  type Cursor,
  type PostgresConnectionConfig,
} from '@peek/core'
import { PostgresSession } from '../session'
import { nodeId } from '../introspect'

/**
 * Integration against a real database (default postgresql://postgres@localhost:5432/postgres,
 * overridable with PEEK_TEST_PG_URL). Covers introspect, collectionScan,
 * tabularQuery's streamed framing, large-value truncation plus valuePeek,
 * cancellation and timeouts.
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

/** One row exercising every logical type whose JS shape the four drivers had disagreed on */
const PG_LOGICAL_SQL = `
  SELECT 1::int8                    AS small_big,
         9007199254740993::int8     AS huge_big,
         DATE '2026-08-01'          AS d,
         TIME '00:01:02'            AS t,
         TIMESTAMPTZ '2026-08-01 11:31:42Z' AS ts,
         INTERVAL '1 day'           AS iv`

const CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: TEST_URL,
  applicationName: 'peek-test',
}

/** Drain a cursor, collecting every frame */
async function drain(cursor: Cursor): Promise<ChunkFrame[]> {
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
function assertFrameProtocol(frames: ChunkFrame[]): void {
  assert.ok(frames.length > 0, 'there has to be at least one frame')
  frames.forEach((f, i) => {
    assert.equal(f.seq, i, 'seq must increment from 0 with no gaps')
    if (i === 0) assert.ok(f.schema, 'the first frame must carry the schema')
    else assert.equal(f.schema, undefined, 'later frames must not repeat the schema')
    const cols = f.cols
    assert.equal(cols.length, frames[0]?.schema?.length, 'the number of cols must equal the number of columns')
    for (const col of cols) assert.equal(col.length, f.rowCount, 'every column must be rowCount long')
  })
  const last = frames[frames.length - 1]
  assert.ok(last?.done, 'the last frame must carry done')
  for (const f of frames.slice(0, -1)) assert.equal(f.done, undefined, 'only the last frame may carry done')
}

describe('driver-postgres against a real database', () => {
  let session: PostgresSession

  /**
   * The table's real row count. The test database is live (other processes write
   * to it), so row-count assertions cannot hard-code a number and must be
   * measured against the server's own count(*).
   */
  async function rowCountOf(table: string): Promise<number> {
    const frames = await drain(
      await session.query({ resultId: newResultId(), text: `SELECT count(*)::int4 AS n FROM ${table}` }),
    )
    const n = frames[0]?.cols[0]?.[0]
    assert.equal(typeof n, 'number', 'count(*) must come back as a number')
    return n as number
  }

  before(async () => {
    session = await PostgresSession.connect(CONFIG)
  })

  after(async () => {
    await session?.close()
  })

  it('the capability set after connecting matches core DRIVER_CAPABILITIES.postgres', () => {
    assert.deepEqual(
      [...session.capabilities].sort(),
      ['cancel', 'collectionScan', 'introspect', 'tabularQuery', 'valuePeek'],
    )
    assert.equal(session.serverInfo.flavor, 'PostgreSQL')
    assert.match(session.serverInfo.version, /^\d+/)
  })

  /* -------------------- introspect: three lazily loaded levels -------------------- */

  it('the root level returns only the current database, expanding one level at a time', async () => {
    const roots = await session.listChildren(null)
    assert.equal(roots.length, 1)
    assert.equal(roots[0]?.kind, 'database')
    // Derive the database name from TEST_URL: PEEK_TEST_PG_URL can point this
    // elsewhere, so it must not be hard-coded
    assert.equal(roots[0]?.name, new URL(TEST_URL).pathname.slice(1))
    assert.equal(roots[0]?.hasChildren, true)

    const schemas = await session.listChildren(roots[0]?.id ?? '')
    const names = schemas.map((s) => s.name)
    assert.ok(names.includes('public'), `the schema level should contain public, got ${names.join(',')}`)
    assert.equal(names[0], 'public', 'public sorts first')
    for (const s of schemas) assert.equal(s.kind, 'schema')
  })

  it('the public schema holds exactly 3 tables, each with a directly openable ref', async () => {
    const tables = await session.listChildren(nodeId.schema('public'))
    assert.deepEqual(tables.map((t) => t.name).sort(), ['account', 'harness', 'document'])
    for (const t of tables) {
      assert.equal(t.kind, 'table')
      assert.equal(t.hasChildren, false, 'a table is a leaf; its columns come from describeCollection')
      assert.deepEqual(t.ref, { kind: 'relation', schema: 'public', name: t.name })
    }
  })

  /**
   * The canonical JS representation of a cell, asserted here against a real
   * server. The rule itself, and the argument for it, is `core/values.ts`; the
   * matching assertions live in the other three driver suites, because the point
   * is precisely that all four agree.
   *
   *   BIGINT 1                 → the number 1, not the string "1"
   *   BIGINT past 2^53         → exact decimal text, never a rounded number
   *   a date / time / timestamp → a string, never a Date object
   */
  it('represents every logical type the way core says all four drivers must', async () => {
    const frames = await drain(
      await session.query({ resultId: newResultId(), text: PG_LOGICAL_SQL }),
    )
    const schema = frames[0]?.schema ?? []
    const at = (name: string): unknown => frames[0]?.cols[schema.findIndex((c) => c.name === name)]?.[0]

    // The reported divergence: this was `"1"` in postgres and `1` everywhere else
    assert.equal(at('small_big'), 1)
    assert.equal(typeof at('small_big'), 'number')
    // …and the reason it cannot simply always be a number
    assert.equal(at('huge_big'), '9007199254740993')

    for (const name of ['d', 't', 'ts', 'iv']) {
      const v = at(name)
      assert.equal(typeof v, 'string', `${name} must travel as a string, not a Date`)
    }
  })

  it('describeCollection reports column definitions and the primary key', async () => {
    const info = await session.describeCollection({
      kind: 'relation',
      schema: 'public',
      name: 'harness',
    })
    assert.deepEqual(info.columns.map((c) => c.name), ['id', 'account_id', 'created_at', 'name'])
    assert.deepEqual(info.primaryKey, ['id'])
    const createdAt = info.columns.find((c) => c.name === 'created_at')
    assert.equal(createdAt?.logical, 'timestamp')
    assert.equal(createdAt?.nativeType, 'timestamptz')
    assert.equal(info.columns.find((c) => c.name === 'id')?.primaryKey, true)
    assert.ok((info.indexes?.length ?? 0) >= 1)
  })

  it('a non-relation CollectionRef is rejected', async () => {
    await assert.rejects(
      () => session.describeCollection({ kind: 'keyPattern', pattern: '*' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* -------------------- collectionScan -------------------- */

  it('scanning harness yields exactly count(*) rows, and the first-frame schema flags the primary key', async () => {
    const expected = await rowCountOf('public.harness')
    assert.ok(expected > 0, 'harness should not be empty in the test database')
    const cursor = await session.scan({ resultId: newResultId(), ref: { kind: 'relation', schema: 'public', name: 'harness' } })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    const total = frames.reduce((n, f) => n + f.rowCount, 0)
    assert.equal(total, expected, 'a scan must emit every row in the table, no more and no fewer')
    assert.equal(frames[frames.length - 1]?.done?.rows, expected)
    const schema = frames[0]?.schema ?? []
    assert.deepEqual(schema.map((c) => c.name), ['id', 'account_id', 'created_at', 'name'])
    assert.equal(schema.find((c) => c.name === 'id')?.primaryKey, true)
    assert.equal(schema.find((c) => c.name === 'created_at')?.nullable, false)
  })

  it('filters are parameterized, so an injection string stays an ordinary value', async () => {
    const cursor = await session.scan({
      resultId: newResultId(),
      ref: { kind: 'relation', schema: 'public', name: 'harness' },
      filter: [{ column: 'name', op: 'eq', value: "no-such-name'; DROP TABLE harness; --" }],
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames[frames.length - 1]?.done?.rows, 0, 'an empty result set still emits one frame carrying done')
    assert.equal(frames[0]?.rowCount, 0)
    // The table is still there, so the injection did nothing
    const after = await session.describeCollection({ kind: 'relation', schema: 'public', name: 'harness' })
    assert.equal(after.columns.length, 4)
  })

  it('pagination returns a nextCursor that fetches the following page', async () => {
    const ref = { kind: 'relation', schema: 'public', name: 'harness' } as const
    const first = await drain(await session.scan({ resultId: newResultId(), ref, limit: 2, sort: [{ column: 'id', dir: 'asc' }] }))
    const done = first[first.length - 1]?.done
    assert.equal(done?.rows, 2)
    // core's envelope around a row offset, not a bare number: the token names the
    // driver that minted it, so another store's continuation cannot be replayed
    // into this one (core/cursor.ts)
    assert.equal(done?.nextCursor, rowOffsetCursor('postgres', 2))

    const second = await drain(await session.scan({
      resultId: newResultId(),
      ref,
      limit: 2,
      sort: [{ column: 'id', dir: 'asc' }],
      cursorToken: done?.nextCursor ?? '',
    }))
    assert.equal(second[second.length - 1]?.done?.rows, 2)
    const firstIds = first.flatMap((f) => f.cols[0] ?? [])
    const secondIds = second.flatMap((f) => f.cols[0] ?? [])
    assert.equal(firstIds.length, 2)
    assert.notDeepEqual(firstIds, secondIds, 'the second page must hold different rows')

    await assert.rejects(
      () => session.scan({
        resultId: newResultId(),
        ref,
        cursorToken: encodeScanCursor({ driverId: 'qdrant', boundary: '"42"', skip: 0 }),
      }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.sql.invalidCursorToken',
    )
  })

  /* -------------------- tabularQuery: genuinely streamed -------------------- */

  it('5000 rows stream back as multiple frames sized by chunkRows', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: `SELECT i, repeat('a', 40) AS pad FROM generate_series(1, 5000) AS i`,
      chunkRows: 500,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames.length, 10, '5000 rows / 500 per frame = 10 frames')
    for (const f of frames) assert.equal(f.rowCount, 500)
    assert.equal(frames[frames.length - 1]?.done?.rows, 5000)
    assert.equal(frames[0]?.schema?.[0]?.logical, 'number')
  })

  it('without chunkRows the frame size adapts to row width, still yielding multiple frames', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: `SELECT i, repeat('b', 300) AS pad FROM generate_series(1, 4000) AS i`,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.ok(frames.length >= 2, `expected multiple frames, got ${frames.length}`)
    assert.equal(frames.reduce((n, f) => n + f.rowCount, 0), 4000)
    // Adaptive sizing keeps every frame inside core's 500-2000 row budget
    for (const f of frames.slice(0, -1)) {
      assert.ok(f.rowCount >= 500 && f.rowCount <= 2000, `frame of ${f.rowCount} rows is outside the budget`)
    }
  })

  it('done.truncated is true when maxRows cuts the result short', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT i FROM generate_series(1, 1000) AS i',
      chunkRows: 100,
      maxRows: 250,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames[frames.length - 1]?.done?.rows, 250)
    assert.equal(frames[frames.length - 1]?.done?.truncated, true)
  })

  it('query parameters travel as $n rather than concatenated text', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT $1::int AS a, $2::text AS b',
      params: [42, "it's fine"],
    })
    const frames = await drain(cursor)
    assert.equal(frames[0]?.cols[0]?.[0], 42)
    assert.equal(frames[0]?.cols[1]?.[0], "it's fine")
  })

  it('a statement that cannot back a cursor degrades to a one-shot query, keeping the frame contract and the server timeout', async () => {
    // DECLARE only accepts SELECT / VALUES / TABLE, so EXPLAIN fails and leaves
    // the transaction aborted; the fallback path has to reopen the transaction
    // and arm the timeouts again
    const explained = await drain(await session.query({ resultId: newResultId(), text: 'EXPLAIN SELECT 1' }))
    assertFrameProtocol(explained)
    assert.ok((explained[explained.length - 1]?.done?.rows ?? 0) > 0, 'EXPLAIN yields at least one plan row')

    const shown = await drain(
      await session.query({ resultId: newResultId(), text: 'SHOW statement_timeout', timeoutMs: 4321 }),
    )
    assertFrameProtocol(shown)
    assert.equal(shown[0]?.cols[0]?.[0], '4321ms', 'statement_timeout still applies on the fallback path')
  })

  it('a syntax error maps to SYNTAX_ERROR and carries a position', async () => {
    await assert.rejects(
      () => session.query({ resultId: newResultId(), text: 'SELEC 1' }),
      (err: unknown) => {
        assert.ok(isPeekError(err))
        assert.equal(err.code, 'SYNTAX_ERROR')
        assert.equal(err.driverCode, '42601')
        assert.ok((err.position ?? 0) > 0)
        return true
      },
    )
  })

  it('a missing table maps to NOT_FOUND', async () => {
    await assert.rejects(
      () => session.query({ resultId: newResultId(), text: 'SELECT * FROM no_such_table_xyz' }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND' && err.driverCode === '42P01',
    )
  })

  /* -------------------- large value truncation + valuePeek -------------------- */

  it('a value over 4KB travels as a preview, and valuePeek retrieves it in full', async () => {
    const resultId = newResultId()
    const cursor = await session.query({
      resultId,
      text: `SELECT repeat('z', 10000) AS big, 1 AS small`,
    })
    const frames = await drain(cursor)
    const cell = frames[0]?.cols[0]?.[0]
    assert.ok(isTruncatedValue(cell), 'a large value must be flagged as a TruncatedValue')
    assert.equal(cell.byteLength, 10000)
    assert.equal(cell.preview.length, 4096)
    assert.deepEqual(cell.ref, { kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(frames[0]?.schema?.[0]?.peekable, true)

    const full = await session.peekValue(cell.ref ?? { kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(full.encoding, 'utf8')
    assert.equal(full.data.length, 10000)
    assert.equal(full.totalBytes, 10000)
    assert.equal(full.eof, true)
  })

  it('valuePeek supports byte ranges, slicing on the server', async () => {
    const resultId = newResultId()
    await drain(await session.query({ resultId, text: `SELECT repeat('q', 20000) AS big` }))
    const ref = { kind: 'resultCell', resultId, row: 0, col: 0 } as const
    const part = await session.peekValue(ref, { offset: 100, length: 50 })
    assert.equal(part.data, 'q'.repeat(50))
    assert.equal(part.byteLength, 50)
    assert.equal(part.totalBytes, 20000)
    assert.equal(part.eof, false)
  })

  it('valuePeek resolves a relation cell by primary key', async () => {
    const idCursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT id, name FROM public.harness ORDER BY id LIMIT 1',
    })
    const frames = await drain(idCursor)
    const id = frames[0]?.cols[0]?.[0]
    const name = frames[0]?.cols[1]?.[0]
    assert.equal(typeof id, 'string')

    const peeked = await session.peekValue({
      kind: 'relationCell',
      collection: { kind: 'relation', schema: 'public', name: 'harness' },
      pk: { id },
      column: 'name',
    })
    assert.equal(peeked.data, name)
    assert.equal(peeked.eof, true)
  })

  it('bytea comes back as base64', async () => {
    const resultId = newResultId()
    const frames = await drain(await session.query({
      resultId,
      text: `SELECT decode('48656c6c6f', 'hex') AS b`,
    }))
    assert.equal(frames[0]?.schema?.[0]?.logical, 'bytes')
    assert.equal(frames[0]?.cols[0]?.[0], Buffer.from('Hello').toString('base64'))
    const peeked = await session.peekValue({ kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(peeked.encoding, 'base64')
    assert.equal(Buffer.from(peeked.data, 'base64').toString('utf8'), 'Hello')
  })

  it('re-fetching through a stale resultId reports NOT_FOUND', async () => {
    await assert.rejects(
      () => session.peekValue({ kind: 'resultCell', resultId: newResultId(), row: 0, col: 0 }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  /* -------------------- cancel / timeout -------------------- */

  it('cancel genuinely interrupts a long query in flight', async () => {
    const resultId = newResultId()
    const cursor = await session.query({ resultId, text: 'SELECT pg_sleep(30)' })
    // Attach the rejection handler immediately: the cancel can interrupt FETCH
    // before session.cancel() even returns, and a bare rejected promise is
    // recorded by node:test as an unhandled rejection
    const pending = cursor.next().then(
      () => null,
      (err: unknown) => err,
    )
    // Give FETCH time to actually go out before cancelling
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    assert.equal(await session.cancel(resultId), true)
    const outcome = await pending
    assert.ok(
      isPeekError(outcome) && outcome.code === 'CANCELLED',
      `after a cancel, next() must fail with CANCELLED; got ${JSON.stringify(outcome)}`,
    )
    assert.ok(Date.now() - t0 < 5000, 'the cancel must take effect at once, not wait for the query to end on its own')
    assert.equal(await session.cancel(resultId), false, 'a repeated cancel returns false without throwing')
  })

  it('an expired timeoutMs maps to TIMEOUT', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT pg_sleep(30)',
      timeoutMs: 300,
    })
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.code === 'TIMEOUT',
    )
  })

  it('the connection stays usable after a long query is cancelled', async () => {
    await session.ping()
    const frames = await drain(await session.query({ resultId: newResultId(), text: 'SELECT 1 AS ok' }))
    assert.equal(frames[0]?.cols[0]?.[0], 1)
  })
})

describe('connection failure classification', () => {
  it('a missing database maps to CONNECTION_FAILED', async () => {
    await assert.rejects(
      () => PostgresSession.connect({
        driverId: 'postgres',
        url: 'postgresql://postgres@localhost:5432/no_such_db_xyz_peek',
        connectTimeoutMs: 3000,
      }),
      (err: unknown) => isPeekError(err) && err.code === 'CONNECTION_FAILED',
    )
  })

  it('an unreachable port maps to CONNECTION_FAILED and is retryable', async () => {
    await assert.rejects(
      () => PostgresSession.connect({
        driverId: 'postgres',
        url: 'postgresql://postgres@127.0.0.1:1/whatever',
        connectTimeoutMs: 2000,
      }),
      (err: unknown) => isPeekError(err) && err.code === 'CONNECTION_FAILED' && err.retryable === true,
    )
  })
})
