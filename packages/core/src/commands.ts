import { z } from 'zod'
import {
  CollectionRefSchema,
  ConnectionConfigSchema,
  FilterSpecSchema,
  SortSpecSchema,
  ValueRefSchema,
  type Capability,
  type ServerInfo,
} from './capability'
import { MAX_PAGE_LIMIT } from './chunk'
import { peekErrorMsg, type PeekError } from './errors'
import {
  ConnIdSchema,
  PanelIdSchema,
  ResultIdSchema,
  SplitIdSchema,
  ViewIdSchema,
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from './ids'
import type { ConnStatus, ViewKind, WorkspaceSnapshot } from './workspace'

/* ================================================================== */
/* 0. Command names (PLAN §6, domain.verb)                             */
/* ================================================================== */

export const COMMAND_NAMES = [
  'conn.open',
  'conn.close',
  'view.open',
  'view.update',
  'view.close',
  'query.run',
  'query.cancel',
  'layout.split',
  'layout.focus',
  'layout.setRatio',
  'layout.close',
  'state.read',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMAND_NAMES as readonly string[]).includes(value)
}

/** Where a command came from; used by the command log and for auditing (the log is a recording of every action, and replayable) */
export const CommandSourceSchema = z.enum(['ui', 'mcp', 'system'])
export type CommandSource = z.infer<typeof CommandSourceSchema>

/* ================================================================== */
/* 1. View-open specs and incremental updates                          */
/* ================================================================== */

const pageLimit = z.number().int().positive().max(MAX_PAGE_LIMIT)
const pageOffset = z.number().int().nonnegative()

export const TableViewSpecSchema = z.object({
  kind: z.literal('table'),
  connId: ConnIdSchema,
  ref: CollectionRefSchema,
  filter: z.array(FilterSpecSchema).optional(),
  sort: z.array(SortSpecSchema).optional(),
  offset: pageOffset.optional(),
  limit: pageLimit.optional(),
  title: z.string().optional(),
})

export const QueryViewSpecSchema = z.object({
  kind: z.literal('query'),
  connId: ConnIdSchema,
  /** Omitted means an empty editor */
  text: z.string().optional(),
  /** Run it as soon as the view opens */
  run: z.boolean().optional(),
  title: z.string().optional(),
})

export const InspectorViewSpecSchema = z.object({
  kind: z.literal('inspector'),
  connId: ConnIdSchema,
  ref: ValueRefSchema,
  title: z.string().optional(),
})

export const TreeViewSpecSchema = z.object({
  kind: z.literal('tree'),
  connId: ConnIdSchema,
  expanded: z.array(z.string()).optional(),
  title: z.string().optional(),
})

export const VectorViewSpecSchema = z.object({
  kind: z.literal('vector'),
  connId: ConnIdSchema,
  collection: z.string().min(1),
  queryVec: z.array(z.number()).optional(),
  queryText: z.string().optional(),
  topK: z.number().int().positive().max(10_000).optional(),
  filter: z.array(FilterSpecSchema).optional(),
  title: z.string().optional(),
})

/** Input spec for view.open: no id, because main generates it */
export const ViewOpenSpecSchema = z.discriminatedUnion('kind', [
  TableViewSpecSchema,
  QueryViewSpecSchema,
  InspectorViewSpecSchema,
  TreeViewSpecSchema,
  VectorViewSpecSchema,
])
export type ViewOpenSpec = z.infer<typeof ViewOpenSpecSchema>

/**
 * Incremental patch for view.update. `kind` is mandatory: main checks it against
 * the target view's kind and answers BAD_REQUEST on a mismatch, which is what stops
 * the AI from applying a table's `filter` to a query view.
 */
export const ViewPatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    ref: CollectionRefSchema.optional(),
    filter: z.array(FilterSpecSchema).optional(),
    sort: z.array(SortSpecSchema).optional(),
    offset: pageOffset.optional(),
    limit: pageLimit.optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('query'),
    text: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('inspector'),
    ref: ValueRefSchema.optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tree'),
    expanded: z.array(z.string()).optional(),
    selected: z.string().nullable().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('vector'),
    collection: z.string().min(1).optional(),
    queryVec: z.array(z.number()).optional(),
    queryText: z.string().optional(),
    topK: z.number().int().positive().max(10_000).optional(),
    filter: z.array(FilterSpecSchema).optional(),
    title: z.string().optional(),
  }),
])
export type ViewPatch = z.infer<typeof ViewPatchSchema>

/* ================================================================== */
/* 2. Per-command input schemas — every type is z.infer'd from these,   */
/*    never hand-written a second time                                 */
/* ================================================================== */

export const ConnOpenInputSchema = z.object({
  config: ConnectionConfigSchema,
  /** Reuse an existing connection id (reconnect); omit to create a new one */
  connId: ConnIdSchema.optional(),
  /** Open a tree view automatically once connected */
  openTree: z.boolean().optional(),
})

