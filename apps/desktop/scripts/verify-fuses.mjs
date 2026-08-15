/*
 * ==================================================================
 * Read the fuses back out of the packaged binary, and prove the sharp one is
 * actually shut.
 * ==================================================================
 *
 * Design 2026-08-07 §4.8 item 34, which the §4sedecies ledger recorded as ⬜
 * 没跑: `package-mac.mjs` calls `flipFuses`, and **nobody had ever read the
 * result back**. That gap has a specific shape worth naming — flipping a fuse is
 * a write into a sentinel-delimited region of the Electron framework binary, and
 * every way it can go wrong is quiet:
 *
 *  - `flipFuses` runs before signing (it has to; it rewrites the binary), so a
 *    re-sign that reordered would invalidate nothing visible;
 *  - the fuse wire is versioned, and a fuse added in a later Electron shifts no
 *    index but does arrive at `INHERIT` rather than at a value we chose;
 *  - `@electron/packager` produces the bundle *before* this step, so a build that
 *    skipped the step ships a working app with every fuse at its default.
 *
 * None of those makes the app fail to launch, and a fuse at its default is
 * `RunAsNode: on` — a signed binary that runs arbitrary JavaScript under peek's
 * own signature and TCC grants. So the only honest check reads the shipped bytes.
 *
 * ## Two halves, and the second is the one that matters
 *
 * 1. **The wire says disabled.** `getCurrentFuseWire` on the packaged bundle,
 *    asserting `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
 *    `EnableNodeCliInspectArguments` are all `FuseState.DISABLE`.
 * 2. **The binary behaves as if it were.** `ELECTRON_RUN_AS_NODE=1 <binary> -e …`
 *    must not run the script. A wire read agrees with itself by construction; it
 *    cannot tell you that this Electron build honours the bit.
 *
 * Half 2 carries a **positive control**, and it is not optional. "The sentinel
 * did not appear" is also what a mistyped command, a wrong binary path and a
 * silent crash all look like, and this repository has been bitten repeatedly by
 * checks that read nothing and reported success. So the same command is run
 * against the *unfused* development Electron in `node_modules`, where the
 * sentinel **must** appear. One command, two binaries, opposite verdicts — that
 * is the whole reverse verification, and it needs no source edit.
 *
 * ## What this cannot tell you
 *
 * `asar: false` means the two integrity fuses do not apply and nothing here
 * detects an edited `out/main/index.js` (`package-mac.mjs` header, §2.10). The
 * report prints all nine fuses rather than only the three under test so that the
 * two sitting at `DISABLE`-for-lack-of-an-archive are visible instead of
 * inferred.
 *
 * ## Running it
 *
 *     pnpm --filter @peek/desktop package        # produces release/…/peek.app
 *     pnpm --filter @peek/desktop verify:fuses
 *
 * There is deliberately **no skip path**: a missing bundle is a failure with a
 * message, not a pass. Exit 0 = both halves held.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FuseState, FuseV1Options, getCurrentFuseWire, pathToFuseFile } from '@electron/fuses'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * The same three strings `package-mac.mjs` builds its output path from. Repeated
 * rather than exported from there because importing it would execute its
 * top-level `await main()` — that file is a script, not a module.
 */
const APP_NAME = 'peek'
const ARCH = 'arm64'

/**
 * `--bundle=<path>` overrides which `.app` is read.
 *
 * It exists for one job, and the job is this file's own reverse verification:
 * copy the bundle, flip `RunAsNode` back on in the copy (with
 * `resetAdHocDarwinSignature: true`, or macOS will refuse to execute it and the
 * second half would go quiet for the wrong reason), and point this at the copy.
 * Both halves must go red. Doing that in place would leave the user's app
 * unsigned if anything died in between, which is why the knob is here rather
 * than a sed on the constant above.
 */
const bundleArg = process.argv.slice(2).find((a) => a.startsWith('--bundle='))
const appBundle =
  bundleArg === undefined
    ? join(packageDir, 'release', `${APP_NAME}-darwin-${ARCH}`, `${APP_NAME}.app`)
    : resolve(bundleArg.slice('--bundle='.length))
const packagedBinary = join(appBundle, 'Contents', 'MacOS', APP_NAME)

/** The unfused binary the positive control needs. */
const devBinary = join(
  packageDir,
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'MacOS',
  'Electron',
)

/** The three §2.10 could turn on. The other six are reported, not asserted. */
const REQUIRED_OFF = [
  FuseV1Options.RunAsNode,
  FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  FuseV1Options.EnableNodeCliInspectArguments,
]

