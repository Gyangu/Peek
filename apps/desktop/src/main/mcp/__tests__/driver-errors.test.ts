import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  NETWORK_ERROR_CODES,
  classifyTransportError,
  isNetworkErrorCode,
  isRetryableErrorCode,
  looksLikeTimeoutMessage,
  readErrno,
  type PeekError,
} from '@peek/core'
import { mapPgError } from '@peek/db-postgres'
import { mapQdrantError } from '@peek/db-qdrant'
import { mapRedisError } from '@peek/db-redis'
import { mapSqlError } from '@peek/db-sql'
import { MYSQL_DIALECT } from '@peek/db-sql'

/**
 * Cross-driver agreement on the part of error mapping that is not about any
 * particular database.
 *
 * Every driver used to carry its own copy of "a socket errno is
 * CONNECTION_FAILED, an AbortError is CANCELLED, a message that says timed out is
 * a TIMEOUT", and the copies had drifted: qdrant knew undici's
 * `UND_ERR_CONNECT_TIMEOUT` and the others did not, the SQL and redis sets knew
 * `EACCES` and qdrant did not, and the timeout regex was spelled three ways — so
 * `pool timed out` was a TIMEOUT in redis and a QUERY_FAILED in postgres.
 *
 * This file is the reason that cannot come back. It lives in the desktop app
 * because that is the only package that depends on all four drivers at once, and
 * it needs no database: every mapper is a pure function of the thrown value.
 */

/** The four funnels, each already bound to whatever context argument it needs */
const MAPPERS: Readonly<Record<string, (value: unknown) => PeekError>> = {
  postgres: (value) => mapPgError(value),
  redis: (value) => mapRedisError(value),
  qdrant: (value) => mapQdrantError(value),
  mysql: (value) => mapSqlError(MYSQL_DIALECT, value),
}

const DRIVER_NAMES = Object.keys(MAPPERS)

describe('driver error mapping: the shared transport layer', () => {
  test('an AbortError is CANCELLED in every driver, with no retry hint', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    for (const name of DRIVER_NAMES) {
      const mapped = MAPPERS[name]?.(aborted)
      assert.equal(mapped?.code, 'CANCELLED', `${name} must report an abort as CANCELLED`)
      // A cancellation is not a failure to retry — it is the user's own decision
      assert.equal(mapped?.retryable, undefined, `${name} must not mark a cancellation retryable`)
    }
  })

  /**
   * A socket errno lands on the connection, never on the statement — so it is
   * always a connection-class code and always retryable, in all four drivers.
   *
   * It is not always the *same* connection-class code, and that is deliberate: a
   * driver whose own table has something more precise to say still wins. MySQL
   * maps `ECONNRESET` to CONNECTION_LOST because mysql2 raises it when an
   * already-established connection drops, and "lost" is more true than "failed".
   * What the shared layer guarantees is the class and the retry hint, which is
   * what the UI and the MCP receipt actually branch on.
   */
  test('every network errno is a retryable connection failure in every driver', () => {
    const CONNECTION_CLASS = new Set(['CONNECTION_FAILED', 'CONNECTION_LOST'])
    for (const errno of NETWORK_ERROR_CODES) {
      const err = Object.assign(new Error(`connect ${errno} 127.0.0.1:1234`), { code: errno })

      // The shared classifier itself is unconditional
      assert.equal(classifyTransportError(err)?.code, 'CONNECTION_FAILED', errno)

      for (const name of DRIVER_NAMES) {
        const mapped = MAPPERS[name]?.(err)
        assert.ok(
          mapped !== undefined && CONNECTION_CLASS.has(mapped.code),
          `${name} must map ${errno} to a connection failure, got ${String(mapped?.code)}`,
        )
        assert.equal(mapped?.retryable, true, `${name} must mark ${errno} retryable`)
        assert.equal(mapped?.driverCode, errno, `${name} must keep ${errno} as driverCode`)
      }
    }
  })

  /**
   * The regression this file exists for. Before the shared layer, postgres tested
   * `/timeout/i` while redis and qdrant tested `/timed? ?out/i`, so a mysql2-style
   * "pool timed out" was a TIMEOUT in three drivers and a QUERY_FAILED in the
   * fourth — the same failure, classified differently by which database it came
   * from.
   */
  test('a bare "timed out" message is a TIMEOUT in every driver', () => {
    for (const text of ['pool timed out', 'Query timeout exceeded', 'connection timed  out']) {
      for (const name of DRIVER_NAMES) {
        const mapped = MAPPERS[name]?.(new Error(text))
        assert.equal(mapped?.code, 'TIMEOUT', `${name} must map "${text}" to TIMEOUT`)
        assert.equal(mapped?.retryable, true, `${name} must mark a timeout retryable`)
      }
    }
  })

  /**
   * undici (and so `@qdrant/js-client-rest`) puts the socket errno on `cause`.
   * Only qdrant used to look there; now every driver does, because a wrapped
   * socket failure is not a qdrant-specific phenomenon.
   */
  test('a socket errno hidden one level down in `cause` is still found', () => {
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    for (const name of DRIVER_NAMES) {
      const mapped = MAPPERS[name]?.(wrapped)
      assert.equal(mapped?.code, 'CONNECTION_FAILED', `${name} must unwrap cause to find the errno`)
    }
  })

  test('a database-specific error still wins over the shared layer', () => {
    // Redis reply errors are ALLCAPS-prefixed, and one may well mention a timeout;
    // the prefix has to be tested first or `ERR` stops being a reply error.
    const replyError = mapRedisError(new Error('ERR the script timed out'))
    assert.equal(replyError.code, 'QUERY_FAILED')
    assert.equal(replyError.driverCode, 'ERR')

    // Postgres SQLSTATE beats the message text as well
    const pg = mapPgError(
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
        severity: 'ERROR',
      }),
    )
    assert.equal(pg.code, 'TIMEOUT')
    assert.equal(pg.driverCode, '57014')

    // Qdrant's HTTP status beats it too: 404 is NOT_FOUND, never a transport code
    const qdrant = mapQdrantError({ status: 404, message: 'Collection `nope` doesn’t exist' })
    assert.equal(qdrant.code, 'NOT_FOUND')
    assert.equal(qdrant.driverCode, 'HTTP 404')
  })

  test('the core primitives behave as the drivers assume', () => {
    assert.equal(isNetworkErrorCode('ECONNREFUSED'), true)
    assert.equal(isNetworkErrorCode('42P01'), false, 'a SQLSTATE must never read as an errno')
    assert.equal(isNetworkErrorCode(undefined), false)

    assert.equal(readErrno(new Error('x')), undefined)
    assert.equal(readErrno(Object.assign(new Error('x'), { code: 'EPIPE' })), 'EPIPE')

    assert.equal(looksLikeTimeoutMessage('timeout'), true)
    assert.equal(looksLikeTimeoutMessage('TIMED OUT'), true)
    assert.equal(looksLikeTimeoutMessage('relation does not exist'), false)
    // The word has to start the phrase, or "runtime output" reads as a deadline
    assert.equal(looksLikeTimeoutMessage('runtime output was truncated'), false)

    assert.equal(isRetryableErrorCode('CONNECTION_LOST'), true)
    assert.equal(isRetryableErrorCode('SYNTAX_ERROR'), false)

    assert.equal(classifyTransportError(new Error('plain failure')), null)
    assert.equal(classifyTransportError('a string'), null)
  })
})
