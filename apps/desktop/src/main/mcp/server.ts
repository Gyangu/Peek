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
  isPeekError,
  peekError,
  toPeekError,
  type PeekError,
  type CommandSource,
  type WorkspaceSnapshot,
} from '@peek/core'
import { mcpInstructions } from './instructions'
import { collectTools, reconcileSessionTools, registerTools, type RegisteredPeekTool } from './registry'
import type { PackageToolCaller } from './package-tools'
import {
  defaultConfigDir,
  generateToken,
  readExistingToken,
  resolveCommandSource,
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
  /**
   * How commands from this server are attributed in the command log. Defaults to
   * `'mcp'`.
   *
   * Pass `'agent'` for the handle given to peek's **own** embedded chat panel.
   * Attribution is the whole reason: over one shared endpoint the assistant in the
   * sidebar and a stranger's editor are indistinguishable in the log, and to a
   * person auditing what rearranged their window those are not the same event. It
   * also lets that handle carry a different tool set — the natural place to keep
   * the embedded agent away from the chat tools it would otherwise point at itself.
   */
  source?: CommandSource
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
  /**
   * A second bearer token that identifies peek's **own** embedded chat panel.
   *
   * Same port, same path — only the credential differs, and it decides the
   * session's `source`. Two listeners would buy no isolation (they are one
   * process) and would cost two `mcp.json` entries, two port sweeps and two
   * addresses to explain in the settings panel.
   *
   * It must never reach `~/.peek/mcp.json`. That file is how an *external*
   * client is meant to authenticate, and an agent token an external client can
   * read is not an identity, it is a costume. Keeping it in memory is what makes
   * `source: 'agent'` mean something.
   *
   * See design/2026-08-02-agent-source-and-permission-scope.md §2.1.
   */
  agentToken?: string
  /** Defaults to ~/.peek. */
  configDir?: string
  /** Set to false to skip writing ~/.peek/mcp.json (used by tests). */
  writeConfigFile?: boolean
  serverInfo?: { name: string; version: string }
  logger?: McpLogger
  /** Supply an explicit tool set; otherwise tools/*.ts are collected automatically. */
  tools?: PeekTool[]
  /**
   * How a package tool reaches its host, for the tools collected here.
   *
   * Separate from `tools` so that supplying the caller does not also pin the
   * set: the list has to be re-collected whenever a package is installed or
   * uninstalled, and it is re-collected *with* this.
   */
  callPackageTool?: PackageToolCaller
}

export interface McpServerHandle {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly url: string
  readonly token: string
  /** The embedded agent's credential, when one was supplied. Never written to disk. */
  readonly agentToken: string | null
  readonly toolNames: readonly string[]
  readonly sessionCount: number
  readonly listening: boolean
  /**
   * Tell every live session that `tools/list` would now answer differently.
   *
   * Called after a package is installed or uninstalled. Synchronous and
   * best-effort: a session whose transport has gone is a session that will not
   * be asking again, so a failure to reach one is logged and not raised — the
   * caller has already changed the registry and cannot un-change it because a
   * dead socket did not accept a notification.
   *
   * Each session's descriptions are recomputed first — see
   * `refreshToolDescriptions`, which is what stops this from being a
   * notification about nothing.
   */
  notifyToolsChanged(): void
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
  /**
   * This session's tool table, so it can be reconciled and its descriptions
   * recomputed in place. Reassigned by `notifyToolsChanged`, never mutated.
   */
  tools: readonly RegisteredPeekTool[]
  /**
   * Who this session authenticated as, kept because reconciling needs to build a
   * `ToolContext` for tools registered after the session opened — and `source`
   * is a property of who connected, settled once at `initialize`.
   */
  source: CommandSource
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

  /**
   * The tool surface, as of the last time anything asked for it.
   *
   * A slot rather than a constant, and that is the second half of acceptance 13
   * (§4duodevicies(d)). `collectTools()` reads `installedTools()` through
   * `packageTools`, so its answer moves when a package is installed or
   * uninstalled — but this was computed once when the server was built, which is
   * why §4sedecies(b) found an uninstalled package's tool still listed *in a
   * brand-new session*: every session was handed the same array.
   *
   * An explicit `options.tools` pins it. That is what a test supplying its own
   * set means, and rebuilding over it would throw the set away.
   *
   * Which is exactly why the caller travels as `options.callPackageTool` and not
   * as a pre-collected array. Main used to pass `tools: collectTools({ callPackageTool })`
   * — it had no other way to hand the package-host caller in — and that silently
   * took the pin meant for tests, leaving the shipped app's list frozen at
   * startup however the registry moved. Acceptance 13 stayed false through two
   * rounds of fixes aimed one layer lower; `smoke-drivers.mjs` is what found it,
   * and is still the only thing guarding this line (§4vicies(c)).
   */
  const collectOptions = options.callPackageTool === undefined ? {} : { callPackageTool: options.callPackageTool }
  let tools = options.tools ?? collectTools(collectOptions)
  const rebuildTools = (): void => {
    if (options.tools === undefined) tools = collectTools(collectOptions)
  }

