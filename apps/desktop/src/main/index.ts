import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from 'electron'
import type {
  ConnId,
  MenuActionMessage,
  NamespaceNode,
  NotifyLevel,
  NotifyMessage,
  WorkspaceSnapshot,
} from '@peek/core'
import { IPC, stepUiZoom, toPeekError, UI_ZOOM_DEFAULT } from '@peek/core'
import { installAppMenu } from './menu'
import { hardenWindow } from './window-hardening'
import { createAutoRefreshScheduler } from './auto-refresh'
import {
  createCommandBus,
  type CommandBus,
  type CommandDeps,
  type PackageAdminService,
} from './bus'
import {
  createChatEventSink,
  createChatHandlers,
  createViewHandlers,
  watchChatViews,
  type ChatRuntime,
} from './bus/handlers'
import {
  installBusIpc,
  installChatRestoreIpc,
  sendChatDeltas,
  sendNotify,
  sendPackagesChanged,
} from './bus/ipc-main'
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
  packagesDir,
  resolveConfigDir,
  type ConnectionBook,
  type McpController,
  type SettingsStore,
  type StoredDisplay,
} from './config'
import {
  createAcpChatRuntime,
  createChatStateApplier,
  createContextSource,
  createDeltaEmitter,
  createEndpointChatRuntime,
} from './chat-host'
import { ConnectionManager, setTimeoutSettings } from './connections'
import { collectTools, createMcpServer, generateToken, type PackageToolCaller } from './mcp'
import { installedPackages as installedSnapshot } from '../drivers/installed'
import {
  bundledCatalog,
  bundledPackagesRoot,
  layOutBundledPackages,
  type BundledLayoutReport,
} from './packages/bundled'
import { adoptPackageScan } from './packages/adopt'
import { createPackageAdmin } from './packages/admin'
import { createPackageHandlers, type PackageCommandOptions } from './packages/commands'
import { createConnectionDisplayService } from './packages/display'
import { packageLoadNotices } from './packages/installed'
import { loadPackages, type PackageLoadReport } from './packages/loader'
import { packageEntryPaths } from './packages/locations'
import { PackageHostRegistry } from './packages/registry'
import { createPackageViewSource } from './packages/view-answers'
import { installPackageProtocol, registerPackageScheme } from './packages/protocol'
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
 * ignored, and `peek-package://` then loads with an opaque origin and no secure
 * context. A package frame would still come up, so nothing would look broken; the
 * isolation it exists to provide would simply not be there. Putting the call
 * where it cannot be reordered after `whenReady` is the only defence, since
 * there is no failure to test for.
 */
registerPackageScheme()

const isDev = !app.isPackaged

/* ================================================================== */
/* Process-wide singletons                                             */
/* ================================================================== */

const store = new WorkspaceStore()
const connections = new ConnectionManager({
  // `PEEK_DRIVER_HOST_DIR` relocates the process that receives unredacted
  // passwords, so a shipped peek ignores it outright and only a development or
  // test run may use it. The decision is made here rather than inside the
  // manager because that module is imported by `node --test`, where `electron`
  // is not importable. See `resolveHostDir`.
  allowHostDirOverride: !app.isPackaged,
})
/**
 * The package host pool.
 *
 * Empty until something needs a value only a package can compute, which is the
 * whole design (§2.4bis c): installing packages costs manifests read at startup
 * and no processes. Nothing here forks; `hostFor` does, and only `hostFor`.
 */
const packageHosts = new PackageHostRegistry({
  // Read at fork time, not now: this constant is evaluated while main is still
  // loading its own imports, and the scan that fills the slot runs inside
  // `app.whenReady()`.
  resolveContrib: (packageId) => packageEntryPaths(packageId)?.contrib ?? null,
  onLog: (packageId, level, text) => {
    notify({ level, message: `[${packageId}] ${text}` })
  },
})

/**
 * How a package's MCP tool reaches the process that can run it.
 *
 * One deadline for every package tool, and a short one: what crosses is the
 * *mapping* — the tool's `toCommands` or its receipt renderer — not the query it
 * maps onto. Whatever the Commands it produces then go on to do has its own
 * budget, on the driver side, where the work actually is.
 */
const PACKAGE_TOOL_MS = 10_000

const callPackageTool: PackageToolCaller = (packageId, call) =>
  packageHosts.call(packageId, 'callTool', call, PACKAGE_TOOL_MS)

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

