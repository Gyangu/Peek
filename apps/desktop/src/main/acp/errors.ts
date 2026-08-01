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

import { peekError, type PeekError } from '@peek/core'

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

/** The agent process died mid-request; the SDK rejects with a bare Error. */
const CLOSED_HINTS = ['connection closed', 'stream closed', 'write after end', 'epipe'] as const

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

/**
 * A short, safe rendering of a tool's arguments, for a permission prompt.
 *
 * Never the full input: it can be arbitrarily large, it is untrusted, and a
 * permission dialog that scrolls is a permission dialog nobody reads.
 */
export function previewInput(rawInput: unknown, maxLen = 300): string {
  let text: string
  try {
    text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
  } catch {
    text = String(rawInput)
  }
  if (text === undefined || text === 'undefined') return ''
  return sanitizeLine(text, maxLen)
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

/** True when the agent process went away underneath an in-flight request. */
export function isConnectionClosed(raw: unknown): boolean {
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
export function classifyAcpError(raw: unknown, secrets: readonly string[] = []): PeekError {
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

  if (isConnectionClosed(raw)) {
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
