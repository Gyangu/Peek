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
import { peekError, type PeekError } from './errors'
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
/* 0. 命令名（PLAN 第 6 节，domain.verb）                                */
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

/** 命令来源，用于 Command 日志与审计（日志天然是操作录制，可回放） */
export const CommandSourceSchema = z.enum(['ui', 'mcp', 'system'])
export type CommandSource = z.infer<typeof CommandSourceSchema>

/* ================================================================== */
/* 1. 视图开启规格与增量更新                                              */
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
  /** 不给就是空编辑器 */
  text: z.string().optional(),
  /** 开完立刻执行 */
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

/** view.open 的入参规格：不含 id（id 由 main 生成） */
export const ViewOpenSpecSchema = z.discriminatedUnion('kind', [
  TableViewSpecSchema,
  QueryViewSpecSchema,
  InspectorViewSpecSchema,
  TreeViewSpecSchema,
  VectorViewSpecSchema,
])
export type ViewOpenSpec = z.infer<typeof ViewOpenSpecSchema>

/**
 * view.update 的增量补丁。必须带 kind，main 会校验它与目标视图的 kind 一致，
 * 不一致回 BAD_REQUEST（防止 AI 把 table 的 filter 打到 query 视图上）。
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
/* 2. 各命令入参 schema —— 类型全部由 z.infer 派生，绝不手写第二遍           */
/* ================================================================== */

export const ConnOpenInputSchema = z.object({
  config: ConnectionConfigSchema,
  /** 复用已有连接 id（重连场景）；不给则新建 */
  connId: ConnIdSchema.optional(),
  /** 建连后自动开一个 tree 视图 */
  openTree: z.boolean().optional(),
})

export const ConnCloseInputSchema = z.object({
  connId: ConnIdSchema,
  /** 一并关掉该连接下的所有视图（默认 true） */
  closeViews: z.boolean().optional(),
})

export const ViewOpenInputSchema = z.object({
  spec: ViewOpenSpecSchema,
  /** 开到哪个面板；不给则用 focusedPanel，再不行用第一个空面板 */
  panelId: PanelIdSchema.optional(),
  /** 目标面板已有视图时：true 覆盖（旧视图被关闭），false 则新开面板。默认 true */
  replace: z.boolean().optional(),
  /** 开完是否聚焦（默认 true） */
  focus: z.boolean().optional(),
})

export const ViewUpdateInputSchema = z.object({
  viewId: ViewIdSchema,
  patch: ViewPatchSchema,
  /** 是否立即按新参数重新取数（table/vector 默认 true，query 默认 false） */
  refresh: z.boolean().optional(),
})

export const ViewCloseInputSchema = z.object({
  viewId: ViewIdSchema,
})

export const QueryRunInputSchema = z
  .object({
    /** 在已有 query 视图里跑 */
    viewId: ViewIdSchema.optional(),
    /** 没有 viewId 时必须给 connId + text，main 会新开一个 query 视图 */
    connId: ConnIdSchema.optional(),
    /** 覆盖视图里的语句文本；不给则用视图当前文本 */
    text: z.string().optional(),
    params: z.array(z.unknown()).optional(),
    maxRows: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** 新开视图时落到哪个面板 */
    panelId: PanelIdSchema.optional(),
  })
  .refine(
    (v) => v.viewId !== undefined || (v.connId !== undefined && v.text !== undefined),
    { message: '需要 viewId，或者 connId + text' },
  )

export const QueryCancelInputSchema = z
  .object({
    resultId: ResultIdSchema.optional(),
    /** 取消该视图当前正在跑的结果集 */
    viewId: ViewIdSchema.optional(),
  })
  .refine((v) => v.resultId !== undefined || v.viewId !== undefined, {
    message: '需要 resultId 或 viewId',
  })

export const LayoutSplitInputSchema = z.object({
  /** 要被劈开的面板 */
  panelId: PanelIdSchema,
  dir: z.enum(['row', 'col']),
  /** 新面板放在原面板之前还是之后（默认 after） */
  insert: z.enum(['before', 'after']).optional(),
  /** 劈开后的占比；长度必须等于新 split 的子节点数，否则等分 */
  ratio: z.array(z.number().positive()).optional(),
  /** 顺手在新面板里开一个视图 */
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
  /** 面板里的视图是否一起关掉（默认 true） */
  closeView: z.boolean().optional(),
})

export const StateReadInputSchema = z.object({
  /** 只取需要的部分，省 token；不给则全给 */
  include: z.array(z.enum(['layout', 'views', 'connections', 'results'])).optional(),
  /** 只关心某个视图时给它，返回值里 views 只含这一个 */
  viewId: ViewIdSchema.optional(),
})

/* ================================================================== */
/* 3. 注册表：command name → input schema                              */
/* ================================================================== */

