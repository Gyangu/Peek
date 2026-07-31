import { peekError, toPeekError, type PeekError, type PeekErrorCode } from '@peek/core'

/**
 * PostgreSQL 错误分类。
 * 把 pg 抛出的 DatabaseError（带 SQLSTATE）与 node 网络错误统一收敛成 PeekError，
 * 尽量给出精确 code，不依赖 toPeekError 的 INTERNAL 兜底。
 */

/** pg 的 DatabaseError 结构（@types/pg 的 DatabaseError 字段都是可选的，这里只取需要的） */
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
  // pg 的 DatabaseError 一定带 severity + code（string），据此与普通 Error 区分
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

/** node 网络层错误码 → CONNECTION_FAILED */
const NET_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EACCES',
])

/** SQLSTATE → PeekErrorCode。返回 null 表示按 class 前缀继续判断。 */
function codeFromSqlState(sqlState: string, message: string): PeekErrorCode | null {
  switch (sqlState) {
    // query_canceled：PG 用同一个 SQLSTATE 表示"被取消"和"语句超时"，靠文案区分
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

/** 哪些错误值得让用户重试 */
function isRetryable(code: PeekErrorCode, sqlState: string | undefined): boolean {
  if (code === 'CONNECTION_FAILED' || code === 'CONNECTION_LOST' || code === 'TIMEOUT') return true
  if (sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03') return true
  return false
}

export interface MapPgErrorContext {
  /** 出错时执行的语句，放进 detail 便于排查 */
  sql?: string
  /** 无法识别时的兜底 code */
  fallback?: PeekErrorCode
}

/**
 * 把任意 catch 到的东西映射成 PeekError。
 * 驱动里所有对外抛出的错误都必须过这里。
 */
export function mapPgError(value: unknown, ctx: MapPgErrorContext = {}): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'

  const pg = asPgError(value)
  if (pg && pg.code) {
    const sqlState = pg.code
    // node 网络错误也走 code 字段，但不是 5 位 SQLSTATE
    if (NET_ERROR_CODES.has(sqlState)) {
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

  // 非 pg 错误：AbortError / 超时 / 普通 Error
  if (value instanceof Error) {
    if (value.name === 'AbortError') return peekError('CANCELLED', value.message || '操作已取消')
    const errno = (value as unknown as Record<string, unknown>)['code']
    if (typeof errno === 'string' && NET_ERROR_CODES.has(errno)) {
      return peekError('CONNECTION_FAILED', value.message, { driverCode: errno, retryable: true })
    }
    if (/timeout/i.test(value.message)) {
      return peekError('TIMEOUT', value.message, { retryable: true })
    }
  }
  return toPeekError(value, fallback)
}

/** 抛出结构化错误（保持调用点简洁） */
export function throwPeek(code: PeekErrorCode, message: string, detail?: string): never {
  throw peekError(code, message, detail === undefined ? undefined : { detail })
}
