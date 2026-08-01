import {
  classifyTransportError,
  isNetworkErrorCode,
  isRetryableErrorCode,
  peekError,
  toPeekError,
  type MapDriverErrorContext,
  type PeekError,
  type PeekErrorCode,
} from '@peek/core'

/**
 * PostgreSQL error classification.
 *
 * Collapses everything the driver can throw — pg's `DatabaseError` (carrying a
 * SQLSTATE) and node's network errnos — into a single `PeekError`, picking the
 * most precise code available rather than falling back on `toPeekError`'s
 * INTERNAL catch-all.
 *
 * **Nothing here is localizable.** The text produced by this module comes
 * straight from the server or the socket layer and is passed through verbatim,
 * with no `i18n` descriptor attached. `relation "usres" does not exist` is not
 * prose, it is evidence: the user searches for it, diffs it against the server
 * log, and spots the typo in it. `detail`, `driverCode` and `position` are
 * likewise never translated.
 *
 * Only the SQLSTATE table below is postgres-specific. Aborts, socket errnos and
 * bare timeout messages are classified by `classifyTransportError` in core, which
 * is shared with the other three drivers — see the note on it for why that split
 * is where it is.
 */

/** The shape of pg's DatabaseError (@types/pg marks every field optional; only these are used) */
interface PgErrorShape {
  message: string
  code?: string
  detail?: string
  hint?: string
  position?: string
  where?: string
  schema?: string
  table?: string
  column?: string
  routine?: string
  severity?: string
}

function asPgError(value: unknown): PgErrorShape | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['message'] !== 'string') return null
  // pg's DatabaseError always carries severity + code (both strings); that is
  // what separates it from a plain Error here
  if (typeof v['code'] !== 'string') return null
  const out: PgErrorShape = { message: v['message'], code: v['code'] }
  if (typeof v['detail'] === 'string') out.detail = v['detail']
  if (typeof v['hint'] === 'string') out.hint = v['hint']
  if (typeof v['position'] === 'string') out.position = v['position']
  if (typeof v['where'] === 'string') out.where = v['where']
  if (typeof v['schema'] === 'string') out.schema = v['schema']
  if (typeof v['table'] === 'string') out.table = v['table']
  if (typeof v['routine'] === 'string') out.routine = v['routine']
  if (typeof v['severity'] === 'string') out.severity = v['severity']
  return out
}

/**
 * SQLSTATE → PeekErrorCode.
 *
 * Two passes: an exact table for the codes worth distinguishing, then the
 * two-character SQLSTATE class as a catch-all. Returning null means "no exact
 * match, fall through to the class prefix".
 */
function codeFromSqlState(sqlState: string, message: string): PeekErrorCode | null {
  switch (sqlState) {
    // query_canceled: PG reuses one SQLSTATE for "cancelled" and "statement
    // timed out"; the message text is the only thing telling them apart
    case '57014':
      return /statement timeout|lock timeout|idle-session timeout/i.test(message) ? 'TIMEOUT' : 'CANCELLED'
    case '42601': // syntax_error
      return 'SYNTAX_ERROR'
    case '42P01': // undefined_table
    case '42703': // undefined_column
    case '3F000': // invalid_schema_name
      return 'NOT_FOUND'
    case '53300': // too_many_connections
    case '53400': // configuration_limit_exceeded
      return 'CONNECTION_FAILED'
    case '28000': // invalid_authorization_specification
    case '28P01': // invalid_password
    case '3D000': // invalid_catalog_name
      return 'CONNECTION_FAILED'
    case '57P01': // admin_shutdown
    case '57P02': // crash_shutdown
    case '57P03': // cannot_connect_now
      return 'CONNECTION_LOST'
    case '25P02': // in_failed_sql_transaction
      return 'QUERY_FAILED'
    default:
      break
  }
  switch (sqlState.slice(0, 2)) {
    case '08': // connection_exception
      return 'CONNECTION_LOST'
    case '42': // syntax_error_or_access_rule_violation
    case '22': // data_exception
    case '23': // integrity_constraint_violation
    case '2B':
    case '2D':
    case '40': // transaction_rollback
    case '55': // object_not_in_prerequisite_state
      return 'QUERY_FAILED'
    case '53':
      return 'CONNECTION_FAILED'
    case '58': // system_error
    case 'XX': // internal_error
      return 'INTERNAL'
    default:
      return null
  }
}

/**
 * Which failures are worth the user's time to retry.
 *
 * The transport half is core's `isRetryableErrorCode`; the SQLSTATEs added on top
 * are the postgres-only half — serialization failure, deadlock, lock_not_available.
 */
function isRetryable(code: PeekErrorCode, sqlState: string | undefined): boolean {
  if (isRetryableErrorCode(code)) return true
  return sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03'
}

export interface MapPgErrorContext extends MapDriverErrorContext {
  /** The statement that failed; goes into `detail` to make the error diagnosable */
  sql?: string
}

/**
 * Map anything caught into a PeekError.
 * Every error this driver throws outward has to pass through here.
 */
export function mapPgError(value: unknown, ctx: MapPgErrorContext = {}): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'

  const pg = asPgError(value)
  if (pg && pg.code) {
    const sqlState = pg.code
    // node network errors also land in `code`, but they are not 5-char SQLSTATEs
    if (isNetworkErrorCode(sqlState)) {
      return peekError('CONNECTION_FAILED', pg.message, {
        driverCode: sqlState,
        retryable: true,
        ...(ctx.sql === undefined ? {} : { detail: ctx.sql }),
      })
    }
    const code = codeFromSqlState(sqlState, pg.message) ?? fallback
    const detailParts: string[] = []
    if (pg.detail) detailParts.push(pg.detail)
    if (pg.hint) detailParts.push(`HINT: ${pg.hint}`)
    if (pg.where) detailParts.push(`WHERE: ${pg.where}`)
    if (ctx.sql) detailParts.push(`SQL: ${ctx.sql}`)
    const pos = pg.position === undefined ? Number.NaN : Number.parseInt(pg.position, 10)
    return peekError(code, pg.message, {
      driverCode: sqlState,
      ...(detailParts.length > 0 ? { detail: detailParts.join('\n') } : {}),
      ...(Number.isFinite(pos) && pos > 0 ? { position: pos } : {}),
      ...(isRetryable(code, sqlState) ? { retryable: true } : {}),
    })
  }

  // Not a pg error: AbortError, a socket errno, or a bare timeout message
  return classifyTransportError(value) ?? toPeekError(value, fallback)
}

