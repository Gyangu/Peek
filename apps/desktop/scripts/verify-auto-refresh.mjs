import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { Cdp } from './cdp.mjs'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))

const DEFAULT_ROWS = 1_000_000
const DEFAULT_FRAMES = 600
const MCP_READY_TIMEOUT_MS = 45_000
/** The `run_query` tool caps both `waitMs` and `timeoutMs` at 120s; do not exceed it. */
const QUERY_TIMEOUT_MS = 120_000
const APP_LIFETIME_MS = 600_000
/** Pixels of wheel delta per frame — roughly a fast but not absurd trackpad fling. */
const WHEEL_DELTA_PX = 120

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function intArg(argv, name, fallback) {
  const found = argv.find((a) => a.startsWith(`--${name}=`))
  if (!found) return fallback
  const value = Number.parseInt(found.slice(name.length + 3), 10)
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`)
  return value
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/**
 * A SQLite file with `rows` rows, cached by row count.
 *
 * Deliberately wide-ish and mixed-type: a single INTEGER column would let the
 * columnar cache and the cell formatter take paths a real result set never
 * takes, and the column axis would virtualize to one visible column.
 */
async function ensureFixture(rows, verbose) {
  const dir = join(tmpdir(), 'peek-bench-fixtures')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `bench-${String(rows)}.sqlite`)
  if (existsSync(path)) {
    if (verbose) console.log(`fixture: reusing ${path}`)
    return path
  }

  const { DatabaseSync } = await import('node:sqlite')
  // Build under a temp name and rename into place, so an interrupted run cannot
  // leave a half-populated file that every later run happily reuses.
  const partial = `${path}.partial`
  rmSync(partial, { force: true })
  const db = new DatabaseSync(partial)
  try {
    db.exec('PRAGMA journal_mode = OFF')
    db.exec('PRAGMA synchronous = OFF')
    db.exec(`CREATE TABLE bench (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      score REAL NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT
    )`)
    const insert = db.prepare(
      'INSERT INTO bench (id, name, email, score, active, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const started = Date.now()
    db.exec('BEGIN')
    for (let i = 1; i <= rows; i += 1) {
      insert.run(
        i,
        `row-${String(i)}`,
        `user${String(i)}@example.invalid`,
        (i % 1000) / 10,
        i % 2,
        new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
        i % 7 === 0 ? null : `note for row ${String(i)}`,
      )
    }
    db.exec('COMMIT')
    if (verbose) console.log(`fixture: wrote ${String(rows)} rows in ${String(Date.now() - started)}ms`)
  } finally {
    db.close()
  }
  renameSync(partial, path)
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

function launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose }) {
  const electronBin = process.env['PEEK_ELECTRON_BIN'] ?? electronBinaryPath()
  const childEnv = { ...process.env }
  // Inherited from whatever spawned this script, it would turn the Electron
  // binary into a bare node runtime: no window, nothing to scroll.
  delete childEnv['ELECTRON_RUN_AS_NODE']
  childEnv['PEEK_MCP_PORT'] = String(mcpPort)
  childEnv['PEEK_CONFIG_DIR'] = configDir
  childEnv['PEEK_SMOKE_EXIT_MS'] = String(APP_LIFETIME_MS)

  const child = spawn(
    electronBin,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${String(cdpPort)}`],
    { cwd: DESKTOP_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const logLines = []
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
      for (const line of parts) {
        logLines.push(`[${tag}] ${line}`)
        if (verbose) console.log(`[app/${tag}] ${line}`)
      }
    })
  }
  return { child, logLines }
}

async function waitForEndpoint(configDir, child) {
  const path = join(configDir, 'mcp.json')
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited early with code ${String(child.exitCode)}`)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.url === 'string' && typeof parsed.token === 'string') return parsed
    } catch {
      // not written yet, or half-written
    }
    await delay(200)
  }
  throw new Error(`the MCP endpoint file never appeared at ${path}`)
}

/* ------------------------------------------------------------------ */
/* The in-page scroll pass                                             */
/* ------------------------------------------------------------------ */

/** Resolve once the grid is mounted and has rendered at least one row. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)
  return {
    n: sorted.length,
    mean,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
  }
}

const ms = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(2)}ms`)

/* ------------------------------------------------------------------ */
/* MCP helpers                                                         */
/* ------------------------------------------------------------------ */

