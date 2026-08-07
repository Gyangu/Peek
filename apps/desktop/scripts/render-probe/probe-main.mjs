#!/usr/bin/env electron
/*
 * ==================================================================
 * The render probe. It reads what the browser computed and painted.
 * ==================================================================
 *
 * Seven rounds of this migration added seven fences, and every round's audit
 * found a channel the new fence could not read. The shape the last audit named:
 *
 *   Every fence reads exactly **one channel** — class strings, or document
 *   order, or stylesheet text, or the artifact CSS — and this codebase routinely
 *   writes through a **second channel that outranks it**: an inline `style`, an
 *   `!important`, and the user agent's own `color-scheme` default.
 *
 * An inline `style` is in no stylesheet and in no artifact CSS; it rides in the
 * JS bundle and is written onto the element at runtime. A UA-painted
 * `accent-color` is written down *nowhere at all* — not in the source, not in
 * the artifact, not in the bundle. **No source-reading fence can ever see
 * either.** This probe is the one that can, because everything it reads is
 * downstream of every channel: `getComputedStyle`, `getBoundingClientRect`,
 * `elementFromPoint`, and the actual pixels out of `capturePage`.
 *
 * ## Reading the right channel is not the same as asking the right question
 *
 * The round after this probe shipped found the next hole one level in, and it
 * was not a channel: `contrast()` was called in exactly **one** place, so the
 * only foreground/background pair anything here graded was a user-agent-painted
 * checkbox. The palette sweep reads what the browser computed — the channel is
 * right — but it asks whether a colour is one the artifact can produce, and
 * membership cannot answer *can this be read*. One appended rule turned every
 * button in the window into a solid invisible block with both colours inside the
 * allow-set, and the probe exited 0. `legibility` is the check that closes that,
 * and §26 of the migration record is why it is a separate check rather than a
 * stricter palette. The lesson, restated because it is the one that keeps
 * recurring: **before adding a fence, ask what predicate it actually decides.**
 *
 * ## And the round after that: the fence can be right and its arithmetic wrong
 *
 * `legibility` shipped with `opacity` group order backwards — it flattened the
 * backdrop, fades included, and then faded the ink against the already-faded
 * result, which read 3.40:1 where the browser paints 3.32:1. Its calibration rig
 * stayed green throughout: the rig's expected answers had been worked out by the
 * same reasoning as the code, and not one of its five specimens had the shape
 * where the order can show — an opaque surface inside a faded group. **A rig
 * whose answers come from the model it is checking is not a rig.** The
 * specimens' answers are now photographs out of `capturePage`. The same round
 * replaced a floor on how many pairs were graded with a test of *coverage*,
 * because no absolute floor can see a third of a page quietly dropping out of
 * the walk. §27 of the record has the numbers and the two commands.
 *
 * ## The split, and why the judgements are all here
 *
 * `page-checks.js` runs in the page and **only measures**. Every judgement is
 * made here, in Node, so a failure message is written once, in the one place
 * that can name a file, a number and a way to reproduce. There is no
 * `checks.mjs` — an earlier comment in `fixture.tsx` named one, and that comment
 * has been corrected rather than the file invented. The measuring half is
 * `page-checks.js` and the judging half is this file: two files, one for each
 * side of the process boundary, is the whole taxonomy.
 *
 * ## Fail closed
 *
 * This repository has six prior instances of a scan that silently read nothing,
 * and a probe **in this same session** produced a full set of plausible numbers
 * off a page whose stylesheet had never loaded; its author caught it by
 * accident. So: no skip path exists. If the page will not build, the stylesheet
 * is missing or too small, the pane mounts nothing, the injected script does not
 * evaluate, or a check finds no subjects where it demands subjects, the probe
 * **fails**. `ProbeSetupError` is for the first class; a plain failure entry for
 * the rest. Nothing here can pass by having looked at nothing.
 *
 * ## It always terminates
 *
 * Two predecessors on this task were killed by an Electron process launched in
 * the foreground that never exited, so termination is a design requirement and
 * not an aspiration:
 *
 *  - a **global watchdog** armed before anything else runs, which prints the
 *    phase it died in and calls `process.exit`. It is not `unref`'d — it is
 *    meant to fire;
 *  - every await that touches the page goes through `withDeadline`, so a page
 *    that never settles fails in seconds instead of hanging;
 *  - `app.quit()` on **every** path, including every error path, followed by an
 *    `app.exit(code)` on a short timer so the exit code is deterministic even if
 *    Electron's graceful shutdown wedges;
 *  - `window-all-closed` is swallowed. Its default is to quit the whole app, and
 *    this probe destroys a window per pane — without this listener the second
 *    pane's `loadFile` would race a shutdown already in progress.
 *
 * ## Two Electron traps that cost real time here
 *
 *  - **No top-level `await` before `app.whenReady()`.** In an ESM main process,
 *    awaiting at the top level of the entry module stalls the ready sequence and
 *    `app.whenReady()` never resolves — measured: the watchdog fired at 20s with
 *    the app still not ready. Everything therefore hangs off
 *    `app.whenReady().then(...)`.
 *  - **`capturePage` works on a `show: false` window** (verified: a hidden
 *    500x400 window returned a 240x240 bitmap for a 120x120 CSS request), so the
 *    probe never puts a window on the user's screen. The 2x is the display's
 *    scale factor and is derived per capture, never assumed.
 *
 * ## Running it
 *
 *     pnpm --filter @peek/desktop build          # the probe measures the artifact
 *     pnpm --filter @peek/desktop probe:render   # or: it is the last step of build
 *
 * Exit 0 = every check passed. Exit 1 = a check failed or the setup did.
 */

import { readFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildProbePage, ProbeSetupError } from './build-page.mjs'
import { contrast, extractColours, hex } from './colours.mjs'

/*
 * `electron` comes in through `createRequire`, and the guard below it is the
 * entire reason.
 *
 * This file used `import { app, BrowserWindow } from 'electron'`, which works
 * under Electron and fails under plain `node` — but it fails during module
 * **instantiation**, before the first statement of this file runs. So the
 * "this needs a real browser" message, which used to sit at the bottom of the
 * file behind exactly this condition, was unreachable code: `node
 * probe-main.mjs` printed a SyntaxError about named exports and CommonJS and the
 * friendly line never executed. Measured, not assumed — that is what running it
 * printed.
 *
 * It still exited 1, so nothing was unsafe about it; what was wrong is that a
 * comment promised a diagnosis the code could not deliver, which is the same
 * failure in miniature as a check that reads as coverage and looks at nothing.
 *
 * A `require` is evaluated where it is written, so the guard can come first and
 * actually fire. Confirmed under Electron 43 through this path: `app` is an
 * object and `BrowserWindow` is a function.
 */
if (process.versions.electron === undefined) {
  process.stderr.write(
    'render-probe: this is an Electron main script, not a Node one — it needs a real browser to\n' +
      'measure. Run it with `pnpm --filter @peek/desktop probe:render`.\n',
  )
  process.exit(1)
}
const { app, BrowserWindow } = createRequire(import.meta.url)('electron')

const here = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* Plants — the seeded defects, and the checks that must catch them    */
/* ------------------------------------------------------------------ */

/*
 * A check nobody has ever seen go red is a check nobody has tested. Each entry
 * here is a real defect from this migration, wired so that
 *
 *     pnpm --filter @peek/desktop probe:render -- --plant=<name>
 *
 * plants it and **inverts the verdict**: the run exits 0 only if the named check
 * failed, and exits 1 if it passed. So the proof that a fence works is a command
 * anybody can re-run, not a paragraph in a report.
 *
 * Two properties make this safe to leave in:
 *
 *  - a plant is only ever applied when `--plant` is on the command line, and
 *    `--plant` makes success mean failure, so it cannot be the thing a green
 *    build is quietly running;
 *  - no plant writes to a source file. The stylesheet ones rewrite an in-memory
 *    copy of the artifact (`build-page.mjs` explains why that is enough); the
 *    DOM ones run in the page, after mount, in a process that is about to be
 *    destroyed.
 */
const PLANTS = {
  'color-scheme': {
    catches: 'accent-color',
    what: 'deletes `color-scheme: dark` from :root, which is the whole of §22.2',
    // Not a whole-declaration-block regex: the point is to remove *only* the
    // root declaration and leave the `.scheme-dark` utility (which the plugin
    // iframe wears) alone, so what fails is the thing being tested.
    css: (text) => text.replace(/(:root\{[^}]*?)color-scheme:\s*dark;?/, '$1'),
  },
  'inline-colour': {
    catches: 'palette',
    what: 'writes a colour into an inline `style`, the channel no stylesheet and no artifact holds',
    onPane: 'gallery',
    dom: `{
      const el = document.querySelector('button')
      if (el === null) throw new Error('plant inline-colour: no button to plant on')
      el.style.backgroundColor = '#7a3f3f'
    }`,
  },
  motion: {
    catches: 'reduced-motion',
    what: 'makes the reduced-motion override unreachable, so the connection dot keeps animating under `reduce`',
    /*
     * A width no window here will ever have, so the override's block is still
     * present and still parses but never applies. That models the real defect —
     * §23's override that was *there* and did not win — and it is why the
     * condition is not `min-width:0px`, which was the first version of this
     * plant: `0px` is always true, so the override would apply *everywhere*, the
     * dot would never animate at all, and the check would go red on its "nothing
     * animates at rest" branch instead of on the one this plant is aimed at. A
     * plant that fails for the opposite reason to its description proves nothing.
     */
    css: (text) =>
      text.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g, '@media (min-width:99999px){'),
  },
  'consent-cover': {
    catches: 'consent-reach',
    what: 'lays a transparent sheet over the consent dialog, so Accept is visible but not pressable',
    onPane: 'consent',
    dom: `{
      const cover = document.createElement('div')
      cover.setAttribute('style', 'position:fixed;inset:0;z-index:99999')
      document.body.appendChild(cover)
    }`,
  },
  'double-border': {
    catches: 'border-bands',
    what: 'asks for a two-line border at 1px, which the browser paints as one line',
    onPane: 'gallery',
    dom: `{
      const el = document.querySelector('button')
      if (el === null) throw new Error('plant double-border: no button to plant on')
      el.style.borderStyle = 'double'
      el.style.borderWidth = '1px'
    }`,
  },
  'invisible-buttons': {
    catches: 'legibility',
    what: 'paints every button one flat colour — ink, fill and border alike — so its label vanishes',
    /*
     * The defect the palette sweep structurally cannot see, and the reason
     * `legibility` exists. Both colours in this rule are colours the artifact
     * produces, so membership is satisfied and the sweep reports a clean page;
     * what is wrong is the *pair*, at 1.00:1. Appended rather than substituted
     * because `!important` in the last rule of the sheet beats everything before
     * it — which is exactly how a real one would arrive.
     */
    css: (text) =>
      text +
      '\nbutton{color:var(--color-bg-1)!important;background-color:var(--color-bg-1)!important;' +
      'border-color:var(--color-bg-1)!important}\n',
  },
  'mute-text': {
    catches: 'legibility',
    what: 'strips every text node out of the pane, so the walk has nothing to grade',
    onPane: 'gallery',
    /*
     * The other half of the proof, and the half that is easy to skip. A grader
     * that goes red on `invisible-buttons` has shown it can catch a defect; it
     * has *not* shown it would notice reading nothing, and this repository's
     * recurring failure is a scan that quietly read nothing and reported clean.
     * Layout survives — the buttons keep their boxes, so `sanity` still passes
     * and what goes red is the pair count, which is the assertion under test.
     */
    dom: `{
      let removed = 0
      for (const el of document.querySelectorAll('body *')) {
        for (const node of [...el.childNodes]) {
          if (node.nodeType === 3) { node.remove(); removed += 1 }
        }
      }
      if (removed === 0) throw new Error('plant mute-text: there was no text to strip')
    }`,
  },
  'x-floor': {
    catches: 'legibility',
    what: 'blinds the walk to every button on the gallery pane and puts a real breach on one of them',
    onPane: 'gallery',
    /*
     * The plant that proves a floor is the wrong shape of guard.
     *
     * It does two things, and neither on its own would be interesting. It drops
     * every `button` pair the walk reports on the gallery — 35 of the pane's 63
     * and 35 of the run's 99, better than a third of everything this check
     * looks at — and it paints a genuine, token-legal breach on a live button:
     * `--color-err` on `--color-bg-hover` is 4.48:1, under the 4.5 floor, and
     * both colours are ones the artifact produces so the palette sweep stays
     * green and the breach is `legibility`'s to catch.
     *
     * Against the per-pane floor of 20 and the run floor of 60 it walks out
     * clean: 28 on the pane, 64 across the run, both comfortably over. That is
     * the whole point — an absolute floor is satisfied by whatever is left, and
     * cannot tell "the fixture is smaller today" from "a third of the page
     * stopped being looked at". `subjects()` is what makes it fail.
     *
     * It wraps the measuring function rather than deleting the buttons, because
     * the defect being modelled is a *reader* that stopped reporting a class of
     * element, not a page that stopped having one. A page that really lost its
     * buttons is a different failure and the census would agree with the walk
     * about it.
     */
    dom: `{
      const live = document.querySelector('button:not([disabled])')
      if (live === null) throw new Error('plant x-floor: no live button to plant the breach on')
      live.style.color = 'var(--color-err)'
      live.style.backgroundColor = 'var(--color-bg-hover)'
      const walk = globalThis.__probe.textPairs
      globalThis.__probe.textPairs = () => {
        const r = walk()
        const kept = r.pairs.filter((p) => p.subject !== 'button')
        const dropped = r.pairs.length - kept.length
        if (dropped === 0) throw new Error('plant x-floor: the walk reported no button pairs to drop')
        return { sites: r.sites - dropped, pairs: kept, skipped: r.skipped }
      }
    }`,
  },
  /*
   * The three that gave this check its reason to exist.
   *
   * An adversarial round seeded seven defects the legibility sweep could not
   * see, and three of them were **one rule** — the `invisible-buttons` rule, the
   * one that paints a control's ink, fill and border the same colour — gated on
   * a state. At rest the page is untouched, so the resting walk is green; both
   * colours are ones the artifact produces, so the palette sweep is green; and
   * the pair is 1.00:1 the moment a pointer, a press or the keyboard ring
   * reaches it.
   *
   * Each is planted on **one marked control** rather than on every button, and
   * that is deliberate: a plant that repainted every button would also stop the
   * pane rendering the hover pairs that are *recorded* in BELOW_FLOOR_RENDERED,
   * and the run would go red partly for staleness — a plant whose check fails
   * for a second reason proves less than one whose check fails for its own.
   * `dom` marks the control and `css` carries the rule, because a state cannot
   * be expressed in an inline `style` at all: this is the shape a real one
   * arrives in.
   */
  'x-hover': {
    catches: 'states',
    what: 'paints one live button into a flat invisible block, but only under the pointer',
    onPane: 'gallery',
    dom: `{
      const live = document.querySelector('button:not([disabled])')
      if (live === null) throw new Error('plant x-hover: no live button to plant on')
      live.setAttribute('data-probe-plant', '')
    }`,
    css: (text) =>
      text +
      '\n[data-probe-plant]:hover{color:var(--color-bg-1)!important;' +
      'background-color:var(--color-bg-1)!important}\n',
  },
  'x-active': {
    catches: 'states',
    what: 'paints one live button into a flat invisible block, but only while it is pressed',
    onPane: 'gallery',
    dom: `{
      const live = document.querySelector('button:not([disabled])')
      if (live === null) throw new Error('plant x-active: no live button to plant on')
      live.setAttribute('data-probe-plant', '')
    }`,
    css: (text) =>
      text +
      '\n[data-probe-plant]:active{color:var(--color-bg-1)!important;' +
      'background-color:var(--color-bg-1)!important}\n',
  },
  'x-focus': {
    catches: 'states',
    what: 'paints one live button into a flat invisible block, but only while it holds the keyboard ring',
    onPane: 'gallery',
    dom: `{
      const live = document.querySelector('button:not([disabled])')
      if (live === null) throw new Error('plant x-focus: no live button to plant on')
      live.setAttribute('data-probe-plant', '')
    }`,
    css: (text) =>
      text +
      '\n[data-probe-plant]:focus-visible{color:var(--color-bg-1)!important;' +
      'background-color:var(--color-bg-1)!important}\n',
  },
  'empty-stylesheet': {
    catches: 'sanity',
    what: 'hands the page an empty stylesheet — the exact failure a probe in this session shipped',
    css: () => '/* deliberately empty */',
  },
  'unknown-pane': {
    catches: 'setup',
    what: 'asks for a pane that does not exist, so the fixture throws and nothing mounts',
    pane: '__no_such_pane__',
  },
}

/* ------------------------------------------------------------------ */
/* Termination                                                         */
/* ------------------------------------------------------------------ */

/**
 * The whole run's budget. A build plus one Electron boot plus a handful of
 * page loads is a few seconds; two minutes is generous enough that a slow
 * machine is not a false failure and short enough that a wedged run is noticed
 * rather than waited on.
 */
const WATCHDOG_MS = Number(process.env.PEEK_PROBE_WATCHDOG_MS ?? 120_000)

/**
 * Writes a line and does not come back until the bytes are gone.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe — which is what
 * it is under `pnpm`, under CI, and under every `| tail` anyone will type at
 * this. `finish()` exits the process synchronously on the very next statement,
 * so a buffered report would be a report nobody ever reads: the probe would
 * fail with a correct exit code and an empty explanation. `writeSync` is the
 * whole reason the exit can be synchronous.
 */
function say(text, fd = 1) {
  try {
    writeSync(fd, text)
  } catch {
    // EAGAIN on a non-blocking pipe is the one case worth surviving; losing the
    // report is bad, but taking the probe down over a write is worse.
    process.stdout.write(text)
  }
}

/** What the watchdog will name if it has to fire. Updated as the run moves. */
let phase = 'starting'
const setPhase = (p) => {
  phase = p
}

const watchdog = setTimeout(() => {
  process.stderr.write(
    `\nrender-probe: WATCHDOG — still in phase "${phase}" after ${String(WATCHDOG_MS)} ms.\n` +
      'The probe is required to terminate on its own, so this is a failure, not a wait.\n',
  )
  // `process.exit` rather than `app.exit`: if the app is what is wedged, asking
  // it politely is exactly what will not work.
  process.exit(1)
}, WATCHDOG_MS)

