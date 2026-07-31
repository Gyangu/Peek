/**
 * MCP Streamable HTTP server（PLAN 第 7 节）。
 *
 * - 绑 127.0.0.1:7332（端口可配），**绝不绑 0.0.0.0**
 * - bearer token 校验，token 落在 ~/.peek/mcp.json（0600）
 * - 每个 HTTP session 一个 StreamableHTTPServerTransport + McpServer 实例
 * - 优雅关闭：先停监听，再关所有 session，最后掐残留 socket
 *
 * 依赖注入：不 import Command Bus 实例，全部通过 createMcpServer 参数传入。
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_DEFAULT_HOST,
  MCP_DEFAULT_PORT,
  MCP_HTTP_PATH,
  peekError,
  toPeekError,
  type PeekError,
  type WorkspaceSnapshot,
} from '@peek/core'
import { collectBuiltinTools, registerTools } from './registry'
import {
  defaultConfigDir,
  generateToken,
  readExistingToken,
  tokenMatches,
  writeEndpointFile,
  type McpEndpointFile,
} from './token'
import type {
  CommandDispatch,
  IntrospectReader,
  McpLogger,
  PeekTool,
  ResultRowsReader,
  ToolContext,
} from './types'

/* ================================================================== */
/* 常量                                                                */
/* ================================================================== */

/** 单次 POST 体积上限（JSON-RPC 报文不该大，超了直接 413） */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** 同时存活的 session 上限，超了淘汰最久未活动的 */
const MAX_SESSIONS = 16
/** session 闲置超时：30 分钟 */
const SESSION_IDLE_MS = 30 * 60 * 1000
/** 闲置清扫周期 */
const SWEEP_INTERVAL_MS = 60 * 1000
/** 关闭时等待 socket 自然结束的宽限期 */
const CLOSE_GRACE_MS = 2000

/** 只认这些 Host/Origin，防 DNS rebinding */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

/* ================================================================== */
/* 对外类型                                                             */
/* ================================================================== */

export interface CreateMcpServerOptions {
  /** Command Bus 入口 */
  dispatch: CommandDispatch
  /** main 的 Workspace 真源快照（已脱敏） */
  getSnapshot: () => WorkspaceSnapshot
  /** 可选：命名空间树读取（Connection Manager → driver host RPC） */
  introspect?: IntrospectReader
  /** 可选：结果集取样行（renderer 缓存） */
  readResultRows?: ResultRowsReader
  host?: string
  port?: number
  path?: string
  /** 显式指定 token；不给则复用 ~/.peek/mcp.json 里的，再没有就新生成 */
  token?: string
  /** 默认 ~/.peek */
  configDir?: string
  /** 关掉后不写 ~/.peek/mcp.json（测试用） */
  writeConfigFile?: boolean
  serverInfo?: { name: string; version: string }
  logger?: McpLogger
  /** 显式给一组工具；不给则自动收集 tools/*.ts */
  tools?: PeekTool[]
}

export interface McpServerHandle {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly url: string
  readonly token: string
  readonly toolNames: readonly string[]
  readonly sessionCount: number
  readonly listening: boolean
  /** 启动监听并写 ~/.peek/mcp.json；失败 reject PeekError */
  start(): Promise<McpEndpointFile>
  /** 优雅关闭 */
  close(): Promise<void>
}

const noopLogger: McpLogger = { log: () => {} }

/* ================================================================== */
/* 实现                                                                */
/* ================================================================== */

interface SessionEntry {
  id: string
  transport: StreamableHTTPServerTransport
  server: McpServer
  lastSeenAt: number
}

