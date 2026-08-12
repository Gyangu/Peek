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
import type { InstalledPackages } from './package-manifest'
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

  /**
   * R→M, **synchronously**: what is installed under `~/.peek/packages/`, as data.
   *
   * The window's only route to the driver manifests, the view-kind declarations
   * and the tool declarations, now that none of the three is compiled into its
   * chunk (design 2026-08-07 §1.4, and `drivers/installed.ts` for the shape).
   *
   * **Synchronous, which is the one thing here worth defending.** Everything
   * that reads this reads it during a render or during module initialisation —
   * the connect dialog's field list, the capability prediction that greys out a
   * query button, the package registration that runs before the first paint — and
   * none of those has anywhere to put an `await`. The alternatives were an async
   * fetch with a "packages not known yet" state threaded through every one of
   * them, or a window that paints an empty database picker and fills it a frame
   * later. This blocks the renderer once, in preload, on a main process that
   * built the answer before it created the window: an in-memory object, already
   * parsed, no disk read.
   *
   * It is not a general-purpose channel and must not grow into one. A *change*
   * to what is installed (install, uninstall, upgrade) is a different question
   * with a different shape — it has to reach a window that is already open —
   * and answering it here would mean polling.
   */
  PACKAGES_READ: 'peek:packages:read',

  /**
   * M→R: what is installed *now*, after an install or an uninstall.
   *
   * The other half of `PACKAGES_READ`, and a separate channel because it answers
   * a different question: that one is "what is installed" asked by a window that
   * is still loading, this one is "it changed" told to a window that is already
   * open. Design §2.4 asks for exactly this pair — one read command plus a
   * broadcast that follows the package set — and the note above says why the
   * synchronous read cannot grow into it (a window would have to poll).
   *
   * The body is the whole `InstalledPackages`, not a delta. It is three small
   * lists that change when a person clicks a button, and a delta would mean the
   * window applying an edit to a registry it can only replace wholesale
   * (`installPackages` in `drivers/installed.ts` refuses to merge, deliberately:
   * a merge keeps a package alive across its own uninstall).
   */
  PACKAGES_CHANGED: 'peek:packages:changed',

  /**
   * R→M: open the native directory chooser, and answer with what was picked.
   *
   * `packages.install` takes an absolute path and a window has none. The DOM
   * cannot supply one either — a `<input type="file" webkitdirectory>` yields
   * relative entry names, and the absolute path behind them is only reachable
   * through a main-world Electron API. So the picker itself runs in main.
   *
   * **Not a command**, for the reason `MENU_ACTION` next door is not one: what
   * crosses is a piece of window chrome, not a change to the source of truth.
   * Cancelling a file dialog is not an action anybody should find in the command
   * log; the `packages.install` that may follow it is, and that one goes through
   * the bus like everything else. Design §2.8(c).
   */
  PACKAGES_PICK_DIR: 'peek:packages:pickDir',

  /** M→R: immer patch broadcast */
  STATE_PATCH: 'peek:state:patch',
  /** M→R: hand over a connection's MessagePort (the port arrives as event.ports[0]) */
  RESULT_PORT: 'peek:result:port',
  /** M→R: non-state notifications (toasts, driver-crash notices, …) */
  NOTIFY: 'peek:notify',

  /**
   * M→R: the user picked an item in the application menu.
   *
   * The menu lives in main and the surfaces it drives live in the renderer, so
   * something has to cross. This channel exists rather than a Command because
   * what crosses is not a change to the source of truth — `Settings…` opens a
   * dialog, which is window chrome the Workspace deliberately knows nothing
   * about (see `renderer/state/settingsDialogStore.ts`).
   *
   * Not folded into NOTIFY, which is next door and also M→R: a NotifyMessage is
   * "show the user this sentence" and the renderer answers it with a toast.
   * See `docs/design/2026-08-04-settings-into-app-menu.md` §2.2.
   */
  MENU_ACTION: 'peek:menu:action',

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

  /**
   * R→M: "I have nothing for this conversation — send it again."
   *
   * CHAT_DELTA is append-only and fire-and-forget, which is right for a stream
   * and wrong for a listener that started late. A renderer that reloads keeps
   * its Workspace (it re-aligns through STATE_SNAPSHOT) but its transcript
   * mirror starts empty, and nothing re-sends: main is still holding the
   * session, so no `session.open` fires and no delta is ever repeated. The tab,
   * the title and the message count all come back; the conversation does not.
   *
   * This is the transcript's equivalent of STATE_SNAPSHOT, with one deliberate
   * difference — it resolves to nothing. The conversation comes back over
   * CHAT_DELTA like any other, so a restored transcript and a live one travel
   * the same path and the renderer cannot tell them apart. See
   * `docs/design/2026-08-03-chat-history-ownership.md` §2.4.
   */
  CHAT_RESTORE: 'peek:chat:restore',
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

