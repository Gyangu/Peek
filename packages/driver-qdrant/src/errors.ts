import { peekError, toPeekError, type PeekError, type PeekErrorCode } from '@peek/core'

/**
 * Qdrant error classification.
 *
 * Qdrant is an HTTP API, so the status code plays the role SQLSTATE plays in
 * postgres and the reply prefix plays in redis. `@qdrant/js-client-rest` throws
 * an `ApiError`-ish object carrying `status` and the response body; both are read
 * structurally here so a client upgrade cannot break the mapping.
 *
 * **Nothing here is localizable**: the server's message ("Not existing vector
 * name error: title") is evidence and passes through verbatim, with no `i18n`
 * descriptor. Peek-authored text uses the catalog keys in core.
 */

const NET_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * HTTP status → PeekErrorCode.
 *
 * 400 is QUERY_FAILED rather than BAD_REQUEST because by the time qdrant rejects
 * a body, peek built that body — a 400 means peek's request was wrong, and
 * BAD_REQUEST would point the user at their own input instead.
 * 404 is NOT_FOUND; 409 CONFLICT; 429 and 5xx are retryable.
 */
export function codeFromHttpStatus(status: number): PeekErrorCode {
  if (status === 401 || status === 403) return 'CONNECTION_FAILED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 429) return 'CONFLICT'
  if (status >= 500) return 'CONNECTION_LOST'
  if (status >= 400) return 'QUERY_FAILED'
  return 'INTERNAL'
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/** The shape `@qdrant/js-client-rest` throws; every field read structurally */
interface QdrantApiErrorShape {
  status: number
  message: string
  detail?: string
}

function asApiError(value: unknown): QdrantApiErrorShape | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const status = v['status']
  if (typeof status !== 'number') return null
  // The client nests the server's explanation under data.status.error
  const data = v['data']
  let detail: string | undefined
  let message: string | undefined
  if (typeof data === 'object' && data !== null) {
    const inner = (data as Record<string, unknown>)['status']
    if (typeof inner === 'object' && inner !== null) {
      const err = (inner as Record<string, unknown>)['error']
      if (typeof err === 'string') message = err
    }
    if (message === undefined) detail = safeJson(data)
  }
  if (message === undefined) {
    const m = v['message']
    message = typeof m === 'string' ? m : `Qdrant returned HTTP ${status}`
  }
  return { status, message, ...(detail === undefined ? {} : { detail }) }
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

export interface MapQdrantErrorContext {
  /** The API call that failed, e.g. 'POST /collections/docs/points/scroll'; goes into `detail` */
  request?: string
  fallback?: PeekErrorCode
}

/**
 * Map anything caught into a PeekError.
 * Every error this driver throws outward has to pass through here.
 */
export function mapQdrantError(value: unknown, ctx: MapQdrantErrorContext = {}): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'

  const api = asApiError(value)
  if (api) {
    const code = codeFromHttpStatus(api.status)
    const detailParts: string[] = []
    if (api.detail) detailParts.push(api.detail)
    if (ctx.request) detailParts.push(`REQUEST: ${ctx.request}`)
    return peekError(code, api.message, {
      driverCode: `HTTP ${api.status}`,
      ...(detailParts.length > 0 ? { detail: detailParts.join('\n') } : {}),
      ...(isRetryable(api.status) ? { retryable: true } : {}),
    })
  }

  if (value instanceof Error) {
    if (value.name === 'AbortError') {
      return peekError('CANCELLED', value.message || 'Operation cancelled')
    }
    // undici wraps the socket error; the errno may be one level down in `cause`
    const errno = readErrno(value)
    if (errno !== undefined && NET_ERROR_CODES.has(errno)) {
      return peekError('CONNECTION_FAILED', value.message, { driverCode: errno, retryable: true })
    }
    if (/timed? ?out/i.test(value.message)) {
      return peekError('TIMEOUT', value.message, { retryable: true })
    }
  }

  return toPeekError(value, fallback)
}

function readErrno(err: Error): string | undefined {
  const direct = (err as unknown as Record<string, unknown>)['code']
  if (typeof direct === 'string') return direct
  const cause = (err as unknown as Record<string, unknown>)['cause']
  if (typeof cause === 'object' && cause !== null) {
    const nested = (cause as Record<string, unknown>)['code']
    if (typeof nested === 'string') return nested
  }
  return undefined
}
