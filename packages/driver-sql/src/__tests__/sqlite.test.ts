import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import {
  encodeScanCursor,
  isPeekError,
  newResultId,
  rowOffsetCursor,
  type RelationRef,
  type SqliteConnectionConfig,
} from '@peek/core'
import { sqliteDriver } from '../driver'
import { SqlSession } from '../session'
import { sqlNodeId } from '../introspect'
import { assertFrameProtocol, cell, drain, drainWithin, requireTruncated, rowsOf } from './harness'

/**
 * Integration against a real SQLite file, written to a scratch directory and
 * deleted afterwards.
 *
 * Covers introspection, the streamed framing contract, filters and paging,
 * large-value truncation plus valuePeek, read-only enforcement, parameter
 * binding, and cancellation. `mysql.test.ts` asserts the same behaviours through
 * the same shared code, which is the claim the package exists to test.
 */

const BIG_ROWS = 200_000
const LONG_TEXT_LENGTH = 40_000

let dir = ''
let file = ''
let session: SqlSession

const items: RelationRef = { kind: 'relation', schema: 'main', name: 'items' }

function seed(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      score REAL,
      qty INTEGER,
      body TEXT,
      blob_col BLOB,
      doc JSON,
      made_at DATETIME
    )`)
  db.exec('CREATE UNIQUE INDEX ix_items_name ON items(name)')
  db.exec(`
    INSERT INTO items (id, name, score, qty, body, blob_col, doc, made_at) VALUES
      (1, 'alpha',  1.5,  10, ${sqlText('a'.repeat(LONG_TEXT_LENGTH))}, x'DEADBEEF', '{"k":1}', '2024-01-02 03:04:05'),
      (2, 'beta''s', NULL, 20, 'short', NULL, NULL, '2024-02-03 04:05:06'),
      (3, '100% raw', 2.5, NULL, 'has % and _ in it', NULL, '{"k":3}', NULL),
      (4, 'delta',  3.5,  40, NULL, NULL, NULL, '2024-04-05 06:07:08')`)
  // A 64-bit integer past Number.MAX_SAFE_INTEGER, the value that silently rounds
  // if anything on the path coerces it to a float
  db.exec('CREATE TABLE wide (id INTEGER PRIMARY KEY, huge INTEGER)')
  db.exec('INSERT INTO wide VALUES (1, 9007199254740993)')
  db.exec('CREATE VIEW items_view AS SELECT id, name FROM items')
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, payload TEXT)')
  db.exec(`
    INSERT INTO big (id, payload)
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${BIG_ROWS})
    SELECT n, 'row-' || n || '-' || substr(hex(zeroblob(190)), 1, 380) FROM s`)
  db.close()
}

/** Single-quoted SQL literal, for the seed script only — the driver itself never does this */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** One row exercising the logical types whose JS shape the four drivers had disagreed on */
const LOGICAL_SQL = `
  SELECT CAST(1 AS INTEGER) AS small_big,
         w.huge             AS huge_big,
         i.made_at          AS made_at
    FROM wide w JOIN items i ON i.id = 1
   WHERE w.id = 1`

describe('driver-sql against a real SQLite database', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peek-sqlite-'))
    file = join(dir, 'peek_test.db')
    seed(file)
    const cfg: SqliteConnectionConfig = { driverId: 'sqlite', file }
    session = (await sqliteDriver.connect(cfg)) as SqlSession
  })

  after(async () => {
    await session?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /* ---------------------------------------------------------------- */
  /* connect                                                           */
  /* ---------------------------------------------------------------- */

  it('reports the flavor, version and capability set', () => {
    assert.equal(session.driverId, 'sqlite')
    assert.equal(session.serverInfo.flavor, 'SQLite')
    assert.match(session.serverInfo.version, /^\d+\.\d+/)
    assert.deepEqual([...session.capabilities].sort(), [
      'cancel', 'collectionScan', 'introspect', 'tabularQuery', 'valuePeek',
    ])
  })

  it('refuses a path that is not a readable database file', async () => {
    await assert.rejects(
      () => sqliteDriver.connect({ driverId: 'sqlite', file: join(dir, 'nope.db') }),
      (err: unknown) => isPeekError(err)
        && err.code === 'CONNECTION_FAILED'
        && err.i18n?.key === 'error.file.notFound',
    )
  })

  /* ---------------------------------------------------------------- */
  /* introspect                                                        */
  /* ---------------------------------------------------------------- */

  it('lists attached databases at the root and relations one level down', async () => {
    const roots = await session.listChildren(null)
    assert.deepEqual(roots.map((n) => n.name), ['main'])
    assert.equal(roots[0]?.kind, 'schema')
    assert.equal(roots[0]?.id, sqlNodeId.schema('main'))

    const rels = await session.listChildren(sqlNodeId.schema('main'))
    const byName = new Map(rels.map((n) => [n.name, n]))
    assert.deepEqual([...byName.keys()].sort(), ['big', 'items', 'items_view', 'wide'])
    assert.equal(byName.get('items')?.kind, 'table')
    assert.equal(byName.get('items_view')?.kind, 'view')
    assert.deepEqual(byName.get('items')?.ref, items)
    // SQLite has no row-count statistic, and counting would mean a full scan
    assert.equal(byName.get('items')?.detail, undefined)
    // Relations are leaves: columns belong to the grid, not to the tree
    assert.deepEqual(await session.listChildren(sqlNodeId.relation('main', 'items')), [])
  })

  it('rejects a node id it did not mint', async () => {
    await assert.rejects(
      () => session.listChildren('nonsense'),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  it('describes a relation: columns, affinity-derived types, primary key and indexes', async () => {
    const info = await session.describeCollection(items)
    assert.deepEqual(info.columns.map((c) => c.name), [
      'id', 'name', 'score', 'qty', 'body', 'blob_col', 'doc', 'made_at',
    ])
    const byName = new Map(info.columns.map((c) => [c.name, c]))
    assert.equal(byName.get('id')?.logical, 'bigint')
    assert.equal(byName.get('score')?.logical, 'number')
    assert.equal(byName.get('name')?.logical, 'string')
    assert.equal(byName.get('name')?.nullable, false)
    assert.equal(byName.get('score')?.nullable, true)
    assert.equal(byName.get('blob_col')?.logical, 'bytes')
    assert.equal(byName.get('doc')?.logical, 'json')
    assert.equal(byName.get('made_at')?.logical, 'timestamp')
    assert.deepEqual(info.primaryKey, ['id'])
    assert.equal(info.rowCountEstimate, undefined)
    assert.deepEqual(info.indexes, [{ name: 'ix_items_name', columns: ['name'], unique: true }])
  })

  it('reports a missing relation as NOT_FOUND rather than an empty table', async () => {
    await assert.rejects(
      () => session.describeCollection({ kind: 'relation', schema: 'main', name: 'ghost' }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  it('normalizes an empty schema to main, so a typed ref and a tree ref address one table', async () => {
    const info = await session.describeCollection({ kind: 'relation', schema: '', name: 'items' })
    assert.deepEqual(info.ref, items)
  })

  it('refuses to browse a collection kind it has no concept of', async () => {
    await assert.rejects(
      () => session.scan({ resultId: newResultId(), ref: { kind: 'keyPattern', pattern: '*' } }),
      (err: unknown) => isPeekError(err)
        && err.code === 'BAD_REQUEST'
        && err.i18n?.key === 'error.collection.kindUnsupported',
    )
  })

  /* ---------------------------------------------------------------- */
  /* collectionScan                                                    */
  /* ---------------------------------------------------------------- */

  it('scans a table, honouring the chunk protocol and carrying primary-key hints', async () => {
    const cursor = await session.scan({ resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }] })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    const schema = frames[0]?.schema ?? []
    assert.equal(schema.find((c) => c.name === 'id')?.primaryKey, true)
    assert.equal(schema.find((c) => c.name === 'name')?.nullable, false)

    const rows = rowsOf(frames)
    assert.equal(rows.length, 4)
    assert.equal(cell(rows, 0, 'name'), 'alpha')
    // Integers inside the safe range travel as numbers, matching MySQL exactly
    assert.equal(cell(rows, 0, 'id'), 1)
    assert.equal(cell(rows, 0, 'score'), 1.5)
    assert.equal(cell(rows, 1, 'score'), null)
    // A BLOB becomes base64 so the frame survives structured clone
    assert.equal(cell(rows, 0, 'blob_col'), Buffer.from('deadbeef', 'hex').toString('base64'))
  })

  it('keeps a 64-bit integer exact instead of rounding it into a float', async () => {
    const frames = await drain(
      await session.scan({ resultId: newResultId(), ref: { kind: 'relation', schema: 'main', name: 'wide' } }),
    )
    assert.equal(cell(rowsOf(frames), 0, 'huge'), '9007199254740993')
  })

  /**
   * The canonical JS representation of a cell, asserted against a real server.
   * The rule and the argument for it live in `core/values.ts`; the matching
   * assertions are in the postgres and mysql suites, because the whole point is
   * that all four drivers agree.
   *
   *   BIGINT 1                  → the number 1, not the string "1"
   *   BIGINT past 2^53          → exact decimal text, never a rounded number
   *   a date / time / timestamp → a string, never a Date object
   */
  it('represents every logical type the way core says all four drivers must', async () => {
    const frames = await drain(
      await session.query({ resultId: newResultId(), text: LOGICAL_SQL }),
    )
    const schema = frames[0]?.schema ?? []
    const at = (name: string): unknown =>
      frames[0]?.cols[schema.findIndex((c) => c.name === name)]?.[0]

    // The reported divergence: postgres used to answer `"1"` where this answers `1`
    assert.equal(at('small_big'), 1)
    assert.equal(typeof at('small_big'), 'number')
    // …and the reason it cannot simply always be a number
    assert.equal(at('huge_big'), '9007199254740993')

    for (const name of ['made_at']) {
      assert.equal(typeof at(name), 'string', `${name} must travel as a string, not a Date`)
    }
  })

  it('binds filter values instead of splicing them, so quotes and wildcards stay data', async () => {
    // A value containing a quote would end the string literal if it were spliced in
    const quoted = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'eq', value: "beta's" }],
    }))
    assert.deepEqual(rowsOf(quoted).map((r) => r.get('id')), [2])

    // `contains` is a literal substring match: '%' is a percent sign, not a wildcard
    const percent = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'contains', value: '100%' }],
    }))
    assert.deepEqual(rowsOf(percent).map((r) => r.get('id')), [3])

    // An injection attempt is a value, and stays one
    const injection = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'eq', value: "x' OR 1=1 --" }],
    }))
    assert.equal(rowsOf(injection).length, 0)
  })

  it('emits one done frame for an empty result set', async () => {
    const frames = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'id', op: 'eq', value: -1 }],
    }))
    assert.equal(frames.length, 1)
    assertFrameProtocol(frames)
    assert.equal(frames[0]?.rowCount, 0)
    assert.equal(frames[0]?.done?.rows, 0)
  })

  it('is NULL-safe on neq, and puts nulls where the caller asked', async () => {
    const rows = rowsOf(await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'score', op: 'neq', value: 1.5 }],
      sort: [{ column: 'score', dir: 'asc', nulls: 'first' }],
    })))
    // A plain `<>` would drop the NULL row entirely
    assert.deepEqual(rows.map((r) => r.get('id')), [2, 3, 4])
    assert.equal(rows[0]?.get('score'), null)
  })

  it('pages with cursorToken, and refuses a malformed one', async () => {
    const first = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2,
    }))
    const page1 = first[first.length - 1]?.done?.nextCursor
    assert.equal(page1, rowOffsetCursor('sqlite', 2), 'the cursor is core\u2019s envelope around a row offset')
    assert.deepEqual(rowsOf(first).map((r) => r.get('id')), [1, 2])

    const second = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2, cursorToken: page1 ?? '',
    }))
    assert.deepEqual(rowsOf(second).map((r) => r.get('id')), [3, 4])
    // A full page still hands back a cursor: the driver cannot know the table
    // ended exactly there without reading one more row, and guessing would drop
    // the tail of any table whose size is a multiple of the page
    const page2 = second[second.length - 1]?.done?.nextCursor
    assert.equal(page2, rowOffsetCursor('sqlite', 4))

    const third = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2, cursorToken: page2 ?? '',
    }))
    assert.equal(rowsOf(third).length, 0)
    assert.equal(third[third.length - 1]?.done?.nextCursor, undefined)

    await assert.rejects(
      () => session.scan({ resultId: newResultId(), ref: items, cursorToken: 'not-a-number' }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.sql.invalidCursorToken',
    )
    // The bare row offset this driver used to mint is no longer a token: it names
    // no driver, so nothing can tell it apart from another store's continuation
    await assert.rejects(
      () => session.scan({ resultId: newResultId(), ref: items, cursorToken: '2' }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.sql.invalidCursorToken',
    )
    // …and neither is a well-formed token minted by a different driver
    await assert.rejects(
      () => session.scan({
        resultId: newResultId(),
        ref: items,
        cursorToken: encodeScanCursor({ driverId: 'redis', boundary: '238', skip: 17 }),
      }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.sql.invalidCursorToken',
    )
  })

  it('rejects a nativeFilter rather than silently ignoring it', async () => {
    await assert.rejects(
      () => session.scan({ resultId: newResultId(), ref: items, nativeFilter: { must: [] } }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* ---------------------------------------------------------------- */
  /* tabularQuery                                                      */
  /* ---------------------------------------------------------------- */

  it('runs a parameterized statement and types its columns from the first value', async () => {
    const frames = await drain(await session.query({
      resultId: newResultId(),
      text: 'SELECT id, name, length(body) AS body_len FROM items WHERE qty > ? ORDER BY id',
      params: [15],
    }))
    assertFrameProtocol(frames)
    const rows = rowsOf(frames)
    assert.deepEqual(rows.map((r) => r.get('id')), [2, 4])
    // `length(...)` has no declared type; the schema is refined from the first
    // non-null value rather than left as `any`
    assert.equal(frames[0]?.schema?.find((c) => c.name === 'body_len')?.logical, 'bigint')
    assert.equal(cell(rows, 0, 'body_len'), 5)
  })

  it('disambiguates duplicate output column names', async () => {
    const frames = await drain(await session.query({
      resultId: newResultId(),
      text: 'SELECT a.id, b.id FROM items a JOIN items b ON b.id = a.id WHERE a.id = 1',
    }))
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'id__2'])
  })

  it('rejects an empty statement', async () => {
    await assert.rejects(
      () => session.query({ resultId: newResultId(), text: '   ' }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.query.emptyText',
    )
  })

  it('reports a syntax error with the server text intact and no i18n descriptor', async () => {
    const cursor = await session.query({ resultId: newResultId(), text: 'SELECT * FROM nope_at_all' })
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.i18n === undefined && /nope_at_all/.test(err.message),
    )
  })

  /* ---------------------------------------------------------------- */
  /* read-only                                                         */
  /* ---------------------------------------------------------------- */

  it('refuses every write, at the engine and not by matching keywords', async () => {
    for (const text of [
      "INSERT INTO items (id, name) VALUES (99, 'x')",
      'DELETE FROM items',
      'DROP TABLE items',
      'CREATE TABLE sneaky (a INTEGER)',
      // A CTE wrapping the write: a keyword allowlist reads this as a SELECT
      "WITH x AS (SELECT 1) INSERT INTO items (id, name) SELECT 98, 'y' FROM x",
    ]) {
      const cursor = await session.query({ resultId: newResultId(), text })
      await assert.rejects(() => cursor.next(), (err: unknown) => isPeekError(err), text)
    }
    // …and the table is untouched
    const rows = rowsOf(await drain(await session.scan({ resultId: newResultId(), ref: items })))
    assert.equal(rows.length, 4)
  })

  /** The same list as the MySQL suite's: a statement with no result set is one empty done frame */
  it('answers a statement with no result set with one empty done frame, not a hang', async () => {
    for (const text of ['BEGIN', 'SAVEPOINT s1', 'PRAGMA cache_size = 2000', 'RELEASE s1']) {
      const cursor = await session.query({ resultId: newResultId(), text })
      const frames = await drainWithin(cursor, 5_000, text)
      assert.equal(frames.length, 1, `${text}: exactly one frame`)
      assert.deepEqual(frames[0]?.schema, [], `${text}: an empty schema, not a missing one`)
      assert.equal(frames[0]?.rowCount, 0, `${text}: nothing is a row here`)
      assert.equal(frames[0]?.done?.rows, 0, `${text}: and done says so`)
    }
  })

  /**
   * The read-only guarantee has to survive user SQL, not just the open flag.
   *
   * `query_only` is a runtime-settable pragma and statement text passes through
   * untouched, so on a `readOnly: false` handle — which the connect config allows
   * and the MCP `connect` tool therefore exposes — `PRAGMA query_only = 0`
   * followed by a DROP used to succeed against the real file. The backend
   * re-asserts the pragma before every prepare; this is that, from the outside.
   */
  it('re-asserts query_only, so user SQL cannot switch the read-only guarantee off', async () => {
    const scratch = join(dir, 'writable.db')
    const db = new DatabaseSync(scratch)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.exec("INSERT INTO t VALUES (1, 'a')")
    db.close()

    const cfg: SqliteConnectionConfig = { driverId: 'sqlite', file: scratch, readOnly: false }
    const writable = (await sqliteDriver.connect(cfg)) as SqlSession
    try {
      const cleared = await writable.query({ resultId: newResultId(), text: 'PRAGMA query_only = 0' })
      await drainWithin(cleared, 5_000, 'PRAGMA query_only = 0')

      const readBack = rowsOf(await drainWithin(
        await writable.query({ resultId: newResultId(), text: 'PRAGMA query_only' }),
        5_000,
        'PRAGMA query_only',
      ))
      assert.equal(Number(cell(readBack, 0, 'query_only')), 1, 'the pragma must be back on')

      for (const text of ["INSERT INTO t VALUES (2, 'b')", 'UPDATE t SET v = ?', 'DROP TABLE t']) {
        const cursor = await writable.query({
          resultId: newResultId(),
          text,
          ...(text.includes('?') ? { params: ['x'] } : {}),
        })
        await assert.rejects(
          () => drainWithin(cursor, 5_000, text),
          (err: unknown) => isPeekError(err),
          text,
        )
      }
      // The table is still there, which is the only proof that matters
      const rows = rowsOf(await drainWithin(
        await writable.query({ resultId: newResultId(), text: 'SELECT count(*) AS n FROM t' }),
        5_000,
        'count',
      ))
      assert.equal(Number(cell(rows, 0, 'n')), 1)
    } finally {
      await writable.close()
    }
  })

  /* ---------------------------------------------------------------- */
  /* large values and valuePeek                                        */
  /* ---------------------------------------------------------------- */

  it('truncates a large cell to a preview and fetches the rest through valuePeek', async () => {
    const resultId = newResultId()
    const frames = await drain(await session.scan({
      resultId, ref: items, filter: [{ column: 'id', op: 'eq', value: 1 }],
    }))
    const rows = rowsOf(frames)
    const truncated = requireTruncated(cell(rows, 0, 'body'))
    assert.equal(truncated.encoding, 'utf8')
    assert.equal(truncated.byteLength, LONG_TEXT_LENGTH)
    assert.equal(truncated.preview.length, 4096)
    assert.ok(truncated.ref, 'a truncated cell must carry the ref that fetches the rest')

    const peeked = await session.peekValue(truncated.ref)
    assert.equal(peeked.encoding, 'utf8')
    assert.equal(peeked.data, 'a'.repeat(LONG_TEXT_LENGTH))
    assert.equal(peeked.totalBytes, LONG_TEXT_LENGTH)
    assert.equal(peeked.eof, true)

    const window = await session.peekValue(truncated.ref, { offset: 10, length: 5 })
    assert.equal(window.data, 'aaaaa')
    assert.equal(window.byteLength, 5)
    assert.equal(window.eof, false)
  })

  it('slices a relationCell server-side, addressed by primary key', async () => {
    const peeked = await session.peekValue(
      { kind: 'relationCell', collection: items, pk: { id: 1 }, column: 'body' },
      { offset: 0, length: 8 },
    )
    assert.equal(peeked.data, 'aaaaaaaa')
    assert.equal(peeked.totalBytes, LONG_TEXT_LENGTH)
    assert.equal(peeked.contentType, 'text/plain')
    assert.equal(peeked.eof, false)
  })

  it('rejects a relationCell whose key column does not exist', async () => {
    await assert.rejects(
      () => session.peekValue({ kind: 'relationCell', collection: items, pk: { nope: 1 }, column: 'body' }),
      (err: unknown) => isPeekError(err) && err.i18n?.key === 'error.value.primaryKeyNotFound',
    )
  })

  it('rejects another driver’s value reference', async () => {
    await assert.rejects(
      () => session.peekValue({ kind: 'redisValue', key: 'k' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* ---------------------------------------------------------------- */
  /* streaming and cancellation                                        */
  /* ---------------------------------------------------------------- */

  it('streams a large table in frames instead of materializing it', async () => {
    const resultId = newResultId()
    const cursor = await session.query({
      resultId,
      text: 'SELECT id, payload FROM big ORDER BY id',
      chunkRows: 1000,
    })

    const startedAt = Date.now()
    const first = await cursor.next()
    const firstFrameMs = Date.now() - startedAt
    assert.ok(first, 'the first frame must arrive')
    assert.equal(first.rowCount, 1000)

    const before = process.memoryUsage().heapUsed
    let frames = 1
    let rows = first.rowCount
    for (;;) {
      const frame = await cursor.next()
      if (frame === null) break
      frames += 1
      rows += frame.rowCount
      if (frame.done) break
    }
    const drainMs = Date.now() - startedAt
    const growth = process.memoryUsage().heapUsed - before

    assert.equal(rows, BIG_ROWS)
    assert.equal(frames, BIG_ROWS / 1000)
    // The whole table is ~80MB of payload. Reading it a frame at a time must not
    // leave anything like that resident: a driver that buffered the result set
    // would show a growth on that order
    assert.ok(growth < 40 * 1024 * 1024, `heap grew by ${Math.round(growth / 1024 / 1024)}MB while streaming`)
    // …and the first frame must not have waited for the last row
    assert.ok(firstFrameMs * 4 < drainMs + 40, `first frame took ${firstFrameMs}ms of a ${drainMs}ms scan`)
  })

  it('stops at maxRows and says so', async () => {
    const frames = await drain(await session.query({
      resultId: newResultId(),
      text: 'SELECT id FROM big ORDER BY id',
      maxRows: 2500,
      chunkRows: 1000,
    }))
    assertFrameProtocol(frames)
    const done = frames[frames.length - 1]?.done
    assert.equal(done?.rows, 2500)
    assert.equal(done?.truncated, true)
  })

  it('cancels a running scan, and answers false when nothing is running', async () => {
    const resultId = newResultId()
    const cursor = await session.query({
      resultId, text: 'SELECT id, payload FROM big ORDER BY id', chunkRows: 500,
    })
    await cursor.next()
    assert.equal(await session.cancel(resultId), true)
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.code === 'CANCELLED',
    )
    // Cancelling something that is not running is `false`, never a throw
    assert.equal(await session.cancel(resultId), false)
    assert.equal(await session.cancel(newResultId()), false)
  })

  it('refuses two result streams under one resultId', async () => {
    const resultId = newResultId()
    const cursor = await session.query({ resultId, text: 'SELECT 1' })
    await assert.rejects(
      () => session.query({ resultId, text: 'SELECT 2' }),
      (err: unknown) => isPeekError(err) && err.code === 'CONFLICT',
    )
    await cursor.close()
  })
})
