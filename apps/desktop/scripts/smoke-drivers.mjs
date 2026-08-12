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
 * One row needs no environment at all. `echo` is a package from
 * `fixtures/packages/echo`, copied into the run's config directory before the
 * app starts and answering out of two constant rows, so it runs on any machine
 * — and it is the row that covers what the others cannot: a database peek only
 * knows about because it read a directory. See `ECHO_FIXTURE` below.
 *
 * Exit code 0 = every attempted driver connected and introspected.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

import { Cdp } from './cdp.mjs'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const KEEP_OPEN = process.argv.includes('--keep-open')

/**
 * A package built outside this repository, dropped into the run's own
 * `<configDir>/packages/` before the app starts.
 *
 * It is the only row in this file that needs no service, which is worth stating
 * plainly: every other target is skipped on a machine with no containers, so
 * without this one the suite can report success having exercised nothing. It is
 * also the only row that covers the *loading* path — the five shipped packages
 * are laid out by the app itself, so a build that could read `~/.peek/packages/`
 * and only ever find what it put there would pass on all of them.
 */
const ECHO_FIXTURE = join(DESKTOP_DIR, 'fixtures/packages/echo')

/** Long enough to cover connect+introspect for every driver, short enough that a hang still ends. */
const APP_LIFETIME_MS = 120_000
const MCP_READY_TIMEOUT_MS = 45_000
const PER_DRIVER_TIMEOUT_MS = 30_000
/** A `packages.read` round trip and the render behind it, with room to spare. */
const PANEL_TIMEOUT_MS = 10_000

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
function buildTargets({ echo }) {
  const rows = []

  // First, so a run that is going to fail on the loading path says so before it
  // spends thirty seconds per database. `registry` is what marks it as the row
  // whose point is which drivers exist, not what one of them can do.
  if (echo) {
    rows.push({
      name: 'echo',
      config: { driverId: 'echo', url: 'echo://localhost', label: 'smoke-echo' },
      registry: true,
    })
  }

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

  // Neo4j needs a password as well as a URL, and has no default for it — see the
  // note in `db-neo4j`'s live suite about failed-auth rate limiting.
  //
  // `packageView` is what makes this row worth more than the others: it is the
  // only driver contributing a self-drawn (Tier C) view kind, so it is the only
  // one whose `open_view` exercises the package path — the registration's
  // `autoFetch` composing Cypher in main, planned through the same result
  // machinery a table uses. A packaging mistake that leaves the package UI
  // unbuilt does not fail here (the frame is the renderer's business), but a
  // seam that stopped planning fetches would.
  const neo4j = env('PEEK_TEST_NEO4J_URL')
  const neo4jPassword = env('PEEK_TEST_NEO4J_PASSWORD')
  if (neo4j && neo4jPassword) {
    rows.push({
      name: 'neo4j',
      config: {
        driverId: 'neo4j',
        url: neo4j,
        user: env('PEEK_TEST_NEO4J_USER') ?? 'neo4j',
        password: neo4jPassword,
        label: 'smoke-neo4j',
      },
      packageView: {
        packageKind: 'graph',
        // The package's own MCP tool, and the only end-to-end proof that one
        // reaches the wire at all: `verify-chat-security.mjs` shows the name is
        // offered, this shows the call works against the *packaged* build.
        // `probe` fetches an argument the tool cannot be given from a fixture —
        // an elementId is assigned by the server.
        tool: 'expand_node',
        probe: 'MATCH (n:PeekSmoke) RETURN elementId(n) AS id LIMIT 1',
      },
    })
  }

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

/**
 * Stage the `echo` package **beside** the config directory, not inside it.
 *
 * It used to be copied into `<configDir>/packages/` before the launch, because
 * the app scanned that directory once on the way up and nothing could change it
 * afterwards. `packages.install` (design §2.7) is what changed: the package is
 * now dropped in through the running app, which is a strictly larger claim —
 * everything the pre-launch copy proved still has to hold, and it has to hold
 * without a restart.
 *
 * The staging directory is deliberately named something other than `echo`, so
 * that "the installed directory is the manifest's id, not the source folder's
 * name" is a property this run actually exercises.
 */
function stageEchoFixture(root) {
  if (!existsSync(ECHO_FIXTURE)) return null
  const staged = join(root, 'echo-1.0.0')
  cpSync(ECHO_FIXTURE, staged, { recursive: true })
  return staged
}

function launchApp({ port, cdpPort, configDir, userDataDir }) {
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

  const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${String(cdpPort)}`], {
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

  // --- the package path, for a driver that contributes a view kind -------
  //
  // A second `open_view`, with a spec the kernel has no schema for. What it
  // proves is the whole Tier C seam short of the pixels: `view.open` accepts a
  // `package` spec, main finds the registration, the registration composes a
  // statement, and it comes back through the same result machinery — the same
  // "Result …: done · N rows" line a table produces. Nothing about this is
  // neo4j-specific; the row declares it.
  let packageRows = null
  let packageTool = null
  if (target.packageView) {
    const packageResult = await withTimeout(
      client.callTool({
        name: 'open_view',
        arguments: {
          spec: { kind: 'package', packageKind: target.packageView.packageKind, connId },
          waitMs: 15_000,
        },
      }),
      PER_DRIVER_TIMEOUT_MS,
      `open_view(${target.name}, ${target.packageView.packageKind})`,
    )
    const packageText = textOf(packageResult)
    if (packageResult.isError === true) throw new Error(`open_view(package) failed:\n${packageText}`)
    const packageLine = /Result\s+\S+:\s+(\w+)\s+·\s+(\d+)\s+rows/.exec(packageText)
    if (!packageLine) {
      throw new Error(
        `a ${target.packageView.packageKind} view opened but never fetched — the registration's `
          + `autoFetch is the thing to look at:\n${packageText}`,
      )
    }
    if (packageLine[1] === 'error') throw new Error(`the ${target.packageView.packageKind} view failed:\n${packageText}`)
    packageRows = Number(packageLine[2])

    // --- and the tool that package contributed ---------------------------
    //
    // A kernel tool reaching a package view would prove nothing new. This is the
    // other direction: a tool declared in `packages/db-neo4j/src/mcp-tools.ts`,
    // collected into the same registry as the kernel's thirteen, called over the
    // same endpoint, landing on `view.update`. If the collection seam is wrong
    // the call comes back as an unknown tool; if the mapping is wrong the view
    // errors. Both are failures here.
    if (target.packageView.tool) {
      const probe = await withTimeout(
        client.callTool({
          name: 'run_query',
          arguments: { connId, text: target.packageView.probe, previewRows: 1, waitMs: 15_000 },
        }),
        PER_DRIVER_TIMEOUT_MS,
        `run_query(probe for ${target.packageView.tool})`,
      )
      const probeText = textOf(probe)
      // `elementId()` is opaque and its shape is the server's business, so this
      // takes whatever came back rather than asserting a format.
      const nodeId = /"([0-9]+:[^"]+:[0-9]+)"/.exec(probeText)?.[1]
      if (!nodeId) throw new Error(`the probe returned no elementId to expand:\n${probeText}`)

      // The uiEffects block is pretty-printed, so `"viewId": "view_…"` carries a
      // space the obvious pattern would miss.
      const viewId = /"viewId":\s*"(view_[^"]+)"/.exec(packageText)?.[1]
      if (!viewId) throw new Error(`open_view(package) reported no viewId to act on:\n${packageText}`)

      const expanded = await withTimeout(
        client.callTool({ name: target.packageView.tool, arguments: { viewId, nodeId, depth: 1 } }),
        PER_DRIVER_TIMEOUT_MS,
        `${target.packageView.tool}(${viewId})`,
      )
      const expandedText = textOf(expanded)
      if (expanded.isError === true) {
        throw new Error(`${target.packageView.tool} failed:\n${expandedText}`)
      }
      if (!expandedText.includes(nodeId)) {
        throw new Error(
          `${target.packageView.tool} succeeded but its receipt does not mention the node it was `
            + `asked to expand, so it is not clear what it did:\n${expandedText}`,
        )
      }
      packageTool = target.packageView.tool
    }
  }

  return {
    connId,
    nodes,
    capabilities: caps,
    opened: openable.name,
    rows: Number(rowText),
    resultStatus,
    ...(packageRows === null ? {} : { packageKind: target.packageView.packageKind, packageRows }),
    ...(packageTool === null ? {} : { packageTool }),
  }
}

