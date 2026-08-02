/**
 * The MCP endpoint's port and token.
 *
 * Before this, the port was a constant with an environment-variable escape
 * hatch, and a busy 7332 meant the AI half of peek simply did not exist for that
 * session — reported by one toast, with no next step in it. Three things are
 * pinned here:
 *
 *   - a taken port is survivable: the neighbours are tried, and the user is told
 *     where the endpoint actually landed, because a client registered against
 *     the old one will not reach this window;
 *   - the port is a *preference*, so it outlives the process, while
 *     `PEEK_MCP_PORT` stays an override that never writes to the user's file;
 *   - rotating the token really invalidates the old one, which means the live
 *     sessions holding it have to go too.
 *
 * No socket is bound here. What is under test is the decision-making, so the
 * server handle is a fake that can be told to refuse a port.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { MCP_DEFAULT_HOST, MCP_HTTP_PATH, peekError, type PeekError } from '@peek/core'
import { createMcpController, type McpEndpointInfo } from '../../config/mcp-controller'
import { createSettingsStore } from '../../config/settings'
import { SETTINGS_FILE_NAME } from '../../config/paths'
import type { McpServerHandle } from '../server'

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-mcp-'))
  tempDirs.push(dir)
  return dir
}

interface Attempt {
  port: number
  token: string | undefined
}

interface Harness {
  controller: ReturnType<typeof createMcpController>
  attempts: Attempt[]
  notices: { level: string; message: string }[]
  endpoints: (McpEndpointInfo | null)[]
  /** Everything the controller wrote to the process log, which is stdout in the real app. */
  logs: string[]
  dir: string
}

/**
 * @param busy ports the fake server refuses to bind, exactly as a real
 *   `EADDRINUSE` would — a `CONFLICT` PeekError out of `start()`.
 */
function harness(options: { busy?: number[]; fatalOn?: number; forcedPort?: number } = {}): Harness {
  const dir = tempConfigDir()
  const attempts: Attempt[] = []
  const notices: { level: string; message: string }[] = []
  const endpoints: (McpEndpointInfo | null)[] = []
  const logs: string[] = []
  let issued = 0

  const controller = createMcpController({
    configDir: dir,
    settings: createSettingsStore(dir),
    ...(options.forcedPort === undefined ? {} : { forcedPort: options.forcedPort }),
    portScanWindow: 3,
    create: ({ port, token }) => {
      attempts.push({ port, token })
      issued += 1
      const minted = token ?? `token-${String(issued)}`
      const url = `http://${MCP_DEFAULT_HOST}:${String(port)}${MCP_HTTP_PATH}`
      let listening = false
      const handle: McpServerHandle = {
        host: MCP_DEFAULT_HOST,
        port,
        path: MCP_HTTP_PATH,
        url,
        token: minted,
        agentToken: null,
        toolNames: [],
        sessionCount: 0,
        get listening() {
          return listening
        },
        start: async () => {
          if (options.fatalOn === port) throw asError(peekError('INTERNAL', 'the socket layer said no'))
          if (options.busy?.includes(port) === true) {
            throw asError(peekError('CONFLICT', `Port ${String(port)} is already in use`))
          }
          listening = true
          return {
            version: 1,
            host: MCP_DEFAULT_HOST,
            port,
            path: MCP_HTTP_PATH,
            url,
            token: minted,
            pid: process.pid,
            updatedAt: new Date().toISOString(),
            // Shaped like the real one, token and all: a fake hint without the
            // token would let "do not log the hint" pass by accident.
            hint: `claude mcp add peek --transport http ${url} --header "Authorization: Bearer ${minted}"`,
          }
        },
        close: async () => {
          listening = false
        },
      }
      return handle
    },
    notify: (message) => notices.push({ level: message.level, message: message.message }),
    log: (line) => logs.push(line),
    onEndpoint: (endpoint) => endpoints.push(endpoint),
  })

  return { controller, attempts, notices, endpoints, logs, dir }
}

