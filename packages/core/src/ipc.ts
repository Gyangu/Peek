import type { Patch } from 'immer'
import type {
  Capability,
  CollectionRef,
  CollectionSchemaInfo,
  ConnectionConfig,
  FilterSpec,
  KeyValueResult,
  NamespaceNode,
  PeekedValue,
  ServerInfo,
  SortSpec,
  ValueRef,
} from './capability'
import type { ColumnDef, ResultPause } from './chunk'
import type { CommandInput, CommandName, CommandResultFor, CommandSource } from './commands'
import type { PeekError } from './errors'
import type { ConnId, ResultId, ViewId } from './ids'
import type { ConnStatus, Workspace, WorkspaceSnapshot } from './workspace'

/* ================================================================== */
/* 0. 常量                                                             */
/* ================================================================== */

/** MCP Streamable HTTP 默认端口（PLAN 第 7 节） */
export const MCP_DEFAULT_HOST = '127.0.0.1'
export const MCP_DEFAULT_PORT = 7332
export const MCP_HTTP_PATH = '/mcp'
/** token 与端口写在 ~/.peek/mcp.json */
export const PEEK_CONFIG_DIR_NAME = '.peek'
export const MCP_CONFIG_FILE_NAME = 'mcp.json'

/** preload 挂到 window 上的键名 */
export const PEEK_BRIDGE_KEY = 'peek' as const

/* ================================================================== */
/* 1. IPC channel 名                                                   */
/* ================================================================== */

/**
 * 所有 channel 名集中在此，禁止在任何地方硬编码字符串。
 * 方向标注：
 *   R→M  renderer → main（ipcRenderer.invoke）
 *   M→R  main → renderer（webContents.send）
 */
