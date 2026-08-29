/**
 * screenshot.mjs — produce the README's screenshots by driving the built app
 * over its own MCP endpoint, the way an AI client would.
 *
 * The point of doing it this way rather than by hand: the arrangement in every
 * shot is a `set_layout` call, so the pictures in the README are literally the
 * thing the README claims — a window an MCP client put together. A screenshot
 * taken by dragging panes around would show the same pixels and prove nothing.
 *
 * Like the two `bench-*.mjs` it launches the **built** app on a throwaway port,
 * user-data directory and config directory, so an installed peek neither blocks
 * it nor is disturbed by it. `pnpm --filter @peek/desktop build` first.
 *
 * One recording and three stills, each a `set_layout` call away from the last:
 *
 *   agent-drives  the README's hero — a real Claude Code turn, recorded live
 *   overview      the tiled window — namespace tree, a table, a query that has run
 *   million-rows  one streamed result, drained to `done` and sitting deep in it
 *   agent-asks    an `ask` suspended mid-call, waiting on a person to click
 *
 *   node apps/desktop/scripts/screenshot.mjs                    # 4 shots x 2 themes
 *   node apps/desktop/scripts/screenshot.mjs --theme dark
 *   node apps/desktop/scripts/screenshot.mjs --only agent-asks --rows 50000
 *   node apps/desktop/scripts/screenshot.mjs --rows 200000 --verbose
 *
 * Output lands in `docs/images/`, one PNG per still per theme; `agent-drives`
 * writes a GIF and the final frame beside it (`design/2026-08-29-the-hero-image
 * -moves.md` §2.4 — the still is what a reader who asked for reduced motion
 * gets). `--only` takes a comma-separated list and exists because a full run
 * drains a million rows, which turns a one-line tweak to a shot into a
 * four-minute round trip.
 *
 * The recording needs `ffmpeg` on PATH and a Claude Code login on this machine —
 * it drives the real embedded agent and spends tokens, the same deal
 * `verify-chat-security.mjs` makes. The stills need neither.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { Cdp } from './cdp.mjs'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_DIR = fileURLToPath(new URL('../../..', import.meta.url))
const OUT_DIR = join(REPO_DIR, 'docs', 'images')

const DEFAULT_EVENT_ROWS = 1_000_000
/**
 * The four shots and the two themes, in the order they are taken.
 *
 * `agent-drives` is first because it is the only one that has an opening state:
 * it records a workspace filling up, so it has to start from an empty one. Run
 * after any still, it would open on that still's panes.
 */
const SHOTS = ['agent-drives', 'overview', 'million-rows', 'agent-asks']
const THEMES = ['dark', 'light']
const MCP_READY_TIMEOUT_MS = 45_000
const APP_LIFETIME_MS = 600_000
/** Long enough for the grid to stream its first screens and for the paint to settle. */
const SETTLE_MS = 2_500

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

/**
 * A deterministic LCG, so a rebuilt fixture is byte-identical and a re-run does
 * not silently change what the README shows.
 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

const FIRST = [
  'Ada',
  'Bruno',
  'Chen',
  'Dara',
  'Emil',
  'Farah',
  'Gita',
  'Hugo',
  'Ingrid',
  'Jonas',
  'Kaori',
  'Lucia',
  'Mateo',
  'Nadia',
  'Omar',
  'Petra',
  'Quinn',
  'Rosa',
  'Sven',
  'Tariq',
  'Ulla',
  'Viktor',
  'Wren',
  'Xiulan',
  'Yosef',
  'Zara',
]
const LAST = [
  'Alvarez',
  'Bakker',
  'Costa',
  'Dubois',
  'Eriksen',
  'Ferrari',
  'Grimaldi',
  'Haas',
  'Ibrahim',
  'Jansen',
  'Kowalski',
  'Lindqvist',
  'Moreau',
  'Novak',
  'Okafor',
  'Pavlov',
  'Quintero',
  'Rossi',
  'Suzuki',
  'Tanaka',
  'Ueda',
  'Vargas',
  'Weber',
  'Xu',
  'Yilmaz',
  'Zhang',
]
const COUNTRIES = ['DE', 'FR', 'JP', 'US', 'BR', 'SE', 'NL', 'IN', 'CA', 'AU', 'ES', 'PL']
const PLANS = ['free', 'starter', 'team', 'business', 'enterprise']
const CATEGORIES = ['analytics', 'storage', 'compute', 'networking', 'observability']
const ORDER_STATUS = ['paid', 'pending', 'refunded', 'failed', 'paid', 'paid']
const EVENT_KINDS = [
  'query.run',
  'view.open',
  'conn.open',
  'layout.setLayout',
  'export.csv',
  'session.start',
  'session.end',
  'chat.send',
]

/**
 * The demo database, cached by event-row count.
 *
 * Four tables rather than one, because the namespace tree is half of what the
 * overview shot is showing and a single table would render it as one leaf. The
 * shapes are mixed on purpose — text, real, integer-as-boolean, ISO timestamps,
 * and a nullable column — so the grid's cell formatter is doing real work in the
 * picture rather than printing a column of integers.
 */
