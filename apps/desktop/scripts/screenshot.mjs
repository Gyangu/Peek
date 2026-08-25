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
 * Three shots, each a `set_layout` call away from the last:
 *
 *   overview      the tiled window — namespace tree, a table, a query that has run
 *   million-rows  one streamed result, drained to `done` and sitting deep in it
 *   agent-asks    an `ask` suspended mid-call, waiting on a person to click
 *
 *   node apps/desktop/scripts/screenshot.mjs                    # 3 shots x 2 themes
 *   node apps/desktop/scripts/screenshot.mjs --theme dark
 *   node apps/desktop/scripts/screenshot.mjs --only agent-asks --rows 50000
 *   node apps/desktop/scripts/screenshot.mjs --rows 200000 --verbose
 *
 * Output lands in `docs/images/`, one PNG per shot per theme. `--only` takes a
 * comma-separated list and exists because a full run drains a million rows,
 * which turns a one-line tweak to a shot into a four-minute round trip.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
/** The three shots and the two themes, in the order they are taken. */
const SHOTS = ['overview', 'million-rows', 'agent-asks']
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
      text:
        "SELECT strftime('%Y-W%W', occurred_at) AS week,\n" +
        '       COUNT(*)                        AS events,\n' +
        '       ROUND(AVG(duration_ms))         AS avg_ms\n' +
        'FROM events\n' +
        'GROUP BY week\n' +
        'ORDER BY week DESC;',
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
  // Written before launch so the first frame is already in the right theme;
  // toggling afterwards would have to be waited out and could be caught mid-swap.
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ theme }, null, 2))

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
