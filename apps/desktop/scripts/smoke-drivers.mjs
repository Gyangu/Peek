#!/usr/bin/env node
/**
 * End-to-end driver smoke check.
 *
 * Launches the *built* app (out/main/index.js) as a real Electron process, then
 * drives it over its own MCP endpoint exactly the way an AI client would: one
 * `connect` per driver followed by one `introspect`. Nothing here reaches into
 * the app's internals, so a pass means the whole path is intact — main spawns a
 * utilityProcess, the bundled `driver-host.js` resolves the driver package,
 * `connect` clears core's capability self-check, and the namespace tree comes
 * back through the driver RPC channel.
 *
 * That end-to-end framing is the point. Unit tests import driver packages
 * straight from source and would keep passing if the bundle failed to resolve
 * `mysql2`, if two drivers fought over `process.parentPort`, or if a row went
 * missing from the registry. Only launching the shipped artifact catches those.
 *
 * The run is fully isolated from an installed peek: its own `--user-data-dir`
 * (which is what scopes Electron's single-instance lock, so a peek already open
 * on the user's desktop neither blocks this run nor gets disturbed by it), its
 * own MCP port, and its own config dir instead of `~/.peek`.
 *
 * Usage:
 *   pnpm --filter @peek/desktop build
 *   node scripts/smoke-drivers.mjs [--keep-open]
 *
 * Targets come from the environment, so CI can point it at its own services:
 *   PEEK_TEST_PG_URL, PEEK_TEST_REDIS_URL, PEEK_TEST_QDRANT_URL,
 *   PEEK_TEST_MYSQL_URL, PEEK_TEST_SQLITE_FILE
 * A target whose variable is unset is skipped, and skips do not fail the run —
 * absent services are an environment fact, not a defect in the code.
 *
 * Exit code 0 = every attempted driver connected and introspected.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const KEEP_OPEN = process.argv.includes('--keep-open')

/** Long enough to cover connect+introspect for every driver, short enough that a hang still ends. */
const APP_LIFETIME_MS = 120_000
const MCP_READY_TIMEOUT_MS = 45_000
const PER_DRIVER_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

const env = (name) => {
  const raw = process.env[name]
  return raw !== undefined && raw !== '' ? raw : null
}

/**
 * One row per driver. `config` is the exact `ConnectionConfig` the MCP `connect`
 * tool takes, which is also what the connect dialog builds — so a passing row
 * says the dialog's output shape is accepted by the driver, not just that some
 * hand-tuned config is.
 */
function buildTargets() {
  const rows = []
  const pg = env('PEEK_TEST_PG_URL')
  if (pg) rows.push({ name: 'postgres', config: { driverId: 'postgres', url: pg, label: 'smoke-pg' } })

  const redis = env('PEEK_TEST_REDIS_URL')
  if (redis) rows.push({ name: 'redis', config: { driverId: 'redis', url: redis, label: 'smoke-redis' } })

  const qdrant = env('PEEK_TEST_QDRANT_URL')
  if (qdrant) rows.push({ name: 'qdrant', config: { driverId: 'qdrant', url: qdrant, label: 'smoke-qdrant' } })

  const mysql = env('PEEK_TEST_MYSQL_URL')
  if (mysql) rows.push({ name: 'mysql', config: { driverId: 'mysql', url: mysql, label: 'smoke-mysql' } })

  const sqlite = env('PEEK_TEST_SQLITE_FILE')
  if (sqlite) rows.push({ name: 'sqlite', config: { driverId: 'sqlite', file: sqlite, label: 'smoke-sqlite' } })

  return rows
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

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

function launchApp({ port, configDir, userDataDir }) {
  // Resolving through the `electron` package rather than a hard-coded path keeps
  // this working on whatever platform the workspace installed a binary for.
  const electronBin = process.env['PEEK_ELECTRON_BIN'] ?? electronBinaryPath()

  const childEnv = { ...process.env }
  // Inherited from whatever spawned this script, it would turn the Electron
  // binary into a bare node runtime and no window (or MCP server) would appear.
  delete childEnv['ELECTRON_RUN_AS_NODE']
  childEnv['PEEK_MCP_PORT'] = String(port)
  childEnv['PEEK_CONFIG_DIR'] = configDir
  childEnv['PEEK_FORWARD_CONSOLE'] = '1'
  // The app's own deadman switch. Left unset with --keep-open so the window can
  // be poked at by hand after the checks have run.
  if (!KEEP_OPEN) childEnv['PEEK_SMOKE_EXIT_MS'] = String(APP_LIFETIME_MS)

  const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`], {
    cwd: DESKTOP_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logLines = []
  const capture = (stream, tag) => {
    stream.setEncoding('utf8')
    let buffered = ''
    stream.on('data', (piece) => {
      buffered += piece
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        logLines.push(`[${tag}] ${line}`)
        if (process.env['PEEK_SMOKE_VERBOSE'] === '1') console.log(`[app/${tag}] ${line}`)
      }
    })
  }
  capture(child.stdout, 'out')
  capture(child.stderr, 'err')

  return { child, logLines }
}

function electronBinaryPath() {
  // The `electron` package's main export is the path string to the binary, so
  // resolving it from this workspace beats hard-coding a platform-specific path.
  const mod = createRequire(join(DESKTOP_DIR, 'package.json'))('electron')
  if (typeof mod !== 'string') throw new Error('the electron package did not resolve to a binary path')
  return mod
}

/** Poll for the endpoint file the app writes once its MCP server is listening. */
async function waitForEndpoint(configDir, child) {
  const path = join(configDir, 'mcp.json')
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited early with code ${child.exitCode}`)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed.url === 'string' && typeof parsed.token === 'string') return parsed
    } catch {
      // not written yet, or half-written
    }
    await delay(250)
  }
  throw new Error(`the MCP endpoint file never appeared at ${path}`)
}

