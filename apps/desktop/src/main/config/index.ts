/**
 * Everything peek writes to disk (PLAN's M6 "connection config UI, token
 * management").
 *
 * The README used to say "Persistence: none. The only file written is
 * `~/.peek/mcp.json`". Four files now live there, and the reason each one broke
 * that promise is worth keeping visible:
 *
 *   connections.json  a connection you cannot save is a connection you retype,
 *                     and a port typo means retyping all of it. Credentials are
 *                     encrypted by the OS keychain and never written in the clear.
 *   settings.json     the MCP port had to be a preference rather than an
 *                     environment variable, and a preference that does not
 *                     survive a restart is not one.
 *   workspace.json    a restart used to mean rebuilding the desk by hand: the
 *                     splits, the tabs, the statement half-written in an editor.
 *                     What it stores is what a view **is** and never what
 *                     happened to it — see `workspace-file.ts`, which is where
 *                     that line is actually drawn.
 *   mcp.json          unchanged: the endpoint and its bearer token.
 *
 * Result sets stay in memory, by design and permanently.
 *
 * ## Wiring (main/index.ts)
 *
 * ```ts
 * const configDir = resolveConfigDir()
 * const vault = createSafeStorageVault(safeStorage)
 * const book = createConnectionBook({ configDir, vault, onError: ... })
 * const settings = createSettingsStore(configDir)
 * const mcp = createMcpController({ configDir, settings, create, notify, log, onEndpoint })
 * commandBus.registerAll(createConfigHandlers({ book, mcp }))
 * // and, once the desk is back: createWorkspacePersister({ store, path })
 * ```
 */

// `connectionIdentity` and `stripUrlPassword` live in @peek/core: the renderer
// needs the same identity to tell a saved entry and a live connection apart.
// What core cannot hold is *which fields* count — that is the driver package's
// `identity` list — so both sides reach it through `drivers/manifests`'
// `connectionIdentityOf`, which is where the manifest is looked up by the
// config's own driverId. `identityId` below is the hashed form of the same
// string and stays here, next to the file it keys.
export { createConnectionBook, identityId, MAX_BOOK_ENTRIES } from './connection-book'
export type { ConnectionBook, ConnectionBookOptions, StoredDisplay } from './connection-book'
export { createConfigHandlers, type ConfigHandlerOptions } from './handlers'
export { readJsonFile, writeJsonFile, CONFIG_DIR_MODE, CONFIG_FILE_MODE } from './json-file'
export { createMcpController, PORT_SCAN_WINDOW } from './mcp-controller'
export type { McpController, McpControllerOptions, McpEndpointInfo } from './mcp-controller'
export {
  CONNECTIONS_FILE_NAME,
  PACKAGES_DIR_NAME,
  SETTINGS_FILE_NAME,
  WORKSPACE_FILE_NAME,
  WORKSPACE_QUARANTINE_SUFFIX,
  connectionsFilePath,
  packagesDir,
  resolveConfigDir,
  settingsFilePath,
  workspaceFilePath,
} from './paths'
export { createSafeStorageVault, unavailableVault } from './secrets'
export type { SafeStorageLike, SecretVault } from './secrets'
export { createSettingsStore } from './settings'
export type { PeekSettings, SettingsStore } from './settings'
export {
  parseWorkspaceFile,
  readWorkspaceFile,
  writeWorkspaceFile,
  WORKSPACE_FILE_VERSION,
} from './workspace-file'
export type {
  PersistedConnection,
  PersistedNode,
  PersistedPanel,
  PersistedSplit,
  PersistedView,
  PersistedWorkspace,
  WorkspaceReadOutcome,
} from './workspace-file'