/** Bounds one page-side await. A page that never settles must not stop the run. */
async function withDeadline(label, ms, work) {
  let timer = null
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProbeSetupError(`${label} did not finish within ${String(ms)} ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The single exit. Called from success and from every failure.
 *
 * The ordering here is load-bearing, and the first version of it shipped a
 * fail-open bug worth spelling out, because this probe is a step of `pnpm build`
 * and an exit code is the only thing the build reads:
 *
 *   `app.quit()` starts a *graceful* shutdown that runs to completion on its
 *   own. It got there first and the process exited **0 with a failing check on
 *   stdout** — the 300 ms `app.exit(code)` timer never ran. Measured: a run
 *   reporting `1 check(s) FAILED` returned `EXIT=0`.
 *
 * So the code is published *before* anything is asked to shut down:
 *
 *  - `process.exitCode` is set first, so whichever path wins the race — a
 *    graceful `app.quit()`, or the timer — carries the verdict;
 *  - `app.quit()` stays, because it is the contract and it is what lets
 *    Electron tear its own windows down cleanly;
 *  - `app.exit(code)` on a short timer stays too, as the backstop for a wedged
 *    shutdown, and it is `unref`'d so it is never itself the reason the process
 *    is still alive.
 *
 * There is a regression test for exactly this: `--selftest=exitcode`.
 */
function finish(code) {
  clearTimeout(watchdog)
  // Belt: honoured if anything ever exits through Node's normal path.
  process.exitCode = code
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.destroy()
    } catch {
      /* a window that is already gone is the state we wanted */
    }
  }
  app.quit()
  // Braces, and the one that actually decides the code. `app.exit(code)` is
  // synchronous and unconditional, so it cannot lose a race to `app.quit()` the
  // way a timer does. It is safe to call this with no delay only because every
  // byte of the report has already been written with `writeSync` — see `say()`.
  app.exit(code)
}

/* ------------------------------------------------------------------ */
/* Judgements                                                          */
/* ------------------------------------------------------------------ */

const failures = []
const notes = []

/** `--plant=<name>`, or null for a normal run. Validated before anything boots. */
const plant = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--plant='))
  if (arg === undefined) return null
  const name = arg.slice('--plant='.length)
  const entry = PLANTS[name]
  if (entry === undefined) {
    process.stderr.write(
      `render-probe: no plant named ${JSON.stringify(name)}. The seeded defects are:\n` +
        Object.entries(PLANTS)
          .map(([k, v]) => `    --plant=${k.padEnd(17)} [${v.catches}] ${v.what}\n`)
          .join(''),
    )
    process.exit(1)
  }
  return { name, ...entry }
})()

/**
 * `--selftest=exitcode` — the regression test for the fail-open bug in `finish`.
 *
 * It records one synthetic failure and reports, touching no window and no
 * stylesheet, so it answers exactly one question in about a second: **does a
 * failing check leave this process with a non-zero exit code?** That question is
 * worth its own flag because every other check in here is only as real as the
 * exit code that carries it, and the first version of `finish` lost it to a
 * race. The expected result is a *non-zero* exit — `[selftest]` on stdout and
 * `$? == 1`.
 */
const selftest = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--selftest='))
  return arg === undefined ? null : arg.slice('--selftest='.length)
})()

/** The DOM plant for one pane, or null. Only the pane it names ever gets it. */
const domPlantFor = (pane) =>
  plant !== null && plant.dom !== undefined && plant.onPane === pane ? plant.dom : null

/** Records a failure. Never throws: the run reports every check, not the first. */
function fail(check, message) {
  failures.push({ check, message })
}

function note(line) {
  notes.push(line)
}

/* ------------------------------------------------------------------ */
/* Loading a pane                                                      */
/* ------------------------------------------------------------------ */

const PAGE_CHECKS = readFileSync(resolve(here, 'page-checks.js'), 'utf8')

/** How long a pane gets to mount and lay out before it counts as broken. */
const MOUNT_MS = 15_000

/**
 * Opens one pane, waits for it to be laid out, and injects the measuring half.
 *
 * The window is hidden and its size is given in **CSS pixels**: `useContentSize`
 * makes the numbers describe the viewport rather than the frame, which is what
 * every geometry check in here is about.
 */
async function openPane(
  page,
  { pane, locale = null, width = 1280, height = 900, zoom = 1, reduceMotion = false },
) {
  setPhase(`loading pane ${pane}`)
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
    webPreferences: { backgroundThrottling: false, sandbox: false },
  })


  // Anything the page logged at `warning` or above. A blank page is the failure
  // this probe is least allowed to report as a pass, and the first line of the
  // renderer's console is usually the whole diagnosis — so it is collected here
  // and pasted into the failure rather than left in a window nobody sees.
  const consoleErrors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      consoleErrors.push(`[${event.level}] ${event.message}`)
    }
  })
  const withConsole = (message) =>
    consoleErrors.length === 0
      ? `${message}\n(the page logged nothing, which is its own kind of clue)`
      : `${message}\nthe page logged:\n${consoleErrors.map((l) => `    ${l.split('\n')[0]}`).join('\n')}`
  let loadFailure = null
  win.webContents.on('did-fail-load', (_e, code, description) => {
    loadFailure = `${description} (${String(code)})`
  })

  const query = { pane }
  if (locale !== null) query.locale = locale
  await withDeadline(`pane ${pane}: loadFile`, MOUNT_MS, () => win.loadFile(page, { query }))
  if (loadFailure !== null) {
    throw new ProbeSetupError(`pane ${pane} failed to load: ${loadFailure}`)
  }
  if (zoom !== 1) win.webContents.setZoomFactor(zoom)

  /*
   * `prefers-reduced-motion: reduce`, asked for the way the OS would ask.
   *
   * Through CDP rather than the `--force-prefers-reduced-motion` command-line
   * switch, because that switch is process-wide: it would put *every* pane in
   * this run under `reduce`, including the one whose whole job is to prove the
   * animation exists in the first place. A check that the dot stops moving is
   * worth nothing unless something also saw it move.
   *
   * **After** `loadFile`, not before, and that ordering is measured: attaching
   * the debugger to a window with no document in it and sending this command
   * left it unanswered until the 15 s deadline killed the run. A media change
   * invalidates style and the page restyles, so applying it here is enough —
   * `matchMedia(...).matches` is read back on the page afterwards rather than
   * assumed, which is what makes that claim checkable rather than hopeful.
   */
  if (reduceMotion) {
    setPhase(`emulating reduced motion for ${pane}`)
    win.webContents.debugger.attach('1.3')
    await withDeadline(`pane ${pane}: setEmulatedMedia`, MOUNT_MS, () =>
      win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      }),
    )
  }

  // Poll rather than wait on an event: the fixture signals readiness by setting
  // a global two frames after the React commit, and there is no main-process
  // event for "React has laid out".
  try {
    await withDeadline(`pane ${pane}: mount`, MOUNT_MS, async () => {
      for (;;) {
        const state = await win.webContents.executeJavaScript(
          '({ ready: window.__probeReady ?? null, error: window.__probeError ?? null })',
        )
        if (state.error !== null) {
          throw new ProbeSetupError(withConsole(`pane ${pane} failed to mount:\n${state.error}`))
        }
        if (state.ready !== null) return state.ready
        await new Promise((r) => setTimeout(r, 25))
      }
    })
  } catch (err) {
    win.destroy()
    throw err instanceof ProbeSetupError && err.message.includes('the page logged')
      ? err
      : new ProbeSetupError(withConsole(String(err && err.message ? err.message : err)))
  }

  setPhase(`injecting page-checks into ${pane}`)
  const injected = await withDeadline(`pane ${pane}: inject page-checks.js`, MOUNT_MS, () =>
    win.webContents.executeJavaScript(PAGE_CHECKS),
  )
  if (injected !== 'ok') {
    throw new ProbeSetupError(
      `pane ${pane}: page-checks.js evaluated to ${JSON.stringify(injected)} rather than "ok"`,
    )
  }

  // After the measuring half is in, so a plant that throws is reported as a
  // setup failure rather than as a mysteriously clean page.
  const domPlant = domPlantFor(pane)
  if (domPlant !== null) {
    setPhase(`planting ${plant.name} in ${pane}`)
    await withDeadline(`pane ${pane}: plant ${plant.name}`, MOUNT_MS, () =>
      win.webContents.executeJavaScript(`${domPlant};'planted'`),
    )
    note(`PLANTED ${plant.name} in pane ${pane}: ${plant.what}`)
  }

  return {
    win,
    pane,
    consoleErrors,
    /** Calls one measuring function in the page and brings the result back. */
    measure: (fn, ...args) =>
      withDeadline(`pane ${pane}: __probe.${fn}`, MOUNT_MS, () =>
        win.webContents.executeJavaScript(
          `globalThis.__probe.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`,
        ),
      ),
    close: () => {
      try {
        win.destroy()
      } catch {
        /* already gone */
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* Pixels                                                              */
/* ------------------------------------------------------------------ */

/*
 * The channel below every other channel.
 *
 * `getComputedStyle` is downstream of the stylesheet, the class string, the
 * inline `style` and the `!important` — but it is **not** downstream of the user
 * agent's own painting. `accent-color` computes to the literal word `auto`, and
 * `border-style` computes to the literal word `double` whether or not two lines
 * were ever drawn. For those two questions the only witness is the framebuffer.
 *
 * Verified before it was relied on: a `show: false` window really does capture
 * (a hidden 500x400 window returned a 240x240 bitmap for a 120x120 CSS request
 * and the checkbox in it came back rgb(1,117,255) — the §22.2 number, from a
 * window that was never on screen). So the probe never puts a window in front of
 * whoever is running it.
 */

/** Grabs one rectangle of the page. Throws rather than hand back a blank. */
async function capture(win, rect, label) {
  const r = {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  }
  if (r.width <= 0 || r.height <= 0) {
    throw new ProbeSetupError(`${label}: nothing to capture — the rect is ${JSON.stringify(rect)}`)
  }
  const img = await withDeadline(`${label}: capturePage`, 10_000, () => win.webContents.capturePage(r))
  const size = img.getSize()
  if (size.width === 0 || size.height === 0) {
    throw new ProbeSetupError(`${label}: capturePage returned a 0x0 image; there are no pixels to judge`)
  }
  const bmp = img.toBitmap()
  // BGRA on every platform Electron documents, and confirmed here: the page
  // background read back as 22,24,28 through this ordering and as 28,24,22
  // through the other one.
  const pixels = []
  for (let i = 0; i < bmp.length; i += 4) pixels.push([bmp[i + 2], bmp[i + 1], bmp[i]])
  // An all-black capture is what a window that never painted returns. It is
  // also, in principle, a legitimate black rectangle — so this only fires when
  // *every* pixel is black, which no control in this app is.
  if (pixels.every((p) => p[0] === 0 && p[1] === 0 && p[2] === 0)) {
    throw new ProbeSetupError(
      `${label}: every one of the ${String(pixels.length)} captured pixels is black. That is what a ` +
        'window which never painted returns, and judging a control by it would be judging nothing.',
    )
  }
  return { width: size.width, height: size.height, scale: size.width / r.width, pixels, rect: r }
}

/** Computed styles always serialise as `rgb(...)`/`rgba(...)`; this reads that. */
function parseRgb(value) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(value).trim())
  if (m === null) return null
  const parts = m[1].split(/[\s,/]+/).filter((s) => s !== '')
  if (parts.length < 3) return null
  const n = parts.slice(0, 3).map((s) => Math.round(Number.parseFloat(s)))
  return n.some((v) => !Number.isFinite(v)) ? null : n
}

const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

/** One pixel out of a capture. The bitmap is row-major, `shot.width` to a row. */
const pixelAt = (shot, x, y) => shot.pixels[y * shot.width + x]

/**
 * Collapses a capture into a one-dimensional walk **across** a border.
 *
 * A border is uniform along its length and structured across its width, so the
 * interesting axis is the short one. Averaging the long axis away costs nothing
 * (every sample on it is the same colour) and buys immunity to a stray pixel:
 * text, a focus ring corner, a rounded end. `axis: 'y'` walks down the rows for
 * a top or bottom border; `axis: 'x'` walks across the columns for a left or
 * right one.
 */
function profileAcross(shot, axis) {
  const out = []
  const across = axis === 'y' ? shot.height : shot.width
  const along = axis === 'y' ? shot.width : shot.height
  for (let i = 0; i < across; i += 1) {
    let r = 0
    let g = 0
    let b = 0
    for (let j = 0; j < along; j += 1) {
      const p = axis === 'y' ? pixelAt(shot, j, i) : pixelAt(shot, i, j)
      r += p[0]
      g += p[1]
      b += p[2]
    }
    out.push([Math.round(r / along), Math.round(g / along), Math.round(b / along)])
  }
  return out
}

/**
 * The runs of border-coloured samples in a profile — the whole judgement, in one
 * number.
 *
 * `border-style: double` is defined as line, gap, line. Walking across a genuine
 * one you cross the border colour, leave it for the gap, and cross it again:
 * **two** runs. Walking across one the browser collapsed into a single stroke
 * you cross it once: **one** run. That difference is the only witness there is,
 * because `getComputedStyle` reports the literal word `double` either way.
 *
 * Classifying each sample as border-coloured-or-not before counting, rather than
 * counting distinct colours, is what makes this survive antialiasing: a
 * half-covered pixel at either edge simply is not the border colour, and adding
 * or losing one at the outside of the run cannot turn one run into two. Only a
 * real gap can.
 */
function colourRuns(profile, colour, tolerance) {
  const runs = []
  let current = null
  profile.forEach((sample, i) => {
    if (distance(sample, colour) <= tolerance) {
      if (current === null) current = { start: i, length: 1 }
      else current.length += 1
    } else if (current !== null) {
      runs.push(current)
      current = null
    }
  })
  if (current !== null) runs.push(current)
  return runs
}

/**
 * The rectangle to photograph for one side of one border, in CSS pixels.
 *
 * Taken from the **middle** of the side and never the ends: borders mitre at the
 * corners, so a strip that included one would be walking diagonally across two
 * borders at once and would report their union. `PAD` on each side of the border
 * is what makes the outer background and the inner fill visible in the profile,
 * which is what stops a run that happens to touch the edge of the capture from
 * being counted as if it had ended there.
 */
const STRIP_PAD = 2

function borderStrip(rect, side, width) {
  const along = Math.max(4, Math.min(12, (side === 'top' || side === 'bottom' ? rect.width : rect.height) * 0.5))
  const thickness = width + 2 * STRIP_PAD
  if (side === 'top' || side === 'bottom') {
    return {
      x: rect.x + rect.width / 2 - along / 2,
      y: side === 'top' ? rect.y - STRIP_PAD : rect.bottom - width - STRIP_PAD,
      width: along,
      height: thickness,
      axis: 'y',
    }
  }
  return {
    x: side === 'left' ? rect.x - STRIP_PAD : rect.right - width - STRIP_PAD,
    y: rect.y + rect.height / 2 - along / 2,
    width: thickness,
    height: along,
    axis: 'x',
  }
}

/** Pixel counts, most common first. */
function histogram(pixels) {
  const counts = new Map()
  for (const p of pixels) {
    const k = `${String(p[0])},${String(p[1])},${String(p[2])}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([k, n]) => ({ rgb: k.split(',').map(Number), n }))
    .sort((a, b) => b.n - a.n)
}

/* ------------------------------------------------------------------ */
/* Check 1 — is this a styled page at all?                             */
/* ------------------------------------------------------------------ */

/**
 * The gate every other number depends on, asserted before any of them is read.
 *
 * Three independent answers, all required, because each covers a different way
 * of measuring nothing:
 *
 *  - the sheet is present and its rules can be **counted** (only possible
 *    because `build-page.mjs` inlines it — a `file://` `<link>` is cross-origin
 *    and `cssRules` throws);
 *  - the theme reached `:root`, so `var()` has something to resolve;
 *  - a **functional** one: a real control out of the product measures like a
 *    control. This is the answer the earlier probe did not have, and the only
 *    one of the three that would have caught it.
 */
function checkSanity(s, pane) {
  const at = `pane ${pane}`
  if (s.ruleError !== null) {
    fail('sanity', `${at}: the stylesheet's rules could not be read: ${s.ruleError}`)
    return false
  }
  if (s.sheetCount !== 1) {
    fail('sanity', `${at}: expected exactly 1 stylesheet in the document, found ${String(s.sheetCount)}`)
    return false
  }
  // 506 class rules shipped when this was written and the sheet has not been
  // under 39 kB all migration, so 300 is a floor with room to shrink under and
  // no room to be an empty sheet.
  if (s.styleRuleCount < 300) {
    fail(
      'sanity',
      `${at}: the document's only stylesheet has ${String(s.styleRuleCount)} style rules ` +
        `(${String(s.ruleCount)} at the top level). The artifact has had hundreds all migration; ` +
        'this is an unstyled page, and every number measured off it would be plausible and wrong.',
    )
    return false
  }
  for (const [name, value] of Object.entries(s.themeVars)) {
    if (value === '') {
      fail('sanity', `${at}: the theme variable for "${name}" is empty at :root, so var() resolves to nothing`)
      return false
    }
  }
  if (s.elementCount < 10) {
    fail('sanity', `${at}: only ${String(s.elementCount)} elements in the body; the pane rendered nothing worth measuring`)
    return false
  }
  if (s.shapedButtonCount === 0) {
    fail(
      'sanity',
      `${at}: none of the ${String(s.buttonCount)} buttons on the page has a border radius or a ` +
        'sensible height. The product\'s own controls are unstyled here, which means the ' +
        'stylesheet is present but is not the one that dresses them.',
    )
    return false
  }
  note(
    `${at}: ${String(s.styleRuleCount)} style rules, ${String(s.elementCount)} elements, ` +
      `${String(s.shapedButtonCount)}/${String(s.buttonCount)} buttons shaped, ` +
      `color-scheme=${s.colorScheme}, bg=${s.bodyBackground}`,
  )
  return true
}

/* ------------------------------------------------------------------ */
/* Check 2 — the colour the user agent paints, that nobody wrote down  */
/* ------------------------------------------------------------------ */

/*
 * §22.2, measured rather than argued: with no `color-scheme` on the document,
 * Chromium paints `accent-color: auto` controls with the **light** scheme's
 * accent — rgb(1,117,255), 4.22:1 against rgb(22,24,28). With
 * `:root { color-scheme: dark }` it paints rgb(153,200,255), 10.21:1. Nine
 * controls ride on it, plus two surfaces no page can restyle at any price: the
 * `<select>` popup and Chromium's autofill panel.
 *
 * That colour appears in no stylesheet, no class string and no bundle, so no
 * fence in this repository other than this one can see it. It is also invisible
 * to `getComputedStyle`: §22.2 exported 3,426 computed properties across six
 * controls under both schemes and **the only property that differed was
 * `color-scheme` itself** — while the two screenshots were not equal. The pixels
 * are the entire evidence, which is why this check is a capture.
 *
 * The floor is 4.5:1. That is the ratio the rest of this app's contrast census
 * holds a foreground to, and the fill of a checkbox is the thing a user is
 * hunting for on the screen. It is worth saying plainly that the defect clears
 * the 3:1 WCAG floor for non-text UI: at 4.22:1 a 3:1 fence would have called
 * the shipping bug fine. The shipped value clears 4.5 by more than double.
 */
const ACCENT_MIN_CONTRAST = 4.5

/**
 * How much of the control's rectangle the accent has to occupy before the probe
 * will call it "the accent". Under the tick mark and the antialiasing, a checked
 * checkbox is about half fill; well under that and something is not painting,
 * which is a failure and not a pass.
 */
const ACCENT_MIN_SHARE = 0.1

