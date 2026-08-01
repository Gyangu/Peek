/**
 * Everything peek writes to disk (PLAN's M6 "connection config UI, token
 * management").
 *
 * The README used to say "Persistence: none. The only file written is
 * `~/.peek/mcp.json`". Three files now live there, and the reason each one broke
 * that promise is worth keeping visible:
 *
 *   connections.json  a connection you cannot save is a connection you retype,
 *                     and a port typo means retyping all of it. Credentials are
 *                     encrypted by the OS keychain and never written in the clear.
 *   settings.json     the MCP port had to be a preference rather than an
 *                     environment variable, and a preference that does not
 *                     survive a restart is not one.
 *   mcp.json          unchanged: the endpoint and its bearer token.
 *
 * Layout, open views, query text and results are still in memory only.
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
 * ```
 */

// `connectionIdentity` and `stripUrlPassword` moved to @peek/core: the renderer
// needs the same identity to tell a saved entry and a live connection apart.
export { createConnectionBook, identityId, MAX_BOOK_ENTRIES } from './connection-book'
export type { ConnectionBook, ConnectionBookOptions } from './connection-book'
export { createConfigHandlers, type ConfigHandlerOptions } from './handlers'
export { readJsonFile, writeJsonFile, CONFIG_DIR_MODE, CONFIG_FILE_MODE } from './json-file'
export { createMcpController, PORT_SCAN_WINDOW } from './mcp-controller'
export type { McpController, McpControllerOptions, McpEndpointInfo } from './mcp-controller'
export {
  CONNECTIONS_FILE_NAME,
  SETTINGS_FILE_NAME,
  connectionsFilePath,
  resolveConfigDir,
  settingsFilePath,
} from './paths'
export { createSafeStorageVault, unavailableVault } from './secrets'
export type { SafeStorageLike, SecretVault } from './secrets'
export { createSettingsStore } from './settings'
export type { PeekSettings, SettingsStore } from './settings'
