import type {
  Capability,
  CollectionRef,
  CollectionSchemaInfo,
  ColumnDef,
  ConnId,
  ConnStatus,
  ConnectionConfig,
  DriverId,
  HostParams,
  HostResult,
  KeyValueResult,
  NamespaceNode,
  NotifyLevel,
  PeekError,
  PeekedValue,
  ResultId,
  ResultPause,
  ServerInfo,
  ValueRef,
} from '@peek/core'
import type { Timeouts } from './classify'

/* ================================================================== */
/* 1. 连接的运行时视图（main 内部用，不进 Workspace）                      */
/* ================================================================== */

/**
 * 连接管理器自己维护的运行时记录。
 * Workspace 里的 ConnectionState 是**真源**，由 Command Bus 维护；
 * 这里只是进程侧的镜像，靠事件把变化推给 Bus。
 */
export interface ConnectionRuntime {
  connId: ConnId
  driverId: DriverId
  label: string
  status: ConnStatus
  /** ready 后由 host 回填的实际能力集 */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  error?: PeekError
  /** driver host 的 utilityProcess pid */
  pid?: number
  readyAt?: number
  /** 正在流的结果集（用于崩溃时批量报错、断连时清理） */
  activeResults: ResultId[]
}

/* ================================================================== */
/* 2. 副作用接口（注入给 Command Bus）                                    */
/* ================================================================== */

export interface ConnectOptions {
  /** 复用已有连接 id（重连场景）；不给则新建 */
  connId?: ConnId
  /** 覆盖建连超时；不给则用 config.connectTimeoutMs 或默认值 */
  timeoutMs?: number
}

export interface ConnectOutcome {
  connId: ConnId
  /** 连上之后驱动实际声明的能力集 */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  pid?: number
}

export interface CancelOutcome {
  /** 目标确实被取消了（本来就已结束时为 false） */
  cancelled: boolean
  /** 是否走了"强制取消 = 杀进程"这条路（PLAN 第 3 节） */
  killed: boolean
}

/** 发起一次流式取数（query / scan / vectorSearch）的返回 */
export interface StartResultOutcome {
  resultId: ResultId
}

/**
 * 连接管理器对 Command Bus 暴露的副作用接口。
 *
 * 约定：
 * - **所有方法失败时 reject 的都是 PeekError 形状**（不是 Error 实例），
 *   调用方直接 `toPeekError(e)` 即可（core 的 toPeekError 会原样返回 PeekError）。
 * - query/scan/vectorSearch 只返回 resultId；**数据帧不经过 main**，
 *   由 driver host 通过 MessagePort 直发 renderer（PLAN 第 3 节）。
 * - 参数形状与 `@peek/core` 的 `HostRpcMap` 完全一致，避免两边各写一遍。
 */
export interface ConnectionEffects {
  /** 建连：spawn utilityProcess → ready 握手 → connect RPC */
  connect(config: ConnectionConfig, options?: ConnectOptions): Promise<ConnectOutcome>

  /** 优雅断连并回收进程；连接不存在时静默返回 */
  disconnect(connId: ConnId): Promise<void>

  /** 命名空间树懒加载：parentId 为 null 取根层 */
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>

  /** 集合结构描述（列定义、主键、行数估算） */
  describeCollection(connId: ConnId, ref: CollectionRef): Promise<CollectionSchemaInfo>

  /** 发起自由查询，返回 resultId */
  runQuery(connId: ConnId, params: HostParams<'query.run'>): Promise<StartResultOutcome>

  /** 发起集合扫描，返回 resultId */
  scan(connId: ConnId, params: HostParams<'collection.scan'>): Promise<StartResultOutcome>

  /** 发起向量检索，返回 resultId */
  vectorSearch(connId: ConnId, params: HostParams<'vector.search'>): Promise<StartResultOutcome>

  /** 按 key 取类型化的值（redis 检查器） */
  getValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult>

  /** 大 value 按需取全量 */
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset?: number; length?: number },
  ): Promise<PeekedValue>

  /**
   * 取消某个结果集。
   * 先走驱动的协作式 cancel；超时或驱动不支持时**升级为杀进程**（PLAN 第 3 节）。
   */
  cancel(connId: ConnId, resultId: ResultId, options?: { force?: boolean }): Promise<CancelOutcome>

  /** 健康检查 */
  ping(connId: ConnId): Promise<HostResult<'ping'>>

  /** 只读：某连接当前的运行时状态 */
  getRuntime(connId: ConnId): ConnectionRuntime | null

  /** 只读：全部连接 */
  listRuntimes(): ConnectionRuntime[]

  /** 只读：连接是否具备某能力（连上之后以驱动实际声明为准） */
  hasCapability(connId: ConnId, capability: Capability): boolean
}

/* ================================================================== */
/* 3. 事件表（连接管理器 → Command Bus / 通知层）                         */
/* ================================================================== */

export interface ResultDoneInfo {
  rows: number
  elapsedMs: number
  truncated?: boolean
  nextCursor?: string
}

/**
 * 连接管理器发出的事件。
 * Command Bus 订阅 status / result.* 把变化写回 Workspace 真源并广播 patch；
 * 通知层订阅 log / crashed 弹 toast。
 */
export interface ConnectionEventMap extends Record<string, unknown> {
  /** 连接状态机变化（idle → connecting → ready / error） */
  status: { connId: ConnId; status: ConnStatus; error?: PeekError; pid?: number }
  /** 首帧 schema 到手，main 用来回填 ResultMeta.schema */
  'result.schema': { connId: ConnId; resultId: ResultId; schema: ColumnDef[] }
  /** 结果集正常收尾 */
  'result.done': { connId: ConnId; resultId: ResultId; info: ResultDoneInfo }
  /** 结果集按设计暂停（背压空闲超时）——**不是错误**，已发出的行全部有效 */
  'result.paused': { connId: ConnId; resultId: ResultId; paused: ResultPause }
  /** 结果集异常终止 */
  'result.error': { connId: ConnId; resultId: ResultId; error: PeekError }
  /** 长查询的行数心跳 */
  'result.progress': { connId: ConnId; resultId: ResultId; rows: number }
  /** driver host 的日志（含 stdout/stderr 转发） */
  log: { connId: ConnId; level: NotifyLevel; message: string; detail?: string }
  /** driver host 非预期退出：进程已回收，连接不可用 */
  crashed: { connId: ConnId; error: PeekError; code: number; expected: boolean }
  /** 数据面端口已移交给 renderer（排查用） */
  'port.attached': { connId: ConnId; pid?: number }
}

/* ================================================================== */
/* 4. 管理器构造选项                                                    */
/* ================================================================== */

export interface ConnectionManagerOptions {
  /**
   * driver host 构建产物所在目录。默认取 main bundle 自身所在目录（out/main）。
   * 可用环境变量 PEEK_DRIVER_HOST_DIR 覆盖，方便测试。
   */
  hostDir?: string
  /** 覆盖各阶段超时 */
  timeouts?: Partial<Timeouts>
  /** 把 driver host 的 stdout/stderr 转成 log 事件（默认 true） */
  forwardStdio?: boolean
}
