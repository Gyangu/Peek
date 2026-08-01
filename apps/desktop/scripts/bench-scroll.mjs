#!/usr/bin/env node
/**
 * Scroll benchmark: the numbers in README's performance table, measured.
 *
 * Those numbers ("p95 frame 9.3ms, zero frames over 16.7ms", "constant at ~240
 * DOM nodes", "run_query over 1,000,000 rows: 1569ms") came from a hand-run M1
 * acceptance session and the README says outright that there is no script to
 * reproduce them. This is that script.
 *
 * ## What it does
 *
 *   1. generates a SQLite file with `--rows` rows (cached in the temp dir, so
 *      only the first run pays for it) — self-contained, so the benchmark needs
 *      no database server and measures the same thing on every machine;
 *   2. launches the **built** app with an isolated user-data-dir, config dir and
 *      MCP port, plus a Chromium remote-debugging port;
 *   3. drives it over its own MCP endpoint the way an AI client would: `connect`
 *      then `run_query`, timing the second one end to end;
 *   4. attaches to the renderer over CDP and scrolls the grid for `--frames`
 *      animation frames, sampling frame cadence, per-frame main-thread work, and
 *      the DOM node count of the row surface.
 *
 * ## What the numbers mean
 *
 * `frameInterval` is rAF-to-rAF wall time. It is vsync-bound, so on a healthy
 * 60Hz run its median is ~16.7ms **by construction** — it is not a measure of
 * how fast the app is, it is a measure of whether frames were *dropped*. The
 * useful figure derived from it is `droppedFrames`: intervals longer than 1.5
 * refresh periods, meaning the compositor missed at least one vsync.
 *
 * `scrollWork` is the part the application actually controls: the wheel handler,
 * VScrollDriver's two style writes, any React commit the row window triggered,
 * and the style/layout flush forced immediately afterwards. It excludes paint
 * and compositing, which belong to the browser. This is the number to watch when
 * changing the grid.
 *
 * `surfaceNodes` is the element count under `.grid-surface`, sampled every
 * frame. Its whole point is that min and max are the same number regardless of
 * `--rows` — that is the virtual-scrolling claim, stated as a measurement.
 *
 * ## Honest limitation
 *
 * The wheel events are synthesized in-page (`dispatchEvent`), not injected
 * through Chromium's input pipeline. The grid's wheel handler is a plain
 * listener on `.grid-wrap` and does not care, so everything from the handler
 * down is the real path — but the hit-testing and input-routing that a physical
 * trackpad would go through is not being measured.
 *
 * Usage:
 *   pnpm --filter @peek/desktop build
 *   node scripts/bench-scroll.mjs [--rows=N] [--frames=N] [--json] [--verbose]
 *
 * Exit code 0 = the grid rendered rows and the scroll pass completed.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The narrowest CDP client that can do the job: one WebSocket, `Runtime.evaluate`
 * with `awaitPromise`. No dependency, and nothing to keep in sync with a
 * protocol version.
 */
class Cdp {
  #ws
  #next = 1
  #pending = new Map()

