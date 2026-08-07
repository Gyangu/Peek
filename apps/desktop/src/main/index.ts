import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage, shell, type WebContents } from 'electron'
import type { ConnId, MenuActionMessage, NamespaceNode, NotifyMessage, WorkspaceSnapshot } from '@peek/core'
import { IPC, stepUiZoom, toPeekError, UI_ZOOM_DEFAULT } from '@peek/core'
import { installAppMenu } from './menu'
import { createAutoRefreshScheduler } from './auto-refresh'
import { createCommandBus, type CommandBus, type CommandDeps } from './bus'
import { createChatEventSink, createChatHandlers, watchChatViews, type ChatRuntime } from './bus/handlers'
import { installBusIpc, installChatRestoreIpc, sendChatDeltas, sendNotify } from './bus/ipc-main'
import { AcpManager, chatRootDir, defaultAcpConfig, type McpEndpointInfo } from './acp'
import { DEFAULT_DELTA_BUDGET } from './agent'
import { EndpointManager } from './agent/endpoint/loop'
import { ENDPOINT_THREAD_DIR, EndpointThreadStore } from './agent/endpoint/thread-store'
import { ACP_SNAPSHOT_DIR, AcpSnapshotStore } from './acp/snapshot-store'
import { SessionIndex } from './agent/session-index'
import {
  createConfigHandlers,
  createConnectionBook,
  createMcpController,
  createSafeStorageVault,
  createSettingsStore,
  resolveConfigDir,
  type ConnectionBook,
  type McpController,
  type SettingsStore,
} from './config'
import {
  createAcpChatRuntime,
  createChatStateApplier,
  createContextSource,
  createDeltaEmitter,
  createEndpointChatRuntime,
} from './chat-host'
import { ConnectionManager, setTimeoutSettings } from './connections'
import { collectTools, createMcpServer, generateToken } from './mcp'
import { installPluginProtocol, registerPluginScheme } from './plugins/protocol'
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

/**
 * At module scope, beside `hardenStdio`, and for the same kind of reason: it is
 * only correct **before `app.whenReady()`**.
 *
 * `protocol.registerSchemesAsPrivileged` after ready is not an error — it is
 * ignored, and `peek-plugin://` then loads with an opaque origin and no secure
 * context. A plugin frame would still come up, so nothing would look broken; the
 * isolation it exists to provide would simply not be there. Putting the call
 * where it cannot be reordered after `whenReady` is the only defence, since
 * there is no failure to test for.
 */
registerPluginScheme()

const isDev = !app.isPackaged

/* ================================================================== */
/* Process-wide singletons                                             */
/* ================================================================== */

const store = new WorkspaceStore()
const connections = new ConnectionManager()
/** The one place driver host events write back into the source of truth (state transitions reuse store/mutations) */
const resultSink = createResultEventSink(store)

let mainWindow: BrowserWindow | null = null
let mcp: McpController | null = null

/**
 * How large the window is drawn, and the store that remembers it.
 *
 * Module-level because three places need it and they run at different times:
 * `createWindow` (every load resets `zoomFactor`, so it has to be re-applied on
 * `did-finish-load`), the View menu, and the `settings.write` handler. The store
 * is null until `assemble` has resolved a config dir — the menu still works then,
 * it just cannot persist, which is the right degradation for a cosmetic setting.
 */
let uiZoom = UI_ZOOM_DEFAULT
let settingsStore: SettingsStore | null = null

function applyUiZoom(factor: number): void {
  uiZoom = factor
  mainWindow?.webContents.setZoomFactor(factor)
}

/**
 * The macOS `Settings…` item's handler.
 *
 * Silent when there is no window: the menu is installed before `bootstrap()`
 * creates one (and survives its close on macOS), and the item is a no-op in
 * both of those moments rather than a reason to create a window.
 */
function menuOpenSettings(): void {
  const wc = mainWindow?.webContents
  if (!wc || wc.isDestroyed()) return
  const message: MenuActionMessage = { action: 'openSettings' }
  wc.send(IPC.MENU_ACTION, message)
}

