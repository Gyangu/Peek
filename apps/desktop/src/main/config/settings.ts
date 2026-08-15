/**
 * `~/.peek/settings.json` — preferences that outlive a session.
 *
 * The bar for a new entry has not moved since there were two of them: a settings
 * file is a place things accumulate, so what may go in it is the small set of
 * choices that would otherwise have to be made again on every launch. The
 * newest, `notifications`, clears it on exactly that test — "do not interrupt
 * me" is a fact about how someone works, not about this session.
 *
 * The layout, the open views and the text in a query editor **do** outlive a
 * session now, and deliberately not from here: they are not preferences, they
 * are the shape of one desk at one moment, and they are rewritten on every drag.
 * They live in `workspace.json` with their own reader, writer and failure story.
 * The UI language is the opposite kind of exception — a preference that is
 * renderer-local by decision, see the note atop `renderer/i18n/store.ts`.
 *
 * Unknown keys are preserved on write. A user who has edited the file by hand,
 * or who ran a newer peek once, should not lose that by launching this one.
 */

import type {
  AgentBackend,
  AgentDefaultPermissionMode,
  AgentEndpointSettings,
  AgentMcpTransport,
  ExecutionBudgets,
  LogLevel,
  NotificationSettings,
  UiTheme,
} from '@peek/core'
import {
  AGENT_BACKENDS,
  AGENT_DEFAULT_PERMISSION_MODES,
  AGENT_MCP_TRANSPORTS,
  AgentEndpointSettingsSchema,
  UI_THEMES,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  parseLogLevel,
} from '@peek/core'
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
  /**
   * Dark, light, or follow the OS.
   *
   * Absent means `dark` — peek's own default, and deliberately not `system`, on
   * the same principle as the fields above: nobody gets an appearance change
   * they did not ask for by upgrading.
   *
   * Here rather than in the renderer's `localStorage` (where the *language*
   * lives) because main is a consumer, not just a store: the window's
   * `backgroundColor`, the traffic lights and `nativeTheme.themeSource` are all
   * main-side and all have to agree with what the window paints. See
   * `design/2026-08-15-light-and-dark-theme.md` §2.1.
   */
  theme?: UiTheme
  /**
   * Which agent answers in the chat panel, and how to reach it.
   *
   * Absent means "the built-in default", as everywhere else here. The endpoint's
   * API key is here only as **ciphertext** the OS keychain sealed — the same
   * shape `connection-book.ts` stores passwords in. Plaintext never lands.
   */
  agent?: PeekAgentSettings
  /**
   * How much gets written to `~/.peek/logs/peek.log`.
   *
   * Absent means `'info'` in a packaged build and `'debug'` in dev, on the same
   * principle as the fields above: a user who never chose keeps following the
   * default when we retune it.
   *
   * Unlike every other member here, this one is expected to be changed *during*
   * a session and from the panel rather than from the settings dialog — turning
   * on `debug` is something you do after the thing you want to debug has already
   * happened once. See `main/logging/index.ts`.
   */
  logLevel?: LogLevel
  /**
   * The notification switches the user has actually flipped.
   *
   * Partial, absent-means-default like everything else here —
   * `NOTIFICATION_DEFAULTS` in core is the single place that says what the
   * default is, so a build that changes its mind reaches every user who never
   * opened the settings dialog.
   */
  notifications?: NotificationSettingsPatch
  /**
   * Keyboard overrides: shortcut id → chord, or `null` for "turned off".
   *
   * Only what the user changed. A shortcut left at its default is absent rather
   * than written out, on the same principle as every field above: a default we
   * retune later should still reach everyone who never disagreed with it.
   *
   * Main does not interpret the chords. The ids and the syntax belong to the
   * window (`renderer/keys/`), which resolves every one of them; storing them
   * uninterpreted is what keeps the keyboard model in one place instead of two.
   */
  keybindings?: Record<string, string | null>
}

/** What is stored: only the switches that were touched. See `NotificationSettings`. */
export type NotificationSettingsPatch = Partial<NotificationSettings>

/**
 * One MCP server as it sits in `settings.json`.
 *
 * Differs from the wire shape in exactly one field, and that field is the point:
 * `authValue` arrives in the clear from a form and is sealed before it lands
 * here, so the file holds ciphertext under a different name. Anything that reads
 * this file and forgets to look for `authValueSealed` gets no credential rather
 * than a plaintext one.
 */
export interface StoredMcpServer {
  name: string
  transport: AgentMcpTransport
  target: string
  args?: string[]
  authHeader?: string
  authValueSealed?: string
  enabled: boolean
}

