import type { z } from 'zod'
import type {
  Command,
  CommandInput,
  CommandName,
  CommandResultFor,
  CommandSource,
} from './commands'
import type { ColumnDef } from './chunk'
import type { NamespaceNode } from './capability'
import type { PeekError } from './errors'
import type { ConnId, ResultId } from './ids'
import type { WorkspaceSnapshot } from './workspace'

/* ==================================================================
 * The MCP tool contract — the shape a package declares a tool in.
 *
 * ## Why this is in core rather than beside the executor that runs it
 *
 * It used to live in `apps/desktop/src/main/mcp/types.ts`, next to the thirteen
 * tools the kernel ships. That was right while the kernel was the only author. A
 * driver package cannot import the app — the dependency runs the other way, and
 * closing it into a cycle is the one thing the whole package boundary exists to
 * prevent — so the moment `@peek/driver-neo4j` wants to contribute `expand_node`,
 * the *shape* of a tool has to be reachable from a package.
 *
 * Nothing here is new; every type is the one that was there, moved. The app's
 * `mcp/types.ts` re-exports this module, which is why the thirteen tool files,
 * the executor, the registry, the server and their tests did not have to change
 * a single import.
 *
 * ## What deliberately did **not** move
 *
 * `defineCommandTool` / `defineReadTool`. They are what turn a spec into a
 * `PeekTool`, and they need the receipt renderers (`renderPanelBrief`, `toJson`)
 * and the window diff (`diffUiEffects`) — seven hundred-odd lines of prose
 * generation that has no business inside a package called "the frozen contract".
 *
 * So the division is: **a package declares a `ToolSpec`; the app's executor is
 * still the only thing that ever builds a `PeekTool`.** That is not a formality.
 * Everything a tool gets for free — the second validation pass before anything
 * reaches the Command Bus, the `uiEffects` block a tool cannot forget or
 * misreport, the catch that stops one tool's exception from taking the server
 * down — lives in that one function. A package that built its own `PeekTool`
 * would be a second execution path with none of it, and the drift would show up
 * as a plugin tool that quietly reports a window it did not change.
 *
 * ## The tool layer is a thin shell
 *
 * Unchanged, and it applies to package tools exactly as it does to the kernel's:
 * one zod `inputSchema` plus a mapping onto Commands, no business logic beyond
 * that. Read-only tools bypass the Command Bus and read main's Workspace Store
 * directly (PLAN §3: zero renderer round-trips).
 * ================================================================== */

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
/* 2. What a tool call did to the window                                */
/* ================================================================== */

export type UiEffectKind =
  | 'view.opened'
  | 'view.closed'
  | 'view.moved'
  | 'view.shown'
  | 'view.hidden'
  | 'view.retitled'
  | 'result.started'
  | 'connection.opened'
  | 'connection.closed'
  | 'focus.moved'

/**
 * One visible consequence of a tool call.
 *
 * `summary` is **always English and always complete on its own** — it is read by
 * the model and quoted to the user, and it is the only field a plain-text client
 * will see. The ids beside it are for a client that can do something with them.
 *
 * The *record* is here; the code that derives it from two workspace snapshots
 * stays in the app (`mcp/ui-effects.ts`). They are different kinds of thing: this
 * is part of a tool receipt, which ACP hands through to the chat panel verbatim
 * and which a panel turns into a clickable button — a contract. How to compute it
 * by diffing is policy, and policy that reads the whole layout tree.
 */
export interface UiEffect {
  kind: UiEffectKind
  summary: string
  viewId?: string
  panelId?: string
  /** Where that panel sits, in words: "the right pane", "pane 2 of 3". */
  panelPlacement?: string
  connId?: string
  resultId?: string
  title?: string
  /**
   * A Command a client may dispatch to put this effect's subject on screen.
   *
   * Present only when there is somewhere to go: a view that was opened, moved or
   * pushed behind another tab. Absent for a view that was closed, because there is
   * nothing left to focus. Spelled as a Command rather than as a bare id so a
   * renderer wires the button up without a lookup table of its own.
   */
  focus?: { command: 'view.activate'; viewId: string }
}

/* ================================================================== */
/* 3. Tool execution context                                            */
/* ================================================================== */

export interface ToolContext {
  readonly dispatch: CommandDispatch
  /**
   * Who these tool calls are attributed to in the command log.
   *
   * Resolved **per session**, from the bearer credential the `initialize` request
   * presented: peek's own embedded chat panel holds a second token and arrives as
   * `'agent'`, everyone else as `'mcp'`. So a human reading the log can tell "the
   * assistant in the sidebar opened this" from "something attached over the
   * network opened this".
   *
   * It changes attribution and two policy rules — `chat.setMode` refuses to
   * disable the human gate for a non-`ui` caller, and `chat.respondPermission`
   * refuses an `'agent'` caller — never the execution path.
   *
   * This used to say the panel "gets its own server handle", in the present
   * tense, while a single handle served everyone and the value was never
   * produced. See design/2026-08-02-agent-source-and-permission-scope.md §1.1.
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
/* 4. Tool output                                                       */
/* ================================================================== */

/** The uniform tool output. The executor turns it into an MCP CallToolResult. */
export interface ToolOutput {
  /** Body shown to the model (human-readable first, with embedded JSON where useful). */
  text: string
  /** Structured attachment, serialized and returned as a second text block; omitted if absent. */
  data?: unknown
  /**
   * What the call did to the window, derived by diffing the workspace before and
   * after (see `mcp/ui-effects.ts` in the app). **Not written by tools** — the
   * executor fills it in for every command tool, so a tool cannot forget it and
   * cannot misreport it. That holds for a package's tool exactly as it does for
   * the kernel's, because both go through the same `defineCommandTool`.
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
/* 5. Tool definitions                                                  */
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
export interface CommandToolSpec<S extends z.ZodType = z.ZodType> extends ToolSpecBase<S> {
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
export interface ReadToolSpec<S extends z.ZodType = z.ZodType> extends ToolSpecBase<S> {
  kind: 'read'
  read(input: z.output<S>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>
}

export type ToolSpec<S extends z.ZodType = z.ZodType> = CommandToolSpec<S> | ReadToolSpec<S>

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

/**
 * Declare a tool spec in a driver package. Identity at runtime; the work is in
 * the type parameter.
 *
 * Without it a package would write `const tools: ToolSpec[] = [{…}]`, and the
 * annotation widens `S` to `z.ZodType` at the point where it would have been
 * inferred — so `toCommands(input)` receives `unknown` and every field access
 * inside becomes a cast. `defineToolSpec` captures the schema's own type first,
 * and the array annotation afterwards is then a widening of an already-checked
 * object rather than a contextual type imposed on an unchecked one.
 *
 * (The widening is sound because `toCommands` and `render` are declared with
 * method syntax, so their parameters are bivariant — the same reason a manifest
 * can declare `endpointSummary` over its own config branch. `defineManifest`
 * exists for the mirror-image reason; see `manifest.ts`.)
 *
 * The app's `defineCommandTool` is what turns the result into a runnable
 * `PeekTool`, and a package must not do that itself — see this module's header.
 */
export function defineToolSpec<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec
}
