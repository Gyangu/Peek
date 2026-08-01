/**
 * The four commands that read and edit what peek keeps on disk.
 *
 * All four are `read` handlers: they touch no Workspace state, bump no `rev` and
 * broadcast no patch, exactly like `state.read`. The connection book is not part
 * of the window's state — it is a file that outlives the session, and a window
 * that mirrored it would have two copies of the same list to keep in step for no
 * benefit. What the renderer gets is the file, answered on request.
 *
 * They are still commands rather than a side channel, because everything that is
 * asked of main is a command: they are validated by the same zod gate and land
 * in the same log, so "who forgot that connection" and "who moved the port" are
 * answerable from the same recording as everything else.
 *
 * `read` is synchronous, and so is the I/O here — three small JSON files under
 * `~/.peek`, none of which are worth an effect intent. The one genuinely
 * asynchronous act, rebinding the MCP port, is deliberately *not* awaited: see
 * the note on `McpController`.
 */

import { MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, MCP_HTTP_PATH } from '@peek/core'
import type {
  ConnBookForgetResult,
  ConnBookListResult,
  McpConfigureResult,
  McpReadResult,
  McpStatus,
} from '@peek/core'
import type { CommandHandlerMap } from '../bus/types'
import type { ConnectionBook } from './connection-book'
import type { McpController } from './mcp-controller'

export interface ConfigHandlerOptions {
  book: ConnectionBook
  mcp: McpController
}

export function createConfigHandlers(options: ConfigHandlerOptions): CommandHandlerMap {
  const { book, mcp } = options

  return {
    'conn.book.list': {
      read: (): ConnBookListResult => ({
        entries: book.list(),
        secretsAvailable: book.secretsAvailable,
      }),
    },

    'conn.book.forget': {
      read: (_state, input): ConnBookForgetResult => ({
        id: input.id,
        removed: book.forget(input.id),
        // The list comes back with the receipt: a caller that had to re-list
        // would be reading a file it just changed, through a second command.
        entries: book.list(),
      }),
    },

    'mcp.read': {
      read: (): McpReadResult => mcp.status(),
    },

    'mcp.configure': {
      read: (_state, input): McpConfigureResult => {
        const outcome = mcp.configure({
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.rotateToken === undefined ? {} : { rotateToken: input.rotateToken }),
        })
        return {
          ...outcome.status,
          tokenRotated: outcome.tokenRotated,
          previousPort: outcome.previousPort,
          // Either change breaks every registration a client already holds — the
          // token it sends stops matching, or the URL stops answering.
          reregisterRequired: outcome.tokenRotated || outcome.previousPort !== null,
        }
      },
    },
  }
}

/* ------------------------------------------------------------------ */
/* The degraded set                                                    */
/* ------------------------------------------------------------------ */

/**
 * What these commands answer before main has assembled anything — the exact
 * analogue of `createUnavailableChatRuntime`.
 *
 * `coreHandlers` is `satisfies Required<CommandHandlerMap>`, which is the check
 * that a command can never be dispatched without an implementation; these are
 * that implementation for a process where nothing has been wired yet (a unit
 * test building a bare `CommandBus`, or an assembly that threw). They report an
 * empty book and an endpoint that is not listening, which is true — rather than
 * failing, which would read as a bug in the command.
 */
const NOT_LISTENING: McpStatus = {
  listening: false,
  host: MCP_DEFAULT_HOST,
  port: MCP_DEFAULT_PORT,
  preferredPort: MCP_DEFAULT_PORT,
  path: MCP_HTTP_PATH,
  url: `http://${MCP_DEFAULT_HOST}:${String(MCP_DEFAULT_PORT)}${MCP_HTTP_PATH}`,
  token: '',
  hint: '',
  configFile: '',
  restarting: false,
}

export const unavailableConfigHandlers = {
  'conn.book.list': {
    read: (): ConnBookListResult => ({ entries: [], secretsAvailable: false }),
  },
  'conn.book.forget': {
    read: (_state, input): ConnBookForgetResult => ({ id: input.id, removed: false, entries: [] }),
  },
  'mcp.read': {
    read: (): McpReadResult => NOT_LISTENING,
  },
  'mcp.configure': {
    read: (): McpConfigureResult => ({
      ...NOT_LISTENING,
      reregisterRequired: false,
      tokenRotated: false,
      previousPort: null,
    }),
  },
} satisfies CommandHandlerMap
