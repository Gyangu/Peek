#!/usr/bin/env node
/**
 * What opening one package-drawn (Tier C) view costs the host.
 *
 * The unit here is **bytes and one-shot milliseconds**, and that is a deliberate
 * change of question from the one acceptance 21 was written with.
 *
 * ## Why this does not measure per-frame work
 *
 * A package view's steady state is bounded by construction, not by budget: it is
 * handed one `structuredClone`d snapshot capped at `PACKAGE_MAX_ROWS`, it
 * subscribes to nothing, and its viewport is whatever panel it was given
 * (design 2026-08-03 §2.6bis). A "frame budget" benchmark over that would report
 * a number that cannot go red — which is worse than no benchmark, because it
 * looks like evidence.
 *
 * What genuinely has no number is the *opening*: how many bytes peek reads,
 * out of which directory, and how long the window waits for a frame that can be
 * talked to. That is what this script measures, once per open.
 *
 * ## What it reports, and where each figure comes from
 *
 * - **bytes / files** — every request an open makes is captured by auto-attaching
 *   to the frame *before* it runs (`Target.setAutoAttach` with
 *   `waitForDebuggerOnStart`) and by listening on the window's session too,
 *   because the iframe's document is announced by the parent and its
 *   subresources by the frame. Each URL is then counted **twice**: once by
 *   resolving it to the file the protocol handler would have served and
 *   stat'ing that, and once by reading the response body back out of the
 *   browser (`Network.getResponseBody`). The two are compared per file and a
 *   disagreement fails the run — `encodedDataLength` is reported beside them but
 *   never used, because a `protocol.handle` response measures 0 there. The
 *   request list also answers "from where": a URL outside the package's own
 *   `ui/` directory fails the run.
 * - **append → load / append → ready** — wall time in the *window*, over the
 *   same sequence `PackageFrame.tsx` performs: the port is posted on the
 *   iframe's `load`, `init` and `data` follow the frame's `ready`.
 * - **host main thread** — `Performance.getMetrics` on the window's own target,
 *   differenced across the open. This is the part of the open that lands on the
 *   thread the rest of peek draws on.
 * - **the frame's renderer** — the same metrics on the frame's target, reported
 *   as a cumulative figure over the documents that process served, which is the
 *   only true reading of it: every open in a view reuses one renderer. A package
 *   view is an out-of-process iframe (`peek-package://<id>` is a real origin, and
 *   Chromium puts it in its own renderer), so none of that CPU is on the
 *   window's thread.
 *
 * ## The positive control is not optional
 *
 * The echo fixture draws a fixed picture and takes a `spin` flag that rewrites
 * every node and edge endpoint each frame without changing the element count.
 * The fixture tallies those writes itself and this script divides by the frames
 * it drew, so the "attributes per frame" line is a measurement and not a label.
 * Both states — idle and spinning — are read with the same meter, and a run
 * whose meter cannot separate them fails: every "the frame costs nothing while
 * it sits there" sentence below depends on the meter being able to see a frame
 * that costs something.
 *
 * ## Honest limitation
 *
 * The iframe is created by this script, not by React. `view.open`, the
 * `PackageFrame` component and the `resultCache` snapshot it builds are
 * therefore *not* in these numbers — the reason is that no shipped view kind is
 * backed by a fixture (`PACKAGE_UI` maps `graph` → neo4j and nothing else), and
 * adding one to open a benchmark's fixture is the product-code change
 * acceptance 21 rules out. Everything from the iframe element down is the real
 * path: same origin, same protocol handler, same response CSP, same handshake in
 * the same order. What is missing is the host-side React work, which is bounded
 * by the same component every other view mounts through.
 *
 * Usage:
 *   pnpm --filter @peek/desktop build
 *   node scripts/bench-package-frame.mjs [--opens=N] [--settle-ms=N] [--json] [--verbose]
 *
 * Exit code 0 = every view opened; every byte came from its own package
 * directory and was counted to the same total by both sources; the bytes and the
 * timings were inside the ceilings below; and the control drew frames, was loud
 * while doing it, stayed the same size, and separated from idle by a margin the
 * meter could see.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const ECHO_FIXTURE = join(DESKTOP_DIR, 'fixtures/packages/echo')

const DEFAULT_OPENS = 5
const DEFAULT_SETTLE_MS = 1000
const APP_LIFETIME_MS = 300_000
const WINDOW_READY_TIMEOUT_MS = 60_000
/** Well past `PackageFrame`'s own 3s stall timer, so a slow open is a number and not an error. */
const FRAME_OPEN_TIMEOUT_MS = 10_000

/**
 * How long to wait for one animation frame before calling the window invisible.
 *
 * Lifted from `bench-scroll.mjs`, which learned it the expensive way: macOS
 * stops the animation tick for an occluded or minimised window, and a
 * measurement hanging off that tick then never returns and never says why. Three
 * orders of magnitude above a healthy frame, so it can only ever mean "the tick
 * is not running", never "this machine is slow today".
 */
const RAF_STALL_MS = 5_000

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ceilings, and where each number came from.
 *
 * Set *after* six calibration rounds on an M1 (5 opens per view per round, 60
 * opens in all), not before — the spread is recorded in the design note dated
 * 2026-08-12, and it is the reason two of these three numbers are as loose as
 * they are.
 *
 * ## What the timing ceilings can and cannot catch
 *
 * Across those six rounds the per-round *median* time to `ready` moved between
 * 7.7 and 16.5ms for the same unchanged code. That factor of 2.1 is this
 * machine, not this app. A ceiling has to sit above the worst honest round, so
 * the resolution of the timing half of this benchmark is roughly "2.5× or
 * worse" — it will catch a package view that starts pulling something enormous
 * in, and it will not catch a 30% regression. Stating that plainly beats
 * quoting a tight-looking number that would go red every third run.
 *
 * The byte ceiling is a different kind of number and is treated as one below.
 */
