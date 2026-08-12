/**
 * Owning the MCP endpoint's lifetime: which port it is on, which token it
 * carries, and what to say when it is not up.
 *
 * ## Why this is not just `await handle.start()`
 *
 * Three problems the single call at startup could not answer:
 *
 * 1. **A taken port used to be terminal.** peek bound 7332 or gave up, and a
 *    second instance — or anything else on that port — left the window working
 *    but the AI side dark, explained by one toast. Now the preferred port is
 *    tried first and a small window of neighbours after it, so the common case
 *    (a second peek) comes up working and merely says where it landed.
 * 2. **The port was not the user's to choose.** `PEEK_MCP_PORT` is an
 *    integration knob, not a setting; a preference has to survive a restart,
 *    which is what `~/.peek/settings.json` is for.
 * 3. **A token could not be rotated without editing a file by hand.** Rotation
 *    is a restart — every live session's authorization becomes invalid the
 *    moment the token changes, so the sessions have to go with it.
 *
 * The controller keeps `restarting` visible rather than hiding a restart behind
 * a long-running command: `mcp.configure` is answered as soon as the *decision*
 * is durable (the preference is written, the new token minted), and the endpoint
 * catches up. A command that blocked until the port was rebound would hold the
 * event loop the endpoint's own sessions run on.
 */

import { MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, MCP_HTTP_PATH, type McpStatus, type PeekError } from '@peek/core'
import { startupError } from '../mcp/server'
import { configFilePath, generateToken, mcpAddCommand } from '../mcp/token'
import type { McpServerHandle } from '../mcp'
import type { SettingsStore } from './settings'

/** How many ports after the preferred one are tried before giving up. */
export const PORT_SCAN_WINDOW = 8

export interface McpEndpointInfo {
  url: string
  token: string
}

export interface McpControllerOptions {
  configDir: string
  settings: SettingsStore
  /** Builds a server handle. A fresh one per attempt: a handle that failed to bind is spent. */
  create: (input: { port: number; token: string | undefined }) => McpServerHandle
  /**
   * Overrides the stored preference and cannot be changed from the UI. This is
   * `PEEK_MCP_PORT`: an integration knob, so that a smoke run can start beside
   * an installed peek without taking its port.
   */
  forcedPort?: number
  /** How the endpoint's comings and goings are announced to the user. */
  notify: (message: { level: 'info' | 'warn' | 'error'; message: string; detail?: string }) => void
  log: (line: string) => void
  /** Called whenever the endpoint appears or disappears; the ACP host reads this. */
  onEndpoint: (endpoint: McpEndpointInfo | null) => void
  portScanWindow?: number
}

export interface McpController {
  /** Bind the endpoint. Never rejects: a failure becomes `status().error`. */
  start(): Promise<McpStatus>
  status(): McpStatus
  /**
   * Apply a new port and/or a new token. Returns as soon as the choice is
   * durable; `status().restarting` reports the rebind.
   */
  configure(input: { port?: number; rotateToken?: boolean }): {
    status: McpStatus
    tokenRotated: boolean
    previousPort: number | null
  }
  /**
   * Forward `notifications/tools/list_changed` to every live session.
   *
   * Here rather than reached for through a handle because the handle is replaced
   * on every rebind (a spent one cannot be reused) and the caller — the package
   * commands — holds a reference for the life of the app. A notification while
   * the endpoint is down is a no-op, which is correct: there are no sessions to
   * tell, and the one that connects next reads the tool list fresh.
   */
  notifyToolsChanged(): void
  close(): Promise<void>
}

