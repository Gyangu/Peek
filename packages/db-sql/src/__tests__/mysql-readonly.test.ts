import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { isPeekError, newResultId, type MysqlConnectionConfig } from '@peek/core'
import mysql from 'mysql2/promise'
import { mysqlDriver } from '../driver'
import { MYSQL_DIALECT, mysqlStatementSetupSql } from '../mysql/dialect'
import { SqlSession } from '../session'
import { drainWithin } from './harness'

/**
 * The MySQL read-only guarantee, asserted against a real server.
 *
 * `mysql.test.ts` already covers the *statement-shaped* attempts (a bare
 * `INSERT`, a CTE hiding one, a `SET SESSION TRANSACTION READ WRITE` followed by
 * DDL). This file covers the one that is not statement-shaped: a sequence of
 * individually harmless statements whose combination writes.
 *
 * It is separate from `mysql.test.ts` because it needs a table it is allowed to
 * see written to — the whole assertion is "the row count on the server did not
 * change" — and mixing a write-target fixture into the read-only suite's shared
 * `items` table would make every other assertion there depend on this one having
 * failed to write.
 */

const TEST_URL = process.env['PEEK_TEST_MYSQL_URL'] ?? 'mysql://root:peektest@localhost:3307/peek_test'
const CONFIG: MysqlConnectionConfig = { driverId: 'mysql', url: TEST_URL }

/** Its own table: the assertion is a server-side count, so nothing else may write here */
const TABLE = 'peek_test_readonly_guard'
const SEEDED_ROWS = 3

let session: SqlSession

/** The count the server itself reports, on a connection that has nothing to do with the driver */
async function serverCount(): Promise<number> {
  const admin = await mysql.createConnection({ uri: TEST_URL, multipleStatements: false })
  try {
    const [rows] = (await admin.query({
      sql: `SELECT COUNT(*) FROM \`${TABLE}\``,
      rowsAsArray: true,
    })) as unknown as [unknown[][], unknown]
    return Number(rows[0]?.[0])
  } finally {
    await admin.end()
  }
}

/** Run one statement through the driver and report whether the server accepted it */
async function attempt(text: string): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const cursor = await session.query({ resultId: newResultId(), text })
    await drainWithin(cursor, 10_000, text)
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

describe('db-sql MySQL read-only enforcement', () => {
  before(async () => {
    const admin = await mysql.createConnection({ uri: TEST_URL, multipleStatements: false })
    try {
      await admin.query(`DROP TABLE IF EXISTS \`${TABLE}\``)
      await admin.query(`CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY)`)
      await admin.query(`INSERT INTO \`${TABLE}\` (id) VALUES (1), (2), (3)`)
    } finally {
      await admin.end()
    }
    session = (await mysqlDriver.connect(CONFIG)) as SqlSession
  })

  after(async () => {
    await session?.close()
    const admin = await mysql.createConnection({ uri: TEST_URL, multipleStatements: false })
    try {
      await admin.query(`DROP TABLE IF EXISTS \`${TABLE}\``)
    } finally {
      await admin.end()
    }
  })

  /**
   * The setup is ordered, and the order is the guarantee.
   *
   * `SET SESSION TRANSACTION READ ONLY` sets the access mode of the *next*
   * transaction; it does not touch one already in progress. So the `ROLLBACK` has
   * to come first, or a transaction the previous borrower opened survives the
   * setup and the statement runs inside it.
   */
  it('ends any inherited transaction before re-asserting read-only', () => {
    assert.deepEqual(mysqlStatementSetupSql(1234), [
      'ROLLBACK',
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION max_execution_time = 1234',
    ])
    assert.equal(MYSQL_DIALECT.sessionSetupSql()[0], 'ROLLBACK', 'the connect path uses the same order')
  })

  /**
   * The escape this file exists for.
   *
   * Every one of these statements is legal for a read-only viewer to *send*, and
   * `START TRANSACTION READ WRITE` is the documented way to override the session
   * default for one transaction. Because peek runs one statement per checkout and
   * hands the connection back to the pool in between, the three of them used to
   * compose into a durable write: the `INSERT` landed inside the transaction the
   * first statement had opened, and re-issuing `SET SESSION TRANSACTION READ ONLY`
   * on checkout neither errored nor reached into it.
   *
   * The loop is not decoration: the pool holds several connections, so a single
   * pass could miss the flipped one by luck. The assertion that matters is the
   * last one — the server's own `COUNT(*)`, not anything the driver reports.
   */
  it('refuses a write smuggled through an explicit read-write transaction', async () => {
    assert.equal(await serverCount(), SEEDED_ROWS, 'the fixture starts where the seed left it')

    for (let i = 0; i < 6; i += 1) {
      const open = await attempt('START TRANSACTION READ WRITE')
      assert.equal(open.ok, true, `attempt ${i}: opening a transaction is not the thing being refused`)

      const write = await attempt(`INSERT INTO \`${TABLE}\` (id) VALUES (${100 + i})`)
      assert.equal(write.ok, false, `attempt ${i}: the write must be refused`)
      assert.ok(
        !write.ok && isPeekError(write.err) && write.err.code === 'CONFLICT',
        `attempt ${i}: refused by the server as a read-only violation, not by client-side parsing`,
      )

      // Whether COMMIT succeeds is beside the point: there must be nothing to commit
      await attempt('COMMIT')
    }

    assert.equal(await serverCount(), SEEDED_ROWS, 'the server must hold exactly the seeded rows')
  })

  /**
   * The same shape with the write disguised as a read.
   *
   * `INSERT … SELECT` and `UPDATE … WHERE` are refused by the server for the same
   * reason, which is the property under test: enforcement is the transaction
   * access mode, so it does not depend on recognising a statement as a write.
   */
  it('refuses disguised writes inside an inherited read-write transaction', async () => {
    for (const text of [
      `INSERT INTO \`${TABLE}\` (id) SELECT id + 200 FROM \`${TABLE}\``,
      `UPDATE \`${TABLE}\` SET id = id + 1000`,
      `DELETE FROM \`${TABLE}\` WHERE id > 0`,
      `TRUNCATE TABLE \`${TABLE}\``,
    ]) {
      const open = await attempt('START TRANSACTION READ WRITE')
      assert.equal(open.ok, true, 'opening a transaction is not the thing being refused')
      const write = await attempt(text)
      assert.equal(write.ok, false, `${text}: must be refused`)
      assert.ok(!write.ok && isPeekError(write.err), `${text}: refused as a PeekError`)
      await attempt('COMMIT')
    }

    assert.equal(await serverCount(), SEEDED_ROWS, 'no row was added, changed or removed')
  })

  /**
   * A connection released mid-transaction must not carry the transaction forward.
   *
   * This is the observable half of the fix: after the sequence above, the next
   * statement to draw that pooled connection has to see `@@SESSION.transaction_read_only`
   * on and no open transaction — `@@in_transaction` would be a nicer probe, but
   * MySQL has no such variable, so the read-only flag is the one that is asserted
   * and the refusals above are what prove the transaction is gone.
   */
  it('hands the next borrower a read-only session', async () => {
    await attempt('START TRANSACTION READ WRITE')
    const probe = await session.query({
      resultId: newResultId(),
      text: 'SELECT @@SESSION.transaction_read_only AS ro',
    })
    const frames = await drainWithin(probe, 10_000, 'read-only probe')
    assert.equal(Number(frames[0]?.cols[0]?.[0]), 1, 'the session default must read back on')
    await attempt('COMMIT')
  })
})