export const IPC = {
  /** R→M：执行一条 Command，返回 CommandResult */
  COMMAND_INVOKE: 'peek:command:invoke',
  /** R→M：拉取 Workspace 全量快照（renderer 启动或检测到 rev 断层时） */
  STATE_SNAPSHOT: 'peek:state:snapshot',

  /** M→R：immer patch 广播 */
  STATE_PATCH: 'peek:state:patch',
  /** M→R：移交某连接的 MessagePort（event.ports[0] 拿端口） */
  RESULT_PORT: 'peek:result:port',
  /** M→R：非状态类通知（toast、driver 崩溃提示等） */
  NOTIFY: 'peek:notify',

  /**
   * R→M：非命令类只读 RPC（命名空间树懒加载 / 大 value 取全量 / keyValue 取值）。
   *
   * 这三件事在 PLAN 第 6 节的命令表里没有对应项，但 driver host 的 HostRpcMap 里有；
   * 它们**不改 Workspace 状态**（树节点、单值本体都不进真源），因此不适合做成 Command，
   * 走这条独立的只读通道，由 main 转发到对应连接的 driver host。
   */
  DRIVER_RPC: 'peek:driver:rpc',

  /**
   * M→R：向 renderer 索取某结果集缓存里的前 N 行。
   *
   * 数据面 chunk 由 driver host 经 MessagePort 直发 renderer，**main 手里没有行数据**，
   * 而 MCP 的 run_query 要给 AI 回几行样本，只能反过来向 renderer 取样。
   */
  RESULT_ROWS_REQUEST: 'peek:result:rows:request',
  /** R→M：RESULT_ROWS_REQUEST 的应答（按 requestId 配对） */
  RESULT_ROWS_REPLY: 'peek:result:rows:reply',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/* ================================================================== */
/* 2. main ↔ renderer 消息体                                            */
/* ================================================================== */

export interface CommandInvokeMessage<K extends CommandName = CommandName> {
  name: K
  input: CommandInput<K>
  source: CommandSource
  /** renderer 侧生成的关联 id，可用于本地去重；不给由 main 生成 */
  commandId?: string
}

/**
 * 状态 patch 广播。renderer 镜像 store 严格按 rev 递增应用；
 * 若收到的 fromRev 与本地 rev 不连续，必须走 STATE_SNAPSHOT 重新对齐。
 */
export interface StatePatchMessage {
  /** 应用前的 rev */
  fromRev: number
  /** 应用后的 rev */
  rev: number
  patches: Patch[]
  /** 触发这批 patch 的命令 */
  commandId?: string
  commandName?: CommandName
}

export interface StateSnapshotMessage {
  rev: number
  workspace: Workspace
}

/** MessagePort 移交：port 走 Electron 的 event.ports，不在消息体里 */
export interface ResultPortMessage {
  connId: ConnId
  /** driver host 的 pid，便于排查 */
  pid?: number
}

export type NotifyLevel = 'info' | 'warn' | 'error'

export interface NotifyMessage {
  level: NotifyLevel
  message: string
  detail?: string
  connId?: ConnId
  viewId?: ViewId
}

/* ================================================================== */
/* 2b. 非命令类只读 RPC（renderer ↔ main ↔ driver host）                 */
/* ================================================================== */

/**
 * renderer 发起的只读 RPC。与 Command 的区别：
 * **不改状态、不进 Command 日志、不广播 patch**，只是把 driver host 的一次查询
 * 结果原样带回来（树的子节点 / 大 value 全量 / redis 类型化取值）。
 */
export type DriverRpcRequest =
  | { kind: 'introspect'; connId: ConnId; parentId: string | null; refresh?: boolean }
  | { kind: 'peekValue'; connId: ConnId; ref: ValueRef; range?: { offset: number; length: number } }
  | { kind: 'keyValue'; connId: ConnId; ref: ValueRef }

export type DriverRpcKind = DriverRpcRequest['kind']

export interface DriverRpcResultMap {
  introspect: NamespaceNode[]
  peekValue: PeekedValue
  keyValue: KeyValueResult
}

/** 只读 RPC 的应答信封：错误一律收敛成 PeekError，绝不把原始 Error 扔过 IPC */
export type DriverRpcResponse<K extends DriverRpcKind = DriverRpcKind> =
  | { ok: true; data: DriverRpcResultMap[K] }
  | { ok: false; error: PeekError }

/* ------------------------------------------------------------------ */
/* 结果集取样（main → renderer）                                        */
/* ------------------------------------------------------------------ */

export interface ResultRowsRequestMessage {
  /** 配对应答用，由 main 生成 */
  requestId: string
  resultId: ResultId
  /** 最多要几行 */
  limit: number
}

export type ResultRowsReplyMessage =
  | {
      requestId: string
      ok: true
      columns: ColumnDef[]
      /** 行式（每行按 columns 顺序），已按 limit 截断 */
      rows: unknown[][]
      /** 结果集已知的总行数（还在跑时为当前已收到的行数） */
      totalRows: number
      /** 因 limit 截断（还有更多行没给出） */
      truncated: boolean
    }
  | { requestId: string; ok: false; error: PeekError }

/* ================================================================== */
/* 3. preload 暴露给 renderer 的窄桥                                     */
/* ================================================================== */

/**
 * preload 只暴露这一个对象，renderer 不允许拿到 ipcRenderer 本体。
 * 所有 on* 返回取消订阅函数。
 */
export interface PeekBridge {
  invoke<K extends CommandName>(
    name: K,
    input: CommandInput<K>,
    source?: CommandSource,
  ): Promise<CommandResultFor<K>>

  getSnapshot(): Promise<StateSnapshotMessage>

  onPatch(handler: (msg: StatePatchMessage) => void): () => void

  /** 收到某连接的数据面端口；renderer 用它接 ResultStreamMessage、回 ResultStreamAck */
  onResultPort(handler: (msg: ResultPortMessage, port: MessagePort) => void): () => void

  onNotify(handler: (msg: NotifyMessage) => void): () => void

  /* ---------------- 非命令类只读通道 ---------------- */
  /*
   * 下面这几个是**可选**的：preload 的主世界引导若降级（executeInMainWorld 不可用），
   * 只有控制面能用。renderer 必须运行时探测，缺失时降级展示，不允许直接解引用。
   */

  /** 命名空间树懒加载，对应 HostRpcMap['introspect.children'] */
  introspect?(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>

  /** 大 value 取全量/按段取，对应 HostRpcMap['value.peek'] */
  peekValue?(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>

  /** 按 key 取类型化的值，对应 HostRpcMap['keyvalue.get'] */
  getKeyValue?(connId: ConnId, ref: ValueRef): Promise<KeyValueResult>

  /** main 向本 renderer 索取结果集样本行；handler 负责回 reply */
  onResultRowsRequest?(
    handler: (msg: ResultRowsRequestMessage) => void,
  ): () => void

  /** 应答 onResultRowsRequest */
  replyResultRows?(msg: ResultRowsReplyMessage): void
}

declare global {
  interface Window {
    /** 由 preload 注入；键名见 PEEK_BRIDGE_KEY。renderer 侧请勿重复声明。 */
    readonly peek: PeekBridge
  }
}

/* ================================================================== */
/* 4. driver host 协议（main ↔ utilityProcess）                          */
/* ================================================================== */

/**
 * driver host 的 RPC 方法表。每个方法的 params / result 在这里一次性定死，
 * 请求与响应类型都从它派生，不存在两边对不上的可能。
 *
 * 注意：**结果数据不走这条通道**。query.run / collection.scan / vector.search
 * 只返回 resultId，真正的 chunk 由 host 通过 MessagePort 直发 renderer。
 */
export interface HostRpcMap {
  connect: {
    params: { connId: ConnId; config: ConnectionConfig; timeoutMs?: number }
    result: { capabilities: Capability[]; serverInfo?: ServerInfo }
  }
  disconnect: {
    params: Record<string, never>
    result: { closed: true }
  }
  ping: {
    params: Record<string, never>
    result: { ok: true; rttMs: number }
  }
  'introspect.children': {
    params: { parentId: string | null; refresh?: boolean }
    result: { nodes: NamespaceNode[] }
  }
  'introspect.describe': {
    params: { ref: CollectionRef }
    result: { schema: CollectionSchemaInfo }
  }
  'query.run': {
    params: {
      resultId: ResultId
      text: string
      params?: unknown[]
      maxRows?: number
      chunkRows?: number
      timeoutMs?: number
    }
    result: { resultId: ResultId }
  }
  'collection.scan': {
    params: {
      resultId: ResultId
      ref: CollectionRef
      filter?: FilterSpec[]
      sort?: SortSpec[]
      columns?: string[]
      offset?: number
      limit?: number
      cursorToken?: string
      chunkRows?: number
      timeoutMs?: number
    }
    result: { resultId: ResultId }
  }
  'vector.search': {
    params: {
      resultId: ResultId
      collection: string
      queryVec?: number[]
      vectorName?: string
      topK: number
      filter?: FilterSpec[]
      withVector?: boolean
      timeoutMs?: number
    }
    result: { resultId: ResultId }
  }
  'keyvalue.get': {
    params: { ref: ValueRef }
    result: { value: KeyValueResult }
  }
  'value.peek': {
    params: { ref: ValueRef; offset?: number; length?: number }
    result: { value: PeekedValue }
  }
  cancel: {
    params: { resultId: ResultId }
    result: { cancelled: boolean }
  }
  shutdown: {
    params: Record<string, never>
    result: { closed: true }
  }
}

export type HostMethod = keyof HostRpcMap
export type HostParams<M extends HostMethod> = HostRpcMap[M]['params']
export type HostResult<M extends HostMethod> = HostRpcMap[M]['result']

/** main → host 请求 */
export interface HostRequestOf<M extends HostMethod> {
  kind: 'req'
  /** 单进程内自增，用来配对响应 */
  rid: number
  method: M
  params: HostParams<M>
}
export type HostRequest = { [M in HostMethod]: HostRequestOf<M> }[HostMethod]

/** host → main 响应 */
export type HostResponseOf<M extends HostMethod> =
  | { kind: 'res'; rid: number; method: M; ok: true; result: HostResult<M> }
  | { kind: 'res'; rid: number; method: M; ok: false; error: PeekError }
export type HostResponse = { [M in HostMethod]: HostResponseOf<M> }[HostMethod]

/**
 * host → main 单向事件（不配对 rid）。
 * 结果集的控制面变化走这里，数据面走 MessagePort。
 */
export type HostEvent =
  /** host 起来了，可以收请求 */
  | { kind: 'evt'; type: 'ready'; pid: number }
  /** 连接状态机变化 */
  | { kind: 'evt'; type: 'status'; status: ConnStatus; error?: PeekError }
  /** 首帧 schema 到手（main 用来填 ResultMeta.schema） */
  | { kind: 'evt'; type: 'result.schema'; resultId: ResultId; schema: ColumnDef[] }
  /** 结果集正常收尾 */
  | { kind: 'evt'; type: 'result.done'; resultId: ResultId; rows: number; elapsedMs: number; truncated?: boolean; nextCursor?: string }
  /**
   * 结果集**按设计暂停**（背压空闲超时）。不是错误：游标已释放，已发出的行全部有效。
   * main 据此把 ResultMeta 打成 status='paused' + truncated + resumable，
   * 绝不能和 result.error 合流（详见 core/chunk.ts 的 ResultPause）。
   */
  | { kind: 'evt'; type: 'result.paused'; resultId: ResultId; paused: ResultPause }
  /** 结果集出错终止 */
  | { kind: 'evt'; type: 'result.error'; resultId: ResultId; error: PeekError }
  /** 进度心跳，用于长查询的行数反馈 */
  | { kind: 'evt'; type: 'result.progress'; resultId: ResultId; rows: number }
  | { kind: 'evt'; type: 'log'; level: NotifyLevel; message: string; detail?: string }

/** host 发出的所有消息 */
export type HostOutbound = HostResponse | HostEvent

/**
 * main 发给 host 的所有消息。
 * `attachPort` 不是 RPC：它随 MessagePort 一起 postMessage 过去，
 * host 收到后把该端口作为数据面出口。
 */
export type HostInbound =
  | HostRequest
  | { kind: 'attachPort'; connId: ConnId }

export function isHostResponse(msg: HostOutbound): msg is HostResponse {
  return msg.kind === 'res'
}

export function isHostEvent(msg: HostOutbound): msg is HostEvent {
  return msg.kind === 'evt'
}

/* ================================================================== */
/* 5. MCP 侧读状态                                                      */
/* ================================================================== */

/** MCP 工具直接读 main 的 Workspace Store，零 renderer 往返（PLAN 第 3 节） */
export interface WorkspaceReader {
  getSnapshot(): WorkspaceSnapshot
}
