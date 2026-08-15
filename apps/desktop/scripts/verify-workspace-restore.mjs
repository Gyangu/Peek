/**
 * Does the desk actually come back?
 *
 * The unit tests answer that for the projection, the file and the restore
 * sequence, each against a hand-built harness. What none of them can answer is
 * the question a user asks — *I quit the app and opened it again* — because
 * every part of that is outside the harness: the launch path in `main/index.ts`,
 * the flush on `before-quit`, a second process reading what the first one wrote,
 * a real driver dialling a real database, and the wake-up that fills a restored
 * view once it does.
 *
 * So this script runs peek twice against one `~/.peek`:
 *
 *   run 1  connect to a SQLite fixture, open a table, open a query view with
 *          unrun text in it, split the window. Then let the app quit itself.
 *   ---    check `workspace.json`: two views, the statement, and none of the
 *          session state that must never be written.
 *   run 2  read the workspace back over MCP. The layout, the tabs and the text
 *          have to be there — and the table has to have *rows*, which is the
 *          only end-to-end proof that reconnecting and waking idle views works.
 *
 * Usage (build first — this runs the built app, not the dev server):
 *
 *     pnpm --filter @peek/desktop build
 *     node scripts/verify-workspace-restore.mjs [--verbose]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const VERBOSE = process.argv.includes('--verbose')
/** Leave the temporary `~/.peek` behind, for when a check fails and you want to look. */
const KEEP = process.argv.includes('--keep')

const MCP_READY_TIMEOUT_MS = 45_000
/**
 * How long each run lives. The app quits *itself* after this, which is the point:
 * `app.quit()` runs `before-quit`, which is what flushes the workspace. Killing
 * the process would skip the very path this script exists to exercise.
 */
const RUN_LIFETIME_MS = 30_000
const QUIT_TIMEOUT_MS = 20_000
/** How long to wait for a restored table to fill in, once its connection is up. */
const WAKE_TIMEOUT_MS = 20_000

const log = (...args) => {
  console.log(...args)
}
const debug = (...args) => {
  if (VERBOSE) console.log(...args)
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

async function makeFixture(dir) {
  const path = join(dir, 'orders.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, total REAL NOT NULL)')
    const insert = db.prepare('INSERT INTO orders (id, customer, total) VALUES (?, ?, ?)')
    db.exec('BEGIN')
    for (let i = 1; i <= 25; i += 1) insert.run(i, `customer-${String(i)}`, i * 1.5)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return path
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

function electronBinaryPath() {
  const mod = createRequire(join(DESKTOP_DIR, 'package.json'))('electron')
  if (typeof mod !== 'string') throw new Error('the electron package did not resolve to a binary path')
  return mod
}

async function pickFreePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => {
        resolve(port)
      })
    })
  })
}

function launch({ label, mcpPort, configDir, userDataDir }) {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['PEEK_MCP_PORT'] = String(mcpPort)
  env['PEEK_CONFIG_DIR'] = configDir
  env['PEEK_SMOKE_EXIT_MS'] = String(RUN_LIFETIME_MS)

  const child = spawn(electronBinaryPath(), ['.', `--user-data-dir=${userDataDir}`], {
    cwd: DESKTOP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  for (const [stream, tag] of [
    [child.stdout, 'out'],
    [child.stderr, 'err'],
  ]) {
    stream.setEncoding('utf8')
    let buffered = ''
    stream.on('data', (piece) => {
      buffered += piece
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) debug(`[${label}/${tag}] ${line}`)
    })
  }
  return child
}

/**
 * `mcp.json` for *this* run.
 *
 * `staleUrl` is what makes the second run work: run 1 leaves its endpoint file
 * behind, and reading it would hand back a port nobody is listening on any more.
 * The file is only believed once it names an endpoint that is not the old one.
 */
async function waitForEndpoint(configDir, child, staleUrl) {
  const path = join(configDir, 'mcp.json')
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited early with code ${String(child.exitCode)}`)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.url === 'string' && typeof parsed.token === 'string' && parsed.url !== staleUrl) {
        return parsed
      }
    } catch {
      // not written yet, or half-written
    }
    await delay(200)
  }
  throw new Error(`the MCP endpoint file never appeared at ${path}`)
}

/** The file can be on disk a beat before the listener accepts; retry briefly. */
async function connectMcp(endpoint) {
  let lastError = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const client = new Client({ name: 'verify-workspace-restore', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
        }),
      )
      return client
    } catch (error) {
      lastError = error
      await delay(500)
    }
  }
  throw lastError ?? new Error('could not reach the MCP endpoint')
}

/** Wait for the app to quit on its own — the path that flushes the workspace. */
async function waitForQuit(child, label) {
  const deadline = Date.now() + RUN_LIFETIME_MS + QUIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      debug(`[${label}] exited with ${String(child.exitCode ?? child.signalCode)}`)
      return
    }
    await delay(200)
  }
  child.kill('SIGKILL')
  throw new Error(`${label} never quit by itself; the workspace was not flushed`)
}

/* ------------------------------------------------------------------ */
/* MCP helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * A tool's structured payload: the value it handed back, not a rendering of it.
 *
 * The blocks are `[prose, data?, uiEffects?]` (see `mcp/registry.ts`), so this
 * skips the first and steps over the `peekUiEffects` envelope — which is a
 * different tool's-eye view of the same call and would otherwise be mistaken for
 * the payload whenever a tool emits one.
 */
function dataOf(result) {
  const blocks = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text)
  for (const block of blocks.slice(1)) {
    try {
      const parsed = JSON.parse(block)
      if (parsed !== null && typeof parsed === 'object' && 'peekUiEffects' in parsed) continue
      return parsed
    } catch {
      // prose, not the payload
    }
  }
  return null
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name} failed:\n${textOf(result)}`)
  return dataOf(result)
}

