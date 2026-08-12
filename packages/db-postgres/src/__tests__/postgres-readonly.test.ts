import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { isPeekError, newResultId, type Cursor, type PostgresConnectionConfig } from '@peek/core'
import pg from 'pg'
import { PostgresSession } from '../session'

/**
 * The PostgreSQL read-only guarantee, asserted against a real server.
 *
 * ## Why this file exists
 *
 * peek's read-only promise is delegated to the database, engine by engine
 * (`README.md:31`). Two of the three SQL engines had a suite proving it —
 * `mysql-readonly.test.ts` walks the escapes one at a time and checks the
 * server's own `COUNT(*)` after each, `sqlite.test.ts:435` flips
 * `PRAGMA query_only` back off and tries again. PostgreSQL had **nothing**: no
 * test in this package ever attempted a write, and none asserted that one was
 * refused. `BEGIN READ ONLY` was covered only indirectly, by `fixture.ts` noting
 * that DDL has to reach past the driver with a bare `pg.Client`.
 *
 * So the strongest link in the chain was the least tested one, and it is the
 * link a write path would have to open first.
 *
 * ## What is under test, and what is not
 *
 * Under test: that a statement peek itself never generates, but any MCP client or
 * any human with the query editor **can** send, does not change the database.
 * peek performs no statement inspection at all and says so as a design position
 * (`db-sql/src/session.ts:155`) — every refusal here comes from the server.
 *
 * Not under test: a stored procedure that opens its own read-write transaction.
 * `CALL` is a read-shaped statement and the write happens on the server's side of
 * the boundary; the only fix is an account without write privileges. Recorded in
 * `README.md:463` and `PLAN.md:573`, deliberately out of scope here.
 *
 * ## The shape of an assertion
 *
 * Every one ends at a count taken on a **separate `pg.Client`**, not on anything
 * the driver reports. A driver that swallowed an error and reported success would
 * pass a test that only checked the driver's own answer.
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

/** Fixed rather than random, so a run killed halfway leaves nothing to clean up. */
const SCHEMA = 'peek_test_pg_readonly'
const TABLE = `${SCHEMA}.guard`
const SEEDED_ROWS = 3

const CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: TEST_URL,
  applicationName: 'peek-test-readonly',
}

let session: PostgresSession

/** Run one statement outside the driver entirely — setup, teardown, and the verdict. */
async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** The count the server itself reports, on a connection the driver has never touched. */
async function serverCount(): Promise<number> {
  return admin(async (client) => {
    const res = await client.query(`SELECT count(*)::int8 AS n FROM ${TABLE}`)
    return Number(res.rows[0]?.n)
  })
}

async function drain(cursor: Cursor): Promise<void> {
  for (;;) {
    const frame = await cursor.next()
    if (frame === null || frame.done) break
  }
}

/** Push one statement through the driver and report whether it got all the way through. */
async function attempt(text: string): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const cursor = await session.query({ resultId: newResultId(), text })
    await drain(cursor)
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

