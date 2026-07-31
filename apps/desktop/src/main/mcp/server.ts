/**
 * MCP Streamable HTTP server (PLAN section 7).
 *
 * - Binds 127.0.0.1:7332 (port configurable) and **never binds 0.0.0.0**
 * - Bearer token authentication, with the token stored in ~/.peek/mcp.json (0600)
 * - One StreamableHTTPServerTransport + McpServer instance per HTTP session
 * - Graceful shutdown: stop listening, close every session, then kill lingering sockets
 *
 * Dependency injection: no Command Bus instance is imported here; everything arrives through
 * the createMcpServer options.
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
/* Constants                                                            */
/* ================================================================== */

/** Per-POST body cap (JSON-RPC messages should be small; anything larger gets a 413). */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Cap on concurrently live sessions; beyond it, the least recently active one is evicted. */
const MAX_SESSIONS = 16
/** Session idle timeout: 30 minutes. */
const SESSION_IDLE_MS = 30 * 60 * 1000
/** How often idle sessions are swept. */
const SWEEP_INTERVAL_MS = 60 * 1000
/** Grace period allowing sockets to close on their own during shutdown. */
const CLOSE_GRACE_MS = 2000

/** Only these Host/Origin values are accepted, as DNS rebinding protection. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

/* ================================================================== */
/* Public types                                                         */
/* ================================================================== */

export interface CreateMcpServerOptions {
  /** Entry point into the Command Bus. */
  dispatch: CommandDispatch
  /** Snapshot of main's Workspace source of truth (already redacted). */
  getSnapshot: () => WorkspaceSnapshot
  /** Optional: namespace tree reader (Connection Manager → driver host RPC). */
  introspect?: IntrospectReader
  /** Optional: sample rows from a result set (out of the renderer cache). */
  readResultRows?: ResultRowsReader
  host?: string
  port?: number
  path?: string
  /** Explicit token; otherwise reuse the one in ~/.peek/mcp.json, or mint a new one. */
  token?: string
  /** Defaults to ~/.peek. */
  configDir?: string
  /** Set to false to skip writing ~/.peek/mcp.json (used by tests). */
  writeConfigFile?: boolean
  serverInfo?: { name: string; version: string }
  logger?: McpLogger
  /** Supply an explicit tool set; otherwise tools/*.ts are collected automatically. */
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
  /** Start listening and write ~/.peek/mcp.json; rejects with a PeekError on failure. */
  start(): Promise<McpEndpointFile>
  /** Graceful shutdown. */
  close(): Promise<void>
}

const noopLogger: McpLogger = { log: () => {} }