async function checkAccentColour(p) {
  const controls = await p.measure('controls')
  const targets = controls.filter((c) => c.kind === 'input:checkbox' || c.kind === 'input:radio')
  // `controls()` checked them; this waits for the frame that shows it. Without
  // it every capture below is a photograph of the page as it was beforehand.
  if (targets.length > 0) await p.measure('settle')
  for (const c of targets) {
    const label = `${p.pane}: ${c.where}`
    const surface = parseRgb(c.surface.value)
    if (surface === null) {
      fail('accent-color', `${label}: could not read the surface behind it (${c.surface.value})`)
      continue
    }
    // Fail closed rather than measure an empty box. A dark-scheme *unchecked*
    // checkbox is a flat grey rectangle that photographs perfectly well and
    // means nothing, so a control that would not check is a broken measurement,
    // not a passing one.
    if (c.checked !== true) {
      fail(
        'accent-color',
        `${label}: the control would not go checked, so there is no accent on it to measure. ` +
          'An unchecked box still photographs — it is just grey — which is exactly why this is a ' +
          'failure instead of a reading.',
      )
      continue
    }
    const shot = await capture(p.win, c.rect, label)
    const bands = histogram(shot.pixels)
    // The accent is the most common colour that is not the surface the control
    // sits on and not the control's own unpainted box.
    const painted = bands.filter((b) => distance(b.rgb, surface) > 24)
    const top = painted[0]
    if (top === undefined || top.n / shot.pixels.length < ACCENT_MIN_SHARE) {
      fail(
        'accent-color',
        `${label}: nothing is painted on this control. ${String(shot.pixels.length)} pixels, the ` +
          `most common being ${bands[0].rgb.join(',')}. A checked ${c.kind} that paints no accent ` +
          'means the capture is not of the control, and a check that measured it would be measuring air.',
      )
      continue
    }
    const ratio = contrast(top.rgb, surface)
    const line =
      `${label}: accent ${hex(top.rgb)} rgb(${top.rgb.join(',')}) over ${hex(surface)} ` +
      `= ${ratio.toFixed(2)}:1 (${String(Math.round((100 * top.n) / shot.pixels.length))}% of the box, ` +
      `${String(shot.width)}x${String(shot.height)} px at ${String(shot.scale)}x)`
    if (ratio < ACCENT_MIN_CONTRAST) {
      fail(
        'accent-color',
        `${line}\nunder the ${String(ACCENT_MIN_CONTRAST)}:1 floor. The user agent picks this colour ` +
          'from the document\'s `color-scheme`; if that declaration has gone from `:root` in ' +
          'styles.css, this is 4.22:1 light-scheme blue on a dark window, and no other check in ' +
          'this repository can see it.',
      )
    } else {
      note(line)
    }
  }
  return targets.length
}

/* ------------------------------------------------------------------ */
/* Check 3 — every painted colour came from the shipped stylesheet     */
/* ------------------------------------------------------------------ */

/*
 * §22.5's defect, and the cleanest example of the second channel: a literal
 * colour written into an **inline `style`** reaches no stylesheet and no
 * artifact, so both colour readers in this repository are structurally unable to
 * see it. It arrives in the JS bundle and lands on the element at runtime.
 *
 * The rule is the artifact's own: *every colour on screen must be one the
 * shipped stylesheet can produce.* The allow-set comes from `extractColours()`
 * over the artifact's text — derived, never curated, so it cannot drift from
 * what ships — and the comparison is done on **canonicalised pixels** rather
 * than strings, because `#4d9cff`, `rgb(77, 156, 255)` and a `color-mix()` that
 * serialises as `oklab(...)` are one colour.
 *
 * `colours()` skips properties whose paint is invisible (a `none` border, a
 * fully transparent background), so a violation here is a colour a user can
 * actually see.
 */
async function checkPalette(p, allowed) {
  const r = await p.measure('colours', allowed)
  // Fail closed. A sweep of nothing reports clean, and this repository has
  // shipped that exact non-event six times.
  if (r.checked === 0) {
    fail(
      'palette',
      `${p.pane}: the colour sweep examined 0 properties. It cannot have looked at this page, and ` +
        'a sweep that looked at nothing passes every time.',
    )
    return 0
  }
  if (r.allowSize === 0) {
    fail(
      'palette',
      `${p.pane}: the allow-set derived from the artifact is empty, so either every colour is a ` +
        'violation or none is. Neither is a measurement.',
    )
    return 0
  }
  for (const v of r.violations) {
    fail(
      'palette',
      `${p.pane}: ${v.where}\n  ${v.prop}: ${v.value} — this colour is not one the shipped ` +
        'stylesheet can produce. A colour that is painted but is in no stylesheet arrived by ' +
        'another channel: an inline `style`, or a `setProperty` from an effect. Neither the ' +
        'source scan nor the artifact audit can see it.',
    )
  }
  note(
    `${p.pane}: ${String(r.checked)} painted colour(s) checked against ${String(r.allowSize)} the ` +
      `artifact can produce, ${String(r.violations.length)} violation(s)`,
  )
  return r.checked
}

/* ------------------------------------------------------------------ */
/* Check 4 — the text on the screen can actually be read               */
/* ------------------------------------------------------------------ */

/*
 * The hole the check above cannot close, and the reason this one exists.
 *
 * The palette sweep asks *is this colour one the artifact can produce* — a
 * membership question. Membership is blind to the only question a reader asks.
 * Append one rule to the artifact that sets a button's `color`, its
 * `background-color` and its `border-color` to the **same** token with
 * `!important`, and every button in the window becomes a solid invisible block:
 * both colours are in the allow-set, so the sweep reports a clean page and the
 * run exits 0. That is `--plant=invisible-buttons`, and before this check
 * existed it escaped.
 *
 * So this check grades pairs. For every element that paints characters it takes
 * the ink, works out the surface that ink is genuinely read against, and holds
 * the two to the WCAG floor.
 *
 * ## The background is the hard half
 *
 * Reading `background-color` off the element is the naive version, and it is
 * wrong in the direction that passes: most elements in this app declare no
 * background at all, so the naive version compares ink against
 * `rgba(0, 0, 0, 0)` and gets a large, meaningless number. The surface is
 * whatever survives compositing **up the ancestor chain**, and this app has
 * translucent surfaces on purpose — the ledger of them in
 * `src/renderer/__tests__/theme-contrast.test.ts` exists because a translucent
 * surface changes what sits behind text.
 *
 * `page-checks.js` walks that chain and hands back the whole stack; the folding
 * happens here, in the same file as the verdict. Three properties of the walk
 * are worth stating because each is a way of being quietly wrong:
 *
 *  - it stops only at a layer that is **fully opaque and unfaded**. A layer that
 *    is either translucent or inside a faded subtree is composited and the walk
 *    continues;
 *  - `opacity` multiplies down the tree, so it is collected per node and applied
 *    to that node's own paint. It moves the ink and the surface by different
 *    amounts, which is exactly why it cannot be ignored;
 *  - a background **image** has no single colour, so the walk refuses to reduce
 *    it and says so. See `PAINTED_BACKDROP`.
 *
 * ## Group order: the arithmetic this check shipped wrong for one round
 *
 * The first version of the fold flattened the whole stack — fades included —
 * into one surface colour and then painted the ink onto that. That is not what
 * `opacity` means. `opacity` on an element composites **its own paint and every
 * glyph inside it together, as one group**, onto what lies *beneath the group*.
 * The ink is inside the group, so it never meets a faded backdrop; the faded
 * result of ink-over-its-own-surface is what meets the layer below.
 *
 * Flattening first fades the backdrop, then fades the ink against it a second
 * time, and the error is in the flattering direction: on the app's disabled
 * controls it read **3.40:1** where the browser paints **3.32:1**. That was
 * settled by photographing the pixels — see §27 of the migration record — and
 * the same reading is why the specimens below now take their answers from the
 * framebuffer instead of from arithmetic written by the same hand as the fold.
 *
 * `compositeThrough` therefore walks the stack **outwards**, in premultiplied
 * alpha, doing per layer what the browser does per stacking context: paint the
 * accumulated content over that layer's own background, then apply the fade that
 * layer's group carries relative to the next layer up. Feed it the ink and you
 * get the glyph colour; feed it nothing and the first layer's own paint starts
 * the accumulation, which is the surface. One walk, two starting points, so the
 * ink and the surface cannot drift out of the same model.
 *
 * ## The values are already resolved, and that is verified rather than assumed
 *
 * `--color-*` reaches elements through `var()` and `color-mix()`.
 * `getComputedStyle` hands back a value with those already substituted, so
 * nothing here re-implements the cascade. The claim is checkable rather than
 * hopeful: every value goes through the same canvas canonicaliser as the palette
 * sweep, and one that had **not** resolved would not parse — a `var(...)` string
 * reaching this code is reported as an unreadable ink and fails the check. The
 * calibration rig's `stacked` specimen also proves the walk really is walking:
 * its answer is only 21:1 if two transparent ancestors were composited through.
 *
 * ## One copy of the maths
 *
 * `contrast()` in `colours.mjs` is the repository's transcription of the WCAG
 * formula and it is imported, not re-derived. `theme-contrast.test.ts` computes
 * the same ratios from tokens; where the two disagree, the disagreement is the
 * finding — see §26 of the migration record.
 */

/**
 * 4.5:1 for body text, 3.0:1 for large.
 *
 * WCAG's large tier starts at 18pt (24px) or 14pt bold (18.66px). This product's
 * type scale runs 11–13px, so in practice everything is body text — but that is
 * **derived from the rendered `font-size` and `font-weight`**, not assumed:
 * `largeSubjects` below counts how many pairs actually took the lower floor, and
 * the run reports the number. A pair that qualified for 3.0 would be a real
 * disagreement with the type-scale audit and wants to be seen, not hidden inside
 * a constant.
 */
const BODY_FLOOR = 4.5
const LARGE_FLOOR = 3.0
const LARGE_PX = 24
const LARGE_BOLD_PX = 18.66
const BOLD_WEIGHT = 700

const floorFor = (px, weight) =>
  px >= LARGE_PX || (px >= LARGE_BOLD_PX && weight >= BOLD_WEIGHT) ? LARGE_FLOOR : BODY_FLOOR

const showHex = (c) => hex(c.map((v) => Math.round(v)))

/** Two canonicalised `[r,g,b,a]` readings are the same paint. */
const sameRgba = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])

/**
 * One walk outwards through the stack `page-checks.js` collected, compositing
 * the way a browser composites stacking contexts.
 *
 * The layers arrive innermost-first, each carrying its own `rgba` and the
 * **cumulative** opacity from its node to the root; the last is guaranteed
 * opaque and unfaded, because that is the walk's stopping condition. At each
 * layer two things happen, in this order and no other:
 *
 *  1. what has accumulated so far is painted over that layer's own background —
 *     they are in the same buffer, the background underneath;
 *  2. the whole buffer is then faded by the opacity that layer's group carries
 *     relative to the next layer up. Both cumulative figures are products to the
 *     root, so `o_i / o_{i+1}` leaves exactly the opacities of the nodes between
 *     the two — including the layer's own and excluding the next one's.
 *
 * Premultiplied alpha throughout, because step 2 fades colour and coverage
 * together and doing that in straight alpha needs a division per layer.
 *
 * `source` is the paint that starts inside the innermost layer's buffer — the
 * ink, with its own alpha and with whatever fade sits between the text element
 * and that layer. Pass `null` and the accumulation starts empty, so the first
 * layer's own background is what emerges: that is the surface, computed by the
 * same code so it cannot disagree with the ink about the model.
 */
function compositeThrough(layers, source) {
  let p = source === null ? [0, 0, 0] : source.rgb.map((v) => v * source.alpha)
  let a = source === null ? 0 : source.alpha
  for (let i = 0; i < layers.length; i += 1) {
    const l = layers[i]
    const la = l.rgba[3] / 255
    p = [0, 1, 2].map((k) => p[k] + l.rgba[k] * la * (1 - a))
    a += la * (1 - a)
    const fade = i + 1 < layers.length ? l.opacity / layers[i + 1].opacity : l.opacity
    p = p.map((v) => v * fade)
    a *= fade
  }
  return { rgb: p, alpha: a }
}

/** Floating-point slack for "this came out fully opaque", which it must. */
const ALPHA_EPSILON = 1e-6

/** One graded pair, or `{ error }` naming why it could not be graded. */
function gradePair(p) {
  if (p.ink === null) {
    return { error: `the ink did not resolve to a colour (${JSON.stringify(p.inkValue)})` }
  }
  if (!p.backdrop.resolved) {
    return {
      error:
        `the surface it is read against could not be resolved: ${p.backdrop.why} at ` +
        `${p.backdrop.where}${p.backdrop.detail === '' ? '' : ` (${p.backdrop.detail})`}`,
      unresolved: p.backdrop,
    }
  }
  const layers = p.backdrop.layers
  if (layers.length === 0) {
    return { error: 'the backdrop walk returned no layers at all, so there is nothing to read against' }
  }
  // A zero anywhere in the chain means nothing on this branch is painted at all,
  // and it would also divide by zero two lines down. `textPairs` drops those
  // sites before they reach here; a rig specimen that managed to build one is a
  // broken specimen, not a ratio.
  if (layers.some((l) => !(l.opacity > 0))) {
    return { error: 'a layer in the backdrop is fully faded out, so nothing on this branch is painted' }
  }
  const surface = compositeThrough(layers, null)
  const inked = compositeThrough(layers, {
    rgb: p.ink.slice(0, 3),
    // The fade between the text element and the innermost painted layer. Both
    // are products to the root and the layer is the element or an ancestor of
    // it, so the quotient is exactly the opacities in between.
    alpha: (p.ink[3] / 255) * Math.min(1, p.inkOpacity / layers[0].opacity),
  })
  if (Math.abs(surface.alpha - 1) > ALPHA_EPSILON || Math.abs(inked.alpha - 1) > ALPHA_EPSILON) {
    return {
      error:
        `compositing the stack ended at alpha ${surface.alpha.toFixed(4)} (surface) / ` +
        `${inked.alpha.toFixed(4)} (ink) rather than 1. The walk is meant to stop only on a fully ` +
        'opaque unfaded layer, so this is the walk contradicting its own stopping condition and a ' +
        'colour read off it would be a colour over nothing.',
    }
  }
  /*
   * Quantised to 8 bits before anything is measured, because that is the colour
   * that exists.
   *
   * The compositing above is done in floats to keep the intermediate steps
   * honest, but a framebuffer has no half-channels: white at `opacity: .5` over
   * black composites to 127.5 here and is *painted* as rgb(128). Grading the
   * float is grading a colour the display cannot produce and no reader ever
   * sees, and it showed up the moment the specimens started being photographed —
   * `faded-ink` graded 5.28:1 against a framebuffer that plainly read 5.32:1,
   * and the framebuffer was right. Rounding once, at the end, is also what keeps
   * the printed hex and the printed ratio descriptions of the same colour.
   */
  const quantise = (c) => c.map((v) => Math.min(255, Math.max(0, Math.round(v))))
  const bg = quantise(surface.rgb)
  const ink = quantise(inked.rgb)
  const floor = floorFor(p.fontSize, p.fontWeight)
  const ratio = contrast(ink, bg)
  return { ratio, floor, ink, bg, large: floor === LARGE_FLOOR, clears: ratio >= floor }
}

/**
 * The specimens, graded on every run against the pixels the browser painted.
 *
 * Same argument as the border rig one section down: proving a fence goes red on
 * a planted defect is only half a proof. A compositor that ignored alpha would
 * look perfect on any page whose surfaces are all opaque and be silently wrong
 * on the ones that are not; a grader wired to return 21:1 would keep every clean
 * run green and still catch the plant.
 *
 * Each specimen is built by `inkRig()` and measured through the **same**
 * `backdropStack` and the same `gradePair` as the real page, so what is
 * calibrated is the code that does the work and not a copy of it.
 *
 * ## Where `expect` comes from, and why that is the whole point
 *
 * These numbers were **hand-worked** for one round, and that round is why this
 * paragraph exists. The compositor had `opacity` group order wrong — it faded
 * the backdrop and then faded the ink against the faded backdrop — and the five
 * specimens agreed with it, because the same reasoning wrote both. Worse, none
 * of the five could have disagreed: not one of them put an **opaque surface
 * inside a faded group**, which is the only shape where the order matters. A rig
 * whose answers come from the model it is checking is not a rig.
 *
 * So `expect` is now a **captured** number: the rig paints an ink witness and a
 * surface witness beside each specimen (see `inkRig` in `page-checks.js` for
 * what they are and why they are blocks rather than glyphs), `capturePage`
 * photographs them, and the grader is held to `contrast()` of those two pixels.
 * The value written here is that photograph, pinned so it cannot drift; the live
 * capture happens on every run and every pane, so the pin cannot rot unnoticed.
 * Method, for anyone re-taking them: run the probe, read the `framebuffer` half
 * of each `contrast rig` line it prints, and write that number down.
 *
 * Where a hand-worked number and a photograph disagreed, the photograph won and
 * the difference is written down here:
 *
 *  - `opaque` — white on black, the definition's ceiling. Hand 21.00, pixel
 *    21.00;
 *  - `stacked` — black on white through **two transparent ancestors**. Hand
 *    21.00, pixel 21.00, and only because the walk composited past both of them;
 *    a walk that stopped at the first background it saw gets a transparent one
 *    and cannot produce this;
 *  - `alpha-surface` — half-alpha white over black is rgb(128,128,128); white on
 *    that is under the floor. Hand 3.95, pixel 3.95. This one must be *reported
 *    as a violation*, which is how each run proves the grader still knows how to
 *    say no. A compositor that ignored the alpha would call it 21:1 and clear it;
 *  - `faded-ink` — white at `opacity: 0.5` on black. Hand **5.28**, pixel
 *    **5.32**, and the pixel won: the hand figure carried rgb(127.5) through
 *    unrounded, while a framebuffer has no half-channels and paints rgb(128).
 *    That disagreement is why `gradePair` now quantises before it measures.
 *    Ignoring `opacity` gives 21:1, so this is the specimen that pins the fade
 *    path;
 *  - `alpha-ink` — the same reading through `rgba()` on `color` instead of
 *    `opacity`. Hand 5.32, pixel 5.32;
 *  - `faded-group` — an **opaque white surface inside an `opacity: .6` group**
 *    over black, with black ink. The shape the old five all missed, and the one
 *    that clears its floor rather than breaching it. The ink is inside the
 *    group, so it composites onto white first and only then fades to
 *    black-over-black — it stays black — while the surface fades to rgb(153).
 *    Hand 7.37, pixel 7.37. Compositing the ink onto the *faded* surface instead
 *    lifts it off the floor with the surface and the ratio collapses;
 *  - `disabled-echo` — the product's own disabled control, reproduced: an
 *    `opacity: .45` group carrying the surface token over the window token, with
 *    the foreground token as ink. This is the pair the render side and
 *    `theme-contrast.test.ts` disagreed about, and it is here so the
 *    disagreement can never be re-opened by argument. Pixel **3.32**, which is
 *    the number the source-side census has held all along and the number a
 *    standalone capture read (3.3226). Hand 3.3304, one 8-bit unit of blue-red
 *    apart from the photograph. The compositor that flattened first said
 *    **3.40** — ten times further out, and in the flattering direction;
 *  - `nested-fade` — two faded groups one inside the other, which is the only
 *    specimen that can tell a per-layer relative fade from a cumulative one. A
 *    fold that multiplied every layer by its cumulative opacity gets this wrong
 *    on the surface alone, before any ink is involved. Hand 2.63, pixel 2.63.
 *
 * `layers` is asserted too. A walk that stopped early could still land on the
 * right ratio by luck, and "how many layers were composited" is the direct
 * question.
 */
