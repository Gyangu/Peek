/**
 * Package the built renderer/preload/main bundles into peek.app (macOS, arm64).
 *
 * Why @electron/packager and not electron-builder
 * -----------------------------------------------
 * The only deliverable here is a double-clickable .app for this machine — no
 * dmg, no auto-update, no Developer ID signing, no notarization. Everything
 * electron-builder adds beyond that is weight, and its one real cost applies
 * directly to this repo: it resolves production dependencies by walking
 * node_modules, which under pnpm is a forest of symlinks into the store.
 * @electron/packager copies a directory verbatim, so pointing it at a staging
 * directory we assemble ourselves means the packager never sees the workspace
 * at all. If a dmg or an updater is ever needed, electron-builder can be
 * layered on top of the same `out/` tree without redoing any of this.
 *
 * Two decisions that are load-bearing rather than incidental:
 *
 * - `asar: false`. The driver host runs in an Electron utilityProcess, forked
 *   by path (src/main/connections/host-process.ts). Entry resolution inside an
 *   asar archive is exactly the kind of thing that works in one Electron
 *   version and not the next, and the app payload is under 20 MB against a
 *   280 MB Electron runtime, so an archive buys nothing measurable. A plain
 *   directory makes the forked path an ordinary file path.
 *
 *   **It also means this build has no application-integrity check.** The two
 *   asar fuses (`OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`)
 *   are the mechanism for that and neither applies without an archive, so
 *   `flipSecurityFuses` below turns off only the three that stop the *binary*
 *   from being reused as a Node interpreter. Nothing here detects an edited
 *   `out/main/index.js`. Read that function's comment before concluding that
 *   fuses closed this.
 *
 * - ad-hoc code signing. On Apple Silicon macOS refuses to execute unsigned
 *   binaries outright, so this is not a Gatekeeper nicety — an unsigned build
 *   simply will not launch. Packager renames the helper bundles, which breaks
 *   the signatures Electron ships with, so the app is re-signed here.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses'
import { packager } from '@electron/packager'
import { stageNodeModules } from './stage-node-modules.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every workspace package directory, as an extra resolution root.
 *
 * Read off disk rather than from pnpm-workspace.yaml: the point is where things
 * actually are, and a new driver package should not need this file edited.
 */
function workspacePackageDirs() {
  const packagesDir = resolve(packageDir, '..', '..', 'packages')
  if (!existsSync(packagesDir)) return []
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
    .map((e) => join(packagesDir, e.name))
}

/**
 * Packages resolved at runtime rather than imported, so no scan can find them.
 *
 * Each ACP agent profile locates its agent with `createRequire` against a path
 * built at runtime — deliberate, since the agent is spawned as a child process
 * and never linked. Nothing in the bundles mentions these as specifiers, so they
 * have to be named here or the packaged app ships a chat panel that cannot start
 * the agent the user selected.
 *
 * One entry per profile in `src/main/acp/profiles.ts`. Adding a profile without
 * adding it here works in development and fails only in a packaged build, which
 * is the worst place to find out.
 */
const RUNTIME_RESOLVED = ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp']

const APP_NAME = 'peek'
const BUNDLE_ID = 'io.github.gyangu.peek'
const ARCH = 'arm64'

const outDir = join(packageDir, 'out')
const packagesOutDir = join(outDir, 'packages')
const releaseDir = join(packageDir, 'release')
const stageDir = join(releaseDir, 'stage')
/**
 * The name the shipped packages wear inside `Contents/Resources`.
 *
 * The same string as `BUNDLED_PACKAGES_DIR_NAME` in
 * `src/main/packages/bundled.ts`, which is what main resolves against
 * `process.resourcesPath` at startup. Spelled twice rather than imported,
 * because that module reaches `@peek/core` and this script runs under plain
 * node with no resolver hooks; `bundled.test.ts` reads this file and fails if
 * the two ever stop agreeing. Renaming one alone ships an app that lays out no
 * packages at all — and it does that silently, since an empty packages
 * directory is also what a first run legitimately starts from.
 */
