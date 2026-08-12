/**
 * peek's MCP service (PLAN section 7).
 *
 * The main process only has to wire it up like this:
 *
 * ```ts
 * import { createMcpServer } from './mcp'
 *
 * const mcp = createMcpServer({
 *   dispatch: (name, input, source) => commandBus.invoke(name, input, source),
 *   getSnapshot: () => snapshotWorkspace(store.getState(), redactRulesFor),
 *   introspect: (req) => connections.listChildren(req),      // optional
 *   readResultRows: (req) => results.readRows(req),          // optional
 *   logger: { log: (level, msg, detail) => console[...] },
 * })
 * await mcp.start()          // binds 127.0.0.1:7332, writes ~/.peek/mcp.json
 * app.on('will-quit', () => void mcp.close())
 * ```
 *
 * `redactRulesFor` is `drivers/manifests`' table of which config fields each
 * driver keeps secret, and `snapshotWorkspace` takes it rather than defaulting
 * it: core holds no manifest registry, and a caller who left it out would put
 * plaintext passwords into every receipt this server writes.
 *
 * To add a **kernel** MCP tool: create a file under `mcp/tools/` that
 * default-exports `defineCommandTool({...})` or `defineReadTool({...})`. The
 * registry picks it up automatically — the core needs no changes.
 *
 * To add a tool that belongs to **one database**: declare it in that driver
 * package's `src/mcp-tools.ts` with `defineToolSpec` from `@peek/core`, and it
 * arrives through `drivers/mcpTools.ts`. The two lists meet in `collectTools()`,
 * and a package may not shadow a kernel name. Its mapping runs in that package's
 * host process (`mcp/package-tools.ts`) while the executor around it stays here,
 * so declaring one is the whole job — there is nothing to wire up per tool.
 *
 * Which of the two a tool is, is not a judgement call: all 32 Command names are
 * kernel-generic, so the question is whether the *mapping* encodes something
 * only one database knows. `set_layout` does not and never will; neo4j's
 * `expand_node` — which writes an `elementId()` into a graph view's `focus` —
 * does. See design/2026-08-03-plugin-architecture.md §2.4bis.
 */

export { createMcpServer, type CreateMcpServerOptions, type McpServerHandle } from './server'
export {
  collectBuiltinTools,
  collectTools,
  registerTools,
  toCallToolResult,
  type CollectToolsOptions,
} from './registry'
export { packageTools, type PackageToolCaller } from './package-tools'
export {
  defineCommandTool,
  defineReadTool,
  dispatchCommand,
  errorOutput,
  outcomeData,
  toPeekTool,
} from './executor'
export {
  buildWorkspaceBrief,
  briefViews,
  renderLayoutOutline,
  renderPanelBrief,
  toJson,
  type BriefSection,
  type ConnBrief,
  type PanelBrief,
  type ResultBrief,
  type ViewBrief,
  type WorkspaceBrief,
} from './summary'
export {
  configFilePath,
  defaultConfigDir,
  generateToken,
  readExistingToken,
  writeEndpointFile,
  type McpEndpointFile,
} from './token'
export {
  UNTRUSTED_CATALOG_FRAMING,
  UNTRUSTED_DATA_FRAMING,
  UNTRUSTED_WORKSPACE_FRAMING,
  metaText,
  renderRowsTable,
  untrustedDataFraming,
  waitForResult,
} from './wait'
export type {
  CommandDispatch,
  CommandOutcome,
  CommandToolSpec,
  IntrospectReader,
  McpLogger,
  McpLogLevel,
  PeekTool,
  ReadToolSpec,
  ResultRowsReader,
  ResultRowsSlice,
  ToolAnnotationsLite,
  ToolContext,
  ToolOutput,
  ToolSpec,
} from './types'