const INK_SPECIMENS = [
  { id: 'opaque', layers: ['#000000'], ink: '#ffffff', expect: 21.0, expectLayers: 1, clears: true },
  {
    id: 'stacked',
    layers: ['#ffffff', 'rgba(0,0,0,0)', 'transparent'],
    ink: '#000000',
    expect: 21.0,
    expectLayers: 1,
    clears: true,
  },
  {
    id: 'alpha-surface',
    layers: ['#000000', 'rgba(255,255,255,0.5)'],
    ink: '#ffffff',
    expect: 3.95,
    expectLayers: 2,
    clears: false,
  },
  {
    id: 'faded-ink',
    layers: ['#000000'],
    ink: '#ffffff',
    opacity: 0.5,
    expect: 5.32,
    expectLayers: 1,
    clears: true,
  },
  {
    id: 'alpha-ink',
    layers: ['#000000'],
    ink: 'rgba(255,255,255,0.5)',
    expect: 5.32,
    expectLayers: 1,
    clears: true,
  },
  {
    id: 'faded-group',
    layers: ['#000000', { bg: '#ffffff', opacity: 0.6 }],
    ink: '#000000',
    expect: 7.37,
    expectLayers: 2,
    clears: true,
  },
  {
    id: 'disabled-echo',
    layers: ['#1b1e23', { bg: '#21252b', opacity: 0.45 }],
    ink: '#d3d8de',
    expect: 3.32,
    expectLayers: 2,
    clears: false,
  },
  {
    id: 'nested-fade',
    layers: ['#000000', { bg: '#ffffff', opacity: 0.5 }, { bg: '#000000', opacity: 0.5 }],
    ink: '#ffffff',
    expect: 2.63,
    expectLayers: 3,
    clears: false,
  },
]

/** How far the grader may sit from the pixels the browser painted. Two hundredths. */
const SPECIMEN_TOLERANCE = 0.02

/** And how far this run's photograph may sit from the one pinned in `expect`. */
const SPECIMEN_PIN_TOLERANCE = 0.05

/**
 * Per channel, how far a composited colour may sit from its photograph.
 *
 * The compositor here rounds **once, at the end**; the browser rounds at every
 * compositing step and hands the capture back in the display's colour space, so
 * a channel that lands on a boundary can differ by a unit. Measured, on the
 * specimen that echoes the product's disabled control: rgb(30,33,39) composited
 * against rgb(31,33,39) photographed — one unit, in one channel, worth 0.008 on
 * the ratio. Two is that, plus one, and nothing more: this is the assertion that
 * the grader produced the colour the browser produced, and a loose one would be
 * no assertion.
 */
const WITNESS_CHANNEL_TOLERANCE = 2

/** How much of a witness patch must be a single colour before it is a reading. */
const WITNESS_UNIFORMITY = 0.95

/** How far in from a witness's edge to start sampling, in CSS pixels. */
const WITNESS_INSET = 3

/**
 * The colour of one witness block, read out of a capture.
 *
 * `WITNESS_INSET` keeps the sample off the block's own edges, where the
 * compositor's own rounding and any half-covered device pixel live. What comes
 * back is the dominant colour **and its share**, because a patch that is not one
 * colour means the sample is not on the block — a geometry mistake that would
 * otherwise be reported as a compositing one.
 */
function witnessPatch(shot, rect) {
  const toX = (v) => Math.round((v - shot.rect.x) * shot.scale)
  const toY = (v) => Math.round((v - shot.rect.y) * shot.scale)
  const x0 = Math.max(0, toX(rect.x + WITNESS_INSET))
  const x1 = Math.min(shot.width, toX(rect.x + rect.width - WITNESS_INSET))
  const y0 = Math.max(0, toY(rect.y + WITNESS_INSET))
  const y1 = Math.min(shot.height, toY(rect.y + rect.height - WITNESS_INSET))
  if (x1 - x0 < 2 || y1 - y0 < 2) {
    return { error: `the witness at ${JSON.stringify(rect)} is not inside the capture` }
  }
  const pixels = []
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) pixels.push(pixelAt(shot, x, y))
  const bands = histogram(pixels)
  return { rgb: bands[0].rgb, share: bands[0].n / pixels.length, n: pixels.length, bands }
}

/**
 * Backdrops that genuinely have no single colour, and are therefore out of
 * scope for a ratio.
 *
 * A gradient, a picture or an element that moves under the text does not have
 * *a* background, so no pair can be formed and no honest number can be reported.
 * Sampling the framebuffer instead was considered and rejected in §26.4: telling
 * a glyph pixel from a background pixel at 11px with subpixel antialiasing is
 * its own estimator with its own error, and this probe already has one
 * pixel-reading check whose calibration rig exists precisely because that kind
 * of counter is easy to get confidently wrong.
 *
 * Empty is the honest state today: nothing in the panes this probe mounts paints
 * text over an image. An entry here is a written exemption with a reason, in the
 * shape this repository already uses — never a way to quieten a pair that simply
 * fails.
 */
const PAINTED_BACKDROP = []

/**
 * Pairs that render below the floor. Breaches, recorded — not exemptions.
 *
 * Same contract as the ledger in `theme-contrast.test.ts`: the measured ratio is
 * **pinned**, so a pair cannot quietly get worse, and each entry says what
 * repairing it costs. Anything that fails and is not on this list fails the run.
 *
 * The pin is matched on the composited colour pair **and the state it renders
 * in**, because that is what a reader sees and what this probe measures; the
 * same pair can render in several places and every site is listed in `where`.
 *
 * `state` is `rest` for a pair the page paints with nothing on it, and the
 * pseudo-class otherwise. Keying on the state rather than on the colours alone
 * is the same shape as the inactive carve-out and for the same reason: the same
 * two colours can be a recorded breach in one state and a new, unrecorded one in
 * another, and a ledger that could not tell them apart would excuse the second
 * for free.
 */
const BELOW_FLOOR_RENDERED = [
  {
    ink: '#757575',
    on: '#16181c',
    state: 'rest',
    measured: 3.86,
    where:
      'The label field\'s placeholder in the connect dialog, "Leave empty to generate one" — the one ' +
      'placeholder any pane this probe mounts puts on screen.',
    why:
      'This colour is written **nowhere**: `grep -c placeholder` over the artifact is 0 and ' +
      '`grep -c 757575` is 0, so no stylesheet, no class string and no bundle contains it. It is the ' +
      'user agent\'s own placeholder ink, the same channel as the accent two checks up, and it is the ' +
      'first pair in this repository found by rendering rather than by reading. The source-side ' +
      'census cannot reach it — it audits tokens, and there is no token. The palette sweep cannot ' +
      'reach it either: that sweep walks elements, and a placeholder\'s ink belongs to a ' +
      'pseudo-element.',
    fix:
      'Declare the ink instead of inheriting it. On this same surface the dim foreground token ' +
      'measures 8.11:1 and the faint one 5.29:1, so either clears the floor outright; the change is ' +
      'one rule in styles.css against the placeholder pseudo-element, which is another file\'s ' +
      'and another change\'s. Recorded here with the number pinned so it cannot drift further.',
  },
  /*
   * The two the state sweep found on its first run, and the reason it exists.
   *
   * Both were already recorded on the source side — `theme-contrast.test.ts`
   * computes them from tokens — and neither had ever been *rendered* by anything
   * this probe mounted, because nothing here had ever touched a control. They
   * are written down here in the render side's own terms, from the composited
   * colours, at the ratios this run measured. Nothing about the floor moved and
   * nothing is exempt: an entry in this list is a breach with a name, a number
   * and a price.
   */
  {
    ink: '#d3d8de',
    on: '#3269ac',
    state: 'hover',
    measured: 3.9,
    where:
      'The label of every `primary` button while the pointer is on it, and of the chosen segmented ' +
      'option: the gallery\'s primary specimen, its "Action" / "Inline" / "✕" row, the connect ' +
      'dialog\'s Connect button and its Fields/URL segment, and the consent dialog\'s Accept in both ' +
      'locales. 9 sites across the four panes this probe mounts.',
    why:
      'The same pair `theme-contrast.test.ts` records at 3.92:1 from the tokens (`--color-fg` on ' +
      '`--color-primary-hover`), rendered. The two readers differ by 0.02 because the hover surface ' +
      'is a `color-mix()` and the browser resolves it to #3269ac, two thousandths of a channel off ' +
      'the arithmetic — the same order of disagreement §27 measured for the compositor, and the ' +
      'same conclusion: both readers are describing the same defect. The resting label of this ' +
      'button is the 4.89:1 this probe has been printing as "worst live text" every run since §26; ' +
      'this is that number one pointer-move later.',
    fix:
      'The hover surface lightens under an almost-white label, so it moves the wrong way. The source ' +
      'side already costed it: mix towards `--color-accent-dim` rather than away from it, or darken ' +
      'the hover and press pair together — either clears the floor, and either is a visible change ' +
      'to the most-clicked control in the window, so it is a palette change in styles.css and not ' +
      'this file\'s to make.',
  },
  {
    ink: '#f0736f',
    on: '#483c42',
    state: 'hover',
    measured: 3.69,
    where:
      'The label of every `danger` button while the pointer is on it: the gallery\'s danger specimen ' +
      'and its "Action" / "Inline" / "✕" row. 5 sites, all on the gallery pane — in the product this ' +
      'is Stop in the composer and Reject in a permission prompt.',
    why:
      '`--color-err` on `--color-danger-hover`, and the render side and the token side agree to the ' +
      'hundredth: 3.69:1 both ways.',
    fix:
      'The same shape as the primary button: the surface lightens under a light ink. ' +
      '`--color-danger-active` is the same mix against `--color-bg-1` instead of `--color-bg-hover` ' +
      'and measures 4.79, so the press state already clears the floor and the hover is the only rung ' +
      'of the three that does not. A palette change, in another file.',
  },
]

/** Two pinned ratios agree when they round to the same two places, near enough. */
const PIN_TOLERANCE = 0.05

/**
 * The least each pane may grade before the run is treated as having looked at
 * nothing.
 *
 * A per-pane floor rather than one number for the run, because a run-wide total
 * is satisfied by one busy pane while another silently renders an empty box —
 * and the consent dialog, the smallest of them, is the pane most likely to be
 * the one that broke. Each number is roughly half of what the pane grades today,
 * so a genuine change to the fixture has room and a collapse does not.
 *
 * This is **not** the guard against a class of element dropping out — a floor
 * cannot be, and `--plant=x-floor` is the proof. See the coverage check further
 * down, which is the one that asks about proportions. Both are kept because they
 * answer different questions: a pane that renders an empty box has a census of
 * nothing and a walk of nothing, and those two agree perfectly.
 */
const PANE_PAIR_FLOOR = { gallery: 20, 'connect-fields': 10, consent: 5 }

/** And the same floor for the run, so the panes cannot fail one at a time. */
const RUN_PAIR_FLOOR = 60

/**
 * The most of a pane that may be excused as switched-off before the excuse
 * itself is treated as the defect. The gallery — a page whose entire purpose is
 * showing every control including its disabled state — runs at 16%.
 */
const INACTIVE_SHARE_MAX = 0.3