export function createMcpServer(options: CreateMcpServerOptions): McpServerHandle {
  const logger = options.logger ?? noopLogger
  const host = options.host ?? MCP_DEFAULT_HOST
  const port = options.port ?? MCP_DEFAULT_PORT
  const path = options.path ?? MCP_HTTP_PATH
  const configDir = options.configDir ?? defaultConfigDir()
  const serverInfo = options.serverInfo ?? { name: 'peek', version: '0.0.1' }
  const token = options.token ?? readExistingToken(configDir) ?? generateToken()

  const tools = options.tools ?? collectBuiltinTools()

  const ctx: ToolContext = {
    dispatch: options.dispatch,
    getSnapshot: options.getSnapshot,
    ...(options.introspect === undefined ? {} : { introspect: options.introspect }),
    ...(options.readResultRows === undefined ? {} : { readResultRows: options.readResultRows }),
    logger,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }

  const sessions = new Map<string, SessionEntry>()
  const sockets = new Set<Socket>()
  let listening = false
  let closing = false
  let sweeper: NodeJS.Timeout | null = null

  /* ---------------- session 生命周期 ---------------- */

  async function closeSession(id: string): Promise<void> {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    try {
      await entry.server.close()
    } catch (err) {
      logger.log('warn', `关闭 MCP session ${id} 出错`, err)
    }
    logger.log('debug', `MCP session 关闭：${id}（剩余 ${sessions.size}）`)
  }

  async function evictIfNeeded(): Promise<void> {
    while (sessions.size >= MAX_SESSIONS) {
      let oldest: SessionEntry | null = null
      for (const entry of sessions.values()) {
        if (oldest === null || entry.lastSeenAt < oldest.lastSeenAt) oldest = entry
      }
      if (!oldest) break
      logger.log('warn', `MCP session 数达上限 ${MAX_SESSIONS}，淘汰最久未活动的 ${oldest.id}`)
      await closeSession(oldest.id)
    }
  }

  async function createSession(): Promise<StreamableHTTPServerTransport> {
    await evictIfNeeded()

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { id: sessionId, transport, server, lastSeenAt: Date.now() })
        logger.log('info', `MCP session 建立：${sessionId}`)
      },
      onsessionclosed: (sessionId) => {
        void closeSession(sessionId)
      },
    })
    transport.onerror = (err) => {
      logger.log('warn', 'MCP transport 错误', err)
    }
    transport.onclose = () => {
      const sid = transport.sessionId
      if (sid !== undefined && sessions.has(sid)) void closeSession(sid)
    }

    const server = new McpServer(serverInfo, {
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
    })
    registerTools(server, tools, ctx)
    await server.connect(transport)
    return transport
  }

  /* ---------------- HTTP 层 ---------------- */

  function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text).toString(),
      ...headers,
    })
    res.end(text)
  }

  function sendRpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
    sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers)
  }

  function hostnameOf(value: string | undefined): string | null {
    if (!value) return null
    // Host 头形如 '127.0.0.1:7332' 或 '[::1]:7332'
    try {
      const url = new URL(`http://${value}`)
      return url.hostname
    } catch {
      return null
    }
  }

  function isLoopback(hostname: string | null): boolean {
    if (hostname === null) return false
    return LOOPBACK_HOSTS.has(hostname) || hostname === host
  }

  /** DNS rebinding 防护：Host 必须是回环，Origin（如果有）也必须是回环 */
  function checkHostHeaders(req: IncomingMessage): boolean {
    if (!isLoopback(hostnameOf(req.headers.host))) return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
      try {
        if (!isLoopback(new URL(origin).hostname)) return false
      } catch {
        return false
      }
    }
    return true
  }

  function checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const prefix = 'bearer '
    if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false
    return tokenMatches(token, header.slice(prefix.length).trim())
  }

  type BodyRead =
    | { ok: true; value: unknown }
    | { ok: false; status: number; code: number; message: string }

  function readJsonBody(req: IncomingMessage): Promise<BodyRead> {
    return new Promise<BodyRead>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (result: BodyRead): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          finish({ ok: false, status: 413, code: -32600, message: '请求体过大' })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.length === 0) {
          finish({ ok: false, status: 400, code: -32700, message: 'Parse error: 空请求体' })
          return
        }
        try {
          finish({ ok: true, value: JSON.parse(raw) })
        } catch {
          finish({ ok: false, status: 400, code: -32700, message: 'Parse error: 非法 JSON' })
        }
      })
      req.on('error', (err) => {
        finish({ ok: false, status: 400, code: -32600, message: `读取请求体失败：${err.message}` })
      })
    })
  }

  function sessionIdOf(req: IncomingMessage): string | null {
    const raw = req.headers['mcp-session-id']
    if (typeof raw === 'string' && raw.length > 0) return raw
    if (Array.isArray(raw) && raw.length > 0 && raw[0]) return raw[0]
    return null
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) {
      sendRpcError(res, 503, -32000, 'peek MCP server 正在关闭')
      return
    }

    if (!checkHostHeaders(req)) {
      sendRpcError(res, 403, -32000, 'Forbidden: 只接受来自本机回环地址的请求')
      return
    }

    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (pathname !== path) {
      sendRpcError(res, 404, -32601, `Not Found: MCP 端点是 ${path}`)
      return
    }

    if (!checkAuth(req)) {
      sendRpcError(res, 401, -32000, 'Unauthorized: 需要 Authorization: Bearer <token>（见 ~/.peek/mcp.json）', {
        'www-authenticate': 'Bearer realm="peek"',
      })
      return
    }

    const method = req.method ?? 'GET'
    const sessionId = sessionIdOf(req)

    if (method === 'POST') {
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendRpcError(res, body.status, body.code, body.message)
        return
      }

      let transport: StreamableHTTPServerTransport
      if (sessionId !== null) {
        const entry = sessions.get(sessionId)
        if (!entry) {
          sendRpcError(res, 404, -32001, 'Session not found')
          return
        }
        entry.lastSeenAt = Date.now()
        transport = entry.transport
      } else if (isInitializeRequest(body.value)) {
        transport = await createSession()
      } else {
        sendRpcError(res, 400, -32000, 'Bad Request: 缺少 mcp-session-id，且不是 initialize 请求')
        return
      }
      await transport.handleRequest(req, res, body.value)
      return
    }

    if (method === 'GET' || method === 'DELETE') {
      if (sessionId === null) {
        sendRpcError(res, 400, -32000, 'Bad Request: 缺少 mcp-session-id')
        return
      }
      const entry = sessions.get(sessionId)
      if (!entry) {
        sendRpcError(res, 404, -32001, 'Session not found')
        return
      }
      entry.lastSeenAt = Date.now()
      await entry.transport.handleRequest(req, res)
      return
    }

    sendRpcError(res, 405, -32000, 'Method Not Allowed', { allow: 'GET, POST, DELETE' })
  }

  const httpServer: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const error = toPeekError(err)
      logger.log('error', `MCP 请求处理失败：${error.message}`, error.detail)
      if (!res.headersSent) {
        sendRpcError(res, 500, -32603, `Internal error: ${error.message}`)
      } else {
        res.end()
      }
    })
  })

  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  httpServer.on('error', (err) => {
    logger.log('error', 'MCP HTTP server 错误', err)
  })

  /* ---------------- 启动 / 关闭 ---------------- */

  async function start(): Promise<McpEndpointFile> {
    if (listening) throw asPeekError(peekError('CONFLICT', 'MCP server 已在运行'))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.removeListener('listening', onListening)
        reject(
          asPeekError(
            errnoCode(err) === 'EADDRINUSE'
              ? peekError('CONFLICT', `端口 ${port} 已被占用，MCP server 无法启动`, {
                  detail: '可能已有另一个 peek 在跑；也可以换端口启动。',
                })
              : toPeekError(err),
          ),
        )
      }
      const onListening = (): void => {
        httpServer.removeListener('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      // 明确绑回环地址：MCP 端点不对外网暴露
      httpServer.listen(port, host)
    })

    listening = true
    sweeper = setInterval(() => {
      const deadline = Date.now() - SESSION_IDLE_MS
      for (const entry of [...sessions.values()]) {
        if (entry.lastSeenAt < deadline) {
          logger.log('info', `MCP session ${entry.id} 闲置超时，回收`)
          void closeSession(entry.id)
        }
      }
    }, SWEEP_INTERVAL_MS)
    sweeper.unref?.()

    const file =
      options.writeConfigFile === false
        ? {
            version: 1 as const,
            host,
            port,
            path,
            url: `http://${host}:${port}${path}`,
            token,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
            hint: '',
          }
        : writeEndpointFile({ configDir, host, port, path, token })

    logger.log('info', `MCP server 已启动：${file.url}（${tools.length} 个工具）`)
    return file
  }

  async function close(): Promise<void> {
    if (closing) return
    closing = true
    if (sweeper) {
      clearInterval(sweeper)
      sweeper = null
    }
    await Promise.all([...sessions.keys()].map((id) => closeSession(id)))
    if (listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        // keep-alive 连接不会自己断，宽限期后强制掐掉
        setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, CLOSE_GRACE_MS).unref?.()
      })
      listening = false
    }
    sockets.clear()
    logger.log('info', 'MCP server 已关闭')
  }

  return {
    host,
    port,
    path,
    url: `http://${host}:${port}${path}`,
    token,
    toolNames: tools.map((t) => t.name),
    get sessionCount() {
      return sessions.size
    },
    get listening() {
      return listening
    },
    start,
    close,
  }
}