/**
 * `connect` reports in prose, not as a payload — the same read `smoke-drivers`
 * does, and the reason this one call is spelled differently from the rest.
 */
async function connectDriver(client, config) {
  const result = await client.callTool({ name: 'connect', arguments: { config } })
  const text = textOf(result)
  if (result.isError === true) throw new Error(`connect failed:\n${text}`)
  const match = /Connection\s+(\S+)\s+is\s+(\w+)/.exec(text)
  if (!match) throw new Error(`could not read a connId out of connect:\n${text}`)
  const [, connId, status] = match
  if (status !== 'ready') throw new Error(`the fixture connection came up as "${status}":\n${text}`)
  return connId
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

let failures = 0

function check(ok, what, detail) {
  if (ok) {
    log(`  ✓ ${what}`)
    return
  }
  failures += 1
  log(`  ✗ ${what}${detail === undefined ? '' : `\n      ${detail}`}`)
}

const SQL = 'select customer, total from orders where total > 10'

/* ------------------------------------------------------------------ */
/* The two runs                                                        */
/* ------------------------------------------------------------------ */

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'peek-workspace-verify-'))
  const configDir = join(root, 'config')
  const userDataDir = join(root, 'user-data')
  const fixture = await makeFixture(root)
  const config = { driverId: 'sqlite', file: fixture, label: 'restore-fixture' }

  try {
    /* ---- Run 1: arrange a desk, then let the app quit ------------- */

    log('run 1: arranging a desk')
    const port1 = await pickFreePort()
    const app1 = launch({ label: 'run1', mcpPort: port1, configDir, userDataDir })
    const endpoint1 = await waitForEndpoint(configDir, app1, null)
    const client1 = await connectMcp(endpoint1)

    const connId = await connectDriver(client1, config)

    const tree = await call(client1, 'introspect', { connId, depth: 3, maxNodes: 60 })
    const ref = findRef(tree)
    if (ref === null) throw new Error('introspect found nothing to open')
    debug('opening', JSON.stringify(ref))

    const opened = await call(client1, 'open_view', { spec: { kind: 'table', connId, ref }, waitMs: 5_000 })
    // Deliberately no `run`: the statement is what must come back *unexecuted*.
    const editor = await call(client1, 'open_view', { spec: { kind: 'query', connId, text: SQL } })
    if (typeof opened?.viewId !== 'string' || typeof editor?.viewId !== 'string') {
      throw new Error('open_view did not report a viewId')
    }

    // A pane each, so the restore has a tree to rebuild and not just a tab strip.
    await call(client1, 'set_layout', {
      tree: {
        type: 'split',
        dir: 'row',
        children: [
          { type: 'panel', key: 'left', viewIds: [opened.viewId] },
          { type: 'panel', key: 'right', viewIds: [editor.viewId] },
        ],
      },
    })

    const before = await call(client1, 'read_workspace', {})
    debug('run 1 workspace:', JSON.stringify(before, null, 2))

    await client1.close()
    await waitForQuit(app1, 'run1')

    /* ---- What landed on disk -------------------------------------- */

    log('the file')
    const path = join(configDir, 'workspace.json')
    check(existsSync(path), 'workspace.json was written on quit')
    const raw = readFileSync(path, 'utf8')
    const file = JSON.parse(raw)
    check(file.version === 1, 'it carries a version')
    check(file.views?.length === 2, `both views are in it (got ${String(file.views?.length)})`)
    check(
      file.views?.some((v) => v.spec?.kind === 'query' && v.spec?.text === SQL),
      'the unrun statement is in it, verbatim',
    )
    check(file.connections?.length === 1, 'the connection is named by identity, once')
    for (const forbidden of ['cursorToken', 'resultId', '"status"', 'rows']) {
      check(!raw.includes(forbidden), `no ${forbidden} reached the file`)
    }

    /* ---- Run 2: the same ~/.peek, a fresh process ------------------ */

    log('run 2: opening again')
    const port2 = await pickFreePort()
    const app2 = launch({ label: 'run2', mcpPort: port2, configDir, userDataDir })
    const client2 = await connectMcp(await waitForEndpoint(configDir, app2, endpoint1.url))

    const after = await waitForRestore(client2)
    debug('run 2 workspace:', JSON.stringify(after, null, 2))

    const views = viewsOf(after)
    check(views.length === 2, `both views came back (got ${String(views.length)})`)
    // `read_workspace` describes a query view rather than echoing it, so the
    // statement itself is checked on disk above; here it only has to be the same
    // editor that came back, in the same pane.
    const query = views.find((v) => v.kind === 'query')
    check(query !== undefined, 'the query editor came back')
    check(
      typeof query?.describe === 'string' && query.describe.includes('orders'),
      'and it still describes the statement it was left with',
      JSON.stringify(query),
    )
    check(
      panelCount(after?.layout) === 2,
      `the split came back (got ${String(panelCount(after?.layout))} panels)`,
    )
    check(
      (after?.connections ?? []).some((c) => c.status === 'ready'),
      'the connection reconnected on its own',
    )

    const table = views.find((v) => v.kind === 'table')
    check(table !== undefined && table.status === 'ready', 'the restored table filled itself in', JSON.stringify(table))
    check(
      !views.some((v) => v.kind === 'query' && v.status === 'ready'),
      'and the statement was still not run',
    )

    await client2.close()
    await waitForQuit(app2, 'run2')
  } finally {
    if (KEEP) log(`\nkept: ${root}`)
    else rmSync(root, { recursive: true, force: true })
  }

  if (failures > 0) {
    log(`\n${String(failures)} check(s) failed`)
    process.exitCode = 1
    return
  }
  log('\nthe desk came back')
}