/* ------------------------------------------------------------------ */
/* The registry, in the two places a user meets it                     */
/* ------------------------------------------------------------------ */

/**
 * `settle()`, as a page-side declaration every DOM reader below pastes in.
 *
 * Two frames is the cheap way to say "let React commit before looking". On its
 * own it is also a way to hang: the window ships `backgroundThrottling` at its
 * default, so occluding or minimising it stops `requestAnimationFrame` firing,
 * and an `awaitPromise` evaluation that never settles ends when the app's own
 * 120s deadman switch kills the process — the CDP socket goes with it and the
 * run dies with an unsettled await rather than a verdict (§4duovicies(d), the
 * exit-13 half). The timer underneath is the floor: a commit does not need a
 * frame to happen, only to be painted.
 */
const SETTLE_FN = `const settle = () => Promise.race([
      new Promise((r) => { requestAnimationFrame(() => { requestAnimationFrame(r) }) }),
      new Promise((r) => { setTimeout(r, 200) }),
    ])`

/** Every `{…}` in the connect tool's description that parses as JSON. */
function connectExamples(description) {
  const parsed = []
  for (const match of description.matchAll(/\{[^{}]*\}/g)) {
    try {
      parsed.push(JSON.parse(match[0]))
    } catch {
      // prose that happens to be in braces
    }
  }
  return parsed
}

/**
 * Every option in the connect dialog's driver picker, read out of the window.
 *
 * Through the *rendered* `<select>` rather than through the bridge value behind
 * it, because the two are not the same claim. `installedPackages` arriving in
 * preload says main answered `IPC.PACKAGES_READ`; an `<option>` says the window
 * installed that answer before its first render and the dialog projected it.
 * Between them sits the ordering `renderer/main.tsx` calls out as the one that
 * fails silently — a picker filled from an empty registry draws once and never
 * corrects itself.
 */
