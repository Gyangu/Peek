import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  canonicalBoolean,
  canonicalCell,
  canonicalDate,
  canonicalInteger,
  canonicalInterval,
  canonicalNumeric,
  canonicalTime,
  canonicalTimestamp,
} from '../index'

/**
 * The canonical JS representation of a cell, per `LogicalType`.
 *
 * The bug this pins: `BIGINT 1` came back as the number `1` from MySQL and
 * SQLite and as the string `"1"` from PostgreSQL, because each driver decided
 * for itself what a logical type *is* in JS. The same column definition rendered
 * right-aligned in one connection and left-aligned in the next, and nothing in
 * the type system had an opinion.
 *
 * The live counterparts are in each driver's own suite (they need a server);
 * this file pins the rule those four assertions share.
 */
describe('canonical cell representation', () => {
  test('a 64-bit integer is exact as a number, or decimal text — never rounded', () => {
    // Every shape the four drivers actually produce for the same BIGINT 1
    assert.equal(canonicalInteger(1n), 1, 'sqlite hands over a bigint for every INTEGER')
    assert.equal(canonicalInteger(1), 1, 'mysql2 hands over a number while it fits')
    assert.equal(canonicalInteger('1'), 1, "pg's int8 parser hands over a string, always")

    // Past 2^53 the number is the lie, so the text is what travels
    assert.equal(canonicalInteger(9007199254740993n), '9007199254740993')
    assert.equal(canonicalInteger('9007199254740993'), '9007199254740993')
    assert.equal(canonicalInteger(-9007199254740993n), '-9007199254740993')
    // Exactly at the boundary is still exact
    assert.equal(canonicalInteger(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)

    // Not decimal text at all: pass it through rather than invent a number
    assert.equal(canonicalInteger('0x10'), '0x10')
    assert.equal(canonicalInteger(''), '')
  })

  test('an arbitrary-precision number keeps its text when a JS number would change it', () => {
    assert.equal(canonicalNumeric('12345'), 12345)
    assert.equal(canonicalNumeric('0.1'), 0.1)
    assert.equal(canonicalNumeric(1.5), 1.5)
    // Trailing zeros are the column's declared scale; dropping them is data loss
    assert.equal(canonicalNumeric('12345.6700'), '12345.6700')
    // 40 digits cannot be a JS number at all
    assert.equal(canonicalNumeric('1'.repeat(40)), '1'.repeat(40))
    assert.equal(canonicalNumeric('not a number'), 'not a number')
  })

  /**
   * The failure that is worse than cosmetic.
   *
   * pg's `date` parser builds a `Date` at **local** midnight. Serializing that
   * with `toISOString()` reports the previous day for anyone west of UTC — a
   * calendar date, silently off by one, with nothing in the pipeline to notice.
   */
  test('a calendar date is read in local time, so it cannot shift by a day', () => {
    const localMidnight = new Date(2026, 7, 1, 0, 0, 0)
    assert.equal(canonicalDate(localMidnight), '2026-08-01')
    // …which is exactly what the naive reading gets wrong in a western timezone
    assert.equal(canonicalDate('2026-08-01'), '2026-08-01', 'text from mysql/sqlite passes through')
    // Year 9 AD: `new Date(9, …)` would mean 1909, so it has to be set explicitly
    const ancient = new Date(2000, 0, 2)
    ancient.setFullYear(9)
    assert.equal(canonicalDate(ancient), '0009-01-02', 'years stay four digits')
  })

  test('a time is local wall-clock, a timestamp is UTC', () => {
    assert.equal(canonicalTime(new Date(2026, 7, 1, 13, 5, 9)), '13:05:09')
    assert.equal(canonicalTime(new Date(2026, 7, 1, 13, 5, 9, 40)), '13:05:09.040')
    assert.equal(canonicalTime('00:01:02'), '00:01:02')

    // An instant names a point on the timeline, so UTC is the reading that does
    // not depend on who is looking
    assert.equal(
      canonicalTimestamp(new Date(Date.UTC(2026, 7, 1, 11, 31, 42, 819))),
      '2026-08-01T11:31:42.819Z',
    )
    assert.equal(canonicalTimestamp('2026-08-01 11:31:42'), '2026-08-01 11:31:42')
    // pg returns an unparsable Date for 'infinity'; it must not become 'Invalid Date'
    assert.equal(typeof canonicalTimestamp(new Date(Number.NaN)), 'string')
  })

  test('an interval becomes text, whatever object shape the driver parsed it into', () => {
    assert.equal(canonicalInterval('1 day'), '1 day')
    // pg's PostgresInterval, which knows how to write itself back
    assert.equal(canonicalInterval({ days: 1, toPostgres: () => '1 day' }), '1 day')
    // A plain object with no serializer at all still has to produce something readable
    assert.equal(canonicalInterval({ days: 1, hours: 2 }), '1 days 2 hours')
    assert.equal(canonicalInterval({}), '00:00:00')
  })

  test('a truth value is a boolean, even where the database has no boolean type', () => {
    // SQLite stores 0/1; MySQL's BOOLEAN is TINYINT(1)
    assert.equal(canonicalBoolean(1), true)
    assert.equal(canonicalBoolean(0), false)
    assert.equal(canonicalBoolean(1n), true)
    assert.equal(canonicalBoolean('t'), true)
    assert.equal(canonicalBoolean('false'), false)
    assert.equal(canonicalBoolean('0'), false)
    assert.equal(canonicalBoolean(true), true)
  })

  test('canonicalCell dispatches on the logical type and leaves the rest alone', () => {
    assert.equal(canonicalCell(null, 'bigint'), null)
    assert.equal(canonicalCell(undefined, 'string'), null)
    assert.equal(canonicalCell('1', 'bigint'), 1)
    // The very same '1' is text when the column is text
    assert.equal(canonicalCell('1', 'string'), '1')

    // json / array are already parsed values and must survive untouched, by
    // identity — re-serializing a million of them per result set is not free
    const payload = { a: [1, 2] }
    assert.equal(canonicalCell(payload, 'json'), payload)

    // A Date reaching a column whose logical type is coarser than its runtime
    // type must still not end up inside a chunk as an object
    assert.equal(canonicalCell(new Date(Date.UTC(2026, 0, 1)), 'unknown'), '2026-01-01T00:00:00.000Z')

    // Buffers belong to the driver's own truncation path, so they pass through
    const bytes = new Uint8Array([1, 2, 3])
    assert.equal(canonicalCell(bytes, 'bytes'), bytes)
  })
})