describe('db-postgres read-only enforcement', () => {
  before(async () => {
    await admin(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY)`)
      await client.query(`INSERT INTO ${TABLE} (id) VALUES (1), (2), (3)`)
    })
    session = await PostgresSession.connect(CONFIG)
  })

  after(async () => {
    await session?.close()
    await admin(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    })
  })

  it('the fixture starts where the seed left it', async () => {
    assert.equal(await serverCount(), SEEDED_ROWS)
  })

  /**
   * The plain attempts, one statement each.
   *
   * A viewer is allowed to *send* every one of these — nothing between the MCP
   * tool and the wire inspects the text — so each has to be refused by the
   * server. `TRUNCATE` and `DROP` are in the list because they are the ones whose
   * consequence is unrecoverable, and `INSERT … SELECT` because it is the one a
   * keyword matcher would be most likely to wave through.
   */
  it('refuses every direct write, and the refusal comes from the server', async () => {
    for (const text of [
      `INSERT INTO ${TABLE} (id) VALUES (99)`,
      `INSERT INTO ${TABLE} (id) SELECT id + 200 FROM ${TABLE}`,
      `UPDATE ${TABLE} SET id = id + 1000`,
      `DELETE FROM ${TABLE} WHERE id > 0`,
      `TRUNCATE TABLE ${TABLE}`,
      `DROP TABLE ${TABLE}`,
      `CREATE TABLE ${SCHEMA}.sneaky (id int)`,
      `ALTER TABLE ${TABLE} ADD COLUMN extra text`,
    ]) {
      const res = await attempt(text)
      assert.equal(res.ok, false, `${text}: must be refused`)
      assert.ok(!res.ok && isPeekError(res.err), `${text}: must arrive as a PeekError`)
      assert.ok(
        !res.ok && isPeekError(res.err) && res.err.code === 'CONFLICT',
        `${text}: SQLSTATE 25006 must map to CONFLICT, the same code MySQL and SQLite ` +
          `report for the same event — got ${!res.ok && isPeekError(res.err) ? res.err.code : '?'}`,
      )
    }

    assert.equal(await serverCount(), SEEDED_ROWS, 'nothing was added, changed or removed')
    assert.equal(
      await admin(async (c) =>
        Number((await c.query(`SELECT count(*)::int8 AS n FROM information_schema.tables
                               WHERE table_schema = '${SCHEMA}'`)).rows[0]?.n),
      ),
      1,
      'no table was created and none was dropped',
    )
  })

  /**
   * The escape that is not statement-shaped.
   *
   * `mysql-readonly.test.ts` exists for the MySQL version of this: a sequence of
   * individually harmless statements whose *combination* writes. On PostgreSQL the
   * equivalent attempt cannot even get started — `BEGIN READ ONLY` is issued by
   * the cursor on its own connection for every statement, so a `BEGIN`/`COMMIT`
   * the user types has nothing to attach to. Asserting it anyway, because "it
   * cannot happen here" is the kind of claim that stops being true quietly.
   *
   * `SET TRANSACTION READ WRITE` is the documented way to widen the access mode,
   * and PostgreSQL refuses it once the transaction is already read-only.
   */
  it('refuses a write smuggled through an explicitly widened transaction', async () => {
    for (let i = 0; i < 4; i += 1) {
      await attempt('BEGIN')
      await attempt('SET TRANSACTION READ WRITE')
      const write = await attempt(`INSERT INTO ${TABLE} (id) VALUES (${300 + i})`)
      assert.equal(write.ok, false, `attempt ${i}: the write must be refused`)
      await attempt('COMMIT')
    }
    assert.equal(await serverCount(), SEEDED_ROWS, 'the server must hold exactly the seeded rows')
  })

  /**
   * `default_transaction_read_only` is a session GUC, and `SET` is not a write —
   * so the statement itself may well succeed. What must not follow is a write.
   *
   * This is the PostgreSQL analogue of MySQL's "flip the session variable back"
   * escape, which `mysql-readonly.test.ts` also tries. It works here because
   * peek does not rely on the GUC at all: the guarantee is the explicit
   * `BEGIN READ ONLY` that opens every cursor, and a session default cannot
   * override a transaction that already declared its access mode.
   */
  it('a session-level read-only default cannot be flipped into a working write', async () => {
    await attempt('SET default_transaction_read_only = off')
    await attempt('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE')

    const write = await attempt(`INSERT INTO ${TABLE} (id) VALUES (777)`)
    assert.equal(write.ok, false, 'the write must still be refused')
    assert.equal(await serverCount(), SEEDED_ROWS)
  })

  /**
   * The positive half. A suite that only proves writes fail would also pass if
   * the connection were broken, or if `attempt` never reached the server.
   */
  it('reads still work, so the refusals above are about writing and not about being broken', async () => {
    const res = await attempt(`SELECT id FROM ${TABLE} ORDER BY id`)
    assert.equal(res.ok, true, 'a plain SELECT must succeed')
  })

  /**
   * The guarantee has to survive a refused statement.
   *
   * A failed statement leaves its transaction in the aborted state, and the
   * cursor is responsible for rolling it back before the connection returns to
   * the pool (`cursor.ts:88`). If it did not, the next borrower would inherit a
   * poisoned transaction and every later assertion in this file would pass for
   * the wrong reason — the writes would be refused as `25P02`
   * (in_failed_sql_transaction), not as read-only violations.
   */
  it('a connection returned after a refusal is still usable', async () => {
    await attempt(`DELETE FROM ${TABLE}`)
    const after = await attempt(`SELECT count(*) FROM ${TABLE}`)
    assert.equal(after.ok, true, 'the pooled connection must not carry an aborted transaction forward')
    assert.equal(await serverCount(), SEEDED_ROWS)
  })
})