/** The first node `open_view` can show. */
function findRef(node) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findRef(child)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.ref !== undefined && node.ref !== null) return node.ref
  for (const value of Object.values(node)) {
    const hit = findRef(value)
    if (hit !== null) return hit
  }
  return null
}

/**
 * Every mounted view. `read_workspace` reports views *inside* their panel, with
 * anything unmounted in a list of its own — so a restore is only right if the
 * views come back in the panels, which is what reading them from here asserts.
 */
function viewsOf(snapshot) {
  return (snapshot?.panels ?? []).flatMap((panel) => panel.views ?? [])
}

function panelCount(layout) {
  if (layout === null || typeof layout !== 'object') return 0
  if (layout.type === 'panel') return 1
  return (layout.children ?? []).reduce((n, child) => n + panelCount(child), 0)
}

/**
 * Read the workspace until the restored table has fetched.
 *
 * The restore deliberately does not wait for connections, so run 2's first
 * `read_workspace` may legitimately arrive before the handshake finishes. That
 * *is* the design; the thing being verified is that it converges.
 */
async function waitForRestore(client) {
  const deadline = Date.now() + WAKE_TIMEOUT_MS
  let last = null
  while (Date.now() < deadline) {
    last = await call(client, 'read_workspace', {})
    const table = viewsOf(last).find((v) => v.kind === 'table')
    if (table?.status === 'ready') return last
    await delay(500)
  }
  return last
}

await main()
