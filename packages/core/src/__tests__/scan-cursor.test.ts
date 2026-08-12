import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DRIVER_IDS,
  PACKAGE_ID_PATTERN,
  decodeRowOffsetCursor,
  decodeScanCursor,
  encodeScanCursor,
  isPeekError,
  rowOffsetCursor,
  tryDecodeScanCursor,
  type DriverId,
} from '../index'

/**
 * The continuation cursor, now that all four drivers mint one shape.
 *
 * Before, `nextCursor` was three unrelated strings that happened to share a
 * field: a bare row offset (`'400'`), a redis SCAN boundary with an intra-page
 * skip (`'238:17'`), and `JSON.stringify` of a qdrant point id (`'"42"'`).
 * Nothing tied a token to the driver that made it, so a token from one store
 * handed to another was **honoured**: qdrant read `'238:17'` as a string point
 * id, scrolled from a point that does not exist, and returned an empty page with
 * no error at all.
 *
 * This file pins the envelope. The per-driver halves — that a redis boundary is a
 * SCAN cursor, that a qdrant boundary round-trips a point id's type, that a SQL
 * boundary is a row offset — are pinned in each driver's own suite.
 */
describe('scan cursor', () => {
  test('round-trips a boundary and an intra-page skip', () => {
    assert.deepEqual(tryDecodeScanCursor(encodeScanCursor({ driverId: 'redis', boundary: '238', skip: 17 })), {
      driverId: 'redis',
      boundary: '238',
      skip: 17,
    })
    // The boundary is driver text and may contain anything, colons included:
    // only the first two colons delimit
    const messy = 'a:b::c"42"'
    assert.equal(
      tryDecodeScanCursor(encodeScanCursor({ driverId: 'qdrant', boundary: messy, skip: 0 }))?.boundary,
      messy,
    )
    assert.equal(
      tryDecodeScanCursor(encodeScanCursor({ driverId: 'postgres', boundary: '', skip: 3 }))?.boundary,
      '',
    )
  })

  test('every id the package pattern admits survives a round trip', () => {
    // The id class inside a cursor token is `PACKAGE_ID_PATTERN` written out, and
    // the two have drifted before: it was `[a-z]+` when every id happened to be
    // pure letters, so `neo4j` minted `neo4j:0:7` and then refused its own
    // output — a scan that silently could not continue past its first page, on
    // that driver only. A package installed from disk can be called `my-db`, so
    // the sample is drawn from the pattern rather than from the six that ship.
    const ids = [...DRIVER_IDS, 'my-db', 'mongo-db-2', '2fast', 'x']
    for (const driverId of ids) {
      assert.ok(PACKAGE_ID_PATTERN.test(driverId), `${driverId} is not a servable id, so it proves nothing`)
      const token = encodeScanCursor({ driverId, boundary: 'a:b', skip: 4 })
      assert.deepEqual(
        tryDecodeScanCursor(token),
        { driverId, boundary: 'a:b', skip: 4 },
        `${driverId} minted a cursor it cannot read back`,
      )
    }
  })

  test('a token names the driver that minted it, so no other driver accepts it', () => {
    for (const mint of DRIVER_IDS) {
      const token = encodeScanCursor({ driverId: mint, boundary: '7', skip: 0 })
      assert.equal(decodeScanCursor(token, mint).boundary, '7')
      for (const other of DRIVER_IDS.filter((d) => d !== mint)) {
        try {
          decodeScanCursor(token, other)
          assert.fail(`${other} must not accept a ${mint} cursor`)
        } catch (err) {
          assert.ok(isPeekError(err))
          assert.equal(err.code, 'BAD_REQUEST')
          // The token is in the message: it is the only thing identifying which
          // stale continuation got replayed
          assert.match(err.message, /7/)
        }
      }
    }
  })

  test('a malformed token is refused rather than read as a fresh scan', () => {
    for (const bad of ['', '400', '238:17', 'postgres:400', 'postgres::400', 'POSTGRES:0:1', '"42"']) {
      assert.equal(tryDecodeScanCursor(bad), null, bad)
      assert.throws(() => decodeScanCursor(bad, 'postgres'), (err: unknown) => isPeekError(err))
    }
    // A skip too large to be an exact integer is not a skip
    assert.equal(tryDecodeScanCursor('redis:99999999999999999999:1'), null)
  })

  /**
   * The relational special case: a boundary that *is* a row offset, so there is
   * never an intra-page remainder to carry.
   */
  test('a row-offset cursor decodes back to the row it addresses', () => {
    for (const driverId of ['postgres', 'mysql', 'sqlite'] as const satisfies readonly DriverId[]) {
      assert.equal(decodeRowOffsetCursor(rowOffsetCursor(driverId, 400), driverId), 400)
      assert.equal(decodeRowOffsetCursor(rowOffsetCursor(driverId, 0), driverId), 0)
    }
    // A boundary that is not a row number is refused, not coerced to 0 — a
    // silent restart from row 0 is a page of rows the caller already saw
    assert.throws(
      () => decodeRowOffsetCursor(encodeScanCursor({ driverId: 'postgres', boundary: 'x', skip: 0 }), 'postgres'),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })
})
