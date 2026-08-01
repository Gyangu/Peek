/**
 * Turning whatever the agent throws into peek's `PeekError`, and keeping secrets
 * out of everything that leaves this module.
 *
 * The agent is an **external process** and its output is untrusted input. Two
 * consequences are enforced here:
 *
 *  - every string that reaches a log, a toast or a Workspace field passes
 *    through `redact` and `sanitizeLine` first;
 *  - nothing the agent sends is ever interpreted as an instruction. Error
 *    classification below keys off JSON-RPC codes and a small set of literal
 *    substrings, and produces a fixed `PeekErrorCode` — the agent cannot talk
 *    peek into a different code, only into a different *message string* that
 *    peek will display as text.
 */

import {
  ConnectionConfigSchema,
  REDACTED,
  peekError,
  redactConnectionConfig,
  type PeekError,
} from '@peek/core'

/* ================================================================== */
/* JSON-RPC codes worth naming                                         */
/* ================================================================== */

/** `RequestError.authRequired()` in `@agentclientprotocol/sdk`. */
const CODE_AUTH_REQUIRED = -32000
const CODE_INVALID_PARAMS = -32602
const CODE_INTERNAL = -32603
const CODE_REQUEST_CANCELLED = -32800

/**
 * Substrings that mean "the model provider refused our credentials".
 *
 * The agent reports these as a generic internal error (`-32603`, `errorKind:
 * "server_error"`), indistinguishable by code from a genuine server fault, so
 * the text is the only signal available. Matching is deliberately narrow: a
 * false negative shows a generic error, while a false positive would tell a user
 * with a working login to go and log in again.
 */
const AUTH_HINTS = [
  'authentication_error',
  'invalid api key',
  'invalid_api_key',
  'unauthorized',
  'not authenticated',
  'please run `claude`',
  'oauth token has expired',
  '401',
] as const

/**
 * Last-resort text match for "the agent process died mid-request".
 *
 * ## Why a string match is here at all, and why it is no longer load-bearing
 *
 * The SDK rejects an in-flight request through `close(error)`, whose default is
 * literally `new Error("ACP connection closed")` — no `code`, no `data`, nothing
 * structured. Worse, `close` is also called with whatever the stream reader
 * threw, so the text is not even a fixed string: an `EPIPE`, an `ECONNRESET` or
 * a future SDK rewording all arrive here as an unrecognisable bare `Error` and
 * used to be reported as a generic internal failure — "the agent failed" — for
 * something peek could see plainly, because the child process it started was
 * gone.
 *
 * {@link AcpFailureContext.agentAlive} is the fix and is now the primary signal:
 * the caller *knows* whether its own child process is still running, and that
 * fact does not depend on anyone's wording. This list stays as a fallback for
 * the one case the structural check cannot cover — the request failing in the
 * window between the stream closing and the OS reporting the exit — and is
 * widened to the shapes actually observed on that path.
 */
const CLOSED_HINTS = [
  'connection closed',
  'connection is closed',
  'stream closed',
  'stream is closed',
  'write after end',
  'premature close',
  'epipe',
  'econnreset',
  'err_stream_destroyed',
  'the agent process exited',
] as const

/**
 * What the caller knows about its own side of the connection.
 *
 * Deliberately not derived from the thrown value: everything in `raw` was
 * authored by the agent or by the transport, and the whole point of this record
 * is to carry a fact peek established for itself.
 */
export interface AcpFailureContext {
  /**
   * Whether peek's agent child process was still running when the request
   * failed. `false` is authoritative — a request cannot fail for any reason
   * other than the agent being gone once the agent is gone — and `undefined`
   * means "not checked", which falls back to {@link CLOSED_HINTS}.
   */
  agentAlive?: boolean
}

/* ================================================================== */
/* Redaction                                                           */
/* ================================================================== */

/**
 * Replace every occurrence of each secret with `***`.
 *
 * The MCP bearer token is handed to the agent in a `session/new` parameter, and
 * agent stderr echoes its own configuration on some paths. Any log line, error
 * detail or notification built from agent output goes through here first, and
 * short strings are ignored so an accidental empty secret cannot blank the text.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.split(secret).join('***')
  }
  return out
}

/**
 * Make one line of agent output safe to display and to log.
 *
 * Strips C0/C1 control characters (ANSI escapes, carriage-return overwrites and
 * the like — an untrusted process should not get to rewrite peek's terminal or
 * smuggle invisible content into a Workspace field) and caps the length.
 */
export function sanitizeLine(text: string, maxLen = 400): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped
}

