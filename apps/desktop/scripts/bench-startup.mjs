#!/usr/bin/env node
/**
 * Cold-start benchmark for the built app, plus the bundle sizes that feed it.
 *
 * PLAN §8 puts a 1.5s ceiling on "launch to first usable frame". That number was
 * a recorded measurement with no way to reproduce it; this script is the
 * reproduction. It launches `out/main/index.js` as a real Electron process N
 * times and reports the distribution of three timestamps, each measured from the
 * instant `spawn` was called:
 *
 *   app-ready       Electron's `app.whenReady()` — runtime boot plus main bundle parse
 *   ready-to-show   the window has a first frame and is about to be shown; this
 *                   is the number PLAN §8 is about
 *   did-finish-load the renderer document finished loading
 *
 * The events are observed by `bench-startup-probe.mjs`, injected with
 * `NODE_OPTIONS=--import`, so the app's own source carries no instrumentation.
 *
 * ## Isolation
 *
 * Every run gets its own `--user-data-dir` (which is what scopes Electron's
 * single-instance lock, so a peek already open on the desktop neither blocks the
 * run nor is disturbed by it), its own `PEEK_CONFIG_DIR` instead of `~/.peek`,
 * and its own free `PEEK_MCP_PORT` instead of 7332. Without all three, the
 * second run measures "a second instance handed off and exited", not a start.
 *
 * ## Warm vs cold
 *
 * Only the first run of a session pays for reading the bundles off disk; the OS
 * page cache serves the rest. Both numbers matter and both are reported: run 1
 * is labelled separately and excluded from the percentiles, which describe the
 * warm case. Purging the page cache needs root, so this script does not pretend
 * to and simply says which is which.
 *
 * Usage:
 *   pnpm --filter @peek/desktop build
 *   node scripts/bench-startup.mjs [--runs=N] [--json] [--verbose]
 *
 * Exit code 0 = every run reached `ready-to-show`.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROBE_URL = new URL('./bench-startup-probe.mjs', import.meta.url).href
const OUT_DIR = join(DESKTOP_DIR, 'out')

const DEFAULT_RUNS = 7
/** A run that has not shown a window by now is a failure, not a slow machine. */
const RUN_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const runsArg = argv.find((a) => a.startsWith('--runs='))
  const runs = runsArg ? Number.parseInt(runsArg.slice('--runs='.length), 10) : DEFAULT_RUNS
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${String(runsArg)}`)
  }
  return { runs, json: argv.includes('--json'), verbose: argv.includes('--verbose') }
}

/* ------------------------------------------------------------------ */
/* Bundle sizes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every emitted script and stylesheet under `out/`, largest first.
 *
 * Reported alongside the timings because they are the same measurement seen from
 * two sides: bytes on disk are what the runtime has to read and parse before
 * `app-ready` can happen, and they are the one thing a config change moves
 * without moving any code.
 */
async function bundleSizes() {
  const rows = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // out/ has not been built
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(js|cjs|mjs|css)$/.test(entry.name)) {
        rows.push({ file: relative(DESKTOP_DIR, path), bytes: statSync(path).size })
      }
    }
  }
  await walk(OUT_DIR)
  rows.sort((a, b) => b.bytes - a.bytes)
  return rows
}

/* ------------------------------------------------------------------ */
/* One run                                                             */
/* ------------------------------------------------------------------ */

function electronBinaryPath() {
  // The `electron` package's main export is the path to the binary, so resolving
  // it from this workspace beats hard-coding a platform-specific path.
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

const MARK_RE = /^__PEEK_BENCH__ (\S+) (\d+)$/

/**
 * Launch once and resolve with `{ appReady, readyToShow, didFinishLoad }`, each
 * in milliseconds since `spawn` was called.
 */
async function runOnce({ electronBin, verbose }) {
  const port = await pickFreePort()
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-bench-udd-'))
  const configDir = mkdtempSync(join(tmpdir(), 'peek-bench-cfg-'))

  const childEnv = { ...process.env }
  // Inherited from whatever spawned this script, it would turn the Electron
  // binary into a bare node runtime: no window, so nothing to time.
  delete childEnv['ELECTRON_RUN_AS_NODE']
  childEnv['PEEK_MCP_PORT'] = String(port)
  childEnv['PEEK_CONFIG_DIR'] = configDir
  // Appended rather than assigned: a caller may already be using NODE_OPTIONS.
  childEnv['NODE_OPTIONS'] = `${process.env['NODE_OPTIONS'] ?? ''} --import ${PROBE_URL}`.trim()

  const marks = new Map()
  const logLines = []

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      // Best-effort: a leftover temp dir is noise, a crash here would lose the run
      for (const dir of [userDataDir, configDir]) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      fn(value)
    }

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `the app did not reach ready-to-show within ${String(RUN_TIMEOUT_MS)}ms.\n${logLines.join('\n')}`,
        ),
      )
    }, RUN_TIMEOUT_MS)

    const spawnedAt = Date.now()
    const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`], {
      cwd: DESKTOP_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const capture = (stream, tag) => {
      stream.setEncoding('utf8')
      let buffered = ''
      stream.on('data', (piece) => {
        buffered += piece
        const parts = buffered.split('\n')
        buffered = parts.pop() ?? ''
        for (const line of parts) {
          const m = MARK_RE.exec(line)
          if (m) {
            marks.set(m[1], Number(m[2]) - spawnedAt)
            // Both are needed, and their order is not guaranteed: ready-to-show
            // is the first paint, did-finish-load is the document. Wait for both.
            if (marks.has('ready-to-show') && marks.has('did-finish-load')) {
              finish(resolve, {
                appReady: marks.get('app-ready') ?? null,
                readyToShow: marks.get('ready-to-show'),
                didFinishLoad: marks.get('did-finish-load'),
              })
            }
            continue
          }
          logLines.push(`[${tag}] ${line}`)
          if (verbose) console.log(`[app/${tag}] ${line}`)
        }
      })
    }
    capture(child.stdout, 'out')
    capture(child.stderr, 'err')

    child.on('error', (err) => {
      finish(reject, err)
    })
    child.on('exit', (code) => {
      finish(
        reject,
        new Error(
          `the app exited with code ${String(code)} before showing a window.\n${logLines.join('\n')}`,
        ),
      )
    })
  })
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/** Nearest-rank percentile; with 6 warm samples anything fancier is theatre. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
  }
}

const ms = (n) => (n === null || n === undefined ? '—' : `${String(Math.round(n))}ms`)
const kb = (n) => `${(n / 1024).toFixed(1)} kB`

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const { runs, json, verbose } = parseArgs(process.argv.slice(2))

  const sizes = await bundleSizes()
  if (sizes.length === 0) {
    throw new Error(`no bundles under ${OUT_DIR} — run \`pnpm --filter @peek/desktop build\` first`)
  }
  const totalBytes = sizes.reduce((sum, row) => sum + row.bytes, 0)

  const electronBin = process.env['PEEK_ELECTRON_BIN'] ?? electronBinaryPath()
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    if (!json) process.stderr.write(`run ${String(i + 1)}/${String(runs)}…\r`)
    samples.push(await runOnce({ electronBin, verbose }))
  }
  if (!json) process.stderr.write('\n')

  // Run 1 reads the bundles off disk; every later run is served by the page
  // cache. Mixing them would report a bimodal distribution as one number.
  const cold = samples[0]
  const warm = samples.slice(1)
  const pick = (key) => warm.map((s) => s[key]).filter((v) => typeof v === 'number')

  const report = {
    electron: electronBin,
    runs,
    bundleBytes: totalBytes,
    bundles: sizes,
    cold,
    warm: {
      appReady: summarize(pick('appReady')),
      readyToShow: summarize(pick('readyToShow')),
      didFinishLoad: summarize(pick('didFinishLoad')),
    },
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('\nBundle sizes (out/)')
    for (const row of sizes) console.log(`  ${kb(row.bytes).padStart(12)}  ${row.file}`)
    console.log(`  ${kb(totalBytes).padStart(12)}  total`)

    console.log(`\nStartup, ${String(runs)} runs (measured from spawn)`)
    console.log(
      `  cold (run 1)      app-ready ${ms(cold.appReady)}  ready-to-show ${ms(cold.readyToShow)}  did-finish-load ${ms(cold.didFinishLoad)}`,
    )
    if (warm.length > 0) {
      const rows = [
        ['app-ready', report.warm.appReady],
        ['ready-to-show', report.warm.readyToShow],
        ['did-finish-load', report.warm.didFinishLoad],
      ]
      console.log(`  warm (runs 2-${String(runs)})   min / median / p95 / max`)
      for (const [name, s] of rows) {
        console.log(`    ${name.padEnd(16)} ${ms(s.min)} / ${ms(s.median)} / ${ms(s.p95)} / ${ms(s.max)}`)
      }
    }
    // PLAN §8's budget is stated against ready-to-show, so that is what is judged.
    const judged = report.warm.readyToShow.median ?? cold.readyToShow
    console.log(
      `\n  PLAN §8 budget: launch → first usable frame < 1500ms — ${judged < 1500 ? 'PASS' : 'FAIL'} (${ms(judged)})`,
    )
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
