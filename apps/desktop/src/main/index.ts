import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import type { ConnId, NamespaceNode, NotifyMessage, PeekError, WorkspaceSnapshot } from '@peek/core'
import { toPeekError } from '@peek/core'
import { createCommandBus, type CommandBus, type CommandDeps } from './bus'
import { installBusIpc, sendNotify } from './bus/ipc-main'
import { ConnectionManager } from './connections'
import { createMcpServer, type McpServerHandle } from './mcp'
import { WorkspaceStore, createResultEventSink } from './store'
import { installDriverRpc, type DriverRpcOptions } from './driver-rpc'
import { createResultRowsBroker, type ResultRowsBroker } from './result-rows'

/**
 * Assembly of peek's main process (PLAN sections 3, 6 and 7).
 *
 * Dependencies point one way only, and the assembly order has to follow them:
 *
 *   WorkspaceStore (the source of truth)
 *     → ConnectionManager (the process model; emits events, never writes the
 *       source of truth)
 *     → CommandDeps (wraps the manager in the side-effect interface the bus knows)
 *     → CommandBus (the single entry point for both UI and MCP)
 *     → IPC wiring (patch broadcast / command channel / data-plane port)
 *     → MCP HTTP server (reads the source of truth, writes through the bus)
 *     → the window
 *
 * References that would point backwards always travel by event or injection and
 * are never imported: the ConnectionManager does not know the bus, the bus does
 * not know the ConnectionManager, and MCP knows neither.
 */

/* ================================================================== */
/* stdio resilience: a broken log pipe must not crash the app          */
/* ================================================================== */

/**
 * stdout / stderr may already be closed — when the parent process exited first,
 * or when the app was started through a pipe or under nohup. Any console.* call
 * then throws EPIPE, which surfaces as an uncaught exception in the main process
 * and makes Electron pop up "A JavaScript error occurred in the main process".
 * Losing the log channel is harmless in itself, yet it presents the whole app as
 * having crashed.
 *
 * Two layers of protection:
 *   1. an error listener on both streams that swallows write failures such as
 *      EPIPE or a destroyed stream (anything else is rethrown as before);
 *   2. a synchronous try/catch around console.*, catching the write errors Node
 *      throws synchronously on some paths.
 */
function hardenStdio(): void {
  const isBrokenPipe = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
  }

  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (isBrokenPipe(error)) return
      throw error
    })
  }

  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      try {
        original(...args)
      } catch (error) {
        if (!isBrokenPipe(error)) throw error
        // The pipe is gone: drop this log line silently
      }
    }
  }
}

hardenStdio()

const isDev = !app.isPackaged

/* ================================================================== */
/* Process-wide singletons                                             */
/* ================================================================== */

const store = new WorkspaceStore()
const connections = new ConnectionManager()
/** The one place driver host events write back into the source of truth (state transitions reuse store/mutations) */
const resultSink = createResultEventSink(store)

let mainWindow: BrowserWindow | null = null
let mcp: McpServerHandle | null = null
const disposers: (() => void)[] = []

/** The renderers that should receive patches and notifications; the window may not exist yet or may be destroyed */
function renderers(): readonly WebContents[] {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => w.webContents)
}

function notify(message: NotifyMessage): void {
  sendNotify(renderers(), message)
  const tag = `[peek/${message.level}]`
  if (message.level === 'error') console.error(tag, message.message, message.detail ?? '')
  else if (message.level === 'warn') console.warn(tag, message.message, message.detail ?? '')
}

/* ================================================================== */
/* 1. Side-effect dependencies for the Command Bus                     */
/* ================================================================== */

/**
 * Adapt the ConnectionManager into the `CommandDeps` the bus knows.
 *
 * This layer is pure shape conversion with no policy of its own: the fetch
 * methods **only deliver the request to the driver host**, row data goes from the
 * host straight to the renderer over a MessagePort, and schema / row counts /
 * completion / errors flow back into the source of truth through
 * connections.events (see the subscriptions below).
 */