/** 从任意错误里取 errno code（EADDRINUSE 等），不用 any */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** PeekError 是纯数据结构，抛出前包一层 Error 以便有 stack；两边信息都保留 */
function asPeekError(error: PeekError): Error & { peek: PeekError } {
  const wrapped = new Error(`[${error.code}] ${error.message}`) as Error & { peek: PeekError }
  wrapped.peek = error
  return wrapped
}

/* ================================================================== */
/* 给 AI 的使用说明（MCP initialize 时下发）                              */
/* ================================================================== */

const INSTRUCTIONS = `peek 是一个数据库 viewer 桌面应用，这些工具直接驱动它的界面。人和 AI 走同一条指令通道，你做的每一步用户都能在屏幕上看到。

典型流程：
1. read_workspace —— 先看当前界面：布局、每个面板里的视图、连了哪些库。
2. list_connections / connect —— 没有连接就先连（postgres 给 {"driverId":"postgres","url":"postgresql://user@host:5432/db"}）。
3. introspect —— 展开命名空间树拿到表的 ref（不给 parentId 是根层）。
4. open_view —— 把表开成 table 视图，或开 query 视图写 SQL。
5. run_query —— 跑查询；回执只给前 20 行，完整结果在界面里，用户自己滚。

注意：
- 所有工具都是只读语义的数据浏览（第一版不做数据写回）。
- 结果集数据不会整份塞给你，需要更多行就改 previewRows，或让用户在界面上看。
- 出错时返回结构化的 PeekError（code + message + detail），按 code 判断该重试还是改参数。`