function asError(error: PeekError): Error {
  return Object.assign(new Error(`[${error.code}] ${error.message}`), { peek: error })
}

/** `configure` returns before the rebind; wait for the controller to settle. */
async function settle(controller: ReturnType<typeof createMcpController>): Promise<void> {
  for (let i = 0; i < 200 && controller.status().restarting; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/* ------------------------------------------------------------------ */

describe('choosing a port', () => {
  test('the default is used when nothing has been chosen', async () => {
    const h = harness()
    const status = await h.controller.start()
    assert.equal(status.listening, true)
    assert.equal(status.port, 7332)
    assert.equal(status.preferredPort, 7332)
    assert.ok(status.hint.startsWith('claude mcp add peek --transport http http://127.0.0.1:7332/mcp'))
    assert.ok(status.hint.includes(status.token), 'the copy-paste line has to carry the token that is live')
  })

  test('a busy port is survivable, and the move is reported', async () => {
    const h = harness({ busy: [7332, 7333] })
    const status = await h.controller.start()

    assert.deepEqual(
      h.attempts.map((attempt) => attempt.port),
      [7332, 7333, 7334],
    )
    assert.equal(status.listening, true)
    assert.equal(status.port, 7334)
    assert.equal(status.preferredPort, 7332, 'landing elsewhere must not silently rewrite what the user asked for')
    // A client registered against 7332 is now pointed at nothing, so this cannot
    // be a silent recovery.
    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0]?.level, 'warn')
    assert.ok(h.notices[0]?.message.includes('7334'))
  })

  test('every port busy leaves an endpoint that is honestly absent', async () => {
    const h = harness({ busy: [7332, 7333, 7334, 7335] })
    const status = await h.controller.start()

    assert.equal(status.listening, false)
    assert.equal(status.error?.code, 'CONFLICT')
    assert.equal(h.notices[0]?.level, 'error')
    // The ACP host reads this: a null endpoint is what stops it handing the user
    // a chat panel whose agent silently cannot see the window.
    assert.deepEqual(h.endpoints, [null])
  })

  test('a failure that is not a busy port is not retried eight times', async () => {
    // Retrying a permission error on every neighbour only delays the message.
    const h = harness({ fatalOn: 7332 })
    const status = await h.controller.start()
    assert.equal(h.attempts.length, 1)
    assert.equal(status.listening, false)
    assert.equal(status.error?.code, 'INTERNAL')
  })

  /**
   * The token is a credential, and the process log is not a private place.
   *
   * The controller used to print the whole registration line at startup —
   * `how to connect: claude mcp add peek … --header "Authorization: Bearer <token>"`
   * — for the user to copy out of the terminal. That token grants full control of
   * the window and of every database connection in it, while stdout ends up in
   * terminal scrollback, CI logs, crash reports, and anything reading
   * `PEEK_FORWARD_CONSOLE`. The copyable command now lives only in `~/.peek/mcp.json`
   * (0600) and behind the settings panel's copy button; the log says where to find
   * it, and where it landed.
   */
  test('the bearer token never reaches the process log', async () => {
    const h = harness()
    const status = await h.controller.start()
    const written = h.logs.join('\n')

    assert.ok(status.token.length > 0, 'the run has to have minted a token for this to mean anything')
    assert.ok(!written.includes(status.token), `the token appeared in the log:\n${written}`)
    assert.ok(!/Authorization:\s*Bearer/i.test(written), `a bearer header appeared in the log:\n${written}`)
    // …and the log is still useful: it says where the endpoint is, and where the
    // command that needs the token can be copied from.
    assert.ok(
      h.logs.some((line) => line.includes(status.url)),
      'the address still has to be logged — that part is not a secret',
    )
    assert.ok(h.logs.some((line) => /Settings/i.test(line)))

    // Rotation mints a second token; that one must not leak either.
    h.controller.configure({ rotateToken: true })
    await settle(h.controller)
    const rotated = h.controller.status().token
    assert.notEqual(rotated, status.token)
    assert.ok(!h.logs.join('\n').includes(rotated), 'the rotated token appeared in the log')
  })

  test('PEEK_MCP_PORT overrides the preference without writing to it', async () => {
    const h = harness({ forcedPort: 7999 })
    const status = await h.controller.start()
    assert.equal(status.port, 7999)
    assert.equal(status.preferredPort, 7999)
    // The user's own file is untouched: a scripted run must not edit settings.
    assert.equal(readSettings(h.dir), null)
  })
})