const BUNDLED_PACKAGES_DIR_NAME = 'bundled-packages'
// Staged under its final name, because @electron/packager copies an extra
// resource in as the directory it already is — `out/packages` would land in
// Contents/Resources as `packages`.
const bundledStageDir = join(releaseDir, BUNDLED_PACKAGES_DIR_NAME)
const icnsPath = join(packageDir, 'build', 'icon.icns')
const runtimeIconPath = join(packageDir, 'resources', 'icon.png')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Everything the packaged app must contain, as paths relative to the staged
 * app root. Checked before packaging (is the build complete?) and again inside
 * the finished bundle (did it all survive the copy?) — the second check is the
 * one that catches a packager filter quietly dropping a file.
 */
const REQUIRED_FILES = [
  'package.json',
  // The main-process entry named by package.json#main
  'out/main/index.js',
  // The utilityProcess entry; ConnectionManager forks it from out/main
  'out/main/driver-host.js',
  // The other utilityProcess entry, in a directory of its own because it is
  // built by a Rollup graph of its own (electron.vite.package-host.config.ts).
  // Same argument as the package UI below: a separate pass is a pass that can be
  // skipped, and skipping it ships an app where every package view and every
  // package tool fails at first use rather than at build time.
  'out/package-host/package-host.js',
  // Loaded through existsSync in createWindow; without it the window degrades to read-only
  'out/preload/index.cjs',
  'out/renderer/index.html',
]

/**
 * A database package, as it is laid out on disk (design 2026-08-07 §2.2): three
 * files beside a document root, built by a Vite pass of its own
 * (`scripts/build-packages.mjs`).
 *
 * Relative to the **bundled-packages root**, not to the app: these do not travel
 * inside `out/`. §2.5 puts the shipped copies in `Contents/Resources` on their
 * own, because they are not code this app loads — they are the originals it
 * copies into `~/.peek/packages/` on first start, and everything after that
 * reads the copy. Leaving them in `out/` would put two identical trees in the
 * bundle with nothing saying which one runs.
 *
 * neo4j is named rather than "whatever was built" for the same reason the list
 * above names files: the pass can be skipped — `electron-vite build` on its own
 * does not run it — and each of these fails differently and quietly when it is.
 * No manifest and the package does not load at all; no `driver.mjs` and every
 * connection to that database fails at connect time; no `ui/index.html` and a
 * Tier C view is a blank frame in a shipped app. An empty `bundled-packages`
 * would satisfy a check that only asked whether the directory was there.
 */
const REQUIRED_BUNDLED_FILES = [
  'neo4j/peek-package.json',
  'neo4j/driver.mjs',
  'neo4j/contrib.mjs',
  'neo4j/ui/index.html',
]

function assertContains(root, label, extraFiles = []) {
  const missing = [...REQUIRED_FILES, ...extraFiles].filter((rel) => !existsSync(join(root, rel)))
  if (missing.length > 0) {
    throw new Error(`${label} is missing required files:\n  ${missing.join('\n  ')}`)
  }
}