async function connectDialogDrivers(cdp, { reopen = true } = {}) {
  const state = await connectDialogState(cdp, { reopen })
  if (state.error) throw new Error(`${state.error}${state.text ? `\n${state.text}` : ''}`)
  if (state.selected === null) throw new Error('the connect dialog has no driver picker')
  return state.options
}

/**
 * The same read, kept whole: which drivers are offered, which one the form
 * **opened on**, whether `＋` was clickable at all, and what the dialog says.
 *
 * The selection is a separate claim from the list, and until design 2026-08-11
 * nothing read it. It was a compiled-in `'postgres'`, so uninstalling that one
 * package turned opening this dialog into a lookup with no manifest behind it —
 * and the throw landed in a *render*, which unmounts the window rather than
 * breaking the dialog. Hence the two departures from the reader this replaces:
 * the selection comes back beside the options, and a missing element is reported
 * rather than thrown, with the page text attached — because the interesting
 * failure is the one where there is no sidebar left to read.
 */
async function connectDialogState(cdp, { reopen = true } = {}) {
  return await cdp.evaluate(`(async () => {
    ${SETTLE_FN}
    const plus = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '＋')
    if (!plus) {
      // No sidebar at all is the shape a render error takes: React unmounts the
      // tree and ErrorBoundary draws over the whole window. The text comes back
      // because it carries the message that killed it.
      return { error: 'the sidebar has no new-connection button', text: document.body.innerText.slice(0, 400) }
    }
    const plusDisabled = plus.disabled === true
    ${
      reopen
        ? `if (!plusDisabled) {
      plus.click()
      // React commits on a microtask; a frame is more than enough and costs nothing.
      await settle()
    }`
        : `await settle()`
    }
    // Not just "a modal dialog": the settings panel is one too, and it is opened
    // by the checks either side of this one. Its own reader tells it apart by the
    // tabpanel it contains, so this tells them apart the same way rather than by
    // an aria-label, which is translated. (No backticks in here: this comment is
    // inside a template literal, and one would end it.)
    const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((d) => d.querySelector('[role="tabpanel"]') === null) ?? null
    const select = document.getElementById('peek-driver')
    return {
      plusDisabled,
      hasDialog: dialog !== null,
      options: select ? [...select.options].map((o) => o.value) : [],
      selected: select ? select.value : null,
      text: dialog ? dialog.innerText : '',
    }
  })()`)
}

/** Shut the dialog through its own ✕, so the next `＋` mounts a fresh one. */
async function closeConnectDialog(cdp) {
  await cdp.evaluate(`(async () => {
    ${SETTLE_FN}
    const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((d) => d.querySelector('[role="tabpanel"]') === null) ?? null
    if (!dialog) return
    const close = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '✕')
    if (close) close.click()
    await settle()
  })()`)
}

/**
 * Open the settings dialog on the section that draws the package table.
 *
 * Opened with the real shortcut rather than by reaching into a store: `⌘,` is a
 * `window` keydown listener (`useGlobalKeys`), so a synthesized event runs the
 * same path a keypress does. On macOS there is no gear button to click — the
 * entry point is the application menu, which CDP cannot reach. `openSettings`
 * sets a section rather than toggling one, so running this twice reopens on the
 * default section and rescans, which is what makes it safe to retry.
 *
 * The Databases tab is found by *what it opens*, not by its position in the tab
 * list and not by its label: an index goes stale the day a section is inserted
 * before it, and a label is translated. Only one section draws a table.
 */
async function openPackagesPanel(cdp) {
  return await cdp.evaluate(`(async () => {
    ${SETTLE_FN}
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Comma', key: ',', metaKey: true, ctrlKey: true, bubbles: true }))
    await settle()
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    if (tabs.length === 0) return { error: 'the settings dialog did not open on Mod+Comma' }
    for (const tab of tabs) {
      tab.click()
      await settle()
      if (document.querySelector('[role="tabpanel"] table')) return {}
    }
    return { error: 'no settings section draws a package table' }
  })()`)
}

/** One pass over the open table: its row groups, or why they could not be read. */
async function readPackagesPanel(cdp) {
  return await cdp.evaluate(`(async () => {
    ${SETTLE_FN}
    await settle()
    const table = document.querySelector('[role="tabpanel"] table')
    if (!table) return { error: 'the package table is not on screen' }

    // Grouped the way the table is: a row per database, with the package-level
    // cells starting the group. A continuation row has three cells because the
    // source and the buttons are spanning down from the row above — so cell
    // count, not a rowspan attribute, is what says where a package begins. It is
    // the same fact read off the element rather than off React's output.
    const groups = []
    for (const tr of table.tBodies[0].rows) {
      const id = tr.querySelector('th span')?.textContent?.trim() ?? ''
      const cells = [...tr.cells]
      if (cells.length === 5) {
        const actions = cells[cells.length - 1]
        groups.push({ ids: [id], span: actions.rowSpan, buttons: actions.querySelectorAll('button').length })
      } else if (cells.length === 3 && groups.length > 0) {
        groups[groups.length - 1].ids.push(id)
      } else {
        // Not a wait: React commits a row whole, so a cell count this table
        // never produces is a verdict about the table, not a half-drawn frame.
        return { malformed: 'row for ' + id + ' has ' + cells.length + ' cells; expected 5 (starts a package) or 3 (continues one)' }
      }
    }
    return { groups }
  })()`)
}

