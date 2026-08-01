import type { Patch } from 'immer'
import type {
  Capability,
  CollectionRef,
  CollectionSchemaInfo,
  ConnectionConfig,
  FilterSpec,
  KeyValueResult,
  KeyValueWindow,
  NamespaceNode,
  PeekedValue,
  ServerInfo,
  SortSpec,
  ValueRef,
} from './capability'
import type { ChatDelta } from './chat'
import type { ColumnDef, ResultPause } from './chunk'
import type { CommandInput, CommandName, CommandResultFor, CommandSource } from './commands'
import type { PeekError } from './errors'
import type { ChatId, ConnId, ResultId, ViewId } from './ids'
import type { ConnStatus, Workspace, WorkspaceSnapshot } from './workspace'

/* ================================================================== */
/* 0. Constants                                                        */
/* ================================================================== */

/** Default MCP Streamable HTTP endpoint (PLAN §7) */
export const MCP_DEFAULT_HOST = '127.0.0.1'
export const MCP_DEFAULT_PORT = 7332
export const MCP_HTTP_PATH = '/mcp'
/** Token and port are written to ~/.peek/mcp.json */
export const PEEK_CONFIG_DIR_NAME = '.peek'
export const MCP_CONFIG_FILE_NAME = 'mcp.json'

/** Key under which preload exposes the bridge on `window` */
export const PEEK_BRIDGE_KEY = 'peek' as const

/* ================================================================== */
/* 1. IPC channel names                                                */
/* ================================================================== */

/**
 * Every channel name lives here; hard-coding one anywhere else is forbidden.
 * Direction markers:
 *   R→M  renderer → main (ipcRenderer.invoke)
 *   M→R  main → renderer (webContents.send)
 */