const CEILINGS = {
  /**
   * Time to a frame that can be talked to.
   *
   * Observed per-round medians 7.7–16.5ms, worst single open 29.2ms. 40ms is
   * 2.4× the worst round median.
   */
  openMedianMs: 40,
  /**
   * The part of the open that lands on the window's own thread — the thread the
   * rest of peek draws on, and the reason an out-of-process frame is worth
   * having. Observed per-round medians 1.6–6.3ms, worst single open 7.0ms.
   */
  hostThreadMedianMs: 15,
  /**
   * Bytes read to open one view.
   *
   * Unlike the timings this has **no** measurement spread at all: six rounds,
   * two independent counts each, and every one of the twelve reported 23,362 B
   * for neo4j and 8,352 B for echo — the same numbers to the byte. So this
   * ceiling is not derived from noise, because there is none; it is a budget,
   * set at roughly 2.7× today's largest view. What it is for is the accident
   * that actually happens to package UIs — a bundle that starts carrying a
   * charting library, a font, an inlined image — not drift.
   */
  openBytes: 64 * 1024,
}

/**
 * How far apart the quiet frame and the loud one have to be for this run to be
 * worth reading, in milliseconds of the frame's own thread per second of wall
 * clock.
 *
 * ## Why milliseconds and not a ratio
 *
 * The ratio was the first thing this script asserted on, and eleven calibration
 * rounds say it is the wrong statistic. Its denominator is the quiet half, which
 * on a good round is a tenth of a millisecond — so it is not really a measure of
 * how loud the loud half is, it is a measure of how undisturbed the quiet one
 * was. Two of those eleven rounds landed on or under a floor of 10× without
 * anything being wrong with the frame or with the meter:
 *
 *   - one at 7.6× — idle window contaminated at 11.4ms, spin 87.1ms;
 *   - one at 10.5× *after* the min-of-three sampling below was added, because
 *     all three idle windows were contaminated (8.0 / 13.5 / 30.1ms).
 *
 * In both, the two halves were plainly distinguishable: the gap was 75.7 and
 * 75.8ms. Across all eleven rounds that gap stayed inside 62–87ms — including
 * the two the ratio tripped on. It is the figure that tracks the loud half,
 * which is the half this control exists to detect.
 *
 * So the assertion is stated on the gap, at 20ms: a third of the smallest gap
 * ever observed, and far above anything the meter's own noise produces. The
 * ratio is still computed and still printed — a reader wants to see it — but a
 * number that twice went red on a quiet machine having a moment is a number
 * that would teach people to ignore this benchmark.
 */
const CONTROL_MIN_MARGIN_MS = 20

/**
 * How many windows the quiet half is sampled over. Three is enough for the
 * minimum to dodge a single contaminated window, and costs three settle beats.
 */
const IDLE_SAMPLES = 3

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
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

function electronBinaryPath() {
  const mod = createRequire(join(DESKTOP_DIR, 'package.json'))('electron')
  if (typeof mod !== 'string') throw new Error('the electron package did not resolve to a binary path')
  return mod
}

async function pickFreePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve_, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => {
        resolve_(port)
      })
    })
  })
}

function launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose }) {
  const electronBin = process.env['PEEK_ELECTRON_BIN'] ?? electronBinaryPath()
  const childEnv = { ...process.env }
  // Inherited from whatever spawned this script, it would turn the Electron
  // binary into a bare node runtime: no window, and no frame to open.
  delete childEnv['ELECTRON_RUN_AS_NODE']
  childEnv['PEEK_MCP_PORT'] = String(mcpPort)
  childEnv['PEEK_CONFIG_DIR'] = configDir
  childEnv['PEEK_SMOKE_EXIT_MS'] = String(APP_LIFETIME_MS)

  const child = spawn(
    electronBin,
    [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${String(cdpPort)}`,
      // Without these three, this benchmark does not measure peek — it measures
      // what else happens to be on the screen. A run takes about a minute, and
      // over that minute macOS reliably marks the window occluded (whatever
      // window the run was started from is in front of it), at which point
      // Chromium marks the page hidden and stops the animation tick. Measured
      // three times in a row: the timed opens completed and the control then
      // failed the rAF guard with `visibilityState: "hidden"`, on the window as
      // well as on the frame.
      //
      // A user opening a package view is looking at the window, so "as if
      // foreground" is the state worth measuring, and these switches hold the
      // renderer in it regardless of stacking order. The guard below stays
      // anyway: it is the thing that told us this was happening instead of the
      // run hanging, and it still covers what the switches do not (a minimised
      // window, a sleeping display).
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
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

/**
 * Stage the `echo` fixture beside the config directory and install it through
 * the running app, the way `smoke-drivers.mjs` does.
 *
 * Not copied into `<configDir>/packages/` directly: that would be a package the
 * loader met at startup, and the benchmark would then be measuring a directory
 * this script laid out rather than one `packages.install` produced.
 */
function stageEchoFixture(root) {
  if (!existsSync(ECHO_FIXTURE)) return null
  const staged = join(root, 'echo-1.0.0')
  cpSync(ECHO_FIXTURE, staged, { recursive: true })
  return staged
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * One WebSocket, with two things `scripts/cdp.mjs` deliberately does not have:
 * events, and sessions.
 *
 * Both are needed here and nowhere else. A package frame is an out-of-process
 * iframe, so its requests and its process metrics are only reachable through a
 * *second* CDP session, and that session only exists because an event announced
 * it. Kept local rather than pushed into the shared client so that the readers
 * that want neither keep the smaller surface.
 */
class Cdp {
  #ws
  #next = 1
  #pending = new Map()
  #handlers = []
  #gone = null

  static async attachPage(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
        const targets = await res.json()
        // The window is the only `page` target the app opens; a package frame is
        // an `iframe` target and is reached through auto-attach, below.
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
    await new Promise((resolve_, reject) => {
      this.#ws.addEventListener('open', resolve_, { once: true })
      this.#ws.addEventListener(
        'error',
        () => {
          reject(new Error(`CDP websocket failed to open: ${url}`))
        },
        { once: true },
      )
    })
    this.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      if (msg.method !== undefined) {
        for (const handler of this.#handlers) handler(msg)
        return
      }
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${String(msg.error.code)})`))
      else entry.resolve(msg.result)
    })
    // A reply that can no longer arrive has to say so, or the app exiting under
    // this script leaves an `await` nothing will settle — the silence
    // `scripts/cdp.mjs` grew the same guard for.
    this.#ws.addEventListener('close', () => {
      this.#abandon('the CDP connection closed — the app most likely exited')
    })
    return this
  }

  #abandon(reason) {
    this.#gone ??= reason
    const waiting = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of waiting) entry.reject(new Error(reason))
  }

  /** Every protocol event, from every session. Filtering is the caller's. */
  on(handler) {
    this.#handlers.push(handler)
  }

  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    if (this.#gone !== null) return Promise.reject(new Error(`${method}: ${this.#gone}`))
    const id = this.#next++
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} got no reply in ${String(timeoutMs)}ms`))
      }, timeoutMs)
      const settle = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      this.#pending.set(id, { resolve: settle(resolve_), reject: settle(reject) })
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  async evaluate(expression, sessionId, timeoutMs = 60_000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      sessionId,
    )
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page evaluation threw: ${String(text)}`)
    }
    return result.result?.value
  }

  /** `Performance.getMetrics` as a plain object. Requires `Performance.enable` on that session first. */
  async metrics(sessionId) {
    const result = await this.send('Performance.getMetrics', {}, sessionId)
    return Object.fromEntries(result.metrics.map((m) => [m.name, m.value]))
  }

  close() {
    this.#abandon('the CDP connection was closed by the run itself')
    try {
      this.#ws?.close()
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* In-page expressions                                                 */
/* ------------------------------------------------------------------ */

/**
 * The occlusion guard, as an expression, so it can be run in the window and in a
 * frame — two different documents, two different animation ticks, and either one
 * stopping is the same silent hang.
 */
function rafGuardExpression(where) {
  return `(async () => {
  const entered = await Promise.race([
    new Promise((r) => requestAnimationFrame(() => r(true))),
    new Promise((r) => setTimeout(() => r(false), ${String(RAF_STALL_MS)})),
  ]);
  if (entered) return { ok: true };
  return { error: 'requestAnimationFrame did not fire in ${String(RAF_STALL_MS)}ms in ${where}; '
    + 'document.visibilityState is "' + document.visibilityState + '". An occluded or minimised window '
    + 'stops the animation tick, and every figure below hangs off it — bring the benchmark window to the '
    + 'front and run it again.' };
})()`
}

/**
 * Open one package frame and time it, in the order `PackageFrame.tsx` does it.
 *
 * The port goes over on the iframe's `load` and `init` + `data` follow the
 * frame's `ready`, because that order is the protocol: a frame is entitled to
 * assume nothing arrives before it has announced itself. Sending them from here
 * rather than stopping at `ready` also means the frame does the work a real open
 * makes it do — parsing a snapshot, drawing its first picture — inside the
 * window this script is measuring.
 */
function openFrameExpression({ packageId, slot, state }) {
  return `(async () => {
  const origin = 'peek-package://${packageId}';
  const t0 = performance.now();
  const el = document.createElement('iframe');
  // Sized and positioned like a panel rather than 1x1: a frame with no area is a
  // frame Chromium need not lay out or paint, which is not the thing being timed.
  el.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:640px;border:0;z-index:2147483000';
  el.setAttribute('allow', '');
  el.referrerPolicy = 'no-referrer';

  const loaded = new Promise((r) => el.addEventListener('load', () => r(performance.now() - t0), { once: true }));
  const channel = new MessageChannel();
  let readyAt = -1;
  const ready = new Promise((r) => {
    channel.port1.onmessage = (event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object') return;
      if (message.t === 'ready') { readyAt = performance.now() - t0; r(readyAt); }
      // A frame reporting its own trouble is the one client message worth
      // keeping: it turns "the numbers look odd" into a sentence.
      if (message.t === 'error') (window.__peekBenchErrors ??= []).push(String(message.message));
    };
  });

  el.src = origin + '/index.html';
  document.body.appendChild(el);

  const timeout = (ms) => new Promise((r) => setTimeout(() => r(-1), ms));
  const loadMs = await Promise.race([loaded, timeout(${String(FRAME_OPEN_TIMEOUT_MS)})]);
  if (loadMs < 0) { el.remove(); return { error: 'the frame never fired load' }; }

  // The origin and not '*': the second argument is what the browser checks the
  // receiver against, so '*' would hand the port to whatever document happened
  // to be in the frame. Same call as PackageFrame's.
  el.contentWindow.postMessage({ t: 'peek-package-port' }, origin, [channel.port2]);
  channel.port1.start();
  const readyMs = await Promise.race([ready, timeout(${String(FRAME_OPEN_TIMEOUT_MS)})]);
  if (readyMs < 0) { el.remove(); return { error: 'the frame loaded but never answered ready' }; }

  channel.port1.postMessage({
    t: 'init', viewId: 'bench-${slot}', packageKind: '${packageId}',
    state: ${JSON.stringify(state)}, locale: 'en', theme: 'dark',
  });
  channel.port1.postMessage({ t: 'data', status: 'done', columns: [], rows: [], rowCount: 0, truncated: false });

  (window.__peekBenchFrames ??= {})['${slot}'] = { el, port: channel.port1 };
  return { loadMs, readyMs };
})()`
}

/** How many elements the frame ended up with. Per document, unlike the process metrics. */
function frameElementsExpression() {
  return `document.getElementsByTagName('*').length`
}

/** Drop a frame, which is what takes its process down with it. */
function closeFrameExpression(slot) {
  return `(() => {
  const held = (window.__peekBenchFrames ??= {})['${slot}'];
  if (!held) return { ok: false };
  held.port.close();
  held.el.remove();
  delete window.__peekBenchFrames['${slot}'];
  return { ok: true };
})()`
}

function postStateExpression(slot, state) {
  return `(() => {
  const held = (window.__peekBenchFrames ??= {})['${slot}'];
  if (!held) return { error: 'no such frame' };
  held.port.postMessage({ t: 'state', state: ${JSON.stringify(state)} });
  return { ok: true };
})()`
}

/* ------------------------------------------------------------------ */
/* Byte accounting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which file a `peek-package://` URL means, and whether it is inside the package.
 *
 * A second implementation of `main/packages/assets.ts`'s `resolvePackageAsset`,
 * on purpose: a benchmark that imported main's resolver would agree with main by
 * construction, including about a URL that escaped. Here the containment test is
 * done on the resolved path and reported, so "every byte came from this
 * package's own `ui/`" is a measurement rather than a restatement.
 */
function resolveRequest(url, packagesRoot) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { url, inside: false, reason: 'not a URL' }
  }
  if (parsed.protocol !== 'peek-package:') return { url, inside: false, reason: `scheme ${parsed.protocol}` }
  const uiRoot = resolve(join(packagesRoot, parsed.hostname, 'ui'))
  const file = resolve(join(uiRoot, decodeURIComponent(parsed.pathname)))
  // Kept, but honestly: a request that came from a live frame cannot reach this
  // branch. Chromium normalises the path before the request is announced, so
  // `../driver.mjs` and `%2e%2e/driver.mjs` both arrive as `/driver.mjs` and are
  // caught one line down as "no such file" — verified by breaking the fixture
  // both ways. This is here for a URL shape that normalisation does not fold,
  // not because it is what does the catching.
  if (file !== uiRoot && !file.startsWith(uiRoot + sep)) {
    return { url, inside: false, reason: 'resolves outside the package ui directory', file }
  }
  let onDisk = null
  try {
    onDisk = statSync(file).size
  } catch {
    return { url, inside: true, file, onDisk: null, reason: 'no such file' }
  }
  return { url, inside: true, file, onDisk }
}

