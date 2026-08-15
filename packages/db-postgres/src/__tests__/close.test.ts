import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { newResultId, type PostgresConnectionConfig } from '@peek/core'
import { Client } from 'pg'
import { PostgresSession } from '../session'

/**
 * Disconnecting must stop the server, not just the client.
 *
 * The bug this file pins down: `close()` closed each active cursor, and closing
 * a cursor sends ROLLBACK **on that cursor's own connection** — a connection
 * that is busy running the statement being abandoned. Postgres does not look at
 * the ROLLBACK until the statement it is queued behind finishes. So a disconnect
 * (or an app quit) taken during a long scan hung on close() and left the backend
 * executing. Measured before the fix, against this same server: `close()` had not
 * returned after 5 s, and `pg_stat_activity` still showed the backend `active` on
 * `FETCH FORWARD` eight seconds later. Local resources were all reclaimed; the
 * database was the one still paying, indefinitely.
 *
 * The assertions here are deliberately made against the **server's own**
 * `pg_stat_activity` rather than against anything the driver reports, because
 * what the driver believes about a statement it has abandoned is exactly what
 * was wrong. Everything runs read-only (`pg_sleep` and a catalog view), which is
 * what makes it safe against the live database the rest of the suite uses.
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

/** Long enough that it could not possibly end on its own inside the test. */
const LONG_QUERY = 'SELECT pg_sleep(120)'

/**
 * Bound on `close()`. Cancelling is one extra handshake plus one round trip; a
 * value this large only fails when close() is waiting on the busy connection
 * again, which is the regression.
 */
const CLOSE_DEADLINE_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Which of our own backends the server still considers busy.
 *
 * Keyed on `application_name`, which is unique per test run, so a live database
 * with other traffic on it cannot make this flaky.
 */
async function activeBackends(probe: Client, appName: string): Promise<{ pid: number; query: string }[]> {
  const res = await probe.query<{ pid: number; query: string }>(
    `SELECT pid, left(query, 80) AS query
       FROM pg_stat_activity
      WHERE application_name = $1 AND state = 'active'`,
    [appName],
  )
  return res.rows
}

/** Wait for the server to report no busy backend for this run, up to `ms`. */
async function waitForIdle(
  probe: Client,
  appName: string,
  ms: number,
): Promise<{ pid: number; query: string }[]> {
  const deadline = Date.now() + ms
  let rows = await activeBackends(probe, appName)
  while (rows.length > 0 && Date.now() < deadline) {
    await sleep(100)
    rows = await activeBackends(probe, appName)
  }
  return rows
}

describe('closing a session stops the work it started', () => {
  it('cancels statements still running on the server, and returns promptly', async () => {
    const appName = `peek-close-test-${process.pid}`
    const config: PostgresConnectionConfig = {
      driverId: 'postgres',
      url: TEST_URL,
      applicationName: appName,
    }
    // A connection of the test's own, so the server can be asked about the
    // session under test after that session is gone.
    const probe = new Client({ connectionString: TEST_URL, application_name: `${appName}-probe` })
    await probe.connect()

    try {
      const session = await PostgresSession.connect(config)
      const cursor = await session.query({ resultId: newResultId(), text: LONG_QUERY })
      // Started and never awaited: the point is a statement in flight, which is
      // the state the app is in when the user quits. The rejection is claimed
      // right away — node:test records a bare rejected promise as a failure.
      const pending = cursor.next().then(
        () => null,
        (err: unknown) => err,
      )

      // Let the FETCH actually reach the server before pulling the rug.
      await sleep(400)
      const before = await activeBackends(probe, appName)
      assert.equal(before.length, 1, 'the setup is only meaningful with a statement genuinely running')
      assert.match(
        before[0]?.query ?? '',
        /FETCH FORWARD/,
        'the running statement should be the cursor FETCH',
      )

      const startedAt = Date.now()
      await session.close()
      const closeMs = Date.now() - startedAt
      assert.ok(
        closeMs < CLOSE_DEADLINE_MS,
        `close() must not wait on the connection it is abandoning; it took ${closeMs}ms`,
      )

      // The real assertion, and the one the old code failed: the server agrees.
      const stillActive = await waitForIdle(probe, appName, 5_000)
      assert.deepEqual(
        stillActive,
        [],
        `closing the session must interrupt the server too; still running: ${JSON.stringify(stillActive)}`,
      )

      // The abandoned read reports what happened rather than hanging forever.
      const outcome = await pending
      assert.ok(outcome !== null, 'the in-flight next() must settle, not hang')
    } finally {
      await probe.end().catch(() => {})
    }
  })

  it('is idempotent, and closing an idle session is still quick', async () => {
    const appName = `peek-close-idle-${process.pid}`
    const session = await PostgresSession.connect({
      driverId: 'postgres',
      url: TEST_URL,
      applicationName: appName,
    })
    await session.ping()
    const startedAt = Date.now()
    await session.close()
    // Nothing was running, so the cancellation sweep has nothing to cancel and
    // must not cost a handshake — a disconnect on an idle connection is the
    // common case and it stayed fast.
    assert.ok(Date.now() - startedAt < 1_000, 'closing an idle session must not pay for the sweep')
    await session.close()
  })
})
