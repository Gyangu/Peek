/**
 * The six commands that read and edit what peek keeps on disk.
 *
 * All six are `read` handlers: they touch no Workspace state, bump no `rev` and
 * broadcast no patch, exactly like `state.read`. The connection book is not part
 * of the window's state — it is a file that outlives the session, and a window
 * that mirrored it would have two copies of the same list to keep in step for no
 * benefit. What the renderer gets is the file, answered on request.
 *
 * They are still commands rather than a side channel, because everything that is
 * asked of main is a command: they are validated by the same zod gate and land
 * in the same log, so "who forgot that connection" and "who moved the port" are
 * answerable from the same recording as everything else.
 *
 * `read` is synchronous, and so is the I/O here — three small JSON files under
 * `~/.peek`, none of which are worth an effect intent. The one genuinely
 * asynchronous act, rebinding the MCP port, is deliberately *not* awaited: see
 * the note on `McpController`.
 */

import {
  clampUiZoom,
  MCP_DEFAULT_HOST,
  MCP_DEFAULT_PORT,
  MCP_HTTP_PATH,
  NOTIFICATION_DEFAULTS,
  resolveNotifications,
  UI_THEME_DEFAULT,
  UI_ZOOM_DEFAULT,
} from '@peek/core'
import type {
  AgentSettingsReadResult,
  CommandInput,
  ConnBookForgetResult,
  ConnBookListResult,
  ExecutionBudgets,
  LogLevel,
  McpConfigureResult,
  McpReadResult,
  McpStatus,
  ResolvedTheme,
  SettingsReadResult,
  SettingsWriteResult,
  UiTheme,
} from '@peek/core'
import type { CommandHandlerMap } from '../bus/types'
// Straight at the module, not through `../connections`: that barrel re-exports
// `host-process.ts`, which imports Electron's `app`, and pulling Electron in
// here would make these handlers unloadable in a plain Node test. `timeouts.ts`
// itself touches neither a file nor Electron, by its own contract.
import { getTimeoutSettings, setTimeoutSettings } from '../connections/timeouts'
import { ACP_PROFILES, profileById, type AcpAgentProfile } from '../acp/profiles'
import { chatRootDir } from '../acp/session-config'
import type { ConnectionBook } from './connection-book'
import type { McpController } from './mcp-controller'
import { connectionsFilePath, settingsFilePath } from './paths'
import type { SecretVault } from './secrets'
import type { PeekAgentSettings, SettingsStore, StoredMcpServer } from './settings'

export interface ConfigHandlerOptions {
  book: ConnectionBook
  mcp: McpController
  settings: SettingsStore
  /** Seals the endpoint backend's API key. The plaintext never leaves this module. */
  vault: SecretVault
  configDir: string
  /** `app.getVersion()`, injected so this module never imports Electron. */
  version: string
  /**
   * Draw the window at this zoom factor. Injected for the same reason `version`
   * is: `webContents.setZoomFactor` is Electron, and this module stays loadable
   * in a plain Node test. Absent in an assembly with no window (a test bus), and
   * the setting is still persisted in that case — the next window will read it.
   */
  applyZoom?: (factor: number) => void
  /**
   * Change what is being captured, now.
   *
   * Injected on the same grounds as `applyZoom`: the logging system owns two
   * open file handles and this module must stay loadable in a plain Node test.
   * Absent in an assembly with no logging attached — the level is still
   * persisted in that case, and the next launch reads it.
   */
  applyLogLevel?: (level: LogLevel) => void
  /** What is being captured right now, for the two settings receipts. */
  readLogLevel?: () => LogLevel
  /**
   * Paint the window this way round, now.
   *
   * Injected on the same grounds as `applyZoom`: `nativeTheme` is Electron. It
   * also broadcasts to the window, which is why the handler does not — see
   * `main/index.ts`'s `applyUiTheme`.
   */
  applyTheme?: (theme: UiTheme) => void
  /**
   * What the theme resolves to right now.
   *
   * Absent in an assembly with no window, where `system` cannot be resolved at
   * all — there is no `nativeTheme` to ask. Both receipts fall back to `dark`
   * there, which is the same answer `UI_THEME_DEFAULT` gives and is inert: a bus
   * with no window paints nothing.
   */
  readResolvedTheme?: () => ResolvedTheme
}

