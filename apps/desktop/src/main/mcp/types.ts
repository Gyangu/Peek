/**
 * MCP 层的公共类型（PLAN 第 7 节）。
 *
 * 设计原则：**工具层是薄壳**。一个工具 = 一份 zod inputSchema + 一个到 Command 的映射，
 * 除此之外不允许有业务逻辑。只读工具（read_workspace / list_connections）不经 Command Bus，
 * 直接读 main 的 Workspace Store（PLAN 第 3 节：零 renderer 往返）。
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

/* ================================================================== */
/* 1. 注入依赖（不 import Command Bus 实例，一律构造函数注入）              */
/* ================================================================== */

/** Command Bus 入口。source 由调用方给，MCP 侧一律传 'mcp'。 */
export type CommandDispatch = <K extends CommandName>(
  name: K,
  input: CommandInput<K>,
  source: CommandSource,
) => Promise<CommandResultFor<K>>

/**
 * 命名空间树读取器。
 *
 * 注意：`introspect` 不是 Command（COMMAND_NAMES 里没有它），它是 driver host 的 RPC
 * （HostRpcMap['introspect.children']）。所以 introspect 工具走这条注入的只读通道，
 * 由 Connection Manager 把请求转给对应连接的 driver host。
 */
export type IntrospectReader = (req: {
  connId: ConnId
  /** null 表示根层 */
  parentId: string | null
  refresh?: boolean
}) => Promise<NamespaceNode[]>

/** 结果集的行切片（给 AI 看的前 N 行，全量数据在界面里） */
export interface ResultRowsSlice {
  columns: ColumnDef[]
  /** 行式（每行按 columns 顺序），已按 limit 截断 */
  rows: unknown[][]
  /** 结果集已知的总行数（还在跑时为当前已收到的行数） */
  totalRows: number
  /** 因 limit 截断（还有更多行没给 AI 看） */
  truncated: boolean
}

/**
 * 结果集行读取器。
 *
 * 注意：数据面（chunk）走 MessagePort 直达 renderer，**main 手里没有行数据**
 * （PLAN 第 3 节）。所以 run_query 想回前 N 行，必须由集成层注入这个读取器
 * （典型实现：向 renderer 要它缓存里的头几个 chunk）。不注入时 run_query
 * 依然可用，只是退化成只回 ResultMeta（行数 / 耗时 / 状态）。
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
/* 2. 工具执行上下文                                                     */
/* ================================================================== */

export interface ToolContext {
  readonly dispatch: CommandDispatch
  /** main 的 Workspace 真源快照（已脱敏） */
  readonly getSnapshot: () => WorkspaceSnapshot
  readonly introspect?: IntrospectReader
  readonly readResultRows?: ResultRowsReader
  readonly logger: McpLogger
  /** 可注入，便于测试 */
  readonly now: () => number
  /** 可注入，便于测试；默认 setTimeout */
  readonly sleep: (ms: number) => Promise<void>
}

/* ================================================================== */
/* 3. 工具产出                                                          */
/* ================================================================== */

/** 工具的统一产出。executor 负责翻成 MCP 的 CallToolResult。 */
export interface ToolOutput {
  /** 给模型看的正文（人可读优先，必要时内嵌 JSON） */
  text: string
  /** 结构化附件，序列化后作为第二段 text 返回；不给则不附 */
  data?: unknown
  /** 工具级错误（不是协议级错误：server 绝不因此崩） */
  isError?: boolean
}

/** 单条 Command 的执行结果（executor 汇总用） */
export interface CommandOutcome {
  name: CommandName
  ok: boolean
  rev?: number
  data?: unknown
  error?: PeekError
}

/* ================================================================== */
/* 4. 工具定义                                                          */
/* ================================================================== */

/** 与 MCP SDK 的 ToolAnnotations 对齐的一小撮字段（不直接依赖 SDK 类型） */
export interface ToolAnnotationsLite {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface ToolSpecBase<S extends z.ZodType> {
  /** MCP 工具名，snake_case */
  name: string
  title?: string
  description: string
  /** zod schema，同时用于 MCP 的 inputSchema（SDK 直接吃 zod v4） */
  inputSchema: S
  annotations?: ToolAnnotationsLite
}

/** 映射到若干 Command 的工具（薄壳的典型形态） */
export interface CommandToolSpec<S extends z.ZodType> extends ToolSpecBase<S> {
  kind: 'command'
  /** 把工具入参映射成一串 Command，executor 按序 dispatch，遇错即停 */
  toCommands(input: z.output<S>, ctx: ToolContext): Command[] | Promise<Command[]>
  /** 可选：把命令结果渲染成给 AI 看的正文；不给则用默认渲染 */
  render?(
    outcomes: CommandOutcome[],
    input: z.output<S>,
    ctx: ToolContext,
  ): ToolOutput | Promise<ToolOutput>
}

/** 只读工具：直接读 Workspace Store / 注入的只读通道，不经 dispatch */
export interface ReadToolSpec<S extends z.ZodType> extends ToolSpecBase<S> {
  kind: 'read'
  read(input: z.output<S>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>
}

export type ToolSpec<S extends z.ZodType> = CommandToolSpec<S> | ReadToolSpec<S>

/**
 * 泛型擦除后的工具形态。注册表里存的是这个：
 * 具体入参类型被 defineTool 闭包吃掉，外部只看到 `run(unknown)`。
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