/* ------------------------------------------------------------------ */
/* Driving the app                                                     */
/* ------------------------------------------------------------------ */

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

async function withTimeout(promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A tool's `data`, which the registry emits as a second text block after the
 * prose one. Parsing that block beats scraping the prose: it is the same value
 * the tool handed back, not a rendering of it.
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

/** First node in the tree carrying a `ref`, i.e. the first thing `open_view` can show. */
function firstOpenableRef(nodes) {
  for (const node of nodes ?? []) {
    if (node.ref) return node
    const nested = firstOpenableRef(node.children)
    if (nested) return nested
  }
  return null
}

/**
 * Connect one driver, expand its namespace root, and stream rows out of the
 * first thing that can be opened.
 *
 * All three stages have to pass, because each proves something the previous one
 * does not. `connect` covers the handshake and core's capability self-check.
 * `introspect` covers the driver-RPC channel. Only opening a view exercises the
 * data plane — the cursor, the chunk framing, and the MessagePort that carries
 * frames from the driver host to the renderer without passing through main —
 * which is the part a viewer actually exists to do.
 */
async function exerciseDriver(client, target) {
  const connectResult = await withTimeout(
    client.callTool({ name: 'connect', arguments: { config: target.config } }),
    PER_DRIVER_TIMEOUT_MS,
    `connect(${target.name})`,
  )
  const connectText = textOf(connectResult)
  if (connectResult.isError === true) throw new Error(`connect failed:\n${connectText}`)

  const match = /Connection\s+(\S+)\s+is\s+(\w+)/.exec(connectText)
  if (!match) throw new Error(`could not read a connId out of the connect result:\n${connectText}`)
  const [, connId, status] = match
  if (status !== 'ready') throw new Error(`connection ${connId} came up as "${status}", not ready:\n${connectText}`)

  // depth 3 is the tool's maximum, and it is the minimum that reaches something
  // openable on every driver: postgres nests database → schema → table, while
  // sqlite and qdrant reach a ref one or two levels up. Walking a fixed depth
  // rather than a per-driver one is deliberate — the point is that a caller who
  // knows nothing about the database gets to a viewable ref the same way.
  const introspectResult = await withTimeout(
    client.callTool({ name: 'introspect', arguments: { connId, depth: 3, maxNodes: 120 } }),
    PER_DRIVER_TIMEOUT_MS,
    `introspect(${target.name})`,
  )
  const introspectText = textOf(introspectResult)
  if (introspectResult.isError === true) throw new Error(`introspect failed:\n${introspectText}`)

  const nodeCount = /:\s+(\d+)\s+node\(s\)/.exec(introspectText)
  const nodes = nodeCount ? Number(nodeCount[1]) : 0
  if (nodes < 1) throw new Error(`introspect returned no namespace nodes:\n${introspectText}`)

  const capabilities = /"capabilities":\s*\[([^\]]*)\]/.exec(connectText)
  const caps = capabilities ? capabilities[1].replace(/["\s]/g, '') : ''

  // --- data plane -------------------------------------------------------
  const treeNodes = toolData(introspectResult)
  if (!Array.isArray(treeNodes)) {
    throw new Error(`introspect returned no structured node data:\n${introspectText.slice(0, 600)}`)
  }
  const openable = firstOpenableRef(treeNodes)
  if (!openable) {
    throw new Error(
      `introspect found ${nodes} node(s) but not one of them carries a ref, so nothing can be opened:\n` +
        `${introspectText.slice(0, 600)}`,
    )
  }

  const openResult = await withTimeout(
    client.callTool({
      name: 'open_view',
      arguments: { spec: { kind: 'table', connId, ref: openable.ref }, waitMs: 15_000 },
    }),
    PER_DRIVER_TIMEOUT_MS,
    `open_view(${target.name})`,
  )
  const openText = textOf(openResult)
  if (openResult.isError === true) throw new Error(`open_view failed:\n${openText}`)

  const resultLine = /Result\s+\S+:\s+(\w+)\s+·\s+(\d+)\s+rows/.exec(openText)
  if (!resultLine) {
    throw new Error(`open_view on ${openable.name} never reported a settled result:\n${openText}`)
  }
  const [, resultStatus, rowText] = resultLine
  if (resultStatus === 'error') throw new Error(`the scan of ${openable.name} failed:\n${openText}`)

  return {
    connId,
    nodes,
    capabilities: caps,
    opened: openable.name,
    rows: Number(rowText),
    resultStatus,
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const targets = buildTargets()
  if (targets.length === 0) {
    console.error('No targets configured. Set at least one PEEK_TEST_*_URL / PEEK_TEST_SQLITE_FILE.')
    process.exit(2)
  }

  const configDir = mkdtempSync(join(tmpdir(), 'peek-smoke-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-smoke-udd-'))
  const port = await pickFreePort()

  console.log(`smoke: launching the built app on MCP port ${port}`)
  console.log(`smoke: targets — ${targets.map((t) => t.name).join(', ')}`)
  const { child, logLines } = launchApp({ port, configDir, userDataDir })

  let client = null
  const results = []
  let failures = 0

  try {
    const endpoint = await waitForEndpoint(configDir, child)
    console.log(`smoke: MCP is up at ${endpoint.url}`)

    client = new Client({ name: 'peek-smoke', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    })
    await withTimeout(client.connect(transport), 20_000, 'MCP handshake')

    const tools = await client.listTools()
    console.log(`smoke: ${tools.tools.length} tools exposed — ${tools.tools.map((t) => t.name).join(', ')}`)

    for (const target of targets) {
      try {
        const info = await exerciseDriver(client, target)
        results.push({ name: target.name, ok: true, ...info })
        console.log(
          `  PASS ${target.name.padEnd(9)} ${info.nodes} node(s); ` +
            `scanned "${info.opened}" → ${info.rows} row(s) (${info.resultStatus})  [${info.capabilities}]`,
        )
      } catch (error) {
        failures += 1
        results.push({ name: target.name, ok: false, error: String(error?.message ?? error) })
        console.log(`  FAIL ${target.name.padEnd(9)} ${String(error?.message ?? error).split('\n')[0]}`)
      }
    }
  } catch (error) {
    failures += 1
    console.error(`smoke: aborted — ${String(error?.message ?? error)}`)
  } finally {
    if (client) await client.close().catch(() => {})
    if (!KEEP_OPEN) {
      child.kill('SIGTERM')
      // Give `before-quit` its chance to reap driver processes before SIGKILL.
      const stopped = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        delay(8000).then(() => false),
      ])
      if (!stopped) child.kill('SIGKILL')
      rmSync(configDir, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  console.log('\n--- summary ---')
  for (const r of results) {
    console.log(
      r.ok
        ? `PASS ${r.name}: ${r.nodes} node(s), scanned "${r.opened}" → ${r.rows} row(s), caps [${r.capabilities}]`
        : `FAIL ${r.name}: ${r.error}`,
    )
  }

  if (failures > 0) {
    console.log('\n--- app log (tail) ---')
    for (const line of logLines.slice(-60)) console.log(line)
  }

  console.log(
    `\nsmoke: ${results.filter((r) => r.ok).length}/${targets.length} driver(s) connected and introspected`,
  )
  process.exit(failures > 0 ? 1 : 0)
}

await main()