export const IPC = {
  /** R→M: execute one Command, returns a CommandResult */
  COMMAND_INVOKE: 'peek:command:invoke',
  /** R→M: fetch a full Workspace snapshot (on renderer startup, or after spotting a gap in `rev`) */
  STATE_SNAPSHOT: 'peek:state:snapshot',

  /** M→R: immer patch broadcast */
  STATE_PATCH: 'peek:state:patch',
  /** M→R: hand over a connection's MessagePort (the port arrives as event.ports[0]) */
  RESULT_PORT: 'peek:result:port',
  /** M→R: non-state notifications (toasts, driver-crash notices, …) */
  NOTIFY: 'peek:notify',

  /**
   * R→M: read-only RPC that is not a command (lazy-loading the namespace tree /
   * fetching a large value in full / reading a keyValue).
   *
   * None of these three appear in the command table of PLAN §6, though the driver
   * host's HostRpcMap has them. They **do not change Workspace state** — neither a
   * tree node nor a single value ever enters the source of truth — so modelling
   * them as commands would be wrong. They take this separate read-only channel,
   * which main forwards to the connection's driver host.
   */
  DRIVER_RPC: 'peek:driver:rpc',

  /**
   * M→R: ask the renderer for the first N rows cached for a result set.
   *
   * Chunks travel the data plane straight from the driver host to the renderer over
   * a MessagePort, so **main holds no row data at all** — yet MCP's run_query owes
   * the AI a few sample rows. The only way to get them is to sample the renderer in
   * the opposite direction.
   */
  RESULT_ROWS_REQUEST: 'peek:result:rows:request',
  /** R→M: the reply to RESULT_ROWS_REQUEST, paired by requestId */
  RESULT_ROWS_REPLY: 'peek:result:rows:reply',

  /**
   * M→R: append-only chat transcript deltas, already batched by main.
   *
   * The second data-plane channel, and it exists for the same reason
   * RESULT_PORT does: `packages/core/src/chat.ts` keeps the transcript out of
   * the Workspace, because a token-by-token stream routed through immer diffing
   * and patch broadcast would bump `rev` hundreds of times a turn, slow every
   * unrelated command as the conversation grows, and stuff the whole
   * conversation into every `read_workspace` reply.
   *
   * The renderer still invents nothing: it projects a delta stream main
   * authored, exactly as it projects the patch stream main authored. Only the
   * transport differs — not who decides.
   */
  CHAT_DELTA: 'peek:chat:delta',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/* ================================================================== */
/* 2. main ↔ renderer message bodies                                   */
/* ================================================================== */

export interface CommandInvokeMessage<K extends CommandName = CommandName> {
  name: K
  input: CommandInput<K>
  source: CommandSource
  /** Correlation id minted by the renderer, useful for local de-duplication; main mints one when absent */
  commandId?: string
}

/**
 * State-patch broadcast. The renderer's mirror store applies these in strict `rev`
 * order; if an incoming `fromRev` does not follow the local `rev`, it must
 * re-align through STATE_SNAPSHOT.
 */
export interface StatePatchMessage {
  /** `rev` before applying */
  fromRev: number
  /** `rev` after applying */
  rev: number
  patches: Patch[]
  /** The command that produced this batch of patches */
  commandId?: string
  commandName?: CommandName
}

export interface StateSnapshotMessage {
  rev: number
  workspace: Workspace
}

/** MessagePort handover: the port itself rides on Electron's event.ports, not in this body */
export interface ResultPortMessage {
  connId: ConnId
  /** Pid of the driver host, handy when debugging */
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
/* 2b. Read-only RPC that is not a command                             */
/*     (renderer ↔ main ↔ driver host)                                 */
/* ================================================================== */

/**
 * A read-only RPC issued by the renderer. How it differs from a Command:
 * it **changes no state, is not written to the command log, and broadcasts no
 * patch** — it just carries one driver-host answer back verbatim (a tree's
 * children / a large value in full / a typed redis read).
 */
export type DriverRpcRequest =
  | { kind: 'introspect'; connId: ConnId; parentId: string | null; refresh?: boolean }
  | { kind: 'peekValue'; connId: ConnId; ref: ValueRef; range?: { offset: number; length: number } }
  /** `window` pages a large structure; omitted means the driver's default first window */
  | { kind: 'keyValue'; connId: ConnId; ref: ValueRef; window?: KeyValueWindow }

/**
 * `KeyValueWindow` — the serializable half of a read window — is declared in
 * capability.ts, next to the `KeyValueReadOptions` union it validates into, and
 * re-exported through the package barrel. It is deliberately *not*
 * `Omit<KeyValueReadOptions, 'signal'>`: an Omit over a union collapses to the
 * fields the members have in common, which for that union is `limit` alone.
 */
export type { KeyValueWindow } from './capability'

export type DriverRpcKind = DriverRpcRequest['kind']

export interface DriverRpcResultMap {
  introspect: NamespaceNode[]
  peekValue: PeekedValue
  keyValue: KeyValueResult
}

/** Response envelope for a read-only RPC: errors always collapse to a PeekError — a raw Error is never thrown across IPC */
export type DriverRpcResponse<K extends DriverRpcKind = DriverRpcKind> =
  | { ok: true; data: DriverRpcResultMap[K] }
  | { ok: false; error: PeekError }

/* ------------------------------------------------------------------ */
/* Result-set sampling (main → renderer)                               */
/* ------------------------------------------------------------------ */

export interface ResultRowsRequestMessage {
  /** Pairs the reply to this request; minted by main */
  requestId: string
  resultId: ResultId
  /** How many rows at most */
  limit: number
}

export type ResultRowsReplyMessage =
  | {
      requestId: string
      ok: true
      columns: ColumnDef[]
      /** Row-major (each row ordered like `columns`), already cut to `limit` */
      rows: unknown[][]
      /** Total rows known for this result set (while still running, the count received so far) */
      totalRows: number
      /** Cut short by `limit` (more rows exist than were returned) */
      truncated: boolean
    }
  | { requestId: string; ok: false; error: PeekError }

/* ------------------------------------------------------------------ */
/* Chat transcript (main → renderer)                                   */
/* ------------------------------------------------------------------ */

/**
 * One flush of transcript deltas for a single conversation.
 *
 * `deltas` is a batch, not a single event: main coalesces on a time and size
 * budget before it crosses IPC (see `DEFAULT_DELTA_BUDGET`), so the common case
 * is a phrase rather than a character. The renderer applies them in order.
 */
export interface ChatDeltaMessage {
  chatId: ChatId
  deltas: ChatDelta[]
}

/* ================================================================== */
/* 3. The narrow bridge preload exposes to the renderer                */
/* ================================================================== */

/**
 * Preload exposes this object and nothing else; the renderer never gets hold of
 * `ipcRenderer` itself. Every `on*` returns an unsubscribe function.
 */
export interface PeekBridge {
  invoke<K extends CommandName>(
    name: K,
    input: CommandInput<K>,
    source?: CommandSource,
  ): Promise<CommandResultFor<K>>

  getSnapshot(): Promise<StateSnapshotMessage>

  onPatch(handler: (msg: StatePatchMessage) => void): () => void

  /** A connection's data-plane port arrived; the renderer receives ResultStreamMessage on it and replies with ResultStreamAck */
  onResultPort(handler: (msg: ResultPortMessage, port: MessagePort) => void): () => void

  onNotify(handler: (msg: NotifyMessage) => void): () => void

  /* ---------------- Read-only, non-command channel ---------------- */
  /*
   * The members below are **optional**: if preload's main-world bootstrap has to
   * degrade (executeInMainWorld unavailable), only the control plane works. The
   * renderer must feature-detect at runtime and degrade its UI when they are
   * missing — never dereference them blindly.
   */

  /** Lazy-load the namespace tree; maps to HostRpcMap['introspect.children'] */
  introspect?(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>

  /** Fetch a large value in full or by range; maps to HostRpcMap['value.peek'] */
  peekValue?(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>

  /** Read a typed value by key; maps to HostRpcMap['keyvalue.get'] */
  getKeyValue?(connId: ConnId, ref: ValueRef, window?: KeyValueWindow): Promise<KeyValueResult>

  /** Main asks this renderer for sample rows of a result set; the handler is responsible for replying */
  onResultRowsRequest?(
    handler: (msg: ResultRowsRequestMessage) => void,
  ): () => void

  /** Reply to onResultRowsRequest */
  replyResultRows?(msg: ResultRowsReplyMessage): void

  /**
   * Transcript deltas for every open conversation, batched by main.
   *
   * The handler receives one conversation's batch at a time; every `ChatDelta`
   * names its own `chatId`, so the batch needs no envelope once it is across.
   * Optional like the members above, and the chat panel feature-detects it:
   * without this channel it says plainly that the transcript is not connected
   * rather than showing an empty conversation that looks like a working one.
   */
  onChatDelta?(handler: (deltas: ChatDelta[]) => void): () => void
}

declare global {
  interface Window {
    /** Injected by preload under the key in PEEK_BRIDGE_KEY. Do not re-declare this in the renderer. */
    readonly peek: PeekBridge
  }
}

/* ================================================================== */
/* 4. Driver-host protocol (main ↔ utilityProcess)                     */
/* ================================================================== */

/**
 * RPC method table of the driver host. Each method's params and result are pinned
 * down here once, and both the request and response types derive from it, so the
 * two ends cannot disagree.
 *
 * Note: **result data does not travel this channel**. query.run / collection.scan /
 * vector.search return only a resultId; the chunks themselves go straight from the
 * host to the renderer over a MessagePort.
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
      /** Driver-native filter, ANDed with `filter`; see CollectionScanRequest.nativeFilter */
      nativeFilter?: unknown
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
      /** Search by an existing point instead of a literal vector */
      queryPointId?: string | number
      vectorName?: string
      topK: number
      filter?: FilterSpec[]
      nativeFilter?: unknown
      scoreThreshold?: number
      offset?: number
      /** Payload keys to flatten into columns; omitted keeps one json `payload` column */
      columns?: string[]
      withVector?: boolean
      withPayload?: boolean
      timeoutMs?: number
    }
    result: { resultId: ResultId }
  }
  'keyvalue.get': {
    /**
     * `ref` plus the flat `KeyValueWindow`. It stays flat across the boundary
     * because a process boundary is where types stop being enforced; the host
     * validates it into the `KeyValueReadOptions` union on arrival.
     */
    params: KeyValueWindow & { ref: ValueRef }
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

/** main → host request */
export interface HostRequestOf<M extends HostMethod> {
  kind: 'req'
  /** Incremented within one process; pairs a response to its request */
  rid: number
  method: M
  params: HostParams<M>
}
export type HostRequest = { [M in HostMethod]: HostRequestOf<M> }[HostMethod]

/** host → main response */
export type HostResponseOf<M extends HostMethod> =
  | { kind: 'res'; rid: number; method: M; ok: true; result: HostResult<M> }
  | { kind: 'res'; rid: number; method: M; ok: false; error: PeekError }
export type HostResponse = { [M in HostMethod]: HostResponseOf<M> }[HostMethod]

/**
 * One-way host → main events (no `rid` to pair with).
 * A result set's control-plane changes travel here; its data plane goes over the
 * MessagePort.
 */
export type HostEvent =
  /** The host is up and accepting requests */
  | { kind: 'evt'; type: 'ready'; pid: number }
  /** Connection state machine changed */
  | { kind: 'evt'; type: 'status'; status: ConnStatus; error?: PeekError }
  /** The first frame's schema arrived (main uses it to fill ResultMeta.schema) */
  | { kind: 'evt'; type: 'result.schema'; resultId: ResultId; schema: ColumnDef[] }
  /** The result set finished normally */
  | { kind: 'evt'; type: 'result.done'; resultId: ResultId; rows: number; elapsedMs: number; truncated?: boolean; nextCursor?: string }
  /**
   * The result set **paused by design** (backpressure idle timeout). Not an error:
   * the cursor has been released and every row already emitted is valid. Main turns
   * this into ResultMeta with status='paused' + truncated + resumable, and it must
   * never be merged into result.error — see ResultPause in core/chunk.ts.
   */
  | { kind: 'evt'; type: 'result.paused'; resultId: ResultId; paused: ResultPause }
  /** The result set terminated with an error */
  | { kind: 'evt'; type: 'result.error'; resultId: ResultId; error: PeekError }
  /** Progress heartbeat, so a long query can report its row count */
  | { kind: 'evt'; type: 'result.progress'; resultId: ResultId; rows: number }
  | { kind: 'evt'; type: 'log'; level: NotifyLevel; message: string; detail?: string }

/** Everything a host can send */
export type HostOutbound = HostResponse | HostEvent

/**
 * Everything main can send to a host.
 * `attachPort` is not an RPC: it is postMessage'd together with the MessagePort,
 * and the host adopts that port as its data-plane outlet.
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
/* 5. State reads on the MCP side                                      */
/* ================================================================== */

/** MCP tools read main's Workspace store directly, with no renderer round-trip (PLAN §3) */
export interface WorkspaceReader {
  getSnapshot(): WorkspaceSnapshot
}
