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
 *   getSnapshot: () => snapshotWorkspace(store.getState()),
 *   introspect: (req) => connections.listChildren(req),      // optional
 *   readResultRows: (req) => results.readRows(req),          // optional
 *   logger: { log: (level, msg, detail) => console[...] },
 * })
 * await mcp.start()          // binds 127.0.0.1:7332, writes ~/.peek/mcp.json
 * app.on('will-quit', () => void mcp.close())
 * ```
 *
 * To add an MCP tool: create a file under `mcp/tools/` that default-exports
 * `defineCommandTool({...})` or `defineReadTool({...})`. The registry picks it up
 * automatically — the core needs no changes.
 */

export { createMcpServer, type CreateMcpServerOptions, type McpServerHandle } from './server'
export { collectBuiltinTools, registerTools, toCallToolResult } from './registry'
export { defineCommandTool, defineReadTool, dispatchCommand, errorOutput, outcomeData } from './executor'
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
export { renderRowsTable, waitForResult } from './wait'
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
