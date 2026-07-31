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