export interface PeekAgentSettings {
  backend?: AgentBackend
  /**
   * The mode a new conversation starts in. Any of them, including the two that
   * stop asking — the panel marks a mode it inherited from here, which is what
   * that costs. See `AGENT_DEFAULT_PERMISSION_MODES` in core.
   */
  permissionMode?: AgentDefaultPermissionMode
  /** Which ACP agent, by profile id. An id this build does not know falls back to the default. */
  acpProfile?: string
  acpExecutablePath?: string
  /**
   * Let the ACP agent use its own file and command tools. Absent = off = the
   * sandbox peek shipped with. See `AcpAgentUserConfig.fullTools`.
   */
  acpFullTools?: boolean
  /**
   * Where a new conversation works, when nothing chose otherwise.
   *
   * Absent means `~/.peek/chat[/<agent>]`, which is what every conversation used
   * before this existed and what the panel is still fine with: a conversation
   * that only reads databases has no use for a project directory. It matters
   * once `acpFullTools` is on, where an agent that can edit files in a directory
   * peek owns can edit nothing anybody wants edited.
   *
   * `null` in a patch means "back to peek's own directory" — the erase signal
   * `endpointApiKeySealed` already uses, rather than a second convention for the
   * same idea. Absent means "leave whatever is stored alone".
   */
  agentWorkdir?: string | null
  /**
   * The user's own MCP servers, with credentials sealed.
   *
   * Stored whole. The write path replaces the list rather than merging it, which
   * is the only shape in which "I removed this server" is expressible.
   */
  mcpServers?: StoredMcpServer[]
  endpoint?: AgentEndpointSettings
  /**
   * The endpoint's API key, sealed by the OS keychain.
   *
   * Ciphertext, never plaintext — same shape `connection-book.ts` stores
   * passwords in. `null` in a patch means "forget it"; absent means "leave it".
   */
  endpointApiKeySealed?: string | null
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
      // Same rule, one level deeper: switching backend must not wipe the endpoint
      // the user configured, and editing the endpoint must not reset the backend.
      if (patch.agent !== undefined) {
        const existing = project(current).agent ?? {}
        const merged: PeekAgentSettings = { ...existing, ...patch.agent }
        if (patch.agent.endpoint !== undefined) {
          merged.endpoint = { ...existing.endpoint, ...patch.agent.endpoint }
        }
        // `null` is the erase signal and must not survive into the file as a key
        // whose value happens to be null — `project` would drop it anyway, but a
        // stored `null` reads as "there is a key here" to anything else looking.
        if (merged.endpointApiKeySealed === null) delete merged.endpointApiKeySealed
        if (merged.agentWorkdir === null) delete merged.agentWorkdir
        changes['agent'] = merged
      }
      // Wholesale, unlike everything above it, and that is the point: a
      // shortcut reset to its default has to *disappear* from the file, which a
      // member-wise merge could never express. The renderer always sends the
      // full record, so the file cannot lose an override the sender still had.
      if (patch.keybindings !== undefined) changes['keybindings'] = patch.keybindings
      // Member-wise like `executionTimeouts`: the settings form sends one
      // checkbox at a time, and turning the automatic ones off must not also
      // decide the channel switch the user never touched.
      if (patch.notifications !== undefined) {
        const existing = project(current).notifications ?? {}
        changes['notifications'] = { ...existing, ...patch.notifications }
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

  // Unknown spelling reads as "not set", so a hand-edited `"Dark"` falls back to
  // the default rather than painting nothing.
  const theme = record['theme']
  if (typeof theme === 'string' && (UI_THEMES as readonly string[]).includes(theme)) {
    settings.theme = theme as UiTheme
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

  // A misspelt level reads as "not set" and the default applies, like every
  // other field here. `parseLogLevel` returns null rather than throwing exactly
  // so this call site can be one line.
  const level = parseLogLevel(record['logLevel'])
  if (level !== null) settings.logLevel = level

  const agent = record['agent']
  if (typeof agent === 'object' && agent !== null && !Array.isArray(agent)) {
    const source = agent as Record<string, unknown>
    const kept: PeekAgentSettings = {}
    const backend = source['backend']
    if (typeof backend === 'string' && (AGENT_BACKENDS as readonly string[]).includes(backend)) {
      kept.backend = backend as AgentBackend
    }
    // Every mode is settable since 2026-08-15, `bypassPermissions` included.
    // What used to be enforced here — reading that value as unset rather than
    // arming it — moved to the panel, which marks an inherited mode instead of
    // refusing to inherit it. A value this build does not know is still dropped.
    const mode = source['permissionMode']
    if (typeof mode === 'string' && (AGENT_DEFAULT_PERMISSION_MODES as readonly string[]).includes(mode)) {
      kept.permissionMode = mode as AgentDefaultPermissionMode
    }
    if (isNonEmptyString(source['acpProfile'])) kept.acpProfile = source['acpProfile']
    if (isNonEmptyString(source['acpExecutablePath'])) kept.acpExecutablePath = source['acpExecutablePath']
    // Only a literal `true` turns it on. Anything else — a string "true", a 1, a
    // typo — reads as off, which is the direction a switch that gives up a
    // guarantee has to fail in.
    if (source['acpFullTools'] === true) kept.acpFullTools = true
    // Not checked for existence here. A directory that has been renamed since it
    // was chosen is a real thing that happens, and the honest place to say so is
    // when a conversation tries to start in it — where the message can name the
    // conversation — rather than silently at read time, which would look like
    // the setting was never saved.
    if (isNonEmptyString(source['agentWorkdir'])) kept.agentWorkdir = source['agentWorkdir']
    const servers = readMcpServers(source['mcpServers'])
    if (servers.length > 0) kept.mcpServers = servers
    if (isNonEmptyString(source['endpointApiKeySealed'])) kept.endpointApiKeySealed = source['endpointApiKeySealed']
    // Validated as a whole: a half-configured endpoint (a URL and no model) is
    // not something to half-apply — it would fail at the first token with an
    // error pointing at the wrong thing. Dropping it reads as "not configured",
    // which is what the form then says.
    const endpoint = AgentEndpointSettingsSchema.safeParse(source['endpoint'])
    if (endpoint.success) kept.endpoint = endpoint.data
    if (Object.keys(kept).length > 0) settings.agent = kept
  }

  // Read member-wise rather than through the zod schema, on the same grounds as
  // everything else here: a hand-edited `"system": "yes"` should cost that one
  // key, not the sibling that was typed correctly.
  const notify = record['notifications']
  if (typeof notify === 'object' && notify !== null && !Array.isArray(notify)) {
    const source = notify as Record<string, unknown>
    const kept: NotificationSettingsPatch = {}
    if (typeof source['system'] === 'boolean') kept.system = source['system']
    if (typeof source['agentTurnEnd'] === 'boolean') kept.agentTurnEnd = source['agentTurnEnd']
    if (Object.keys(kept).length > 0) settings.notifications = kept
  }

  const keys = record['keybindings']
  if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
    const kept: Record<string, string | null> = {}
    for (const [id, chord] of Object.entries(keys as Record<string, unknown>)) {
      // `null` is a value here — "this shortcut is off" — and is not the same
      // state as an absent key, which means "never changed".
      if (chord === null || typeof chord === 'string') kept[id] = chord
    }
    if (Object.keys(kept).length > 0) settings.keybindings = kept
  }
  return settings
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Same shape the wire schema enforces. Duplicated here because this file is hand-edited. */
const MCP_NAME = /^[a-z0-9_-]+$/

/**
 * The MCP list, with unusable rows dropped rather than repaired.
 *
 * Member-wise like everything else here, and for the sharper version of the same
 * reason: a name that is not a legal tool prefix cannot be *fixed* into one
 * without inventing a server the user never configured, and a row kept with a
 * bad name would reach the agent as tools it cannot address — which surfaces as
 * "the model ignored your server", not as an error.
 *
 * Duplicate names go to the first occurrence. The agent merges by name, so a
 * second row under the same one would silently replace the first somewhere
 * downstream; deciding it here means the settings form can show which row won.
 */
function readMcpServers(value: unknown): StoredMcpServer[] {
  if (!Array.isArray(value)) return []
  const out: StoredMcpServer[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const name = row['name']
    if (typeof name !== 'string' || !MCP_NAME.test(name) || name.length > 64) continue
    if (seen.has(name)) continue
    const transport = row['transport']
    if (typeof transport !== 'string' || !(AGENT_MCP_TRANSPORTS as readonly string[]).includes(transport)) continue
    const target = row['target']
    if (!isNonEmptyString(target)) continue
    seen.add(name)
    const args = Array.isArray(row['args'])
      ? (row['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined
    out.push({
      name,
      transport: transport as AgentMcpTransport,
      target,
      enabled: row['enabled'] !== false,
      ...(args && args.length > 0 ? { args } : {}),
      ...(isNonEmptyString(row['authHeader']) ? { authHeader: row['authHeader'] } : {}),
      ...(isNonEmptyString(row['authValueSealed']) ? { authValueSealed: row['authValueSealed'] } : {}),
    })
  }
  return out
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
  if (patch.theme !== undefined) out['theme'] = patch.theme
  if (patch.keybindings !== undefined) out['keybindings'] = patch.keybindings
  if (patch.logLevel !== undefined) out['logLevel'] = patch.logLevel
  return out
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
}