async function checkLegibility(p, { minPairs }) {
  /* --- half 1: specimens whose answers are photographed, not argued --- */
  let calibrated = false
  const pinnedShots = []
  try {
    const rig = await p.measure('inkRig', INK_SPECIMENS)
    if (!Array.isArray(rig) || rig.length !== INK_SPECIMENS.length) {
      fail(
        'legibility',
        `${p.pane}: the contrast rig returned ${JSON.stringify(rig)} rather than ` +
          `${String(INK_SPECIMENS.length)} specimens, so the grader was never calibrated and nothing ` +
          'it says about the real page can be trusted.',
      )
    } else {
      // One photograph of the whole row. The rig is `position: fixed` at the top
      // of the z-order, so its rects are viewport rects, which is the coordinate
      // space `capturePage` takes; `settle` is what makes the frame the one the
      // rig is in rather than the one before it.
      await p.measure('settle')
      const boxes = rig.flatMap((r) => [r.witness.ink, r.witness.surface])
      const union = {
        x: Math.min(...boxes.map((b) => b.x)),
        y: Math.min(...boxes.map((b) => b.y)),
      }
      union.width = Math.max(...boxes.map((b) => b.right)) - union.x
      union.height = Math.max(...boxes.map((b) => b.bottom)) - union.y
      const shot = await capture(p.win, union, `${p.pane}: contrast rig`)
      let good = 0
      for (const spec of INK_SPECIMENS) {
        const measured = rig.find((r) => r.id === spec.id)
        const label = `${p.pane}: contrast rig [${spec.id}]`
        if (measured === undefined) {
          fail('legibility', `${label}: the rig did not build this specimen`)
          continue
        }
        const g = gradePair(measured)
        if (g.error !== undefined) {
          fail('legibility', `${label}: ${g.error}. The rig is a specimen whose answer is not in question.`)
          continue
        }
        if (measured.backdrop.layers.length !== spec.expectLayers) {
          fail(
            'legibility',
            `${label}: the backdrop walk composited ${String(measured.backdrop.layers.length)} ` +
              `layer(s), expected ${String(spec.expectLayers)}. The walk is not going as far up the ` +
              'ancestor chain as it must, and a ratio off a truncated stack is a ratio against the ' +
              'wrong surface.',
          )
          continue
        }
        /*
         * The witness has to be the ink before a pixel of it is worth anything.
         * Both facts are read back off the page rather than echoed from the spec:
         * the block's own computed `background-color`, and the fade it sits
         * under. A witness painted in some other colour, or faded by some other
         * amount, would photograph beautifully and mean nothing.
         */
        if (measured.inkPaint === null || !sameRgba(measured.inkPaint, measured.ink)) {
          fail(
            'legibility',
            `${label}: the ink witness is painted ${JSON.stringify(measured.inkPaint)} while the text ` +
              `is inked ${JSON.stringify(measured.ink)}. The photograph would be of a different ` +
              'colour from the one being graded.',
          )
          continue
        }
        if (Math.abs(measured.inkWitnessOpacity - measured.inkOpacity) > 1e-9) {
          fail(
            'legibility',
            `${label}: the ink witness is faded by ${String(measured.inkWitnessOpacity)} and the text ` +
              `by ${String(measured.inkOpacity)}. They must be inside the same groups or the ` +
              'photograph is of a different compositing path.',
          )
          continue
        }
        const shotInk = witnessPatch(shot, measured.witness.ink)
        const shotBg = witnessPatch(shot, measured.witness.surface)
        const bad = [
          ['ink', shotInk],
          ['surface', shotBg],
        ].find(([, w]) => w.error !== undefined || w.share < WITNESS_UNIFORMITY)
        if (bad !== undefined) {
          fail(
            'legibility',
            `${label}: the ${bad[0]} witness did not photograph as one colour — ` +
              (bad[1].error ??
                `${String(Math.round(100 * bad[1].share))}% of ${String(bad[1].n)} pixels were ` +
                  `${bad[1].rgb.join(',')}, the rest ${JSON.stringify(bad[1].bands.slice(1, 3))}`) +
              '. The sample is not on the block, so this is a geometry fault and any compositing ' +
              'verdict read off it would be blaming the wrong code.',
          )
          continue
        }
        const shotRatio = contrast(shotInk.rgb, shotBg.rgb)
        const line =
          `grader ${g.ratio.toFixed(2)}:1 (${showHex(g.ink)} on ${showHex(g.bg)}) · framebuffer ` +
          `${shotRatio.toFixed(2)}:1 (${hex(shotInk.rgb)} on ${hex(shotBg.rgb)})`
        /*
         * The pixels are the authority. Not the spec table, and above all not the
         * arithmetic in `compositeThrough` — a grader checked against a number
         * derived from the same reasoning is a grader checked against itself,
         * and that is precisely how the group-order bug survived a round of this
         * rig being green.
         */
        const off = [0, 1, 2].filter((i) => Math.abs(g.ink[i] - shotInk.rgb[i]) > WITNESS_CHANNEL_TOLERANCE)
        const offBg = [0, 1, 2].filter((i) => Math.abs(g.bg[i] - shotBg.rgb[i]) > WITNESS_CHANNEL_TOLERANCE)
        if (off.length > 0 || offBg.length > 0) {
          fail(
            'legibility',
            `${label}: ${line}. The composited colour is not the painted one — channels ` +
              `[${[...off.map((i) => `ink.${'rgb'[i]}`), ...offBg.map((i) => `bg.${'rgb'[i]}`)].join(', ')}] ` +
              `differ by more than ${String(WITNESS_CHANNEL_TOLERANCE)}. The browser is the authority ` +
              'here: this is the compositor in this file disagreeing with what was actually painted.',
          )
          continue
        }
        if (Math.abs(g.ratio - shotRatio) > SPECIMEN_TOLERANCE) {
          fail(
            'legibility',
            `${label}: ${line} — a gap of ${Math.abs(g.ratio - shotRatio).toFixed(3)}. The grader and ` +
              'the framebuffer must agree; where they do not, the framebuffer is right and every ' +
              'verdict below would be noise.',
          )
          continue
        }
        if (Math.abs(shotRatio - spec.expect) > SPECIMEN_PIN_TOLERANCE) {
          fail(
            'legibility',
            `${label}: the framebuffer now reads ${shotRatio.toFixed(2)}:1 against the ` +
              `${spec.expect.toFixed(2)}:1 pinned in INK_SPECIMENS. Re-take the pin if the rendering ` +
              'genuinely changed — the number in the table is a photograph and has to stay one.',
          )
          continue
        }
        if (g.clears !== shotRatio >= g.floor || g.clears !== spec.clears) {
          fail(
            'legibility',
            `${label}: ${line}, graded against a ${String(g.floor)} floor and called ` +
              `it ${g.clears ? 'legible' : 'a violation'}; it is meant to be the other one. A grader ` +
              'that cannot say no on a specimen built to be unreadable will not say it on the page.',
          )
          continue
        }
        pinnedShots.push(`${spec.id} ${shotRatio.toFixed(2)}:1 ${hex(shotInk.rgb)}/${hex(shotBg.rgb)}`)
        good += 1
      }
      calibrated = good === INK_SPECIMENS.length
      if (calibrated) {
        note(
          `${p.pane}: contrast grader calibrated against the framebuffer — ` +
            `${String(INK_SPECIMENS.length)} specimens (${pinnedShots.join(', ')}) photographed at ` +
            `${String(shot.width)}x${String(shot.height)} px, ${String(shot.scale)}x, every one ` +
            `within ${String(SPECIMEN_TOLERANCE)} of the grader; alpha, \`opacity\`, transparent ` +
            'ancestors, an opaque surface inside a faded group, and two faded groups nested',
        )
      }
    }
  } finally {
    // `position: fixed` at the top of the z-order, like the border rig, and torn
    // down before the real page is walked so it can never be one of the subjects.
    try {
      await p.measure('inkRigClear')
    } catch (err) {
      fail('legibility', `${p.pane}: the contrast rig could not be torn down: ${String(err)}`)
    }
  }
  if (!calibrated) return { graded: 0, hits: [] }

  /* --- half 2: the real page, graded by a grader that has just proved itself --- */
  // Taken before the walk and by a different traversal, so it is a statement
  // about the pane rather than a restatement of what the walk decided to report.
  const census = await p.measure('subjects')
  const r = await p.measure('textPairs')
  if (r.sites === 0) {
    fail(
      'legibility',
      `${p.pane}: the walk found no text at all — not a word, not a form value, not a placeholder. ` +
        'A page with nothing readable on it is not a page that passed a legibility check; this ' +
        'repository has shipped six scans that quietly read nothing and every one of them was green.',
    )
    return { graded: 0, hits: [] }
  }

  const hits = []
  const seen = new Map()
  const inactive = new Map()
  const accounted = {}
  let inactiveCount = 0
  let graded = 0
  let large = 0
  let worst = null
  for (const pair of r.pairs) {
    // Counted before the verdict, and counting a pair that failed to grade as
    // accounted for: that failure is already reported on its own terms, and
    // double-reporting it here would bury the one thing this tally is for.
    accounted[pair.subject] = (accounted[pair.subject] ?? 0) + 1
    const at = `${p.pane}: ${pair.where} [${pair.kind}] "${pair.sample}"`
    const g = gradePair(pair)
    if (g.error !== undefined) {
      const exempt =
        g.unresolved !== undefined &&
        PAINTED_BACKDROP.find((e) => pair.where.includes(e.where) && g.unresolved.why === e.why)
      if (exempt !== undefined && exempt !== false) continue
      fail(
        'legibility',
        `${at}\n  ${g.error}\n` +
          '  Text whose background cannot be resolved has not been checked, and a check that skipped ' +
          'it would be reporting a pass it never earned. Either the surface is a colour and the walk ' +
          'is wrong, or it is a gradient or an image — in which case it belongs on PAINTED_BACKDROP ' +
          'with a sentence saying why no ratio can be formed.',
      )
      continue
    }
    graded += 1
    if (g.large) large += 1
    /*
     * WCAG 2.1 SC 1.4.3's own carve-out, applied as written: *"Text or images of
     * text that are part of an inactive user interface component ... have no
     * contrast requirement."* A disabled button in this app is `opacity: .45`,
     * and every one of the five variants lands between 2.17:1 and 3.40:1 — real
     * numbers, printed below every run rather than dropped, because "it is
     * exempt" and "nobody knows what it measures" are different states.
     *
     * The exemption is keyed on the **state the page reported**, never on the
     * colours: a pair excused for its ratio would excuse the same ratio on live
     * text, which is precisely the plant this check exists to catch. And it
     * cannot grow without being noticed — `INACTIVE_SHARE_MAX` fails the run if
     * the carve-out ever starts absorbing a large fraction of the page, which is
     * what a broken `isInactive` would look like.
     */
    if (pair.inactive) {
      inactiveCount += 1
      const ik = `${showHex(g.ink)}|${showHex(g.bg)}`
      if (!inactive.has(ik)) inactive.set(ik, { ratio: g.ratio, ink: showHex(g.ink), on: showHex(g.bg) })
      continue
    }
    if (worst === null || g.ratio < worst.ratio) worst = { ratio: g.ratio, at }
    if (g.clears) continue
    const k = `${showHex(g.ink)}|${showHex(g.bg)}|${String(g.floor)}`
    const already = seen.get(k)
    if (already !== undefined) {
      already.sites.push(at)
      continue
    }
    seen.set(k, {
      ink: showHex(g.ink),
      on: showHex(g.bg),
      ratio: g.ratio,
      floor: g.floor,
      fontSize: pair.fontSize,
      fontWeight: pair.fontWeight,
      sites: [at],
    })
  }

  for (const v of seen.values()) {
    // `rest`, explicitly: a pair recorded as a breach under the pointer is not a
    // licence for the same two colours to appear on a page nobody is touching.
    const pinned = BELOW_FLOOR_RENDERED.find(
      (b) => b.ink === v.ink && b.on === v.on && b.state === 'rest',
    )
    if (pinned === undefined) {
      fail(
        'legibility',
        `${v.ink} on ${v.on} is ${v.ratio.toFixed(2)}:1, under the ${String(v.floor)}:1 floor for ` +
          `${String(v.fontSize)}px/${String(v.fontWeight)} text. ${String(v.sites.length)} site(s):\n` +
          v.sites.map((s) => `    ${s}`).join('\n') +
          '\n  This pair is not in BELOW_FLOOR_RENDERED. Fix the colour, or write it down there with ' +
          'its measured ratio and what repairing it costs — being under the floor has to be a ' +
          'sentence somebody wrote.',
      )
      continue
    }
    hits.push(`${pinned.ink}|${pinned.on}|rest`)
    if (v.ratio < pinned.measured - PIN_TOLERANCE) {
      fail(
        'legibility',
        `${v.ink} on ${v.on} is pinned at ${pinned.measured.toFixed(2)}:1 in BELOW_FLOOR_RENDERED and ` +
          `now measures ${v.ratio.toFixed(2)}:1. A recorded breach may not get worse — that is the ` +
          'whole of what pinning it buys.\n' +
          v.sites.map((s) => `    ${s}`).join('\n'),
      )
    } else if (v.ratio > pinned.measured + PIN_TOLERANCE) {
      fail(
        'legibility',
        `${v.ink} on ${v.on} is pinned at ${pinned.measured.toFixed(2)}:1 and now measures ` +
          `${v.ratio.toFixed(2)}:1 — better, which is good news and still a failure: re-pin it, or if ` +
          'it now clears the floor, delete the entry. A pin that is not the number is not a pin.',
      )
    }
  }

  // The floor on how much was graded. A walk that resolved nothing, or one that
  // silently stopped after a handful of elements, must fail rather than report a
  // clean page — which is the exact shape of every scan this repository has had
  // to go back and fix.
  if (graded < minPairs) {
    fail(
      'legibility',
      `${p.pane}: graded ${String(graded)} text/surface pair(s) out of ${String(r.sites)} site(s) ` +
        `found, under the floor of ${String(minPairs)} for this pane. Either the pane rendered less ` +
        'than it should have or the walk stopped early; a legibility check that looked at almost ' +
        'nothing passes almost always.',
    )
  }
  /*
   * Coverage, which is the guard a floor cannot be.
   *
   * `minPairs` above answers *did the walk look at enough*, and a proportion is
   * invisible to it. Blind the walk to every button on the gallery — the class
   * of element most likely to be carrying a contrast defect, and the class this
   * check exists to protect — and 63 graded pairs become 28, over the floor with
   * room to spare, while a 4.48:1 breach on a button walks out unremarked. That
   * is `--plant=x-floor`, and no absolute number can catch it, because the
   * number that is wrong is a *share of what was there*.
   *
   * So the question is asked the other way round: `subjects()` says what the
   * pane paints, by class of element, through its own traversal; this compares
   * it against what the walk came back with. A class that is on the pane and
   * contributes nothing is the failure, whatever the totals say.
   *
   * The two floors stay. They answer a different question — a pane that renders
   * an empty box has a census of nothing and a walk of nothing, which agree
   * perfectly — and `--plant=mute-text` is the proof that they have to.
   */
  if (Object.keys(census).length === 0) {
    fail(
      'legibility',
      `${p.pane}: the walk reported ${String(r.sites)} text site(s) and the independent census of ` +
        'this pane found no text of any kind. The two readers cannot both be right, and a coverage ' +
        'test against an empty census is a test that passes by having nothing to compare.',
    )
  }
  for (const [cls, expected] of Object.entries(census)) {
    const got = accounted[cls] ?? 0
    if (got >= expected) continue
    fail(
      'legibility',
      `${p.pane}: ${String(expected)} \`${cls}\` text site(s) are on this pane and the walk came ` +
        `back with ${String(got)}. Coverage by class: ` +
        Object.keys(census)
          .map((k) => `${k} ${String(accounted[k] ?? 0)}/${String(census[k])}`)
          .join(', ') +
        `.\n  A class of element that stops contributing is invisible to any floor on the total — ` +
        `this pane would still be over its floor of ${String(minPairs)}. Either the walk is no longer ` +
        'reaching these elements, or something excused them; either way the check has lost the part ' +
        'of the page it was most needed on.',
    )
  }

  // The carve-out's own fence. A hole this shape is only safe while it stays
  // small: an `isInactive` that started answering yes for everything would empty
  // the check without failing a single assertion, which is the exact shape of
  // "red where somebody checks, blind everywhere else".
  if (graded > 0 && inactiveCount / graded > INACTIVE_SHARE_MAX) {
    fail(
      'legibility',
      `${p.pane}: ${String(inactiveCount)} of ${String(graded)} graded pairs were excused as ` +
        `inactive user-interface components, over the ${String(Math.round(100 * INACTIVE_SHARE_MAX))}% ` +
        'ceiling. WCAG exempts a switched-off control, and a page that is mostly switched-off ' +
        'controls means the detection is wrong, not that the page is fine.',
    )
  }
  if (inactive.size > 0) {
    note(
      `${p.pane}: ${String(inactiveCount)} pair(s) on inactive controls, no contrast requirement ` +
        'under WCAG 2.1 SC 1.4.3, measured anyway: ' +
        [...inactive.values()]
          .sort((a, b) => a.ratio - b.ratio)
          .map((v) => `${v.ink} on ${v.on} ${v.ratio.toFixed(2)}:1`)
          .join(', '),
    )
  }
  note(
    `${p.pane}: coverage by subject ` +
      Object.keys(census)
        .sort()
        .map((k) => `${k} ${String(accounted[k] ?? 0)}/${String(census[k])}`)
        .join(', '),
  )
  note(
    `${p.pane}: ${String(graded)} text/surface pair(s) graded (${String(r.sites)} site(s), ` +
      `${String(r.skipped.length)} not on screen), ${String(large)} at the large-text floor, ` +
      `${String(seen.size)} distinct pair(s) under the floor` +
      (worst === null ? '' : `, worst live text ${worst.ratio.toFixed(2)}:1 at ${worst.at}`),
  )
  return { graded, hits }
}

/** `checkLegibility`, with the run-wide bookkeeping folded in at the one call site shape. */
async function legible(p, opts, ledgerHits) {
  const r = await checkLegibility(p, opts)
  for (const h of r.hits) ledgerHits.add(h)
  return r.graded
}

/* ------------------------------------------------------------------ */
/* Check 8 — the same page under the pointer, the press and the ring    */
/* ------------------------------------------------------------------ */

/*
 * Everything above this measures a page **at rest**, and that is where the
 * coverage hole was.
 *
 * An adversarial round seeded seven defects this probe could not see, and three
 * of them were the *same* rule — the one that paints a button into an invisible
 * flat block — gated on a state: under the pointer, under the press, under the
 * keyboard ring. All three walked out. And the states were not hypothetical: a
 * diagnostic plant read back `hoverMatches:false`, `documentHasFocus:false` and
 * `matchesFocus:false`, the last of those on the pane whose whole contract is
 * that Accept holds the initial focus. The window was not even focused.
 *
 * The artifact's own size of the gap: 21 `:hover` selectors of which 13 paint,
 * 7 `:active`, 21 `:focus` and 17 `:focus-visible`. And **four of the six pairs
 * the source-side census already records as under the floor exist only while
 * hovered** — including the primary button's label at 3.92:1, on the very button
 * whose resting label this probe was reporting as the worst live text at 4.89:1.
 * One of the four was even proved gradeable a round earlier: `--plant=x-floor`
 * paints `--color-err` on `--color-bg-hover` *statically* and the grader catches
 * it at 4.48:1. **The grader was fine. The coverage was not.**
 *
 * ## Subjects come from the artifact, never from a list
 *
 * `stateRules()` in the page half derives them: every rule that paints (matched
 * against the longhand names the browser expanded the rule into, because
 * `outline: 2px solid …` contains no `outline-color` substring and a text-match
 * missed 13 of the 14 ring rules), with the state pseudo *deleted* from its
 * selector. `X:hover` de-states to `X`; `.a:hover .b` de-states to `.b`, and
 * hovering `.b` hovers `.a` too because the browser puts `:hover` on the whole
 * ancestor chain. So the matched element is always the element to drive.
 *
 * Two exclusions, both stated in §28.2 of the record: anything not on screen,
 * and anything **switched off** — WCAG 2.1 SC 1.4.3 exempts an inactive
 * component, this repository's exemption has always been keyed on the state the
 * page reports rather than on a colour pair, and forcing hover onto a disabled
 * control would manufacture a breach out of an exemption in the direction that
 * flatters the fence. Both counts are printed rather than silently dropped.
 *
 * ## One driver per state, each for a reason
 *
 *  - **hover: a real pointer.** It tests the hit test as well as the paint — a
 *    control something is painted over never enters the state, and forcing would
 *    paper over exactly the defect `--plant=consent-cover` exists for. Measured
 *    cost: 25 subjects in 206 ms;
 *  - **active: a forced pseudo-class.** A real press means a real `mousedown`,
 *    and `mousedown` runs the product's own handlers — menus open, dialogs
 *    close, selection moves — so the page would change under the sweep and the
 *    sweep would blame the state for it. Pressing is a pure paint question, and
 *    **that forcing paints what a press paints is photographed on every run**
 *    (see `calibrateStates`), not promised;
 *  - **focus: real Tab keystrokes.** Rounds 3 and 5 learned that a programmatic
 *    `.focus()` does not satisfy `:focus-visible`; and `documentHasFocus:false`
 *    said the window had no focus at all, which `Emulation.setFocusEmulationEnabled`
 *    fixes for a window that is deliberately never shown. One keyboard pass
 *    covers `:focus` and `:focus-visible` together — every stop reports both —
 *    and a pointer-driven focus can only paint *less* (the ring rules do not
 *    apply), never a text/surface pair the keyboard pass would miss.
 *
 * ## Only what changed is graded
 *
 * Each subject's subtree is walked twice through the *same* `pairsOver` the
 * resting walk uses — once before the state, once inside it — and only the sites
 * whose composited ink or surface actually moved are graded. The rest were
 * already graded by `legibility`, and reporting one breach twice is the first
 * step towards a fence somebody turns down. Text that only *exists* in the state
 * is graded too: it has no resting reading to be identical to.
 *
 * So three numbers, printed every run: subjects entered, pairs re-read, pairs
 * changed. The vacuity guard is on **re-read**, not on changed — the keyboard
 * ring paints an `outline`, which moves no text/surface pair at all, and a guard
 * that demanded a change there would be demanding a defect.
 */

/**
 * The calibration specimens: one per state, each declaring the pair it paints at
 * rest and the pair it paints in the state.
 *
 * Same contract as `INK_SPECIMENS` one section up, plus the two questions that
 * only exist here:
 *
 *  - **did the driver enter the state at all**, read back with `matches()` and
 *    photographed — a driver dispatching its pointer into the void, paired with
 *    a grader that quietly re-read the resting colours, agree perfectly on a
 *    clean page and would still let all three plants go red, because a plant
 *    that paints a state also paints the rest of the page badly;
 *  - **is the state's pair what was graded, not the resting one** — which is why
 *    every specimen's two ratios are far apart, and why both photographs are
 *    asserted against pins.
 *
 * Two of the three breach their floor **in the state**, so every run proves the
 * grader still says no inside a state and not merely at rest. The `expect`
 * numbers are photographs, taken the way §27.3 describes: run the probe and copy
 * the `framebuffer` half of each `state rig` line.
 *
 * The colours are flat and opaque on purpose. `INK_SPECIMENS` is where alpha,
 * `opacity` and nested groups are pinned; repeating that here would be
 * calibrating the compositor twice and the driver not at all.
 */
const STATE_SPECIMENS = [
  {
    id: 'hover-swap',
    state: 'hover',
    rest: { bg: '#000000', ink: '#ffffff' },
    on: { bg: '#999999', ink: '#808080' },
    expectRest: 21.0,
    expectOn: 1.39,
    clearsRest: true,
    clearsOn: false,
  },
  {
    id: 'press-dim',
    state: 'active',
    rest: { bg: '#000000', ink: '#ffffff' },
    on: { bg: '#767676', ink: '#ffffff' },
    expectRest: 21.0,
    expectOn: 4.54,
    clearsRest: true,
    clearsOn: true,
  },
  {
    id: 'ring-shift',
    state: 'focus-visible',
    rest: { bg: '#ffffff', ink: '#000000' },
    on: { bg: '#ffffff', ink: '#949494' },
    expectRest: 21.0,
    expectOn: 3.03,
    clearsRest: true,
    clearsOn: false,
  },
]

/** The three sweeps, in the order they run, and the pseudo-class each drives. */
const SWEPT_STATES = ['hover', 'active', 'focus']

/**
 * A CDP session on one window, attached at most once.
 *
 * `openPane` already attaches the debugger when it is emulating reduced motion,
 * and a second `attach` throws rather than being a no-op — so the guard is not
 * defensive, it is the difference between this check running and the run dying
 * on the one pane that also tests motion.
 */
function cdp(win) {
  const dbg = win.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  return (method, params = {}) =>
    withDeadline(`cdp ${method}`, 10_000, () => dbg.sendCommand(method, params))
}

/** Moves the real pointer. `button: 'none'` is a move, not a drag. */
const movePointer = (send, x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })

const pressPointer = (send, x, y) =>
  send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })

const releasePointer = (send, x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })

/**
 * One Tab keystroke, as a keyboard sends it.
 *
 * `rawKeyDown` rather than `keyDown` because a `keyDown` carrying `text` is
 * delivered as a character insertion and the browser's sequential focus
 * navigation never runs — the ring would not move and every stop would be the
 * same element. Verified: this pair advances the ring and every stop it produces
 * matches `:focus-visible`, which a programmatic `.focus()` does not.
 */
async function tabKey(send) {
  const key = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * Forces (or releases) a pseudo-class on everything one selector matches.
 *
 * This is the mechanism DevTools' own `:hov` panel uses: it sets the flag in the
 * style engine, so the paint is the browser's paint and not a simulation of one.
 * What it does *not* do is dispatch input, which is the whole reason it is used
 * for `:active` and not for `:hover` — see the header.
 */
async function forcePseudo(send, selector, classes) {
  const doc = await send('DOM.getDocument', { depth: 0 })
  const found = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector })
  for (const nodeId of found.nodeIds) {
    await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })
  }
  return found.nodeIds.length
}

/** The rectangle that contains every witness in a rig reading. */
function witnessUnion(readings) {
  const boxes = readings.flatMap((r) => [r.witness.ink, r.witness.surface])
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.right)) - x,
    height: Math.max(...boxes.map((b) => b.bottom)) - y,
  }
}

/** Reads both witnesses of one specimen out of one photograph. */
function witnessPair(shot, reading) {
  const ink = witnessPatch(shot, reading.witness.ink)
  const surface = witnessPatch(shot, reading.witness.surface)
  const bad = [
    ['ink', ink],
    ['surface', surface],
  ].find(([, w]) => w.error !== undefined || w.share < WITNESS_UNIFORMITY)
  if (bad !== undefined) {
    return {
      error:
        `the ${bad[0]} witness did not photograph as one colour — ` +
        (bad[1].error ??
          `${String(Math.round(100 * bad[1].share))}% of ${String(bad[1].n)} pixels were ` +
            `${bad[1].rgb.join(',')}`) +
        '. The sample is not on the block, so this is a geometry fault and any verdict read off it ' +
        'would be blaming the wrong code.',
    }
  }
  return { ink: ink.rgb, surface: surface.rgb, ratio: contrast(ink.rgb, surface.rgb) }
}

/** Whether two photographed colours are the same paint, at the rig's tolerance. */
const samePhoto = (a, b) => [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= WITNESS_CHANNEL_TOLERANCE)