/* ------------------------------------------------------------------ */
/* Credentials inside a tool's arguments                               */
/* ------------------------------------------------------------------ */

/**
 * `scheme://user:password@host`, masked everywhere it occurs.
 *
 * Core's `redactUrlCredentials` does the same job but replaces only the first
 * match, which is exactly right for a config field holding one URL. A tool
 * argument is free-form — a single shell command can name two DSNs — so the sweep
 * here is global, and it stops at whitespace so a bare `@` later in a sentence
 * cannot drag the match across half the line.
 */
const URL_CREDENTIALS_RE = /(:\/\/[^:/@\s]*):[^@\s]*@/g

function maskUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS_RE, `$1:${REDACTED}@`)
}

/**
 * Argument names whose **value** is a credential, whatever tool they belong to.
 *
 * The fallback for tools peek knows nothing about — a config shape it can parse
 * is handled precisely, one field below. Deliberately anchored whole-name
 * matches: `password` is a secret, `passwordPolicy` is not, and over-masking a
 * permission prompt costs the user the ability to see what they are approving.
 * `url` is **not** in this list: masking a whole URL would hide the host the user
 * is being asked to allow, so URLs keep their shape and lose only the password.
 */
const SECRET_KEY_RE =
  /^(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth[-_]?token|authorization|bearer|credential|credentials|private[-_]?key|session[-_]?token|client[-_]?secret)$/i

/** Deep enough for any real tool payload; a guard against a pathological nest, not a policy. */
const MAX_PREVIEW_DEPTH = 8

/**
 * Walk a tool argument, masking secret-named fields and credentials in strings.
 *
 * The cycle guard is scoped to the current path (added on the way down, removed
 * on the way up), so a value that legitimately appears twice is still rendered
 * twice — only a real loop becomes a marker.
 */
function redactPreviewValue(value: unknown, depth: number, path: Set<object>): unknown {
  if (typeof value === 'string') return maskUrlCredentials(value)
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_PREVIEW_DEPTH) return '…'
  if (path.has(value)) return '[circular]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactPreviewValue(item, depth + 1, path))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactPreviewValue(item, depth + 1, path)
    }
    return out
  } finally {
    path.delete(value)
  }
}

/**
 * Strip credentials out of a tool's raw arguments.
 *
 * ## Why this exists at all
 *
 * The preview built from these arguments is not a local string. It becomes
 * `PendingPermission.inputPreview`, which is Workspace state: `summarizeChat`
 * carries it into the outward snapshot that `read_workspace` hands to any MCP
 * caller holding the bearer token, and the same field is broadcast to the
 * renderer, for as long as the prompt stands. A cleartext DSN there is a secret
 * published to a wider audience than the one that typed it — and the same field
 * is already redacted on the way to the command log (`redactCommandInput`), so
 * leaving this path open was a hole in an otherwise closed surface.
 *
 * ## Two passes, because they know different amounts
 *
 * The generic walk knows nothing about peek and masks by field name. The second
 * pass is exact: `connect`'s `config` is a shape core can parse, so it goes
 * through the same `redactConnectionConfig` every other outbound copy of a config
 * uses — which also drops any key the schema does not declare.
 */
export function redactToolInput(rawInput: unknown): unknown {
  if (typeof rawInput === 'string') return maskUrlCredentials(rawInput)
  if (typeof rawInput !== 'object' || rawInput === null) return rawInput

  const walked = redactPreviewValue(rawInput, 0, new Set<object>())
  if (Array.isArray(walked) || typeof walked !== 'object' || walked === null) return walked

  // Parsed from the *original* input: the walk has already masked the password,
  // and a schema is stricter about everything else.
  const parsed = ConnectionConfigSchema.safeParse((rawInput as Record<string, unknown>)['config'])
  if (parsed.success) (walked as Record<string, unknown>)['config'] = redactConnectionConfig(parsed.data)
  return walked
}

/**
 * A short, safe rendering of a tool's arguments, for a permission prompt.
 *
 * Never the full input: it can be arbitrarily large, it is untrusted, and a
 * permission dialog that scrolls is a permission dialog nobody reads. Never the
 * *raw* input either — see {@link redactToolInput}. The final sweep repeats the
 * URL mask on the serialised form, which is what covers a payload the structural
 * walk could not enter (a string of pre-serialised JSON, anything past the depth
 * limit).
 */
export function previewInput(rawInput: unknown, maxLen = 300): string {
  const safe = redactToolInput(rawInput)
  let text: string
  try {
    text = typeof safe === 'string' ? safe : JSON.stringify(safe)
  } catch {
    text = String(safe)
  }
  if (text === undefined || text === 'undefined') return ''
  return sanitizeLine(maskUrlCredentials(text), maxLen)
}