/**
 * Notices raised before any window had loaded, kept until one has.
 *
 * Startup happens entirely before `createWindow` — the bundled lay-out and the
 * package scan both have to finish before preload can be answered — so every
 * notice either of them produces was, until this buffer, sent to nobody and
 * survived only in the console. That is the wrong half of the audience: a
 * refused package means a database the user can no longer connect to, and the
 * place they are meant to find out is the error centre (`packageLoadNotices` in
 * `packages/installed.ts` is written for a reader, not for a log).
 *
 * Bounded, because a window that never finishes loading would otherwise make
 * this grow for the life of the process. It holds the *oldest* entries on
 * purpose: the first refusal is the one that explains the rest.
 */
const pendingNotices: NotifyMessage[] = []
const PENDING_NOTICE_CAPACITY = 100
/** Flipped by the first `did-finish-load`; before it, `sendNotify` has nothing to send to. */
let rendererHasLoaded = false

function notify(message: NotifyMessage): void {
  // A window that exists but has not run its scripts drops what it is sent, so
  // the gate is "has one loaded", not "is there one".
  if (rendererHasLoaded) sendNotify(renderers(), message)
  else if (pendingNotices.length < PENDING_NOTICE_CAPACITY) pendingNotices.push(message)
  const tag = `[peek/${message.level}]`
  if (message.level === 'error') console.error(tag, message.message, message.detail ?? '')
  else if (message.level === 'warn') console.warn(tag, message.message, message.detail ?? '')
}

/** Hand the startup notices to the window that just came up, in the order they happened. */
function flushPendingNotices(target: WebContents): void {
  rendererHasLoaded = true
  const queued = pendingNotices.splice(0, pendingNotices.length)
  for (const message of queued) sendNotify([target], message)
}

/**
 * Say what happened to the packages this build ships.
 *
 * The console is the channel and not a fallback: this runs before there is a
 * window, so `notify`'s renderer half is empty by construction. The place a
 * person is meant to see this is the settings panel, which reads the same
 * outcomes to draw "upgrade" and "restore bundled packages" (design §2.8).
 *
 * Only the outcomes somebody can act on are said out loud. "Laid out" on a first
 * run is five lines of noise about the app working, and `kept` is every launch
 * after that.
 */
function reportBundledLayout(report: BundledLayoutReport): void {
  for (const status of report.statuses) {
    // `laid-out` and `kept` carry no detail, which is the same statement: the
    // first is the app working on a first run, the second is every launch after.
    if (status.detail === null) continue
    const level: NotifyLevel = status.outcome === 'failed' ? 'error' : 'info'
    notify({ level, message: `Bundled package '${status.id}': ${status.detail}` })
  }
}

/**
 * Read `<configDir>/packages/` and make what is there the registry every process
 * reads.
 *
 * The production caller `loadPackages` was landed without (`loader.ts`'s "not
 * wired yet"), and the half of acceptance 11 that was missing: a package outside
 * the repository could be *read* and not *used*, because main and the window
 * both still built their registries from a compile-time list (§4undecies(b)).
 * Three lines, and every registry downstream — driver manifests, the spawn
 * table, the connect dialog's picker — is now a projection of this call.
 *
 * ## Every refusal is said out loud, and none of them stops the boot
 *
 * A refused package is a database that is simply not there, which without a line
 * on the error centre is indistinguishable from a bug in peek — the user opens
 * the connect dialog and PostgreSQL is missing. So each one is reported with all
 * of its issues (design §4.2 item 10: one bad package does not cost the others),
 * and the `redact` warnings with it: decision 5 made that warning the *only*
 * observable consequence of a package that never considered which of its fields
 * are secret, and a warning nobody sees would leave it with none.
 *
 * The console is half the channel and not a fallback: this runs before there is
 * a window, so `notify`'s renderer half is empty by construction, exactly as it
 * is for `reportBundledLayout` above.
 */
function installAndReportPackages(packagesRoot: string): PackageLoadReport {
  const report = loadPackages(packagesRoot)
  adoptPackages(report)
  for (const notice of packageLoadNotices(report, packagesRoot)) notify(notice)
  return report
}

/**
 * Make one scan the registry every process reads, and tell the windows.
 *
 * Split out of `installAndReportPackages` because `packages.install` and
 * `packages.uninstall` need exactly this and nothing else: no notices (a
 * command's own refusals come back in its receipt, and re-announcing every
 * pre-existing one on each install would bury them) and no ordering assumptions
 * about the window, which by then exists.
 *
 * The broadcast is the third line rather than the caller's job, so that it is
 * impossible to replace the registry without saying so. A window holding a
 * driver list main has already forgotten offers a database that no longer opens,
 * and nothing about that is loud.
 */
