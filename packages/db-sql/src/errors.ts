import {
  classifyAbortError,
  classifyTransportError,
  isPeekError,
  isRetryableErrorCode,
  peekError,
  toPeekError,
  type MapDriverErrorContext,
  type PeekError,
  type PeekErrorCode,
} from '@peek/core'
import type { SqlDialect } from './dialect'

/**
 * SQL error classification.
 *
 * Same contract as `mapPgError` and `mapRedisError`, and the same rule about
 * language: **server text is never localized**. `Table 'peek_test.nope' doesn't
 * exist` is evidence the user greps for, so it travels verbatim in
 * `PeekError.message` with no `i18n` descriptor. Only peek-authored text goes
 * through the catalog.
 *
 * The classification itself is split in two:
 *
 * 1. the dialect maps its own code (`ER_NO_SUCH_TABLE`, SQLite's extended result
 *    code) to a `PeekErrorCode`, because that table is exactly what differs;
 * 2. abort signals, socket errnos and bare timeout messages do not differ at all
 *    — not between the two dialects, and not between this driver and the other
 *    three — so they are classified by `classifyTransportError` in core.
 *
 * `driverCode` always carries the native code where there is one: that is the
 * string a user pastes into a search engine, and dropping it makes every error
 * look the same.
 */

export interface MapSqlErrorContext extends MapDriverErrorContext {
  /** The statement that failed; goes into `detail`, never into `message` */
  sql?: string
}

/**
 * Map anything caught into a PeekError. Every error a SQL driver throws outward
 * passes through here.
 *
 * Implementations must fill in, at minimum:
 * - `driverCode`: MySQL's `err.code` (`ER_*`) or `err.errno`; SQLite's
 *   `err.code` (`ERR_SQLITE_ERROR`) alongside `err.errcode` / `err.errstr`;
 * - `position`: MySQL does not report one, SQLite does not either — so this stays
 *   undefined for both, and the editor simply does not underline. Do **not**
 *   invent an offset by regex-matching the message.
 */
export function mapSqlError(
  dialect: SqlDialect,
  value: unknown,
  ctx: MapSqlErrorContext = {},
): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'
  // A PeekError raised inside the driver is already classified; re-mapping it
  // would relabel a deliberate BAD_REQUEST as a QUERY_FAILED
  if (isPeekError(value)) return value

  if (value instanceof Error) {
    const aborted = classifyAbortError(value)
    if (aborted !== null) return aborted

    const rec = value as unknown as Record<string, unknown>
    const code = typeof rec['code'] === 'string' ? rec['code'] : undefined
    // mysql2 puts the numeric code on `errno`; node:sqlite puts it on `errcode`
    const errno = numberOf(rec['errno']) ?? numberOf(rec['errcode'])

    // The dialect's own table first: it is the only layer that knows what
    // `ER_LOCK_WAIT_TIMEOUT` or SQLite result code 8 actually mean
    const classified = dialect.classifyError(code, errno)
    if (classified !== null) {
      return peekError(classified, value.message, {
        ...driverCodeOf(code, errno),
        ...detailOf(rec, ctx),
        ...(isRetryable(classified) ? { retryable: true } : {}),
      })
    }

    // A socket errno, or — since mysql2 reports its own connect/acquire deadlines
    // as plain Errors with no code at all — a message that says "timed out"
    const transport = classifyTransportError(value, detailOf(rec, ctx))
    if (transport !== null) return transport

    if (code !== undefined || errno !== undefined) {
      return peekError(fallback, value.message, {
        ...driverCodeOf(code, errno),
        ...detailOf(rec, ctx),
      })
    }
  }
  return toPeekError(value, fallback)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The code a user pastes into a search engine.
 *
 * MySQL's `ER_*` name is that string. SQLite's `err.code` is always the useless
 * `ERR_SQLITE_ERROR`, so the numeric result code is appended — `ERR_SQLITE_ERROR`
 * alone makes a missing table and a corrupt file look identical.
 */
function driverCodeOf(code: string | undefined, errno: number | undefined): { driverCode?: string } {
  if (code === undefined) return errno === undefined ? {} : { driverCode: String(errno) }
  return { driverCode: errno === undefined ? code : `${code} (${errno})` }
}

/** `detail` collects the evidence: SQLite's `errstr`, MySQL's `sqlState`, and the statement */
function detailOf(rec: Record<string, unknown>, ctx: MapSqlErrorContext): { detail?: string } {
  const parts: string[] = []
  if (typeof rec['errstr'] === 'string' && rec['errstr'].length > 0) parts.push(rec['errstr'])
  if (typeof rec['sqlState'] === 'string' && rec['sqlState'].length > 0) {
    parts.push(`SQLSTATE: ${rec['sqlState']}`)
  }
  if (ctx.sql !== undefined) parts.push(`SQL: ${ctx.sql}`)
  return parts.length > 0 ? { detail: parts.join('\n') } : {}
}

/**
 * Which failures are worth the user's time to retry.
 *
 * `CONFLICT` is deliberately absent even though `SQLITE_BUSY` belongs to it: the
 * same code also carries `SQLITE_READONLY` and MySQL's
 * `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`, which peek causes **on purpose** and
 * which retrying will never fix.
 */
function isRetryable(code: PeekErrorCode): boolean {
  return isRetryableErrorCode(code)
}

