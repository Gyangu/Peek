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
 * peek 主进程装配（PLAN 第 3 / 6 / 7 节）。
 *
 * 依赖方向是单向的，装配顺序必须照着来：
 *
 *   WorkspaceStore（真源）
 *     → ConnectionManager（进程模型；只发事件，不改真源）
 *     → CommandDeps（把管理器包成 bus 认识的副作用接口）
 *     → CommandBus（UI 与 MCP 唯一入口）
 *     → IPC 装配（patch 广播 / 命令通道 / 数据面端口）
 *     → MCP HTTP Server（读真源、写走 bus）
 *     → 窗口
 *
 * 反向引用一律通过事件或注入，绝不 import 回去：
 * ConnectionManager 不认识 Bus，Bus 不认识 ConnectionManager，MCP 不认识两者。
 */

/* ================================================================== */
/* stdio 韧性：日志写不出去不该让 app 崩                                   */
/* ================================================================== */

/**
 * 当父进程先退出、或 app 是经由管道/nohup 启动时，stdout / stderr 可能已经关闭。
 * 此时任何 console.* 都会抛 EPIPE，冒泡成主进程未捕获异常，
 * Electron 随即弹出「A JavaScript error occurred in the main process」错误框——
 * 日志通道断掉本身是无害的，却把整个 app 表现成了崩溃。
 *
 * 两道防护：
 *   1. 给两个流挂 error 监听，吞掉 EPIPE / 流已销毁这类写入失败（其余错误照旧抛出）；
 *   2. console.* 再包一层同步 try/catch，兜住 Node 在某些路径下同步抛出的写入错误。
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
        // 管道已断：静默丢弃这条日志
      }
    }
  }
}

hardenStdio()

const isDev = !app.isPackaged

/* ================================================================== */
/* 进程级单例                                                           */
/* ================================================================== */

const store = new WorkspaceStore()
const connections = new ConnectionManager()
/** driver host 事件 → 真源的唯一回填口（状态机复用 store/mutations） */
const resultSink = createResultEventSink(store)

let mainWindow: BrowserWindow | null = null
let mcp: McpServerHandle | null = null
const disposers: (() => void)[] = []

/** 当前需要收 patch / 通知的 renderer；窗口可能还没建或已销毁 */
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
/* 1. Command Bus 的副作用依赖                                          */
/* ================================================================== */

/**
 * 把 ConnectionManager 适配成 Bus 认识的 `CommandDeps`。
 *
 * 这一层只做形状转换，没有任何策略：
 * 取数方法**只负责把请求送到 driver host**，行数据由 host 经 MessagePort 直发 renderer，
 * 执行过程中的 schema / 行数 / 收尾 / 报错由 connections.events 回填真源（见下方订阅）。
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
          // 连接早就没了 / 结果集已结束：按契约回 false，不要把取消变成一条错误命令
          return false
        }
      },
    },

    notify,
  }
}

/* ================================================================== */
/* 2. driver host 事件 → 真源 + 通知                                     */
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
      // driver host 的 stdout/stderr 很吵，只有 warn 以上才打扰用户
      if (level === 'info') {
        console.log('[peek/driver]', message, detail ?? '')
        return
      }
      notify({ level, message, connId, ...(detail === undefined ? {} : { detail }) })
    }),

    events.on('crashed', ({ connId, error }) => {
      notify({
        level: 'error',
        message: `driver 进程异常退出：${error.message}`,
        connId,
        detail: '该连接已不可用，请重新连接。其它连接不受影响。',
      })
    }),
  )
}

/* ================================================================== */
/* 3. 非命令类只读通道（契约缺口的补丁，见文件末尾说明）                    */
/* ================================================================== */