function adoptPackages(report: PackageLoadReport): void {
  // The two registry halves are `packages/adopt.ts`, not two lines here: they
  // have to move together, and a test that drives the four verbs has to be able
  // to install them the way this line does rather than by copying it.
  sendPackagesChanged(renderers(), adoptPackageScan(report))
}

/**
 * Everything the four `packages.*` verbs need from this process.
 *
 * Assembled once and shared by the handlers and by the uninstall effect, so
 * there is one packages root and one bundled catalog in the process rather than
 * one per caller. The catalog is read here and held — see the field's note in
 * `packages/commands.ts` for why that is safe and why it has to be.
 *
 * `bundledRoot` is the same path the startup lay-out used, computed the same
 * way. Two spellings of "where this build keeps its copies" would be one
 * spelling too many: `packages.restore` and the first start have to reach the
 * identical directory or "restore" means something different from "lay out".
 *
 * `toolsChanged` reaches the controller through the module-level `mcp` at call
 * time rather than capturing a handle: a rebind (a new port, a rotated token)
 * replaces the server handle, and a captured one would be notifying sessions
 * that closed with the endpoint it belonged to.
 */
function createPackageCommandOptions(): PackageCommandOptions {
  const packagesRoot = packagesDir(resolveConfigDir())
  const bundledRoot = bundledPackagesRoot(
    import.meta.dirname,
    app.isPackaged ? process.resourcesPath : null,
  )
  return {
    packagesRoot,
    bundledRoot,
    catalog: bundledCatalog(bundledRoot),
    scan: () => loadPackages(packagesRoot),
    adopt: adoptPackages,
    toolsChanged: () => {
      mcp?.notifyToolsChanged()
    },
    notify,
  }
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
function createDeps(packages: PackageAdminService): CommandDeps {
  return {
    // Naming a connection is the owning package's job and the package runs
    // elsewhere, so it arrives here as a side effect like any other. See
    // `describeConnection` in bus/intents.ts for why the reducer cannot wait.
    display: createConnectionDisplayService(packageHosts),

    // Taking one off the disk, after `packages.uninstall` has closed everything
    // that pointed at it.
    packages,

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
        book?.remember(config, nameOf(req.connId))
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

/**
 * What a connection is called, read back out of the source of truth on its way
 * into the connection book.
 *
 * The answer is already there because `conn.open` plans `describeConnection`
 * **before** `connect` and intents run in order (`bus/effects.ts`), so the round
 * trip to the package host has landed by the time the connect effect gets here.
 * That ordering is now load-bearing rather than cosmetic, and
 * `connection-book.test.ts` pins it.
 *
 * Empty when naming did not succeed — it is a soft intent, so a slow host leaves
 * a working connection unnamed. `remember` then keeps the pair the entry already
 * had (see `pickDisplay`); main must not fall back to computing it, which is the
 * whole point of §2.3(b-2).
 */
function nameOf(connId: ConnId): StoredDisplay {
  const conn = store.getState().connections[connId]
  return { label: conn?.label ?? '', detail: conn?.detail ?? '' }
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
    // Right here rather than on `ready-to-show`: the same reason the handover
    // above waits for this event is the reason a notice does — before it, the
    // renderer has not subscribed and the message goes on the floor.
    flushPendingNotices(win.webContents)
    // `zoomFactor` is per-navigation state, not per-window: it resets to 1 on
    // every load, so remembering it once at startup is not enough — a dev-server
    // hot reload would silently undo the user's setting.
    win.webContents.setZoomFactor(uiZoom)
  })

  win.on('closed', () => {
    connections.detachRenderer()
    if (mainWindow === win) mainWindow = null
  })

  // No new windows, no navigation, no permissions. In its own module so the
  // Electron probe can exercise this exact function rather than a copy of it —
  // these are Chromium behaviours, so an assertion is the only honest check and
  // it has to run against the real thing. Design 2026-08-07 §2.10.
  hardenWindow(win)

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
        // Passed rather than left to `collectTools()`'s own default, because the
        // default has no way to reach a package host: a tool would list and then
        // refuse to run.
        callPackageTool,
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
  const packageOptions = createPackageCommandOptions()
  // Wrapped rather than passed as `packageHosts.dispose`, which would arrive
  // unbound. One binding for both callers: an install and an uninstall have to
  // reach the same registry, or one of them kills a host the other still has.
  const disposeHost = (packageId: string): Promise<void> => packageHosts.dispose(packageId)
  const packages = createPackageAdmin(packageOptions, disposeHost)
  const commandBus = createCommandBus({ store, deps: createDeps(packages) })

  // Overwrites the `createUnavailablePackageViews` stubs `createCommandBus`
  // registered, exactly as the chat handlers below are overwritten. Until this
  // line runs, a package view opens and never fetches — which is also what it
  // does when the package that owns it is gone, so there is no second code path.
  commandBus.registerAll(
    createViewHandlers(
      createPackageViewSource(packageHosts, {
        onError: (message, detail) => {
          notify({ level: 'warn', message, detail })
        },
      }),
    ),
  )

  // The four kernel verbs of §2.4, replacing the `unavailablePackageHandlers`
  // stubs the same way. They can be registered this early because they depend on
  // nothing that is assembled below: the packages root is an environment
  // variable, the scan is a directory read, and the MCP notification is looked up
  // through `mcp` at call time.
  commandBus.registerAll(createPackageHandlers(packageOptions, disposeHost))

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
      tools: collectTools({ callPackageTool }),
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
  // Last, and unconditionally: a package host holds no connection, so there is
  // nothing to wind down first — only processes to reap.
  await packageHosts.disposeAll().catch((error: unknown) => {
    console.error('[peek/error] failed to reclaim package host processes', error)
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
    // workspace can contain is a package view, and its iframe would then request
    // a scheme with no handler. That failure is silent in the frame — a blank
    // panel, no console entry in the host — so the ordering is the fix.
    //
    // `resolveConfigDir()` is called again here rather than threaded down from
    // `bootstrap()`: it reads one environment variable and nothing else, and
    // ordering the protocol behind the window's assembly is what the paragraph
    // above forbids.
    const packagesRoot = packagesDir(resolveConfigDir())

    // And before the protocol, because this is what puts a package's `ui/` where
    // the protocol serves it from. The shipped packages are copied into
    // `~/.peek/packages/` exactly once — never over anything already there, and
    // never over a tombstone (design 2026-08-07 §2.5); after that they are
    // ordinary installed packages, which is decision 1.
    reportBundledLayout(
      layOutBundledPackages({
        bundledRoot: bundledPackagesRoot(import.meta.dirname, app.isPackaged ? process.resourcesPath : null),
        packagesRoot,
      }),
    )

    // Then the scan, which is what turns those directories into a registry. It
    // has to be after the lay-out (a first start would otherwise find nothing)
    // and before `bootstrap()`, which creates the window: preload reads the
    // registry synchronously as the window loads, and the connect dialog's
    // fields, the capability prediction and the spawn table are all projections
    // of it.
    installAndReportPackages(packagesRoot)

    // The window's only route to that registry, and it is answered from memory:
    // `event.returnValue` blocks the renderer until it is set, so anything slower
    // than a property read here would be a stall on every window load. See
    // `IPC.PACKAGES_READ` for why the channel is synchronous at all.
    //
    // Registered here rather than in `bootstrap()` because preload asks before
    // the window's first script runs, and a handler installed a tick later would
    // answer `undefined` on exactly the launches that are slowest.
    ipcMain.on(IPC.PACKAGES_READ, (event) => {
      event.returnValue = installedSnapshot()
    })

    // The window half of "Install…". It picks and stops there — validating the
    // directory and copying it in is `packages.install`, which the window sends
    // next, so a hand-typed path and a picked one meet exactly the same checks.
    // See `IPC.PACKAGES_PICK_DIR` for why this is not itself a command.
    ipcMain.handle(IPC.PACKAGES_PICK_DIR, async (event): Promise<string | null> => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      // Sheet-modal to the window that asked, when there is one: the dialog is
      // an answer to a click in that window, and a detached chooser on macOS is
      // one more thing to find behind the app.
      const result = await (parent === null
        ? dialog.showOpenDialog({ properties: ['openDirectory'] })
        : dialog.showOpenDialog(parent, { properties: ['openDirectory'] }))
      // `filePaths` is empty on cancel; `null` says that plainly rather than
      // making the renderer read an array's length to find out.
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })

    installPackageProtocol(packagesRoot)

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