  const agentToken = options.agentToken ?? null
  const externalSource: CommandSource = options.source ?? 'mcp'

  /**
   * One context per session, because `source` is now a property of *who
   * connected* rather than of the process.
   *
   * A session is established by an `initialize` request, and that request
   * carries the Authorization header, so the answer is settled once at the
   * moment the session opens rather than recomputed per call.
   */
  function contextFor(source: CommandSource): ToolContext {
    return {
      dispatch: options.dispatch,
      source,
      getSnapshot: options.getSnapshot,
      ...(options.introspect === undefined ? {} : { introspect: options.introspect }),
      ...(options.readResultRows === undefined ? {} : { readResultRows: options.readResultRows }),
      logger,
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    }
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

  async function createSession(source: CommandSource): Promise<StreamableHTTPServerTransport> {
    await evictIfNeeded()
    // Here rather than only on `notifyToolsChanged`, so that a new session is
    // right because it read the registry and not because a notification happened
    // to have fired. §4sedecies(b) measured the difference: re-handshaking was
    // the first thing tried against the stale list, and it did not help.
    rebuildTools()

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          id: sessionId,
          transport,
          server,
          tools: registered,
          source,
          lastSeenAt: Date.now(),
        })
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
      // True since packages can be installed and uninstalled without a restart
      // (design 2026-08-07 §2.7). Declaring `false` while the tool list moves is
      // lying to the protocol — a client that trusted the declaration would cache
      // a list that no longer matches what peek will accept, and the failure
      // surfaces as a tool call for a database that is gone.
      capabilities: { tools: { listChanged: true } },
      // Fixed for the life of this session, and there is no notification that can
      // correct it — the protocol has `tools/list_changed` and nothing for
      // instructions. So a package installed after this line runs contributes its
      // tools to this session and its **skill only to sessions opened later**.
      // §2.7 records this as one of the two things hot loading cannot do; it is a
      // protocol limit, not a shortcut, and `mcpInstructions()` being lazy is
      // what makes the *next* session correct.
      instructions: mcpInstructions(),
    })
    const registered = registerTools(server, tools, contextFor(source))
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

  /**
   * Which caller this is, or null when the credential does not open the door.
   * The rule itself lives in `token.ts` beside the other credential logic, where
   * it can be asserted without standing up an HTTP server.
   */
  function identify(req: IncomingMessage): CommandSource | null {
    return resolveCommandSource(req.headers.authorization, { token, agentToken, externalSource })
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

    const source = identify(req)
    if (source === null) {
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
        transport = await createSession(source)
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
                  detail:
                    'Another peek instance may already be running. peek looks for a free port nearby on startup; ' +
                    'to pin one, set it under Settings → MCP endpoint (it is stored in ~/.peek/settings.json).',
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

  /**
   * One notification per live session, and one failure does not cost the others.
   *
   * Per session rather than once on a shared server because there is no shared
   * server: `createSession` builds an `McpServer` per transport (see the comment
   * on `contextFor` — `source` is a property of who connected), so the
   * notification has to be sent down each one.
   */
  function notifyToolsChanged(): void {
    rebuildTools()
    for (const entry of sessions.values()) {
      try {
        // Before the notification, not after: a client that re-lists the instant
        // it hears must be answered with the new list, and this is the only thing
        // that puts it there. The SDK stored a table of tools when the session was
        // created — both which tools and how each describes itself — so both have
        // to be brought forward, and `reconcileSessionTools` does both.
        entry.tools = reconcileSessionTools(entry.server, entry.tools, tools, contextFor(entry.source))
        entry.server.sendToolListChanged()
      } catch (err) {
        logger.log('warn', `Could not tell MCP session ${entry.id} that the tool list changed`, err)
      }
    }
  }

  return {
    host,
    port,
    path,
    url: `http://${host}:${port}${path}`,
    token,
    agentToken,
    get toolNames() {
      return tools.map((t) => t.name)
    },
    get sessionCount() {
      return sessions.size
    },
    get listening() {
      return listening
    },
    notifyToolsChanged,
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

/**
 * The inverse of `asPeekError`, and the only correct way to read what `start()`
 * rejected with.
 *
 * `toPeekError` alone is **not** enough here, and quietly was not: it recognizes
 * a `PeekError` or a bare `Error`, but an `Error` that *carries* one is just an
 * Error to it, so every rejection out of `start()` came back as `INTERNAL`. The
 * caller's "is this port in use?" branch therefore never ran — the one piece of
 * information that decides between "try the next port" and "tell the user and
 * stop".
 */
export function startupError(error: unknown): PeekError {
  if (typeof error === 'object' && error !== null) {
    const carried = (error as { peek?: unknown }).peek
    if (isPeekError(carried)) return carried
  }
  return toPeekError(error)
}