async function ensureFixture(eventRows, verbose) {
  const dir = join(tmpdir(), 'peek-shot-fixtures')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `demo-v2-${String(eventRows)}.sqlite`)
  if (existsSync(path)) {
    if (verbose) console.log(`fixture: reusing ${path}`)
    return path
  }

  const { DatabaseSync } = await import('node:sqlite')
  const partial = `${path}.partial`
  rmSync(partial, { force: true })
  const db = new DatabaseSync(partial)
  const started = Date.now()
  try {
    db.exec('PRAGMA journal_mode = OFF')
    db.exec('PRAGMA synchronous = OFF')

    db.exec(`CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      country TEXT NOT NULL,
      plan TEXT NOT NULL,
      mrr_usd REAL NOT NULL,
      active INTEGER NOT NULL,
      signed_up_at TEXT NOT NULL
    )`)
    db.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_usd REAL NOT NULL,
      in_stock INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      total_usd REAL NOT NULL,
      status TEXT NOT NULL,
      placed_at TEXT NOT NULL
    )`)
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      payload TEXT,
      occurred_at TEXT NOT NULL
    )`)

    /*
     * Six more small tables, populated but never queried by a shot.
     *
     * They exist for the namespace tree: with four tables the tree pane in the
     * overview shot was four rows over an empty pane, and a screenshot of an
     * almost-empty navigator argues against the thing it is illustrating. A real
     * analytics schema has a dozen tables, so the fixture has a dozen.
     */
    db.exec(`CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, plan TEXT NOT NULL,
      seats INTEGER NOT NULL, renews_at TEXT NOT NULL, cancelled INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE invoices (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount_usd REAL NOT NULL,
      paid INTEGER NOT NULL, issued_at TEXT NOT NULL
    )`)
    db.exec(`CREATE TABLE refunds (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, amount_usd REAL NOT NULL,
      reason TEXT NOT NULL, refunded_at TEXT NOT NULL
    )`)
    db.exec(`CREATE TABLE regions (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, tax_rate REAL NOT NULL
    )`)
    db.exec(`CREATE TABLE feature_flags (
      key TEXT PRIMARY KEY, description TEXT NOT NULL, enabled INTEGER NOT NULL, rollout_pct INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, at TEXT NOT NULL
    )`)

    const rand = rng(20_260_824)
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString()

    const CUSTOMERS = 2_400
    const PRODUCTS = 120
    const ORDERS = 14_000

    db.exec('BEGIN')
    const insCustomer = db.prepare(
      'INSERT INTO customers (id, name, email, country, plan, mrr_usd, active, signed_up_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= CUSTOMERS; i += 1) {
      const first = pick(FIRST)
      const last = pick(LAST)
      const plan = pick(PLANS)
      insCustomer.run(
        i,
        `${first} ${last}`,
        `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        pick(COUNTRIES),
        plan,
        Math.round(PLANS.indexOf(plan) * 49.5 * (0.6 + rand()) * 100) / 100,
        rand() > 0.18 ? 1 : 0,
        day(i * 7),
      )
    }

    const insProduct = db.prepare(
      'INSERT INTO products (id, sku, name, category, price_usd, in_stock) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= PRODUCTS; i += 1) {
      const category = pick(CATEGORIES)
      insProduct.run(
        i,
        `${category.slice(0, 3).toUpperCase()}-${String(1000 + i)}`,
        `${category[0].toUpperCase()}${category.slice(1)} tier ${String((i % 5) + 1)}`,
        category,
        Math.round((9 + rand() * 490) * 100) / 100,
        rand() > 0.25 ? 1 : 0,
      )
    }

    const insOrder = db.prepare(
      'INSERT INTO orders (id, customer_id, product_id, quantity, total_usd, status, placed_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= ORDERS; i += 1) {
      const quantity = 1 + Math.floor(rand() * 8)
      insOrder.run(
        i,
        1 + Math.floor(rand() * CUSTOMERS),
        1 + Math.floor(rand() * PRODUCTS),
        quantity,
        Math.round(quantity * (9 + rand() * 490) * 100) / 100,
        pick(ORDER_STATUS),
        day(i),
      )
    }

    const insSub = db.prepare(
      'INSERT INTO subscriptions (id, customer_id, plan, seats, renews_at, cancelled) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= 1_800; i += 1) {
      insSub.run(
        i,
        1 + Math.floor(rand() * CUSTOMERS),
        pick(PLANS),
        1 + Math.floor(rand() * 40),
        day(i * 5),
        rand() > 0.88 ? 1 : 0,
      )
    }
    const insInvoice = db.prepare(
      'INSERT INTO invoices (id, customer_id, amount_usd, paid, issued_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= 6_200; i += 1) {
      insInvoice.run(
        i,
        1 + Math.floor(rand() * CUSTOMERS),
        Math.round(rand() * 4_800 * 100) / 100,
        rand() > 0.12 ? 1 : 0,
        day(i * 2),
      )
    }
    const insRefund = db.prepare(
      'INSERT INTO refunds (id, invoice_id, amount_usd, reason, refunded_at) VALUES (?, ?, ?, ?, ?)',
    )
    const REASONS = ['duplicate charge', 'downgrade credit', 'service outage', 'billing error', 'goodwill']
    for (let i = 1; i <= 340; i += 1) {
      insRefund.run(
        i,
        1 + Math.floor(rand() * 6_200),
        Math.round(rand() * 900 * 100) / 100,
        pick(REASONS),
        day(i * 19),
      )
    }
    const insRegion = db.prepare('INSERT INTO regions (code, name, currency, tax_rate) VALUES (?, ?, ?, ?)')
    for (const [code, name, currency, tax] of [
      ['EU-WEST', 'Europe West', 'EUR', 0.21],
      ['EU-NORTH', 'Europe North', 'SEK', 0.25],
      ['NA-EAST', 'North America East', 'USD', 0.0875],
      ['NA-WEST', 'North America West', 'USD', 0.095],
      ['APAC-JP', 'Japan', 'JPY', 0.1],
      ['APAC-AU', 'Australia', 'AUD', 0.1],
      ['LATAM-BR', 'Brazil', 'BRL', 0.17],
      ['SA-IN', 'India', 'INR', 0.18],
    ]) {
      insRegion.run(code, name, currency, tax)
    }
    const insFlag = db.prepare(
      'INSERT INTO feature_flags (key, description, enabled, rollout_pct) VALUES (?, ?, ?, ?)',
    )
    for (const [key, description] of [
      ['vector_search', 'Similarity search in the console'],
      ['streaming_export', 'Stream CSV exports instead of buffering'],
      ['multi_region', 'Route reads to the nearest replica'],
      ['audit_retention_365', 'Keep the audit log for a year'],
      ['self_serve_downgrade', 'Let customers downgrade without support'],
      ['usage_alerts', 'Email when a quota crosses 80%'],
    ]) {
      insFlag.run(key, description, rand() > 0.4 ? 1 : 0, Math.floor(rand() * 101))
    }
    const insAudit = db.prepare(
      'INSERT INTO audit_log (id, actor, action, target, at) VALUES (?, ?, ?, ?, ?)',
    )
    const ACTIONS = ['plan.changed', 'seat.added', 'invoice.voided', 'flag.toggled', 'member.invited']
    for (let i = 1; i <= 900; i += 1) {
      insAudit.run(
        i,
        `${pick(FIRST).toLowerCase()}@acme.example`,
        pick(ACTIONS),
        `customer:${String(1 + Math.floor(rand() * CUSTOMERS))}`,
        day(i * 7),
      )
    }
    db.exec('COMMIT')

    // The big one goes in its own transaction so the small tables are durable
    // even if this is interrupted — and it is the only loop worth reporting on.
    db.exec('BEGIN')
    const insEvent = db.prepare(
      'INSERT INTO events (id, customer_id, kind, duration_ms, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 1; i <= eventRows; i += 1) {
      insEvent.run(
        i,
        1 + (i % CUSTOMERS),
        EVENT_KINDS[i % EVENT_KINDS.length],
        1 + (i % 2_500),
        i % 11 === 0 ? null : `{"rows":${String(i % 5000)},"cached":${i % 3 === 0 ? 'true' : 'false'}}`,
        day(i / 24),
      )
    }
    db.exec('COMMIT')
    if (verbose) console.log(`fixture: built in ${String(Date.now() - started)}ms`)
  } finally {
    db.close()
  }
  renameSync(partial, path)
  return path
}

/**
 * The two rollups the `ask` card offers, counted in the fixture itself.
 *
 * The card ends up beside a grid running `GROUP BY strftime('%Y-W%W', …)` over
 * the same table, and an agent stating a number the query output next to it
 * disproves is the one thing these pictures must not show. So the counts are not
 * written down here: they are read out of the file the grid reads, with the
 * expressions the two options describe.
 *
 * Arithmetic on `eventRows` gets days right — rows are 2.5 minutes apart, so
 * `ceil(eventRows / 576)` — and weeks wrong. `%W` is scoped to the calendar year,
 * so every year boundary opens a bucket `ceil(days / 7)` knows nothing about:
 * 249 against the 252 the grid shows.
 */
async function rollupBuckets(fixture) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(fixture, { readOnly: true })
  try {
    const row = db
      .prepare(
        'SELECT COUNT(DISTINCT date(occurred_at))              AS days,' +
          " COUNT(DISTINCT strftime('%Y-W%W', occurred_at))     AS weeks," +
          ' MIN(occurred_at)                                    AS first,' +
          ' MAX(occurred_at)                                    AS last' +
          ' FROM events',
      )
      .get()
    if (typeof row?.days !== 'number' || row.days < 1) {
      throw new Error(`the fixture at ${fixture} has no events to roll up`)
    }
    return {
      days: row.days,
      weeks: row.weeks,
      firstYear: String(row.first).slice(0, 4),
      lastYear: String(row.last).slice(0, 4),
    }
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* App lifecycle — same shape as bench-scroll.mjs                      */
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
  delete childEnv['ELECTRON_RUN_AS_NODE']
  childEnv['PEEK_MCP_PORT'] = String(mcpPort)
  childEnv['PEEK_CONFIG_DIR'] = configDir
  childEnv['PEEK_SMOKE_EXIT_MS'] = String(APP_LIFETIME_MS)

  const child = spawn(
    electronBin,
    ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${String(cdpPort)}`],
    { cwd: DESKTOP_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const [stream, tag] of [
    [child.stdout, 'out'],
    [child.stderr, 'err'],
  ]) {
    stream.setEncoding('utf8')
    stream.on('data', (piece) => {
      if (verbose) process.stdout.write(`[app/${tag}] ${piece}`)
    })
  }
  return child
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
/* MCP helpers                                                         */
/* ------------------------------------------------------------------ */

const textOf = (result) =>
  (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

async function call(client, name, args, what = name) {
  const result = await client.callTool({ name, arguments: args })
  const text = textOf(result)
  if (result.isError === true) throw new Error(`${what} failed:\n${text}`)
  return { text, result }
}

/** Every structured (JSON) block a tool emitted, parsed. */
function dataBlocks(result) {
  const out = []
  for (const c of result.content ?? []) {
    if (c.type !== 'text') continue
    try {
      out.push(JSON.parse(c.text))
    } catch {
      // the prose block, not the data one
    }
  }
  return out
}

/** Depth-first walk over anything, yielding every plain object. */
function* walk(value) {
  if (value === null || typeof value !== 'object') return
  if (!Array.isArray(value)) yield value
  for (const child of Object.values(value)) yield* walk(child)
}

/**
 * The namespace tree, flattened to the nodes that matter here: every node's id,
 * name, and `ref` when it has one.
 *
 * Both things the shots need come out of this one call — the `ref` for a table,
 * and the id of the schema node the tree view has to be told to expand. A tree
 * view opened without `expanded` renders one collapsed root, which is what the
 * first attempt at these screenshots showed: a pane that proves nothing.
 */
async function namespaceNodes(client, connId) {
  const { text, result } = await call(client, 'introspect', { connId, depth: 3 }, 'introspect')
  const nodes = []
  for (const block of dataBlocks(result)) {
    for (const obj of walk(block)) {
      if (typeof obj.id === 'string' && typeof obj.name === 'string') {
        nodes.push({ id: obj.id, name: obj.name, kind: obj.kind, ref: obj.ref })
      }
    }
  }
  if (nodes.length === 0) throw new Error(`introspect returned no nodes:\n${text}`)
  return nodes
}

const refFor = (nodes, name) => {
  const hit = nodes.find((n) => n.name === name && n.ref)
  if (!hit) throw new Error(`no ref for table ${name} (saw: ${nodes.map((n) => n.name).join(', ')})`)
  return hit.ref
}

/** Ids of the nodes that are not tables — the schema level the tree must expand. */
const containerIds = (nodes) => nodes.filter((n) => !n.ref).map((n) => n.id)

/** Open one view through `view.open` and return its id. */
async function openView(client, spec, waitMs = 0) {
  const { text, result } = await call(client, 'open_view', { spec, waitMs }, `open_view/${spec.kind}`)
  const viewId = dataBlocks(result)
    .map((b) => b.viewId)
    .find((v) => typeof v === 'string')
  if (!viewId) throw new Error(`open_view returned no viewId:\n${text}`)
  return viewId
}

/* ------------------------------------------------------------------ */
/* Window chrome                                                       */
/* ------------------------------------------------------------------ */

/**
 * Collapse the conversations rail before the shutter.
 *
 * It is `localStorage` rather than a Command on purpose — a side rail's open/shut
 * is renderer-local window chrome and deliberately not in the Workspace
 * (`design/2026-08-04-sidebar-collapse.md` §2.2), so there is no MCP tool that
 * can reach it and this is the honest way in. Without it every screenshot spends
 * 18% of its width on an empty "No conversations yet."
 *
 * The connections rail is left open: it is showing something, and it is half of
 * what "a connection book" means.
 */
async function collapseChatRail(cdp) {
  await cdp.evaluate(`(() => {
    localStorage.setItem('peek.chatRail.collapsed', '1')
    localStorage.setItem('peek.sidebar.collapsed', '0')
    return 'set'
  })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await delay(1_000)
  await cdp.waitForFirstPaint()
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function capture(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (typeof shot?.data !== 'string') throw new Error(`captureScreenshot returned nothing for ${file}`)
  const bytes = Buffer.from(shot.data, 'base64')
  writeFileSync(file, bytes)
  console.log(`  wrote ${file} (${String(Math.round(bytes.length / 1024))}KB)`)
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

const GIF_FPS = 12
const FRAME_INTERVAL_MS = Math.round(1_000 / GIF_FPS)
/** What GitHub's README column renders at on a wide screen. Wider is bytes nobody sees. */
const GIF_WIDTH = 1_200
/** §2.3's budget, per file. Exceeding it fails the run rather than quietly shipping. */
const GIF_BUDGET_BYTES = 3 * 1_024 * 1_024

function ffmpegOrDie() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    throw new Error('the agent-drives recording needs ffmpeg on PATH (brew install ffmpeg)')
  }
}

/** Width and height straight out of the PNG's IHDR — cheaper than decoding it. */
function pngSize(file) {
  const head = readFileSync(file).subarray(16, 24)
  return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) }
}

/**
 * Poll `Page.captureScreenshot` on an interval and keep the wall-clock time of
 * every frame.
 *
 * Not `Page.startScreencast`, for two reasons. It delivers frames as CDP
 * *events*, and `cdp.mjs` carries no event plumbing on purpose — it dispatches
 * replies and drops the rest, which is why it needs nothing kept in sync with a
 * protocol version. And a screencast only emits when the compositor produces a
 * frame, so a deliberately motionless beat — the suspended `ask`, the most
 * important second in the file — emits nothing and has to be reconstructed from
 * timestamps anyway. Polling has to do that for jitter regardless, so it may as
 * well be the whole mechanism. See `design/2026-08-29-the-hero-image-moves.md`
 * §2.2.
 *
 * `clip.scale` does the downscale at the shutter rather than in ffmpeg. The clip
 * is in CSS pixels but the scale multiplies the *device* pixels on top of the
 * display's ratio, so at dpr 2 a scale of 1 is the 2880px wide frame the stills
 * are captured at, and the divisor has to carry the ratio as well. Measured, not
 * assumed: the first version divided by `innerWidth` alone and wrote 2400px
 * frames, which is why the width is asserted rather than trusted.
 */
class Recorder {
  #cdp
  #dir
  #clip
  #frames = []
  #stopped = false
  #loop = null

  constructor(cdp, dir, clip) {
    this.#cdp = cdp
    this.#dir = dir
    this.#clip = clip
  }

  static async open(cdp, dir) {
    const box = await cdp.evaluate(
      `JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })`,
    )
    const { w, h, dpr } = JSON.parse(String(box))
    if (!(w > 0 && h > 0 && dpr > 0)) throw new Error(`the window reported no size: ${String(box)}`)
    return new Recorder(cdp, dir, { x: 0, y: 0, width: w, height: h, scale: GIF_WIDTH / (w * dpr) })
  }

  start() {
    this.#loop = this.#run()
  }

  async #run() {
    while (!this.#stopped) {
      const at = Date.now()
      let shot = null
      try {
        shot = await this.#cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: this.#clip,
          captureBeyondViewport: false,
        })
      } catch {
        // The app went away mid-recording. Whatever was captured before that is
        // still a truthful prefix; `stop` reports the count and the caller's own
        // assertions decide whether it was enough.
        break
      }
      const file = join(this.#dir, `f${String(this.#frames.length).padStart(5, '0')}.png`)
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      this.#frames.push({ file, at })
      const rest = FRAME_INTERVAL_MS - (Date.now() - at)
      if (rest > 0) await delay(rest)
    }
  }

  async stop() {
    this.#stopped = true
    await this.#loop
    return this.#frames
  }
}

/**
 * Frames → GIF, in ffmpeg's two passes.
 *
 * The concat list carries each frame's *real* duration, so a capture that took
 * longer than the interval stretches the picture instead of silently speeding
 * the recording up. `fps=` then resamples that to a constant rate, which is what
 * a GIF's per-frame delay can actually express.
 *
 * `palettegen=stats_mode=diff` weights the 256 entries towards the pixels that
 * move; on a screen recording the static background would otherwise take the
 * whole palette. `diff_mode=rectangle` lets each frame carry only its changed
 * rectangle — nearly all of the compression here. `dither=bayer` because an
 * ordered dither is stable frame to frame, where error diffusion re-scatters
 * itself every frame and turns a motionless background into crawling noise that
 * defeats the rectangle. §2.3.
 */
/**
 * How long a motionless stretch is allowed to last in the finished GIF.
 *
 * A real turn is mostly waiting: measured on the first good take, 49 of its 55
 * seconds were frozen, in stretches of 14.2s and 11.6s while the model thought.
 * A hero nobody watches to the end is not a hero, and 55 seconds of autoplaying
 * loop is worse than that — it is 55 seconds of bandwidth spent on a still.
 *
 * So the waits are truncated and nothing else is. Every motion in the file plays
 * at the speed it happened; only the gaps between motions are shortened, and the
 * caption says so. This is deliberately not a uniform speed-up: a 3x recording
 * makes the streaming text unreadable and misrepresents how fast the *window*
 * responds, which is the one thing the picture is measuring.
 */
const IDLE_CAP_S = 1.2

/**
 * The motionless spans in a recording, as ffmpeg's own `freezedetect` reports
 * them — asked rather than guessed.
 *
 * Comparing the frames here would mean decoding PNGs to tell "nothing happened"
 * from "the caret blinked and an elapsed-ms counter ticked", which is exactly
 * the judgement `freezedetect` already encodes as a noise floor.
 */
function freezeSpans(list) {
  const run = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `freezedetect=n=-55dB:d=${String(IDLE_CAP_S)}`,
      '-map',
      '0:v',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  )
  const spans = []
  for (const line of (run.stderr ?? '').split('\n')) {
    const start = /freeze_start:\s*([\d.]+)/.exec(line)
    if (start?.[1] !== undefined) spans.push({ start: Number(start[1]), end: Infinity })
    const dur = /freeze_duration:\s*([\d.]+)/.exec(line)
    const last = spans.at(-1)
    if (dur?.[1] !== undefined && last) last.end = last.start + Number(dur[1])
  }
  return spans
}