/**
 * Photographs the rig, and gives the compositor another frame if the picture has
 * not caught up with the page yet.
 *
 * `capturePage` returns the browser process's most recent composited frame, and
 * `settle`'s two `requestAnimationFrame`s are the renderer's word for "the frame
 * after this one" — which is enough when the page changed through the renderer,
 * and *measured to be not always enough* when it changed through CDP input and
 * forced pseudo-classes. The symptom was a run where the pointer's `:hover` was
 * in the picture and the press and the ring, applied a few milliseconds later,
 * were not: three specimens, one frame, two of them one state behind.
 *
 * So the loop asks the picture whether it agrees with what the page says it
 * painted, and re-photographs if it does not. It is bounded, and the last
 * photograph is judged whatever happens — a page that never catches up must fail
 * on the assertion that noticed, not vanish into a retry that gave up quietly.
 * This is a wait for a frame, never a second opinion: the predicate is the same
 * comparison the specimen assertions make.
 */
async function captureAgreeing(p, rect, label, readings) {
  const want = readings.map((r) => gradePair(r))
  const agrees = (shot) =>
    readings.every((r, i) => {
      if (want[i].error !== undefined) return true
      const seen = witnessPair(shot, r)
      return seen.error === undefined && samePhoto(want[i].ink, seen.ink) && samePhoto(want[i].bg, seen.surface)
    })
  let shot = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await p.measure('settle')
    shot = await capture(p.win, rect, label)
    if (agrees(shot)) break
  }
  return shot
}

/**
 * The rig, driven by the same three drivers the real page gets.
 *
 * Returns true only if all three specimens passed, and nothing on the real page
 * is swept unless it did: a sweep whose driver was never shown to enter a state
 * reports numbers about a page at rest while calling them a state.
 */
async function calibrateStates(p, send) {
  let good = 0
  const pinned = []
  try {
    const rest = await p.measure('stateRig', STATE_SPECIMENS)
    if (!Array.isArray(rest) || rest.length !== STATE_SPECIMENS.length) {
      fail(
        'states',
        `${p.pane}: the state rig returned ${JSON.stringify(rest)} rather than ` +
          `${String(STATE_SPECIMENS.length)} specimens, so no driver was ever calibrated.`,
      )
      return false
    }
    const union = witnessUnion(rest)
    const restShot = await captureAgreeing(p, union, `${p.pane}: state rig at rest`, rest)

    // All three states at once: the pointer is on the first box, the second is
    // forced, and the third is the third stop in the tab ring — the rig host is
    // inserted as `body`'s first child precisely so that is three keystrokes and
    // not a walk across the whole pane.
    const hoverBox = rest.find((r) => r.id === 'hover-swap').boxRect
    await movePointer(send, Math.round(hoverBox.x + hoverBox.width / 2), Math.round(hoverBox.y + hoverBox.height / 2))
    const forced = await forcePseudo(send, `#__probe-state-rig .press-dim`, ['active'])
    if (forced !== 1) {
      fail(
        'states',
        `${p.pane}: the press specimen matched ${String(forced)} node(s) over CDP rather than 1, so ` +
          'the forced-state driver was pointed at nothing and everything it says about `:active` on ' +
          'the real page would be a statement about a page at rest.',
      )
      return false
    }
    /*
     * The ring specimen: one real keystroke, then the focus is placed on the
     * specimen and `:focus-visible` is **read back**.
     *
     * Tabbing all the way to it is what this wanted to be, and it cannot be:
     * two of this probe's four panes are modal dialogs whose trap consumes every
     * Tab and puts focus back inside the dialog (measured — `blur()` plus three
     * Tabs lands on a dialog control on all three panes), and a `position:
     * fixed` box has a null `offsetParent`, which is how that trap decides what
     * is a stop. So the keystroke establishes the keyboard modality that
     * `:focus-visible` is *about*, the focus is then placed, and whether the
     * browser agreed is asserted rather than assumed. Measured on all three
     * panes: `:focus` and `:focus-visible` both true this way, and both false
     * for the naive walk. The real page's ring is still walked with real
     * keystrokes and nothing else — see `driveFocus`.
     */
    await tabKey(send)
    const ring = await p.measure('stateRigFocus', 'ring-shift')
    if (ring.ok !== true || ring.matchesFocusVisible !== true) {
      fail(
        'states',
        `${p.pane}: the ring specimen did not reach \`:focus-visible\` — ${JSON.stringify(ring)}. ` +
          'Rounds 3 and 5 of this migration learned that a programmatic `.focus()` does not satisfy ' +
          '`:focus-visible`; this run is the check on that lesson still holding, and it did not.',
      )
      return false
    }

    const on = await p.measure('stateRigRead', STATE_SPECIMENS)
    const onShot = await captureAgreeing(p, union, `${p.pane}: state rig in state`, on)

    for (const spec of STATE_SPECIMENS) {
      const label = `${p.pane}: state rig [${spec.id}/${spec.state}]`
      const atRest = rest.find((r) => r.id === spec.id)
      const inState = on.find((r) => r.id === spec.id)
      if (atRest === undefined || inState === undefined) {
        fail('states', `${label}: the rig did not build this specimen`)
        continue
      }
      if (atRest.matched) {
        fail(
          'states',
          `${label}: the specimen reports it was already in its state before any driver ran. A ` +
            'before/after comparison against a "before" that is already the "after" cannot fail.',
        )
        continue
      }
      if (!inState.matched) {
        fail(
          'states',
          `${label}: the driver ran and the element still does not match \`:${spec.state}\`` +
            (spec.state === 'focus-visible' ? ` (it holds focus: ${String(inState.focused)})` : '') +
            '. This is the failure the whole check exists to refuse: a sweep that visits a state it ' +
            'never entered reports the page at rest under another name.',
        )
        continue
      }
      const gRest = gradePair(atRest)
      const gOn = gradePair(inState)
      if (gRest.error !== undefined || gOn.error !== undefined) {
        fail('states', `${label}: ${gRest.error ?? gOn.error}. A specimen's answer is not in question.`)
        continue
      }
      const shotRest = witnessPair(restShot, atRest)
      const shotOn = witnessPair(onShot, inState)
      if (shotRest.error !== undefined || shotOn.error !== undefined) {
        fail('states', `${label}: ${shotRest.error ?? shotOn.error}`)
        continue
      }
      // The driver moved something. Without this a sweep that entered nothing and
      // a grader that re-read the resting colours would agree, every run.
      if (samePhoto(shotRest.ink, shotOn.ink) && samePhoto(shotRest.surface, shotOn.surface)) {
        fail(
          'states',
          `${label}: the framebuffer is identical before and after the driver ran — ` +
            `${hex(shotRest.ink)} on ${hex(shotRest.surface)} at rest, ${hex(shotOn.ink)} on ` +
            `${hex(shotOn.surface)} in the state, while the grader read ${showHex(gRest.ink)} on ` +
            `${showHex(gRest.bg)} then ${showHex(gOn.ink)} on ${showHex(gOn.bg)}. Whatever this run ` +
            'graded as a state, the display never showed.',
        )
        continue
      }
      const line =
        `rest grader ${gRest.ratio.toFixed(2)}:1 (${showHex(gRest.ink)} on ${showHex(gRest.bg)}) · ` +
        `framebuffer ${shotRest.ratio.toFixed(2)}:1 (${hex(shotRest.ink)} on ${hex(shotRest.surface)}) — ` +
        `in state grader ${gOn.ratio.toFixed(2)}:1 (${showHex(gOn.ink)} on ${showHex(gOn.bg)}) · ` +
        `framebuffer ${shotOn.ratio.toFixed(2)}:1 (${hex(shotOn.ink)} on ${hex(shotOn.surface)})`
      const mismatch = [
        ['rest ink', gRest.ink, shotRest.ink],
        ['rest surface', gRest.bg, shotRest.surface],
        ['state ink', gOn.ink, shotOn.ink],
        ['state surface', gOn.bg, shotOn.surface],
      ].find(([, a, b]) => !samePhoto(a, b))
      if (mismatch !== undefined) {
        fail(
          'states',
          `${label}: ${line}. The composited ${mismatch[0]} is not the painted one ` +
            `(${showHex(mismatch[1])} against ${hex(mismatch[2])}, over the ` +
            `${String(WITNESS_CHANNEL_TOLERANCE)}-per-channel tolerance). The browser is the ` +
            'authority: this is the grader disagreeing with what was actually painted.',
        )
        continue
      }
      const drift = [
        ['rest', shotRest.ratio, spec.expectRest],
        ['in state', shotOn.ratio, spec.expectOn],
      ].find(([, got, want]) => Math.abs(got - want) > SPECIMEN_PIN_TOLERANCE)
      if (drift !== undefined) {
        fail(
          'states',
          `${label}: the framebuffer ${drift[0]} now reads ${drift[1].toFixed(2)}:1 against the ` +
            `${drift[2].toFixed(2)}:1 pinned in STATE_SPECIMENS. Re-take the pin if the rendering ` +
            'genuinely changed — the number in the table is a photograph and has to stay one.',
        )
        continue
      }
      if (gRest.clears !== spec.clearsRest || gOn.clears !== spec.clearsOn) {
        fail(
          'states',
          `${label}: ${line}, and the grader called the resting pair ` +
            `${gRest.clears ? 'legible' : 'a violation'} and the state's pair ` +
            `${gOn.clears ? 'legible' : 'a violation'}; they are meant to be ` +
            `${spec.clearsRest ? 'legible' : 'a violation'} and ` +
            `${spec.clearsOn ? 'legible' : 'a violation'}. A grader that cannot say no *inside a ` +
            'state* will not say it on the page.',
        )
        continue
      }
      pinned.push(
        `${spec.id} ${shotRest.ratio.toFixed(2)}→${shotOn.ratio.toFixed(2)}:1 ` +
          `${hex(shotOn.ink)}/${hex(shotOn.surface)}`,
      )
      good += 1
    }

    /*
     * And the one assertion that licenses forcing `:active` on the real page:
     * the same block, pressed for real, has to photograph the same as the block
     * that was forced. The rig is the probe's own inert div, so a real press
     * here runs no product handler and changes no page — which is exactly the
     * property the real page does not have.
     */
    if (good === STATE_SPECIMENS.length) {
      const press = on.find((r) => r.id === 'press-dim')
      const forcedShot = witnessPair(onShot, press)
      await forcePseudo(send, `#__probe-state-rig .press-dim`, [])
      const box = press.boxRect
      const cx = Math.round(box.x + box.width / 2)
      const cy = Math.round(box.y + box.height / 2)
      await movePointer(send, cx, cy)
      await pressPointer(send, cx, cy)
      const pressed = await p.measure('stateRigRead', STATE_SPECIMENS)
      const pressShot = await captureAgreeing(p, union, `${p.pane}: state rig under a real press`, pressed)
      await releasePointer(send, cx, cy)
      const real = witnessPair(pressShot, press)
      const pressedRead = pressed.find((r) => r.id === 'press-dim')
      if (!pressedRead.matched) {
        fail(
          'states',
          `${p.pane}: state rig [press-dim/active]: a real pointer press did not put the block in ` +
            '`:active`, so the forced-state driver has nothing to be equivalent to and using it on ' +
            'the real page is an unbacked assumption.',
        )
        good -= 1
      } else if (real.error !== undefined) {
        fail('states', `${p.pane}: state rig [press-dim/active]: under a real press, ${real.error}`)
        good -= 1
      } else if (!samePhoto(real.ink, forcedShot.ink) || !samePhoto(real.surface, forcedShot.surface)) {
        fail(
          'states',
          `${p.pane}: state rig [press-dim/active]: forcing the pseudo-class photographs ` +
            `${hex(forcedShot.ink)} on ${hex(forcedShot.surface)} and a real pointer press ` +
            `photographs ${hex(real.ink)} on ${hex(real.surface)}. \`:active\` on the real page is ` +
            'driven by forcing precisely because a real press runs the product\'s own handlers; that ' +
            'trade is only sound while these two are the same picture, and this run they are not.',
        )
        good -= 1
      } else {
        pinned.push(`press-dim forced == pressed ${hex(real.ink)}/${hex(real.surface)}`)
      }
    }
  } finally {
    await forcePseudo(send, `#__probe-state-rig .press-dim`, [])
    try {
      await p.measure('stateRigClear')
      await p.measure('focusReset')
    } catch (err) {
      fail('states', `${p.pane}: the state rig could not be torn down: ${String(err)}`)
    }
  }
  if (good === STATE_SPECIMENS.length) {
    note(
      `${p.pane}: state drivers calibrated against the framebuffer — ${pinned.join(', ')}; a real ` +
        'pointer, a forced press and real Tab keystrokes, each read back with `matches()` and each ' +
        'photographed before and after',
    )
    return true
  }
  return false
}

/** Names one text site well enough to pair a resting reading with a state one. */
const siteKey = (pair) => `${pair.where}|${pair.kind}|${pair.sample}`

/**
 * Pairs a subtree's resting walk with its in-state walk, site by site.
 *
 * Matched positionally would be simpler and wrong: a state can *reveal* text
 * (something with `display` gated on hover), and the two arrays then have
 * different lengths and everything after the reveal is compared against the
 * wrong site. Keyed and consumed instead, so a site that only exists in the
 * state comes back with `rest: null` and is graded on its own — text nobody can
 * read at rest is not text the resting walk was ever going to catch.
 */
function pairAgainstRest(before, after) {
  const pool = new Map()
  for (const b of before.pairs) {
    const k = siteKey(b)
    const list = pool.get(k)
    if (list === undefined) pool.set(k, [b])
    else list.push(b)
  }
  return after.pairs.map((a) => {
    const list = pool.get(siteKey(a))
    return { pair: a, rest: list !== undefined && list.length > 0 ? list.shift() : null }
  })
}

/**
 * Drives one state over one pane and grades what it changed.
 *
 * `readings` arrive as `{ subject, before, after }` from the per-state driver
 * above; everything from here — grading, the inactive carve-out, the ledger — is
 * the same code path the resting walk uses, deliberately, because two graders
 * that disagreed about a pair would make every number here arguable.
 */
function gradeStateReadings(p, state, readings, seen) {
  let reread = 0
  let changed = 0
  let inactiveCount = 0
  let worst = null
  for (const { subject, before, after } of readings) {
    reread += after.pairs.length
    for (const { pair, rest } of pairAgainstRest(before, after)) {
      const at = `${p.pane}: ${pair.where} [${pair.kind}] "${pair.sample}" while \`:${state}\` is on ${subject.where}`
      const g = gradePair(pair)
      if (g.error !== undefined) {
        const exempt =
          g.unresolved !== undefined &&
          PAINTED_BACKDROP.find((e) => pair.where.includes(e.where) && g.unresolved.why === e.why)
        if (exempt !== undefined && exempt !== false) continue
        fail(
          'states',
          `${at}\n  ${g.error}\n` +
            '  A pair the state repainted and that could not be graded has not been checked, and the ' +
            'state sweep exists because unchecked pairs are where the breaches were.',
        )
        continue
      }
      // Unchanged means the same ink, on the same surface, against the same
      // floor. The floor is in the comparison because a state may repaint
      // nothing and still change the verdict — text that grows or bolds under
      // the pointer moves between WCAG's two tiers with its colours untouched,
      // and skipping it as "unchanged" would skip the one thing that changed.
      if (rest !== null) {
        const gr = gradePair(rest)
        if (
          gr.error === undefined &&
          showHex(gr.ink) === showHex(g.ink) &&
          showHex(gr.bg) === showHex(g.bg) &&
          gr.floor === g.floor
        ) {
          continue
        }
      }
      changed += 1
      // Same carve-out, same key: the state the page reported, never the ratio.
      if (pair.inactive) {
        inactiveCount += 1
        continue
      }
      if (worst === null || g.ratio < worst.ratio) worst = { ratio: g.ratio, at }
      if (g.clears) continue
      const k = `${showHex(g.ink)}|${showHex(g.bg)}|${String(g.floor)}`
      const already = seen.get(k)
      if (already !== undefined) {
        already.sites.push(at)
        continue
      }
      seen.set(k, {
        ink: showHex(g.ink),
        on: showHex(g.bg),
        state,
        ratio: g.ratio,
        floor: g.floor,
        fontSize: pair.fontSize,
        fontWeight: pair.fontWeight,
        sites: [at],
      })
    }
  }
  return { reread, changed, inactiveCount, worst }
}

/**
 * Where the pointer goes when it is not the thing being measured: **outside the
 * viewport**, where it hovers nothing at all.
 *
 * A pointer has to be somewhere, and wherever it is inside the page, that
 * element and every one of its ancestors is hovered. Two things go wrong with an
 * in-page parking spot, and both were measured here before this constant moved:
 *
 *  - park it on the subject about to be read — or on that subject's child, or
 *    its parent — and the "before" reading is already the "after". The delta
 *    comes out empty and the state's repaint is silently excused;
 *  - leave it anywhere at all during the press and ring sweeps and it
 *    contaminates them. It did: the ring sweep reported the primary button's
 *    *hover* pair as something `:focus` had repainted, because the page scrolled
 *    a focused control under a pointer that had been left on the last hovered
 *    subject. The colours were real, the attribution was not.
 *
 * `-10,-10` measured empty: `document.querySelectorAll(':hover')` returns
 * nothing there, before and after a scroll, while `0,0` returns five elements.
 * Chromium does not clamp the coordinate back into the viewport.
 */
const POINTER_PARK = { x: -10, y: -10 }

/** Every subject of one state, hovered by a real pointer, one at a time. */
async function driveHover(p, send, subjects) {
  const readings = []
  const missed = []
  for (const subject of subjects) {
    await movePointer(send, POINTER_PARK.x, POINTER_PARK.y)
    const before = await p.measure('stateRead', subject.index, 'hover')
    if (before.matched) {
      missed.push(
        `${subject.where} (it is already hovered with the pointer parked at ` +
          `${String(POINTER_PARK.x)},${String(POINTER_PARK.y)}, so there is no resting reading to ` +
          'compare the state against)',
      )
      continue
    }
    const aim = await p.measure('stateAim', subject.index)
    if (aim.ok !== true || aim.reachable !== true) {
      missed.push(`${subject.where} (${aim.why ?? 'not reachable inside the viewport'})`)
      continue
    }
    await movePointer(send, aim.x, aim.y)
    const after = await p.measure('stateRead', subject.index, 'hover')
    if (!after.matched) {
      // The hit test is taken at the subject's own centre, which is the useful
      // half of the diagnosis: it says whether something is painted over the
      // control, and therefore whether the pointer could not arrive or simply
      // did not.
      missed.push(
        `${subject.where} (the pointer was moved to ${String(aim.x)},${String(aim.y)} and ` +
          '`matches(\':hover\')` is still false; a hit test at its centre lands on ' +
          `${String(after.hit)}, ` +
          (after.hitIsSelf
            ? 'which is the subject itself — nothing is covering it, so the pointer never arrived)'
            : 'which is something else painted over it)'),
      )
      continue
    }
    readings.push({ subject, before, after })
  }
  return { readings, missed }
}

/** Two walks of the same subtree that found the same ink over the same paint. */
const sameReading = (a, b) =>
  a.pairs.length === b.pairs.length &&
  a.pairs.every(
    (x, i) =>
      siteKey(x) === siteKey(b.pairs[i]) &&
      JSON.stringify(x.ink) === JSON.stringify(b.pairs[i].ink) &&
      JSON.stringify(x.backdrop.layers) === JSON.stringify(b.pairs[i].backdrop.layers),
  )

