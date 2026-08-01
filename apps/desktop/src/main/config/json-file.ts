/**
 * Reading and writing the small JSON files under `~/.peek`.
 *
 * Three properties matter here, and none of them are the JSON:
 *
 * 1. **A corrupt file is not a crash.** These files are edited by hand (the
 *    README tells people to read `mcp.json`), so a truncated write or a stray
 *    comma has to degrade to "no saved state" rather than take the app down on
 *    launch. Every read returns `null` on any failure.
 * 2. **The write is atomic.** A half-written connection book would lose every
 *    entry, and peek writes it on each successful connect — i.e. often enough
 *    that "the app was killed mid-write" is a real scenario. Write to a
 *    temporary file in the same directory, then rename over the target.
 * 3. **The permissions are tight from the first byte.** The book holds encrypted
 *    credentials and `mcp.json` holds a bearer token; both are 0600 inside a
 *    0700 directory. `mode` in `writeFileSync` only applies when the file is
 *    created, so an existing file is chmod'ed explicitly.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CONFIG_DIR_MODE = 0o700
export const CONFIG_FILE_MODE = 0o600

/** Parsed JSON, or null when the file is missing, unreadable or malformed. */
export function readJsonFile(path: string): unknown {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Write one JSON file atomically. Throws on failure — callers decide whether a
 * failed save is worth telling the user about.
 */
export function writeJsonFile(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })

  // The temporary file sits beside the target so the rename stays within one
  // filesystem; a cross-device rename is not atomic and would fall back to copy.
  const temp = `${path}.${String(process.pid)}.tmp`
  try {
    writeJsonAt(temp, value)
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temporary file was never created, or is already gone.
    }
    throw error
  }
  tighten(path)
}

function writeJsonAt(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  tighten(path)
}

function tighten(path: string): void {
  try {
    chmodSync(path, CONFIG_FILE_MODE)
  } catch {
    // chmod is largely meaningless on Windows; failing here breaks nothing.
  }
}
