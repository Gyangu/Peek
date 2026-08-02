/**
 * The six commands that read and edit what peek keeps on disk.
 *
 * All six are `read` handlers: they touch no Workspace state, bump no `rev` and
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

import { clampUiZoom, MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, MCP_HTTP_PATH, UI_ZOOM_DEFAULT } from '@peek/core'
import type {
  ConnBookForgetResult,
  ConnBookListResult,
  ExecutionBudgets,
  McpConfigureResult,
  McpReadResult,
  McpStatus,
  SettingsReadResult,
  SettingsWriteResult,
} from '@peek/core'
import type { CommandHandlerMap } from '../bus/types'
// Straight at the module, not through `../connections`: that barrel re-exports
// `host-process.ts`, which imports Electron's `app`, and pulling Electron in
// here would make these handlers unloadable in a plain Node test. `timeouts.ts`
// itself touches neither a file nor Electron, by its own contract.
import { getTimeoutSettings, setTimeoutSettings } from '../connections/timeouts'
import type { ConnectionBook } from './connection-book'
import type { McpController } from './mcp-controller'
import { connectionsFilePath, settingsFilePath } from './paths'
import type { SettingsStore } from './settings'

export interface ConfigHandlerOptions {
  book: ConnectionBook
  mcp: McpController
  settings: SettingsStore
  configDir: string
  /** `app.getVersion()`, injected so this module never imports Electron. */
  version: string
  /**
   * Draw the window at this zoom factor. Injected for the same reason `version`
   * is: `webContents.setZoomFactor` is Electron, and this module stays loadable
   * in a plain Node test. Absent in an assembly with no window (a test bus), and
   * the setting is still persisted in that case — the next window will read it.
   */
  applyZoom?: (factor: number) => void
}

export function createConfigHandlers(options: ConfigHandlerOptions): CommandHandlerMap {
  const { book, mcp, settings, configDir, version, applyZoom } = options

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

    'settings.read': {
      read: (): SettingsReadResult => ({
        execution: executionBudgets(),
        paths: {
          configDir,
          settingsFile: settingsFilePath(configDir),
          connectionsFile: connectionsFilePath(configDir),
          // Owned by the MCP server, which writes it; asking the controller
          // keeps one spelling of that path in the process rather than two.
          mcpFile: mcp.status().configFile,
        },
        version,
        uiZoom: settings.read().uiZoom ?? UI_ZOOM_DEFAULT,
      }),
    },

    'settings.write': {
      read: (_state, input): SettingsWriteResult => {
        // Order matters. `setTimeoutSettings` drops entries it considers
        // invalid and returns what actually took effect, so applying first and
        // persisting its answer is what keeps the file from recording a value
        // the process is not honouring.
        const applied = setTimeoutSettings(input.execution ?? {})
        const execution: ExecutionBudgets = {
          queryMs: applied.queryMs,
          scanMs: applied.scanMs,
          vectorSearchMs: applied.vectorSearchMs,
        }
        // Only the keys the caller asked about are persisted: the other two stay
        // absent from the file so they keep following the built-in default if we
        // ever retune it.
        const persisted: Partial<ExecutionBudgets> = {}
        for (const key of ['queryMs', 'scanMs', 'vectorSearchMs'] as const) {
          if (input.execution?.[key] !== undefined) persisted[key] = execution[key]
        }
        if (Object.keys(persisted).length > 0) settings.update({ executionTimeouts: persisted })

        // Same order as the timeouts above: apply, then persist what applied.
        // `clampUiZoom` is belt and braces — the schema already bounds it — but
        // it is what makes this handler correct for a settings file someone
        // edited by hand and a `settings.write` that came in over MCP.
        let uiZoom = settings.read().uiZoom ?? UI_ZOOM_DEFAULT
        if (input.uiZoom !== undefined) {
          uiZoom = clampUiZoom(input.uiZoom)
          applyZoom?.(uiZoom)
          settings.update({ uiZoom })
        }
        return { execution, uiZoom }
      },
    },
  }
}

function executionBudgets(): ExecutionBudgets {
  const current = getTimeoutSettings()
  return {
    queryMs: current.queryMs,
    scanMs: current.scanMs,
    vectorSearchMs: current.vectorSearchMs,
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
  // The timeouts are real even here — `connections/timeouts.ts` is a module-level
  // singleton that needs no assembly — so these report the truth rather than
  // zeroes. Only the paths are unknowable before a config dir is resolved.
  'settings.read': {
    read: (): SettingsReadResult => ({
      execution: executionBudgets(),
      paths: { configDir: '', settingsFile: '', connectionsFile: '', mcpFile: '' },
      version: '',
      uiZoom: UI_ZOOM_DEFAULT,
    }),
  },
  'settings.write': {
    read: (_state, input): SettingsWriteResult => {
      // Applied but not persisted: there is no settings file to write to yet.
      const applied = setTimeoutSettings(input.execution ?? {})
      return {
        execution: {
          queryMs: applied.queryMs,
          scanMs: applied.scanMs,
          vectorSearchMs: applied.vectorSearchMs,
        },
        // Nothing to draw and nothing to write, so the honest answer is the
        // value that would take effect, not a claim that one did.
        uiZoom: clampUiZoom(input.uiZoom ?? UI_ZOOM_DEFAULT),
      }
    },
  },
} satisfies CommandHandlerMap