/**
 * The settings panel's package table, read out of the rendered DOM once it says
 * something — `until` is what "something" means to the caller.
 *
 * The other window-side projection of the registry, and it is not the picker's
 * claim restated: the picker draws driver ids off a synchronous module slot,
 * while this table's *rows* come from `packages.read` — an asynchronous round
 * trip — and only its display names and capabilities come from the slot. Design
 * §2.8(b) is the join, and a join is exactly the kind of thing that keeps
 * working when one of its two sides has stopped moving.
 *
 * That round trip is why this waits instead of reading once. The `<thead>` is on
 * screen the moment the section mounts and the rows land a round trip later, so
 * a single read caught the table empty roughly one run in four and aborted the
 * whole smoke before it reached anything about packages at all (§4duovicies(d)).
 * A judgement that stops itself a quarter of the time is one people put a retry
 * around, and a retried judgement has stopped judging.
 *
 * `until` is a readiness condition, not the assertion: the default only asks
 * that the table has answered at all, and the callers keep their own claims
 * about *what* it answered. Where a caller is waiting on the panel to notice a
 * change — the one read taken without reopening — the wait is that claim, so
 * `what` has to spell it out well enough to stand as the failure message.
 */
async function packagesPanel(cdp, {
  reopen = true,
  until = (groups) => groups.length > 0,
  what = 'the settings panel to fill in its package table',
} = {}) {
  const deadline = Date.now() + PANEL_TIMEOUT_MS
  let groups = null
  let why = null
  for (;;) {
    why = reopen ? (await openPackagesPanel(cdp)).error ?? null : null
    if (why === null) {
      const read = await readPackagesPanel(cdp)
      if (read.malformed !== undefined) throw new Error(read.malformed)
      why = read.error ?? null
      if (why === null) {
        groups = read.groups
        if (until(groups)) return groups
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waited ${String(PANEL_TIMEOUT_MS)}ms for ${what}; `
          + (why ?? `it lists [${groups.map((group) => group.ids.join('+')).join(', ')}]`),
      )
    }
    await delay(100)
  }
}

/**
 * The table's grouping is the *package* grouping, and each group has one set of buttons.
 *
 * Checked against `packages.read` rather than against itself, which is the whole
 * point: a table that gave every database its own row of buttons would still
 * look internally consistent — every group one row, every span 1 — and would be
 * telling the user that uninstalling mysql leaves sqlite alone. It does not; one
 * package provides both. Only the command knows where the package boundaries
 * are, so it is the command this is measured against.
 *
 * It is also the §2.8(b) join asserted end to end: the row *set* comes from this
 * command and the display names come from the registry, and if the two ever
 * stopped agreeing the panel would list a package with no databases under it.
 */
async function panelGroupsArePackages(cdp, groups) {
  const listing = await invokeInWindow(cdp, 'packages.read', {})
  const expected = listing.packages.map((pkg) => pkg.driverIds.join('+'))
  const actual = groups.map((group) => group.ids.join('+'))
  if (expected.join(' | ') !== actual.join(' | ')) {
    throw new Error(
      `the settings table groups its rows as [${actual.join(', ')}] but the packages are `
        + `[${expected.join(', ')}] — uninstall is per package, so a row group that is not a package `
        + `puts a button next to the wrong set of databases`,
    )
  }
  for (const [index, group] of groups.entries()) {
    const pkg = listing.packages[index]
    if (group.span !== group.ids.length) {
      throw new Error(
        `'${pkg.id}' provides ${group.ids.length} database(s) but its button cell spans ${group.span} row(s)`,
      )
    }
    // One uninstall, plus an upgrade exactly when this build ships a newer copy.
    const wanted = pkg.upgradeVersion === undefined ? 1 : 2
    if (group.buttons !== wanted) {
      throw new Error(
        `'${pkg.id}' offers ${group.buttons} button(s); expected ${wanted} `
          + `(upgradeVersion=${pkg.upgradeVersion ?? 'none'})`,
      )
    }
  }
}

/**
 * Shut the settings dialog again, so the next DOM read is not made through a mask.
 *
 * By its own close control rather than by Escape: Escape belongs to
 * `useModalDialog`, which listens on the dialog element, and a synthesized event
 * aimed at `window` would only look like it worked. The glyph is a literal in
 * the JSX and is not translated, so matching on it survives a language switch —
 * unlike the "Done" beside it.
 *
 * **Reached through its tabpanel, not by `[role=dialog]`.** More than one dialog
 * can be on screen, `querySelector` answers with whichever is first in the DOM,
 * and closing the connect dialog by mistake is not a silent miss: it re-mounts
 * on the next `＋` and re-seeds from a connection book that has grown since,
 * which is a different driver selected for reasons this file never mentions.
 * That cost an hour. Only the settings dialog contains a tabpanel.
 */
async function closeSettingsPanel(cdp) {
  const closed = await cdp.evaluate(`(async () => {
    ${SETTLE_FN}
    const dialog = document.querySelector('[role="tabpanel"]')?.closest('[role="dialog"]')
    if (!dialog) return { ok: true }
    const close = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '✕')
    if (!close) return { error: 'the settings dialog has no close button' }
    close.click()
    await settle()
    const still = document.querySelector('[role="tabpanel"]')
    return still === null ? { ok: true } : { error: 'the settings dialog would not close' }
  })()`)
  if (closed.error) throw new Error(closed.error)
}

/**
 * The two registry projections a driver row cannot speak for.
 *
 * `exerciseDriver` proves that *one* driver works end to end, which it would
 * keep doing if the window's picker were empty and the connect tool's examples
 * were a compile-time list: both are read by a human or an AI, not by this
 * script's happy path. They are the other half of "a package on disk is a
 * package peek offers", so they are asserted where the package is known to be
 * on disk and nowhere else.
 */
async function checkRegistryProjections({ client, cdp, driverId }) {
  const tools = await client.listTools()
  const connect = tools.tools.find((t) => t.name === 'connect')
  if (!connect) throw new Error('the MCP server exposes no `connect` tool')
  // Parsed rather than matched as a substring: the examples are a package's own
  // `mcpConnectExample` strings, so their whitespace is the package author's to
  // choose and an assertion about it would fail on a formatting difference.
  if (!connectExamples(connect.description).some((ex) => ex.driverId === driverId)) {
    throw new Error(
      `the connect tool's description offers no ${driverId} example, so an AI client cannot learn the `
        + `config shape of a package that is installed:\n${connect.description}`,
    )
  }

  const options = await connectDialogDrivers(cdp)
  if (!options.includes(driverId)) {
    throw new Error(
      `the window's connect dialog offers [${options.join(', ')}] — ${driverId} is installed and main `
        + `accepts connections to it, but nobody can start one from the UI`,
    )
  }
  return { drivers: options }
}