/**
 * One application-menu item was chosen.
 *
 * A tagged union of one member, on purpose: the next menu item that has to
 * reach the renderer adds a variant here instead of a channel next door, and
 * the renderer's `applyMenuAction` gets a compile error until it handles it.
 */
export interface MenuActionMessage {
  action: 'openSettings'
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
  /**
   * Whether preload's main-world bootstrap succeeded.
   *
   * `'degraded'` means the control plane is intact and the data plane does not
   * exist: commands run, patches arrive, the tree expands — and query results
   * never come, because `onResultPort` can only receive a MessagePort from
   * main-world code. Required rather than optional so both preload paths have to
   * answer; a silent third path is exactly how this went unnoticed before.
   */
  dataPlane: 'ok' | 'degraded'

  invoke<K extends CommandName>(
    name: K,
    input: CommandInput<K>,
    source?: CommandSource,
  ): Promise<CommandResultFor<K>>

  getSnapshot(): Promise<StateSnapshotMessage>

  /**
   * The installed packages, as data, fetched by preload before this object
   * existed.
   *
   * A property rather than a method, and that is the contract: preload has
   * already asked (`IPC.PACKAGES_READ`, synchronously), so a reader cannot end up
   * holding a promise on a path that has no room for one. Required, and answered
   * on the degraded preload path too — a window that cannot list databases is not
   * a window with a degraded data plane, it is a window with no connect dialog.
   */
  installedPackages: InstalledPackages

  /**
   * What is installed changed — a package was installed or uninstalled.
   *
   * Required rather than optional, on the same grounds as `onMenuAction`: it is
   * one `ipcRenderer.on` with no main world involved, so a degraded data plane is
   * no reason for it to be missing, and a window that silently kept a stale
   * driver list would offer a database peek can no longer open. The handler
   * receives the complete registry, which replaces the one `installedPackages`
   * seeded.
   */
  onPackagesChanged(handler: (installed: InstalledPackages) => void): () => void

  /**
   * Ask the user for a package directory; `null` means they cancelled.
   *
   * Required rather than optional, on the same grounds as `onMenuAction` and
   * `onPackagesChanged`: it is one `ipcRenderer.invoke` with no main world
   * involved, so a degraded data plane is no reason for it to be missing. A
   * feature-detected picker would give the settings panel an "Install…" button
   * that silently does nothing on exactly the launches that are already broken.
   *
   * It does **not** install. The path comes back, the window sends
   * `packages.install`, and the refusals arrive in that command's receipt — see
   * `IPC.PACKAGES_PICK_DIR` for why the two halves are not one call.
   */
  pickPackageDir(): Promise<string | null>

  onPatch(handler: (msg: StatePatchMessage) => void): () => void

  /** A connection's data-plane port arrived; the renderer receives ResultStreamMessage on it and replies with ResultStreamAck */
  onResultPort(handler: (msg: ResultPortMessage, port: MessagePort) => void): () => void

  onNotify(handler: (msg: NotifyMessage) => void): () => void

  /**
   * An application-menu item was chosen (macOS `peek → Settings…` today).
   *
   * Required, not optional, and implemented on the degraded preload path too:
   * it is one `ipcRenderer.on` with no main world involved, so there is nothing
   * about it for a failed data-plane bootstrap to take down. A window whose
   * menu item silently does nothing is worse than one without the item.
   */
  onMenuAction(handler: (msg: MenuActionMessage) => void): () => void

  /* ---------------- Read-only, non-command channel ---------------- */
  /*
   * The members below are **optional** so that a preload which does not
   * implement them still satisfies this contract; the renderer feature-detects
   * and degrades its UI (the tree explains itself, a large value shows its
   * preview) rather than dereferencing them blindly.
   *
   * They are *not* what the degraded bootstrap loses. Each is a plain
   * `ipcRenderer.invoke` and needs no main world, so peek's own fallback path
   * implements all of them. The one casualty of `dataPlane: 'degraded'` is
   * `onResultPort` above.
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

  /**
   * Ask main to re-deliver one conversation, for a mirror that started empty.
   *
   * Resolves when main has *dispatched* the transcript, not when the renderer
   * has applied it — the messages arrive over `onChatDelta` like everything
   * else. `false` means main has nothing for that conversation, which is an
   * answer ("this really is empty") and not a failure.
   *
   * Optional and feature-detected, like the members above.
   */
  restoreChat?(chatId: ChatId): Promise<boolean>
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
