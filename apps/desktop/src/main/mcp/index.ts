/**
 * peek 的 MCP 服务（PLAN 第 7 节）。
 *
 * main 进程只需要这样接线：
 *
 * ```ts
 * import { createMcpServer } from './mcp'
 *
 * const mcp = createMcpServer({
 *   dispatch: (name, input, source) => commandBus.invoke(name, input, source),
 *   getSnapshot: () => snapshotWorkspace(store.getState()),
 *   introspect: (req) => connections.listChildren(req),      // 可选
 *   readResultRows: (req) => results.readRows(req),          // 可选
 *   logger: { log: (level, msg, detail) => console[...] },
 * })
 * await mcp.start()          // 绑 127.0.0.1:7332，写 ~/.peek/mcp.json
 * app.on('will-quit', () => void mcp.close())
 * ```
 *
 * 新增一个 MCP 工具：在 `mcp/tools/` 下新建一个文件，default-export
 * `defineCommandTool({...})` 或 `defineReadTool({...})`。注册表会自动收集，内核不用改。
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