export const ConnCloseInputSchema = z.object({
  connId: ConnIdSchema,
  /** Also close every view belonging to this connection (default true) */
  closeViews: z.boolean().optional(),
})

export const ViewOpenInputSchema = z.object({
  spec: ViewOpenSpecSchema,
  /** Which panel to open into; falls back to focusedPanel, then to the first empty panel */
  panelId: PanelIdSchema.optional(),
  /** When the target panel already holds a view: true replaces it (the old view is closed), false opens a new panel. Default true */
  replace: z.boolean().optional(),
  /** Focus the view once open (default true) */
  focus: z.boolean().optional(),
})

export const ViewUpdateInputSchema = z.object({
  viewId: ViewIdSchema,
  patch: ViewPatchSchema,
  /** Re-fetch immediately with the new parameters (default true for table/vector, false for query) */
  refresh: z.boolean().optional(),
})

export const ViewCloseInputSchema = z.object({
  viewId: ViewIdSchema,
})

export const QueryRunInputSchema = z
  .object({
    /** Run inside an existing query view */
    viewId: ViewIdSchema.optional(),
    /** Without a viewId, connId + text are required and main opens a new query view */
    connId: ConnIdSchema.optional(),
    /** Override the view's statement text; omit to run whatever the view currently holds */
    text: z.string().optional(),
    params: z.array(z.unknown()).optional(),
    maxRows: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Which panel a newly opened view lands in */
    panelId: PanelIdSchema.optional(),
  })
  // Zod issue messages surface in PeekError.detail, which is never translated.
  .refine(
    (v) => v.viewId !== undefined || (v.connId !== undefined && v.text !== undefined),
    { message: 'Provide either viewId, or connId together with text' },
  )

export const QueryCancelInputSchema = z
  .object({
    resultId: ResultIdSchema.optional(),
    /** Cancel whatever result set this view is currently running */
    viewId: ViewIdSchema.optional(),
  })
  .refine((v) => v.resultId !== undefined || v.viewId !== undefined, {
    message: 'Provide either resultId or viewId',
  })

export const LayoutSplitInputSchema = z.object({
  /** The panel to split */
  panelId: PanelIdSchema,
  dir: z.enum(['row', 'col']),
  /** Place the new panel before or after the original one (default after) */
  insert: z.enum(['before', 'after']).optional(),
  /** Ratios after the split; the length must equal the new split's child count, otherwise the space is divided evenly */
  ratio: z.array(z.number().positive()).optional(),
  /** Optionally open a view in the new panel right away */
  view: ViewOpenSpecSchema.optional(),
})

export const LayoutFocusInputSchema = z.object({
  panelId: PanelIdSchema,
})

export const LayoutSetRatioInputSchema = z.object({
  splitId: SplitIdSchema,
  ratio: z.array(z.number().positive()).min(2),
})

export const LayoutCloseInputSchema = z.object({
  panelId: PanelIdSchema,
  /** Close the panel's view along with it (default true) */
  closeView: z.boolean().optional(),
})

export const StateReadInputSchema = z.object({
  /** Ask for only the parts you need, to save tokens; omit for everything */
  include: z.array(z.enum(['layout', 'views', 'connections', 'results'])).optional(),
  /** Pass a view id when only that view matters; `views` in the response then holds just this one */
  viewId: ViewIdSchema.optional(),
})

/* ================================================================== */
/* 3. Registry: command name → input schema                            */
/* ================================================================== */

/**
 * The command registry. **This is the single source of truth**: every input type
 * is `CommandInput<'xxx'>`, z.infer'd from here, so no second hand-written copy
 * exists.
 */
export const commandSchemas = {
  'conn.open': ConnOpenInputSchema,
  'conn.close': ConnCloseInputSchema,
  'view.open': ViewOpenInputSchema,
  'view.update': ViewUpdateInputSchema,
  'view.close': ViewCloseInputSchema,
  'query.run': QueryRunInputSchema,
  'query.cancel': QueryCancelInputSchema,
  'layout.split': LayoutSplitInputSchema,
  'layout.focus': LayoutFocusInputSchema,
  'layout.setRatio': LayoutSetRatioInputSchema,
  'layout.close': LayoutCloseInputSchema,
  'state.read': StateReadInputSchema,
} as const satisfies Record<CommandName, z.ZodType>

export type CommandSchemas = typeof commandSchemas

/** Input type of one command */
export type CommandInput<K extends CommandName> = z.infer<CommandSchemas[K]>

/* ================================================================== */
/* 4. Per-command results                                              */
/* ================================================================== */

export interface ConnOpenResult {
  connId: ConnId
  status: ConnStatus
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** The tree view opened automatically, when openTree was true */
  treeViewId?: ViewId
}

export interface ConnCloseResult {
  connId: ConnId
  closedViewIds: ViewId[]
}

export interface ViewOpenResult {
  viewId: ViewId
  panelId: PanelId
  kind: ViewKind
  /** Present when a table/vector view started fetching on open */
  resultId?: ResultId
}