const driverRpc: DriverRpcOptions = {
  introspect: (connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> =>
    connections.introspect(connId, parentId, refresh),
  peekValue: (connId, ref, range) => connections.peekValue(connId, ref, range),
  getKeyValue: (connId, ref) => connections.getValue(connId, ref),
}

/* ================================================================== */
/* 4. 窗口                                                             */
/* ================================================================== */

function createWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, '../preload/index.cjs')
  const hasPreload = existsSync(preloadPath)
  if (!hasPreload) {
    console.error('[peek/error] preload 产物缺失：', preloadPath, '——界面将退化为只读态')
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
      // 安全基线：renderer 无 Node、开上下文隔离、开沙箱
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(hasPreload ? { preload: preloadPath } : {}),
    },
  })

  // 冷启动预算 < 1.5s：首帧准备好再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show()
  })

  // renderer 出事必须在主进程日志里看得见，否则界面白屏时无从查起
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[peek/error] 界面加载失败', code, description, url)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    notify({
      level: 'error',
      message: `界面进程退出（${details.reason}）`,
      detail: '连接与 driver 进程仍在，重开窗口即可恢复。',
    })
  })
  if (isDev || process.env['PEEK_FORWARD_CONSOLE'] === '1') {
    win.webContents.on('console-message', (details) => {
      console.log(`[peek/renderer:${details.level}]`, details.message)
    })
  }

  // 数据面端口靠 attachRenderer 移交，**必须等文档加载完**，
  // 否则 webContents.postMessage 的端口会丢；每次重载都要重新移交。
  win.webContents.on('did-finish-load', () => {
    connections.attachRenderer(win.webContents)
  })

  win.on('closed', () => {
    connections.detachRenderer()
    if (mainWindow === win) mainWindow = null
  })

  // 外链一律丢给系统浏览器，窗口内不允许导航到外部
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
    // UI 与 AI 共用同一条指令通道：source 只进日志，不改任何一行执行路径
    dispatch: (name, input, source) => commandBus.dispatch(name, input, source),
    getSnapshot: (): WorkspaceSnapshot => store.getSnapshot(),
    // introspect 不是 Command（COMMAND_NAMES 里没有），走注入的只读通道
    introspect: (req) => driverRpc.introspect(req.connId, req.parentId, req.refresh),
    // 行数据只在 renderer 的缓存里（chunk 不经过 main），向 renderer 取样
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
    console.log(`[peek/mcp] 已监听 ${endpoint.url}`)
    console.log(`[peek/mcp] 接入方式：${endpoint.hint}`)
  } catch (raw) {
    mcp = null
    const error: PeekError = toPeekError(raw)
    notify({
      level: 'error',
      message: `MCP server 启动失败：${error.message}`,
      detail:
        error.code === 'CONFLICT'
          ? '端口被占用（可能已有一个 peek 在跑）。界面照常可用，只是 AI 连不进来。'
          : (error.detail ?? ''),
    })
  }
}

/* ================================================================== */
/* 6. 生命周期                                                          */
/* ================================================================== */

function bootstrap(): void {
  const commandBus = createCommandBus({ store, deps: createDeps() })

  wireConnectionEvents()

  // renderer ↔ Bus / Store：命令通道 + 全量快照 + patch 广播
  disposers.push(
    installBusIpc({
      ipcMain,
      bus: commandBus,
      store,
      renderers,
    }),
  )

  // 命名空间树 / 单值取全量：这三件事没有对应的 Command（契约缺口），
  // 走一条独立的只读 IPC，不进 Workspace 状态也不进 Command 日志
  disposers.push(installDriverRpc({ ipcMain, ...driverRpc }))

  // MCP run_query 要给 AI 回几行样本，而行数据只在 renderer 缓存里
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
      console.error('[peek/error] 清理钩子抛错', error)
    }
  }
  // MCP 先关：别让 AI 在 driver 收尸期间还能发命令进来
  await mcp?.close().catch((error: unknown) => {
    console.error('[peek/error] 关闭 MCP server 失败', error)
  })
  mcp = null
  await connections.disposeAll().catch((error: unknown) => {
    console.error('[peek/error] 回收 driver 进程失败', error)
  })
}

// 单实例：MCP 端口与本地状态都是单点，多开没有意义
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

    // 冒烟自检：设了这个环境变量就在 N 毫秒后自己退出，供 CI / 集成脚本用
    const smokeMs = Number(process.env['PEEK_SMOKE_EXIT_MS'] ?? '')
    if (Number.isFinite(smokeMs) && smokeMs > 0) {
      setTimeout(() => {
        console.log('[peek] 冒烟自检结束，退出')
        app.quit()
      }, smokeMs)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * 优雅退出：driver host 是独立进程，不收会留一堆孤儿；MCP 占着 7332 端口。
   * before-quit 是同步事件，所以先 preventDefault，异步收干净之后再真正 quit。
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