/**
 * How many bytes the protocol handler actually put on the wire for one request.
 *
 * The other count in this script stats the file the URL resolves to, which is
 * only the number of bytes an open costs if two assumptions hold: that the
 * handler served *that* file, and that it served all of it. Neither is checked
 * by stat'ing harder, so this reads the response body back out of the browser's
 * own buffer, where it is the served bytes and nothing else.
 *
 * It has to happen while the frame is still up: the buffer belongs to the
 * session, and closing the frame takes both down. `encodedDataLength` from
 * `Network.loadingFinished` is reported next to it rather than used — a
 * `protocol.handle` response measured 0 there on every request, which is exactly
 * the kind of plausible-looking zero that would have made a byte total collapse
 * quietly.
 */
async function servedBytes(cdp, request, state) {
  // The session that *announced* a request is not always the session that can
  // hand its body back: the iframe's document is announced by the parent, whose
  // network buffer never holds the bytes, while the frame that received them was
  // created after the announcement. So the announcing session is tried first and
  // every attached frame session after it — the id is the same across them,
  // because both sessions are on one browser connection.
  const candidates = [request.session === 'window' ? undefined : request.session, ...state.sessions.keys()]
  const reasons = []
  for (const session of candidates) {
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: request.requestId }, session, 10_000)
      const length = body.base64Encoded
        ? Buffer.from(body.body, 'base64').byteLength
        : Buffer.byteLength(body.body, 'utf8')
      return { bytes: length, encodedDataLength: state.finished.get(request.requestId) ?? null }
    } catch (error) {
      reasons.push(String(error?.message ?? error))
    }
  }
  return { bytes: null, reason: reasons.join(' | ') }
}

/** Every file in a directory tree, with its size. Used to say what an open did *not* read. */
function treeFiles(dir) {
  const out = []
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push({ file: full, bytes: statSync(full).size })
    }
  }
  walk(dir)
  return out
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
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: percentile(sorted, 50),
    max: sorted[sorted.length - 1] ?? null,
  }
}