const SENTINEL = 'PEEK_FUSE_PROBE_RAN_AS_NODE'

/** How long a binary gets to prove it is a Node interpreter. */
const RUN_MS = 12_000

const failures = []
const fail = (message) => failures.push(message)
const lines = []
const say = (line) => lines.push(line)

/**
 * Run one binary under `ELECTRON_RUN_AS_NODE=1` and report whether the script ran.
 *
 * The environment is scrubbed of everything that would let the app half of this
 * touch the user's machine: `PEEK_CONFIG_DIR` points at a throwaway directory and
 * `PEEK_MCP_PORT` at a port nothing listens on, because when the fuse *is* off
 * the binary boots the real app — and a verification script that binds peek's
 * real port and reads the real keychain is a side effect nobody asked for.
 *
 * Killed by process group: in app mode the binary forks helpers, and killing only
 * the leader leaves them running.
 */
async function ranAsNode(binary, label) {
  const configDir = mkdtempSync(join(tmpdir(), 'peek-fuse-'))
  try {
    const child = spawn(binary, ['-e', `console.log(${JSON.stringify(SENTINEL)} + ':' + process.version)`], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PEEK_CONFIG_DIR: configDir,
        // 0 would be a free port; a fixed unlikely one keeps the log readable and
        // the app half is being killed in a moment either way.
        PEEK_MCP_PORT: '58631',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', () => {
      /* app mode is noisy on stderr and none of it is the answer */
    })

    const exited = await new Promise((settle) => {
      const timer = setTimeout(() => settle(false), RUN_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        settle(true)
      })
    })
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone, which is the state we wanted */
      }
    }
    const ran = out.includes(SENTINEL)
    say(`  ${label}: ${ran ? `ran the script (${out.trim().split('\n')[0]})` : 'did not run the script'}`)
    return ran
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(appBundle)) {
    process.stderr.write(
      `verify-fuses: no packaged bundle at\n  ${appBundle}\n` +
        'Run `pnpm --filter @peek/desktop package` first. This is a failure rather than a skip:\n' +
        'the fuses are a property of the shipped binary, so there is nothing to check without one.\n',
    )
    process.exit(1)
  }

  say(`the bundle: ${appBundle}`)
  say(`the fuse wire lives in: ${pathToFuseFile(appBundle)}`)
  say('')

  /* --- Half 1: what the wire says --- */

  const wire = await getCurrentFuseWire(appBundle)
  const stateName = (value) => FuseState[value] ?? `unknown(${String(value)})`
  say('the wire, all nine:')
  for (const [index, name] of Object.entries(FuseV1Options)) {
    // The enum is a two-way map; only the numeric-key half names a fuse.
    if (Number.isNaN(Number(index))) continue
    const value = wire[index]
    const required = REQUIRED_OFF.includes(Number(index))
    say(`  ${required ? '*' : ' '} ${String(name).padEnd(38)} ${stateName(value)}`)
  }
  say('  (* = asserted below; the two asar fuses do not apply to an asar: false build)')

  for (const fuse of REQUIRED_OFF) {
    const value = wire[fuse]
    if (value !== FuseState.DISABLE) {
      fail(`${String(FuseV1Options[fuse])} is ${stateName(value)}, not DISABLE`)
    }
  }

  /* --- Half 2: what the binary does, against a control that must say yes --- */

  say('')
  say(`ELECTRON_RUN_AS_NODE=1 <binary> -e "console.log('${SENTINEL}')":`)
  const packagedRan = await ranAsNode(packagedBinary, 'the packaged peek binary')
  const devRan = await ranAsNode(devBinary, 'node_modules electron (unfused control)')

  if (packagedRan) {
    fail('the packaged binary honoured ELECTRON_RUN_AS_NODE — the RunAsNode fuse is not shut')
  }
  if (!devRan) {
    // Without this the whole second half is unfalsifiable: if the control cannot
    // reach Node mode either, "the packaged one did not" measures the command, not
    // the fuse.
    fail(
      'the unfused control did not reach Node mode either, so this check proved nothing about the ' +
        'packaged binary. Fix the control before reading the line above.',
    )
  }

  process.stdout.write(`\n${lines.join('\n')}\n\n`)
  if (failures.length === 0) {
    process.stdout.write(
      'verify-fuses: the three fuses read DISABLE, and the packaged binary refuses Node mode.\n',
    )
    return
  }
  process.stderr.write(
    `verify-fuses: ${String(failures.length)} failure(s):\n${failures.map((f) => `  - ${f}\n`).join('')}`,
  )
  process.exitCode = 1
}

await main()