function assertBundledPackages(root, label) {
  const missing = REQUIRED_BUNDLED_FILES.filter((rel) => !existsSync(join(root, rel)))
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing bundled database packages:\n  ${missing.join('\n  ')}\n` +
        'Run "pnpm build:packages" (it is part of "pnpm build").',
    )
  }
}

/**
 * Assemble the app root that gets copied into Contents/Resources/app.
 *
 * The staged package.json is written from scratch rather than copied: the
 * workspace manifest declares `workspace:*` dependencies, which mean nothing
 * outside the monorepo, alongside dependencies that the renderer bundle already
 * inlines. What the app genuinely needs at runtime is derived from the built
 * output instead (see stage-node-modules.mjs) — a manifest copied wholesale
 * would describe a tree that is not there. Name and version still come from the
 * real manifest, so those keep one source of truth.
 *
 * Returns the external packages that were staged.
 */
function stage(version) {
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  rmSync(bundledStageDir, { recursive: true, force: true })

  // `out/packages` is the one part of the build that is not the app's own code,
  // so it is lifted out of the copy and staged as a resource of its own (see
  // `REQUIRED_BUNDLED_FILES`). Excluded rather than copied twice: two identical
  // trees in one bundle is an invitation to load the wrong one.
  cpSync(outDir, join(stageDir, 'out'), {
    recursive: true,
    filter: (src) => src !== packagesOutDir,
  })
  cpSync(packagesOutDir, bundledStageDir, { recursive: true })
  assertBundledPackages(bundledStageDir, 'The bundled-packages staging directory')

  writeFileSync(
    join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: APP_NAME,
        productName: APP_NAME,
        version,
        description: 'A database viewer whose window can be driven over MCP',
        private: true,
        // The main bundle is ESM and uses import.meta.dirname to locate the
        // preload, the renderer and the driver host, so the type matters.
        type: 'module',
        main: 'out/main/index.js',
      },
      null,
      2,
    )}\n`,
  )

  // The bundles inline every workspace package, so a leftover external may be a
  // dependency of any of them rather than of the app. Under pnpm's strict layout
  // those are not visible from the app directory — mysql2 belongs to
  // @peek/db-sql — so each workspace package is offered as a starting point.
  const externals = stageNodeModules({
    buildDir: join(stageDir, 'out'),
    resolveFrom: [packageDir, ...workspacePackageDirs()],
    stageDir,
    alsoInclude: RUNTIME_RESOLVED,
  })

  assertContains(stageDir, 'The staging directory', manifestPathsOf(externals))
  return externals
}

/** Each staged package must at least have its manifest, or resolution fails at launch. */
const manifestPathsOf = (externals) => externals.map((name) => `node_modules/${name}/package.json`)

/**
 * Turn off the Electron fuses that let a signed binary be used as something
 * other than this app.
 *
 * ## What a fuse is, and why signing does not cover this
 *
 * A fuse is a bit flipped in the Electron binary itself. Ad-hoc signing (below)
 * proves the bundle has not been modified *since we signed it* — it says nothing
 * about what the binary is willing to do when asked nicely. `RunAsNode` is the
 * sharp one: with it on, `ELECTRON_RUN_AS_NODE=1 /path/to/peek script.js` runs
 * arbitrary JavaScript under peek's own signature and TCC permissions. Every
 * check that trusts "this is the signed peek binary" is then trusting an
 * interpreter.
 *
 * The three below are the ones that apply here:
 *
 * - `RunAsNode` — the above.
 * - `EnableNodeOptionsEnvironmentVariable` — `NODE_OPTIONS=--require evil.js`
 *   injects a module into the app's own processes.
 * - `EnableNodeCliInspectArguments` — `--inspect-brk` attaches a debugger with
 *   full access to main-process memory, which includes decrypted credentials.
 *
 * ## The two that are deliberately not here
 *
 * `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` both require
 * an asar archive, and this build sets `asar: false` (see the header comment for
 * why: the driver host is forked as a utilityProcess entry, and forking an entry
 * inside an asar is exactly the kind of thing that works in one Electron version
 * and not the next).
 *
 * **So this build has no application-integrity check at all**, and that limit
 * belongs in the open: flipping these fuses stops the peek binary from being
 * *reused* as a Node interpreter; it does not stop someone who can write to
 * `out/main/index.js` from changing what peek does. Under
 * `docs/design/2026-08-07-database-packages-from-disk.md` decision 6 that gap is
 * not the pressing one — anyone who can write into the app bundle can equally
 * drop a package into `~/.peek/packages/`, which is loaded with nothing checked
 * about it by design.
 *
 * Must run **before** signing: flipping a fuse rewrites the binary and would
 * invalidate a signature applied first.
 */
