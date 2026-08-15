/**
 * The MCP tool contract, re-exported.
 *
 * These types **moved to `@peek/core` (`mcp-tools.ts`)** and this module is the
 * shim that keeps every existing import working. The move was forced by one
 * thing: a driver package contributes tools now, and a package cannot import the
 * app — see `docs/design/2026-08-03-plugin-architecture.md` §2.4bis(c).
 *
 * Kept rather than deleted because the alternative was rewriting the import line
 * in fourteen tool files, the executor, the registry, the server and their tests
 * to say the same thing in a longer way. A file that only re-exports is easy to
 * mistake for cruft; this one is load-bearing in the sense that matters — it made
 * a contract move show up in the diff as a contract move, not as forty touched
 * lines.
 *
 * New code in main may import either spelling. `@peek/core` is the honest one.
 */

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
  UiEffect,
  UiEffectKind,
} from '@peek/core'