export function createConfigHandlers(options: ConfigHandlerOptions): CommandHandlerMap {
  const {
    book,
    mcp,
    settings,
    vault,
    configDir,
    version,
    applyZoom,
    applyLogLevel,
    readLogLevel,
    applyTheme,
    readResolvedTheme,
  } = options
  // The stored preference is the fallback, not the answer: `PEEK_LOG_LEVEL` can
  // override it for this run, and only the logging system knows that.
  const currentLogLevel = (): LogLevel => readLogLevel?.() ?? settings.read().logLevel ?? 'info'

  return {
    'conn.book.list': {
      read: (): ConnBookListResult => ({
        entries: book.list(),
        secretsAvailable: book.secretsAvailable,
      }),
    },

    'conn.book.forget': {
      read: (_state, input): ConnBookForgetResult => ({
        id: input.id,
        removed: book.forget(input.id),
        // The list comes back with the receipt: a caller that had to re-list
        // would be reading a file it just changed, through a second command.
        entries: book.list(),
      }),
    },

    'mcp.read': {
      read: (): McpReadResult => mcp.status(),
    },

    'mcp.configure': {
      read: (_state, input): McpConfigureResult => {
        const outcome = mcp.configure({
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.rotateToken === undefined ? {} : { rotateToken: input.rotateToken }),
        })
        return {
          ...outcome.status,
          tokenRotated: outcome.tokenRotated,
          previousPort: outcome.previousPort,
          // Either change breaks every registration a client already holds — the
          // token it sends stops matching, or the URL stops answering.
          reregisterRequired: outcome.tokenRotated || outcome.previousPort !== null,
        }
      },
    },

    'settings.read': {
      read: (): SettingsReadResult => {
        const stored = settings.read()
        return {
          execution: executionBudgets(),
          paths: {
            configDir,
            settingsFile: settingsFilePath(configDir),
            connectionsFile: connectionsFilePath(configDir),
            // Owned by the MCP server, which writes it; asking the controller
            // keeps one spelling of that path in the process rather than two.
            mcpFile: mcp.status().configFile,
          },
          version,
          uiZoom: stored.uiZoom ?? UI_ZOOM_DEFAULT,
          theme: stored.theme ?? UI_THEME_DEFAULT,
          // Resolved here rather than by the caller: `system` is only answerable
          // where `nativeTheme` is, and this is the reply the window paints its
          // *first* frame from — before any `THEME_CHANGED` has been sent.
          resolvedTheme: readResolvedTheme?.() ?? 'dark',
          agent: readAgentSettings(settings, vault),
          // Uninterpreted, and absent when the user changed nothing. The window
          // parses these; main only remembers them. See `PeekSettings`.
          ...(stored.keybindings === undefined ? {} : { keybindings: stored.keybindings }),
          logLevel: currentLogLevel(),
          notifications: resolveNotifications(stored.notifications),
        }
      },
    },

    'settings.write': {
      read: (_state, input): SettingsWriteResult => {
        // Order matters. `setTimeoutSettings` drops entries it considers
        // invalid and returns what actually took effect, so applying first and
        // persisting its answer is what keeps the file from recording a value
        // the process is not honouring.
        const applied = setTimeoutSettings(input.execution ?? {})
        const execution: ExecutionBudgets = {
          queryMs: applied.queryMs,
          scanMs: applied.scanMs,
          vectorSearchMs: applied.vectorSearchMs,
        }
        // Only the keys the caller asked about are persisted: the other two stay
        // absent from the file so they keep following the built-in default if we
        // ever retune it.
        const persisted: Partial<ExecutionBudgets> = {}
        for (const key of ['queryMs', 'scanMs', 'vectorSearchMs'] as const) {
          if (input.execution?.[key] !== undefined) persisted[key] = execution[key]
        }
        if (Object.keys(persisted).length > 0) settings.update({ executionTimeouts: persisted })

        // Same order as the timeouts above: apply, then persist what applied.
        // `clampUiZoom` is belt and braces — the schema already bounds it — but
        // it is what makes this handler correct for a settings file someone
        // edited by hand and a `settings.write` that came in over MCP.
        let uiZoom = settings.read().uiZoom ?? UI_ZOOM_DEFAULT
        if (input.uiZoom !== undefined) {
          uiZoom = clampUiZoom(input.uiZoom)
          applyZoom?.(uiZoom)
          settings.update({ uiZoom })
        }

        // Apply, then persist — the order every setting above follows. `applyTheme`
        // is also what broadcasts the change to the window, so a theme picked here
        // reaches the DOM without this handler knowing an IPC channel exists.
        if (input.theme !== undefined) {
          applyTheme?.(input.theme)
          settings.update({ theme: input.theme })
        }

        if (input.agent) writeAgentSettings(settings, vault, input.agent)

        // Whole-record, not merged: see `SettingsStore.update`. An empty record
        // is how the window says "everything is back to its default".
        if (input.keybindings !== undefined) settings.update({ keybindings: input.keybindings })

        // Apply first, then persist — the same order as the timeouts and the
        // zoom above, and for the same reason: the file must not record a level
        // the running process is not honouring.
        if (input.logLevel !== undefined) {
          applyLogLevel?.(input.logLevel)
          settings.update({ logLevel: input.logLevel })
        }

        // No apply step, unlike the four above: nothing holds these switches at
        // run time. `createNotifier` reads them per call (see `NotifierDeps`),
        // so persisting *is* applying and a change is live on the next notice.
        if (input.notifications !== undefined) settings.update({ notifications: input.notifications })

        const keybindings = settings.read().keybindings
        return {
          execution,
          uiZoom,
          theme: settings.read().theme ?? UI_THEME_DEFAULT,
          resolvedTheme: readResolvedTheme?.() ?? 'dark',
          agent: readAgentSettings(settings, vault),
          ...(keybindings === undefined ? {} : { keybindings }),
          logLevel: currentLogLevel(),
          notifications: resolveNotifications(settings.read().notifications),
        }
      },
    },
  }
}

