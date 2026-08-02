/**
 * `~/.peek/settings.json` — preferences that outlive a session.
 *
 * Two entries today, and the bar for a third is the same as it was for these: a
 * settings file is a place things accumulate, so what may go in it is the small
 * set of choices that would otherwise have to be made again on every launch.
 * Layout, open views and query text stay in memory, as the README promises. So
 * does the UI language, which is renderer-local by decision — see the note atop
 * `renderer/i18n/store.ts`.
 *
 * Unknown keys are preserved on write. A user who has edited the file by hand,
 * or who ran a newer peek once, should not lose that by launching this one.
 */

import type { ExecutionBudgets } from '@peek/core'
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '@peek/core'
import { readJsonFile, writeJsonFile } from './json-file'
import { settingsFilePath } from './paths'

export interface PeekSettings {
  /**
   * Preferred MCP port. Absent means "whatever core's default is" — kept absent
   * rather than materialized so that a future change to the default reaches
   * users who never chose a port.
   */
  mcpPort?: number
  /**
   * Whole-fetch deadlines in milliseconds, and only the ones the user actually
   * changed. Absent members mean "core's default", for the same reason `mcpPort`
   * is absent rather than materialized: a user who never touched the query
   * timeout should follow us when we retune it.
   *
   * `0` is a value, not an absence — it means no deadline.
   */
  executionTimeouts?: Partial<ExecutionBudgets>
  /**
   * Whole-window zoom factor, as Electron's `zoomFactor`.
   *
   * Absent means "the default", on the same principle as the two above. Out-of-
   * range values are dropped on read rather than clamped: a hand-edited `4` is
   * more likely a typo than a wish, and 1 is a state the user can see and fix,
   * while 1.5-because-you-typed-4 is a state they cannot explain.
   */
  uiZoom?: number
}

const EXECUTION_KEYS = ['queryMs', 'scanMs', 'vectorSearchMs'] as const

/** Same ceiling main enforces (~1 hour); a typo cannot disable a deadline outright. */
const MAX_TIMEOUT_MS = 3_600_000

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
      const current = load()
      const changes = toRecord(patch)
      // Nested settings merge member-wise: "raise the query timeout" must not
      // unset the scan timeout that the caller had no opinion about.
      if (patch.executionTimeouts !== undefined) {
        const existing = project(current).executionTimeouts ?? {}
        changes['executionTimeouts'] = { ...existing, ...patch.executionTimeouts }
      }
      const next = { ...current, version: 1, ...changes }
      writeJsonFile(path, next)
      cached = next
      return project(next)
    },
  }
}

/**
 * The file, read as settings.
 *
 * Every field is validated on the way *out* as well as on the way in, because
 * the file is user-editable: a hand-typed `"queryMs": "two minutes"` must read
 * as "not set" rather than reach `setTimeoutSettings` as a string. Dropping the
 * bad key and keeping the good ones beats refusing the whole file, which would
 * make one typo look like a factory reset.
 */
function project(record: Record<string, unknown>): PeekSettings {
  const port = record['mcpPort']
  const settings: PeekSettings = {}
  if (isPort(port)) settings.mcpPort = port

  const zoom = record['uiZoom']
  if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= UI_ZOOM_MIN && zoom <= UI_ZOOM_MAX) {
    settings.uiZoom = zoom
  }

  const timeouts = record['executionTimeouts']
  if (typeof timeouts === 'object' && timeouts !== null && !Array.isArray(timeouts)) {
    const kept: Partial<ExecutionBudgets> = {}
    for (const key of EXECUTION_KEYS) {
      const value = (timeouts as Record<string, unknown>)[key]
      if (isTimeoutMs(value)) kept[key] = value
    }
    if (Object.keys(kept).length > 0) settings.executionTimeouts = kept
  }
  return settings
}

/**
 * The patch, as keys to merge into the file.
 *
 * `executionTimeouts` merges member-wise rather than wholesale: a caller that
 * only changed the query budget must not silently unset the scan budget it never
 * mentioned. That merge happens in `update`, which is why this returns the patch
 * unflattened.
 */
function toRecord(patch: PeekSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (patch.mcpPort !== undefined) out['mcpPort'] = patch.mcpPort
  if (patch.executionTimeouts !== undefined) out['executionTimeouts'] = patch.executionTimeouts
  if (patch.uiZoom !== undefined) out['uiZoom'] = patch.uiZoom
  return out
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
}
