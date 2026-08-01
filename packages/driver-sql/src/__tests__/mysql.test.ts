import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { isPeekError, newResultId, type MysqlConnectionConfig, type RelationRef } from '@peek/core'
import mysql from 'mysql2/promise'
import { mysqlDriver } from '../driver'
import { SqlSession } from '../session'
import { sqlNodeId } from '../introspect'
import { assertFrameProtocol, cell, drain, drainWithin, requireTruncated, rowsOf } from './harness'

/**
 * Integration against a real MySQL server (default the docker instance on 3307,
 * overridable with PEEK_TEST_MYSQL_URL).
 *
 * Deliberately the same list of behaviours as `sqlite.test.ts`, asserted in the
 * same order: everything below runs through the shared `SqlSession`, `SqlCursor`,
 * `SqlIntrospector` and `SqlValuePeeker`, and a difference between the two suites
 * that is not a documented dialect difference would mean the sharing is a
 * fiction.
 */

const TEST_URL = process.env['PEEK_TEST_MYSQL_URL'] ?? 'mysql://root:peektest@localhost:3307/peek_test'
const SCHEMA = 'peek_test'
const BIG_ROWS = 200_000
const LONG_TEXT_LENGTH = 40_000

const CONFIG: MysqlConnectionConfig = { driverId: 'mysql', url: TEST_URL }

const items: RelationRef = { kind: 'relation', schema: SCHEMA, name: 'items' }

let session: SqlSession

/** Seed through a plain write connection: the driver under test cannot write, by design */
async function seed(): Promise<void> {
  const admin = await mysql.createConnection({ uri: TEST_URL, multipleStatements: false })
  try {
    for (const name of ['items', 'wide', 'big']) {
      await admin.query(`DROP TABLE IF EXISTS \`${name}\``)
    }
    await admin.query('DROP VIEW IF EXISTS `items_view`')
    await admin.query(`
      CREATE TABLE items (
        id INT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        score DOUBLE NULL,
        qty INT NULL,
        body LONGTEXT NULL,
        blob_col BLOB NULL,
        doc JSON NULL,
        made_at DATETIME NULL,
        UNIQUE KEY ix_items_name (name)
      ) COMMENT='peek integration fixture'`)
    await admin.query(
      'INSERT INTO items (id, name, score, qty, body, blob_col, doc, made_at) VALUES'
      + ' (1, ?, 1.5, 10, ?, UNHEX(?), ?, ?),'
      + ' (2, ?, NULL, 20, ?, NULL, NULL, ?),'
      + ' (3, ?, 2.5, NULL, ?, NULL, ?, NULL),'
      + ' (4, ?, 3.5, 40, NULL, NULL, NULL, ?)',
      [
        'alpha', 'a'.repeat(LONG_TEXT_LENGTH), 'DEADBEEF', '{"k":1}', '2024-01-02 03:04:05',
        "beta's", 'short', '2024-02-03 04:05:06',
        '100% raw', 'has % and _ in it', '{"k":3}',
        'delta', '2024-04-05 06:07:08',
      ],
    )
    await admin.query('CREATE TABLE wide (id INT PRIMARY KEY, huge BIGINT)')
    await admin.query('INSERT INTO wide VALUES (1, 9007199254740993)')
    await admin.query('CREATE VIEW items_view AS SELECT id, name FROM items')
    await admin.query('CREATE TABLE big (id INT PRIMARY KEY, payload VARCHAR(400))')
    await admin.query('SET SESSION cte_max_recursion_depth = 1000000')
    await admin.query(
      'INSERT INTO big (id, payload)'
      + ` WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${BIG_ROWS})`
      + " SELECT n, CONCAT('row-', n, '-', REPEAT('p', 380)) FROM s",
    )
    // TABLE_ROWS is a sampled estimate; ANALYZE makes it a useful one for the test
    await admin.query('ANALYZE TABLE items, big')
  } finally {
    await admin.end()
  }
}