/* ================================================================== */
/* The chat panel's agent                                              */
/* ================================================================== */

/**
 * How the endpoint backend's API key is kept.
 *
 * Sealed by the OS keychain, stored as ciphertext — the same shape connection
 * passwords use (`connection-book.ts`), and reused rather than reinvented so
 * there is one answer in this codebase to "where do secrets go".
 *
 * The plaintext never reaches `settings.json`, which is a file users hand-edit,
 * paste into issues and sync between machines. It never travels back to the
 * renderer either: `endpointApiKeySet` reports *whether*, never *what*.
 */
function readAgentSettings(settings: SettingsStore, vault: SecretVault): AgentSettingsReadResult {
  const stored = settings.read().agent ?? {}
  const profile = profileById(stored.acpProfile)
  return {
    backend: stored.backend ?? 'acp',
    // `default` — ask every time — unless the user chose otherwise. peek does not
    // pick a looser one for anybody.
    permissionMode: stored.permissionMode ?? 'default',
    // Resolved, not echoed: a file naming an agent this build does not have gets
    // the default, and the form should show what will actually run.
    acpProfile: profile.id,
    // Each candidate's tier is resolved against the tool switch, not read off
    // the profile: the picker is where a user compares agents, and comparing
    // them at a sandbox none of them currently has would be showing the wrong
    // thing on exactly the screen where the switch lives.
    profiles: ACP_PROFILES.map((candidate) => ({
      id: candidate.id,
      displayName: candidate.displayName,
      sandbox: candidate.sandbox({ fullTools: stored.acpFullTools === true }),
      baseSandbox: candidate.sandbox({}) === 'enforced' ? 'enforced' : 'unverified',
      available: isProfileAvailable(candidate),
    })),
    acpFullTools: stored.acpFullTools === true,
    // The path itself, not a placeholder. The form has to be able to say "your
    // conversations run here" for the default too, and it cannot compose that
    // path: `chatRootDir` reads an environment variable the window does not have.
    agentWorkdirDefault: chatRootDir(process.env['PEEK_CONFIG_DIR']),
    // Whether, never what — the same rule `endpointApiKeySet` follows. The sealed
    // value does not cross back even to the renderer, so a form can show
    // "configured" without ever holding the secret.
    mcpServers: (stored.mcpServers ?? []).map((server) => ({
      name: server.name,
      transport: server.transport,
      target: server.target,
      enabled: server.enabled,
      authValueSet: server.authValueSealed !== undefined,
      ...(server.args ? { args: server.args } : {}),
      ...(server.authHeader ? { authHeader: server.authHeader } : {}),
    })),
    // `null` is the erase signal on the way in and never lands in the file, so
    // it is not a state the form has to render — both spellings of "unset"
    // arrive here as an absent field.
    ...(stored.agentWorkdir ? { agentWorkdir: stored.agentWorkdir } : {}),
    ...(stored.acpExecutablePath === undefined ? {} : { acpExecutablePath: stored.acpExecutablePath }),
    ...(stored.endpoint === undefined ? {} : { endpoint: stored.endpoint }),
    // Whether, never what. The value does not cross back even to the renderer.
    endpointApiKeySet: stored.endpointApiKeySealed !== undefined,
  }
}