/* ================================================================== */
/* Implementation                                                       */
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

  /* ---------------- Session lifecycle ---------------- */

  async function closeSession(id: string): Promise<void> {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    try {
      await entry.server.close()
    } catch (err) {
      logger.log('warn', `Error while closing MCP session ${id}`, err)
    }
    logger.log('debug', `MCP session closed: ${id} (${sessions.size} remaining)`)
  }

  async function evictIfNeeded(): Promise<void> {
    while (sessions.size >= MAX_SESSIONS) {
      let oldest: SessionEntry | null = null
      for (const entry of sessions.values()) {
        if (oldest === null || entry.lastSeenAt < oldest.lastSeenAt) oldest = entry
      }
      if (!oldest) break
      logger.log('warn', `MCP session limit ${MAX_SESSIONS} reached, evicting least recently active ${oldest.id}`)
      await closeSession(oldest.id)
    }
  }

  async function createSession(): Promise<StreamableHTTPServerTransport> {
    await evictIfNeeded()

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { id: sessionId, transport, server, lastSeenAt: Date.now() })
        logger.log('info', `MCP session established: ${sessionId}`)
      },
      onsessionclosed: (sessionId) => {
        void closeSession(sessionId)
      },
    })
    transport.onerror = (err) => {
      logger.log('warn', 'MCP transport error', err)
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

  /* ---------------- HTTP layer ---------------- */

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
    // The Host header looks like '127.0.0.1:7332' or '[::1]:7332'.
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

  /** DNS rebinding protection: Host must be loopback, and Origin (when present) must be too. */
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
          finish({ ok: false, status: 413, code: -32600, message: 'Request body too large' })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.length === 0) {
          finish({ ok: false, status: 400, code: -32700, message: 'Parse error: empty request body' })
          return
        }
        try {
          finish({ ok: true, value: JSON.parse(raw) })
        } catch {
          finish({ ok: false, status: 400, code: -32700, message: 'Parse error: malformed JSON' })
        }
      })
      req.on('error', (err) => {
        finish({ ok: false, status: 400, code: -32600, message: `Failed to read request body: ${err.message}` })
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
      sendRpcError(res, 503, -32000, 'peek MCP server is shutting down')
      return
    }

    if (!checkHostHeaders(req)) {
      sendRpcError(res, 403, -32000, 'Forbidden: only requests from the local loopback address are accepted')
      return
    }

    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (pathname !== path) {
      sendRpcError(res, 404, -32601, `Not Found: the MCP endpoint is ${path}`)
      return
    }

    if (!checkAuth(req)) {
      sendRpcError(res, 401, -32000, 'Unauthorized: Authorization: Bearer <token> is required (see ~/.peek/mcp.json)', {
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
        sendRpcError(res, 400, -32000, 'Bad Request: missing mcp-session-id, and this is not an initialize request')
        return
      }
      await transport.handleRequest(req, res, body.value)
      return
    }

    if (method === 'GET' || method === 'DELETE') {
      if (sessionId === null) {
        sendRpcError(res, 400, -32000, 'Bad Request: missing mcp-session-id')
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
      logger.log('error', `MCP request handling failed: ${error.message}`, error.detail)
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
    logger.log('error', 'MCP HTTP server error', err)
  })

  /* ---------------- Startup / shutdown ---------------- */

  async function start(): Promise<McpEndpointFile> {
    if (listening) throw asPeekError(peekError('CONFLICT', 'MCP server is already running'))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.removeListener('listening', onListening)
        reject(
          asPeekError(
            errnoCode(err) === 'EADDRINUSE'
              ? peekError('CONFLICT', `Port ${port} is already in use, the MCP server cannot start`, {
                  detail: 'Another peek instance may already be running; you can also start on a different port.',
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
      // Bind the loopback address explicitly: the MCP endpoint is never exposed off-machine.
      httpServer.listen(port, host)
    })

    listening = true
    sweeper = setInterval(() => {
      const deadline = Date.now() - SESSION_IDLE_MS
      for (const entry of [...sessions.values()]) {
        if (entry.lastSeenAt < deadline) {
          logger.log('info', `MCP session ${entry.id} idled out, reclaiming it`)
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

    logger.log('info', `MCP server started: ${file.url} (${tools.length} tools)`)
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
        // keep-alive connections never close on their own; force them after the grace period.
        setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, CLOSE_GRACE_MS).unref?.()
      })
      listening = false
    }
    sockets.clear()
    logger.log('info', 'MCP server closed')
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

/** Pull the errno code (EADDRINUSE and friends) out of an arbitrary error, without using `any`. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * PeekError is a plain data structure, so wrap it in an Error before throwing to get a stack;
 * both halves of the information are preserved.
 */
function asPeekError(error: PeekError): Error & { peek: PeekError } {
  const wrapped = new Error(`[${error.code}] ${error.message}`) as Error & { peek: PeekError }
  wrapped.peek = error
  return wrapped
}

/* ================================================================== */
/* Usage instructions for the AI (sent during MCP initialize)           */
/* ================================================================== */

const INSTRUCTIONS = `peek is a desktop database viewer, and these tools drive its user interface directly. Humans and AI share one command channel, so every step you take is visible to the user on screen.

Typical flow:
1. read_workspace — look at the current UI first: the layout, the view in each panel, which databases are connected.
2. list_connections / connect — connect first if there is no connection yet (for postgres, pass {"driverId":"postgres","url":"postgresql://user@host:5432/db"}).
3. introspect — expand the namespace tree to obtain a table's ref (omit parentId for the root level).
4. open_view — open a table as a table view, or open a query view to write SQL.
5. run_query — run a query; the receipt carries only the first 20 rows, the full result lives in the UI for the user to scroll.

Notes:
- Every tool is read-only data browsing (this first version does not write data back).
- Result set data is never handed to you in full: raise previewRows if you need more rows, or let the user look at the UI.
- Failures return a structured PeekError (code + message + detail); use the code to decide whether to retry or to change your arguments.`