describe('driver-sql against a real MySQL server', () => {
  before(async () => {
    await seed()
    session = (await mysqlDriver.connect(CONFIG)) as SqlSession
  })

  after(async () => {
    await session?.close()
  })

  /* ---------------------------------------------------------------- */
  /* connect                                                           */
  /* ---------------------------------------------------------------- */

  it('reports the flavor, version and capability set', () => {
    assert.equal(session.driverId, 'mysql')
    assert.ok(session.serverInfo.flavor === 'MySQL' || session.serverInfo.flavor === 'MariaDB')
    assert.match(session.serverInfo.version, /^\d+\.\d+/)
    assert.deepEqual([...session.capabilities].sort(), [
      'cancel', 'collectionScan', 'introspect', 'tabularQuery', 'valuePeek',
    ])
  })

  it('fails to connect to a server that is not there', async () => {
    await assert.rejects(
      () => mysqlDriver.connect({
        driverId: 'mysql',
        url: 'mysql://root:peektest@127.0.0.1:3399/peek_test',
        connectTimeoutMs: 1000,
      }),
      (err: unknown) => isPeekError(err) && err.code === 'CONNECTION_FAILED',
    )
  })

  /* ---------------------------------------------------------------- */
  /* introspect                                                        */
  /* ---------------------------------------------------------------- */

  it('lists user databases at the root and relations one level down', async () => {
    const roots = await session.listChildren(null)
    const names = roots.map((n) => n.name)
    assert.ok(names.includes(SCHEMA), `the connected database is listed: ${names.join(', ')}`)
    // The four server-owned schemas would bury the user's own database in noise
    for (const sys of ['information_schema', 'performance_schema', 'mysql', 'sys']) {
      assert.ok(!names.includes(sys), `${sys} must not appear at the root`)
    }
    // The connection's own database opens first
    assert.equal(names[0], SCHEMA)

    const rels = await session.listChildren(sqlNodeId.schema(SCHEMA))
    const byName = new Map(rels.map((n) => [n.name, n]))
    // A subset check, not an exact list: the fixture database is shared and may
    // hold tables this suite did not create
    for (const expected of ['big', 'items', 'items_view', 'wide']) {
      assert.ok(byName.has(expected), `${expected} is listed`)
    }
    assert.equal(byName.get('items')?.kind, 'table')
    assert.equal(byName.get('items_view')?.kind, 'view')
    assert.deepEqual(byName.get('items')?.ref, items)
    // MySQL does have a row-count statistic, so the tree shows an estimate
    assert.match(String(byName.get('big')?.detail), /rows/)
    assert.deepEqual(await session.listChildren(sqlNodeId.relation(SCHEMA, 'items')), [])
  })

  it('rejects a node id it did not mint', async () => {
    await assert.rejects(
      () => session.listChildren('nonsense'),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  it('describes a relation: columns, native types, primary key and indexes', async () => {
    const info = await session.describeCollection(items)
    assert.deepEqual(info.columns.map((c) => c.name), [
      'id', 'name', 'score', 'qty', 'body', 'blob_col', 'doc', 'made_at',
    ])
    const byName = new Map(info.columns.map((c) => [c.name, c]))
    assert.equal(byName.get('id')?.logical, 'number')
    assert.equal(byName.get('score')?.logical, 'number')
    assert.equal(byName.get('name')?.logical, 'string')
    assert.equal(byName.get('name')?.nativeType, 'varchar(64)')
    assert.equal(byName.get('name')?.nullable, false)
    assert.equal(byName.get('score')?.nullable, true)
    assert.equal(byName.get('blob_col')?.logical, 'bytes')
    assert.equal(byName.get('doc')?.logical, 'json')
    assert.equal(byName.get('made_at')?.logical, 'timestamp')
    assert.deepEqual(info.primaryKey, ['id'])
    assert.equal(info.comment, 'peek integration fixture')
    assert.ok((info.rowCountEstimate ?? 0) >= 0)
    const indexes = new Map((info.indexes ?? []).map((i) => [i.name, i]))
    assert.deepEqual(indexes.get('PRIMARY'), { name: 'PRIMARY', columns: ['id'], unique: true })
    assert.deepEqual(indexes.get('ix_items_name'), {
      name: 'ix_items_name', columns: ['name'], unique: true,
    })
  })

  it('reports a missing relation as NOT_FOUND rather than an empty table', async () => {
    await assert.rejects(
      () => session.describeCollection({ kind: 'relation', schema: SCHEMA, name: 'ghost' }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  it('normalizes an empty schema to the connection’s database', async () => {
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
    assert.equal(cell(rows, 0, 'id'), 1)
    assert.equal(cell(rows, 0, 'score'), 1.5)
    assert.equal(cell(rows, 1, 'score'), null)
    assert.equal(cell(rows, 0, 'blob_col'), Buffer.from('deadbeef', 'hex').toString('base64'))
    // dateStrings keeps the server's own spelling; converting to a Date would
    // apply the client's time zone to a value the server never called UTC
    assert.equal(cell(rows, 0, 'made_at'), '2024-01-02 03:04:05')
    assert.deepEqual(cell(rows, 0, 'doc'), { k: 1 })
  })

  it('keeps a 64-bit integer exact instead of rounding it into a float', async () => {
    const frames = await drain(
      await session.scan({ resultId: newResultId(), ref: { kind: 'relation', schema: SCHEMA, name: 'wide' } }),
    )
    assert.equal(cell(rowsOf(frames), 0, 'huge'), '9007199254740993')
  })

  it('binds filter values instead of splicing them, so quotes and wildcards stay data', async () => {
    const quoted = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'eq', value: "beta's" }],
    }))
    assert.deepEqual(rowsOf(quoted).map((r) => r.get('id')), [2])

    const percent = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'contains', value: '100%' }],
    }))
    assert.deepEqual(rowsOf(percent).map((r) => r.get('id')), [3])

    const injection = await drain(await session.scan({
      resultId: newResultId(),
      ref: items,
      filter: [{ column: 'name', op: 'eq', value: "x' OR 1=1 -- " }],
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
    assert.deepEqual(rows.map((r) => r.get('id')), [2, 3, 4])
    assert.equal(rows[0]?.get('score'), null)
  })

  it('pages with cursorToken, and refuses a malformed one', async () => {
    const first = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2,
    }))
    assert.equal(first[first.length - 1]?.done?.nextCursor, '2')
    assert.deepEqual(rowsOf(first).map((r) => r.get('id')), [1, 2])

    const second = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2, cursorToken: '2',
    }))
    assert.deepEqual(rowsOf(second).map((r) => r.get('id')), [3, 4])
    assert.equal(second[second.length - 1]?.done?.nextCursor, '4')

    const third = await drain(await session.scan({
      resultId: newResultId(), ref: items, sort: [{ column: 'id', dir: 'asc' }], limit: 2, cursorToken: '4',
    }))
    assert.equal(rowsOf(third).length, 0)
    assert.equal(third[third.length - 1]?.done?.nextCursor, undefined)

    await assert.rejects(
      () => session.scan({ resultId: newResultId(), ref: items, cursorToken: 'not-a-number' }),
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

  it('runs a parameterized statement over the prepared-statement protocol', async () => {
    const frames = await drain(await session.query({
      resultId: newResultId(),
      text: 'SELECT id, name, CHAR_LENGTH(body) AS body_len FROM items WHERE qty > ? ORDER BY id',
      params: [15],
    }))
    assertFrameProtocol(frames)
    const rows = rowsOf(frames)
    assert.deepEqual(rows.map((r) => r.get('id')), [2, 4])
    assert.equal(cell(rows, 0, 'body_len'), 5)
    assert.equal(cell(rows, 1, 'body_len'), null)
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

  it('reports a syntax error with the server text intact, classified from the driver code', async () => {
    const cursor = await session.query({ resultId: newResultId(), text: 'SELEKT 1' })
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err)
        && err.code === 'SYNTAX_ERROR'
        && err.i18n === undefined
        && String(err.driverCode).startsWith('ER_PARSE_ERROR'),
    )
    const missing = await session.query({ resultId: newResultId(), text: 'SELECT * FROM nope_at_all' })
    await assert.rejects(
      () => missing.next(),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND' && /nope_at_all/.test(err.message),
    )
  })

  /* ---------------------------------------------------------------- */
  /* read-only                                                         */
  /* ---------------------------------------------------------------- */

  it('refuses every write, at the server and not by matching keywords', async () => {
    for (const text of [
      "INSERT INTO items (id, name) VALUES (99, 'x')",
      'DELETE FROM items',
      'DROP TABLE items',
      'CREATE TABLE sneaky (a INT)',
      "WITH x AS (SELECT 1 AS n) INSERT INTO items (id, name) SELECT 98, 'y' FROM x",
    ]) {
      const cursor = await session.query({ resultId: newResultId(), text })
      await assert.rejects(() => cursor.next(), (err: unknown) => isPeekError(err), text)
    }
    const rows = rowsOf(await drain(await session.scan({ resultId: newResultId(), ref: items })))
    assert.equal(rows.length, 4)
  })

  /**
   * The OK-packet path: statements that produce no result set at all.
   *
   * mysql2 announces one by emitting `fields` with `undefined` and then pushing a
   * `ResultSetHeader` down the row stream. A driver that maps over `fields`
   * unguarded throws inside that emit, which aborts mysql2's own `done()` before
   * `push(null)` — the readable never ends, `next()` never settles and never
   * rejects, and the pooled connection is held forever. Deliberately the same
   * list as the SQLite suite's: this is the dialect-parity claim.
   */
  it('answers a statement with no result set with one empty done frame, not a hang', async () => {
    for (const text of ['SET autocommit = 1', 'SET @x = 1', 'DO 1', 'BEGIN', 'SET NAMES utf8mb4']) {
      const cursor = await session.query({ resultId: newResultId(), text })
      const frames = await drainWithin(cursor, 5_000, text)
      assert.equal(frames.length, 1, `${text}: exactly one frame`)
      assert.deepEqual(frames[0]?.schema, [], `${text}: an empty schema, not a missing one`)
      assert.equal(frames[0]?.rowCount, 0, `${text}: the OK packet is not a row`)
      assert.equal(frames[0]?.done?.rows, 0, `${text}: and done says so`)
    }
  })

  /**
   * Read-only is session state, and session state outlives a checkout.
   *
   * `SET SESSION TRANSACTION READ WRITE` is a statement peek will happily run,
   * and the connection then goes back to the pool writable — so unless every
   * borrow re-asserts it, the next cursor to draw that connection can write. The
   * loop is what makes the test meaningful: the pool holds POOL_MAX connections,
   * and only repeating the attempt guarantees the flipped one is drawn again.
   */
  it('keeps the session read-only after a statement tries to make it writable', async () => {
    const flip = await session.query({
      resultId: newResultId(),
      text: 'SET SESSION TRANSACTION READ WRITE',
    })
    await drainWithin(flip, 5_000, 'SET SESSION TRANSACTION READ WRITE')

    for (let i = 0; i < 12; i += 1) {
      const cursor = await session.query({
        resultId: newResultId(),
        text: 'CREATE TABLE escaped_readonly (a INT)',
      })
      await assert.rejects(
        () => drainWithin(cursor, 5_000, 'CREATE TABLE'),
        (err: unknown) => isPeekError(err),
        `attempt ${i}: a write must still be refused`,
      )
    }
    const probe = await session.query({
      resultId: newResultId(),
      text: 'SELECT @@SESSION.transaction_read_only AS ro',
    })
    const rows = rowsOf(await drainWithin(probe, 5_000, 'read-only probe'))
    assert.equal(Number(cell(rows, 0, 'ro')), 1, 'the session variable itself must read back on')
  })

  /**
   * `timeoutMs` is a core contract field, not a suggestion.
   *
   * MySQL's only per-statement budget is `max_execution_time`, which is session
   * state — so it has to be set for the statement about to run, on the connection
   * about to run it. Left unset, the fixed 300s ceiling from `sessionSetupSql`
   * applies and an 800ms request pins a pooled connection for five minutes.
   */
  it('honours the caller timeoutMs rather than the fixed session ceiling', async () => {
    const startedAt = Date.now()
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT COUNT(*) AS n FROM big a JOIN big b ON a.id <= b.id',
      timeoutMs: 800,
    })
    await assert.rejects(
      () => drainWithin(cursor, 30_000, 'timeoutMs'),
      (err: unknown) => isPeekError(err) && err.code === 'TIMEOUT',
    )
    // Generous, because the point is 800ms-not-300s, not stopwatch accuracy
    assert.ok(Date.now() - startedAt < 15_000, 'the caller budget must be the one that applies')
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
      () => session.peekValue({ kind: 'qdrantPoint', collection: 'c', pointId: 1, field: 'vector' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* ---------------------------------------------------------------- */
  /* streaming and cancellation                                        */
  /* ---------------------------------------------------------------- */

  it('streams a large table in frames instead of buffering the result set', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
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
    // ~80MB of payload read a frame at a time: `execute()`'s buffering path would
    // hold all of it, the streaming path holds one high-water mark of rows
    assert.ok(growth < 40 * 1024 * 1024, `heap grew by ${Math.round(growth / 1024 / 1024)}MB while streaming`)
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

  it('cancels a running scan server-side, and answers false when nothing is running', async () => {
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
    assert.equal(await session.cancel(resultId), false)
    assert.equal(await session.cancel(newResultId()), false)
  })

  it('releases pooled connections, so more cursors than the pool holds still run', async () => {
    // POOL_MAX is 8; a cursor that leaked its connection would wedge here
    for (let i = 0; i < 20; i += 1) {
      const cursor = await session.query({
        resultId: newResultId(), text: 'SELECT id FROM items ORDER BY id',
      })
      const frames = await drain(cursor)
      assert.equal(frames[frames.length - 1]?.done?.rows, 4)
    }
    await session.ping()
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
