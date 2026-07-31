import { peekError, toPeekError, type PeekError } from '@peek/core'

/* ================================================================== */
/* 超时预算                                                            */
/* ================================================================== */

/**
 * 各阶段的默认超时（毫秒）。调用方可以按需覆盖。
 *
 * 注意 query/scan/vectorSearch 的 RPC **只是发起**（返回 resultId 就算成功），
 * 真正的数据走 MessagePort，所以这里的超时是"发起阶段"的上限，
 * 不是整条查询的上限——整条查询的上限由调用方传进 params.timeoutMs 交给驱动执行。
 */
export interface Timeouts {
  readyMs: number
  connectMs: number
  rpcMs: number
  queryStartMs: number
  queryGraceMs: number
  cancelMs: number
  disconnectMs: number
  shutdownMs: number
  exitMs: number
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  /** spawn 到收到 ready 事件 */
  readyMs: 10_000,
  /** connect RPC（建连 + 握手 + 取 serverInfo） */
  connectMs: 15_000,
  /** 普通控制面 RPC（introspect / peek / keyvalue） */
  rpcMs: 30_000,
  /** 查询/扫描的发起阶段上限；调用方给了 timeoutMs 就用 timeoutMs + 宽限 */
  queryStartMs: 60_000,
  /** 调用方给了 timeoutMs 时额外留给驱动收尾的宽限 */
  queryGraceMs: 5_000,
  /** cancel RPC：超过这个时间就升级为强杀进程 */
  cancelMs: 2_000,
  /** disconnect RPC */
  disconnectMs: 5_000,
  /** shutdown RPC */
  shutdownMs: 3_000,
  /** kill 之后等进程真正退出 */
  exitMs: 3_000,
}

/* ================================================================== */
/* 错误分类                                                            */
/* ================================================================== */

/** 认证/授权类 SQLSTATE（PG 28 类） */
const AUTH_SQLSTATES = new Set([
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '28P02', // 部分发行版用于 SCRAM 失败
  '42501', // insufficient_privilege
])

/** 库不存在 / 无权访问 */
const DB_NOT_FOUND_SQLSTATES = new Set([
  '3D000', // invalid_catalog_name
  '3F000', // invalid_schema_name
])

/** 语法错误类（PG 42601 等），带 position 时编辑器可定位 */
const SYNTAX_SQLSTATES = new Set(['42601', '42P01', '42703', '42883'])

/** 网络层 errno（node 的 ECONNREFUSED 之类会出现在 message 里） */
const NETWORK_ERRNOS = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
] as const

function haystack(err: PeekError): string {
  return `${err.driverCode ?? ''} ${err.message} ${err.detail ?? ''}`.toUpperCase()
}

function matchNetworkErrno(err: PeekError): string | null {
  const text = haystack(err)
  for (const errno of NETWORK_ERRNOS) {
    if (text.includes(errno)) return errno
  }
  return null
}

/**
 * 建连阶段的错误细化。
 *
 * 驱动应当自己给出精确的 code/driverCode；这里只做兜底细化，
 * 把"一坨 CONNECTION_FAILED"拆成认证 / 网络 / 超时 / 库不存在，
 * 让 UI 和 MCP 能给出可操作的提示。
 */
export function classifyConnectError(raw: unknown): PeekError {
  const err = toPeekError(raw, 'CONNECTION_FAILED')

  // 已经是明确的终态分类就不再动
  if (err.code === 'CANCELLED' || err.code === 'TIMEOUT' || err.code === 'DRIVER_CRASHED') return err

  const sqlstate = err.driverCode ?? ''
  if (AUTH_SQLSTATES.has(sqlstate)) {
    return {
      ...err,
      code: 'CONNECTION_FAILED',
      message: err.message || '认证失败：用户名或密码不正确',
      retryable: false,
    }
  }
  if (DB_NOT_FOUND_SQLSTATES.has(sqlstate)) {
    return { ...err, code: 'NOT_FOUND', retryable: false }
  }

  const errno = matchNetworkErrno(err)
  if (errno !== null) {
    const retryable = errno !== 'ENOTFOUND'
    const hint =
      errno === 'ECONNREFUSED'
        ? '目标端口拒绝连接，确认数据库是否在运行、端口是否正确'
        : errno === 'ENOTFOUND' || errno === 'EAI_AGAIN'
          ? '主机名解析失败'
          : errno === 'ETIMEDOUT'
            ? '网络连接超时'
            : '网络错误'
    return {
      ...err,
      code: errno === 'ETIMEDOUT' ? 'TIMEOUT' : 'CONNECTION_FAILED',
      detail: err.detail ? `${hint}（${errno}）\n${err.detail}` : `${hint}（${errno}）`,
      retryable,
    }
  }

  // 认证提示词兜底（部分驱动不给 SQLSTATE）
  const text = haystack(err)
  if (
    text.includes('PASSWORD AUTHENTICATION FAILED')
    || text.includes('AUTHENTICATION FAILED')
    || text.includes('NO PG_HBA.CONF ENTRY')
    || text.includes('WRONGPASS')
    || text.includes('NOAUTH')
    || text.includes('UNAUTHORIZED')
  ) {
    return { ...err, code: 'CONNECTION_FAILED', retryable: false }
  }

  return { ...err, code: err.code === 'INTERNAL' ? 'CONNECTION_FAILED' : err.code }
}

/**
 * 执行阶段（query / scan / introspect / peek）的错误细化。
 * 语法错误单拎出来，UI 才能把光标定位到 position。
 */
export function classifyExecError(raw: unknown): PeekError {
  const err = toPeekError(raw, 'QUERY_FAILED')
  if (err.code === 'CANCELLED' || err.code === 'TIMEOUT' || err.code === 'DRIVER_CRASHED') return err

  const sqlstate = err.driverCode ?? ''
  if (SYNTAX_SQLSTATES.has(sqlstate) || (sqlstate.startsWith('42') && err.position !== undefined)) {
    return { ...err, code: 'SYNTAX_ERROR', retryable: false }
  }
  if (matchNetworkErrno(err) !== null) {
    return { ...err, code: 'CONNECTION_LOST', retryable: true }
  }
  return err
}

/* ------------------------------------------------------------------ */
/* 常用错误构造                                                         */
/* ------------------------------------------------------------------ */

export function timeoutError(what: string, ms: number): PeekError {
  return peekError('TIMEOUT', `${what} 超时（${ms}ms）`, { retryable: true })
}

export function crashedError(detail?: string): PeekError {
  return peekError('DRIVER_CRASHED', 'driver 进程已退出', {
    ...(detail === undefined ? {} : { detail }),
    retryable: true,
  })
}

export function notFoundConn(connId: string): PeekError {
  return peekError('NOT_FOUND', `连接不存在：${connId}`)
}

export function notReadyConn(connId: string, status: string): PeekError {
  return peekError('CONFLICT', `连接 ${connId} 当前状态为 ${status}，无法执行该操作`)
}

export function unsupported(capability: string): PeekError {
  return peekError('UNSUPPORTED_CAPABILITY', `当前驱动不支持能力：${capability}`)
}