describe('changing the port', () => {
  test('the choice is durable before the rebind is, and the endpoint follows', async () => {
    const h = harness()
    await h.controller.start()

    const outcome = h.controller.configure({ port: 7400 })
    // Answered immediately, and already true: the preference is on disk even if
    // the rebind below never completes.
    assert.equal(outcome.status.preferredPort, 7400)
    assert.equal(outcome.previousPort, 7332)
    assert.equal(readSettings(h.dir), 7400)

    await settle(h.controller)
    const status = h.controller.status()
    assert.equal(status.listening, true)
    assert.equal(status.port, 7400)
    assert.ok(status.url.includes(':7400/'))
  })

  test('the token survives a move — only the address changed', async () => {
    const h = harness()
    const before = (await h.controller.start()).token
    h.controller.configure({ port: 7401 })
    await settle(h.controller)
    assert.equal(h.controller.status().token, before)
  })

  test('a chosen port is remembered across a restart of the process', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.configure({ port: 7402 })
    await settle(h.controller)
    await h.controller.close()

    // A second controller over the same config dir is what "next launch" means.
    const next = createMcpController({
      configDir: h.dir,
      settings: createSettingsStore(h.dir),
      create: ({ port }) => stubHandle(port),
      notify: () => {},
      log: () => {},
      onEndpoint: () => {},
    })
    const status = await next.start()
    assert.equal(status.port, 7402)
    await next.close()
  })
})

describe('rotating the token', () => {
  test('a rotation mints a new token and takes the live sessions with it', async () => {
    const h = harness()
    const before = (await h.controller.start()).token

    const outcome = h.controller.configure({ rotateToken: true })
    assert.equal(outcome.tokenRotated, true)
    await settle(h.controller)

    const after = h.controller.status().token
    assert.notEqual(after, before)
    assert.ok(after.length >= 32, 'a rotated token has to be as strong as the one it replaces')
    // The new token must be handed to the server, not merely recorded: the old
    // one has to stop being accepted.
    assert.equal(h.attempts.at(-1)?.token, after)
    assert.ok(h.controller.status().hint.includes(after))
  })

  test('the endpoint is handed to the chat host again after the rotation', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.configure({ rotateToken: true })
    await settle(h.controller)
    // down, then up: an agent holding the previous endpoint must not keep using it.
    assert.deepEqual(
      h.endpoints.map((endpoint) => endpoint === null),
      [false, null === null, false],
    )
    assert.equal(h.endpoints.at(-1)?.token, h.controller.status().token)
  })
})

function stubHandle(port: number): McpServerHandle {
  const url = `http://${MCP_DEFAULT_HOST}:${String(port)}${MCP_HTTP_PATH}`
  let listening = false
  return {
    host: MCP_DEFAULT_HOST,
    port,
    path: MCP_HTTP_PATH,
    url,
    token: 'stub-token-stub-token-stub-token',
    agentToken: null,
    toolNames: [],
    sessionCount: 0,
    get listening() {
      return listening
    },
    start: async () => {
      listening = true
      return {
        version: 1,
        host: MCP_DEFAULT_HOST,
        port,
        path: MCP_HTTP_PATH,
        url,
        token: 'stub-token-stub-token-stub-token',
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        hint: '',
      }
    },
    close: async () => {
      listening = false
    },
  }
}

function readSettings(dir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')) as Record<string, unknown>
    return typeof raw['mcpPort'] === 'number' ? raw['mcpPort'] : null
  } catch {
    return null
  }
}
