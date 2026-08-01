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
 * - ad-hoc code signing. On Apple Silicon macOS refuses to execute unsigned
 *   binaries outright, so this is not a Gatekeeper nicety — an unsigned build
 *   simply will not launch. Packager renames the helper bundles, which breaks
 *   the signatures Electron ships with, so the app is re-signed here.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * The ACP host locates the agent with `createRequire` against
 * '@agentclientprotocol/claude-agent-acp/dist/index.js' — a path built at
 * runtime, which is deliberate (the agent is spawned as a child process, never
 * linked). Nothing in the bundles mentions it as a specifier, so it has to be
 * named here or the packaged app ships a chat panel that cannot start an agent.
 */
const RUNTIME_RESOLVED = ['@agentclientprotocol/claude-agent-acp']

const APP_NAME = 'peek'
const BUNDLE_ID = 'io.github.gyangu.peek'
const ARCH = 'arm64'

const outDir = join(packageDir, 'out')
const releaseDir = join(packageDir, 'release')
const stageDir = join(releaseDir, 'stage')
const icnsPath = join(packageDir, 'build', 'icon.icns')

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
  // Loaded through existsSync in createWindow; without it the window degrades to read-only
  'out/preload/index.cjs',
  'out/renderer/index.html',
]

function assertContains(root, label, extraFiles = []) {
  const missing = [...REQUIRED_FILES, ...extraFiles].filter((rel) => !existsSync(join(root, rel)))
  if (missing.length > 0) {
    throw new Error(`${label} is missing required files:\n  ${missing.join('\n  ')}`)
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

  cpSync(outDir, join(stageDir, 'out'), { recursive: true })

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
  // @peek/driver-sql — so each workspace package is offered as a starting point.
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

  console.log('[package] ad-hoc signing')
  signAdHoc(appBundle)

  // The staging copy has served its purpose; leaving it behind just confuses
  // anyone looking at release/ for the actual product.
  rmSync(stageDir, { recursive: true, force: true })

  console.log(`[package] ${appBundle}`)
  console.log('[package] install it with: pnpm install:local')
}

await main()
