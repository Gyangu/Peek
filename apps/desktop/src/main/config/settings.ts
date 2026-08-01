/**
 * `~/.peek/settings.json` — preferences that outlive a session.
 *
 * Exactly one entry today, the MCP port, and that is on purpose: a settings file
 * is a place things accumulate, so what may go in it is the small set of choices
 * that would otherwise have to be made again on every launch. Layout, open
 * views and query text stay in memory, as the README promises.
 *
 * Unknown keys are preserved on write. A user who has edited the file by hand,
 * or who ran a newer peek once, should not lose that by launching this one.
 */

import { readJsonFile, writeJsonFile } from './json-file'
import { settingsFilePath } from './paths'

export interface PeekSettings {
  /**
   * Preferred MCP port. Absent means "whatever core's default is" — kept absent
   * rather than materialized so that a future change to the default reaches
   * users who never chose a port.
   */
  mcpPort?: number
}

export interface SettingsStore {
  read(): PeekSettings
  /** Merge and persist. Throws only if the file cannot be written. */
  update(patch: PeekSettings): PeekSettings
  readonly path: string
}

export function createSettingsStore(configDir: string): SettingsStore {
  const path = settingsFilePath(configDir)
  let cached: Record<string, unknown> | null = null

  function load(): Record<string, unknown> {
    if (cached !== null) return cached
    const raw = readJsonFile(path)
    cached = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    return cached
  }

  return {
    path,
    read() {
      return project(load())
    },
    update(patch) {
      const next = { ...load(), version: 1, ...toRecord(patch) }
      writeJsonFile(path, next)
      cached = next
      return project(next)
    },
  }
}

function project(record: Record<string, unknown>): PeekSettings {
  const port = record['mcpPort']
  return isPort(port) ? { mcpPort: port } : {}
}

function toRecord(patch: PeekSettings): Record<string, unknown> {
  return patch.mcpPort === undefined ? {} : { mcpPort: patch.mcpPort }
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