/**
 * Drop the tail of every motionless stretch, keeping `IDLE_CAP_S` of it.
 *
 * The first and last frames are never dropped: the last one is also written out
 * as the reduced-motion still, and a GIF whose final frame is not that still
 * would make the two disagree.
 */
function trimIdle(frames, spans) {
  const all = frames.map((_, i) => i)
  if (spans.length === 0) return all
  const t0 = frames[0].at
  return all.filter((i) => {
    if (i === 0 || i === frames.length - 1) return true
    const at = (frames[i].at - t0) / 1_000
    return !spans.some((s) => at > s.start + IDLE_CAP_S && at < s.end)
  })
}

function encodeGif(frames, outFile, dir, verbose) {
  /** Each frame's own duration: the gap to the frame that actually followed it. */
  const durations = frames.map((frame, i) => {
    const next = frames[i + 1]?.at ?? frame.at + FRAME_INTERVAL_MS
    return Math.max(0.01, (next - frame.at) / 1_000)
  })
  const list = join(dir, 'frames.txt')

  const write = (keep) => {
    const lines = []
    for (const i of keep) lines.push(`file '${frames[i].file}'`, `duration ${durations[i].toFixed(3)}`)
    // The concat demuxer ignores the last entry's duration unless the file is
    // repeated, which drops the final frame to a single tick.
    lines.push(`file '${frames[keep.at(-1)].file}'`)
    writeFileSync(list, `${lines.join('\n')}\n`)
  }

  const all = frames.map((_, i) => i)
  write(all)

  /*
   * One pass to find the motionless stretches, then the list is rebuilt without
   * their tails. The durations carried into the second list are the frames' own,
   * so everything that survives plays at the speed it was recorded at — what is
   * cut is the dead air between motions, never a motion.
   */
  const kept = trimIdle(frames, freezeSpans(list))
  const shown = kept.reduce((sum, k) => sum + durations[k], 0)
  if (kept.length < all.length) {
    write(kept)
    console.log(
      `  trimmed ${String(all.length - kept.length)} idle frame(s): ` +
        `${((frames.at(-1).at - frames[0].at) / 1_000).toFixed(1)}s recorded, ${shown.toFixed(1)}s shown`,
    )
  }

  const palette = join(dir, 'palette.png')
  const quiet = verbose ? [] : ['-loglevel', 'error']
  execFileSync(
    'ffmpeg',
    [
      ...quiet,
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `fps=${String(GIF_FPS)},palettegen=stats_mode=diff`,
      palette,
    ],
    { stdio: verbose ? 'inherit' : ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(
    'ffmpeg',
    [
      ...quiet,
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-i',
      palette,
      '-lavfi',
      `fps=${String(GIF_FPS)}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop',
      '0',
      outFile,
    ],
    { stdio: verbose ? 'inherit' : ['ignore', 'ignore', 'inherit'] },
  )
  return { bytes: statSync(outFile).size, shown }
}

/** Resolve once the grid has rendered rows, or the deadline passes. */
async function waitForRows(cdp, atLeast = 5, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await cdp.evaluate(`document.querySelectorAll('.grid-row').length`).catch(() => 0)
    if (typeof n === 'number' && n >= atLeast) return n
    await delay(250)
  }
  return 0
}

/**
 * Wheel the grid down.
 *
 * The listener is on `.grid-wrap`, not on the scroller: React registers wheel as
 * passive, so `DataGrid` attaches it by hand one level up where the scrollbar and
 * the overlay are siblings (`DataGrid.tsx` §"wheel must be attached by hand").
 * Dispatching at the scroller therefore hits nothing.
 */
async function wheelDown(cdp, ticks, deltaPx = 3_000) {
  return await cdp.evaluate(`(() => {
    const wrap = document.querySelector('.grid-wrap')
    if (!wrap) return 'no .grid-wrap'
    for (let i = 0; i < ${String(ticks)}; i += 1) {
      wrap.dispatchEvent(new WheelEvent('wheel', { deltaY: ${String(deltaPx)}, bubbles: true, cancelable: true }))
    }
    return 'ok'
  })()`)
}

/**
 * Put the horizontal axis back at column one.
 *
 * A wheel burst carries a little deltaX with it, and the row-number gutter is
 * `sticky left-0` inside the horizontal scroller — so a scrolled-right grid
 * clips the row numbers, which is what the second attempt at the million-row
 * shot captured: `6000` where the row is 60001. The gutter is sized for six
 * digits deliberately (`styles.css` — 48px fits 39.74px of SF Mono at 11px),
 * so this is the shot's error to fix, not the app's.
 */
async function resetHorizontal(cdp) {
  return await cdp.evaluate(`(() => {
    const el = document.querySelector('.grid-scroll')
    if (!el) return 'no .grid-scroll'
    el.scrollLeft = 0
    return el.scrollLeft
  })()`)
}

/**
 * Measure the row-number gutter against what `styles.css` says it fits.
 *
 * `--spacing-gutter` is 48px with the arithmetic written next to it: 48 − 7 − 1
 * = 40px of content, and SF Mono at `--text-micro` advances 6.6226px, so six
 * digits (39.74px) fit and a seventh does not. This reports what the running app
 * actually does, so a clipped row number in a screenshot can be blamed on the
 * right thing rather than guessed at.
 */
async function gutterProbe(cdp) {
  return await cdp.evaluate(`(() => {
    const el = document.querySelector('.grid-rownum')
    if (!el) return { error: 'no .grid-rownum' }
    const cs = getComputedStyle(el)
    const token = cs.getPropertyValue('--spacing-gutter').trim()
    return {
      rowNumber: (el.textContent ?? '').trim(),
      digits: (el.textContent ?? '').trim().length,
      width: cs.width,
      token,
      honoursToken: cs.width === token,
      clipped: el.scrollWidth > el.clientWidth,
    }
  })()`)
}

/**
 * Every CSS rule that actually contributes a width to the row-number gutter,
 * asked of the engine rather than inferred.
 *
 * `getComputedStyle` says what won; this says who was in the running and from
 * which stylesheet, which is the difference between "the gutter is 24px" and
 * knowing why.
 */
async function matchedWidthRules(cdp) {
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '.grid-rownum',
    })
    if (!nodeId) return ['no .grid-rownum node']
    const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
    const out = []
    for (const entry of matched.matchedCSSRules ?? []) {
      const props = (entry.rule.style?.cssProperties ?? []).filter((p) =>
        /^(width|min-width|max-width|inline-size)$/.test(p.name),
      )
      if (props.length > 0) {
        out.push(
          `${entry.rule.selectorList?.text ?? '?'} { ${props
            .map((p) => `${p.name}: ${p.value}`)
            .join('; ')} } [${entry.rule.origin}]`,
        )
      }
    }
    return out.length > 0 ? out : ['no rule sets width on this element']
  } catch (error) {
    return [`probe failed: ${String(error?.message ?? error)}`]
  }
}

/**
 * What the workspace says about every live result — rows and status.
 *
 * Asked over MCP rather than scraped out of the DOM because `read_workspace`
 * reports exactly this and cannot drift from a class name. It is also the honest
 * check on the million-row shot: the picture is only worth publishing if the
 * number under the grid is the number in the fixture.
 */
async function resultSummary(client) {
  const { result } = await call(client, 'read_workspace', {}, 'read_workspace')
  const seen = []
  for (const block of dataBlocks(result)) {
    for (const obj of walk(block)) {
      if (typeof obj.rows === 'number' && typeof obj.status === 'string') {
        seen.push(`${String(obj.rows)} rows · ${obj.status}`)
      }
    }
  }
  return seen.join(' | ')
}

/* ------------------------------------------------------------------ */
/* Shots                                                               */
/* ------------------------------------------------------------------ */

/**
 * Each shot opens its views through `open_view`, then declares the arrangement
 * with one `set_layout`.
 *
 * Opening separately rather than inline in the tree is not styling: `set_layout`
 * calls the same `openView` helper but does **not** forward `run`
 * (`bus/handlers/layout.ts` — `{ panelId, replace, activate, focus }`, no `run`),
 * so a query opened inside a tree arrives unexecuted. The first attempt at these
 * screenshots showed exactly that: an editor with a statement in it reading
 * "0 rows · Idle".
 */
/** The SQL `agent-asks` puts on screen, so the `ask` card's day/week numbers are
 *  grounded by the grid sitting next to them. */
const ROLLUP_SQL =
  "SELECT strftime('%Y-W%W', occurred_at) AS week,\n" +
  '       COUNT(*)                        AS events,\n' +
  '       ROUND(AVG(duration_ms))         AS avg_ms\n' +
  'FROM events\n' +
  'GROUP BY week\n' +
  'ORDER BY week DESC;'

/**
 * The README's hero: a real Claude Code turn, recorded as it happens.
 *
 * The stills answer "what does it look like". This answers the only question
 * that distinguishes the project — *who arranged that window* — and a still
 * cannot, because a window an agent tiled and a window a person dragged into
 * shape are the same pixels.
 *
 * Neither could the first cut, which is worth knowing before this is simplified
 * back into it. That version issued the tool calls from this script and recorded
 * the window obeying them: true in every frame, and still no evidence, because a
 * viewer cannot tell an agent from a fast mouse. What closes the gap is the chat
 * panel itself — it renders the agent's tool calls in plain language as they
 * land and marks peek's own as acting on this window (`chat/toolCalls.ts`), so
 * the transcript is a running caption for the motion in the other panes, written
 * by the product rather than by a caption track. See
 * `design/2026-08-29-the-hero-image-moves.md` §1.2 and §3.
 *
 * The price is that this is **one take**, not a reproducible artifact: the model
 * chooses its own wording, tools and order, which is exactly why the recording is
 * evidence and exactly why it cannot be pinned. What is pinned is the scene, the
 * prompt, and the assertions below.
 *
 * It spends tokens, against whatever Claude Code login exists on this machine —
 * the same deal `verify-chat-security.mjs` makes, and for the same reason: the
 * thing being photographed is the real agent.
 */

/**
 * The one sentence the hero asks for. Committed so the recording can be re-made
 * and so a reader can see exactly what was asked.
 *
 * It names no tool. Asking for an outcome and letting the agent choose the route
 * is the whole point — a prompt that dictated `open_view` then `set_layout` would
 * be the first cut again, wearing a conversation as a costume.
 */
const AGENT_PROMPT =
  'Open the customers table, then work out how many events there are per week, ' +
  'and put the two side by side so I can compare them.'

/**
 * The permission mode the recorded conversation starts in.
 *
 * The panel ships on "Ask every time" and that is the right default: every tool
 * call stops and waits for a person. It is the wrong *recording* — the hero would
 * be somebody clicking Allow five times, which is the opposite of what it is
 * there to show. "Let the agent judge" hands the approval to the agent's own
 * classifier and still reaches nothing beyond peek's own tools, and the panel
 * header says which mode the conversation is on for the whole recording. The two
 * modes below it in the list carry a warning triangle and neither is used here.
 */
const AGENT_MODE = 'auto'

/** A turn with four or five tool calls in it, with room for a slow one. */
const TURN_TIMEOUT_MS = 300_000

/** `read_chat`'s one-line brief for a conversation, parsed for the two facts the recording needs. */
async function chatState(client, viewId) {
  const { text } = await call(client, 'read_chat', { viewId }, 'read_chat')
  return {
    text,
    streaming: /a turn is running/.test(text),
    blocked: /BLOCKED:/.test(text),
    messages: Number(/(\d+) message\(s\)/.exec(text)?.[1] ?? '0'),
  }
}

/**
 * Wait for the agent's turn to finish.
 *
 * Two guards rather than one. `streaming` alone is not enough — it is still
 * false in the moment between `send_chat` returning and the agent starting, and
 * a naive poll reads that as "already done" and stops the recording on an empty
 * transcript. So the turn is only finished once it has also produced a reply.
 *
 * A pending permission prompt fails the run instead of waiting it out: the
 * conversation is set to a mode that should not produce one, and a window that
 * has quietly stopped is the one thing this recording must never show.
 */
async function waitForTurn(client, viewId, verbose) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let sawStreaming = false
  while (Date.now() < deadline) {
    const state = await chatState(client, viewId)
    if (state.blocked) throw new Error(`the agent is blocked on a permission prompt:\n${state.text}`)
    if (state.streaming) sawStreaming = true
    else if (sawStreaming && state.messages >= 2) return state
    if (verbose) console.log(`    [turn] ${state.text.trim().split('\n').pop()}`)
    await delay(1_000)
  }
  throw new Error(`the turn did not finish within ${String(TURN_TIMEOUT_MS / 1_000)}s`)
}

/**
 * The tool calls the agent made, read off the transcript it drew.
 *
 * Read from the DOM rather than from a tool, because there is no tool that
 * reports it — `read_chat` deliberately never returns the messages, on the
 * grounds that the conversation is for the person watching. This is what the
 * person watching sees, which is the right thing to assert on anyway.
 */
async function transcriptTools(cdp) {
  const raw = await cdp
    .evaluate(
      `JSON.stringify([...document.querySelectorAll('.rounded-control > button')]
         .map((b) => b.textContent.trim().replace(/\\s+/g, ' '))
         .filter(Boolean))`,
    )
    .catch(() => '[]')
  try {
    return JSON.parse(String(raw))
  } catch {
    return []
  }
}

async function recordAgentDrives({ client, cdp, connId, nodes, theme, verbose }) {
  const dir = mkdtempSync(join(tmpdir(), 'peek-shot-rec-'))
  const recorder = await Recorder.open(cdp, dir)

  try {
    /*
     * The scene, set before the shutter opens: a namespace tree on the left and
     * an empty conversation on the right, which is what the window looks like
     * the moment before somebody asks it for something. Everything that appears
     * after this is the agent's doing, and that is the claim the picture makes.
     */
    const treeId = await openView(client, { kind: 'tree', connId, expanded: containerIds(nodes) })
    const chatId = await openView(client, { kind: 'chat', connId, title: 'Claude Code' })
    await call(
      client,
      'set_layout',
      {
        tree: {
          type: 'split',
          dir: 'row',
          ratio: [32, 68],
          children: [
            { type: 'panel', viewIds: [treeId], activeViewId: treeId },
            { type: 'panel', viewIds: [chatId], activeViewId: chatId },
          ],
        },
        unplaced: 'close',
        focusViewId: chatId,
      },
      'set_layout/scene',
    )

    recorder.start()
    await delay(1_200)

    console.log(`  · send_chat: ${AGENT_PROMPT}`)
    await call(client, 'send_chat', { viewId: chatId, text: AGENT_PROMPT }, 'send_chat')

    const finished = await waitForTurn(client, chatId, verbose)
    console.log(`  · turn finished — ${finished.text.trim().split('\n').pop()}`)
    /*
     * Long enough for two things: to read the last thing the agent said, and for
     * the "the agent has replied" toast to expire.
     *
     * The toast is real UI and it is right to fire — but it lands over the
     * composer, repeats the reply it is announcing, and the frame it lands on is
     * also the still that stands in for the whole recording under
     * `prefers-reduced-motion`. `notifyStore.AUTO_DISMISS_MS` is 4500, so the
     * wait is set past it. What this adds is motionless and the idle trim takes
     * it back out.
     */
    await delay(6_500)

    const frames = await recorder.stop()

    const tools = await transcriptTools(cdp)
    console.log(
      `  · the agent called: ${tools.length > 0 ? tools.join(' | ') : '(nothing the transcript shows)'}`,
    )
    if (tools.length < 3) {
      throw new Error(
        `the transcript shows ${String(tools.length)} tool call(s); the hero needs a turn that works`,
      )
    }
    const { text: workspace } = await call(client, 'read_workspace', {}, 'read_workspace')
    if (!/result/i.test(workspace)) throw new Error('the agent finished without leaving a result on screen')

    if (frames.length < 60) throw new Error(`only ${String(frames.length)} frames were captured`)
    const { width, height } = pngSize(frames[0].file)
    if (Math.abs(width - GIF_WIDTH) > 2) {
      throw new Error(`frames came out ${String(width)}px wide, expected ${String(GIF_WIDTH)}`)
    }

    const gif = join(OUT_DIR, `agent-drives-${theme}.gif`)
    const still = join(OUT_DIR, `agent-drives-${theme}.png`)
    // The reduced-motion still is the recording's *last* frame rather than a
    // fresh capture: a reader who asked their system to stop things moving gets
    // the frame the recording ends on, to the pixel. §2.4.
    copyFileSync(frames.at(-1).file, still)
    const { bytes, shown } = encodeGif(frames, gif, dir, verbose)
    console.log(
      `  wrote ${gif} (${String(frames.length)} frames captured, ${shown.toFixed(1)}s shown, ` +
        `${String(width)}x${String(height)}, ${String(Math.round(bytes / 1_024))}KB)`,
    )
    console.log(`  wrote ${still} (final frame, for prefers-reduced-motion)`)
    if (bytes > GIF_BUDGET_BYTES) {
      throw new Error(
        `${gif} is ${String(Math.round(bytes / 1_024))}KB, over the ${String(GIF_BUDGET_BYTES / 1_024)}KB budget — ` +
          'the levers, in order: frame rate, dwell times, width (§2.3)',
      )
    }
  } finally {
    await recorder.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function shotOverview({ client, cdp, connId, nodes, theme }) {
  const treeId = await openView(client, { kind: 'tree', connId, expanded: containerIds(nodes) })
  const tableId = await openView(client, { kind: 'table', connId, ref: refFor(nodes, 'customers') }, 8_000)
  const queryId = await openView(
    client,
    {
      kind: 'query',
      connId,
      title: 'Revenue by plan',
      text:
        'SELECT c.plan,\n' +
        '       COUNT(DISTINCT c.id)       AS customers,\n' +
        '       COUNT(o.id)                AS orders,\n' +
        '       ROUND(SUM(o.total_usd), 2) AS revenue_usd\n' +
        'FROM customers c\n' +
        'JOIN orders o ON o.customer_id = c.id\n' +
        "WHERE o.status = 'paid'\n" +
        'GROUP BY c.plan\n' +
        'ORDER BY revenue_usd DESC;',
      run: true,
    },
    15_000,
  )

  await call(
    client,
    'set_layout',
    {
      tree: {
        type: 'split',
        dir: 'row',
        ratio: [21, 79],
        children: [
          { type: 'panel', viewIds: [treeId], activeViewId: treeId },
          {
            type: 'split',
            dir: 'col',
            ratio: [54, 46],
            children: [
              { type: 'panel', viewIds: [tableId], activeViewId: tableId },
              { type: 'panel', viewIds: [queryId], activeViewId: queryId },
            ],
          },
        ],
      },
      unplaced: 'close',
      focusViewId: tableId,
    },
    'set_layout/overview',
  )

  if ((await waitForRows(cdp)) === 0) throw new Error('the overview grid never rendered a row')
  await delay(SETTLE_MS)
  return { theme }
}

/**
 * The million-row shot has to be a **query** view.
 *
 * A `table` view paginates — the first attempt captured "200 rows · Done" with a
 * `1–200` pager, which is the opposite of the claim the picture is there to
 * support. `run_query` streams the whole result into the grid, which is the path
 * `bench-scroll.mjs` measures and the one the hand-written virtual scrolling
 * exists for.
 */
async function shotMillionRows({ client, cdp, connId, nodes, eventRows }) {
  const treeId = await openView(client, { kind: 'tree', connId, expanded: containerIds(nodes) })
  const queryId = await openView(
    client,
    {
      kind: 'query',
      connId,
      title: 'events',
      text: 'SELECT id, customer_id, kind, duration_ms, payload, occurred_at\nFROM events;',
      run: true,
    },
    0,
  )

  await call(
    client,
    'set_layout',
    {
      tree: {
        type: 'split',
        dir: 'row',
        ratio: [21, 79],
        children: [
          { type: 'panel', viewIds: [treeId], activeViewId: treeId },
          { type: 'panel', viewIds: [queryId], activeViewId: queryId },
        ],
      },
      unplaced: 'close',
      focusViewId: queryId,
    },
    'set_layout/million-rows',
  )

  /* --- drain the stream ------------------------------------------------
   *
   * Ack backpressure holds the stream as soon as delivered rows run far enough
   * ahead of the viewport, so a million-row query parks at ~200k and reports
   * `running` until somebody scrolls — README, Known limitations, first entry.
   * The first full run captured exactly that: "261000 rows · running" under a
   * picture captioned one million. So scroll until the workspace says `done`
   * rather than for a fixed number of bursts — and if the deadline arrives
   * first, stop here rather than photographing a partial stream. */
  if ((await waitForRows(cdp)) === 0) throw new Error('the million-row grid never rendered a row')
  const drainDeadline = Date.now() + 180_000
  let settled = ''
  while (Date.now() < drainDeadline) {
    const wheeled = await wheelDown(cdp, 80)
    if (wheeled !== 'ok') throw new Error(`could not wheel the grid: ${String(wheeled)}`)
    await delay(500)
    settled = await resultSummary(client)
    if (settled !== '' && /\brunning\b/.test(settled) === false) break
  }
  if (settled === '' || /\brunning\b/.test(settled)) {
    throw new Error(`the stream never drained — the workspace says: ${settled || '(nothing)'}`)
  }
  console.log(`  drained: ${settled}`)

  /* --- stay where the stream ended ------------------------------------
   *
   * An earlier version scrolled back up to keep the row numbers in the
   * four-digit range, and that was worse than the problem it dodged: draining a
   * million rows evicts the early chunks to stay inside the memory budget (the
   * grid says so, "84 chunks evicted"), their cursor is closed, and the shot
   * came back as a grid full of `...` under a "Rows dropped from the cache"
   * banner. The loaded window is where the stream ended, so that is where the
   * shutter goes. */
  const scrollLeft = await resetHorizontal(cdp)
  if (typeof scrollLeft !== 'number') {
    throw new Error(`could not reset the horizontal scroll: ${String(scrollLeft)}`)
  }
  await delay(SETTLE_MS)
  console.log(`  gutter: ${JSON.stringify(await gutterProbe(cdp))}`)
  console.log(`  width rules: ${JSON.stringify(await matchedWidthRules(cdp))}`)

  /*
   * The caption on this picture is a number, so the number is checked rather
   * than printed for somebody to check. `read_workspace` is asked because it is
   * what the grid's own status bar reports, which is the string the README's alt
   * text then quotes.
   */
  const status = await resultSummary(client)
  if (!status.includes(`${String(eventRows)} rows`)) {
    throw new Error(
      `the workspace says ${status || '(nothing)'}, but the fixture has ${String(eventRows)} rows`,
    )
  }
  console.log(`  workspace says: ${status} — fixture has ${String(eventRows)} rows`)
  return { status }
}

/**
 * The third shot: an agent that stopped to ask.
 *
 * This is the one interaction no other database GUI has, and the first two shots
 * do not contain it — they show a window an MCP client arranged, which is half
 * the claim. The other half is that the person and the agent are *in the same
 * window*, and that the agent can reach them.
 *
 * `ask` is the honest way to photograph it. It is the only tool in peek that
 * suspends: it puts a question on screen and does not return until a human
 * clicks, and for an agent running outside peek — a Claude Code in a terminal —
 * it is the only way to reach the person sitting in front of the window at all.
 * This script *is* such a client, so the question in the picture is not staged:
 * it is a real `ask` call, suspended, waiting on a real click that the next few
 * lines then perform.
 *
 * No agent backend is started. `chat.ask` runs through `QuestionBroker` and
 * never touches ACP, so this needs no API key, no Claude Code binary and no
 * token spend — which also means the shot stays reproducible for anyone who
 * clones the repository.
 */
async function shotAgentAsks({ client, cdp, connId, nodes, rollup }) {
  const treeId = await openView(client, { kind: 'tree', connId, expanded: containerIds(nodes) })
  const queryId = await openView(
    client,
    {
      kind: 'query',
      connId,
      title: 'Weekly rollup',
      text: ROLLUP_SQL,
      run: true,
    },
    20_000,
  )
  const chatId = await openView(client, { kind: 'chat', connId, title: 'Claude Code' })

  await call(
    client,
    'set_layout',
    {
      tree: {
        type: 'split',
        dir: 'row',
        ratio: [18, 44, 38],
        children: [
          { type: 'panel', viewIds: [treeId], activeViewId: treeId },
          { type: 'panel', viewIds: [queryId], activeViewId: queryId },
          { type: 'panel', viewIds: [chatId], activeViewId: chatId },
        ],
      },
      unplaced: 'close',
      focusViewId: chatId,
    },
    'set_layout/agent',
  )

  /*
   * Every number in the card comes from `rollupBuckets`, because the grid to its
   * left is in the same picture. Written by hand they said "four years", "1,461"
   * and "209" against a fixture that spans 4.75 years and answers 1,737 and 252 —
   * and the grid's status bar, two inches away in the published PNG, said 252.
   *
   * Deliberately not awaited: `ask` is the one tool that does not return until a
   * person acts, and a suspended call is exactly what the picture is of.
   */
  const buckets = (n) => n.toLocaleString('en-US')
  const pending = client
    .callTool({
      name: 'ask',
      arguments: {
        viewId: chatId,
        header: 'Aggregation',
        question: `events spans ${rollup.firstYear} to ${rollup.lastYear} — roll it up by day or by week?`,
        options: [
          {
            optionId: 'day',
            label: 'By day',
            description: `${buckets(rollup.days)} buckets. Every spike visible, dense to chart.`,
          },
          {
            optionId: 'week',
            label: 'By week',
            description: `${buckets(rollup.weeks)} buckets. Reads at a glance, hides sub-week spikes.`,
          },
        ],
      },
    })
    .catch(() => null)

  const asked = await waitForQuestion(cdp)
  if (!asked) throw new Error('the question never rendered in the chat panel')
  await delay(SETTLE_MS)
  return { pending }
}

/** Resolve once the question card is on screen. */
async function waitForQuestion(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const there = await cdp
      .evaluate(`!!document.querySelector('[aria-live="assertive"] button')`)
      .catch(() => false)
    if (there === true) return true
    await delay(250)
  }
  return false
}

/**
 * Answer it, so the suspended tool call returns and the app can be shut down.
 *
 * Through the UI rather than through a command, because there is no other way:
 * `chat.answer` refuses `source: 'agent'` on purpose — an agent answering its
 * own question manufactures consent. Only a click counts, so the shot ends with
 * one.
 */
async function answerQuestion(cdp) {
  return await cdp.evaluate(`(() => {
    const button = document.querySelector('[aria-live="assertive"] button')
    if (!button) return 'no question on screen'
    button.click()
    return 'answered'
  })()`)
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= argv.length) return fallback
  return argv[i + 1]
}

async function runTheme({ theme, fixture, eventRows, rollup, verbose, wants }) {
  console.log(`\n=== ${theme} ===`)
  const configDir = mkdtempSync(join(tmpdir(), 'peek-shot-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-shot-udd-'))
  /*
   * Written before launch so the first frame is already in the right theme;
   * toggling afterwards would have to be waited out and could be caught mid-swap.
   *
   * `agent.permissionMode` has to be here too, rather than set later through
   * `control_chat`, because a conversation's session is created lazily — it does
   * not exist until the first message is sent, so there is nothing for
   * `set_mode` to set, and the session is then born on the settings default
   * anyway. Measured: the first live take set the mode through `control_chat`
   * before `send_chat`, and the agent blocked on a permission prompt for
   * `read_workspace` with the conversation still reading `mode default`. See
   * `design/2026-08-13-permission-mode-takes-effect.md` §1.
   */
  const settings = { theme }
  if (wants('agent-drives')) settings.agent = { permissionMode: AGENT_MODE }
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2))

  const mcpPort = await pickFreePort()
  const cdpPort = await pickFreePort()
  const child = launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose })
  let client = null
  let cdp = null

  try {
    const endpoint = await waitForEndpoint(configDir, child)
    client = new Client({ name: 'peek-screenshot', version: '1.0.0' }, { capabilities: {} })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }),
    )

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitForFirstPaint()
    await collapseChatRail(cdp)

    const { text: connectText } = await call(
      client,
      'connect',
      { config: { driverId: 'sqlite', file: fixture, label: 'acme-analytics' } },
      'connect',
    )
    const connId = /Connection\s+(\S+)\s+is\s+ready/.exec(connectText)?.[1]
    if (!connId) throw new Error(`could not read a connId out of:\n${connectText}`)
    const nodes = await namespaceNodes(client, connId)

    if (wants('agent-drives')) {
      console.log('- agent-drives: a real Claude Code turn, recorded live')
      await recordAgentDrives({ client, cdp, connId, nodes, theme, verbose })
    }

    if (wants('overview')) {
      console.log('- overview: namespace tree · table · a query that has run')
      await shotOverview({ client, cdp, connId, nodes, theme })
      await capture(cdp, join(OUT_DIR, `overview-${theme}.png`))
    }

    if (wants('million-rows')) {
      console.log('- million-rows: one streamed result, scrolled deep')
      await shotMillionRows({ client, cdp, connId, nodes, eventRows })
      await capture(cdp, join(OUT_DIR, `million-rows-${theme}.png`))
    }

    if (wants('agent-asks')) {
      console.log('- agent-asks: a suspended `ask`, waiting on a person')
      const { pending } = await shotAgentAsks({ client, cdp, connId, nodes, rollup })
      await capture(cdp, join(OUT_DIR, `agent-asks-${theme}.png`))
      console.log(`  answered: ${await answerQuestion(cdp)}`)
      await pending
    }
  } finally {
    cdp?.close()
    try {
      await client?.close()
    } catch {
      /* the transport may already be gone */
    }
    child.kill('SIGTERM')
    await delay(500)
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(configDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

/*
 * All three arguments are checked before anything is built or launched.
 *
 * Each of them used to fail open into something that looks like a successful
 * run: `--only overvew` matched no shot and exited 0 having written nothing,
 * `--rows abc` gave `Number('abc')` → NaN and cached an empty database as
 * `demo-v2-NaN.sqlite` for every later run to reuse, and `--theme foo` was
 * rejected by the app's own settings schema so the default theme was captured
 * and written to `overview-foo.png` while `overview-dark.png` went stale. Two of
 * those three survive looking at the pictures.
 */
function parseArgs(argv) {
  const rowsArg = argOf(argv, 'rows', String(DEFAULT_EVENT_ROWS))
  const eventRows = Number(rowsArg)
  if (!Number.isInteger(eventRows) || eventRows < 1) {
    throw new Error(`--rows must be a positive integer, got ${String(rowsArg)}`)
  }

  const themeArg = argOf(argv, 'theme', null)
  if (themeArg !== null && !THEMES.includes(themeArg)) {
    throw new Error(`--theme must be one of ${THEMES.join(', ')}, got ${themeArg}`)
  }

  /*
   * `--only` exists because iterating on one shot otherwise costs a full
   * million-row drain: the picture takes seconds to compose and minutes to
   * arrive at. Comma-separated; omitted means all three.
   */
  const onlyArg = argOf(argv, 'only', null)
  const only = onlyArg ? new Set(onlyArg.split(',').map((n) => n.trim())) : null
  const unknown = only ? [...only].filter((name) => !SHOTS.includes(name)) : []
  if (unknown.length > 0) {
    throw new Error(`--only names no shot: ${unknown.join(', ')} — the three are ${SHOTS.join(', ')}`)
  }

  return {
    eventRows,
    themes: themeArg ? [themeArg] : THEMES,
    only,
    verbose: argv.includes('--verbose'),
  }
}

async function main() {
  const { eventRows, themes, only, verbose } = parseArgs(process.argv.slice(2))
  const wants = (name) => only === null || only.has(name)
  if (only) console.log(`only: ${[...only].join(', ')}`)

  // Before anything is built or launched: a missing ffmpeg would otherwise
  // surface minutes later, after the recording it cannot encode.
  if (wants('agent-drives')) ffmpegOrDie()

  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`fixture: ${String(eventRows)} event rows`)
  const fixture = await ensureFixture(eventRows, true)
  // Counted once rather than per theme: it is a full scan of the events table.
  const rollup = wants('agent-asks') ? await rollupBuckets(fixture) : null
  if (rollup) {
    console.log(`rollup: ${String(rollup.days)} day buckets, ${String(rollup.weeks)} week buckets`)
  }

  for (const theme of themes) {
    await runTheme({ theme, fixture, eventRows, rollup, verbose, wants })
  }
  console.log(`\ndone — ${OUT_DIR}`)
}

await main()