  static async attach(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
        const targets = await res.json()
        // The renderer is the only `page` target the app opens; DevTools itself
        // would show up as `other`.
        const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
        if (page) return await new Cdp().#open(page.webSocketDebuggerUrl)
      } catch (error) {
        lastError = error
      }
      await delay(250)
    }
    throw new Error(`no CDP page target on port ${String(port)}: ${String(lastError?.message ?? lastError)}`)
  }

  async #open(url) {
    this.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true })
      this.#ws.addEventListener('error', () => {
        reject(new Error(`CDP websocket failed to open: ${url}`))
      }, { once: true })
    })
    this.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      const entry = this.#pending.get(msg.id)
      if (!entry) return // an event, not a reply
      this.#pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${String(msg.error.code)})`))
      else entry.resolve(msg.result)
    })
    return this
  }

  send(method, params = {}) {
    const id = this.#next++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an async expression in the page and return its resolved value. */
  async evaluate(expression, timeoutMs = 120_000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page evaluation threw: ${String(text)}`)
    }
    return result.result?.value
  }

  close() {
    try {
      this.#ws?.close()
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* The in-page scroll pass                                             */
/* ------------------------------------------------------------------ */

/** Resolve once the grid is mounted and has rendered at least one row. */
function awaitGridExpression() {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 400; i++) {
    const surface = document.querySelector('.grid-surface');
    if (surface && surface.children.length > 0) return { ok: true, rows: surface.children.length };
    await sleep(50);
  }
  return { error: 'the grid rendered no rows' };
})()`
}

/**
 * Send one key to the grid.
 *
 * `End` is what keeps the ack backpressure open. The grid is the only source of
 * the `atBottom` signal, and `atBottom` is recomputed against a `maxTop` that
 * *grows with every chunk* — so one jump to the end stops being "at the bottom"
 * the moment the next chunk lands, and main holds the stream again. Pressing it
 * on every poll is the faithful stand-in for a reader who keeps scrolling to
 * keep up, which is the only condition under which "end to end over N rows"
 * means the query rather than the pause timeout.
 */
function pressKeyExpression(key) {
  return `(() => {
  const wrap = document.querySelector('.grid-wrap');
  if (!wrap) return { error: 'the grid is not mounted' };
  wrap.focus();
  wrap.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  return { ok: true };
})()`
}

/**
 * Built as a string because it runs in the renderer, not here.
 *
 * It waits for the grid to have rows, measures an idle baseline to learn the
 * display's refresh period, then scrolls for `frames` animation frames while
 * sampling. Everything returned is a plain array or number so
 * `returnByValue` can carry it back.
 */
function scrollPassExpression({ frames, deltaPx }) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  const wrap = document.querySelector('.grid-wrap');
  const surface = document.querySelector('.grid-surface');
  if (!wrap || !surface) return { error: 'the grid is not mounted' };

  // Rows arrive by stream, so the surface is briefly empty even on a healthy run.
  for (let i = 0; i < 200 && surface.children.length === 0; i++) await sleep(50);
  if (surface.children.length === 0) return { error: 'the grid rendered no rows' };

  // Idle baseline: the refresh period, needed to say what "a dropped frame" is.
  const baseline = [];
  let prev = await nextFrame();
  for (let i = 0; i < 30; i++) { const t = await nextFrame(); baseline.push(t - prev); prev = t; }
  baseline.sort((a, b) => a - b);
  const refreshMs = baseline[Math.floor(baseline.length / 2)];

  const intervals = [];
  const work = [];
  let nodesMin = Infinity;
  let nodesMax = 0;

  prev = await nextFrame();
  for (let i = 0; i < ${String(frames)}; i++) {
    const t = await nextFrame();
    intervals.push(t - prev);
    prev = t;

    const w0 = performance.now();
    wrap.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${String(deltaPx)}, deltaMode: 0, bubbles: true, cancelable: true,
    }));
    // Force the style/layout flush the handler's writes queued, so the work
    // number covers laying the frame out and not just running the listener.
    void surface.offsetHeight;
    work.push(performance.now() - w0);

    const n = surface.getElementsByTagName('*').length;
    if (n < nodesMin) nodesMin = n;
    if (n > nodesMax) nodesMax = n;
  }

  return {
    refreshMs,
    intervals,
    work,
    nodesMin,
    nodesMax,
    rowsRendered: surface.children.length,
    documentNodes: document.getElementsByTagName('*').length,
  };
})()`
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

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

async function main() {
  const argv = process.argv.slice(2)
  const rows = intArg(argv, 'rows', DEFAULT_ROWS)
  const frames = intArg(argv, 'frames', DEFAULT_FRAMES)
  const json = argv.includes('--json')
  const verbose = argv.includes('--verbose')

  const fixture = await ensureFixture(rows, verbose || !json)

  const configDir = mkdtempSync(join(tmpdir(), 'peek-bench-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-bench-udd-'))
  const mcpPort = await pickFreePort()
  const cdpPort = await pickFreePort()

  const { child, logLines } = launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose })
  let client = null
  let cdp = null

  try {
    const endpoint = await waitForEndpoint(configDir, child)
    client = new Client({ name: 'peek-bench', version: '1.0.0' }, { capabilities: {} })
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
        arguments: { config: { driverId: 'sqlite', file: fixture, label: 'bench' } },
      }),
      30_000,
      'connect',
    )
    const connectText = textOf(connectResult)
    if (connectResult.isError === true) throw new Error(`connect failed:\n${connectText}`)
    const connId = /Connection\s+(\S+)\s+is\s+ready/.exec(connectText)?.[1]
    if (!connId) throw new Error(`could not read a connId out of:\n${connectText}`)

    /* --- run_query, and the stream it starts ---------------------------
     *
     * `waitMs: 0` on purpose. Waiting here is what makes a naive version of this
     * benchmark report nonsense: the ack backpressure holds the stream as soon
     * as the delivered rows run far enough ahead of the viewport, and with
     * nobody scrolling the result sits there until the pause idle timeout fires.
     * Measured at 1,000,000 rows that produced "60,483ms, 207,000 rows" — which
     * is the timeout, not the query.
     *
     * So: start the query, let the grid mount, jump the viewport to the bottom
     * (which is what clears the row-count gate), and only then time the stream
     * to completion. That is "end to end" for a viewer whose reader is actually
     * looking at the rows. */
    const queryStarted = Date.now()
    const queryResult = await withTimeout(
      client.callTool({
        name: 'run_query',
        arguments: {
          connId,
          text: 'SELECT * FROM bench',
          maxRows: rows,
          previewRows: 0,
          waitMs: 0,
          timeoutMs: QUERY_TIMEOUT_MS,
        },
      }),
      30_000,
      'run_query',
    )
    const queryText = textOf(queryResult)
    if (queryResult.isError === true) throw new Error(`run_query failed:\n${queryText}`)
    // The receipt nests its outcomes (`{ outcomes: [{ kind: 'result.started',
    // resultId, … }] }`), and that shape is a rendering detail — walk for the id
    // rather than pinning the path.
    const resultId = findKey(toolData(queryResult), 'resultId')
    if (typeof resultId !== 'string') throw new Error(`run_query returned no resultId:\n${queryText}`)

    cdp = await Cdp.attach(cdpPort)
    const mounted = await cdp.evaluate(awaitGridExpression())
    if (!mounted?.ok) throw new Error(`could not reach the grid: ${String(mounted?.error ?? 'no result')}`)

    const stream = await waitForResultSettled(client, cdp, resultId, QUERY_TIMEOUT_MS)
    const queryMs = Date.now() - queryStarted

    // Back to the top, so the scroll pass has the full range in front of it.
    await cdp.evaluate(pressKeyExpression('Home'))
    const pass = await cdp.evaluate(scrollPassExpression({ frames, deltaPx: WHEEL_DELTA_PX }))
    if (!pass || pass.error) throw new Error(`the scroll pass failed: ${String(pass?.error ?? 'no result')}`)

    // A dropped frame is an interval past 1.5 refresh periods: half a period of
    // slack absorbs rAF jitter, anything beyond it means a missed vsync.
    const dropThreshold = pass.refreshMs * 1.5
    const dropped = pass.intervals.filter((v) => v > dropThreshold).length

    const report = {
      rows,
      frames,
      queryMs,
      stream,
      refreshMs: pass.refreshMs,
      droppedFrames: dropped,
      droppedPct: (dropped / pass.intervals.length) * 100,
      frameInterval: summarize(pass.intervals),
      scrollWork: summarize(pass.work),
      surfaceNodes: { min: pass.nodesMin, max: pass.nodesMax },
      rowsRendered: pass.rowsRendered,
      documentNodes: pass.documentNodes,
    }

    if (json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(`\nScroll benchmark — ${rows.toLocaleString('en-US')} rows, ${String(frames)} frames`)
      console.log(
        `  run_query end to end        ${String(queryMs)}ms` +
          ` → ${stream.rows.toLocaleString('en-US')} rows, status ${stream.status}` +
          `${stream.truncated ? ' (truncated)' : ''}`,
      )
      console.log(`  display refresh period      ${ms(pass.refreshMs)}`)
      console.log(
        `  dropped frames              ${String(dropped)} / ${String(pass.intervals.length)}` +
          ` (${report.droppedPct.toFixed(1)}%, > ${ms(dropThreshold)})`,
      )
      console.log('                              median / p95 / p99 / max')
      console.log(
        `  frame interval              ${ms(report.frameInterval.median)} / ${ms(report.frameInterval.p95)}` +
          ` / ${ms(report.frameInterval.p99)} / ${ms(report.frameInterval.max)}`,
      )
      console.log(
        `  scroll work (script+layout) ${ms(report.scrollWork.median)} / ${ms(report.scrollWork.p95)}` +
          ` / ${ms(report.scrollWork.p99)} / ${ms(report.scrollWork.max)}`,
      )
      console.log(
        `  .grid-surface elements      ${String(pass.nodesMin)} min / ${String(pass.nodesMax)} max` +
          `  (${String(pass.rowsRendered)} rows in the DOM, ${String(pass.documentNodes)} in the document)`,
      )
    }
    return report
  } catch (error) {
    console.error(`bench-scroll: ${String(error?.message ?? error)}`)
    console.error('--- app log (tail) ---')
    for (const line of logLines.slice(-40)) console.error(line)
    process.exitCode = 1
  } finally {
    cdp?.close()
    if (client) await client.close().catch(() => {})
    child.kill('SIGTERM')
    const stopped = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      delay(8000).then(() => false),
    ])
    if (!stopped) child.kill('SIGKILL')
    rmSync(configDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

await main()