/** One reading, short enough to put in a failure and complete enough to act on. */
const summariseReading = (r) =>
  r.pairs
    .map(
      (x) =>
        `${x.kind} "${x.sample}" ink ${JSON.stringify(x.ink)} over ` +
        `${JSON.stringify(x.backdrop.layers.map((l) => l.rgba))}`,
    )
    .join(' · ') || '(no text)'

/** Every subject of `:active`, forced together, then read one at a time. */
async function driveActive(p, send, subjects) {
  const readings = []
  const missed = []
  const before = []
  // Out of the page first: a pointer left on the last hovered subject would put
  // that subject's hover paint into everything below and call it the press.
  await movePointer(send, POINTER_PARK.x, POINTER_PARK.y)
  for (const subject of subjects) before.push(await p.measure('stateRead', subject.index, 'active'))
  const forced = await forcePseudo(send, '[data-probe-subject-active]', ['active'])
  try {
    if (forced !== subjects.length) {
      return {
        readings: [],
        missed: subjects.map(
          (s) => `${s.where} (CDP matched ${String(forced)} node(s) for ${String(subjects.length)} subject(s))`,
        ),
      }
    }
    for (let i = 0; i < subjects.length; i += 1) {
      const after = await p.measure('stateRead', subjects[i].index, 'active')
      if (!after.matched) {
        missed.push(`${subjects[i].where} (forced, and \`matches(':active')\` still says no)`)
        continue
      }
      readings.push({ subject: subjects[i], before: before[i], after })
    }
  } finally {
    /*
     * Released, recomputed, and **checked back to rest**.
     *
     * Clearing the forced flag is not the same as recomputing the style: with
     * the flag gone and `matches(':active')` already saying no, every computed
     * value stayed at what the press had painted, and the sweep that ran next
     * took its resting readings off a pressed page — 25 pairs, every one of them
     * reported as "repainted", by the state that had not repainted anything.
     * `restyle()` is the invalidation and this loop is the proof it worked,
     * because a driver that quietly leaves the page in a state is worse than one
     * that never entered it: the first contaminates everything downstream and
     * looks like data.
     */
    await forcePseudo(send, '[data-probe-subject-active]', [])
    await p.measure('restyle')
    for (let i = 0; i < subjects.length; i += 1) {
      const back = await p.measure('stateRead', subjects[i].index, 'active')
      if (!sameReading(before[i], back)) {
        fail(
          'states',
          `${p.pane}: ${subjects[i].where} did not return to its resting paint after the press was ` +
            'released. Everything measured after this point would be measuring a page still in a ' +
            'state nobody is in:\n' +
            `    at rest ${summariseReading(before[i])}\n    afterwards ${summariseReading(back)}`,
        )
        break
      }
    }
  }
  return { readings, missed }
}

/**
 * The keyboard ring, walked with real Tab keystrokes until it comes back round.
 *
 * The subjects are the union of the `:focus` and `:focus-visible` sets, because
 * a keyboard stop wears both — the two are censused separately only so that the
 * de-stated selectors of one are not counted under the other's name.
 */
async function driveFocus(p, send, subjects) {
  // Same reason as the press sweep, and this is the one where it was caught.
  await movePointer(send, POINTER_PARK.x, POINTER_PARK.y)
  const rest = new Map()
  for (const subject of subjects) {
    rest.set(subject.uid, await p.measure('stateRead', subject.index, subject.state))
  }
  await p.measure('focusReset')
  const readings = []
  const missed = []
  const stops = []
  const seenStops = new Set()
  const limit = subjects.length * 2 + 8
  for (let i = 0; i < limit; i += 1) {
    await tabKey(send)
    const here = await p.measure('focusHere')
    if (here.ok !== true) {
      // The ring passing through the document itself is normal; the ring never
      // leaving it is not, and the guard below is what says which happened.
      if (seenStops.size > 0) break
      missed.push(`the ring never left the document (${String(here.why)}, hasFocus ${String(here.hasFocus)})`)
      break
    }
    if (!here.hasFocus) {
      missed.push(`${here.where} (document.hasFocus() is false, so no ring is being painted at all)`)
      break
    }
    if (seenStops.has(here.uid)) break
    seenStops.add(here.uid)
    stops.push(here)
    if (!here.matchesFocusVisible) {
      missed.push(
        `${here.where} (matches \`:focus\` ${String(here.matchesFocus)} but \`:focus-visible\` is ` +
          'false, and this app paints its ring off the stricter one — a programmatic focus looks ' +
          'exactly like this)',
      )
      continue
    }
    const before = rest.get(here.uid)
    if (before === undefined) continue
    readings.push({ subject: { where: here.where, uid: here.uid, index: -1 }, before, after: here })
  }
  const reached = new Set(stops.map((s) => s.uid))
  for (const subject of subjects) {
    if (!reached.has(subject.uid)) missed.push(`${subject.where} (the tab ring never stopped on it)`)
  }
  return { readings, missed, stops: stops.length }
}

/**
 * How few pairs the whole run may re-read inside a state before the sweep counts
 * as having visited nothing.
 *
 * Roughly half of what it re-reads today, on the same reasoning as the resting
 * floors one section up: room for the fixture to change, none for the sweep to
 * collapse. It is a floor on **re-read**, not on changed, for the reason in the
 * header: the keyboard ring is an `outline` and legitimately changes nothing.
 */
const STATE_REREAD_FLOOR = 60

async function checkStates(p, ledgerHits) {
  const send = cdp(p.win)
  await send('DOM.enable')
  await send('CSS.enable')
  // A window that is never shown has no focus, and `:focus-visible` on a page
  // that is not focused is a state that does not exist. This is the fix for the
  // `documentHasFocus:false` the diagnostic plant read back.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  if (!(await calibrateStates(p, send))) return { reread: 0, entered: {} }

  const seen = new Map()
  const entered = {}
  let reread = 0
  let changed = 0
  let inactiveCount = 0
  let worst = null
  const census = {}
  for (const state of SWEPT_STATES) {
    const parts = state === 'focus' ? ['focus', 'focus-visible'] : [state]
    const subjects = []
    // By `uid`, never by the description: thirty buttons in a gallery describe
    // identically, and the first version of this keyed the set on `where` and
    // swept six of the twenty-five elements it had just tagged.
    const byUid = new Set()
    let offScreen = 0
    let excluded = 0
    let ruleCount = 0
    for (const part of parts) {
      const info = await p.measure('stateSubjects', part)
      ruleCount += info.ruleCount
      offScreen += info.offScreen
      excluded += info.inactive
      if (info.badSelectors.length > 0) {
        fail(
          'states',
          `${p.pane}: ${String(info.badSelectors.length)} \`:${part}\` selector(s) in the artifact ` +
            'de-state into something the browser will not parse, so the elements they paint were ' +
            'never swept:\n' +
            info.badSelectors.map((b) => `    ${b.sel} → ${b.de}: ${b.why}`).join('\n'),
        )
      }
      for (const s of info.subjects) {
        if (byUid.has(s.uid)) continue
        byUid.add(s.uid)
        subjects.push({ ...s, state: part })
      }
    }
    census[state] = subjects.length
    if (subjects.length === 0) {
      note(
        `${p.pane}: no element on this pane can reach \`:${state}\` — ${String(ruleCount)} rule(s) in ` +
          `the artifact paint it, ${String(offScreen)} candidate(s) are off screen and ` +
          `${String(excluded)} are switched off (WCAG 2.1 SC 1.4.3)`,
      )
      entered[state] = 0
      continue
    }
    const driven =
      state === 'hover'
        ? await driveHover(p, send, subjects)
        : state === 'active'
          ? await driveActive(p, send, subjects)
          : await driveFocus(p, send, subjects)
    entered[state] = driven.readings.length
    if (driven.missed.length > 0) {
      fail(
        'states',
        `${p.pane}: ${String(driven.missed.length)} of ${String(subjects.length)} \`:${state}\` ` +
          'subject(s) never entered the state:\n' +
          driven.missed.map((m) => `    ${m}`).join('\n') +
          '\n  Every one of these is an element the artifact paints in this state and this run did ' +
          'not look at. Either something is on top of it — which is a finding of its own — or the ' +
          'driver stopped working.',
      )
    }
    if (driven.readings.length === 0) {
      fail(
        'states',
        `${p.pane}: ${String(subjects.length)} element(s) can reach \`:${state}\` and the sweep ` +
          'entered none of them. A state sweep that visits nothing reports the page at rest under ' +
          'another name, which is the exact failure this check was added for.',
      )
      continue
    }
    const graded = gradeStateReadings(p, state, driven.readings, seen)
    if (graded.reread === 0) {
      fail(
        'states',
        `${p.pane}: \`:${state}\` was entered on ${String(driven.readings.length)} subject(s) and the ` +
          'walk came back with no text at all. The state was reached and nothing was read, so ' +
          'nothing was checked.',
      )
    }
    reread += graded.reread
    changed += graded.changed
    inactiveCount += graded.inactiveCount
    if (graded.worst !== null && (worst === null || graded.worst.ratio < worst.ratio)) worst = graded.worst
    note(
      `${p.pane}: \`:${state}\` entered on ${String(driven.readings.length)}/${String(subjects.length)} ` +
        `subject(s) from ${String(ruleCount)} artifact rule(s) (${String(offScreen)} off screen, ` +
        `${String(excluded)} switched off), ${String(graded.reread)} pair(s) re-read, ` +
        `${String(graded.changed)} repainted by the state` +
        (state === 'focus' ? `, ${String(driven.stops)} ring stop(s)` : ''),
    )
  }

  for (const v of seen.values()) {
    const pinned = BELOW_FLOOR_RENDERED.find((b) => b.ink === v.ink && b.on === v.on && b.state === v.state)
    if (pinned === undefined) {
      fail(
        'states',
        `${v.ink} on ${v.on} is ${v.ratio.toFixed(2)}:1 while \`:${v.state}\` is on, under the ` +
          `${String(v.floor)}:1 floor for ${String(v.fontSize)}px/${String(v.fontWeight)} text. ` +
          `${String(v.sites.length)} site(s):\n` +
          v.sites.map((s) => `    ${s}`).join('\n') +
          '\n  This pair is not in BELOW_FLOOR_RENDERED. Fix the colour, or write it down there with ' +
          'its measured ratio and what repairing it costs — being under the floor has to be a ' +
          'sentence somebody wrote.',
      )
      continue
    }
    ledgerHits.add(`${pinned.ink}|${pinned.on}|${pinned.state}`)
    if (v.ratio < pinned.measured - PIN_TOLERANCE || v.ratio > pinned.measured + PIN_TOLERANCE) {
      fail(
        'states',
        `${v.ink} on ${v.on} in \`:${v.state}\` is pinned at ${pinned.measured.toFixed(2)}:1 in ` +
          `BELOW_FLOOR_RENDERED and now measures ${v.ratio.toFixed(2)}:1. A recorded breach may not ` +
          'drift in either direction — worse is a regression, better wants re-pinning or deleting.',
      )
    }
  }
  if (changed > 0 && inactiveCount / changed > INACTIVE_SHARE_MAX) {
    fail(
      'states',
      `${p.pane}: ${String(inactiveCount)} of ${String(changed)} repainted pairs were excused as ` +
        'inactive user-interface components, over the ceiling. Subjects that are switched off are ' +
        'excluded before a state is ever driven, so a large share here means the exclusion is not ' +
        'working and the sweep is grading controls WCAG exempts.',
    )
  }
  note(
    `${p.pane}: states swept — ${Object.keys(census)
      .map((s) => `${s} ${String(entered[s] ?? 0)}/${String(census[s])}`)
      .join(', ')} subject(s) entered, ${String(reread)} pair(s) re-read, ${String(changed)} repainted, ` +
      `${String(seen.size)} distinct pair(s) under the floor` +
      (worst === null ? '' : `, worst repainted text ${worst.ratio.toFixed(2)}:1 at ${worst.at}`),
  )
  return { reread, entered }
}

/* ------------------------------------------------------------------ */
/* Check 5 — reduced motion actually stops the motion                  */
/* ------------------------------------------------------------------ */

/*
 * §22.4 and §23: the override for this shipped *twice* while not working. Once
 * because our `@keyframes pulse` lost the name to Tailwind's and our keyframes
 * never reached the artifact at all; once because the override and the rule it
 * overrode were both unlayered and both (0,2,0), so document order decided
 * between them and a file merge put them the wrong way round. Both times the
 * class strings were perfect and every source-reading check was green.
 *
 * So this check refuses to be satisfied by absence. It takes **two**
 * measurements and requires both:
 *
 *  - without emulation the connection dot **is** animating. If nothing animates
 *    here there is no motion to reduce, and "no animations under reduce" would
 *    be true of an empty page;
 *  - with `prefers-reduced-motion: reduce` emulated, nothing animates.
 *
 * `matchMedia` is read back on both sides rather than trusted, because an
 * emulation that silently did not apply would make the second half pass for the
 * worst possible reason.
 */
function checkReducedMotion(before, after) {
  if (before.matchesReduce) {
    fail(
      'reduced-motion',
      'the un-emulated pane already reports `prefers-reduced-motion: reduce`. Something is forcing ' +
        'it for the whole process, so the "animates normally" half of this check proves nothing.',
    )
    return
  }
  if (!after.matchesReduce) {
    fail(
      'reduced-motion',
      'the emulated pane does not report `prefers-reduced-motion: reduce`, so the emulation did ' +
        'not take. Every animation being absent below would mean nothing.',
    )
    return
  }
  if (before.animations.length === 0) {
    fail(
      'reduced-motion',
      'nothing on the gallery pane animates at rest, so there is no motion for `reduce` to stop. ' +
        'The connection dot is spelled with the product\'s own class constant; if it stopped ' +
        'animating, either the keyframe name drifted again (it is `conn-pulse`, and it was ' +
        '`pulse` for two rounds while colliding with Tailwind\'s) or the rule stopped matching. ' +
        'Either way this check would otherwise pass by having nothing to look at.',
    )
    return
  }
  if (after.animations.length > 0) {
    for (const a of after.animations) {
      fail(
        'reduced-motion',
        `${a.where} is still running \`${a.name}\` (${a.duration}, ${a.iterations}) with ` +
          '`prefers-reduced-motion: reduce` in force. The override is not reaching this element — ' +
          'check that it is nested inside the rule it overrides rather than sitting in a separate ' +
          'block whose position in the file decides the cascade.',
      )
    }
    return
  }
  note(
    `reduced-motion: ${String(before.animations.length)} animation(s) at rest ` +
      `(${before.animations.map((a) => a.name).join(', ')}), 0 under \`reduce\``,
  )
}

/* ------------------------------------------------------------------ */
/* Check 6 — the blocking dialog can actually be answered              */
/* ------------------------------------------------------------------ */

/*
 * The consent dialog is modal and blocking: a user who cannot reach its Accept
 * cannot use the app at all. §24.2 is the reason this is measured rather than
 * reasoned about — an inline `style` walked straight past the fence that was
 * supposed to guarantee it.
 *
 * The viewport is the real floor, derived rather than typed: the main window
 * refuses to go below 900x600 (`src/main/index.ts`), and the UI zoom goes to
 * `UI_ZOOM_MAX` = 1.5, so the smallest layout any user can produce is
 * 900/1.5 x 600/1.5 = **600x400 CSS pixels**. That is the case where a dialog
 * with five paragraphs and two buttons runs out of room.
 *
 * Both locales, because the German-length problem is real here in miniature:
 * translated labels change button widths and translated prose changes height,
 * and a dialog that fits in English is not thereby a dialog that fits.
 *
 * Three distinct failures are checked because they are genuinely different and
 * only one of them is a rectangle: off-viewport, clipped by an `overflow`
 * ancestor, and covered by something painted on top. `elementFromPoint` is the
 * only witness for the third, and the third is the one §24.2 shipped.
 */
const FLOOR_VIEWPORT = { width: Math.round(900 / 1.5), height: Math.round(600 / 1.5) }

function checkConsentReach(h, locale) {
  const at = `consent [${locale}] at ${String(FLOOR_VIEWPORT.width)}x${String(FLOOR_VIEWPORT.height)}`
  if (!h.found) {
    fail(
      'consent-reach',
      `${at}: ${h.selector} did not resolve, so Accept was never located. The dialog gives its ` +
        'accept button initial focus; if nothing holds focus, either the dialog did not mount or ' +
        'that contract has changed — and this check must not pass by having found nothing.',
    )
    return
  }
  if (h.tag !== 'button') {
    fail(
      'consent-reach',
      `${at}: initial focus is on <${h.tag}> (${h.where}), not the accept button. The measurement ` +
        'is pointed at the wrong element, so its result means nothing.',
    )
    return
  }
  if (h.disabled === true) {
    fail('consent-reach', `${at}: Accept (${h.where}) is disabled, so the dialog cannot be answered`)
  }
  if (!h.inViewport) {
    fail(
      'consent-reach',
      `${at}: Accept is outside the viewport — its box is ${JSON.stringify(h.rect)} in a ` +
        `${String(h.viewport.width)}x${String(h.viewport.height)} viewport. At the smallest window ` +
        'this app allows, the button a user must press to continue is off the screen.',
    )
  }
  if (h.clippedBy !== null) {
    fail(
      'consent-reach',
      `${at}: Accept is clipped by ${h.clippedBy.where} (${JSON.stringify(h.clippedBy.rect)}), an ` +
        'ancestor that does not scroll it into reach.',
    )
  }
  if (!h.hitIsSelf) {
    fail(
      'consent-reach',
      `${at}: a click at the centre of Accept lands on ${h.hit ?? 'nothing'}, not on the button. ` +
        'It is visible and it is in the right place, and pressing it does nothing — which is what ' +
        'a transparent element painted over the dialog does, and what no check that reads ' +
        'geometry or class names can see.',
    )
  }
  note(`${at}: Accept "${h.text}" reachable and hit-testable at ${JSON.stringify(h.rect)}`)
}

/* ------------------------------------------------------------------ */
/* Check 7 — a two-line border is actually two lines                   */
/* ------------------------------------------------------------------ */

/*
 * The check the keyword cannot make.
 *
 * `border-style: double` is defined as line, gap, line. Below 3px there is not
 * enough room to give each of the three a whole pixel, so the browser paints
 * **one** stroke — and `getComputedStyle` still reports the literal word
 * `double`, and the class string still says what the author meant, and the
 * artifact still contains the declaration. Every reader in this repository
 * except this one agrees the border is two lines. Measured at 1px: solid, dashed
 * and double all came back as a single unbroken run of the border colour, the
 * double one indistinguishable from the solid one.
 *
 * So the witness is the framebuffer, and the judgement is a run count:
 * **two** runs of border colour across the border's width is a real double,
 * **one** is a browser that collapsed it.
 *
 * ## Why there is a calibration rig
 *
 * This app ships no double borders at all (`grep -c double` over the artifact:
 * 0), so on a clean run the band counter has no subject. That is a trap worth
 * naming: a counter hard-wired to report "one line" would still catch
 * `--plant=double-border` and would still leave a clean run green — red in the
 * one place anybody checks it and blind everywhere else. Proving a fence can go
 * red is only half a proof.
 *
 * So every run first builds a border whose answer is already known — 3px, the
 * narrowest width where line, gap and line each get a whole pixel — and requires
 * the counter to see **two** runs in the double one and **one** in the solid
 * one. Only a counter that has just been shown to distinguish those two is
 * allowed to say anything about the real page. If the rig does not calibrate,
 * this check fails and does not go on to report a reassuring nothing.
 */