/* ------------------------------------------------------------------ */
/* Hot loading (design §2.7)                                           */
/* ------------------------------------------------------------------ */

/**
 * Run one command through the window's own bridge.
 *
 * Through the renderer rather than over MCP because these three verbs have no
 * MCP tool — they are kernel verbs a person drives from the settings panel — and
 * `window.peek.invoke` is the exact path that panel takes. It also means the
 * assertions below are made against a window that has been *told*, rather than
 * against main's copy of the answer.
 */
async function invokeInWindow(cdp, name, input) {
  const answer = await cdp.evaluate(
    `window.peek.invoke(${JSON.stringify(name)}, ${JSON.stringify(input)})`,
  )
  if (!answer || answer.ok !== true) {
    throw new Error(`${name} failed: ${answer?.error?.message ?? JSON.stringify(answer)}`)
  }
  return answer.data
}

/** Whether `connect` accepts a driver id at all — the structured refusal, not a socket. */
async function connectIsOffered(client, driverId) {
  const result = await withTimeout(
    client.callTool({ name: 'connect', arguments: { config: { driverId, url: `${driverId}://localhost` } } }),
    PER_DRIVER_TIMEOUT_MS,
    `connect(${driverId})`,
  )
  return { ok: result.isError !== true, text: textOf(result) }
}

/** The tool names a live MCP session would answer `tools/list` with, right now. */
async function toolNames(client) {
  const listed = await withTimeout(client.listTools(), PER_DRIVER_TIMEOUT_MS, 'tools/list')
  return listed.tools.map((tool) => tool.name)
}

/**
 * The tool names a package's manifest declares, read off the directory itself.
 *
 * Off the fixture rather than written here, on the same grounds as everything
 * else in this file: what is under test is that peek publishes what the package
 * declares, and a name restated in the harness would agree with the harness.
 */
function declaredToolNames(sourceDir) {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'peek-package.json'), 'utf8'))
  return (manifest.tools ?? []).map((tool) => tool.name)
}

/**
 * Install a package into a running app and prove all five steps of §2.7 landed.
 *
 * Each assertion covers a different consumer of the registry, and none of them
 * implies the others: main accepts the connection, the MCP tool list moved *and
 * said so*, and the window's picker — which reads its registry synchronously
 * during render and would happily keep drawing a stale one — offers it.
 */
