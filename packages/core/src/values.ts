import type { LogicalType } from './chunk'

/**
 * The **canonical JS representation** of a cell, per `LogicalType`.
 *
 * ## Why this has to exist
 *
 * `LogicalType` was documented as "a thin bucketing whose only job is to decide
 * how a value renders". It could not do that job, because it said nothing about
 * what the value *is*. So each driver answered separately, and they disagreed —
 * on the same column type, over the same wire:
 *
 * | value                | postgres        | mysql   | sqlite  |
 * |----------------------|-----------------|---------|---------|
 * | `BIGINT 1`           | `"1"` (string)  | `1`     | `1`     |
 * | `TIMESTAMP`          | a `Date` object | ISO str | ISO str |
 * | `DATE '2026-08-01'`  | `Date` at **local** midnight | `'2026-08-01'` | `'2026-08-01'` |
 * | `INTERVAL '1 day'`   | `{ days: 1 }`   | string  | string  |
 *
 * Every row of that table is a bug that reaches the user. The first makes the
 * same number right-aligned in one connection and left-aligned in the next. The
 * third is worse than cosmetic: a `Date` built at local midnight serializes to
 * the **previous day** anywhere east of Greenwich, so a plain calendar date
 * silently shifts by one.
 *
 * ## The rules
 *
 * | logical                   | canonical JS                                   |
 * |---------------------------|------------------------------------------------|
 * | string, uuid, unknown     | `string`                                        |
 * | number                    | `number`, or a decimal `string` when exactness needs one |
 * | bigint                    | `number` inside the safe range, decimal `string` outside |
 * | boolean                   | `boolean`                                       |
 * | date                      | `'YYYY-MM-DD'`                                  |
 * | time                      | `'HH:MM:SS[.fff]'`                              |
 * | timestamp                 | a `string`, never a `Date` (see below)          |
 * | interval                  | `string`                                        |
 * | json, array               | the parsed JSON value                           |
 * | bytes, vector, geo        | `string` (base64 for bytes), or a `TruncatedValue` |
 *
 * Plus `null` for SQL NULL, in every case.
 *
 * ## The one rule worth defending: exact-or-string
 *
 * A 64-bit integer becomes a `number` while that is exact, and a **decimal
 * string** the moment it is not. Never a rounded number, and never a string when
 * a number would have been exact.
 *
 * The alternative — always a string — was rejected because it makes `BIGINT 1`
 * render as `"1"`, right-alignment and all arithmetic downstream gone, in
 * exchange for correctness in a range almost no column ever reaches. The other
 * alternative — always a number — loses data silently: `9007199254740993`
 * becomes `…992` and nothing says so.
 *
 * The same rule covers `number`, where an arbitrary-precision `NUMERIC` arrives
 * from the server as text: it becomes a `number` only when the text and the
 * number are the *same value written the same way*, so `'12345'` is 12345 while
 * `'12345.6700'` and a 40-digit total stay strings.
 *
 * ## What a timestamp is, and what it deliberately is not
 *
 * A timestamp is always a **string** and never a `Date`, which is the part that
 * was actually broken: a `Date` in a chunk is an object the grid has to
 * special-case, `JSON.stringify` renders it in one timezone and the cell renderer
 * in another, and the MCP receipt disagrees with the window.
 *
 * It is *not* forced to a single spelling, and that is a decision rather than an
 * omission. `timestamp` covers both PostgreSQL's `timestamptz`, which names an
 * instant, and MySQL's `DATETIME`, which names a wall-clock reading with no
 * timezone at all. Rewriting the second as `…Z` would invent an offset the server
 * never stated. So a driver that hands over a `Date` — meaning it really does know
 * the instant — gets ISO 8601 in UTC, and a driver that hands over the server's
 * own text keeps it verbatim. Both are strings, which is the property the rest of
 * the system depends on.
 */

/** Bounds of the exactly-representable integer range, as bigints */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/** A decimal integer, optionally signed. What a 64-bit column looks like as text. */
const DECIMAL_INTEGER_RE = /^[+-]?\d+$/

/**
 * A 64-bit integer in canonical form: exact as a `number`, decimal text when a
 * `number` could not hold it.
 *
 * Accepts every shape the four drivers actually produce — `bigint` (node:sqlite
 * with `setReadBigInts`), `number` (mysql2 while the value fits) and `string`
 * (pg's int8 parser, and mysql2 past the safe range).
 */
export function canonicalInteger(value: bigint | number | string): number | string {
  if (typeof value === 'bigint') {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString(10)
  }
  if (typeof value === 'number') {
    // A non-integer in a bigint column means the driver already lost precision;
    // there is nothing left to recover, so pass it through rather than lie
    return value
  }
  const text = value.trim()
  if (!DECIMAL_INTEGER_RE.test(text)) return value
  const big = BigInt(text)
  return big >= MIN_SAFE && big <= MAX_SAFE ? Number(big) : big.toString(10)
}

/**
 * A numeric value in canonical form.
 *
 * Text becomes a `number` only when the round trip is exact *and* spelled the
 * same way. `'12345'` → `12345`; `'12345.6700'` stays text, because dropping the
 * trailing zeros would throw away the column's declared scale; a 40-digit
 * `NUMERIC` stays text, because no `number` can hold it.
 */
