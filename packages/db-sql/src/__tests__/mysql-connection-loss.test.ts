import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { isPeekError, newResultId, type Cursor, type MysqlConnectionConfig } from '@peek/core'
import mysql from 'mysql2/promise'
import { mysqlDriver } from '../driver'
import { SqlSession } from '../session'

/**
 * A MySQL connection that dies under a streaming cursor.
 *
 * ## The hang this file pins
 *
 * `MysqlRowStream` used to listen only on the `Query` readable (`readable` /
 * `end` / `error`), and mysql2 never reports a **connection-level** fault there:
 * `Connection._notifyError` hands the error to the active command's `onResult`
 * callback, a streaming query has none, so the error is emitted on the connection
 * and the readable is abandoned with no terminal event at all. `waitForWake()`
 * then waited for something that could never arrive.
 *
 * Measured on this exact fixture before the fix: after `KILL CONNECTION`,
 * `cursor.next()` was **still pending 30 seconds later**, with the server-side
 * thread long gone. In the app that stranded the view at `loading` until main's
 * whole-fetch deadline (120s by default) fired and reported TIMEOUT — the wrong
 * reason, two minutes late, for a connection that had already dropped. A MySQL
 * restart, a `wait_timeout` expiry and ordinary network trouble all land here.
 *
 * The test is deliberately an integration test: the bug lives entirely in which
 * emitter mysql2 puts the error on, so a stub of mysql2 would have asserted
 * peek's belief about mysql2 rather than mysql2's behaviour.
 */

const TEST_URL = process.env['PEEK_TEST_MYSQL_URL'] ?? 'mysql://root:peektest@localhost:3307/peek_test'
const CONFIG: MysqlConnectionConfig = { driverId: 'mysql', url: TEST_URL }

/** Rows wide enough that the server is still writing when the first frame lands */
const ROWS = 60_000

/** Tags the statement so its server-side thread can be found in the process list */
const MARKER = 'peek_conn_loss_probe'

let session: SqlSession
let admin: mysql.Connection

/** Fail fast rather than hanging the suite: the regression *is* a hang. */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still pending after ${String(ms)}ms`)), ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Pull frames until the cursor settles one way or the other.
 *
 * Resolving is always a test failure here: the connection was killed part-way
 * through, so a `done` frame would mean peek reported a complete result set for a
 * result set the server never finished sending.
 */
async function drainUntilSettled(cursor: Cursor): Promise<never> {
  let rows = 0
  for (;;) {
    const frame = await cursor.next()
    if (frame === null) throw new Error(`the cursor ended cleanly after ${String(rows)} rows`)
    rows += frame.rowCount
    if (frame.done) throw new Error(`the cursor reported done after ${String(rows)} of ${String(ROWS)} rows`)
    assert.ok(rows < ROWS, 'a killed connection cannot have delivered the whole table')
  }
}

interface ProcessRow {
  Id: number
  Info: string | null
}

/** The server's own view of which thread is running peek's statement. */
async function findThreadId(): Promise<number> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [rows] = await admin.query('SHOW FULL PROCESSLIST')
    const hit = (rows as ProcessRow[]).find((row) => row.Info?.includes(MARKER) === true)
    if (hit) return hit.Id
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the streaming statement never appeared in SHOW FULL PROCESSLIST')
}

describe('db-sql: a MySQL connection lost mid-stream', () => {
  before(async () => {
    admin = await mysql.createConnection({ uri: TEST_URL, multipleStatements: false })
    await admin.query('DROP TABLE IF EXISTS `conn_loss`')
    await admin.query('CREATE TABLE conn_loss (id INT PRIMARY KEY, payload VARCHAR(400))')
    await admin.query('SET SESSION cte_max_recursion_depth = 1000000')
    await admin.query(
      'INSERT INTO conn_loss (id, payload)'
      + ` WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${String(ROWS)})`
      + " SELECT n, CONCAT('row-', n, '-', REPEAT('p', 380)) FROM s",
    )
    session = (await mysqlDriver.connect(CONFIG)) as SqlSession
  })

  after(async () => {
    await session?.close()
    await admin?.query('DROP TABLE IF EXISTS `conn_loss`').catch(() => undefined)
    await admin?.end().catch(() => undefined)
  })

  it('settles next() as CONNECTION_LOST instead of waiting forever', async () => {
    const cursor: Cursor = await session.query({
      resultId: newResultId(),
      text: `SELECT /* ${MARKER} */ id, payload FROM conn_loss ORDER BY id`,
      chunkRows: 200,
    })

    // One frame proves the stream is live and the server is mid-result-set: peek
    // stops reading here, so TCP backpressure keeps the statement running.
    const first = await within(cursor.next(), 20_000, 'the first frame')
    assert.ok(first, 'the first frame must arrive')
    assert.equal(first.rowCount, 200)

    const threadId = await findThreadId()
    await admin.query(`KILL CONNECTION ${String(threadId)}`)

    // Rows already parsed into the readable are still delivered — losing them
    // would be a second bug — so the failure surfaces once that buffer drains.
    // The regression is that it never surfaces at all.
    const startedAt = Date.now()
    await assert.rejects(
      () => within(drainUntilSettled(cursor), 15_000, 'next() after the connection was killed'),
      (err: unknown) => {
        assert.ok(isPeekError(err), `expected a PeekError, got ${String(err)}`)
        // Not TIMEOUT and not QUERY_FAILED: the statement was fine, the socket was not.
        assert.equal(err.code, 'CONNECTION_LOST')
        return true
      },
    )
    // The old behaviour was "never" — 30s in and still pending. Anything inside
    // this bound is the wake-up working rather than a deadline elsewhere.
    assert.ok(Date.now() - startedAt < 15_000, 'the cursor must settle promptly, not on a deadline')
  })

  it('leaves the pool usable: the killed connection is not handed to the next borrower', async () => {
    const cursor = await session.query({ resultId: newResultId(), text: 'SELECT COUNT(*) AS n FROM conn_loss' })
    const frame = await within(cursor.next(), 20_000, 'a query after the connection loss')
    assert.ok(frame?.done, 'the follow-up query must complete normally')
    await cursor.close()
    await session.ping()
  })
})