async function hotInstall({ client, cdp, sourceDir, driverId, notifications }) {
  const before = await connectDialogDrivers(cdp)
  if (before.includes(driverId)) {
    throw new Error(`${driverId} is already in the picker before it was installed: [${before.join(', ')}]`)
  }
  const refused = await connectIsOffered(client, driverId)
  if (refused.ok) throw new Error(`connect accepted ${driverId} before its package was installed`)

  // Read on the session that is already open, so that the `tools/list` compared
  // after the install is the same session answering differently — not a fresh
  // handshake, which is the thing §4sedecies(b) tried and found did not help.
  const declared = declaredToolNames(sourceDir)
  const toolsBefore = await toolNames(client)
  const early = declared.filter((name) => toolsBefore.includes(name))
  if (early.length > 0) {
    throw new Error(`tools/list already offers [${early.join(', ')}] before ${driverId} was installed`)
  }

  // The settings panel, opened *before* the install and left open across it.
  // Everything below about it is the same trap the picker taught last round: a
  // panel re-read because it was re-opened proves nothing about whether it is
  // subscribed to anything.
  const panelBefore = await packagesPanel(cdp)
  if (panelBefore.some((group) => group.ids.includes(driverId))) {
    throw new Error(`the settings panel already lists ${driverId} before it was installed`)
  }
  await panelGroupsArePackages(cdp, panelBefore)

  const seen = notifications.length
  const receipt = await invokeInWindow(cdp, 'packages.install', { dir: sourceDir })
  if (receipt.id !== driverId) throw new Error(`packages.install answered with id '${receipt.id}'`)

  // The notification is what a live MCP client learns from; without it a session
  // that already listed the tools never asks again.
  await waitFor(() => notifications.length > seen, 5000, 'notifications/tools/list_changed after install')

  // And what it learns has to be *different*, which is a separate claim from the
  // notification arriving (§4duodevicies(d)). Until then the tool list was fixed
  // when the server was built, so this could only ever have returned what the
  // line above already had.
  const toolsAfter = await toolNames(client)
  const unlisted = declared.filter((name) => !toolsAfter.includes(name))
  if (unlisted.length > 0) {
    throw new Error(
      `${driverId} declares [${declared.join(', ')}] and tools/list still answers `
        + `[${toolsAfter.join(', ')}] — the notification arrived and the list behind it did not move`,
    )
  }

  // Calling one, on the same session. It must fail, and it must fail the way a
  // structured refusal fails: the fixture declares a tool and ships no mapping
  // for it, which is what makes listing-without-forking observable at all.
  if (declared.length > 0) {
    const called = await withTimeout(
      client.callTool({ name: declared[0], arguments: { text: 'ping' } }),
      PER_DRIVER_TIMEOUT_MS,
      `${declared[0]}()`,
    )
    if (called.isError !== true) {
      throw new Error(`${declared[0]} answered successfully, but ${driverId} ships no mapping for it`)
    }
  }

  // **Without reopening it.** Clicking `＋` again puts a fresh object into the
  // sidebar's dialog state, which re-renders the picker for a reason that has
  // nothing to do with packages — and would make this pass with no subscription
  // at all. Read from the dialog that has been open since before the install and
  // the only thing that can have refreshed it is `packagesReplaced`.
  const after = await connectDialogDrivers(cdp, { reopen: false })
  if (!after.includes(driverId)) {
    throw new Error(
      `the window's connect dialog offers [${after.join(', ')}] — ${driverId} was just installed and `
        + `the dialog was open the whole time, so nobody can start a connection to it`,
    )
  }

  // Same read, same dialog, no reopening: the panel's row set comes from
  // `packages.read`, so this is the one assertion that the window re-asks that
  // command when the registry moves rather than only when it is mounted. Which
  // is a claim about *whether* it re-asks, so the row arriving is what is waited
  // for — the broadcast and the re-read behind it are two hops, and pinning them
  // to the frame after the install would be asserting a schedule nobody promised.
  const panelAfter = await packagesPanel(cdp, {
    reopen: false,
    until: (groups) => groups.some((group) => group.ids.includes(driverId)),
    what: `the open settings panel to list '${driverId}' — it was just installed and the panel was open the `
      + `whole time, so a row that never arrives is an uninstall button next to a stale list`,
  })
  await panelGroupsArePackages(cdp, panelAfter)
  await closeSettingsPanel(cdp)
  return {
    installed: receipt.id,
    picker: after,
    panel: panelAfter.map((g) => g.ids.join('+')),
    tools: declared,
  }
}

/**
 * Uninstall it again, and prove every route to it is gone (acceptance 13).
 *
 * The connection opened by `exerciseDriver` is still live when this runs, on
 * purpose: closing it is §2.7 step 1, and a receipt that does not name it would
 * mean a driver host left holding a `driver.mjs` that has been deleted.
 */
async function hotUninstall({ client, cdp, driverId, declaredTools = [], notifications }) {
  const seen = notifications.length
  const receipt = await invokeInWindow(cdp, 'packages.uninstall', { id: driverId })
  if (receipt.closedConnIds.length === 0) {
    throw new Error(`packages.uninstall closed no connection, but ${driverId} had one open`)
  }
  await waitFor(() => notifications.length > seen, 5000, 'notifications/tools/list_changed after uninstall')

  const after = await connectDialogDrivers(cdp)
  if (after.includes(driverId)) {
    throw new Error(`the picker still offers ${driverId} after its package was uninstalled`)
  }
  const tools = await client.listTools()

  // **The first sentence of acceptance 13, on the session that was open across
  // the uninstall.** §4sedecies(b) measured this failing three ways — same
  // session, fresh session, and after a full restart with the directory gone —
  // because `packageTools` mapped a compile-time constant. Asked here rather
  // than after a re-handshake because the same-session answer is the one that
  // was hardest to move: it needs the registration table reconciled, not just
  // the registry re-read (§4duodevicies(d)).
  const stillListed = declaredTools.filter((name) => tools.tools.some((tool) => tool.name === name))
  if (stillListed.length > 0) {
    throw new Error(
      `tools/list still offers [${stillListed.join(', ')}] after ${driverId} was uninstalled — `
        + `the model is being shown a tool for a database peek cannot connect to`,
    )
  }

  const connect = tools.tools.find((t) => t.name === 'connect')
  if (connectExamples(connect?.description ?? '').some((ex) => ex.driverId === driverId)) {
    throw new Error(`the connect tool still advertises ${driverId} after its package was uninstalled`)
  }
  const refused = await connectIsOffered(client, driverId)
  if (refused.ok) throw new Error(`connect still accepts ${driverId} after its package was uninstalled`)

  // The panel is opened after the uninstall here rather than held across it: the
  // half that needed the open dialog was proven on the way in, and what is left
  // to check is acceptance 13's — no surface still offers the package.
  const panel = await packagesPanel(cdp)
  if (panel.some((group) => group.ids.includes(driverId))) {
    throw new Error(`the settings panel still lists ${driverId} after its package was uninstalled`)
  }
  await closeSettingsPanel(cdp)

  return {
    closedConnIds: receipt.closedConnIds.length,
    picker: after,
    refusal: refused.text.split('\n')[0],
    tools: declaredTools,
  }
}