const textOf = (result) =>
  (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

/**
 * A tool's structured `data`, emitted as a second text block after the prose one.
 * Parsing that beats scraping the prose: it is the value the tool handed back,
 * not a rendering of it.
 */
function toolData(result) {
  const blocks = (result.content ?? []).filter((c) => c.type === 'text')
  if (blocks.length < 2) return null
  try {
    return JSON.parse(blocks[blocks.length - 1].text)
  } catch {
    return null
  }
}

async function withTimeout(promise, timeoutMs, what) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not finish within ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** First value found under `key`, at any depth. */
function findKey(value, key) {
  if (value === null || typeof value !== 'object') return undefined
  if (!Array.isArray(value) && value[key] !== undefined) return value[key]
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findKey(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Poll `read_workspace` until the result set leaves `running`.
 *
 * `paused` counts as settled and is reported as such: it means the ack
 * backpressure is holding, every row already delivered is valid, and the number
 * to read is `rows`, not the elapsed time.
 */
async function waitForResultSettled(client, cdp, resultId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const keepReading = pressKeyExpression('End')
  let last = { status: 'running', rows: 0, truncated: false }
  while (Date.now() < deadline) {
    await cdp.evaluate(keepReading)
    const snapshot = await withTimeout(
      client.callTool({ name: 'read_workspace', arguments: { include: ['results'] } }),
      20_000,
      'read_workspace',
    )
    const results = toolData(snapshot)?.results ?? []
    const row = results.find((r) => r.resultId === resultId)
    if (row) {
      last = { status: row.status, rows: row.rows ?? 0, truncated: row.truncated === true }
      if (row.status !== 'running') return last
    }
    await delay(50)
  }
  return { ...last, timedOut: true }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

/* ==================================================================
 * Auto-refresh, end to end, in the real app.
 *
 *   pnpm --filter @peek/desktop build
 *   node apps/desktop/scripts/verify-auto-refresh.mjs
 *
 * Free — it drives a SQLite fixture it generates itself, needs no database
 * service and no network. Exit code 0 = every check passed.
 *
 * It exists because the interesting half of this feature is not reachable from a
 * unit test. `auto-refresh.test.ts` proves the scheduler beats correctly against
 * a hand-cranked clock and a stubbed driver; what it cannot see is whether the
 * control is drawn at all, whether picking an interval reaches main, and whether
 * the grid holds its place while the rows underneath it are replaced — which is
 * the whole reason the feature is worth having. Two of the ten checks here have
 * already caught real gaps: the interval was missing from `read_workspace`'s
 * view brief (so a model could not tell a live view from a still one).
 *
 * Launches the built product against a small SQLite fixture, opens a table
 * view over MCP, then drives the toolbar with CDP the way a person would:
 * click the `auto` button, pick 1s from the menu, and watch what happens.
 *
 * What it asserts:
 *   1. the control is drawn on a table view and reads "Off" to start with;
 *   2. picking an interval writes `autoRefreshMs` into main's Workspace;
 *   3. the view is actually refetched — the result id changes on its own;
 *   4. the reader's scroll position and dragged column widths survive a tick;
 *   5. picking Off stops it: no further result ids.
 * ================================================================== */

const FIXTURE_ROWS = 5_000

function q(s) {
  return JSON.stringify(s)
}

const awaitGrid = `(async () => {
  for (let i = 0; i < 600; i += 1) {
    const surface = document.querySelector('.grid-surface')
    if (surface && surface.children.length > 0) return surface.children.length
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('grid never rendered a row')
})()`

const readControl = `(() => {
  const b = document.querySelector('[data-peek-action="view.autoRefresh"]')
  return b ? b.textContent.trim() : null
})()`

function openMenuAndPick(itemId) {
  return `(async () => {
    const b = document.querySelector('[data-peek-action="view.autoRefresh"]')
    if (!b) throw new Error('no auto-refresh control on the toolbar')
    b.click()
    for (let i = 0; i < 100; i += 1) {
      const item = document.querySelector('[data-menu-item=' + ${q(JSON.stringify(itemId))} + ']')
      if (item) { item.click(); return true }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('menu item ' + ${q(itemId)} + ' never appeared')
  })()`
}

/** Widen the first data column by dragging its resize handle, so we can tell if it survives. */
const widenFirstColumn = `(async () => {
  const cell = document.querySelector('.grid-head .grid-head-cell')
  if (!cell) throw new Error('no header cell')
  const before = cell.getBoundingClientRect().width
  const handle = cell.querySelector('.col-resizer')
  if (!handle) throw new Error('no resize handle')
  const x = cell.getBoundingClientRect().right
  const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientY: 10 }
  handle.setPointerCapture = () => {}
  handle.releasePointerCapture = () => {}
  handle.hasPointerCapture = () => false
  handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x }))
  handle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x + 120 }))
  handle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x + 120 }))
  await new Promise((r) => setTimeout(r, 120))
  return { before, after: document.querySelector('.grid-head .grid-head-cell').getBoundingClientRect().width }
})()`

const firstColumnWidth = `(() => {
  const cell = document.querySelector('.grid-head .grid-head-cell')
  return cell ? cell.getBoundingClientRect().width : null
})()`

/** Scroll down by wheeling over the grid, then report the first visible row index. */
const scrollDown = `(async () => {
  const wrap = document.querySelector('.grid-wrap')
  if (!wrap) throw new Error('no .grid-wrap')
  for (let i = 0; i < 20; i += 1) {
    wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    await new Promise((r) => requestAnimationFrame(() => r()))
  }
  await new Promise((r) => setTimeout(r, 150))
  const n = document.querySelector('.grid-surface .grid-rownum')
  return n ? Number(n.textContent.replace(/[^0-9]/g, '')) : null
})()`

const visibleFirstRow = `(() => {
  const n = document.querySelector('.grid-surface .grid-rownum')
  return n ? Number(n.textContent.replace(/[^0-9]/g, '')) : null
})()`

async function workspace(client) {
  const res = await client.callTool({ name: 'read_workspace', arguments: {} })
  const data = toolData(res)
  if (data === null)
    throw new Error('read_workspace returned no structured block:\n' + textOf(res).slice(0, 800))
  return data
}

async function tableView(client) {
  const ws = await workspace(client)
  const views = (ws.panels ?? []).flatMap((p) => p.views ?? []).concat(ws.unplacedViews ?? [])
  const view = views.find((v) => v.kind === 'table')
  if (!view) throw new Error('no table view in:\n' + JSON.stringify(ws, null, 2).slice(0, 2000))
  return view
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const verbose = process.argv.includes('--verbose')
  const fixture = await ensureFixture(FIXTURE_ROWS, true)
  const configDir = mkdtempSync(join(tmpdir(), 'peek-ar-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-ar-udd-'))
  const mcpPort = await pickFreePort()
  const cdpPort = await pickFreePort()
  const { child, logLines } = launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose })
  let client = null
  let cdp = null

  try {
    const endpoint = await waitForEndpoint(configDir, child)
    client = new Client({ name: 'peek-auto-refresh', version: '1.0.0' }, { capabilities: {} })
    await withTimeout(
      client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }),
      ),
      20_000,
      'MCP handshake',
    )

    const connectResult = await withTimeout(
      client.callTool({
        name: 'connect',
        arguments: { config: { driverId: 'sqlite', file: fixture, label: 'ar' } },
      }),
      30_000,
      'connect',
    )
    const connId = /Connection\s+(\S+)\s+is\s+ready/.exec(textOf(connectResult))?.[1]
    if (!connId) throw new Error('no connId:\n' + textOf(connectResult))

    const opened = await withTimeout(
      client.callTool({
        name: 'open_view',
        arguments: {
          spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'main', name: 'bench' } },
        },
      }),
      30_000,
      'open_view',
    )
    if (opened.isError === true) throw new Error('open_view failed:\n' + textOf(opened))

    cdp = await Cdp.attach(cdpPort)
    await cdp.evaluate(awaitGrid)

    /* 1. the control exists and starts off */
    const initial = await cdp.evaluate(readControl)
    check('the toolbar draws an auto-refresh control', initial !== null, String(initial))
    check('it starts off', typeof initial === 'string' && /Off/.test(initial), String(initial))

    /* set up something to preserve */
    const widths = await cdp.evaluate(widenFirstColumn)
    const anchorRow = await cdp.evaluate(scrollDown)
    check(
      'the reader scrolled away from the top',
      (anchorRow ?? 0) > 0,
      `first visible row ${String(anchorRow)}`,
    )

    /* 2. picking an interval reaches main */
    await cdp.evaluate(openMenuAndPick('ms-1000'))
    await delay(300)
    const on = await tableView(client)
    check(
      'picking 1s writes autoRefreshMs into the Workspace',
      on.autoRefreshMs === 1000,
      String(on.autoRefreshMs),
    )
    const label = await cdp.evaluate(readControl)
    check('and the button reports the interval', /1/.test(String(label)), String(label))

    /* 3. it actually refetches */
    const before = (await tableView(client)).result?.resultId
    await delay(3_500)
    const after = (await tableView(client)).result?.resultId
    check('the view refetched on its own', before !== after, `${String(before)} → ${String(after)}`)

    /* 4. position and column width survived */
    const rowNow = await cdp.evaluate(visibleFirstRow)
    const widthNow = await cdp.evaluate(firstColumnWidth)
    check(
      'the scroll position survived the ticks',
      rowNow !== null && Math.abs(rowNow - anchorRow) <= 12,
      `${String(anchorRow)} → ${String(rowNow)}`,
    )
    check(
      'the dragged column width survived the ticks',
      widthNow !== null && Math.abs(widthNow - widths.after) < 4,
      `${String(widths.before)} → ${String(widths.after)} → ${String(widthNow)}`,
    )

    /* 5. off means off */
    await cdp.evaluate(openMenuAndPick('off'))
    await delay(300)
    const offView = await tableView(client)
    check(
      'picking Off clears the interval',
      offView.autoRefreshMs === undefined,
      String(offView.autoRefreshMs),
    )
    const settled = offView.result?.resultId
    await delay(3_000)
    check('and nothing refetches after that', (await tableView(client)).result?.resultId === settled)
  } catch (error) {
    console.error('\n' + String(error?.stack ?? error))
    console.error('\n--- app log tail ---\n' + logLines.slice(-40).join('\n'))
    process.exitCode = 1
  } finally {
    cdp?.close()
    await client?.close().catch(() => {})
    child.kill('SIGTERM')
    rmSync(configDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
