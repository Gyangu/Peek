#!/usr/bin/env electron
/*
 * ==================================================================
 * The hardening probe. It asks a real window to do the three things it must
 * refuse, and watches it refuse them.
 * ==================================================================
 *
 * Design 2026-08-07 §4.8 items 36, 37 and 38, plus §4.4 item 18. All four were
 * "有实现无断言" in the §4sedecies ledger: `main/window-hardening.ts` has carried
 * the navigation and permission guards since §2.10 landed and nothing had ever
 * made one fire, and the two boundary claims the front end rests on — a package
 * frame has no network, and a package id is an origin — were asserted only as
 * **strings** in `hardening.test.ts`.
 *
 * ## Why this cannot be a unit test
 *
 * `will-navigate`, `will-frame-navigate` and the two permission handlers are
 * Chromium behaviours, not arithmetic. A `node --test` file can assert that
 * `hardenWindow` *registers* listeners; it cannot assert that Chromium asks
 * them, and "we registered a handler" is precisely the claim that was already
 * true while the property went unverified. So this runs under Electron, calls
 * the real `hardenWindow` on a real `BrowserWindow`, and grades what the page
 * observes. `window-hardening.ts` exists as its own module for this reason —
 * see its header.
 *
 * The same gap, one level down, is why items 18 and 38 are here rather than
 * beside their string assertions:
 *
 *  - **18** — `assert.match(PACKAGE_CSP, /connect-src 'none'/)` grades a string.
 *    It would keep passing if the header never reached the document, if the
 *    scheme's privileges quietly re-opened fetch, or if Chromium stopped
 *    enforcing the clause. What this file grades instead is a **server that
 *    never heard from the frame** — the only instrument that can tell "refused"
 *    from "sent and failed".
 *  - **38** — `assert.equal(PACKAGE_SCHEME_PRIVILEGES.standard, true)` grades a
 *    boolean in a file. §2.10 is explicit that getting it wrong degrades the
 *    frame to an opaque origin **without an error**, so a string check is
 *    exactly the shape of guard that cannot see the failure it names. Two
 *    package ids write to `localStorage` and Cache Storage here, and each must
 *    read back its own.
 *
 * ## The mechanism under test is deliberately the only one left standing
 *
 * peek denies these things twice over, and a probe that let the *other*
 * mechanism answer would pass while `hardenWindow` was gutted. That is the
 * mistake §2.10 already made once with `partition` (a check that measured the
 * wrong mechanism), so the fixture here removes peek's second layers on purpose:
 *
 *  - the real `PackageFrame` iframe carries `allow=""`, which denies every
 *    permission-policy-gated feature before Electron is consulted. The probe's
 *    iframe carries the widest `allow` list instead, so a denial can only come
 *    from `setPermissionRequestHandler`.
 *  - the probe's host document ships no CSP, so `frame-src` cannot be what stops
 *    the frame from navigating.
 *
 * What is *not* replaced: the package frame is served by the real
 * `installPackageProtocol` on the real `peek-package://` scheme, so it is
 * cross-origin to the host and a secure context, exactly as a package view is.
 *
 * ## Reverse verification is a flag, not a story
 *
 *     pnpm --filter @peek/desktop probe:hardening -- --plant=<name>
 *
 * plants a defect and **inverts the verdict**: the run exits 0 only if exactly
 * the checks that own that defect went red — an exact set, not "the named one is
 * among them", so a plant that also took out a neighbour is a failed reverse
 * check rather than a passing one. Each plant removes a guard the real code
 * installed, so a check that cannot fail cannot be mistaken for coverage.
 * `--plant=list` prints them.
 *
 * ## It always terminates
 *
 * Same rules as `render-probe/probe-main.mjs`, and for the same reason (two
 * predecessors on that task were killed by a foreground Electron that never
 * exited): a global watchdog that is meant to fire, a deadline around every
 * page-side await, `process.exitCode` published before anything is asked to shut
 * down, and `app.exit(code)` last.
 *
 * ## Running it
 *
 *     pnpm --filter @peek/desktop probe:hardening
 *
 * Needs no build: it imports the TypeScript sources directly (Electron 43 ships
 * Node 24, which strips types on its own). Exit 0 = every check passed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * The guard comes before anything that needs Electron, and `require` rather than
 * `import` is what lets it: a static `import ... from 'electron'` fails during
 * module instantiation under plain node, so a friendly message placed after it
 * is unreachable code. Same lesson, same shape, as `render-probe/probe-main.mjs`.
 */
if (process.versions.electron === undefined) {
  process.stderr.write(
    'probe-hardening: this is an Electron main script, not a Node one — the guards it grades are\n' +
      'Chromium behaviours. Run it with `pnpm --filter @peek/desktop probe:hardening`.\n',
  )
  process.exit(1)
}

/*
 * Extensionless relative imports, resolved the way the repository writes them.
 * The same hooks `node:test` gets from `bus/__tests__/ts-resolve.hooks.mjs`;
 * duplicated rather than imported because that file is a `--import` preload and
 * this one needs the hooks installed *before* the first `require` below, which
 * an ESM `import` of it could not guarantee.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        return nextResolve(`${specifier}/index.ts`, context)
      }
    }
  },
})

const require_ = createRequire(import.meta.url)
const { app, BrowserWindow, protocol } = require_('electron')

// The real ones. A probe that re-implemented either would be grading its own copy.
const { hardenWindow } = require_('../src/main/window-hardening.ts')
const { installPackageProtocol, registerPackageScheme } = require_('../src/main/packages/protocol.ts')
const { PACKAGE_CSP, PACKAGE_SCHEME, resolvePackageAsset } = require_('../src/main/packages/assets.ts')

/* ------------------------------------------------------------------ */
/* Plants — the seeded defects, and the checks that must catch them     */
/* ------------------------------------------------------------------ */