/**
 * The connect dialog outlives every driver it can open on (design 2026-08-11).
 *
 * Nothing above covers this, and the gap was shipped: the dialog seeded a blank
 * form with a compiled-in `'postgres'`, so uninstalling that one package made
 * opening it a lookup for a manifest that is not there. That throw runs inside a
 * render, and React answers a render error by unmounting the tree — so the
 * failure was not "the dialog defaults badly", it was a window replaced by
 * ErrorBoundary with no way back to the settings panel that could reinstall
 * anything.
 *
 * The loop is the shape of the bug rather than a scripted case: uninstall
 * whichever package provides the driver the dialog just **opened on**, and ask
 * again. Whatever the seed prefers, it is removed next, until nothing is left.
 * Two assertions ride along at each step:
 *
 *   - the still-open dialog names the driver that went away instead of dying
 *     with the window. That is the case a user reaches by uninstalling from the
 *     settings panel with the dialog open, and it is the one the guard in
 *     `ConnectDialog` is actually for;
 *   - the reopened dialog defaults to something it also offers. A default
 *     outside its own picker is the class of bug this whole check exists for.
 *
 * It runs last because it leaves the app with no databases at all.
 */
async function checkDialogOutlivesItsDrivers({ cdp }) {
  // Read before anything is removed: the bridge value is a preload-time snapshot
  // and does not move with `packages.uninstall`. Which package owns a driver does
  // not move either, so a snapshot is the right shape here.
  const owners = await cdp.evaluate(`(() => {
    const installed = window.peek.installedPackages
    return Object.fromEntries(installed.drivers.map((d) => [d.manifest.driverId, d.packageId]))
  })()`)

  // Start from no dialog. Clicking `＋` while one is already open re-seeds the
  // sidebar's state without unmounting the component, so the form would keep the
  // driver it was mounted with and this would be checking the wrong thing.
  await closeConnectDialog(cdp)

  const removed = []
  const defaults = []
  for (;;) {
    const state = await connectDialogState(cdp)
    if (state.error) throw new Error(`${state.error}\n${state.text ?? ''}`)
    if (state.plusDisabled) {
      // Packages, not drivers: `sql` ships mysql and sqlite, so one uninstall
      // takes two ids out of the picker and counting drivers here would report a
      // package that is still installed when none is.
      const packages = new Set(Object.values(owners))
      if (packages.size > removed.length) {
        throw new Error(
          `the new-connection button is disabled while ${packages.size - removed.length} package(s) are `
            + `still installed`,
        )
      }
      break
    }
    if (state.selected === null) {
      throw new Error(
        `the connect dialog opened with no driver picker while packages are still installed `
          + `(removed so far: [${removed.join(', ')}])\n${state.text}`,
      )
    }
    if (!state.options.includes(state.selected)) {
      throw new Error(
        `the connect dialog opened on '${state.selected}', which is not among the drivers it offers `
          + `[${state.options.join(', ')}]`,
      )
    }
    defaults.push(state.selected)

    const owner = owners[state.selected]
    if (owner === undefined) throw new Error(`no installed package claims driver '${state.selected}'`)
    await invokeInWindow(cdp, 'packages.uninstall', { id: owner })
    removed.push(owner)

    // The dialog is still the one that was open across the uninstall — not
    // reopened — so this is the render that used to throw.
    const during = await connectDialogState(cdp, { reopen: false })
    if (during.error) {
      throw new Error(
        `uninstalling '${owner}' while the connect dialog was open took the window down\n${during.text ?? ''}`,
      )
    }
    if (!during.text.includes(state.selected)) {
      throw new Error(
        `the open connect dialog does not say what happened to '${state.selected}' after its package was `
          + `uninstalled; it shows: ${JSON.stringify(during.text.slice(0, 200))}`,
      )
    }
    await closeConnectDialog(cdp)
  }

  // The window is still there to be asked — the point of the whole check.
  const empty = await connectDialogState(cdp)
  if (empty.error) throw new Error(`${empty.error}\n${empty.text ?? ''}`)
  if (empty.hasDialog) {
    throw new Error('the disabled new-connection button still opened a dialog with no database to connect to')
  }
  return { removed, defaults }
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`${what} never arrived`)
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const configDir = mkdtempSync(join(tmpdir(), 'peek-smoke-cfg-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'peek-smoke-udd-'))

  const stagingDir = mkdtempSync(join(tmpdir(), 'peek-smoke-src-'))

  // The fixture is missing from a checkout that was pruned to `out/`, and that
  // is an environment fact like an absent container: the run goes on without it
  // and says so, rather than failing on a file it was never given.
  const echoSource = stageEchoFixture(stagingDir)
  if (!echoSource) console.log(`smoke: no echo fixture at ${ECHO_FIXTURE}; the from-disk package row is skipped`)

  const targets = buildTargets({ echo: echoSource !== null })
  if (targets.length === 0) {
    console.error('No targets configured. Set at least one PEEK_TEST_*_URL / PEEK_TEST_SQLITE_FILE.')
    process.exit(2)
  }

  const port = await pickFreePort()
  const cdpPort = await pickFreePort()

  console.log(`smoke: launching the built app on MCP port ${port}`)
  console.log(`smoke: targets — ${targets.map((t) => t.name).join(', ')}`)
  const { child, logLines } = launchApp({ port, cdpPort, configDir, userDataDir })

  let client = null
  let cdp = null
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

    // Counted before anything is installed, so `hotInstall` can wait on the
    // notification arriving rather than on a timer.
    const listChanged = []
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged.push(Date.now())
    })
    // Filled by `hotInstall` off the fixture's own manifest, and read by
    // `hotUninstall` to check the same names left again.
    let echoTools = []

    const tools = await client.listTools()
    console.log(`smoke: ${tools.tools.length} tools exposed — ${tools.tools.map((t) => t.name).join(', ')}`)

    cdp = await Cdp.attach(cdpPort)
    await cdp.waitForFirstPaint()

    // Install echo through the running app, before the target loop reaches it.
    // Everything the pre-launch copy used to prove still has to hold below; what
    // is added is that it holds without a restart (design §2.7).
    if (echoSource) {
      const installed = await hotInstall({
        client,
        cdp,
        sourceDir: echoSource,
        driverId: 'echo',
        notifications: listChanged,
      })
      echoTools = installed.tools
      console.log(
        `smoke: installed '${installed.installed}' at runtime; picker offers ${installed.picker.join('/')}; `
          + `settings panel lists ${installed.panel.join(', ')}; `
          + `tools/list gained ${installed.tools.length === 0 ? 'nothing' : installed.tools.join(', ')}`,
      )
    }

    for (const target of targets) {
      try {
        const info = await exerciseDriver(client, target)
        if (target.registry === true) {
          const seen = await checkRegistryProjections({ client, cdp, driverId: target.config.driverId })
          info.drivers = seen.drivers
        }
        results.push({ name: target.name, ok: true, ...info })
        console.log(
          `  PASS ${target.name.padEnd(9)} ${info.nodes} node(s); ` +
            `scanned "${info.opened}" → ${info.rows} row(s) (${info.resultStatus})` +
            (info.packageKind === undefined ? '' : `; ${info.packageKind} view → ${info.packageRows} row(s)`) +
            (info.packageTool === undefined ? '' : `; ${info.packageTool} ok`) +
            (info.drivers === undefined ? '' : `; picker offers ${info.drivers.join('/')}`) +
            `  [${info.capabilities}]`,
        )
      } catch (error) {
        failures += 1
        results.push({ name: target.name, ok: false, error: String(error?.message ?? error) })
        console.log(`  FAIL ${target.name.padEnd(9)} ${String(error?.message ?? error).split('\n')[0]}`)
      }
    }

    // Last, so it runs against a package that has been fully exercised and still
    // has a live connection: closing that connection is §2.7 step 1.
    if (echoSource) {
      try {
        const removed = await hotUninstall({
          client,
          cdp,
          driverId: 'echo',
          declaredTools: echoTools,
          notifications: listChanged,
        })
        console.log(
          `smoke: uninstalled 'echo' at runtime; ${removed.closedConnIds} connection(s) closed, ` +
            `picker offers ${removed.picker.join('/')}, connect says "${removed.refusal}", ` +
            `tools/list dropped ${removed.tools.length === 0 ? 'nothing' : removed.tools.join(', ')}`,
        )
      } catch (error) {
        failures += 1
        console.log(`  FAIL echo-uninstall ${String(error?.message ?? error).split('\n')[0]}`)
        results.push({ name: 'echo-uninstall', ok: false, error: String(error?.message ?? error) })
      }
    }

    // After everything else, because it uninstalls every package that is left:
    // the app this hands back can open no database at all.
    try {
      const survived = await checkDialogOutlivesItsDrivers({ cdp })
      console.log(
        `smoke: the connect dialog outlived its own drivers — opened on ${survived.defaults.join(' → ')}, `
          + `uninstalled ${survived.removed.join('/')}, window still standing`,
      )
    } catch (error) {
      failures += 1
      console.log(`  FAIL dialog-outlives ${String(error?.message ?? error).split('\n')[0]}`)
      results.push({ name: 'dialog-outlives', ok: false, error: String(error?.message ?? error) })
    }
  } catch (error) {
    failures += 1
    console.error(`smoke: aborted — ${String(error?.message ?? error)}`)
  } finally {
    cdp?.close()
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
      rmSync(stagingDir, { recursive: true, force: true })
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
