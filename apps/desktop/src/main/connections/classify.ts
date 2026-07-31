import { peekErrorMsg, toPeekError, type PeekError } from '@peek/core'

/* ================================================================== */
/* Timeout budget                                                      */
/* ================================================================== */

/**
 * Default timeout (in ms) for each stage. Callers may override any of them.
 *
 * Note that the query/scan/vectorSearch RPCs **only start the work** — they
 * succeed as soon as a resultId comes back — while the data itself travels the
 * MessagePort. So these are limits on the *start* phase, not on the whole query;
 * the whole-query limit is whatever the caller passes in params.timeoutMs for the
 * driver to enforce.
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
  /** From spawn to the ready event */
  readyMs: 10_000,
  /** The connect RPC (dial + handshake + fetch serverInfo) */
  connectMs: 15_000,
  /** Ordinary control-plane RPCs (introspect / peek / keyvalue) */
  rpcMs: 30_000,
  /** Limit on the start phase of a query or scan; when the caller supplies timeoutMs, use timeoutMs plus the grace period */
  queryStartMs: 60_000,
  /** Extra grace given to the driver to wind down when the caller supplied timeoutMs */
  queryGraceMs: 5_000,
  /** The cancel RPC: past this, escalate to killing the process */
  cancelMs: 2_000,
  /** disconnect RPC */
  disconnectMs: 5_000,
  /** shutdown RPC */
  shutdownMs: 3_000,
  /** How long to wait after kill for the process to actually exit */
  exitMs: 3_000,
}

/* ================================================================== */
/* Error classification                                                */
/* ================================================================== */

/** Authentication / authorization SQLSTATEs (PG class 28) */
const AUTH_SQLSTATES = new Set([
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '28P02', // used by some distributions for SCRAM failure
  '42501', // insufficient_privilege
])

/** Database missing or not accessible */
const DB_NOT_FOUND_SQLSTATES = new Set([
  '3D000', // invalid_catalog_name
  '3F000', // invalid_schema_name
])

/** Syntax error class (PG 42601 and friends); with a position the editor can point at it */
const SYNTAX_SQLSTATES = new Set(['42601', '42P01', '42703', '42883'])

/** Network-layer errnos (node's ECONNREFUSED and the like show up inside `message`) */
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
 * Refine an error raised while connecting.
 *
 * Drivers are expected to produce a precise code/driverCode themselves; this is
 * only a fallback that splits an undifferentiated pile of CONNECTION_FAILED into
 * auth / network / timeout / missing database, so the UI and MCP can say
 * something actionable.
 */
export function classifyConnectError(raw: unknown): PeekError {
  const err = toPeekError(raw, 'CONNECTION_FAILED')

  // Already a definitive terminal classification: leave it alone
  if (err.code === 'CANCELLED' || err.code === 'TIMEOUT' || err.code === 'DRIVER_CRASHED') return err

  const sqlstate = err.driverCode ?? ''
  if (AUTH_SQLSTATES.has(sqlstate)) {
    return {
      ...err,
      code: 'CONNECTION_FAILED',
      // Fallback wording for drivers that give us nothing but a SQLSTATE. It is
      // literal English rather than a catalog key because it substitutes for
      // driver text and travels the same untranslated path.
      message: err.message || 'Authentication failed: wrong user name or password',
      retryable: false,
    }
  }
  if (DB_NOT_FOUND_SQLSTATES.has(sqlstate)) {
    return { ...err, code: 'NOT_FOUND', retryable: false }
  }

  const errno = matchNetworkErrno(err)
  if (errno !== null) {
    const retryable = errno !== 'ENOTFOUND'
    // These hints end up in `detail`, which is never translated (see the rule in
    // @peek/core/error-messages), so they are literal English.
    const hint =
      errno === 'ECONNREFUSED'
        ? 'the target port refused the connection; check that the database is running on that port'
        : errno === 'ENOTFOUND' || errno === 'EAI_AGAIN'
          ? 'host name resolution failed'
          : errno === 'ETIMEDOUT'
            ? 'the network connection timed out'
            : 'network error'
    return {
      ...err,
      code: errno === 'ETIMEDOUT' ? 'TIMEOUT' : 'CONNECTION_FAILED',
      detail: err.detail ? `${hint} (${errno})\n${err.detail}` : `${hint} (${errno})`,
      retryable,
    }
  }

  // Keyword fallback for auth failures (some drivers give no SQLSTATE)
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
 * Refine an error raised during execution (query / scan / introspect / peek).
 * Syntax errors are singled out so the UI can move the cursor to `position`.
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
/* Common error constructors                                            */
/* ------------------------------------------------------------------ */

/**
 * These all build localizable errors: `message` carries canonical English for
 * MCP and the logs, while the attached `{ key, params }` descriptor lets the
 * window render the same thing in the user's language.
 *
 * `operation` and `detail` arguments stay literal English — they name internal
 * operations or pass driver output through, and neither is translated.
 */
export function timeoutError(operation: string, ms: number): PeekError {
  return peekErrorMsg('TIMEOUT', 'error.query.timedOut', { operation, ms }, { retryable: true })
}

export function crashedError(detail?: string): PeekError {
  return peekErrorMsg('DRIVER_CRASHED', 'error.driver.hostExited', undefined, {
    ...(detail === undefined ? {} : { detail }),
    retryable: true,
  })
}

export function notFoundConn(connId: string): PeekError {
  return peekErrorMsg('NOT_FOUND', 'error.conn.notFound', { connId })
}

export function notReadyConn(connId: string, status: string): PeekError {
  return peekErrorMsg('CONFLICT', 'error.conn.notReady', { label: connId, status })
}

export function unsupported(driverId: string, capability: string): PeekError {
  return peekErrorMsg('UNSUPPORTED_CAPABILITY', 'error.conn.unsupportedCapability', {
    driverId,
    capability,
  })
}