/**
 * Each plant takes a guard away, after the real code installed it.
 *
 * Removal rather than a rewrite of the source: the point of a reverse check is
 * that the check goes red when the *property* stops holding, and deleting the
 * listener is the smallest edit that does that without also changing what the
 * probe is looking at.
 *
 * `catches` may name more than one check, and where it does that is a measured
 * fact rather than a tolerance: the window and subframe navigation properties
 * share a listener, and a permission that is granted has to be visible both in
 * the handler's answer and in what the page then got. Every list here was run
 * and corrected against what actually went red — `nav-window` was written
 * expecting one and produces two, for the reason in its own comment.
 *
 * Three shapes, because the three guards are installed at three different
 * moments and a plant has to be applied where its guard is:
 *
 *  - `apply(win)` — the window guards, removed after `hardenWindow` set them;
 *  - `csp` — the document CSP, which is a **response header**, so relaxing it
 *    means serving the package differently (`installRelaxedProtocol`);
 *  - `sameOrigin` — a fixture change, because "two origins" is a property of
 *    which URLs the two frames were pointed at.
 *
 * There is deliberately **no plant for `standard: false`**. Getting that
 * privilege wrong is the failure §2.10 warns about, but it does not degrade one
 * check — a non-standard scheme has no URL host, so `resolvePackageAsset` finds
 * nothing and *every* frame 404s. It is verified by hand (edit
 * `PACKAGE_SCHEME_PRIVILEGES`, watch `frame-first-load` and everything under it
 * go red together) and pinned as a string by `hardening.test.ts`; a plant here
 * would fail the "only its own check" rule and would be claiming a precision it
 * does not have. `one-origin` is the plant that actually models a storage
 * boundary that stopped existing.
 */
const PLANTS = {
  'first-load': {
    // The regression this probe was written by finding: a `will-frame-navigate`
    // guard with no exemption for a frame's own first load refuses the package
    // its document, and the product symptom is a Tier C view that is blank
    // forever. Added as a plant so the fix has a check that has been seen red.
    what: 'refuse every frame navigation, first load included',
    catches: 'frame-first-load',
    apply: (win) => {
      win.webContents.on('will-frame-navigate', (event) => {
        event.preventDefault()
      })
    },
  },
  'nav-window': {
    /*
     * **Both** listeners, and that is the finding rather than a convenience.
     *
     * Dropping `will-navigate` alone changes nothing a check can see: Electron 43
     * emits `will-frame-navigate` first, and when that prevents the navigation
     * `will-navigate` is never emitted at all — so in a hardened window the main
     * frame is guarded by the frame event, and `will-navigate` is the fallback
     * that only gets a turn once the frame event is gone (measured with each
     * listener registered alone). A plant that removed just the fallback would
     * leave every check green and would be reverse verification in name only.
     */
    what: 'drop both navigation listeners hardenWindow installed',
    catches: ['window-navigation', 'frame-navigation'],
    apply: (win) => {
      win.webContents.removeAllListeners('will-navigate')
      win.webContents.removeAllListeners('will-frame-navigate')
    },
  },
  'nav-frame': {
    // Takes the subframe property down on its own: `will-navigate` is still
    // there, and with the frame event gone it is what refuses the main frame —
    // which is the evidence that the two listeners cover different frames rather
    // than one of them being redundant.
    what: 'drop the will-frame-navigate listener hardenWindow installed',
    catches: 'frame-navigation',
    apply: (win) => {
      win.webContents.removeAllListeners('will-frame-navigate')
    },
  },
  'permission-request': {
    /*
     * Two checks, and the second is not collateral damage — it is the point.
     * `permissions-observed` grades what the page got, so a handler that grants
     * *must* show up there as well; if it did not, the two checks would not be
     * two ends of one chain and one of them would be measuring nothing.
     *
     * Only the two permissions Chromium routes through the request handler move.
     * The clipboard is answered by the check handler alone (see `VIA_REQUEST`),
     * so it stays refused here — which is why `permissions-check` is not on this
     * list and is on the next one.
     */
    what: 'replace the permission request handler with one that grants',
    catches: ['permissions-request', 'permissions-observed'],
    apply: (win) => {
      win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(true)
      })
    },
  },
  'permission-check': {
    // Same pairing as above, reaching all three names: `navigator.permissions
    // .query` goes to the check handler for every one of them, so granting here
    // is visible in each — and in what the page then reports.
    what: 'replace the permission check handler with one that grants',
    catches: ['permissions-check', 'permissions-observed'],
    apply: (win) => {
      win.webContents.session.setPermissionCheckHandler(() => true)
    },
  },
  'csp-connect': {
    what: "serve the package CSP with `connect-src *` in place of `connect-src 'none'`",
    catches: 'frame-network',
    // Derived from the real header with one clause swapped, so every other thing
    // the CSP says is still the thing that ships. Swapped rather than deleted:
    // `default-src 'none'` is `connect-src`'s fallback, so a *removed* clause
    // would still block and the plant would prove nothing.
    csp: PACKAGE_CSP.replace("connect-src 'none'", 'connect-src *'),
  },
  'one-origin': {
    what: 'point both storage frames at one package id, so the two share an origin',
    catches: 'origin-isolation',
    sameOrigin: true,
  },
}

const plant = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--plant='))
  if (arg === undefined) return null
  const name = arg.slice('--plant='.length)
  const entry = PLANTS[name]
  if (entry === undefined) {
    process.stderr.write(
      (name === 'list' ? 'probe-hardening: the seeded defects are:\n' : `probe-hardening: no plant named ${JSON.stringify(name)}. The seeded defects are:\n`) +
        Object.entries(PLANTS)
          .map(([k, v]) => `    --plant=${k.padEnd(20)} [${[v.catches].flat().join(", ")}] ${v.what}\n`)
          .join(''),
    )
    process.exit(1)
  }
  return { name, ...entry }
})()

/* ------------------------------------------------------------------ */
/* Termination, reporting, judgement                                    */
/* ------------------------------------------------------------------ */

const WATCHDOG_MS = 60_000

