import { z } from 'zod'
import { formatErrorMessage, type ErrorMessageKey, type ErrorMessageParams } from './error-messages'
import type { MessageParamMap } from './messages'

/**
 * Structured error. The whole chain (driver host → main → renderer → MCP) is
 * allowed to carry exactly this shape and nothing else; throwing a raw Error
 * across IPC is forbidden, because structured clone drops everything but `stack`.
 */
export const PEEK_ERROR_CODES = [
  /** Malformed input (zod validation failed, reference to a non-existent id, …) */
  'BAD_REQUEST',
  /** Target missing (connId / viewId / panelId / resultId not found) */
  'NOT_FOUND',
  /** State conflict (e.g. running a query against a connection that is not ready) */
  'CONFLICT',
  /** The driver does not have that capability */
  'UNSUPPORTED_CAPABILITY',
  /** Could not establish the connection */
  'CONNECTION_FAILED',
  /** The connection dropped mid-flight */
  'CONNECTION_LOST',
  /** Query execution failed (the database returned an error) */
  'QUERY_FAILED',
  /** Statement syntax error (with `position` the editor can point at it) */
  'SYNTAX_ERROR',
  /** Timed out */
  'TIMEOUT',
  /** Cancelled on purpose */
  'CANCELLED',
  /** The driver host process crashed or exited */
  'DRIVER_CRASHED',
  /** Catch-all */
  'INTERNAL',
] as const

export const PeekErrorCodeSchema = z.enum(PEEK_ERROR_CODES)
export type PeekErrorCode = z.infer<typeof PeekErrorCodeSchema>

/**
 * Localization descriptor: what the renderer needs to say the same thing in the
 * user's language.
 *
 * `key` is typed as a plain string on the wire on purpose. `ErrorMessageKey`
 * governs the *construction* helpers, so a typo is still a compile error, but a
 * driver host built from a slightly older bundle must not have its error rejected
 * by schema validation — a stale key should degrade to the English `message`,
 * not vanish into a validation failure the user cannot act on.
 */
export const PeekErrorI18nSchema = z.object({
  key: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})

export type PeekErrorI18n = z.infer<typeof PeekErrorI18nSchema>

export const PeekErrorSchema = z.object({
  code: PeekErrorCodeSchema,
  /**
   * One line of plain English, always present.
   *
   * This is the canonical, locale-independent text: it is what MCP hands to the
   * AI, what the command log records, and what the renderer falls back to when
   * there is no `i18n` descriptor. It is **not** what a localized UI displays
   * when `i18n` is set.
   */
  message: z.string(),
  /**
   * Present only for messages peek itself authored. Absent means "this text came
   * from the database driver, show it verbatim" — see the rule on `peekErrorMsg`.
   */
  i18n: PeekErrorI18nSchema.optional(),
  /** Detail, possibly multi-line (driver output, SQL fragment, …). Never translated. */
  detail: z.string().optional(),
  /** The driver's own error code, e.g. PostgreSQL SQLSTATE '42P01' */
  driverCode: z.string().optional(),
  /** Character offset of a syntax error within the statement (1-based, same as PG's `position`) */
  position: z.number().int().nonnegative().optional(),
  /** Whether retrying is worth the user's time */
  retryable: z.boolean().optional(),
})

export type PeekError = z.infer<typeof PeekErrorSchema>

export type PeekErrorExtra = Omit<PeekError, 'code' | 'message'>

/**
 * Build a structured error from literal English text.
 *
 * Use this when the text is **not** meant to be translated:
 *   - it came out of the driver (SQLSTATE message, socket errno);
 *   - it is internal plumbing only a developer will ever read;
 *   - it is on the MCP path, where the language must stay English forever.
 *
 * For anything a user reads in the window, use `peekErrorMsg` instead.
 */
export function peekError(code: PeekErrorCode, message: string, extra?: PeekErrorExtra): PeekError {
  return { code, message, ...extra }
}