export function canonicalNumeric(value: bigint | number | string): number | string {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return canonicalInteger(value)
  const text = value.trim()
  if (text.length === 0) return value
  const n = Number(text)
  if (!Number.isFinite(n)) return value
  return String(n) === text ? n : value
}

/** Two digits, zero-padded — the width every field of a date or a time uses */
function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n)
}

/**
 * A calendar date, as `'YYYY-MM-DD'`.
 *
 * A `Date` is read in **local** time on purpose, and this is the whole point of
 * the function: pg's `date` parser builds a `Date` at local midnight, so
 * `toISOString()` on it reports the previous day for every user west of UTC and
 * the same day only by luck. The date the server sent is the local one.
 */
export function canonicalDate(value: Date | string): string {
  if (typeof value === 'string') return value
  const y = value.getFullYear()
  return `${String(y).padStart(4, '0')}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
}

/** A time of day, as `'HH:MM:SS'` or `'HH:MM:SS.fff'`. Local, for the same reason as `canonicalDate`. */
export function canonicalTime(value: Date | string): string {
  if (typeof value === 'string') return value
  const base = `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`
  const ms = value.getMilliseconds()
  return ms === 0 ? base : `${base}.${String(ms).padStart(3, '0')}`
}

/**
 * An instant, as ISO 8601 in UTC.
 *
 * Unlike a date or a time, a timestamp names a point on the timeline, so UTC is
 * the reading that does not depend on who is looking. An unparsable `Date`
 * (pg returns one for `'infinity'`) keeps its text rather than becoming
 * `'Invalid Date'`.
 */
export function canonicalTimestamp(value: Date | string): string {
  if (typeof value === 'string') return value
  return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
}

/**
 * A duration, as text.
 *
 * pg parses `interval` into a `PostgresInterval` object; mysql and sqlite have no
 * interval type at all and produce text. The object's own `toPostgres()` /
 * `toString()` is preferred when it has one, because it round-trips back into the
 * server; otherwise the fields are rendered in the order postgres writes them.
 */
export function canonicalInterval(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return String(value)
  const rec = value as Record<string, unknown>
  for (const method of ['toPostgres', 'toISOString', 'toString'] as const) {
    const fn = rec[method]
    if (typeof fn === 'function') {
      const text: unknown = (fn as () => unknown).call(value)
      if (typeof text === 'string' && text !== '[object Object]') return text
    }
  }
  const parts: string[] = []
  for (const unit of ['years', 'months', 'days', 'hours', 'minutes', 'seconds'] as const) {
    const n = rec[unit]
    if (typeof n === 'number' && n !== 0) parts.push(`${String(n)} ${unit}`)
  }
  return parts.length > 0 ? parts.join(' ') : '00:00:00'
}

/**
 * A truth value.
 *
 * SQLite has no boolean type — a column declared `BOOLEAN` stores 0 and 1 — and
 * MySQL's `BOOLEAN` is `TINYINT(1)`. A driver that types the column `boolean`
 * has to hand over a boolean, or the grid renders `1` in one database and `true`
 * in the next for the same column definition.
 */
export function canonicalBoolean(value: boolean | number | bigint | string): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'bigint') return value !== 0n
  const text = value.trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false' && text !== 'f' && text !== 'no'
}

/**
 * Coerce one already-parsed driver value into the canonical representation for
 * its column's logical type.
 *
 * **Every driver calls this before anything else in its `normalizeCell`**, which
 * is what makes the table at the top of this file true rather than aspirational.
 * It deliberately does *not* do truncation, base64 or `TruncatedValue` — those
 * need a `ValueRef` factory the driver owns — so the shapes it does not
 * understand (objects for json/array, buffers for bytes) pass through untouched
 * for the driver's own handling.
 */
export function canonicalCell(value: unknown, logical: LogicalType): unknown {
  if (value === null || value === undefined) return null
  switch (logical) {
    case 'bigint':
      return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string'
        ? canonicalInteger(value)
        : value
    case 'number':
      return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string'
        ? canonicalNumeric(value)
        : value
    case 'boolean':
      return typeof value === 'boolean' || typeof value === 'number'
        || typeof value === 'bigint' || typeof value === 'string'
        ? canonicalBoolean(value)
        : value
    case 'date':
      return value instanceof Date || typeof value === 'string' ? canonicalDate(value) : value
    case 'time':
      return value instanceof Date || typeof value === 'string' ? canonicalTime(value) : value
    case 'timestamp':
      return value instanceof Date || typeof value === 'string' ? canonicalTimestamp(value) : value
    case 'interval':
      return canonicalInterval(value)
    case 'string':
    case 'uuid':
    case 'json':
    case 'array':
    case 'bytes':
    case 'vector':
    case 'geo':
    case 'unknown':
      // A Date can still arrive here when a driver's logical mapping is coarser
      // than its runtime types (an expression column in SQLite, say). Letting it
      // through would put a non-JSON object in a chunk.
      return value instanceof Date ? canonicalTimestamp(value) : value
  }
}