/** Unbuffered, because `finish()` exits on the next statement. */
function say(text, fd = 1) {
  try {
    writeSync(fd, text)
  } catch {
    process.stdout.write(text)
  }
}

let phase = 'starting'
const setPhase = (p) => {
  phase = p
}

const watchdog = setTimeout(() => {
  process.stderr.write(
    `\nprobe-hardening: WATCHDOG — still in phase "${phase}" after ${String(WATCHDOG_MS)} ms.\n` +
      'The probe is required to terminate on its own, so this is a failure, not a wait.\n',
  )
  process.exit(1)
}, WATCHDOG_MS)

/** Bounds one page-side await. A page that never settles must not stop the run. */
async function withDeadline(label, ms, work) {
  let timer = null
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${String(ms)} ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

const results = []
const notes = []

/** Records a verdict. Never throws: the run reports every check, not the first. */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

const note = (line) => notes.push(line)

let scratch = null
let witnessServer = null

/**
 * The single exit, ordered exactly as `render-probe/probe-main.mjs` learned to
 * order it: the code is published before anything is asked to shut down, because
 * `app.quit()` is graceful, gets there first, and once exited 0 with a failing
 * check on stdout.
 */
function finish(code) {
  clearTimeout(watchdog)
  process.exitCode = code
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true })
  // Closed here rather than after its check, because a request the frame should
  // not have been able to make can still be in flight then — see the settle.
  witnessServer?.close()
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.destroy()
    } catch {
      /* a window that is already gone is the state we wanted */
    }
  }
  app.quit()
  app.exit(code)
}

/**
 * Prints the ledger and decides the exit code.
 *
 * Under `--plant`, the verdict is inverted **and narrowed**: the named check must
 * be the one that went red. A plant that took down some other check would
 * otherwise read as a successful reverse verification while proving nothing
 * about the check it claims to exercise.
 */