function createDeps(): CommandDeps {
  return {
    connections: {
      async open(req) {
        const outcome = await connections.connect(req.config, {
          connId: req.connId,
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        })
        return {
          capabilities: outcome.capabilities,
          ...(outcome.serverInfo === undefined ? {} : { serverInfo: outcome.serverInfo }),
          ...(outcome.pid === undefined ? {} : { pid: outcome.pid }),
        }
      },
      async close(connId) {
        await connections.disconnect(connId)
      },
    },

    results: {
      async runQuery(req) {
        await connections.runQuery(req.connId, {
          resultId: req.resultId,
          text: req.text,
          ...(req.params === undefined ? {} : { params: req.params }),
          ...(req.maxRows === undefined ? {} : { maxRows: req.maxRows }),
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        })
      },
      async scanCollection(req) {
        await connections.scan(req.connId, {
          resultId: req.resultId,
          ref: req.ref,
          ...(req.filter === undefined ? {} : { filter: req.filter }),
          ...(req.sort === undefined ? {} : { sort: req.sort }),
          ...(req.offset === undefined ? {} : { offset: req.offset }),
          ...(req.limit === undefined ? {} : { limit: req.limit }),
          ...(req.cursorToken === undefined ? {} : { cursorToken: req.cursorToken }),
        })
      },
      async vectorSearch(req) {
        await connections.vectorSearch(req.connId, {
          resultId: req.resultId,
          collection: req.collection,
          ...(req.queryVec === undefined ? {} : { queryVec: req.queryVec }),
          topK: req.topK,
          ...(req.filter === undefined ? {} : { filter: req.filter }),
        })
      },
      async cancel(req) {
        try {
          const outcome = await connections.cancel(req.connId, req.resultId)
          return outcome.cancelled
        } catch {
          // The connection is long gone, or the result set already finished. The
          // contract says answer false — a cancel must not become a failed command.
          return false
        }
      },
    },

    notify,
  }
}

/* ================================================================== */
/* 2. Driver host events → source of truth + notifications             */
/* ================================================================== */

function wireConnectionEvents(): void {
  const { events } = connections

  disposers.push(
    events.on('status', ({ connId, status, error, pid }) => {
      resultSink.onConnectionStatus(connId, status, {
        ...(error === undefined ? {} : { error }),
        ...(pid === undefined ? {} : { pid }),
      })
    }),

    events.on('result.schema', ({ resultId, schema }) => {
      resultSink.onSchema(resultId, schema)
    }),

    events.on('result.progress', ({ resultId, rows }) => {
      resultSink.onProgress(resultId, rows)
    }),

    events.on('result.done', ({ resultId, info }) => {
      resultSink.onDone(resultId, info)
    }),

    events.on('result.paused', ({ resultId, paused }) => {
      resultSink.onPaused(resultId, {
        rows: paused.rows,
        elapsedMs: paused.elapsedMs,
        reason: paused.message,
      })
    }),

    events.on('result.error', ({ resultId, error }) => {
      resultSink.onError(resultId, error)
    }),

    events.on('log', ({ connId, level, message, detail }) => {
      // A driver host's stdout/stderr is noisy; only warn and above bother the user
      if (level === 'info') {
        console.log('[peek/driver]', message, detail ?? '')
        return
      }
      notify({ level, message, connId, ...(detail === undefined ? {} : { detail }) })
    }),

    events.on('crashed', ({ connId, error }) => {
      notify({
        level: 'error',
        // NotifyMessage carries no localization descriptor, and this text also
        // goes to the main-process log, so it stays plain English.
        message: `The driver process exited unexpectedly: ${error.message}`,
        connId,
        detail: 'This connection is unusable; reconnect to continue. Other connections are unaffected.',
      })
    }),
  )
}

/* ================================================================== */
/* 3. The non-command read-only channel                                */
/*    (a patch over a gap in the command contract; see below)          */
/* ================================================================== */

const driverRpc: DriverRpcOptions = {
  introspect: (connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> =>
    connections.introspect(connId, parentId, refresh),
  peekValue: (connId, ref, range) => connections.peekValue(connId, ref, range),
  getKeyValue: (connId, ref) => connections.getValue(connId, ref),
}

/* ================================================================== */
/* 4. The window                                                       */
/* ================================================================== */

function createWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, '../preload/index.cjs')
  const hasPreload = existsSync(preloadPath)
  if (!hasPreload) {
    console.error(
      '[peek/error] preload build output missing:',
      preloadPath,
      '— the window will degrade to read-only',
    )
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#141414',
    webPreferences: {
      // Security baseline: no Node in the renderer, context isolation on, sandbox on
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(hasPreload ? { preload: preloadPath } : {}),
    },
  })

  // Cold-start budget under 1.5s: show only once the first frame is ready, to
  // avoid a flash of blank window.
  win.once('ready-to-show', () => {
    win.show()
  })

  // Renderer trouble has to show up in the main-process log, or a blank window
  // leaves nothing to investigate.
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[peek/error] window failed to load', code, description, url)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    notify({
      level: 'error',
      message: `The window process exited (${details.reason})`,
      detail: 'Connections and driver processes are still alive; reopening the window restores everything.',
    })
  })
  if (isDev || process.env['PEEK_FORWARD_CONSOLE'] === '1') {
    win.webContents.on('console-message', (details) => {
      console.log(`[peek/renderer:${details.level}]`, details.message)
    })
  }

  // attachRenderer performs the data-plane handover, and it **must wait for the
  // document to finish loading** — otherwise the port passed to
  // webContents.postMessage is lost. Every reload needs a fresh handover.
  win.webContents.on('did-finish-load', () => {
    connections.attachRenderer(win.webContents)
  })

  win.on('closed', () => {
    connections.detachRenderer()
    if (mainWindow === win) mainWindow = null
  })

  // External links always go to the system browser; in-window navigation off-site is refused
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

