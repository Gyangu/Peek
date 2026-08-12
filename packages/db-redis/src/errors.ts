import {
  classifyAbortError,
  classifyNetworkError,
  classifyTimeoutError,
  isNetworkErrorCode,
  peekError,
  readErrno,
  toPeekError,
  type MapDriverErrorContext,
  type PeekError,
  type PeekErrorCode,
} from '@peek/core'

/**
 * Redis error classification.
 *
 * Same contract as db-postgres's `mapPgError`, and the same rule about
 * language: **nothing here is localizable**. `WRONGTYPE Operation against a key
 * holding the wrong kind of value` is evidence, not prose — the user greps for
 * it. Peek-authored text goes through the catalog; server text passes through
 * verbatim with no `i18n` descriptor.
 *
 * Redis has no SQLSTATE. What it has is an error *prefix* — the first token of
 * the reply — which plays the same role and is what this maps on. That table is
 * the only redis-specific part; aborts, socket errnos and bare timeout messages
 * go through core's shared `classify*Error` helpers.
 *
 * The **order** below is load-bearing and therefore stays here rather than moving
 * into a single core call: the reply prefix has to be tested before the timeout
 * regex, or `ERR ... timed out` — a perfectly ordinary reply error — is relabelled
 * a transport timeout.
 */

/**
 * Redis reply-error prefixes worth distinguishing.
 *
 * - WRONGTYPE   a command was applied to the wrong data structure. QUERY_FAILED,
 *               not NOT_FOUND: the key exists, the read was wrong.
 * - NOAUTH / WRONGPASS   authentication, which is a connection problem even when
 *               it surfaces mid-session (ACLs can change under a live client).
 * - NOPERM      an ACL forbids the command. Its own case because the fix is
 *               administrative, and calling it QUERY_FAILED sends the user
 *               looking for a typo that is not there.
 * - LOADING / BUSY / MASTERDOWN / CLUSTERDOWN   the server is temporarily unable;
 *               retryable, unlike everything else here.
 * - READONLY    a write hit a replica. peek is read-only today, so this can only
 *               come from a command peek should not have issued — INTERNAL.
 * - OOM         the server refused the command; QUERY_FAILED, not retryable.
 */
const PREFIX_CODES: Readonly<Record<string, PeekErrorCode>> = {
  WRONGTYPE: 'QUERY_FAILED',
  NOAUTH: 'CONNECTION_FAILED',
  WRONGPASS: 'CONNECTION_FAILED',
  NOPERM: 'UNSUPPORTED_CAPABILITY',
  LOADING: 'CONNECTION_FAILED',
  BUSY: 'CONFLICT',
  MASTERDOWN: 'CONNECTION_LOST',
  CLUSTERDOWN: 'CONNECTION_LOST',
  READONLY: 'INTERNAL',
  OOM: 'QUERY_FAILED',
  NOSCRIPT: 'QUERY_FAILED',
  EXECABORT: 'QUERY_FAILED',
  ERR: 'QUERY_FAILED',
}

const RETRYABLE_PREFIXES = new Set(['LOADING', 'BUSY', 'MASTERDOWN', 'CLUSTERDOWN', 'TRYAGAIN'])

/**
 * Prefixes that mean "*this* command was refused", not "the connection is gone".
 *
 * The distinction is what lets a pipelined metadata read degrade one cell to null
 * instead of failing the whole scan:
 * - NOPERM — an ACL forbids the command. `MEMORY USAGE` and `OBJECT ENCODING` are
 *   routinely denied on ElastiCache / Upstash / Redis Cloud, and a keyspace
 *   browser that dies rather than showing an empty `bytes` column is unusable
 *   there.
 * - ERR — "unknown command", "wrong number of arguments" (a renamed or removed
 *   command) and "no such key" (the key expired between the SCAN and the metadata
 *   read) all arrive this way.
 * - WRONGTYPE — the key was retyped mid-scan; the *size* command chosen for the
 *   old type no longer applies.
 * - OOM — the server declined this command; another one may still succeed.
 *
 * Everything else — NOAUTH, WRONGPASS, LOADING, CLUSTERDOWN, a socket errno —
 * is a property of the connection, and must surface rather than be smoothed into
 * a page of null metadata that reads as data.
 */
const PER_COMMAND_REFUSAL_PREFIXES = new Set(['NOPERM', 'ERR', 'WRONGTYPE', 'OOM'])

/** True when the failure is the server refusing one command, not the connection failing */
export function isRedisCommandRefusal(value: unknown): boolean {
  if (!(value instanceof Error)) return false
  if (isNetworkErrorCode(readErrno(value))) return false
  const prefix = redisErrorPrefix(value.message)
  return prefix !== undefined && PER_COMMAND_REFUSAL_PREFIXES.has(prefix)
}

/** First token of a redis error message, when it looks like a reply-error prefix (ALLCAPS) */
export function redisErrorPrefix(message: string): string | undefined {
  const first = message.split(' ', 1)[0]
  if (first === undefined || first.length === 0) return undefined
  return /^[A-Z]{3,}$/.test(first) ? first : undefined
}

export interface MapRedisErrorContext extends MapDriverErrorContext {
  /** The command that failed, e.g. 'HSCAN user:42 0 COUNT 200'; goes into `detail` */
  command?: string
}

/**
 * Map anything caught into a PeekError.
 * Every error this driver throws outward has to pass through here.
 */
export function mapRedisError(value: unknown, ctx: MapRedisErrorContext = {}): PeekError {
  const fallback = ctx.fallback ?? 'QUERY_FAILED'
  const detail = ctx.command === undefined ? {} : { detail: `COMMAND: ${ctx.command}` }

  if (value instanceof Error) {
    const early = classifyAbortError(value) ?? classifyNetworkError(value, detail)
    if (early !== null) return early

    const prefix = redisErrorPrefix(value.message)
    if (prefix !== undefined) {
      const code = PREFIX_CODES[prefix] ?? fallback
      return peekError(code, value.message, {
        driverCode: prefix,
        ...(RETRYABLE_PREFIXES.has(prefix) ? { retryable: true } : {}),
        ...detail,
      })
    }
    const timedOut = classifyTimeoutError(value, detail)
    if (timedOut !== null) return timedOut
    if (/connection is closed|socket closed|stream isn'?t writeable|disconnect/i.test(value.message)) {
      return peekError('CONNECTION_LOST', value.message, { retryable: true, ...detail })
    }
  }

  return toPeekError(value, fallback)
}