const ms = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}ms`)
const bytes = (n) => `${n.toLocaleString('en-US')} B`

/** Metric deltas, in the units a reader wants: CPU seconds become milliseconds, counts stay counts. */
function metricDelta(before, after) {
  const secs = (key) => (after[key] ?? 0) - (before[key] ?? 0)
  return {
    threadMs: secs('ThreadTime') * 1000,
    taskMs: secs('TaskDuration') * 1000,
    scriptMs: secs('ScriptDuration') * 1000,
    layoutMs: secs('LayoutDuration') * 1000,
    styleMs: secs('RecalcStyleDuration') * 1000,
    layoutCount: (after['LayoutCount'] ?? 0) - (before['LayoutCount'] ?? 0),
    styleCount: (after['RecalcStyleCount'] ?? 0) - (before['RecalcStyleCount'] ?? 0),
  }
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

/**
 * Attach to every frame target the window creates, and record what it fetches.
 *
 * `waitForDebuggerOnStart` is what makes the accounting complete — without it
 * the frame's subresources are requested before there is a session to hear about
 * them. It also **costs the timing measurement its meaning**: the frame sits
 * paused until `Runtime.runIfWaitingForDebugger`, which measured 100ms slower
 * than an uninstrumented open. So this mode is entered for the accounting pass
 * and left before anything is timed.
 */
function installFrameTracking(cdp, state) {
  cdp.on((msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params
      if (targetInfo.type !== 'iframe') return
      state.sessions.set(sessionId, { url: targetInfo.url, targetId: targetInfo.targetId })
      void (async () => {
        // Order matters: Network before the frame is let go, or its own document
        // and scripts are already in flight.
        await cdp.send('Network.enable', {}, sessionId).catch(() => {})
        await cdp.send('Performance.enable', {}, sessionId).catch(() => {})
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
      })()
      return
    }
    if (msg.method === 'Target.detachedFromTarget') {
      state.sessions.delete(msg.params.sessionId)
      return
    }
    if (msg.method === 'Network.requestWillBeSent') {
      state.requests.push({
        url: msg.params.request.url,
        session: msg.sessionId ?? 'window',
        requestId: msg.params.requestId,
      })
    }
    if (msg.method === 'Network.loadingFinished') {
      state.finished.set(msg.params.requestId, msg.params.encodedDataLength)
    }
  })
}

/**
 * The requests that belong to the open, out of everything both sessions saw.
 *
 * Two sessions have to be listened to, because the two halves of an open are
 * issued by different frames. The iframe's **document** is fetched on behalf of
 * the parent — it is the window's session that announces it, and a frame target
 * does not exist yet to hear it — while the document's subresources are the
 * frame's own. Listening to the frame alone (which is what this script did
 * first) silently dropped `index.html` from every byte total and then listed it
 * under "left unread", which read as a finding and was an accounting hole.
 *
 * Keeping the window session also drags in the window's own traffic, so the
 * split is by *what*, not by *who*: any `peek-package:` URL is part of opening a
 * package view no matter which session announced it, and anything else is only
 * interesting when a frame asked for it — which is exactly the escape this run
 * is meant to catch.
 */
function requestsForOpen(requests) {
  const seen = new Set()
  const out = []
  for (const request of requests) {
    const isPackageUrl = request.url.startsWith('peek-package://')
    if (!isPackageUrl && request.session === 'window') continue
    if (seen.has(request.url)) continue
    seen.add(request.url)
    out.push(request)
  }
  return out
}

/** One instrumented open, for the byte accounting. Its timings are deliberately not kept. */
async function accountForOpen(cdp, state, { packageId, slot, packagesRoot, cdpPort, viewState }) {
  state.requests.length = 0
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const opened = await cdp.evaluate(openFrameExpression({ packageId, slot, state: viewState }))
  if (opened?.error) throw new Error(`${packageId}: ${String(opened.error)}`)
  // The last subresource can land after `ready` — a stylesheet does not hold up
  // the script that answers. One settle beat, then the list is closed.
  await delay(400)

  // Both readings that need the frame alive, before it is taken down.
  const requests = requestsForOpen(state.requests)
  const served = []
  for (const request of requests) served.push(await servedBytes(cdp, request, state))
  const frameSession = await attachToFrame(cdp, cdpPort, packageId)
  const elements = frameSession === null ? null : await cdp.evaluate(frameElementsExpression(), frameSession)

  await cdp.evaluate(closeFrameExpression(slot))
  await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })

  const read = requests.map((r, i) => ({ ...resolveRequest(r.url, packagesRoot), ...served[i] }))
  const foreign = read.filter((r) => !r.inside || r.onDisk === null)
  const total = read.reduce((sum, r) => sum + (r.onDisk ?? 0), 0)
  const servedTotal = read.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const disagree = read.filter((r) => r.bytes !== r.onDisk)

  const uiRoot = join(packagesRoot, packageId, 'ui')
  const packageRoot = join(packagesRoot, packageId)
  const readFiles = new Set(read.map((r) => r.file))
  const unread = treeFiles(packageRoot).filter((f) => !readFiles.has(f.file))

  return {
    files: read.map((r) => ({ name: relative(uiRoot, r.file ?? ''), bytes: r.bytes, onDisk: r.onDisk, url: r.url })),
    totalBytes: total,
    servedTotal,
    disagree: disagree.map((r) => ({ name: relative(uiRoot, r.file ?? r.url), served: r.bytes, onDisk: r.onDisk })),
    encodedDataLengths: read.map((r) => r.encodedDataLength),
    elements,
    foreign,
    unread: { count: unread.length, bytes: unread.reduce((s, f) => s + f.bytes, 0), names: unread.map((f) => relative(packageRoot, f.file)) },
  }
}

/** `opens` clean opens, timed. No auto-attach, so nothing is paused mid-flight. */
async function timeOpens(cdp, { packageId, slot, opens, viewState, verbose }) {
  const loadMs = []
  const readyMs = []
  const hostThreadMs = []
  for (let i = 0; i < opens; i += 1) {
    const before = await cdp.metrics()
    const opened = await cdp.evaluate(openFrameExpression({ packageId, slot, state: viewState }))
    if (opened?.error) throw new Error(`${packageId} open ${String(i + 1)}: ${String(opened.error)}`)
    const after = await cdp.metrics()
    loadMs.push(opened.loadMs)
    readyMs.push(opened.readyMs)
    hostThreadMs.push(metricDelta(before, after).threadMs)
    if (verbose) {
      console.log(`  ${packageId} open ${String(i + 1)}: load ${ms(opened.loadMs)}, ready ${ms(opened.readyMs)}`)
    }
    // The last one is left open: the caller measures the process it created.
    if (i < opens - 1) {
      await cdp.evaluate(closeFrameExpression(slot))
      // A frame's process goes away with its last frame, and the next open pays
      // for a new one — which is what an open costs. Without this pause the
      // teardown overlaps the next open and both numbers are somebody else's.
      await delay(300)
    }
  }
  return { loadMs: summarize(loadMs), readyMs: summarize(readyMs), hostThreadMs: summarize(hostThreadMs) }
}

/**
 * A session on the frame that is open right now, found by origin.
 *
 * Deliberately not the session auto-attach produced: that one is announced
 * before the target has a URL (`targetInfo.url` is empty at
 * `Target.attachedToTarget`), so identifying a frame by origin has to happen
 * later, and the timed opens run with auto-attach off anyway. Asking the
 * debugging endpoint for the target list is the only place the origin is
 * readable, which is also what makes this an *observation* that the frame lives
 * in its own target rather than an assumption.
 */
async function attachToFrame(cdp, cdpPort, packageId) {
  const targets = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/list`)).json()
  const found = targets.filter((t) => t.type === 'iframe' && t.url.startsWith(`peek-package://${packageId}/`))
  if (found.length !== 1) return null
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: found[0].id, flatten: true })
  await cdp.send('Performance.enable', {}, sessionId)
  return sessionId
}

