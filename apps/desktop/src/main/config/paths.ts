/**
 * Where peek keeps the three files it is allowed to write.
 *
 * `~/.peek` was already the home of `mcp.json`; the connection book and the
 * settings file join it rather than spreading into Electron's `userData`, for
 * one reason: `mcp.json` is a file a human is told to `cat`, and splitting
 * "things you may look at" from "things the app happens to store" would make
 * the documented path an exception instead of the rule.
 *
 * `PEEK_CONFIG_DIR` redirects all three together. Integration runs rely on that
 * — a smoke check has to be able to start beside an installed peek without
 * overwriting the book or the endpoint file its AI client is pointed at.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { PEEK_CONFIG_DIR_NAME } from '@peek/core'

/** Saved connections. */
export const CONNECTIONS_FILE_NAME = 'connections.json'
/** User preferences that outlive a session (today: the MCP port). */
export const SETTINGS_FILE_NAME = 'settings.json'

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