/**
 * Build a structured, **localizable** error from a catalog key.
 *
 * Fills `message` with the canonical English rendering and attaches the
 * `{ key, params }` descriptor the renderer needs to say it in another language.
 * The call site therefore declares its wording once, in `error-messages.ts`, and
 * both audiences stay in sync automatically.
 *
 *   peekErrorMsg('NOT_FOUND', 'error.conn.notFound', { connId })
 *   → { code: 'NOT_FOUND',
 *       message: 'Connection c_17 does not exist',
 *       i18n: { key: 'error.conn.notFound', params: { connId: 'c_17' } } }
 *
 * Params are checked against the placeholders in the English template, so a
 * misspelled or missing param fails the build rather than leaking `{connId}`
 * into the UI.
 */
export function peekErrorMsg<K extends ErrorMessageKey>(
  code: PeekErrorCode,
  key: K,
  params?: ErrorMessageParams<K>,
  extra?: PeekErrorExtra,
): PeekError {
  const bag = params as MessageParamMap | undefined
  return {
    code,
    message: formatErrorMessage(key, bag),
    i18n: bag === undefined ? { key } : { key, params: bag },
    ...extra,
  }
}

export function isPeekError(value: unknown): value is PeekError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['code'] === 'string' && typeof v['message'] === 'string'
    && (PEEK_ERROR_CODES as readonly string[]).includes(v['code'])
}

/**
 * Collapse anything caught into a PeekError.
 * Drivers should produce a precise code / driverCode at their own layer rather
 * than leaning on this fallback.
 */
export function toPeekError(value: unknown, fallback: PeekErrorCode = 'INTERNAL'): PeekError {
  if (isPeekError(value)) return value
  if (value instanceof Error) {
    const extra: PeekErrorExtra = {}
    if (value.stack) extra.detail = value.stack
    // AbortError, DOMException and friends all mean the same thing here
    const code = value.name === 'AbortError' ? 'CANCELLED' : fallback
    return { code, message: value.message || value.name, ...extra }
  }
  if (typeof value === 'string') return { code: fallback, message: value }
  return { code: fallback, message: 'Unknown error', detail: safeStringify(value) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A zod failure as one line per issue: `path: message`.
 *
 * One wording for every parse peek reports on, because they are all read the
 * same way — someone looking for the field they got wrong. A command's input
 * (`parseCommandInput`), a connect draft (`validateConnectionConfig`), and a
 * package manifest read off disk (`parsePackageManifest`) had three near-copies
 * of this between them, and the manifest one is the one that has to be good: a
 * loader refusing a package is a sentence the user reads instead of an
 * installed database, so "which key, and what was wrong with it" is the whole
 * message.
 *
 * Never translated. A path is a path, and the message names types.
 */
export function zodIssueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

/* ================================================================== */
/* Transport classification, shared by every driver                    */
/* ================================================================== */

/**
 * The part of error mapping that is **not** database-specific.
 *
 * Every driver ships a `map*Error` funnel, and each one used to re-derive the
 * same three facts: an aborted operation is CANCELLED, a socket errno is
 * CONNECTION_FAILED, and a message that says "timed out" is a TIMEOUT. Four
 * copies meant four slightly different answers — the errno set drifted (qdrant
 * knew about undici's `UND_ERR_CONNECT_TIMEOUT`, the others did not; the SQL and
 * redis sets knew about `EACCES`, qdrant did not), and the timeout regex was
 * spelled three different ways, so `timed out` was a TIMEOUT in redis and a
 * QUERY_FAILED in postgres.
 *
 * What stays private to a driver is exactly what is genuinely private: postgres's
 * SQLSTATE table, redis's reply-error prefixes, qdrant's HTTP status map, and the
 * SQL dialects' `ER_*` / result-code tables. Those are the mappings that differ
 * because the databases differ; everything below differs only by accident.
 *
 * Composition rule: a driver applies its own table where its own table is
 * authoritative, and calls these for the rest. The ordering is the driver's
 * choice, because it is load-bearing — redis must test its reply prefix before
 * the timeout regex, or `ERR ... timed out` stops being a reply error.
 */

/**
 * node / undici network-layer errnos that mean "the connection did not happen".
 *
 * The union of what the four drivers each knew separately. Broadening one
 * driver's set with another's is always safe here: these strings never collide
 * with a SQLSTATE (5 chars, alphanumeric), a redis reply prefix (matched by its
 * own ALLCAPS rule) or an HTTP status (a number).
 */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EACCES',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
])

