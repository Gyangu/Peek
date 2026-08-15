/**
 * Where peek keeps what it writes: four files, and one subtree.
 *
 * `~/.peek` was already the home of `mcp.json`; the connection book, the
 * settings file and the workspace join it rather than spreading into Electron's
 * `userData`, for one reason: `mcp.json` is a file a human is told to `cat`, and
 * splitting "things you may look at" from "things the app happens to store"
 * would make the documented path an exception instead of the rule.
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
/** The desk as it was left: the layout tree, and the definition of every open view. */
export const WORKSPACE_FILE_NAME = 'workspace.json'
/**
 * Where a `workspace.json` that could not be read is moved aside to.
 *
 * Renamed rather than deleted, and rather than overwritten in place: the file
 * describes work someone arranged by hand, so the one thing a failed read must
 * not do is destroy it. It is also the only evidence of what went wrong.
 */
export const WORKSPACE_QUARANTINE_SUFFIX = '.bad'
/** Installed database packages, one directory each. */
export const PACKAGES_DIR_NAME = 'packages'
/**
 * Diagnostics and the command audit.
 *
 * Under `~/.peek` rather than Electron's `app.getPath('logs')` for the reason
 * this file opens with: the whole point of that root is that everything peek
 * writes is in one directory a human can open. A log the user has to be told to
 * find in `~/Library/Logs` on one platform and `%APPDATA%` on another is the
 * exception that makes the rule useless — and a log nobody can find is a log
 * that may as well not be written.
 */
export const LOGS_DIR_NAME = 'logs'

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

export function workspaceFilePath(configDir: string): string {
  return join(configDir, WORKSPACE_FILE_NAME)
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

/**
 * Where the two log streams live.
 *
 * A directory rather than two paths beside the config files, because the pair is
 * meant to be handed over together: "zip this folder and attach it" is the whole
 * user-facing story, and it only works if the folder holds exactly the logs.
 */
export function logsDir(configDir: string): string {
  return join(configDir, LOGS_DIR_NAME)
}
