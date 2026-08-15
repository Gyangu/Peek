import {
  classifyTransportError,
  peekError,
  toPeekError,
  type MapDriverErrorContext,
  type PeekError,
  type PeekErrorCode,
} from '@peek/core'

/**
 * Neo4j error classification.
 *
 * Neo4j's wire errors carry a dotted status code —
 * `Neo.ClientError.Security.Unauthorized`,
 * `Neo.TransientError.Transaction.DeadlockDetected` — which is a better
 * discriminator than any message, and the direct analogue of SQLSTATE in the
 * postgres driver. `neo4j-driver` surfaces it as `error.code`, read structurally
 * here so a client upgrade cannot break the mapping.
 *
 * **Nothing here is localizable**: the server's message is evidence and passes
 * through verbatim, with no `i18n` descriptor. Peek-authored text uses the
 * catalog keys in core.
 */

/**
 * Status code → PeekErrorCode.
 *
 * Matched on the **category** (the second and third segments) rather than the
 * whole code, because Neo4j adds leaf codes freely between minor versions and a
 * full table would silently fall through to `QUERY_FAILED` for each new one.
 *
 * The read-only case is the one worth calling out: peek opens every session in
 * READ access mode, so a write statement comes back as
 * `Neo.ClientError.Statement.AccessMode` (or `...Request.Invalid` on older
 * servers) rather than being executed. That is the server enforcing peek's
 * read-only promise, not peek trusting itself — the same property the postgres
 * driver gets from `BEGIN READ ONLY`.
 */
export function codeFromNeo4jStatus(status: string): PeekErrorCode {
  if (status.startsWith('Neo.TransientError')) return 'CONFLICT'
  if (status.startsWith('Neo.DatabaseError')) return 'INTERNAL'
  if (status.includes('.Security.')) return 'CONNECTION_FAILED'
  if (status.includes('.Database.DatabaseNotFound')) return 'NOT_FOUND'
  if (status.includes('.Transaction.Terminated')) return 'CANCELLED'
  if (status.includes('.Statement.')) return 'QUERY_FAILED'
  if (status.startsWith('Neo.ClientError')) return 'QUERY_FAILED'
  return 'INTERNAL'
}

/** Transient errors are the ones the server itself says to retry. */
function isRetryable(status: string): boolean {
  return status.startsWith('Neo.TransientError')
}

/** The shape `neo4j-driver` throws (`Neo4jError`); every field read structurally. */
interface Neo4jErrorShape {
  code: string
  message: string
}

function asNeo4jError(value: unknown): Neo4jErrorShape | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const code = v['code']
  // `Neo.…` is the whole test: the driver also throws `ServiceUnavailable` with a
  // non-dotted `code`, and that one belongs to the transport classifier below.
  if (typeof code !== 'string' || !code.startsWith('Neo.')) return null
  const message = v['message']
  return { code, message: typeof message === 'string' ? message : `Neo4j returned ${code}` }
}

export interface MapNeo4jErrorContext extends MapDriverErrorContext {
  /** The statement that failed; goes into `detail`. */
  statement?: string
}

/**
 * Map anything caught into a PeekError.
 * Every error this driver throws outward has to pass through here.
 */
export function mapNeo4jError(value: unknown, ctx: MapNeo4jErrorContext = {}): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'

  const err = asNeo4jError(value)
  if (err) {
    const code = codeFromNeo4jStatus(err.code)
    return peekError(code, err.message, {
      driverCode: err.code,
      // The statement is withheld from a cancellation for the reason
      // `classifyTransportError` withholds it: a cancelled query is not a wrong
      // query, and showing its text invites a hunt for a bug that is not there.
      ...(ctx.statement !== undefined && code !== 'CANCELLED'
        ? { detail: `STATEMENT: ${ctx.statement}` }
        : {}),
      ...(isRetryable(err.code) ? { retryable: true } : {}),
    })
  }

  // `ServiceUnavailable` / `SessionExpired` arrive as plain Errors whose `cause`
  // holds the socket errno, which is exactly what the shared classifier reads.
  return (
    classifyTransportError(value, ctx.statement === undefined ? undefined : { detail: ctx.statement }) ??
    toPeekError(value, fallback)
  )
}
