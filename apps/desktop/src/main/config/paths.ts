/**
 * Where peek keeps what it writes: three files, and one subtree.
 *
 * `~/.peek` was already the home of `mcp.json`; the connection book and the
 * settings file join it rather than spreading into Electron's `userData`, for
 * one reason: `mcp.json` is a file a human is told to `cat`, and splitting
 * "things you may look at" from "things the app happens to store" would make
 * the documented path an exception instead of the rule.
 *
 * **This used to say "the three files it is allowed to write", and that closed
 * set is what `packages/` ends** (design 2026-08-07 §2.2). A database package is
 * a directory the *user* puts there — by hand, or through the install button —
 * and peek writes into the same tree when it lays out the packages it ships
 * with. So the invariant is no longer "peek writes exactly these three files";
 * it is that everything peek writes is under one directory a human can open, and
 * that a package's own directory is the boundary anything read out of it is
 * checked against (`main/packages/loader.ts`, `main/packages/assets.ts`).
 *
 * `PEEK_CONFIG_DIR` redirects all of it together. Integration runs rely on that
 * — a smoke check has to be able to start beside an installed peek without
 * overwriting the book or the endpoint file its AI client is pointed at, and now
 * without loading the packages that installation happens to have.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { PEEK_CONFIG_DIR_NAME } from '@peek/core'

/** Saved connections. */
export const CONNECTIONS_FILE_NAME = 'connections.json'
/** User preferences that outlive a session (today: the MCP port). */
export const SETTINGS_FILE_NAME = 'settings.json'
/** Installed database packages, one directory each. */
export const PACKAGES_DIR_NAME = 'packages'

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PEEK_CONFIG_DIR']
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), PEEK_CONFIG_DIR_NAME)
}

export function connectionsFilePath(configDir: string): string {
  return join(configDir, CONNECTIONS_FILE_NAME)
}

export function settingsFilePath(configDir: string): string {
  return join(configDir, SETTINGS_FILE_NAME)
}

/**
 * The directory the loader scans, and the root every `peek-package://` URL is
 * resolved against.
 *
 * One function rather than two constants because those two callers must not be
 * able to disagree: a package whose UI is served from one root and whose
 * manifest was read from another is a package that half-loads, which is the
 * failure the loader exists to prevent.
 */
export function packagesDir(configDir: string): string {
  return join(configDir, PACKAGES_DIR_NAME)
}
