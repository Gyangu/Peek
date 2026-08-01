/**
 * Shared types for the MCP layer (PLAN section 7).
 *
 * Design principle: **the tool layer is a thin shell**. A tool is exactly one zod inputSchema
 * plus a mapping onto Commands; no business logic is allowed beyond that. Read-only tools
 * (read_workspace / list_connections) bypass the Command Bus and read main's Workspace Store
 * directly (PLAN section 3: zero renderer round-trips).
 */

import type { z } from 'zod'
import type {
  Command,
  CommandInput,
  CommandName,
  CommandResultFor,
  CommandSource,
  ConnId,
  ColumnDef,
  NamespaceNode,
  PeekError,
  ResultId,
  WorkspaceSnapshot,
} from '@peek/core'
import type { UiEffect } from './ui-effects'

/* ================================================================== */
/* 1. Injected dependencies (never import a Command Bus instance —      */
/*    everything arrives through the factory arguments)                 */
/* ================================================================== */

/** Entry point into the Command Bus. The caller supplies `source`; the MCP side always passes 'mcp'. */
export type CommandDispatch = <K extends CommandName>(
  name: K,
  input: CommandInput<K>,
  source: CommandSource,
) => Promise<CommandResultFor<K>>

/**
 * Namespace tree reader.
 *
 * Note: `introspect` is not a Command (it is absent from COMMAND_NAMES) — it is a driver host
 * RPC (HostRpcMap['introspect.children']). The introspect tool therefore goes through this
 * injected read-only channel, and the Connection Manager forwards the request to the driver
 * host that owns the connection.
 */
export type IntrospectReader = (req: {
  connId: ConnId
  /** null means the root level */
  parentId: string | null
  refresh?: boolean
}) => Promise<NamespaceNode[]>

/** A slice of result rows (the first N rows shown to the AI; the full data lives in the UI). */
export interface ResultRowsSlice {
  columns: ColumnDef[]
  /** Row-major (each row follows the `columns` order), already cut down to `limit`. */
  rows: unknown[][]
  /** Total rows known for this result (while still running, the count received so far). */
  totalRows: number
  /** Cut short by `limit` (more rows exist that the AI has not been shown). */
  truncated: boolean
}

/**
 * Result row reader.
 *
 * Note: the data plane (chunks) flows over a MessagePort straight to the renderer, so
 * **main never holds row data** (PLAN section 3). For run_query to echo back the first N rows,
 * the integration layer must inject this reader (typical implementation: ask the renderer for
 * the first few chunks in its cache). Without it run_query still works, it just degrades to
 * returning ResultMeta only (row count / elapsed time / status).
 */
export type ResultRowsReader = (req: {
  resultId: ResultId
  limit: number
  timeoutMs?: number
}) => Promise<ResultRowsSlice>

export type McpLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface McpLogger {
  log(level: McpLogLevel, message: string, detail?: unknown): void
}

/* ================================================================== */
/* 2. Tool execution context                                            */
/* ================================================================== */

export interface ToolContext {
  readonly dispatch: CommandDispatch
  /**
   * Who these tool calls are attributed to in the command log.
   *
   * Defaults to `'mcp'`. peek's **own** embedded chat panel gets its own server
   * handle with `'agent'`, so a human reading the log can tell "the assistant in
   * the sidebar opened this" from "something attached over the network opened
   * this". It changes attribution and one policy rule (`chat.setMode` refuses to
   * disable the human gate for a non-`ui` caller) — never the execution path.
   */
  readonly source?: CommandSource
  /** Snapshot of main's Workspace source of truth (already redacted). */
  readonly getSnapshot: () => WorkspaceSnapshot
  readonly introspect?: IntrospectReader
  readonly readResultRows?: ResultRowsReader
  readonly logger: McpLogger
  /** Injectable, for tests. */
  readonly now: () => number
  /** Injectable, for tests; defaults to setTimeout. */
  readonly sleep: (ms: number) => Promise<void>
}

/* ================================================================== */
/* 3. Tool output                                                       */
/* ================================================================== */

/** The uniform tool output. The executor turns it into an MCP CallToolResult. */
export interface ToolOutput {
  /** Body shown to the model (human-readable first, with embedded JSON where useful). */
  text: string
  /** Structured attachment, serialized and returned as a second text block; omitted if absent. */
  data?: unknown
  /**
   * What the call did to the window, derived by diffing the workspace before and
   * after (see `ui-effects.ts`). **Not written by tools** — the executor fills it
   * in for every command tool, so a tool cannot forget it and cannot misreport it.
   *
   * It is returned as its own block so that a client rendering the agent's tool
   * calls — peek's own chat panel, above all — can turn "opened public.harness in
   * the right pane" into something clickable rather than having to parse prose.
   */
  uiEffects?: UiEffect[]
  /** Tool-level error (not a protocol-level one: the server never crashes over this). */
  isError?: boolean
}

/** Outcome of a single Command (the executor aggregates these). */
export interface CommandOutcome {
  name: CommandName
  ok: boolean
  rev?: number
  data?: unknown
  error?: PeekError
}

/* ================================================================== */
/* 4. Tool definitions                                                  */
/* ================================================================== */

/** The handful of fields that mirror the MCP SDK's ToolAnnotations (without depending on the SDK type). */
export interface ToolAnnotationsLite {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface ToolSpecBase<S extends z.ZodType> {
  /** MCP tool name, snake_case. */
  name: string
  title?: string
  description: string
  /** zod schema, doubling as the MCP inputSchema (the SDK consumes zod v4 directly). */
  inputSchema: S
  annotations?: ToolAnnotationsLite
}

/** A tool that maps onto one or more Commands (the canonical thin-shell shape). */
export interface CommandToolSpec<S extends z.ZodType> extends ToolSpecBase<S> {
  kind: 'command'
  /** Map the tool input onto a list of Commands; the executor dispatches them in order and stops at the first failure. */
  toCommands(input: z.output<S>, ctx: ToolContext): Command[] | Promise<Command[]>
  /** Optional: render the command results into the body shown to the AI; falls back to the default renderer. */
  render?(
    outcomes: CommandOutcome[],
    input: z.output<S>,
    ctx: ToolContext,
  ): ToolOutput | Promise<ToolOutput>
}

/** Read-only tool: reads the Workspace Store or an injected read-only channel, never dispatches. */
export interface ReadToolSpec<S extends z.ZodType> extends ToolSpecBase<S> {
  kind: 'read'
  read(input: z.output<S>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>
}

export type ToolSpec<S extends z.ZodType> = CommandToolSpec<S> | ReadToolSpec<S>

/**
 * The generic-erased tool shape — this is what the registry stores:
 * the concrete input type is captured inside the defineTool closure, and the outside world
 * only ever sees `run(unknown)`.
 */
export interface PeekTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: z.ZodType
  readonly annotations?: ToolAnnotationsLite
  readonly readOnly: boolean
  run(rawInput: unknown, ctx: ToolContext): Promise<ToolOutput>
}