export function createMcpController(options: McpControllerOptions): McpController {
  const scan = options.portScanWindow ?? PORT_SCAN_WINDOW
  const configFile = configFilePath(options.configDir)

  let handle: McpServerHandle | null = null
  let token: string | undefined = undefined
  let boundPort = 0
  let lastError: PeekError | null = null
  let restarting = false
  let closed = false
  /** Serializes start / configure / close, so two restarts cannot race for the port. */
  let queue: Promise<void> = Promise.resolve()

  function preferredPort(): number {
    if (options.forcedPort !== undefined) return options.forcedPort
    return options.settings.read().mcpPort ?? MCP_DEFAULT_PORT
  }

  function status(): McpStatus {
    const port = handle?.port ?? boundPort ?? preferredPort()
    const host = handle?.host ?? MCP_DEFAULT_HOST
    const path = handle?.path ?? MCP_HTTP_PATH
    const url = handle?.url ?? `http://${host}:${String(port)}${path}`
    const current = handle?.token ?? token ?? ''
    return {
      listening: handle?.listening === true,
      host,
      port,
      preferredPort: preferredPort(),
      path,
      url,
      token: current,
      hint: current === '' ? '' : mcpAddCommand(url, current),
      configFile,
      restarting,
      ...(lastError === null ? {} : { error: lastError }),
    }
  }

  /**
   * Try the preferred port, then its neighbours.
   *
   * Only a `CONFLICT` moves on to the next candidate. Anything else — a refused
   * bind, a permission problem — would fail identically on every port, and
   * retrying eight times would only delay the message the user needs.
   */
  async function bind(): Promise<void> {
    const first = preferredPort()
    lastError = null
    for (let offset = 0; offset <= scan; offset += 1) {
      const port = first + offset
      if (port > 65535) break
      const candidate = options.create({ port, token })
      try {
        const endpoint = await candidate.start()
        handle = candidate
        token = candidate.token
        boundPort = candidate.port
        lastError = null
        options.onEndpoint({ url: endpoint.url, token: candidate.token })
        options.log(`listening on ${endpoint.url}`)
        // The bearer token is deliberately *not* logged. It grants full control of
        // this window and every database connection in it, and stdout has a much
        // wider audience than it looks: terminal scrollback, CI logs, crash
        // reports, and `PEEK_FORWARD_CONSOLE` all carry it onward. The full
        // registration command lives in two places that are actually access
        // controlled — `~/.peek/mcp.json` (0600) and the MCP settings panel's
        // copy button.
        options.log('to register an AI client, copy the command from Settings → MCP endpoint')
        if (port !== first) {
          options.notify({
            level: 'warn',
            message: `Port ${String(first)} was busy; the MCP endpoint is on ${String(port)}.`,
            detail:
              'An AI client registered against the old port will not reach this window. Re-copy the command from ' +
              'Settings → MCP endpoint, or pin a port there.',
          })
        }
        return
      } catch (raw) {
        // `startupError`, not `toPeekError`: the code is what decides between
        // "try the next port" and "stop and say why".
        const error = startupError(raw)
        lastError = error
        // The handle is spent either way: `start` leaves a half-open server
        // behind on failure, and `close` is what releases the socket.
        await candidate.close().catch(() => {})
        if (error.code !== 'CONFLICT') break
      }
    }

    handle = null
    options.onEndpoint(null)
    const error = lastError
    options.notify({
      level: 'error',
      message: `The MCP server failed to start: ${error?.message ?? 'unknown error'}`,
      detail:
        error?.code === 'CONFLICT'
          ? `Ports ${String(first)}–${String(Math.min(first + scan, 65535))} are all in use. The window works as usual; ` +
            'only the AI cannot connect. Free one of those ports, or choose another under Settings → MCP endpoint.'
          : (error?.detail ?? ''),
    })
  }

  async function stop(): Promise<void> {
    const current = handle
    handle = null
    options.onEndpoint(null)
    if (current) await current.close().catch(() => {})
  }

  /** Runs `task` after everything already queued, so restarts cannot overlap. */
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task, task)
    return queue
  }

  return {
    status,

    async start() {
      await enqueue(async () => {
        if (closed || handle !== null) return
        await bind()
      })
      return status()
    },

    configure(input) {
      const previousPort = input.port === undefined || input.port === boundPort ? null : boundPort
      const tokenRotated = input.rotateToken === true

      // Durable first, and synchronously: the answer this command returns has to
      // be true even if the rebind below never completes.
      if (input.port !== undefined) options.settings.update({ mcpPort: input.port })
      if (tokenRotated) token = undefined

      restarting = true
      void enqueue(async () => {
        await stop()
        // A rotation asked for a *new* token; clearing the field is not enough,
        // because the server would then reuse the one still sitting in mcp.json.
        if (tokenRotated) token = generateToken()
        if (!closed) await bind()
        restarting = false
      })

      return { status: status(), tokenRotated, previousPort }
    },

    notifyToolsChanged() {
      handle?.notifyToolsChanged()
    },

    async close() {
      closed = true
      await enqueue(async () => {
        await stop()
      })
    },
  }
}