export interface ViewUpdateResult {
  viewId: ViewId
  /** The new result set, when the update triggered a re-fetch */
  resultId?: ResultId
}

export interface ViewCloseResult {
  viewId: ViewId
  /** The panel the view used to sit in (the panel stays, with viewId set to null) */
  panelId: PanelId | null
}

export interface QueryRunResult {
  resultId: ResultId
  viewId: ViewId
}

export interface QueryCancelResult {
  resultId: ResultId
  /** False when the target had already finished */
  cancelled: boolean
}

export interface LayoutSplitResult {
  splitId: SplitId
  /** The newly created panel */
  panelId: PanelId
  /** Present when a `view` was passed in */
  viewId?: ViewId
}

export interface LayoutFocusResult {
  panelId: PanelId
}

export interface LayoutSetRatioResult {
  splitId: SplitId
  /** The effective ratios after normalization */
  ratio: number[]
}

export interface LayoutCloseResult {
  panelId: PanelId
  closedViewIds: ViewId[]
}

export interface StateReadResult {
  snapshot: WorkspaceSnapshot
}

export interface CommandResultMap {
  'conn.open': ConnOpenResult
  'conn.close': ConnCloseResult
  'view.open': ViewOpenResult
  'view.update': ViewUpdateResult
  'view.close': ViewCloseResult
  'query.run': QueryRunResult
  'query.cancel': QueryCancelResult
  'layout.split': LayoutSplitResult
  'layout.focus': LayoutFocusResult
  'layout.setRatio': LayoutSetRatioResult
  'layout.close': LayoutCloseResult
  'state.read': StateReadResult
}

/** Compile-time assertion: every command needs a result type — miss one and this line goes red */
type MissingResult = Exclude<CommandName, keyof CommandResultMap>
const _assertNoMissingResult: MissingResult extends never ? true : never = true
void _assertNoMissingResult

export type CommandResultData<K extends CommandName> = CommandResultMap[K]

/* ================================================================== */
/* 5. Command and result envelopes                                     */
/* ================================================================== */

/** A single command; `name` and `input` are correlated */
export type Command = { [K in CommandName]: { name: K; input: CommandInput<K> } }[CommandName]

export interface CommandEnvelope<K extends CommandName = CommandName> {
  /** Unique id, carried through the command log, the patch broadcast and the result */
  id: string
  name: K
  input: CommandInput<K>
  source: CommandSource
  /** Timestamp of dispatch (ms) */
  ts: number
}

/** Envelope of any command, keeping `name` and `input` correlated */
export type AnyCommandEnvelope = { [K in CommandName]: CommandEnvelope<K> }[CommandName]

export interface CommandOk<T> {
  ok: true
  commandId: string
  /** Workspace revision after the command was committed */
  rev: number
  data: T
}

export interface CommandErr {
  ok: false
  commandId: string
  error: PeekError
}

export type CommandResult<T = unknown> = CommandOk<T> | CommandErr

/** Full result type of one command */
export type CommandResultFor<K extends CommandName> = CommandResult<CommandResultData<K>>

export function commandOk<T>(commandId: string, rev: number, data: T): CommandOk<T> {
  return { ok: true, commandId, rev, data }
}

export function commandErr(commandId: string, error: PeekError): CommandErr {
  return { ok: false, commandId, error }
}

/* ================================================================== */
/* 6. Validation entry point                                           */
/* ================================================================== */

export type ParsedCommand<K extends CommandName> =
  | { ok: true; input: CommandInput<K> }
  | { ok: false; error: PeekError }

/**
 * Validate one command's input. The UI and the MCP tools **both** have to clear
 * this gate before reaching the Command Bus, which is what guarantees a handler
 * only ever sees well-formed data.
 */
export function parseCommandInput<K extends CommandName>(name: K, raw: unknown): ParsedCommand<K> {
  const schema: z.ZodType = commandSchemas[name]
  const result = schema.safeParse(raw)
  if (result.success) {
    return { ok: true, input: result.data as CommandInput<K> }
  }
  return {
    ok: false,
    // The summary is localizable; the zod issue list in `detail` never is.
    error: peekErrorMsg('BAD_REQUEST', 'error.command.badInput', { name }, {
      detail: formatZodIssues(result.error),
    }),
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('\n')
}

/** Assemble an envelope for a command about to be executed */
export function makeCommandEnvelope<K extends CommandName>(
  id: string,
  name: K,
  input: CommandInput<K>,
  source: CommandSource,
): CommandEnvelope<K> {
  return { id, name, input, source, ts: Date.now() }
}

/**
 * Convert one command's input schema to JSON Schema, so an MCP tool can reuse it
 * directly as its `inputSchema`. That makes the first half of "a new MCP tool =
 * declare an inputSchema + map it onto some commands" cost essentially nothing.
 */
export const commandInputJsonSchema = (name: CommandName): unknown =>
  z.toJSONSchema(commandSchemas[name], { io: 'input', unrepresentable: 'any' })