/* ================================================================== */
/* 5. MCP HTTP Server                                                  */
/* ================================================================== */

async function startMcp(commandBus: CommandBus, rows: ResultRowsBroker): Promise<void> {
  const handle = createMcpServer({
    // UI and AI share one command channel: source is recorded in the log and
    // changes no line of the execution path.
    dispatch: (name, input, source) => commandBus.dispatch(name, input, source),
    getSnapshot: (): WorkspaceSnapshot => store.getSnapshot(),
    // introspect is not a Command (it is absent from COMMAND_NAMES), so it goes
    // through the injected read-only channel.
    introspect: (req) => driverRpc.introspect(req.connId, req.parentId, req.refresh),
    // Row data lives only in the renderer cache (chunks bypass main), so sample from the renderer
    readResultRows: (req) => rows.read(req),
    logger: {
      log: (level, message, detail) => {
        if (level === 'error') console.error('[peek/mcp]', message, detail ?? '')
        else if (level === 'warn') console.warn('[peek/mcp]', message, detail ?? '')
        else if (level === 'info') console.log('[peek/mcp]', message)
      },
    },
  })
  mcp = handle

  try {
    const endpoint = await handle.start()
    console.log(`[peek/mcp] listening on ${endpoint.url}`)
    console.log(`[peek/mcp] how to connect: ${endpoint.hint}`)
  } catch (raw) {
    mcp = null
    const error: PeekError = toPeekError(raw)
    notify({
      level: 'error',
      message: `The MCP server failed to start: ${error.message}`,
      detail:
        error.code === 'CONFLICT'
          ? 'The port is in use — another peek may already be running. The window works as usual; only the AI cannot connect.'
          : (error.detail ?? ''),
    })
  }
}

/* ================================================================== */
/* 6. Lifecycle                                                        */
/* ================================================================== */

function bootstrap(): void {
  const commandBus = createCommandBus({ store, deps: createDeps() })

  wireConnectionEvents()

  // renderer ↔ bus / store: the command channel, full snapshots and patch broadcast
  disposers.push(
    installBusIpc({
      ipcMain,
      bus: commandBus,
      store,
      renderers,
    }),
  )

  // Namespace tree and full single-value reads: these three have no corresponding
  // Command (a gap in the contract), so they travel a separate read-only IPC that
  // enters neither the Workspace state nor the Command log.
  disposers.push(installDriverRpc({ ipcMain, ...driverRpc }))

  // MCP's run_query owes the AI a few sample rows, and row data lives only in the renderer cache
  const rows = createResultRowsBroker({ ipcMain, renderers })
  disposers.push(() => {
    rows.dispose()
  })

  createWindow()

  void startMcp(commandBus, rows)
}

let shuttingDown = false

async function shutdown(): Promise<void> {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      console.error('[peek/error] a disposer threw', error)
    }
  }
  // Close MCP first: the AI must not be able to send commands while drivers are being reaped
  await mcp?.close().catch((error: unknown) => {
    console.error('[peek/error] failed to close the MCP server', error)
  })
  mcp = null
  await connections.disposeAll().catch((error: unknown) => {
    console.error('[peek/error] failed to reclaim driver processes', error)
  })
}

// Single instance: the MCP port and the local state are both singletons, so a second window would be meaningless
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    bootstrap()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // Smoke check: with this environment variable set, quit after N milliseconds.
    // Used by CI and integration scripts.
    const smokeMs = Number(process.env['PEEK_SMOKE_EXIT_MS'] ?? '')
    if (Number.isFinite(smokeMs) && smokeMs > 0) {
      setTimeout(() => {
        console.log('[peek] smoke check finished, exiting')
        app.quit()
      }, smokeMs)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * Graceful exit: driver hosts are separate processes and would be orphaned if
   * left behind, and MCP is holding port 7332. `before-quit` is a synchronous
   * event, so preventDefault first, clean up asynchronously, then really quit.
   */
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    void shutdown().finally(() => {
      app.exit(0)
    })
  })
}
