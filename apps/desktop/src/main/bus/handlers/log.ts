/**
 * `log.read` and `log.readCommands` — the two read-only commands behind the
 * log panel.
 *
 * Read handlers like `state.read` and the six config commands: no Workspace
 * state, no `rev` bump, no patch. Being commands rather than a side channel is
 * the whole trick — PLAN §10 priced "send main's command log to the renderer" at
 * an IPC channel plus a `PeekBridge` member, and travelling the bus costs
 * neither. See `docs/design/2026-08-15-logging-and-audit.md` §3.5.
 *
 * They are also, by that same construction, callable over MCP. An agent can read
 * what it just did and what the human just did, which is the point of both
 * surfaces sharing one bus.
 */

import type { LogLevel, LogNamespace, LogReadCommandsResult, LogReadResult } from '@peek/core'
import { LOG_NAMESPACES } from '@peek/core'
import type { CommandLog } from '../command-log'
import type { CommandHandlerMap } from '../types'
import type { Logging } from '../../logging'

export interface LogHandlerOptions {
  logging: Logging
  /** The Command Bus's own log — the same instance, not a copy. */
  commandLog: CommandLog
}

export function createLogHandlers(options: LogHandlerOptions): CommandHandlerMap {
  const { logging, commandLog } = options

  return {
    'log.read': {
      read: (_state, input): LogReadResult => {
        // `ns` arrives as a string because core's schema cannot name main's
        // namespaces without importing them; an unknown one filters to nothing,
        // which is the honest answer to "show me the logs for a subsystem that
        // does not exist".
        const ns = asNamespace(input.ns)
        const records = logging.read({
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.minLevel === undefined ? {} : { minLevel: input.minLevel as LogLevel }),
          ...(ns === null ? {} : { ns }),
          ...(input.tag === undefined ? {} : { tag: input.tag }),
        })
        return {
          records,
          level: logging.level(),
          path: logging.diagnosticPath,
          truncated: logging.truncated,
        }
      },
    },

    'log.readCommands': {
      read: (_state, input): LogReadCommandsResult => {
        // Filtered before the limit is applied, so "the last 50 from the agent"
        // means fifty agent commands rather than however many of the last fifty
        // commands happened to be the agent's.
        const all = commandLog.entries()
        const filtered =
          input.source === undefined ? all : all.filter((entry) => entry.source === input.source)
        const limit = input.limit ?? 200
        return {
          entries: filtered.slice(Math.max(0, filtered.length - limit)),
          path: logging.auditPath,
        }
      },
    },
  }
}

/**
 * Before assembly: an empty log rather than a failure.
 *
 * Same reasoning as `unavailableConfigHandlers` — a bus that exists without a
 * logging system yet should answer "nothing here" to a reader, because that is
 * true. Failing instead would make the panel look broken in exactly the setups
 * (a test bus, an early window) where it has nothing to show anyway.
 */
export const unavailableLogHandlers = {
  'log.read': {
    read: (): LogReadResult => ({ records: [], level: 'info', path: '', truncated: false }),
  },
  'log.readCommands': {
    read: (): LogReadCommandsResult => ({ entries: [], path: '' }),
  },
} satisfies CommandHandlerMap

function asNamespace(raw: string | undefined): LogNamespace | null {
  if (raw === undefined) return null
  const found = LOG_NAMESPACES.find((ns) => ns === raw)
  return found ?? null
}