const DOUBLE_MIN_WIDTH = 3

/**
 * How far apart the border colour and its neighbours must be before the profile
 * can be classified at all. Below this the border is not visually distinct from
 * what is on either side of it, so "how many lines" has no measurable answer and
 * the honest result is a failure rather than a number.
 */
const MIN_BAND_SEPARATION = 60

/**
 * One walk across a border, classified into runs of border colour.
 *
 * The tolerance is **derived, never typed**. `borderStrip` puts `STRIP_PAD` CSS
 * pixels of plain background outside the border and of plain fill inside it, so
 * the two ends of the profile *are* the two neighbouring colours — read them
 * back and put the threshold half way. That is a nearest-neighbour rule in
 * disguise: an antialiased sample sits on the segment between the border colour
 * and whichever neighbour it is blending with, so half the separation is exactly
 * the point where it stops being more border than background.
 *
 * Half rather than a third, deliberately, because the two errors are not
 * symmetric. Too generous and a real gap gets filled in, a genuine double reads
 * as one run, and the check fails loudly on something that was fine. Too strict
 * and the antialiased interior of a *solid* line splits into two runs — which
 * would make a collapsed 1px double read as a healthy one and let the defect
 * through silently. Between a false alarm and a silent pass, this fence takes
 * the false alarm; the rig is what proves the generous threshold still resolves
 * a real gap at 3px.
 */
function bandsAcross(shot, axis, borderColour) {
  const profile = profileAcross(shot, axis)
  const outside = profile[0]
  const inside = profile[profile.length - 1]
  const separation = Math.min(distance(borderColour, outside), distance(borderColour, inside))
  const tolerance = Math.floor(separation / 2)
  return {
    profile,
    outside,
    inside,
    separation,
    tolerance,
    runs: colourRuns(profile, borderColour, tolerance),
  }
}

/** A profile rendered short enough to paste into a failure message. */
const showProfile = (profile) => profile.map((p) => `${String(p[0])},${String(p[1])},${String(p[2])}`).join(' | ')

/**
 * Photographs one side of one border and counts the lines in it.
 *
 * Returns the band reading, or null having already recorded why it could not be
 * taken. Never returns a number it does not stand behind.
 */
async function readBands(p, rect, side, width, colourValue, label) {
  const colour = parseRgb(colourValue)
  if (colour === null) {
    fail('border-bands', `${label}: the border colour did not parse (${colourValue})`)
    return null
  }
  const strip = borderStrip(rect, side, width)
  const shot = await capture(p.win, strip, label)
  const b = bandsAcross(shot, strip.axis, colour)
  if (b.separation < MIN_BAND_SEPARATION) {
    fail(
      'border-bands',
      `${label}: the border colour ${hex(colour)} is within ${String(b.separation)} of what sits on ` +
        `either side of it (outside ${hex(b.outside)}, inside ${hex(b.inside)}), under the ` +
        `${String(MIN_BAND_SEPARATION)} floor. The lines cannot be told apart from their background, ` +
        'so no run count off this strip would mean anything, and reporting one would be inventing it.',
    )
    return null
  }
  return b
}

async function checkBorderBands(p) {
  /* --- half 1: calibrate the counter on a border whose answer is known --- */
  const specs = [
    { id: 'solid', style: 'solid', width: DOUBLE_MIN_WIDTH },
    { id: 'double', style: 'double', width: DOUBLE_MIN_WIDTH },
  ]
  const expected = { solid: 1, double: 2 }
  let calibrated = false
  let rig
  try {
    rig = await p.measure('borderRig', specs)
    await p.measure('settle')
    if (!Array.isArray(rig) || rig.length !== specs.length) {
      fail(
        'border-bands',
        `${p.pane}: the calibration rig returned ${JSON.stringify(rig)} rather than ` +
          `${String(specs.length)} elements, so the band counter was never calibrated and nothing ` +
          'it says about the real page can be trusted.',
      )
    } else {
      let good = 0
      for (const r of rig) {
        const label = `${p.pane}: calibration rig [${r.id}]`
        // Read back rather than assumed — if the browser did not accept the
        // width or the style, the rig is not the control it claims to be.
        if (r.style !== (r.id === 'solid' ? 'solid' : 'double') || r.width !== DOUBLE_MIN_WIDTH) {
          fail(
            'border-bands',
            `${label}: the rig element computed to \`${r.style}\` at ${String(r.width)}px rather than ` +
              `the ${String(DOUBLE_MIN_WIDTH)}px ${r.id} it was built as. The calibration subject is ` +
              'not what it says it is.',
          )
          continue
        }
        const b = await readBands(p, r.rect, 'top', r.width, r.colour, label)
        if (b === null) continue
        if (b.runs.length !== expected[r.id]) {
          fail(
            'border-bands',
            `${label}: counted ${String(b.runs.length)} band(s) across a ${String(DOUBLE_MIN_WIDTH)}px ` +
              `${r.id} border, expected ${String(expected[r.id])}.\n` +
              `  border ${hex(parseRgb(r.colour) ?? [0, 0, 0])}, tolerance ${String(b.tolerance)}, ` +
              `profile: ${showProfile(b.profile)}\n` +
              'This is the counter failing on a border whose answer is not in question, so it is the ' +
              'counter that is broken, not the page. Every verdict below it would be noise — which is ' +
              'exactly why the rig runs first and every time, on a page that ships no double borders ' +
              'of its own and would otherwise never exercise this code at all.',
          )
          continue
        }
        good += 1
      }
      calibrated = good === specs.length
      if (calibrated) {
        note(
          `${p.pane}: band counter calibrated — ${String(DOUBLE_MIN_WIDTH)}px solid reads as 1 line, ` +
            `${String(DOUBLE_MIN_WIDTH)}px double reads as 2`,
        )
      }
    }
  } finally {
    // The rig is `position: fixed` at the top of the z-order; leaving it up
    // would put two invented rectangles in front of whatever looks at this pane
    // next. Torn down before anything else runs, and a teardown that fails is
    // reported rather than swallowed.
    try {
      await p.measure('borderRigClear')
    } catch (err) {
      fail('border-bands', `${p.pane}: the calibration rig could not be torn down: ${String(err)}`)
    }
  }

  if (!calibrated) return 0

  /* --- half 2: the real page, judged by a counter that has just proved itself --- */
  const subjects = await p.measure('doubleBorders')
  if (subjects.length === 0) {
    // Not a failure: this app ships no double borders, and half 1 is what keeps
    // that from being a check that looked at nothing. The rig is the subject.
    return specs.length
  }
  await p.measure('settle')
  for (const s of subjects) {
    const label = `${p.pane}: ${s.where} (border-${s.side})`
    if (s.width < DOUBLE_MIN_WIDTH) {
      fail(
        'border-bands',
        `${label}: \`border-style: double\` at ${String(s.width)}px. Two lines and the gap between ` +
          `them need ${String(DOUBLE_MIN_WIDTH)}px before each can have a whole pixel, so the browser ` +
          'paints one stroke and the second line silently does not exist. `getComputedStyle` still ' +
          'reports the word `double` here, and so does the class string and so does the artifact — ' +
          'this is only visible in the pixels.',
      )
    }
    const b = await readBands(p, s.rect, s.side, s.width, s.colour, label)
    if (b === null) continue
    if (b.runs.length !== 2) {
      fail(
        'border-bands',
        `${label}: \`border-style: double\` at ${String(s.width)}px paints ${String(b.runs.length)} ` +
          `line(s), not 2.\n  runs: ${JSON.stringify(b.runs)}, tolerance ${String(b.tolerance)}\n` +
          `  profile across the border: ${showProfile(b.profile)}\n` +
          'The declaration asks for line-gap-line and the framebuffer has one unbroken stroke.',
      )
    } else {
      note(`${label}: double border at ${String(s.width)}px paints 2 lines, as declared`)
    }
  }
  return specs.length + subjects.length
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

async function run() {
  if (selftest === 'exitcode') {
    fail(
      'selftest',
      'this failure is deliberate: --selftest=exitcode exists to prove that a failing check ' +
        'leaves a non-zero exit code behind. If this run exited 0, `finish()` has regressed and ' +
        'every other check in this probe is decoration, because `pnpm build` reads nothing but ' +
        'the exit code.',
    )
    return
  }
  if (selftest !== null) {
    throw new ProbeSetupError(`no selftest named ${JSON.stringify(selftest)}; the only one is "exitcode"`)
  }

  setPhase('building the probe page')
  const { page, css } = await buildProbePage({
    transformCss: plant !== null && plant.css !== undefined ? plant.css : null,
  })
  note(`artifact: ${css.name} (${String(css.text.length)} B)`)
  if (plant !== null && plant.css !== undefined) {
    note(`PLANTED ${plant.name} in the stylesheet copy: ${plant.what}`)
  }

  const galleryPane = plant !== null && plant.pane !== undefined ? plant.pane : 'gallery'
  let accentSubjects = 0
  let bandSubjects = 0
  let gradedPairs = 0
  let statePairs = 0
  const statesEntered = { hover: 0, active: 0, focus: 0 }
  const ledgerHits = new Set()

  /**
   * Runs the interaction-state sweep on a pane and folds its totals in.
   *
   * Always the **last** thing done on a pane. The sweep leaves a pointer
   * somewhere, a ring on something and — for a moment — a forced pseudo-class in
   * the style engine, and no other check should have to reason about that.
   */
  const swept = async (p) => {
    const r = await checkStates(p, ledgerHits)
    statePairs += r.reread
    for (const [k, v] of Object.entries(r.entered)) statesEntered[k] += v
  }

  // Derived from the artifact's own text, once, and handed to every pane.
  const allowed = extractColours(css.text)
  note(`palette: ${String(allowed.length)} colour token(s) extracted from ${css.name}`)

  setPhase('gallery pane')
  let motionAtRest = null
  const gallery = await openPane(page, { pane: galleryPane })
  try {
    const s = await gallery.measure('sanity')
    if (checkSanity(s, galleryPane)) {
      accentSubjects += await checkAccentColour(gallery)
      await checkPalette(gallery, allowed)
      gradedPairs += await legible(gallery, { minPairs: PANE_PAIR_FLOOR.gallery }, ledgerHits)
      // Read before the accent check's clicks could matter, and on the pane that
      // carries the connection dot. This is the "it does animate" half.
      motionAtRest = await gallery.measure('motion')
      // Both of these raise a `position: fixed` rig at the top of the z-order,
      // and although each tears its own down in a `finally`, nothing else here
      // should have to depend on that having happened. The state sweep is last
      // of all: it drives real input at the page.
      bandSubjects += await checkBorderBands(gallery)
      await swept(gallery)
    }
  } finally {
    gallery.close()
  }

  // `connect-fields` rather than `connect`: the dialog opens in URL mode, where
  // the `ssl` checkbox is not mounted at all. See `ConnectFieldsPane`.
  setPhase('connect pane')
  const connect = await openPane(page, { pane: 'connect-fields' })
  try {
    const s = await connect.measure('sanity')
    if (checkSanity(s, 'connect-fields')) {
      accentSubjects += await checkAccentColour(connect)
      await checkPalette(connect, allowed)
      gradedPairs += await legible(connect, { minPairs: PANE_PAIR_FLOOR['connect-fields'] }, ledgerHits)
      await swept(connect)
    }
  } finally {
    connect.close()
  }

  // The "and it stops" half, on its own window because the emulation is set on
  // the web contents before the first style pass.
  setPhase('reduced-motion pane')
  const reduced = await openPane(page, { pane: 'gallery', reduceMotion: true })
  try {
    const s = await reduced.measure('sanity')
    if (checkSanity(s, 'gallery under reduce') && motionAtRest !== null) {
      checkReducedMotion(motionAtRest, await reduced.measure('motion'))
    } else if (motionAtRest === null) {
      fail(
        'reduced-motion',
        'the un-emulated gallery pane never produced a motion reading, so there is nothing to ' +
          'compare against and this check cannot be satisfied.',
      )
    }
  } finally {
    reduced.close()
  }

  setPhase('consent panes')
  for (const locale of ['en', 'zh-CN']) {
    const consent = await openPane(page, {
      pane: 'consent',
      locale,
      width: FLOOR_VIEWPORT.width,
      height: FLOOR_VIEWPORT.height,
    })
    try {
      const s = await consent.measure('sanity')
      if (checkSanity(s, `consent [${locale}]`)) {
        checkConsentReach(await consent.measure('hitTestActive'), locale)
        gradedPairs += await legible(consent, { minPairs: PANE_PAIR_FLOOR.consent }, ledgerHits)
        await swept(consent)
      }
    } finally {
      consent.close()
    }
  }

  // Fail closed. A sweep that found nothing to sweep is the failure mode this
  // repository has shipped six times, and it reports as a pass every time.
  if (accentSubjects === 0) {
    fail(
      'accent-color',
      'not one checkbox or radio was found on any pane, so the user-agent accent was never ' +
        'measured. This check passes only by having looked at something.',
    )
  } else {
    note(`accent-color: ${String(accentSubjects)} user-agent-painted control(s) measured`)
  }

  // Same fail-closed accounting, and it matters more here than anywhere else:
  // this app ships no double borders, so the band counter's only routine subject
  // is its own calibration rig. If that did not run, this check looked at
  // literally nothing — and "no double borders were painted wrong" is trivially
  // true of a page with no borders and of a check that never executed.
  if (bandSubjects === 0) {
    fail(
      'border-bands',
      'the band counter measured nothing at all — not even its calibration rig. It passes only by ' +
        'having resolved a real two-line border, and it resolved none.',
    )
  } else {
    note(`border-bands: ${String(bandSubjects)} border(s) counted in the framebuffer`)
  }

  // Two more fail-closed accounts, and they answer different questions. The
  // first: did the grader see the whole run, or did the panes fail one at a time
  // in a way each per-pane floor forgave? The second: is every recorded breach
  // still a thing this app renders? A ledger that outlives the pair it describes
  // is a ledger nobody is reading, and it is the way an exemption list turns into
  // a list of colours nothing checks.
  if (gradedPairs < RUN_PAIR_FLOOR) {
    fail(
      'legibility',
      `${String(gradedPairs)} text/surface pair(s) were graded across the whole run, under the floor ` +
        `of ${String(RUN_PAIR_FLOOR)}. Grading a handful of pairs and reporting a clean page is the ` +
        'failure this check exists to make impossible.',
    )
  } else {
    note(`legibility: ${String(gradedPairs)} text/surface pair(s) graded across the run`)
  }
  /*
   * The state sweep's own fail-closed account, and it asks two questions.
   *
   * The first: was every state entered *somewhere*? A driver that silently
   * stopped working — a CDP method renamed, focus emulation refused, a pointer
   * dispatched into a window that has moved — takes the whole of one state's
   * coverage with it and leaves every per-pane note reading like a pane that
   * simply has no such rules.
   *
   * The second: was enough re-read inside those states to be worth calling a
   * sweep? Same shape as `RUN_PAIR_FLOOR` above, and the floor is on pairs
   * re-read rather than on pairs repainted, because the keyboard ring paints an
   * `outline` and is entitled to change no text pair at all.
   */
  const never = Object.entries(statesEntered).filter(([, n]) => n === 0)
  if (never.length > 0) {
    fail(
      'states',
      `${never.map(([k]) => '`:' + k + '`').join(' and ')} was never entered on any pane in this ` +
        'run. The artifact paints these states, so either every subject on every pane was excluded ' +
        'or the driver for it stopped working — and a state nobody entered is a state nobody ' +
        'checked, which is the hole this check was added to close.',
    )
  }
  if (statePairs < STATE_REREAD_FLOOR) {
    fail(
      'states',
      `${String(statePairs)} text/surface pair(s) were re-read inside an interaction state across ` +
        `the whole run, under the floor of ${String(STATE_REREAD_FLOOR)}. Sweeping a handful of ` +
        'pairs and reporting a clean page is the failure this check exists to make impossible.',
    )
  } else {
    note(
      `states: ${String(statePairs)} pair(s) re-read across the run — ` +
        Object.entries(statesEntered)
          .map(([k, n]) => `${String(n)} \`:${k}\` subject(s)`)
          .join(', '),
    )
  }
  const stale = BELOW_FLOOR_RENDERED.filter((b) => !ledgerHits.has(`${b.ink}|${b.on}|${b.state}`))
  // Reported against whichever check is supposed to render it. A recorded
  // hover breach that stops appearing is the state sweep having lost coverage,
  // and saying `legibility` would send the next person to the wrong half of the
  // file — which is the mistake §26.7 had to be corrected for.
  for (const [check, group] of [
    ['legibility', stale.filter((b) => b.state === 'rest')],
    ['states', stale.filter((b) => b.state !== 'rest')],
  ]) {
    if (group.length === 0) continue
    fail(
      check,
      'BELOW_FLOOR_RENDERED records pairs this run never rendered:\n' +
        group
          .map((b) => `    ${b.ink} on ${b.on} ${b.state === 'rest' ? 'at rest' : `under \`:${b.state}\``} — ${b.where}`)
          .join('\n') +
        '\n  Either the breach was repaired, in which case delete the entry, or the pane that showed ' +
        'it stopped rendering it, in which case the check has quietly lost coverage and the entry is ' +
        'the only evidence.',
    )
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

// The "you need Electron" guard used to be here. It is now beside the `electron`
// require at the top of the file, because here it was never reached — see the
// comment there.

// Nothing may be `await`ed at the top level of an ESM Electron main script: it
// stalls the ready sequence and `app.whenReady()` never resolves. See the header.
app.on('window-all-closed', () => {
  /* deliberately empty — the default quits the app out from under the next pane */
})

app.whenReady().then(
  () =>
    run().then(
      () => {
        report()
      },
      (err) => {
        if (err instanceof ProbeSetupError) {
          fail('setup', err.message)
        } else {
          fail('setup', `the probe threw: ${String(err && err.stack ? err.stack : err)}`)
        }
        report()
      },
    ),
  (err) => {
    process.stderr.write(`render-probe: Electron never became ready: ${String(err)}\n`)
    finish(1)
  },
)

function report() {
  setPhase('reporting')
  const out = { write: (t) => say(t) }
  for (const line of notes) out.write(`render-probe: ${line}\n`)
  if (failures.length > 0) {
    out.write(`\nrender-probe: ${String(failures.length)} check(s) FAILED\n\n`)
    for (const f of failures) out.write(`  [${f.check}] ${f.message}\n\n`)
  } else {
    out.write('render-probe: all checks passed\n')
  }

  if (plant === null) {
    finish(failures.length === 0 ? 0 : 1)
    return
  }

  /*
   * A planted run is asking the opposite question, and it is strict about which
   * check answered: a plant that turns some *other* check red has proved nothing
   * about the fence it was aimed at.
   */
  const caught = failures.some((f) => f.check === plant.catches)
  if (caught) {
    out.write(
      `\nrender-probe: PLANT PROVEN — --plant=${plant.name} was caught by [${plant.catches}].\n`,
    )
    finish(0)
  } else {
    out.write(
      `\nrender-probe: PLANT ESCAPED — --plant=${plant.name} (${plant.what}) was NOT caught by ` +
        `[${plant.catches}]. The fence does not do what it says.\n`,
    )
    finish(1)
  }
}