/** The View menu's handler: step, draw, remember. */
function menuZoom(step: 1 | -1 | 0): void {
  const next = step === 0 ? UI_ZOOM_DEFAULT : stepUiZoom(uiZoom, step)
  if (next === uiZoom) return
  applyUiZoom(next)
  settingsStore?.update({ uiZoom: next })
}
/**
 * The saved connections.
 *
 * Assembled lazily so that `safeStorage` is only asked whether it can encrypt
 * once the app is ready — on Linux that question talks to the keyring daemon,
 * and asking it during module evaluation answers "no" on a machine where the
 * answer is "yes".
 */
let book: ConnectionBook | null = null
/**
 * Set only once the MCP server is really listening, and cleared if it dies.
 *
 * The ACP host reads this at session-creation time and refuses to pretend: ACP's
 * `session/new` **silently degrades** when an MCP server is unreachable, so
 * without this check the user would get a Claude that cannot see the window and
 * no error anywhere explaining why.
 */
let mcpEndpoint: McpEndpointInfo | null = null

/**
 * The credential the embedded chat panel authenticates with, and nobody else.
 *
 * Minted once per process and never written to `~/.peek/mcp.json` — that file is
 * how an *external* client authenticates, and a token an external client can read
 * cannot identify anyone. It is what turns `source: 'agent'` from a comment into
 * a fact: `commands.ts` has described this wiring since the enum was written, and
 * until now nothing produced the value.
 *
 * The panel cannot reach the external token either: `buildAgentSessionMeta` gives
 * the session `tools: []` and `settingSources: []`, so it has no way to read a
 * file. The isolation rests on that, not on the agent behaving.
 *
 * See design/2026-08-02-agent-source-and-permission-scope.md §2.1–2.2.
 */
const agentToken = generateToken()
let acp: AcpManager | null = null
/**
 * The endpoint backend's teardown, when that is the backend in use.
 *
 * Separate from `acp` because only one of the two is ever built: the chat panel
 * has one backend per launch, chosen from settings. Shutdown calls whichever
 * exists.
 */
let endpoint: EndpointManager | null = null
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
        /*
         * The connection book plugs in here, and only here.
         *
         * `conn.open` stays the single write path: nothing else saves a
         * connection, and there is no second command that could describe one
         * differently. What happens around the handshake is
         *
         *   hydrate → connect → remember
         *
         * `hydrate` puts a stored password back into a config that arrived
         * without one — which is what lets the window offer a saved connection
         * without ever holding its credential. `remember` runs only after the
         * driver has actually connected, so the book cannot fill up with configs
         * that do not work.
         *
         * Note what is *not* affected: the config that went into the Workspace
         * during the reduce phase is the one the caller sent, so the hydrated
         * secret never enters the source of truth, never reaches a patch, and
         * never reaches `read_workspace`.
         */
        const config = book?.hydrate(req.config) ?? req.config
        const outcome = await connections.connect(config, {
          connId: req.connId,
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        })
        book?.remember(config)
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
          ...(req.queryPointId === undefined ? {} : { queryPointId: req.queryPointId }),
          ...(req.vectorName === undefined ? {} : { vectorName: req.vectorName }),
          topK: req.topK,
          ...(req.scoreThreshold === undefined ? {} : { scoreThreshold: req.scoreThreshold }),
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
  getKeyValue: (connId, ref, window) => connections.getValue(connId, ref, window),
}

/* ================================================================== */
/* 4. The window                                                       */
/* ================================================================== */

function createWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, '../preload/index.cjs')
  const hasPreload = existsSync(preloadPath)
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(import.meta.dirname, '../../resources/icon.png')
  const hasIcon = existsSync(iconPath)
  if (!hasPreload) {
    console.error(
      '[peek/error] preload build output missing:',
      preloadPath,
      '— the window will degrade to read-only',
    )
  }

  // BrowserWindow uses this on Windows/Linux; macOS takes its Dock icon from app.dock.
  if (process.platform === 'darwin' && hasIcon) app.dock?.setIcon(iconPath)

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    /*
     * `hidden` rather than `hiddenInset`, and the traffic lights placed by hand.
     * The inset variant puts them where a 38px system title bar would want them
     * (centre around y=19), and peek's own strip is `--bar-h` — 30px — so they
     * sat visibly low in it. y=9 centres a 12px button in 30px exactly; x=12
     * puts the right edge of the three at ~64px, which is what the strip's 72px
     * left padding leaves room for. See
     * `docs/design/2026-08-04-settings-into-app-menu.md` §2.3.
     */
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 9 } }
      : {}),
    backgroundColor: '#141414',
    ...(hasIcon ? { icon: iconPath } : {}),
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
  // Errors are forwarded in every build, not just in dev: a render failure now
  // shows the user a reload screen instead of a blank window (renderer's
  // ErrorBoundary), and the stack trace it logs is the only trace that failure
  // leaves anywhere — main's own state stayed valid throughout, so nothing else
  // reports a problem. Everything below error level stays behind the dev flag.
  const forwardAll = isDev || process.env['PEEK_FORWARD_CONSOLE'] === '1'
  win.webContents.on('console-message', (details) => {
    if (!forwardAll && details.level !== 'error') return
    console.log(`[peek/renderer:${details.level}]`, details.message)
  })

  // attachRenderer performs the data-plane handover, and it **must wait for the
  // document to finish loading** — otherwise the port passed to
  // webContents.postMessage is lost. Every reload needs a fresh handover.
  win.webContents.on('did-finish-load', () => {
    connections.attachRenderer(win.webContents)
    // `zoomFactor` is per-navigation state, not per-window: it resets to 1 on
    // every load, so remembering it once at startup is not enough — a dev-server
    // hot reload would silently undo the user's setting.
    win.webContents.setZoomFactor(uiZoom)
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

function buildMcpController(
  commandBus: CommandBus,
  rows: ResultRowsBroker,
  configDir: string,
  settings: SettingsStore,
): McpController {
  // An integration knob, in the same spirit as PEEK_SMOKE_EXIT_MS below: a smoke
  // run has to be able to start beside an already-installed peek without taking
  // its port. It **overrides the stored preference** rather than writing to it,
  // so a scripted run never edits the user's settings. Unset — the normal case —
  // the preference in ~/.peek/settings.json decides, falling back to 7332.
  const portOverride = Number(process.env['PEEK_MCP_PORT'] ?? '')

  return createMcpController({
    configDir,
    settings,
    ...(Number.isInteger(portOverride) && portOverride > 0 ? { forcedPort: portOverride } : {}),
    create: ({ port, token }) =>
      createMcpServer({
        port,
        configDir,
        ...(token === undefined ? {} : { token }),
        agentToken,
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
      }),
    notify,
    log: (line) => {
      console.log('[peek/mcp]', line)
    },
    // The ACP host reads this at session-creation time; a null endpoint is what
    // stops it from handing the user a Claude that silently cannot see the window.
    onEndpoint: (endpoint) => {
      // Same URL, different credential. This is the whole of the wiring: the ACP
      // host hands this straight to `buildPeekMcpServer`, so the embedded panel
      // opens its MCP session with the agent token and every command it sends
      // arrives as `source: 'agent'`.
      mcpEndpoint = endpoint === null ? null : { url: endpoint.url, token: agentToken }
    },
  })
}

/* ================================================================== */
/* 6. Lifecycle                                                        */
/* ================================================================== */

function bootstrap(): void {
  const commandBus = createCommandBus({ store, deps: createDeps() })
  const configDir = resolveConfigDir()

  // The one place peek is allowed to keep a credential. `safeStorage` hands the
  // key to the OS keychain; where that is unavailable the book saves the
  // connection **without** its password rather than writing it in the clear, and
  // `conn.book.list` reports which of the two happened.
  //
  // One vault for the process: connection passwords and the chat panel's endpoint
  // API key are the same kind of secret and go through the same seal.
  const vault = createSafeStorageVault(safeStorage)

  book = createConnectionBook({
    configDir,
    vault,
    onError: (message, detail) => {
      notify({ level: 'warn', message, detail })
    },
  })

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

  // "Fetch this view again every N seconds." The interval is ordinary view state;
  // this is only the timer that honours it. See main/auto-refresh.ts.
  const autoRefresh = createAutoRefreshScheduler({ store, bus: commandBus })
  disposers.push(() => {
    autoRefresh.dispose()
  })

  // MCP's run_query owes the AI a few sample rows, and row data lives only in the renderer cache
  const rows = createResultRowsBroker({ ipcMain, renderers })
  disposers.push(() => {
    rows.dispose()
  })

  // One store, shared. Two `createSettingsStore` calls over the same path would
  // each cache the file, and the second write would silently drop the first.
  //
  // **Before `wireChatHost`, and that ordering is load-bearing.** It reads
  // `settingsStore?.read().agent` to decide which backend answers, and this line
  // used to come after it — so `chosen` was always `undefined` and the endpoint
  // backend could never be selected no matter what `settings.json` said. Silent,
  // because falling back to the ACP agent is also what an unconfigured install
  // does: the panel worked, just never with the endpoint the user had chosen.
  const settings = createSettingsStore(configDir)
  settingsStore = settings

  // The chat panel is optional; the rest of peek is not. Anything that goes
  // wrong assembling it — most plausibly a `~/.peek` that cannot be written —
  // must not stop a window from ever being created. `createCommandBus` has
  // already registered the `createUnavailableChatRuntime` stubs, so leaving them
  // in place degrades chat panels visibly and leaves everything else intact.
  try {
    wireChatHost(commandBus, rows)
  } catch (error) {
    const failure = toPeekError(error)
    console.error('[peek/error] the chat host could not be assembled', failure)
    notify({
      level: 'error',
      message: 'The chat panel is unavailable.',
      detail: failure.detail ?? failure.message,
    })
  }
  // Adopt the remembered zoom before the window exists, so the first frame is
  // already the right size rather than snapping a moment after it appears.
  uiZoom = settings.read().uiZoom ?? UI_ZOOM_DEFAULT

  // Timeouts are a module-level singleton in `connections/timeouts.ts`, applied
  // rather than injected. This must happen before any connection is opened —
  // hence here, ahead of `createWindow()`. Invalid entries are dropped by
  // `setTimeoutSettings` itself, so a hand-edited file cannot leave the app with
  // no deadlines at all.
  const persistedTimeouts = settings.read().executionTimeouts
  if (persistedTimeouts) setTimeoutSettings(persistedTimeouts)

  // Reads and edits of what is on disk: the connection book, the MCP endpoint's
  // port and token, and the settings file. `read` handlers, so none of them
  // touch the Workspace — see config/handlers.ts.
  const controller = buildMcpController(commandBus, rows, configDir, settings)
  mcp = controller
  commandBus.registerAll(
    createConfigHandlers({
      book,
      mcp: controller,
      settings,
      vault,
      configDir,
      version: app.getVersion(),
      applyZoom: applyUiZoom,
    }),
  )

  createWindow()

  void controller.start()
}

/* ================================================================== */
/* 7. The chat panel's back end                                        */
/* ================================================================== */

/**
 * Assemble the ACP host and hand the bus a runtime that can actually reach it.
 *
 * ## The loop this closes
 *
 * The agent is a child process of main. It reaches back into peek over peek's own
 * MCP endpoint, which means an agent tool call travels
 * `agent → HTTP → main → Command Bus` — the same path a click takes, with the
 * same validation and the same command log. That is the whole point of the
 * feature, and it is also why two rules below are not negotiable:
 *
 * 1. **No command may stay open for the length of a turn.** `ChatRuntime.run` is
 *    never awaited by the bus, and `AcpManager.send` resolves when the turn is
 *    *accepted*, not when it finishes. A command that blocked until the agent was
 *    done would be holding the very event loop the agent's tool calls need.
 * 2. **The agent's session is created lazily, after MCP is listening.** Sessions
 *    come up on the first prompt, and `resolveMcpEndpoint` reports `null` until
 *    `startMcp` has actually bound the port.
 *
 * The two channels out of the host stay split for the reason `core/chat.ts`
 * argues at length: control-plane fields (status, mode, usage, the pending
 * permission) are small, low-frequency and must be visible to both the human and
 * `read_workspace`, so they go into the Workspace; the transcript is token-by-token
 * data plane and takes its own IPC channel, exactly as result chunks do.
 */
/**
 * The endpoint backend, when the user configured one.
 *
 * Returns null — and says why — rather than throwing, on any of the three ways
 * this can be unusable: no endpoint configured, a key the keychain will not open,
 * or a provider that cannot be built from what is stored. The caller then falls
 * back to the bundled agent, which is a working chat panel rather than none, and
 * the notification is what keeps that from being a silent substitution.
 */
function wireEndpointBackend(
  chosen: NonNullable<ReturnType<SettingsStore['read']>['agent']>,
  sessionIndex: SessionIndex,
  source: ReturnType<typeof createContextSource>,
  onError: (chatId: never, error: never) => void,
  commandBus: CommandBus,
  rows: ResultRowsBroker,
): ChatRuntime | null {
  const config = chosen.endpoint
  if (!config) {
    notify({
      level: 'warn',
      message: 'The chat panel is set to use your own endpoint, but none is configured.',
      detail: 'Add a base URL and a model in Settings → Chat agent. Using the bundled agent for now.',
    })
    return null
  }

  // Unsealed here and nowhere else. It travels from this line into the provider
  // and out as an HTTP header; nothing writes it to a file or a log, and
  // `EndpointManager` redacts it from every error it reports.
  let apiKey: string | null = null
  if (chosen.endpointApiKeySealed) {
    apiKey = createSafeStorageVault(safeStorage).open(chosen.endpointApiKeySealed)
    if (apiKey === null) {
      notify({
        level: 'warn',
        message: 'The chat endpoint’s API key could not be read.',
        detail:
          'It was sealed by a different machine or user account. Enter it again in Settings → Chat agent. ' +
          'Continuing without a key.',
      })
    }
  }

  const manager = new EndpointManager(
    {
      applyState: createChatStateApplier(store),
      emitDeltas: createDeltaEmitter(renderers, sendChatDeltas),
      notify,
      // The same tools an external MCP client sees, called in-process rather than
      // over the loopback: no second credential, and `source: 'agent'` is passed
      // by this line rather than inferred from a bearer token.
      tools: collectTools(),
      toolContext: {
        dispatch: (name, input, callSource) => commandBus.dispatch(name, input, callSource) as never,
        getSnapshot: (): WorkspaceSnapshot => store.getSnapshot(),
        readResultRows: (req) => rows.read(req),
        logger: {
          log: (level, message, detail) => {
            if (level === 'error') console.error('[peek/agent]', message, detail ?? '')
            else if (level === 'warn') console.warn('[peek/agent]', message, detail ?? '')
            else console.log('[peek/agent]', message)
          },
        },
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      // This backend's history. Under the chat root beside each ACP agent's
      // workdir, for the same reason those are separated: one directory per
      // backend, so nobody enumerates anybody else's files.
      threads: new EndpointThreadStore(
        join(chatRootDir(process.env['PEEK_CONFIG_DIR']), ENDPOINT_THREAD_DIR),
      ),
      sessionIndex,
    },
    {
      settings: config,
      apiKey,
      permissionMode: chosen.permissionMode ?? 'default',
      batch: DEFAULT_DELTA_BUDGET,
      source: 'agent',
    },
  )
  endpoint = manager

  return createEndpointChatRuntime({
    manager,
    source,
    notify,
    onError: onError as never,
    sessionIndex,
    modelId: config.model,
  })
}

function wireChatHost(commandBus: CommandBus, rows: ResultRowsBroker): void {
  const sink = createChatEventSink(store)
  const applyState = createChatStateApplier(store)
  const source = createContextSource({ store, connections, rows })
  const onError = (chatId: Parameters<typeof sink.onAgentError>[0], error: Parameters<typeof sink.onAgentError>[1]): void => {
    sink.onAgentError(chatId, error)
  }

  // Which agent the user picked, read once at wire-up. Changing it in settings
  // decides what the *next* peek launch runs: a backend holds live sessions, and
  // swapping it under a conversation would hand a transcript to something that
  // cannot read it. The settings panel says so.
  const chosen = settingsStore?.read().agent
  // One index for every backend, at the root of the chat directory — each agent
  // owns a subdirectory under it, and the index is what says which. Built here
  // because assembly is the only place that knows the config directory.
  const sessionIndex = SessionIndex.at(chatRootDir(process.env['PEEK_CONFIG_DIR']))

  if (chosen?.backend === 'endpoint') {
    const runtime = wireEndpointBackend(chosen, sessionIndex, source, onError, commandBus, rows)
    if (runtime) {
      commandBus.registerAll(createChatHandlers(runtime))
      disposers.push(watchChatViews(store, runtime))
      disposers.push(installChatRestoreIpc({ ipcMain, restore: (id) => runtime.restore(id) }))
      return
    }
    // Configured for an endpoint that is not usable — no URL, no model, or a key
    // the keychain will not open. The ACP backend below is not a silent
    // substitution: the notify above says what happened and what to fix.
  }

  const acpConfig = defaultAcpConfig(chosen?.acpProfile)
  if (chosen?.acpExecutablePath) acpConfig.agentConfig = { executablePath: chosen.acpExecutablePath }
  // The mode a new conversation starts in. The panel's own dropdown still moves it
  // per conversation — this only decides where it starts.
  if (chosen?.permissionMode) acpConfig.permissionMode = chosen.permissionMode

  const manager = new AcpManager(
    {
      applyState,
      emitDeltas: createDeltaEmitter(renderers, sendChatDeltas),
      notify,
      resolveMcpEndpoint: () => mcpEndpoint,
      sessionIndex,
      // Pictures of ACP conversations, so opening one from the rail draws
      // immediately instead of waiting out `session/load`. A sibling of the
      // endpoint backend's `endpoint/` directory rather than a tenant of it:
      // that one holds conversations peek owns, this one holds pictures of
      // conversations it does not. See `AcpSnapshotStore`.
      snapshots: new AcpSnapshotStore(
        join(chatRootDir(process.env['PEEK_CONFIG_DIR']), ACP_SNAPSHOT_DIR),
      ),
    },
    { ...acpConfig, clientVersion: app.getVersion() },
  )
  acp = manager

  // Diagnostics, not state: the host reports its own process lifecycle here, and
  // only the terminal case is worth interrupting the user for.
  manager.events.on('log', ({ level, message, detail }) => {
    if (level === 'error') console.error('[peek/acp]', message, detail ?? '')
    else if (level === 'warn') console.warn('[peek/acp]', message, detail ?? '')
    else console.log('[peek/acp]', message, detail ?? '')
  })
  manager.events.on('ready', ({ pid, agentName, agentVersion }) => {
    console.log(`[peek/acp] agent ready: ${agentName} ${agentVersion} (pid ${pid ?? '?'})`)
  })
  manager.events.on('gaveUp', ({ error }) => {
    notify({
      level: 'error',
      message: `The chat agent could not be restarted: ${error.message}`,
      detail: 'Chat panels are unusable until peek is restarted. Everything else is unaffected.',
    })
  })

  const runtime = createAcpChatRuntime({
    manager,
    source,
    notify,
    // Failures that escape the agent land on the conversation the user is looking
    // at, through the same sink the streaming path writes with.
    onError,
    sessionIndex,
  })

  // Overwrites the `createUnavailableChatRuntime` stubs `createCommandBus`
  // registered, by name. Until this line a chat view opens, stages attachments
  // and accepts a message that is never answered — which is the honest degraded
  // state, not a crash.
  commandBus.registerAll(createChatHandlers(runtime))

  // The renderer's way back from a reload. Registered here rather than with the
  // bus because it is not a command: it asks main to repeat what it already
  // sent, and changes nothing. See `docs/design/2026-08-03-chat-history-ownership.md` §2.4.
  disposers.push(installChatRestoreIpc({ ipcMain, restore: (id) => runtime.restore(id) }))

  // Conversations appear and disappear through at least four routes (view.close,
  // layout.close, setLayout with unplaced:'close', conn.close). Watching the state
  // answers "which conversations exist" once, for every route including ones
  // added later, instead of hanging a hook on each.
  disposers.push(watchChatViews(store, runtime))
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
  mcpEndpoint = null
  book = null
  // Then the agent, and only then the drivers. The agent is a child process that
  // would otherwise be orphaned, and it may still be mid-turn; taking its MCP
  // endpoint away first means anything it tries fails cleanly instead of racing
  // driver teardown.
  await acp?.dispose().catch((error: unknown) => {
    console.error('[peek/error] failed to shut the chat agent down', error)
  })
  acp = null
  // The endpoint backend has no child process, but it does have pending
  // permission prompts and in-flight turns; disposing settles both rather than
  // leaving a promise nobody will ever answer.
  endpoint?.dispose()
  endpoint = null
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
    // Ahead of `bootstrap()` on purpose. The menu is not a feature of a fully
    // assembled app — two of the things it does are corrections that must hold
    // even if assembly fails: it keeps Reload and DevTools out of a packaged
    // build, and it stops the default Window menu from binding ⌘W, which is
    // peek's own "close tab". See menu.ts.
    installAppMenu({ isDev, onZoom: menuZoom, onOpenSettings: menuOpenSettings })

    // Before `bootstrap()`, which creates the window: the first thing a restored
    // workspace can contain is a plugin view, and its iframe would then request
    // a scheme with no handler. That failure is silent in the frame — a blank
    // panel, no console entry in the host — so the ordering is the fix.
    installPluginProtocol()

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