function writeAgentSettings(
  settings: SettingsStore,
  vault: SecretVault,
  input: NonNullable<CommandInput<'settings.write'>['agent']>,
): void {
  const patch: PeekAgentSettings = {}
  if (input.backend !== undefined) patch.backend = input.backend
  if (input.permissionMode !== undefined) patch.permissionMode = input.permissionMode
  if (input.acpProfile !== undefined) patch.acpProfile = profileById(input.acpProfile).id
  if (input.acpExecutablePath !== undefined) patch.acpExecutablePath = input.acpExecutablePath
  if (input.acpFullTools !== undefined) patch.acpFullTools = input.acpFullTools
  // An empty string is how the form says "back to peek's own directory". It
  // becomes the store's `null` erase signal here rather than travelling as one:
  // a form field that has been cleared *is* an empty string, and asking the
  // window to send a null instead would be asking it to speak the file's dialect.
  if (input.agentWorkdir !== undefined) {
    patch.agentWorkdir = input.agentWorkdir === '' ? null : input.agentWorkdir
  }
  if (input.endpoint !== undefined) patch.endpoint = input.endpoint
  if (input.mcpServers !== undefined) {
    patch.mcpServers = sealMcpServers(settings, vault, input.mcpServers)
  }
  // An empty string is how a form says "forget it" — distinct from omitting the
  // field, which means "leave whatever is stored alone".
  if (input.endpointApiKey !== undefined) {
    if (input.endpointApiKey === '') {
      patch.endpointApiKeySealed = null
    } else {
      const sealed = vault.seal(input.endpointApiKey)
      // A vault that cannot seal must not fall back to plaintext. The write is
      // dropped and `endpointApiKeySet` stays false, so the form can say the key
      // was not stored rather than leaving one readable in a text file.
      if (sealed !== null) patch.endpointApiKeySealed = sealed
    }
  }

  if (Object.keys(patch).length > 0) settings.update({ agent: patch })
}

/**
 * Seal the credentials in an incoming MCP list, keeping the ones not resent.
 *
 * The list arrives whole — that is the only shape in which removing a row is
 * expressible — but the credentials do not, because they never crossed back to
 * the form in the first place. So a row that omits `authValue` means "the one
 * you already have", matched by name against what is stored. Without that,
 * editing a server's URL would silently clear its token, and the failure would
 * arrive later as an authentication error against a server that was working.
 *
 * An empty string is the deliberate erase, distinct from omitting the field —
 * the same convention `endpointApiKey` uses.
 */
function sealMcpServers(
  settings: SettingsStore,
  vault: SecretVault,
  incoming: NonNullable<CommandInput<'settings.write'>['agent']>['mcpServers'] & object,
): StoredMcpServer[] {
  const stored = new Map((settings.read().agent?.mcpServers ?? []).map((s) => [s.name, s]))
  const out: StoredMcpServer[] = []
  const seen = new Set<string>()
  for (const row of incoming) {
    // The schema already refused a malformed name; this refuses a *repeated*
    // one, which the schema cannot see. First occurrence wins, as on read.
    if (seen.has(row.name)) continue
    seen.add(row.name)
    const previous = stored.get(row.name)
    const kept: StoredMcpServer = {
      name: row.name,
      transport: row.transport,
      target: row.target,
      enabled: row.enabled,
      ...(row.args && row.args.length > 0 ? { args: row.args } : {}),
      ...(row.authHeader ? { authHeader: row.authHeader } : {}),
    }
    if (row.authValue === undefined) {
      // Not resent: carry the stored one forward.
      if (previous?.authValueSealed) kept.authValueSealed = previous.authValueSealed
    } else if (row.authValue !== '') {
      const sealed = vault.seal(row.authValue)
      // A vault that cannot seal must not fall back to plaintext. The credential
      // is dropped and `authValueSet` stays false, so the form says it was not
      // stored rather than leaving one readable in a text file.
      if (sealed !== null) kept.authValueSealed = sealed
    }
    out.push(kept)
  }
  return out
}

/** Whether the agent's package is actually installed in this build. */
function isProfileAvailable(profile: AcpAgentProfile): boolean {
  try {
    profile.resolveSpawn({})
    return true
  } catch {
    return false
  }
}

function executionBudgets(): ExecutionBudgets {
  const current = getTimeoutSettings()
  return {
    queryMs: current.queryMs,
    scanMs: current.scanMs,
    vectorSearchMs: current.vectorSearchMs,
  }
}

