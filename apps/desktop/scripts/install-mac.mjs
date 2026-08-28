/**
 * Install the packaged Peek.app into /Applications.
 *
 * `ditto` rather than `cp -R`: it preserves extended attributes and the
 * resource forks inside the bundle, which is what keeps the ad-hoc code
 * signature intact. A signature broken in transit fails closed on Apple
 * Silicon — the app refuses to launch at all — so this is not cosmetic.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const APP_NAME = 'Peek'
const ARCH = 'arm64'

const builtApp = join(packageDir, 'release', `${APP_NAME}-darwin-${ARCH}`, `${APP_NAME}.app`)
const installedApp = join('/Applications', `${APP_NAME}.app`)

function main() {
  if (!existsSync(builtApp)) {
    throw new Error(`Nothing to install at ${builtApp}. Run "pnpm package" first.`)
  }

  /*
   * ditto merges into an existing bundle rather than replacing it, which would
   * leave files from a previous version behind. Remove first.
   *
   * Matched case-insensitively rather than by exact path, because the app was
   * `peek.app` until 2026-08-28 and a case-**sensitive** APFS volume — which
   * macOS offers, and some developers choose — treats that as a different
   * directory from `Peek.app`. Removing only the exact path there would leave
   * both bundles installed, both registered with Launch Services, sharing one
   * bundle identifier and one `~/.peek`, with no rule saying which one opens.
   * On the default case-insensitive volume this is the same single removal it
   * has always performed. See design 2026-08-28 §2.2.
   */
  const wanted = `${APP_NAME}.app`.toLowerCase()
  for (const entry of readdirSync('/Applications')) {
    if (entry.toLowerCase() !== wanted) continue
    const stale = join('/Applications', entry)
    console.log(`[install] replacing ${stale}`)
    rmSync(stale, { recursive: true, force: true })
  }

  execFileSync('ditto', [builtApp, installedApp], { stdio: 'inherit' })

  // A locally built app carries no quarantine flag, but one can be inherited if
  // the bundle ever travels through a browser, AirDrop or an archive. Clearing
  // it is free and makes the first launch predictable.
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', installedApp], { stdio: 'ignore' })
  } catch {
    // No such attribute — the normal case for a local build.
  }

  execFileSync('codesign', ['--verify', '--deep', '--strict', installedApp], { stdio: 'inherit' })

  console.log(`[install] ${installedApp}`)
  console.log(`[install] launch it from Spotlight, or: open -a ${installedApp}`)
}

main()