export function isNetworkErrorCode(code: string | undefined): boolean {
  return code !== undefined && NETWORK_ERROR_CODES.has(code)
}

/**
 * Read the errno off a thrown value, following one level of `cause`.
 *
 * undici (and therefore `@qdrant/js-client-rest`) wraps the socket failure, so
 * the errno that matters sits on `err.cause.code` rather than `err.code`. Every
 * driver reads it the same way now, which is why this is here and not there.
 */
export function readErrno(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const direct = (value as Record<string, unknown>)['code']
  if (typeof direct === 'string') return direct
  const cause = (value as Record<string, unknown>)['cause']
  if (typeof cause === 'object' && cause !== null) {
    const nested = (cause as Record<string, unknown>)['code']
    if (typeof nested === 'string') return nested
  }
  return undefined
}

/**
 * "timeout" / "time out" / "timed out", in any casing and any spacing.
 *
 * The last-resort branch: several clients report their own deadlines as a plain
 * `Error` with no code at all, and the word is the only evidence there is.
 *
 * The leading `\b` is what keeps it from firing on `runtime output`: the "time"
 * inside "runtime" is not at a word boundary, so the phrase has to actually start
 * with the word.
 */
export const TIMEOUT_MESSAGE_RE = /\btimed?\s*out/i

export function looksLikeTimeoutMessage(message: string): boolean {
  return TIMEOUT_MESSAGE_RE.test(message)
}

/** AbortError, DOMException's abort, and anything else that means "the caller pulled the plug" */
export function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === 'AbortError'
}

/** Which codes are worth the user's time to retry. Drivers may add their own cases on top. */
export function isRetryableErrorCode(code: PeekErrorCode): boolean {
  return code === 'CONNECTION_FAILED' || code === 'CONNECTION_LOST' || code === 'TIMEOUT'
}

/** Fields every `map*Error` context carries; the driver-specific ones extend it. */
export interface MapDriverErrorContext {
  /** Code to use when nothing matches */
  fallback?: PeekErrorCode
}

/**
 * Classify a thrown value as an abort / socket failure / timeout, or return null
 * when it is none of those and the driver's own table has to answer.
 *
 * `extra` is the driver's evidence bag (the statement, the command, the request
 * line) — it is attached to the connection and timeout results but deliberately
 * **not** to CANCELLED: a cancellation is not a failure of the statement, and
 * pasting the statement into it only invites the user to look for a bug in it.
 */
export function classifyTransportError(value: unknown, extra?: PeekErrorExtra): PeekError | null {
  return classifyAbortError(value)
    ?? classifyNetworkError(value, extra)
    ?? classifyTimeoutError(value, extra)
}

export function classifyAbortError(value: unknown): PeekError | null {
  return isAbortError(value) ? peekError('CANCELLED', value.message || 'Operation cancelled') : null
}

export function classifyNetworkError(value: unknown, extra?: PeekErrorExtra): PeekError | null {
  if (!(value instanceof Error)) return null
  const errno = readErrno(value)
  if (!isNetworkErrorCode(errno)) return null
  return peekError('CONNECTION_FAILED', value.message, {
    driverCode: errno as string,
    retryable: true,
    ...extra,
  })
}

export function classifyTimeoutError(value: unknown, extra?: PeekErrorExtra): PeekError | null {
  if (!(value instanceof Error) || !looksLikeTimeoutMessage(value.message)) return null
  return peekError('TIMEOUT', value.message, { retryable: true, ...extra })
}