/* ------------------------------------------------------------------ */
/* The degraded set                                                    */
/* ------------------------------------------------------------------ */

/**
 * What these commands answer before main has assembled anything — the exact
 * analogue of `createUnavailableChatRuntime`.
 *
 * `coreHandlers` is `satisfies Required<CommandHandlerMap>`, which is the check
 * that a command can never be dispatched without an implementation; these are
 * that implementation for a process where nothing has been wired yet (a unit
 * test building a bare `CommandBus`, or an assembly that threw). They report an
 * empty book and an endpoint that is not listening, which is true — rather than
 * failing, which would read as a bug in the command.
 */
const NOT_LISTENING: McpStatus = {
  listening: false,
  host: MCP_DEFAULT_HOST,
  port: MCP_DEFAULT_PORT,
  preferredPort: MCP_DEFAULT_PORT,
  path: MCP_HTTP_PATH,
  url: `http://${MCP_DEFAULT_HOST}:${String(MCP_DEFAULT_PORT)}${MCP_HTTP_PATH}`,
  token: '',
  hint: '',
  configFile: '',
  restarting: false,
}

export const unavailableConfigHandlers = {
  'conn.book.list': {
    read: (): ConnBookListResult => ({ entries: [], secretsAvailable: false }),
  },
  'conn.book.forget': {
    read: (_state, input): ConnBookForgetResult => ({ id: input.id, removed: false, entries: [] }),
  },
  'mcp.read': {
    read: (): McpReadResult => NOT_LISTENING,
  },
  'mcp.configure': {
    read: (): McpConfigureResult => ({
      ...NOT_LISTENING,
      reregisterRequired: false,
      tokenRotated: false,
      previousPort: null,
    }),
  },
  // The timeouts are real even here — `connections/timeouts.ts` is a module-level
  // singleton that needs no assembly — so these report the truth rather than
  // zeroes. Only the paths are unknowable before a config dir is resolved.
  'settings.read': {
    read: (): SettingsReadResult => ({
      execution: executionBudgets(),
      paths: { configDir: '', settingsFile: '', connectionsFile: '', mcpFile: '' },
      version: '',
      uiZoom: UI_ZOOM_DEFAULT,
      theme: UI_THEME_DEFAULT,
      resolvedTheme: 'dark',
      agent: UNCONFIGURED_AGENT,
      logLevel: 'info',
      notifications: NOTIFICATION_DEFAULTS,
    }),
  },
  'settings.write': {
    read: (_state, input): SettingsWriteResult => {
      // Applied but not persisted: there is no settings file to write to yet.
      const applied = setTimeoutSettings(input.execution ?? {})
      return {
        execution: {
          queryMs: applied.queryMs,
          scanMs: applied.scanMs,
          vectorSearchMs: applied.vectorSearchMs,
        },
        // Nothing to draw and nothing to write, so the honest answer is the
        // value that would take effect, not a claim that one did.
        uiZoom: clampUiZoom(input.uiZoom ?? UI_ZOOM_DEFAULT),
        theme: input.theme ?? UI_THEME_DEFAULT,
        // Same clause as the zoom above: nothing painted it, so this is the value
        // that *would* take effect. `system` cannot be resolved with no window, so
        // the default's own resolution is the only honest answer.
        resolvedTheme: 'dark',
        agent: UNCONFIGURED_AGENT,
        logLevel: input.logLevel ?? 'info',
        notifications: resolveNotifications(input.notifications),
      }
    },
  },
} satisfies CommandHandlerMap

/**
 * What the agent settings look like before a config dir exists.
 *
 * The profile list is still real — it is compiled in, not read from disk — so a
 * degraded window can show which agents this build has even while it cannot say
 * which one is selected. Everything the file would have supplied reads as unset.
 */
const UNCONFIGURED_AGENT: AgentSettingsReadResult = {
  backend: 'acp',
  permissionMode: 'default',
  acpProfile: profileById(undefined).id,
  // No config dir means no switch to have been set, so every tier here is the
  // one the agent ships with.
  profiles: ACP_PROFILES.map((candidate) => ({
    id: candidate.id,
    displayName: candidate.displayName,
    sandbox: candidate.sandbox({}),
    baseSandbox: candidate.sandbox({}) === 'enforced' ? 'enforced' : 'unverified',
    available: isProfileAvailable(candidate),
  })),
  acpFullTools: false,
  agentWorkdirDefault: chatRootDir(process.env['PEEK_CONFIG_DIR']),
  mcpServers: [],
  endpointApiKeySet: false,
}