/* ================================================================== */
/* Classification                                                      */
/* ================================================================== */

interface RpcErrorLike {
  code?: unknown
  message?: unknown
  data?: unknown
}

function asRpcError(raw: unknown): RpcErrorLike | null {
  if (typeof raw !== 'object' || raw === null) return null
  return raw as RpcErrorLike
}

function messageOf(raw: unknown): string {
  const rpc = asRpcError(raw)
  if (rpc && typeof rpc.message === 'string') return rpc.message
  if (raw instanceof Error) return raw.message
  return String(raw)
}

function detailOf(raw: unknown): string | undefined {
  const rpc = asRpcError(raw)
  if (!rpc || rpc.data === undefined || rpc.data === null) return undefined
  try {
    return typeof rpc.data === 'string' ? rpc.data : JSON.stringify(rpc.data)
  } catch {
    return undefined
  }
}

function hasHint(text: string, hints: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return hints.some((hint) => lower.includes(hint))
}

/** True when the failure means "log in first", by code or by the narrow text match. */
export function isAuthFailure(raw: unknown): boolean {
  const rpc = asRpcError(raw)
  if (rpc && rpc.code === CODE_AUTH_REQUIRED) return true
  return hasHint(`${messageOf(raw)} ${detailOf(raw) ?? ''}`, AUTH_HINTS)
}

/**
 * True when the agent process went away underneath an in-flight request.
 *
 * Structural first: a dead agent plus a rejection that carries no JSON-RPC code
 * is a crash, whatever the text says. The code check matters — an agent that
 * answered `-32602` and *then* exited reported a real protocol error, and
 * relabelling it as a crash would send the user chasing the wrong thing.
 */
export function isConnectionClosed(raw: unknown, context: AcpFailureContext = {}): boolean {
  if (context.agentAlive === false && typeof asRpcError(raw)?.code !== 'number') return true
  return hasHint(messageOf(raw), CLOSED_HINTS)
}

/**
 * The guidance shown when authentication fails.
 *
 * peek **never collects a password, an API key or an OAuth token**. The agent
 * reuses whatever Claude Code login already exists on the machine, so the fix is
 * always something the user does in their own terminal, and this text says so
 * rather than offering a field to type a secret into.
 */
export const AUTH_HELP =
  'peek reuses the Claude Code login already on this machine and never handles credentials itself. ' +
  'Run `claude` in a terminal, sign in there, then send the message again.'

/**
 * Collapse anything thrown by the ACP layer into a `PeekError`.
 *
 * `secrets` are redacted from every string that ends up in the result.
 */
export function classifyAcpError(
  raw: unknown,
  secrets: readonly string[] = [],
  context: AcpFailureContext = {},
): PeekError {
  const message = sanitizeLine(redact(messageOf(raw), secrets))
  const rawDetail = detailOf(raw)
  const detail = rawDetail === undefined ? undefined : sanitizeLine(redact(rawDetail, secrets), 1_000)
  const rpc = asRpcError(raw)
  const code = typeof rpc?.code === 'number' ? rpc.code : undefined

  if (isAuthFailure(raw)) {
    return peekError('CONNECTION_FAILED', message || 'The agent could not authenticate.', {
      detail: AUTH_HELP,
      retryable: false,
    })
  }

  if (code === CODE_REQUEST_CANCELLED) {
    return peekError('CANCELLED', message || 'The turn was cancelled.')
  }

  if (isConnectionClosed(raw, context)) {
    return peekError('DRIVER_CRASHED', message || 'The agent process exited.', {
      detail: 'The chat panel restarts the agent automatically; the conversation so far is preserved.',
      retryable: true,
    })
  }

  if (code === CODE_INVALID_PARAMS) {
    return peekError('BAD_REQUEST', message || 'The agent rejected the request.', {
      ...(detail === undefined ? {} : { detail }),
    })
  }

  if (code === CODE_INTERNAL) {
    return peekError('INTERNAL', message || 'The agent reported an internal error.', {
      ...(detail === undefined ? {} : { detail }),
      retryable: true,
    })
  }

  return peekError('INTERNAL', message || 'The agent failed.', {
    ...(detail === undefined ? {} : { detail }),
  })
}

/** A timeout with the operation named, so the toast is actionable. */
export function acpTimeout(operation: string, ms: number): PeekError {
  return peekError('TIMEOUT', `${operation} did not finish within ${ms} ms.`, { retryable: true })
}