function report() {
  const width = Math.max(...results.map((r) => r.name.length))
  let text = '\n'
  for (const r of results) {
    text += `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}\n`
  }
  if (notes.length > 0) text += `\n${notes.map((n) => `  note  ${n}\n`).join('')}`

  const failed = results.filter((r) => !r.ok).map((r) => r.name)
  if (plant === null) {
    text += `\n${failed.length === 0 ? `probe-hardening: ${String(results.length)} check(s) passed.` : `probe-hardening: ${String(failed.length)} check(s) FAILED: ${failed.join(', ')}`}\n`
    say(text, failed.length === 0 ? 1 : 2)
    finish(failed.length === 0 ? 0 : 1)
    return
  }

  /*
   * The demand is an **exact set**, not "the named check is among the reds".
   *
   * A plant that also took down a neighbour would otherwise read as a successful
   * reverse verification while saying nothing about the check it names. Most
   * plants own one check; `nav-window` owns two, because the only way to make the
   * window property fail is to remove a listener the subframe property also
   * depends on — see its comment. Stating that as a list keeps it a measured
   * fact instead of a tolerated extra red.
   */
  const expected = Array.isArray(plant.catches) ? plant.catches : [plant.catches]
  const want = [...expected].sort().join(',')
  const got = [...failed].sort().join(',')
  text +=
    `\nprobe-hardening: plant "${plant.name}" (${plant.what})\n` +
    `  expected red: ${expected.join(', ')}\n` +
    `  actually red: ${failed.length === 0 ? '(nothing)' : failed.join(', ')}\n` +
    `${want === got ? '  the reverse check holds: the plant is caught, by exactly its own check(s).\n' : '  REVERSE CHECK FAILED — see above.\n'}`
  say(text, want === got ? 1 : 2)
  finish(want === got ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/* Fixture                                                              */
/* ------------------------------------------------------------------ */

/**
 * A host document and three packages under a throwaway packages root.
 *
 * Each package is a real one as far as `resolvePackageAsset` is concerned —
 * `<root>/<id>/ui/index.html`, id matching `PACKAGE_ID_PATTERN` — because the
 * frames have to be served by the production handler to be on production
 * origins. Their bodies are inert: nothing in a frame's own document is under
 * test, and its CSP is `script-src 'self'` anyway, so everything the probe runs
 * in there is injected from main.
 *
 * Three and not one because §4.4 item 18 and §4.8 item 38 need frames the
 * permission and navigation checks are not also standing on:
 *
 *  - `probe` is the one carrying the widest `allow` list and the one that gets
 *    navigated at, which is destructive;
 *  - `probe-a` and `probe-b` are two **different package ids**, which is the
 *    whole subject of item 38 — the claim is that a package id is an origin, and
 *    a check with one id in it could not tell that from a shared store.
 *
 * The two carry `name=` so the probe can address them by frame name rather than
 * by URL: under `--plant=one-origin` their URLs are identical, and a lookup that
 * could not tell them apart would make the plant unobservable rather than caught.
 */
function buildFixture(sameOrigin) {
  const packagesRoot = join(scratch, 'packages')
  for (const id of ['probe', 'probe-a', 'probe-b']) {
    mkdirSync(join(packagesRoot, id, 'ui'), { recursive: true })
    writeFileSync(
      join(packagesRoot, id, 'ui', 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${id}</title><p>package frame ${id}</p>\n`,
    )
  }

  const hostPage = join(scratch, 'host.html')
  writeFileSync(
    hostPage,
    '<!doctype html><meta charset="utf-8"><title>hardening probe host</title>\n' +
      // The widest `allow` the platform will take, which is the opposite of what
      // ships: see the header. Whatever denies a permission below has to be
      // Electron, because permissions policy here denies nothing.
      '<iframe id="pkg" src="peek-package://probe/index.html"\n' +
      '        allow="geolocation *; clipboard-read *; clipboard-write *; camera *; microphone *; midi *"\n' +
      '        style="width:600px;height:400px;border:0"></iframe>\n' +
      '<iframe name="probe-a" src="peek-package://probe-a/index.html" style="width:1px;height:1px;border:0"></iframe>\n' +
      `<iframe name="probe-b" src="peek-package://${sameOrigin ? 'probe-a' : 'probe-b'}/index.html" style="width:1px;height:1px;border:0"></iframe>\n`,
  )
  return { packagesRoot, hostPage }
}

/**
 * `installPackageProtocol` with one clause of the CSP replaced — `--plant=csp-connect`
 * and nothing else.
 *
 * A copy of the production handler's body rather than a seam cut into it:
 * `connect-src` travels as a response header, so the only way to relax it is to
 * serve the package differently, and production code does not grow an injection
 * point for a probe. What is *not* copied is the decision this file is grading —
 * `resolvePackageAsset` is the real one, and the CSP is the real string with one
 * substitution (see the plant).
 */
function installRelaxedProtocol(packagesRoot, csp) {
  protocol.handle(PACKAGE_SCHEME, async (request) => {
    const target = resolvePackageAsset(request.url, packagesRoot)
    if (target === null) return new Response('Not found', { status: 404 })
    const body = await readFile(target.file)
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': target.mediaType,
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  })
}

/**
 * A server the package frame must not be able to reach, and this process can.
 *
 * The evidence item 18 asks for is that the request "没发出去" — was never sent —
 * and only something outside the renderer can say that. A rejected promise
 * cannot: a connection refused by the OS and one refused by CSP look the same
 * from inside the page.
 *
 * `upgrade` is listened for separately because a WebSocket handshake never
 * becomes a `request` event, and the one scheme whose block is easiest to get
 * wrong would otherwise be recorded as silence.
 */
async function startWitnessServer() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '(no url)')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => {
    hits.push(req.url ?? '(no url)')
    socket.destroy()
  })
  // The probe must terminate on its own; a listening socket is exactly the kind
  // of handle that keeps a run alive past its last check.
  server.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, hits, base: `http://127.0.0.1:${String(server.address().port)}` }
}

/* ------------------------------------------------------------------ */
/* Instruments                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wrap the session's two permission setters so that whatever `hardenWindow`
 * installs is recorded as it answers.
 *
 * Installed **before** `hardenWindow` and delegating to its handler, so the log
 * is a transcript of the real handler rather than a second opinion. Without it a
 * denial in the page proves only that *something* denied — and Chromium denies a
 * few of these on its own, which is exactly the false pass this probe exists to
 * avoid.
 */
function recordPermissions(session) {
  const log = []
  const setRequest = session.setPermissionRequestHandler.bind(session)
  const setCheck = session.setPermissionCheckHandler.bind(session)
  session.setPermissionRequestHandler = (handler) => {
    setRequest((contents, permission, callback, details) => {
      handler(
        contents,
        permission,
        (granted) => {
          log.push({ via: 'request', permission, granted })
          callback(granted)
        },
        details,
      )
    })
  }
  session.setPermissionCheckHandler = (handler) => {
    setCheck((contents, permission, origin, details) => {
      const granted = handler(contents, permission, origin, details)
      log.push({ via: 'check', permission, granted })
      return granted
    })
  }
  return log
}

/**
 * Record whether the guard called `preventDefault` on each navigation attempt.
 *
 * Listeners added *after* `hardenWindow`, so they run after it and read the flag
 * it set. This is the assertion that needs no network: a blocked navigation and
 * an attempted-then-failed one both leave the page where it was, and only
 * `defaultPrevented` tells them apart.
 */
function recordNavigation(webContents) {
  const log = []
  webContents.on('will-navigate', (event, url) => {
    // `will-navigate` is main-frame-only by definition, so the field is filled in
    // here rather than read off the payload: it lets the checks below select by
    // *which frame moved* instead of by which listener happened to see it.
    log.push({ event: 'will-navigate', url, isMainFrame: true, prevented: event.defaultPrevented })
  })
  webContents.on('will-frame-navigate', (event) => {
    log.push({
      event: 'will-frame-navigate',
      url: event.url,
      isMainFrame: event.isMainFrame,
      prevented: event.defaultPrevented,
    })
  })
  return log
}

/**
 * Every console line the window and its frames produce, with the frame that
 * produced it.
 *
 * Item 18 asks for a console record of the interception, not just a failed
 * promise, and the reason is worth keeping: a package author debugging a blank
 * view has the console and nothing else, and a CSP that blocked silently would
 * be indistinguishable from a bug in their own code. Attribution is kept because
 * a violation logged against the *host* document would be a different story
 * about which document the header reached.
 */
function recordConsole(webContents) {
  const log = []
  webContents.on('console-message', (event) => {
    log.push({ level: event.level, message: String(event.message), frame: event.frame?.url ?? '(gone)' })
  })
  return log
}

/* ------------------------------------------------------------------ */
/* The page-side half                                                   */
/* ------------------------------------------------------------------ */

/** How long one permission gets to be answered before the answer counts as absent. */
const PERMISSION_MS = 8000

/**
 * Asks for three permissions and reports what came back.
 *
 * Every await is bounded on the page side as well as by `withDeadline`: a
 * geolocation callback that is never invoked is a plausible failure mode of a
 * missing handler, and `'(no answer)'` is a fact worth reporting rather than a
 * hang worth waiting out.
 */
const ASK_FOR_PERMISSIONS = `(async () => {
  const bounded = (p) => Promise.race([
    p,
    new Promise((r) => setTimeout(() => r('(no answer)'), ${String(PERMISSION_MS)})),
  ])
  const out = { origin: location.origin, secure: isSecureContext }
  out.notifications = await bounded(
    Notification.requestPermission().then((s) => s, (e) => 'threw:' + e.name),
  )
  out.geolocation = await bounded(new Promise((r) => {
    navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied:' + e.code))
  }))
  out.clipboard = await bounded(
    navigator.clipboard.readText().then(() => 'granted', (e) => 'rejected:' + e.name),
  )
  out.query = {}
  for (const name of ['notifications', 'geolocation', 'clipboard-read']) {
    out.query[name] = await bounded(
      navigator.permissions.query({ name }).then((s) => s.state, (e) => 'threw:' + e.name),
    )
  }
  return out
})()`

const GO_TO_EXAMPLE = "location.href = 'https://example.com/'"

/** The five ways a document can open a connection, and the paths they aim at. */
const NETWORK_PATHS = {
  fetch: '/fetch',
  xhr: '/xhr',
  websocket: '/ws',
  eventsource: '/es',
  sendbeacon: '/beacon',
}

/** How long a socket that is going to answer has to answer before silence is the answer. */
const SOCKET_MS = 2000

/**
 * Try to reach the witness server five ways, and report what came back.
 *
 * Runs in the frame's own world, so it is the *document's* CSP that applies —
 * which is the point. `script-src 'self'` does not stop an injected evaluation
 * (that is what DevTools is), and `connect-src` is not supposed to care where
 * the script came from: if it did, this probe would be measuring an exemption
 * rather than the rule.
 */
const ATTEMPT_NETWORK = (base) => `(async () => {
  const violations = []
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI })
  })
  const base = ${JSON.stringify(base)}
  const paths = ${JSON.stringify(NETWORK_PATHS)}
  const attempts = {}
  const record = async (name, work) => {
    try { attempts[name] = await work() } catch (e) { attempts[name] = 'threw:' + e.name }
  }
  await record('fetch', async () => 'resolved ' + (await fetch(base + paths.fetch)).status)
  await record('xhr', () => new Promise((done) => {
    const x = new XMLHttpRequest()
    x.onload = () => done('loaded ' + x.status)
    x.onerror = () => done('refused')
    x.open('GET', base + paths.xhr)
    x.send()
  }))
  await record('websocket', () => new Promise((done) => {
    const w = new WebSocket(base.replace('http://', 'ws://') + paths.websocket)
    w.onopen = () => { w.close(); done('opened') }
    w.onerror = () => done('refused')
    setTimeout(() => done('(no answer)'), ${String(SOCKET_MS)})
  }))
  await record('eventsource', () => new Promise((done) => {
    const s = new EventSource(base + paths.eventsource)
    s.onopen = () => { s.close(); done('opened') }
    s.onerror = () => { s.close(); done('refused') }
    setTimeout(() => { s.close(); done('(no answer)') }, ${String(SOCKET_MS)})
  }))
  // \`sendBeacon\` answers **before** the CSP check runs, so it returns true for a
  // request that is about to be dropped. Its return value is therefore reported
  // and not graded; what grades it is the violation it raises and the server it
  // does not reach.
  await record('sendbeacon', () => 'returned ' + navigator.sendBeacon(base + paths.sendbeacon, 'x'))
  // Violation events are queued against the task queue, not raised synchronously
  // with the call that was blocked.
  await new Promise((done) => setTimeout(done, 300))
  return { origin: location.origin, secure: isSecureContext, attempts, violations }
})()`

/**
 * The key every storage write in this file uses.
 *
 * An `https:` URL, and it has to be: the Cache API refuses to store a request
 * whose scheme it does not know, so a relative key would resolve to
 * `peek-package://…` and throw before the isolation question was ever asked.
 * Nothing dereferences it — `.invalid` is reserved for exactly this.
 */
const CACHE_KEY = 'https://peek-boundary.invalid/mark'
const STORAGE_KEY = 'peek-boundary'
const HOST_KEY = 'peek-boundary-host'

/** Write one origin's mark into both stores. */
const WRITE_STORAGE = (label) => `(async () => {
  const out = { origin: location.origin }
  try { localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(label)}); out.local = 'ok' }
  catch (e) { out.local = 'threw:' + e.name }
  try {
    const c = await caches.open(${JSON.stringify(STORAGE_KEY)})
    await c.put(new Request(${JSON.stringify(CACHE_KEY)}), new Response(${JSON.stringify(label)}))
    out.cache = 'ok'
  } catch (e) { out.cache = 'threw:' + e.name }
  return out
})()`

/**
 * Read both stores back, and list what is in them.
 *
 * The key lists are the half that answers "can it see the *window's*": a value
 * of one's own proves nothing about what else is visible, and an opaque origin —
 * the degradation §2.10 names — makes `localStorage` throw rather than return
 * the wrong thing, which is why every access here reports its exception instead
 * of falling back to null.
 */
const READ_STORAGE = `(async () => {
  const out = { origin: location.origin }
  try {
    out.local = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
    out.localKeys = Object.keys(localStorage).sort()
  } catch (e) { out.local = 'threw:' + e.name; out.localKeys = null }
  try {
    const c = await caches.open(${JSON.stringify(STORAGE_KEY)})
    const hit = await c.match(${JSON.stringify(CACHE_KEY)})
    out.cache = hit === undefined ? null : await hit.text()
    out.cacheNames = (await caches.keys()).sort()
  } catch (e) { out.cache = 'threw:' + e.name; out.cacheNames = null }
  return out
})()`

/** The window's own mark, under names no package uses. */
const HOST_STORAGE = `(async () => {
  const out = { origin: location.origin }
  try {
    localStorage.setItem(${JSON.stringify(HOST_KEY)}, 'host')
    const c = await caches.open(${JSON.stringify(HOST_KEY)})
    await c.put(new Request(${JSON.stringify(CACHE_KEY)}), new Response('host'))
    out.local = localStorage.getItem(${JSON.stringify(HOST_KEY)})
    out.localKeys = Object.keys(localStorage).sort()
    out.cacheNames = (await caches.keys()).sort()
  } catch (e) { out.local = 'threw:' + e.name; out.localKeys = null; out.cacheNames = null }
  return out
})()`

/* ------------------------------------------------------------------ */
/* The run                                                              */
/* ------------------------------------------------------------------ */

/** Long enough for a navigation to have committed if it was going to. */
const settle = () => new Promise((r) => setTimeout(r, 750))

/**
 * A package frame once it has a document, or null if it never gets one.
 *
 * `match` picks which one. Three subframes now load, and `find` on "the first
 * `peek-package://` one" would be trusting document order to stay what it is —
 * the kind of implicit dependency that turns a later fixture edit into a check
 * silently grading the wrong frame.
 */
async function packageFrame(win, match) {
  const deadline = Date.now() + 8000
  for (;;) {
    const frame = win.webContents.mainFrame.frames.find((f) => f.url.startsWith('peek-package://') && match(f))
    if (frame !== undefined) return frame
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Every subframe URL, read fresh: a committed cross-origin navigation replaces the frame object. */
const frameUrls = (win) => win.webContents.mainFrame.frames.map((f) => f.url || '(empty)')

async function run() {
  setPhase('building the fixture')
  const { packagesRoot, hostPage } = buildFixture(plant?.sameOrigin === true)
  if (plant?.csp === undefined) installPackageProtocol(packagesRoot)
  else installRelaxedProtocol(packagesRoot, plant.csp)

  const witness = await startWitnessServer()
  witnessServer = witness.server

  setPhase('opening the window')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    // The same baseline `createWindow` uses. A window with node in it would be
    // answering a different question than the one peek ships.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  const permissions = recordPermissions(win.webContents.session)

  // The subject. Everything above this line is instrumentation; everything below
  // it grades what this call did.
  hardenWindow(win)

  const navigations = recordNavigation(win.webContents)
  const consoleLog = recordConsole(win.webContents)
  if (plant !== null) {
    // `csp` and `sameOrigin` plants were already applied above — they act on the
    // protocol handler and the fixture, both of which precede the window.
    if (plant.apply !== undefined) plant.apply(win)
    note(`plant "${plant.name}" applied: ${plant.what}`)
  }

  setPhase('loading the host page')
  await withDeadline('loadFile', 15_000, () => win.loadFile(hostPage))

  /* --- The frame has to arrive before anything can be asked of it, and
     "it arrived" is itself one of the properties: `will-frame-navigate` fires
     for a frame's own first load, and the first version of this probe caught
     `hardenWindow` refusing exactly that. A blank Tier C view is what that costs
     in the product, so it is graded rather than treated as setup. --- */

  const frame = await withDeadline('package frame', 12_000, () =>
    packageFrame(win, (f) => f.url.startsWith('peek-package://probe/')),
  )
  const frameA = await withDeadline('storage frame a', 12_000, () =>
    packageFrame(win, (f) => f.name === 'probe-a'),
  )
  const frameB = await withDeadline('storage frame b', 12_000, () =>
    packageFrame(win, (f) => f.name === 'probe-b'),
  )
  check(
    'frame-first-load',
    frame !== null && frameA !== null && frameB !== null,
    frame === null || frameA === null || frameB === null
      ? `a package frame never got a document; subframes are at ${frameUrls(win).join(', ')}`
      : `served at ${[frame, frameA, frameB].map((f) => f.origin).join(', ')}`,
  )
  if (frame === null || frameA === null || frameB === null) {
    note('the checks below need loaded package frames, so they did not run')
    setPhase('reporting')
    report()
    return
  }

  /* --- The two below read state and change none, so they run before anything
     that navigates. --- */

  /* --- 18 (§4.4): the frame has no network, and the witness never heard from it --- */

  setPhase('attempting network from a package frame')
  // Proof the target is reachable at all. Without it, "nothing arrived" is also
  // what a server that never came up would report, and this repository has six
  // prior instances of a scan that quietly measured nothing.
  const control = await withDeadline('control request', 10_000, () =>
    fetch(`${witness.base}/control`).then(
      (r) => `answered ${String(r.status)}`,
      (e) => `FAILED: ${String(e)}`,
    ),
  )
  const controlOk = witness.hits.includes('/control') && control.startsWith('answered')
  const network = await withDeadline('network attempts', 30_000, () =>
    frameA.executeJavaScript(ATTEMPT_NETWORK(witness.base)),
  )
  // `sendBeacon` is fire-and-forget by definition, so a request that *was* going
  // to arrive can arrive after the page has finished reporting. Reading the hit
  // list any earlier would make the plant's own evidence a race.
  await settle()
  const frameHits = witness.hits.filter((path) => path !== '/control')
  note(`the frame's attempts: ${JSON.stringify(network.attempts)}`)

  // Refusals as the page sees them. `sendbeacon` is absent on purpose — see
  // ATTEMPT_NETWORK for why its return value is not evidence.
  //
  // The weakest of the four terms below, and measured to be: under
  // `--plant=csp-connect` all five requests reach the server and the page still
  // reports every one of them as refused, because the witness sends no
  // `Access-Control-Allow-Origin` and CORS rejects the *response*. A page cannot
  // tell "never sent" from "sent, answered, discarded" — which is the whole
  // reason the server is here and why this term is asserted alongside it rather
  // than instead of it.
  const REFUSED_AS = { fetch: 'threw:TypeError', xhr: 'refused', websocket: 'refused', eventsource: 'refused' }
  const apisRefused = Object.entries(REFUSED_AS).every(([name, want]) => network.attempts[name] === want)
  const blockedUris = new Set(
    network.violations.filter((v) => v.directive === 'connect-src').map((v) => v.blocked),
  )
  const wanted = Object.entries(NETWORK_PATHS).map(([name, path]) =>
    name === 'websocket' ? `${witness.base.replace('http://', 'ws://')}${path}` : `${witness.base}${path}`,
  )
  const allViolated = wanted.every((url) => blockedUris.has(url))
  const logged = consoleLog.filter(
    (line) => line.frame === frameA.url && line.message.includes("connect-src 'none'"),
  )
  check(
    'frame-network',
    controlOk && apisRefused && allViolated && logged.length > 0 && frameHits.length === 0,
    `control request ${controlOk ? 'answered' : `NOT ANSWERED (${control})`}; ` +
      `${String(frameHits.length)} of the frame's requests reached the server` +
      `${frameHits.length === 0 ? '' : ` (${frameHits.join(', ')})`}; ` +
      `${String(Object.values(REFUSED_AS).length - Object.entries(REFUSED_AS).filter(([n, w]) => network.attempts[n] === w).length)} API(s) not refused as expected; ` +
      `${String(blockedUris.size)}/${String(wanted.length)} connect-src violations; ` +
      `${String(logged.length)} console record(s) naming connect-src 'none'`,
  )

  /* --- 38 (§4.8): a package id is an origin, and storage follows origins --- */

  setPhase('writing storage from three origins')
  const host = await withDeadline('host storage', 10_000, () =>
    win.webContents.executeJavaScript(HOST_STORAGE),
  )
  const wroteA = await withDeadline('write a', 10_000, () => frameA.executeJavaScript(WRITE_STORAGE('a')))
  const wroteB = await withDeadline('write b', 10_000, () => frameB.executeJavaScript(WRITE_STORAGE('b')))
  const readA = await withDeadline('read a', 10_000, () => frameA.executeJavaScript(READ_STORAGE))
  const readB = await withDeadline('read b', 10_000, () => frameB.executeJavaScript(READ_STORAGE))
  note(`host storage: ${JSON.stringify(host)}`)
  note(`frame a wrote ${JSON.stringify(wroteA)} and reads ${JSON.stringify(readA)}`)
  note(`frame b wrote ${JSON.stringify(wroteB)} and reads ${JSON.stringify(readB)}`)

  // `b` is written last, so a shared store shows `b` on both sides. That
  // asymmetry is the whole test: two frames each reading their own value is the
  // only outcome a single store cannot produce.
  const keptOwn = readA.local === 'a' && readA.cache === 'a' && readB.local === 'b' && readB.cache === 'b'
  const distinctOrigins =
    readA.origin === 'peek-package://probe-a' && readB.origin === 'peek-package://probe-b'
  /*
   * Three outcomes, not two. An opaque origin makes `localStorage` **throw** and
   * removes `caches` altogether, so a store that could not be read at all is a
   * third state — and calling it "visible" would describe the `standard: false`
   * failure as the opposite of what it is. Measured: with that privilege
   * flipped, both frames report `origin: "null"`, `SecurityError` and
   * `ReferenceError`, and this check is the one that sees it.
   */
  const holding = (r, key) =>
    !Array.isArray(r.localKeys) || !Array.isArray(r.cacheNames)
      ? 'unreadable'
      : r.localKeys.includes(key) || r.cacheNames.includes(key)
        ? 'VISIBLE'
        : 'invisible'
  const hostSeenFromA = holding(readA, HOST_KEY)
  const hostSeenFromB = holding(readB, HOST_KEY)
  // And the other direction, which a shared store breaks just as surely: the
  // window must not be holding the packages' marks either.
  const packagesSeenFromHost = holding(host, STORAGE_KEY)
  check(
    'origin-isolation',
    keptOwn &&
      distinctOrigins &&
      hostSeenFromA === 'invisible' &&
      hostSeenFromB === 'invisible' &&
      packagesSeenFromHost === 'invisible',
    `origins ${readA.origin} / ${readB.origin} / ${host.origin}; ` +
      `a reads local=${JSON.stringify(readA.local)} cache=${JSON.stringify(readA.cache)}, ` +
      `b reads local=${JSON.stringify(readB.local)} cache=${JSON.stringify(readB.cache)}; ` +
      `the window's marks are ${hostSeenFromA}/${hostSeenFromB} from the two frames; ` +
      `the packages' marks are ${packagesSeenFromHost} from the window`,
  )

  /* --- 37: three permissions, asked from inside the package frame --- */

  setPhase('asking for permissions in the package frame')
  const asked = await withDeadline('permissions', 40_000, () => frame.executeJavaScript(ASK_FOR_PERMISSIONS))
  note(`the frame reports: ${JSON.stringify(asked)}`)
  note(`the handlers answered: ${JSON.stringify(permissions)}`)

  const answered = (via, permission) => permissions.filter((e) => e.via === via && e.permission === permission)
  const deniedBy = (via, permission) => {
    const seen = answered(via, permission)
    return seen.length > 0 && seen.every((e) => e.granted === false)
  }

  // Graded per permission and reported as one line, because "notifications was
  // never asked about" and "notifications was granted" are different defects and
  // a single boolean would hide which one happened.
  const REQUESTED = ['notifications', 'geolocation', 'clipboard-read']

  /*
   * Which of the three Chromium actually routes through the **request** handler.
   *
   * Measured, not assumed, and the difference is not cosmetic: the async
   * clipboard read is answered by the *check* handler alone, so demanding it here
   * fails a window whose permissions are all refused. Both handlers are asserted
   * — `permissions-check` below covers all three, and `permissions-observed`
   * covers what the page got — so nothing is unwatched by splitting them this
   * way; what changes is that each check now names the route it grades.
   *
   * This is the two-handler split `window-hardening.ts` claims in prose ("one
   * answers a prompt, the other answers the synchronous query some APIs make
   * before prompting"), turned into a measurement. `NOT ASKED` on a name in this
   * list is still a failure: it would mean the prompt route stopped being
   * consulted for something that used to use it.
   */
  const VIA_REQUEST = ['notifications', 'geolocation']
  const requestVerdicts = REQUESTED.map((p) => {
    const seen = answered('request', p)
    if (seen.length === 0) {
      return `${p}: not asked${VIA_REQUEST.includes(p) ? ' — EXPECTED ON THIS ROUTE' : ' (check-only route)'}`
    }
    return `${p}: ${deniedBy('request', p) ? 'refused' : 'GRANTED'}`
  })
  check(
    'permissions-request',
    VIA_REQUEST.every((p) => deniedBy('request', p)) &&
      // A permission that starts arriving here is not a failure, but it must be
      // refused when it does: the list above records today's routing, and the
      // guard is what has to hold whatever the routing turns out to be.
      REQUESTED.every((p) => answered('request', p).length === 0 || deniedBy('request', p)),
    requestVerdicts.join(', '),
  )

  const checkVerdicts = REQUESTED.map((p) => {
    const seen = answered('check', p)
    if (seen.length === 0) return `${p}: NOT ASKED`
    return `${p}: ${deniedBy('check', p) ? 'refused' : 'GRANTED'}`
  })
  check(
    'permissions-check',
    REQUESTED.every((p) => deniedBy('check', p)),
    checkVerdicts.join(', '),
  )

  // What the page actually got. The handler answering `false` and the API
  // reporting a refusal are two links of one chain, and only this end of it is
  // what a package would experience.
  check(
    'permissions-observed',
    asked.notifications === 'denied' &&
      asked.geolocation === 'denied:1' &&
      String(asked.clipboard).startsWith('rejected:') &&
      Object.values(asked.query).every((s) => s === 'denied'),
    `Notification.requestPermission → ${asked.notifications}; getCurrentPosition → ${asked.geolocation}; clipboard.readText → ${asked.clipboard}; permissions.query → ${JSON.stringify(asked.query)}`,
  )

  /* --- 36a: the package frame tries to navigate --- */

  setPhase('navigating the package frame')
  const before = navigations.length
  void frame.executeJavaScript(GO_TO_EXAMPLE).catch(() => {})
  await settle()
  const frameAttempts = navigations
    .slice(before)
    // Selected on the frame that moved, the same way `window-navigation` below
    // is, so the two checks are visibly about different frames rather than about
    // different listeners.
    .filter((e) => e.isMainFrame === false && e.url.startsWith('https://example.com'))
  // Read by URL, not by frame identity: a committed cross-origin navigation
  // swaps the `WebFrameMain` out, so holding the old one would report the state
  // of a frame that is no longer in the tree — which is the failing case.
  const subframes = frameUrls(win)
  check(
    'frame-navigation',
    frameAttempts.length > 0 &&
      frameAttempts.every((e) => e.prevented === true) &&
      subframes.some((u) => u.startsWith('peek-package://')) &&
      !subframes.some((u) => u.startsWith('https://example.com')),
    frameAttempts.length === 0
      ? `nothing fired for the subframe; subframes are at ${subframes.join(', ')}`
      : `${String(frameAttempts.length)} attempt(s), prevented=${frameAttempts.map((e) => String(e.prevented)).join(',')}; subframes still at ${subframes.join(', ')}`,
  )

  /* --- 36b: the window itself tries to navigate. Last, because a window that
     got away takes the frame with it. --- */

  setPhase('navigating the window')
  const beforeWindow = navigations.length
  void win.webContents.executeJavaScript(GO_TO_EXAMPLE).catch(() => {})
  await settle()
  /*
   * Either event may be the carrier, and in Electron 43 it is **not the one this
   * check first named**.
   *
   * Measured: Electron emits `will-frame-navigate` first, and when that
   * prevented the navigation, `will-navigate` is never emitted at all — for
   * `location.href =`, for `location.assign` with a user gesture, and for a real
   * link click alike. With only `will-navigate` registered it fires and refuses
   * normally, so it is a live fallback rather than dead code; it is simply not
   * what does the work in a hardened window.
   *
   * So this selects on **which frame tried to move**, not on which listener saw
   * it. Grading on a listener's name would have made this check red while the
   * window was, in fact, staying exactly where it was told to.
   */
  const windowAttempts = navigations
    .slice(beforeWindow)
    .filter((e) => e.isMainFrame === true && e.url.startsWith('https://example.com'))
  const windowUrlNow = win.webContents.getURL()
  check(
    'window-navigation',
    windowAttempts.length > 0 &&
      windowAttempts.every((e) => e.prevented === true) &&
      windowUrlNow.startsWith('file://'),
    windowAttempts.length === 0
      ? `nothing fired for the main frame; the window is now at ${windowUrlNow}`
      : `${String(windowAttempts.length)} attempt(s) via ${[...new Set(windowAttempts.map((e) => e.event))].join('+')}, prevented=${windowAttempts.map((e) => String(e.prevented)).join(',')}, window still at ${windowUrlNow}`,
  )

  setPhase('reporting')
  report()
}

/*
 * The probe's own profile, and item 38 is what makes it mandatory rather than
 * tidy.
 *
 * Without it Electron hands this script the *installed app's* user-data
 * directory. The probe's host page is a `file://` document and so is production's
 * window, `file://` is one origin, and the first run of this file duly read a
 * `peek.locale` it had not written — a developer's real setting, one call away
 * from being overwritten by a test. It also means storage outlives the run,
 * which for a check whose entire subject is storage is the difference between an
 * assertion and a coincidence.
 *
 * Set before ready, because `userData` is read while the app initializes;
 * `mkdtempSync` here rather than in `buildFixture` for the same reason.
 */
scratch = mkdtempSync(join(tmpdir(), 'peek-hardening-'))
app.setPath('userData', join(scratch, 'user-data'))

// `registerSchemesAsPrivileged` is ignored after ready, and its failure mode is
// a frame with an opaque origin rather than an error — so this is at module
// scope here for the same reason it is in `main/index.ts`.
registerPackageScheme()

// Destroying a window per phase would otherwise start a shutdown mid-run.
app.on('window-all-closed', () => {})

// No top-level await before this: awaiting at the top level of an ESM main entry
// stalls the ready sequence and `whenReady()` never resolves.
app.whenReady().then(
  () => {
    run().catch((error) => {
      say(`\nprobe-hardening: the run threw in phase "${phase}":\n${String(error?.stack ?? error)}\n`, 2)
      finish(1)
    })
  },
  (error) => {
    say(`\nprobe-hardening: app.whenReady() rejected: ${String(error)}\n`, 2)
    finish(1)
  },
)