/**
 * The control: one frame idle, the same frame spinning, same meter on both.
 *
 * Measured on the frame's own process *and* on the window's, because the two
 * answer different questions — the first says the meter can see work at all, the
 * second says whether that work lands on the thread peek draws with.
 *
 * ## Why the idle side is sampled more than once
 *
 * The first six calibration rounds put idle frame time at 0.22, 0.39, 0.45,
 * 0.52, 1.20 — and 11.38ms. That sixth window was not an idle frame costing
 * 11ms; nothing in the fixture can spend that, and the spinning half of the same
 * round was normal. It was another tenant of that renderer (the *other* package
 * frame shares the process is the likeliest reader) landing inside the one
 * window that happened to be the sample. One contaminated window is enough to
 * drag a ratio whose denominator is a fraction of a millisecond from ~200× down
 * to 7.6×, which is what failed round 5.
 *
 * Sampling idle `IDLE_SAMPLES` times and keeping the **smallest** window is the
 * fix on the measurement side: contamination can only ever add time, so the
 * minimum is the sample least likely to contain somebody else's work.
 *
 * It is not a complete fix, and the numbers say so — a later round had all three
 * windows contaminated (8.0 / 13.5 / 30.1ms). That is why the assertion this
 * feeds is stated on the gap between the halves and not on their ratio; see
 * `CONTROL_MIN_MARGIN_MS`.
 */
