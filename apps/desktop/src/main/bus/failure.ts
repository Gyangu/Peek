import {
  peekError,
  peekErrorMsg,
  toPeekError,
  type ErrorMessageKey,
  type ErrorMessageParams,
  type PeekError,
  type PeekErrorCode,
} from '@peek/core'

/**
 * Command failure signal.
 *
 * The pure state phase of a handler just does `throw fail(...)`: immer discards
 * the whole draft, so no half-applied state survives, and the Command Bus
 * collapses it into the error branch of a CommandResult at the outermost level.
 * **The exception never escapes to the caller** — both the UI's `invoke` and the
 * MCP tools only ever see a structured result.
 */
export class CommandFailure extends Error {
  readonly error: PeekError

  constructor(error: PeekError) {
    super(error.message)
    this.name = 'CommandFailure'
    this.error = error
  }
}

export type PeekErrorExtra = Omit<PeekError, 'code' | 'message'>

/**
 * Fail with a **localizable** message.
 *
 * This is the default for anything a user will read: the key resolves to English
 * for `PeekError.message` (what MCP and the command log see) and travels on as a
 * `{ key, params }` descriptor the window renders in its own language.
 * See `@peek/core/error-messages`.
 */
export function failMsg<K extends ErrorMessageKey>(
  code: PeekErrorCode,
  key: K,
  params?: ErrorMessageParams<K>,
  extra?: PeekErrorExtra,
): never {
  throw new CommandFailure(peekErrorMsg(code, key, params, extra))
}

/**
 * Fail with literal English text.
 *
 * Only for text that must not be translated: driver output passed through
 * verbatim, or internal plumbing no user is meant to read. Prefer `failMsg`.
 */
export function fail(code: PeekErrorCode, message: string, extra?: PeekErrorExtra): never {
  throw new CommandFailure(peekError(code, message, extra))
}

/** Collapse anything caught into a PeekError */
export function asPeekError(value: unknown, fallback: PeekErrorCode = 'INTERNAL'): PeekError {
  if (value instanceof CommandFailure) return value.error
  return toPeekError(value, fallback)
}