async function flipSecurityFuses(appBundle) {
  await flipFuses(appBundle, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // The signature is applied by `signAdHoc` immediately after this, so there
    // is no point paying for a second one here.
    resetAdHocDarwinSignature: false,
  })
}

/** Ad-hoc sign the bundle in place, innermost first (what --deep does for us). */
function signAdHoc(appPath) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  })
  // --verify re-walks every nested bundle; a helper we failed to re-sign shows
  // up here rather than as a silent crash on first launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
}

async function main() {
  const manifest = readJson(join(packageDir, 'package.json'))
  const electronVersion = readJson(
    join(packageDir, 'node_modules', 'electron', 'package.json'),
  ).version

  if (!existsSync(outDir)) {
    throw new Error(`No build output at ${outDir}. Run "pnpm build" first.`)
  }
  if (!existsSync(icnsPath)) {
    throw new Error(`No icon at ${icnsPath}. Run "pnpm icon" to generate it from build/icon.svg.`)
  }
  if (!existsSync(runtimeIconPath)) {
    throw new Error(`No runtime icon at ${runtimeIconPath}. Run "pnpm icon" to generate it.`)
  }

  console.log(`[package] staging ${APP_NAME} ${manifest.version} (electron ${electronVersion}, ${ARCH})`)
  const externals = stage(manifest.version)
  console.log(`[package] runtime dependencies: ${externals.length > 0 ? externals.join(', ') : 'none'}`)

  const [appPath] = await packager({
    dir: stageDir,
    out: releaseDir,
    name: APP_NAME,
    platform: 'darwin',
    arch: ARCH,
    electronVersion,
    appBundleId: BUNDLE_ID,
    appVersion: manifest.version,
    buildVersion: manifest.version,
    icon: icnsPath,
    // createWindow reads process.resourcesPath/icon.png in a packaged app, and
    // `bundledPackagesRoot` reads process.resourcesPath/bundled-packages.
    extraResource: [runtimeIconPath, bundledStageDir],
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: `Copyright © ${new Date().getFullYear()} peek`,
    darwinDarkModeSupport: true,
    // See the header: the driver host is forked by path from a utilityProcess.
    asar: false,
    // The staged node_modules is already exactly the runtime closure; letting
    // packager prune it would only give it a chance to remove something.
    prune: false,
    overwrite: true,
    // Signing is done below, so packager does not need a signing identity.
    osxSign: false,
    quiet: true,
    extendInfo: {
      NSHighResolutionCapable: true,
      // arm64-only build, so the floor is the first macOS that ran on one.
      LSMinimumSystemVersion: '11.0',
    },
  })

  const appBundle = join(appPath, `${APP_NAME}.app`)
  assertContains(
    join(appBundle, 'Contents', 'Resources', 'app'),
    'The packaged bundle',
    manifestPathsOf(externals),
  )
  assertBundledPackages(
    join(appBundle, 'Contents', 'Resources', BUNDLED_PACKAGES_DIR_NAME),
    'The packaged bundle',
  )
  const packagedRuntimeIconPath = join(appBundle, 'Contents', 'Resources', 'icon.png')
  if (!existsSync(packagedRuntimeIconPath)) {
    throw new Error(`The packaged bundle is missing its runtime icon: ${packagedRuntimeIconPath}`)
  }
  if (!readFileSync(packagedRuntimeIconPath).equals(readFileSync(runtimeIconPath))) {
    throw new Error('The packaged runtime icon does not match resources/icon.png')
  }

  // Before signing, not after: flipping a fuse rewrites the binary.
  console.log('[package] flipping security fuses')
  await flipSecurityFuses(appBundle)

  console.log('[package] ad-hoc signing')
  signAdHoc(appBundle)

  // The staging copies have served their purpose; leaving them behind just
  // confuses anyone looking at release/ for the actual product.
  rmSync(stageDir, { recursive: true, force: true })
  rmSync(bundledStageDir, { recursive: true, force: true })

  console.log(`[package] ${appBundle}`)
  console.log('[package] install it with: pnpm install:local')
}

await main()