async function runControl(cdp, { slot, sessionId, settleMs }) {
  const guard = await cdp.evaluate(rafGuardExpression('the package frame'), sessionId)
  if (guard?.error) throw new Error(String(guard.error))

  const sample = async () => {
    const frameBefore = await cdp.metrics(sessionId)
    const hostBefore = await cdp.metrics()
    await delay(settleMs)
    const frameAfter = await cdp.metrics(sessionId)
    const hostAfter = await cdp.metrics()
    return { frame: metricDelta(frameBefore, frameAfter), host: metricDelta(hostBefore, hostAfter) }
  }

  /** The quietest of `IDLE_SAMPLES` windows. See above for why the minimum. */
  const quietestSample = async () => {
    // Collect first. The frame's renderer has just torn down five previous opens
    // and a collection landing inside a sample is the single likeliest way for a
    // quiet window to measure loud — better to pay for it deliberately, outside
    // the windows, than to sample around it.
    await cdp.send('HeapProfiler.collectGarbage', {}, sessionId).catch(() => {})
    let best = null
    const all = []
    for (let i = 0; i < IDLE_SAMPLES; i += 1) {
      const taken = await sample()
      all.push(taken.frame.threadMs)
      if (best === null || taken.frame.threadMs < best.frame.threadMs) best = taken
    }
    return { ...best, allThreadMs: all }
  }

  const framesDrawn = async () =>
    await cdp.evaluate(
      `(window.__peekEchoFixture ? window.__peekEchoFixture.framesDrawn : -1)`,
      sessionId,
    )

  const attrWrites = async () =>
    await cdp.evaluate(`(window.__peekEchoFixture ? window.__peekEchoFixture.attrWrites : -1)`, sessionId)

  const elementCount = async () =>
    await cdp.evaluate(`(window.__peekEchoFixture ? window.__peekEchoFixture.elementCount : -1)`, sessionId)

  const idle = await quietestSample()
  const elementsIdle = await elementCount()
  const drawnBeforeSpin = await framesDrawn()
  const writtenBeforeSpin = await attrWrites()
  await cdp.evaluate(postStateExpression(slot, { spin: true }))
  const spin = await sample()
  const drawnAfterSpin = await framesDrawn()
  const writtenAfterSpin = await attrWrites()
  // Read while the loop is still running: an element count taken after the frame
  // went quiet again would be a count of the frame at rest, which is not the
  // claim. The claim is that a frame doing its loudest work is the same size.
  const elementsSpinning = await elementCount()
  await cdp.evaluate(postStateExpression(slot, { spin: false }))

  const framesSpun = drawnAfterSpin - drawnBeforeSpin
  return {
    idle,
    spin,
    framesSpun,
    attrsPerFrame: framesSpun > 0 ? (writtenAfterSpin - writtenBeforeSpin) / framesSpun : 0,
    elements: elementsIdle,
    elementsSpinning,
    settleMs,
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2)
  const opens = intArg(argv, 'opens', DEFAULT_OPENS)
  const settleMs = intArg(argv, 'settle-ms', DEFAULT_SETTLE_MS)
  const json = argv.includes('--json')
  const verbose = argv.includes('--verbose')

  const configDir = mkdtempSync(join(tmpdir(), 'peek-bench-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-bench-udd-'))
  const stagingDir = mkdtempSync(join(tmpdir(), 'peek-bench-stage-'))
  const mcpPort = await pickFreePort()
  const cdpPort = await pickFreePort()

  const { child, logLines } = launchApp({ mcpPort, cdpPort, configDir, userDataDir, verbose })
  let cdp = null
  const failures = []

  try {
    cdp = await Cdp.attachPage(cdpPort)
    const deadline = Date.now() + WINDOW_READY_TIMEOUT_MS
    let painted = false
    while (Date.now() < deadline && !painted) {
      painted = await cdp
        .evaluate(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`)
        .catch(() => false)
      if (!painted) await delay(250)
    }
    if (!painted) throw new Error('the window never rendered anything into #root')

    // Before anything is timed. A window whose tick is stopped mis-times every
    // open below it, and says nothing about why.
    const guard = await cdp.evaluate(rafGuardExpression('the window'))
    if (guard?.error) throw new Error(String(guard.error))

    const echoSource = stageEchoFixture(stagingDir)
    if (echoSource === null) throw new Error(`no echo fixture at ${ECHO_FIXTURE}; the control has no carrier`)
    const installed = await cdp.evaluate(
      `window.peek.invoke('packages.install', ${JSON.stringify({ dir: echoSource })})`,
    )
    if (installed?.ok !== true) throw new Error(`packages.install failed: ${JSON.stringify(installed)}`)

    await cdp.send('Performance.enable')
    // On the *window's* session, not only on the frames': see `requestsForOpen`.
    await cdp.send('Network.enable')
    const state = { sessions: new Map(), requests: [], finished: new Map() }
    installFrameTracking(cdp, state)

    const packagesRoot = join(configDir, 'packages')
    const views = [
      { packageId: 'neo4j', slot: 'graph', label: 'neo4j graph (the shipped Tier C view)', viewState: {} },
      { packageId: 'echo', slot: 'echo', label: 'echo fixture (fixed size, 600 elements)', viewState: { spin: false } },
    ]

    const report = { opens, settleMs, views: [], control: null, frameErrors: [] }

    let echoSessionId = null
    for (const view of views) {
      const accounting = await accountForOpen(cdp, state, { ...view, packagesRoot, cdpPort })
      const timings = await timeOpens(cdp, { ...view, opens, verbose })
      const sessionId = await attachToFrame(cdp, cdpPort, view.packageId)
      if (sessionId === null) throw new Error(`${view.packageId} has no frame target of its own to read`)
      const frameMetrics = await cdp.metrics(sessionId)
      if (view.packageId === 'echo') echoSessionId = sessionId
      report.views.push({ ...view, accounting, timings, frameMetrics })

      if (accounting.foreign.length > 0) {
        failures.push(
          `${view.packageId} read ${String(accounting.foreign.length)} thing(s) from outside its own ui/: ` +
            accounting.foreign.map((f) => `${f.url} (${String(f.reason)})`).join(', '),
        )
      }
      // Two independent counts of the same bytes. Whichever is wrong, the byte
      // figure is not quotable until they agree, so this is a failure and not a
      // note — a single unchecked number is how a benchmark ends up confidently
      // reporting a total that was missing a file.
      if (accounting.disagree.length > 0) {
        failures.push(
          `${view.packageId}: served bytes and file sizes disagree on ` +
            accounting.disagree
              .map((d) => `${d.name} (${String(d.served)} served vs ${String(d.onDisk)} on disk)`)
              .join(', '),
        )
      }
      if (timings.readyMs.median > CEILINGS.openMedianMs) {
        failures.push(
          `${view.packageId} took a median ${ms(timings.readyMs.median)} to answer ready, ceiling ${ms(CEILINGS.openMedianMs)}`,
        )
      }
      if (timings.hostThreadMs.median > CEILINGS.hostThreadMedianMs) {
        failures.push(
          `${view.packageId} cost the window's own thread a median ${ms(timings.hostThreadMs.median)}, ` +
            `ceiling ${ms(CEILINGS.hostThreadMedianMs)}`,
        )
      }
      if (accounting.totalBytes > CEILINGS.openBytes) {
        failures.push(
          `${view.packageId} read ${bytes(accounting.totalBytes)} to open, budget ${bytes(CEILINGS.openBytes)}`,
        )
      }
      if (view.packageId !== 'echo') await cdp.evaluate(closeFrameExpression(view.slot))
    }

    report.control = await runControl(cdp, { slot: 'echo', sessionId: echoSessionId, settleMs })
    report.frameErrors = (await cdp.evaluate(`window.__peekBenchErrors ?? []`)) ?? []

    // The control decides whether anything above it is worth reading.
    const idleThread = report.control.idle.frame.threadMs
    const spinThread = report.control.spin.frame.threadMs
    const ratio = idleThread <= 0 ? Infinity : spinThread / idleThread
    const margin = spinThread - idleThread
    if (report.control.framesSpun <= 0) {
      failures.push(
        `the control never drew a frame while spinning (${String(report.control.framesSpun)} frames in ` +
          `${String(settleMs)}ms) — the fixture's animation tick is not running, so the idle numbers above ` +
          `prove nothing`,
      )
    } else if (report.control.attrsPerFrame < report.control.elements) {
      // At least one attribute write per element on screen. The floor exists
      // because of what a weaker one lets through: a fixture rewriting a *single*
      // attribute per frame was measured drawing 114 frames a second and burning
      // 91.7ms of thread time — more than the real loud case, which draws 48
      // heavier frames for ~80ms. Total thread time over a fixed window says "a
      // loop is running", not "each frame is expensive", so the loudness of the
      // loud case has to be asserted where it is actually decided.
      failures.push(
        `the control rewrote ${String(report.control.attrsPerFrame)} attribute(s) per frame across ` +
          `${String(report.control.elements)} elements — under one write per element, the loud case is not ` +
          `loud enough to be a control for the quiet one`,
      )
    } else if (margin < CONTROL_MIN_MARGIN_MS) {
      failures.push(
        `the control separated idle from busy by only ${ms(margin)} (${ms(idleThread)} idle vs ` +
          `${ms(spinThread)} spinning over ${String(settleMs)}ms, ${String(report.control.framesSpun)} frames ` +
          `drawn), under ${ms(CONTROL_MIN_MARGIN_MS)} — the meter cannot see the difference, so nothing ` +
          `measured with it means anything`,
      )
    }
    // The size claim, stated where it can fail: 1,200 attribute writes a frame
    // and the picture is the same size as it was standing still.
    if (report.control.elements !== report.control.elementsSpinning) {
      failures.push(
        `the fixture changed size while spinning: ${String(report.control.elements)} elements idle vs ` +
          `${String(report.control.elementsSpinning)} spinning — the loud case is drawing a different picture, ` +
          `so it is not a control for the quiet one`,
      )
    }

    if (json) {
      console.log(JSON.stringify({ ...report, failures }, null, 2))
    } else {
      printReport(report, failures, packagesRoot)
    }
    if (failures.length > 0) process.exitCode = 1
    return report
  } catch (error) {
    console.error(`bench-package-frame: ${String(error?.message ?? error)}`)
    console.error('--- app log (tail) ---')
    for (const line of logLines.slice(-40)) console.error(line)
    process.exitCode = 1
  } finally {
    cdp?.close()
    child.kill('SIGTERM')
    const stopped = await Promise.race([
      new Promise((resolve_) => child.once('exit', () => resolve_(true))),
      delay(8000).then(() => false),
    ])
    if (!stopped) child.kill('SIGKILL')
    rmSync(configDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

function printReport(report, failures, packagesRoot) {
  console.log(`\nPackage-frame open benchmark — ${String(report.opens)} opens per view`)
  console.log(`  package root                ${packagesRoot}`)
  for (const view of report.views) {
    const a = view.accounting
    const m = view.frameMetrics
    console.log(`\n  ${view.label}`)
    console.log(
      `    read to open              ${String(a.files.length)} file(s), ${bytes(a.totalBytes)}` +
        `  [${a.files.map((f) => `${f.name} ${bytes(f.onDisk ?? 0)}`).join(', ')}]`,
    )
    console.log(
      `    same bytes, counted twice ${bytes(a.servedTotal)} read back off the wire` +
        `  (encodedDataLength: ${a.encodedDataLengths.map((n) => String(n)).join('/')})`,
    )
    console.log(
      `    left unread in the package ${String(a.unread.count)} file(s), ${bytes(a.unread.bytes)}` +
        `  [${a.unread.names.join(', ')}]`,
    )
    console.log('                              min / median / max')
    console.log(
      `    append → load             ${ms(view.timings.loadMs.min)} / ${ms(view.timings.loadMs.median)} / ${ms(view.timings.loadMs.max)}`,
    )
    console.log(
      `    append → ready            ${ms(view.timings.readyMs.min)} / ${ms(view.timings.readyMs.median)} / ${ms(view.timings.readyMs.max)}`,
    )
    console.log(
      `    window main thread        ${ms(view.timings.hostThreadMs.min)} / ${ms(view.timings.hostThreadMs.median)} / ${ms(view.timings.hostThreadMs.max)}`,
    )
    console.log(`    elements in the frame     ${String(a.elements ?? -1)}`)
    if (m) {
      // Cumulative for the renderer, not for one open: every open in this view
      // landed in the same process, and `Documents` says how many. Reported as
      // "what one process ended up carrying", which is the only reading of it
      // that is true.
      console.log(
        `    its renderer, cumulative  ${ms((m['ProcessTime'] ?? 0) * 1000)} CPU over ` +
          `${String(m['Documents'] ?? 0)} document(s), ${bytes(m['JSHeapUsedSize'] ?? 0)} JS heap`,
      )
    }
  }

  const c = report.control
  if (c) {
    console.log(
      `\n  Positive control — the fixture's ${String(c.elements)} elements, ` +
        `${String(c.attrsPerFrame)} attributes rewritten per frame`,
    )
    console.log(`                              thread / script / layout / style        layouts`)
    for (const [name, side] of [
      ['frame idle  ', c.idle.frame],
      ['frame spin  ', c.spin.frame],
      ['window idle ', c.idle.host],
      ['window spin ', c.spin.host],
    ]) {
      console.log(
        `    ${name}              ${ms(side.threadMs)} / ${ms(side.scriptMs)} / ${ms(side.layoutMs)} / ${ms(side.styleMs)}` +
          `        ${String(side.layoutCount)}`,
      )
    }
    const ratio = c.idle.frame.threadMs <= 0 ? Infinity : c.spin.frame.threadMs / c.idle.frame.threadMs
    console.log(
      `    separation                ${ratio === Infinity ? '∞' : `${ratio.toFixed(0)}×`} / ` +
        `${ms(c.spin.frame.threadMs - c.idle.frame.threadMs)} on the frame's thread over ` +
        `${String(c.settleMs)}ms, ${String(c.framesSpun)} frames drawn`,
    )
    // Per frame, because the total does not separate "expensive frames" from
    // "cheap frames, more of them" — see the attributes-per-element failure.
    console.log(
      `    spin, per frame drawn     ${ms(c.framesSpun > 0 ? c.spin.frame.threadMs / c.framesSpun : 0)} of ` +
        `thread time, ${String(c.attrsPerFrame)} attribute writes`,
    )
    console.log(
      `    idle windows sampled      ${c.idle.allThreadMs.map((v) => ms(v)).join(' / ')} — quietest kept`,
    )
    console.log(
      `    elements, idle vs spin    ${String(c.elements)} / ${String(c.elementsSpinning)}`,
    )
  }

  if (report.frameErrors.length > 0) {
    console.log(`\n  the frames reported ${String(report.frameErrors.length)} error(s) of their own:`)
    for (const line of report.frameErrors.slice(0, 5)) console.log(`    ${line}`)
  }

  if (failures.length > 0) {
    console.log('')
    for (const line of failures) console.log(`  FAIL ${line}`)
  }
}

await main()
