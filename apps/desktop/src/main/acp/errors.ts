/**
 * Turning whatever an ACP agent throws into peek's `PeekError`.
 *
 * The agent is an **external process** and its output is untrusted input:
 * nothing it sends is ever interpreted as an instruction. Classification below
 * keys off JSON-RPC codes and a small set of literal substrings, and produces a
 * fixed `PeekErrorCode` — the agent cannot talk peek into a different code, only
 * into a different *message string* that peek will display as text.
 *
 * The other half of that discipline — `redact`, `sanitizeLine`, `previewInput`,
 * which every string reaching a log, a toast or a Workspace field goes through —
 * moved to `agent/redact.ts`, because it applies to every backend and not just
 * to one speaking JSON-RPC. They are re-exported here so this module still reads
 * as the one place ACP output is made safe.
 */

import { isPeekError, peekError, type PeekError } from '@peek/core'
import { redact, sanitizeLine } from '../agent/redact'

export { previewInput, redact, redactToolInput, sanitizeLine } from '../agent/redact'

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
  // Already ours: peek raised it, with a code it chose deliberately. Running it
  // through the wire-error taxonomy below can only lose that — an
  // `UNSUPPORTED_CAPABILITY` carries no JSON-RPC code, so it would fall through
  // every branch and come out as `INTERNAL`, which is both wrong and unhelpful.
  if (isPeekError(raw)) return raw

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

/**
 * The agent has no session history, but something asked it to open one.
 *
 * Reachable only through a race: the session list refuses to draw rows for an
 * agent that does not advertise `loadSession`, so getting here means the agent
 * was replaced between the list and the click. Not retryable — trying again does
 * not grow a capability.
 */
export function loadUnsupportedError(): PeekError {
  return peekError('UNSUPPORTED_CAPABILITY', 'This agent cannot reopen past conversations.', {
    detail: 'The agent does not advertise session history, so there is nothing to load.',
  })
}