/**
 * Command 注册表。**这是唯一的真源**：
 * 入参类型一律 `CommandInput<'xxx'>` 从这里 z.infer 出来，不存在手写第二份。
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

/** 某条命令的入参类型 */
export type CommandInput<K extends CommandName> = z.infer<CommandSchemas[K]>

/* ================================================================== */
/* 4. 各命令返回值                                                      */
/* ================================================================== */

export interface ConnOpenResult {
  connId: ConnId
  status: ConnStatus
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** openTree 为 true 时返回自动开出的树视图 */
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
  /** table/vector 视图开启即取数时返回 */
  resultId?: ResultId
}

export interface ViewUpdateResult {
  viewId: ViewId
  /** 触发了重新取数时返回新结果集 */
  resultId?: ResultId
}

export interface ViewCloseResult {
  viewId: ViewId
  /** 视图原本挂在哪个面板（面板保留，viewId 置 null） */
  panelId: PanelId | null
}

export interface QueryRunResult {
  resultId: ResultId
  viewId: ViewId
}

export interface QueryCancelResult {
  resultId: ResultId
  /** 目标本来就已结束时为 false */
  cancelled: boolean
}

export interface LayoutSplitResult {
  splitId: SplitId
  /** 新建出来的面板 */
  panelId: PanelId
  /** 传了 view 时返回 */
  viewId?: ViewId
}

export interface LayoutFocusResult {
  panelId: PanelId
}

export interface LayoutSetRatioResult {
  splitId: SplitId
  /** 归一化之后的实际占比 */
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

/** 编译期断言：每条命令都必须有返回值类型，漏一条这里就红 */
type MissingResult = Exclude<CommandName, keyof CommandResultMap>
const _assertNoMissingResult: MissingResult extends never ? true : never = true
void _assertNoMissingResult

export type CommandResultData<K extends CommandName> = CommandResultMap[K]

/* ================================================================== */
/* 5. Command 信封与结果信封                                             */
/* ================================================================== */

/** 单条命令（name 与 input 强相关） */
export type Command = { [K in CommandName]: { name: K; input: CommandInput<K> } }[CommandName]

export interface CommandEnvelope<K extends CommandName = CommandName> {
  /** 唯一 id，贯穿 Command 日志、patch 广播、结果返回 */
  id: string
  name: K
  input: CommandInput<K>
  source: CommandSource
  /** 发起时间戳（ms） */
  ts: number
}

/** 任意命令的信封（name 与 input 保持相关性） */
export type AnyCommandEnvelope = { [K in CommandName]: CommandEnvelope<K> }[CommandName]

export interface CommandOk<T> {
  ok: true
  commandId: string
  /** 落地后的 Workspace 修订号 */
  rev: number
  data: T
}

export interface CommandErr {
  ok: false
  commandId: string
  error: PeekError
}

export type CommandResult<T = unknown> = CommandOk<T> | CommandErr

/** 某条命令的完整结果类型 */
export type CommandResultFor<K extends CommandName> = CommandResult<CommandResultData<K>>

export function commandOk<T>(commandId: string, rev: number, data: T): CommandOk<T> {
  return { ok: true, commandId, rev, data }
}

export function commandErr(commandId: string, error: PeekError): CommandErr {
  return { ok: false, commandId, error }
}

/* ================================================================== */
/* 6. 校验入口                                                          */
/* ================================================================== */

export type ParsedCommand<K extends CommandName> =
  | { ok: true; input: CommandInput<K> }
  | { ok: false; error: PeekError }

/**
 * 校验某条命令的入参。UI 与 MCP 工具**都必须**先过这一关再进 Command Bus，
 * 保证进入 handler 的一定是合法数据。
 */
export function parseCommandInput<K extends CommandName>(name: K, raw: unknown): ParsedCommand<K> {
  const schema: z.ZodType = commandSchemas[name]
  const result = schema.safeParse(raw)
  if (result.success) {
    return { ok: true, input: result.data as CommandInput<K> }
  }
  return {
    ok: false,
    error: peekError('BAD_REQUEST', `命令 ${name} 入参不合法`, {
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

/** 组装一条待执行的命令信封 */
export function makeCommandEnvelope<K extends CommandName>(
  id: string,
  name: K,
  input: CommandInput<K>,
  source: CommandSource,
): CommandEnvelope<K> {
  return { id, name, input, source, ts: Date.now() }
}

/**
 * 把某条命令的入参 schema 转成 JSON Schema，供 MCP 工具的 inputSchema 直接复用。
 * 这样"新增 MCP 工具 = 声明 inputSchema + 映射到若干 Command"里的前半句几乎为零成本。
 */
export const commandInputJsonSchema = (name: CommandName): unknown =>
  z.toJSONSchema(commandSchemas[name], { io: 'input', unrepresentable: 'any' })
