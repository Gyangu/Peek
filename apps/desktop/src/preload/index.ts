import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Runtime constants must come **directly** from core's ipc.ts: that module has
// no runtime dependencies, whereas the '@peek/core' barrel drags zod in — and a
// sandboxed preload cannot require third-party packages.
// Type-only imports from '@peek/core' are fine; they vanish at compile time.
import { IPC, PEEK_BRIDGE_KEY } from '../../../../packages/core/src/ipc'
import type {
  ChatDeltaMessage,
  DriverRpcRequest,
  DriverRpcResponse,
  KeyValueWindow,
  NotifyMessage,
  PeekBridge,
  ResultPortMessage,
  ResultRowsReplyMessage,
  ResultRowsRequestMessage,
  StatePatchMessage,
  StateSnapshotMessage,
} from '../../../../packages/core/src/ipc'
import type {
  ChatDelta,
  CommandInput,
  CommandName,
  CommandResultFor,
  CommandSource,
  ConnId,
  KeyValueResult,
  NamespaceNode,
  PeekedValue,
  ValueRef,
} from '@peek/core'

/**
 * The narrow preload bridge.
 *
 * Security baseline: contextIsolation and sandbox are both on, and **ipcRenderer
 * itself is never exposed** — the renderer sees only the methods on PeekBridge.
 *
 * About MessagePort (measured, do not revert):
 *   contextBridge copies a MessagePort into a plain object, and what the main
 *   world receives does not even have start(), which kills the data plane
 *   outright. Ports must therefore be transferred the way Electron officially
 *   recommends, `window.postMessage(msg, '*', [port])`, and the receiver **must
 *   be main-world code**. That is why window.peek itself is assembled in the main
 *   world by executeInMainWorld, and contextBridge only carries the clone-safe
 *   part (invoke / patch / notify).
 */

/**
 * The internal key shared between preload and the main-world bootstrap.
 * Properties installed by contextBridge cannot be deleted, so this one is visible
 * in the main world; it exposes exactly the same capabilities as window.peek
 * (the same ipcRenderer wrappers), so it grants no extra privilege.
 */
const INTERNAL_KEY = '__peekPreloadInternal'
/** Discriminator key on a port-handover message */
const PORT_RELAY_KEY = '__peekResultPort'

type Unsubscribe = () => void

/** contextBridge carries only these clone-safe capabilities */
interface InternalBridge {
  invoke(name: string, input: unknown, source?: string): Promise<unknown>
  getSnapshot(): Promise<StateSnapshotMessage>
  onPatch(handler: (msg: StatePatchMessage) => void): Unsubscribe
  onNotify(handler: (msg: NotifyMessage) => void): Unsubscribe
  /** Non-command read-only RPCs: introspect / peekValue / keyValue */
  driverRpc(req: DriverRpcRequest): Promise<DriverRpcResponse>
  onResultRowsRequest(handler: (msg: ResultRowsRequestMessage) => void): Unsubscribe
  replyResultRows(msg: ResultRowsReplyMessage): void
  /** Chat transcript data plane; the envelope is unwrapped to plain deltas here. */
  onChatDelta(handler: (deltas: ChatDelta[]) => void): Unsubscribe
}

const internal: InternalBridge = {
  invoke(name, input, source) {
    return ipcRenderer.invoke(IPC.COMMAND_INVOKE, { name, input, source: source ?? 'ui' })
  },
  getSnapshot() {
    return ipcRenderer.invoke(IPC.STATE_SNAPSHOT) as Promise<StateSnapshotMessage>
  },
  onPatch(handler) {
    const listener = (_event: IpcRendererEvent, msg: StatePatchMessage): void => {
      handler(msg)
    }
    ipcRenderer.on(IPC.STATE_PATCH, listener)
    return () => {
      ipcRenderer.off(IPC.STATE_PATCH, listener)
    }
  },
  onNotify(handler) {
    const listener = (_event: IpcRendererEvent, msg: NotifyMessage): void => {
      handler(msg)
    }
    ipcRenderer.on(IPC.NOTIFY, listener)
    return () => {
      ipcRenderer.off(IPC.NOTIFY, listener)
    }
  },
  driverRpc(req) {
    return ipcRenderer.invoke(IPC.DRIVER_RPC, req) as Promise<DriverRpcResponse>
  },
  onResultRowsRequest(handler) {
    const listener = (_event: IpcRendererEvent, msg: ResultRowsRequestMessage): void => {
      handler(msg)
    }
    ipcRenderer.on(IPC.RESULT_ROWS_REQUEST, listener)
    return () => {
      ipcRenderer.off(IPC.RESULT_ROWS_REQUEST, listener)
    }
  },
  replyResultRows(msg) {
    ipcRenderer.send(IPC.RESULT_ROWS_REPLY, msg)
  },
  onChatDelta(handler) {
    const listener = (_event: IpcRendererEvent, msg: ChatDeltaMessage): void => {
      handler(msg.deltas)
    }
    ipcRenderer.on(IPC.CHAT_DELTA, listener)
    return () => {
      ipcRenderer.off(IPC.CHAT_DELTA, listener)
    }
  },
}

/**
 * Assemble window.peek in place, inside the main world.
 *
 * **This function is serialized and executed in a different world**: it may
 * reference only its own parameters and globals, never a closure variable. Type
 * annotations are fine — they are compiled away.
 */
function bootstrapMainWorld(internalKey: string, relayKey: string, bridgeKey: string): boolean {
  const globals = window as unknown as Record<string, unknown>
  const bridge = globals[internalKey] as InternalBridge | undefined
  if (!bridge) return false

  type PortHandler = (msg: ResultPortMessage, port: MessagePort) => void
  const handlers = new Set<PortHandler>()
  // A port may arrive before the renderer registers its handler; buffer it and replay
  const pending: { msg: ResultPortMessage; port: MessagePort }[] = []

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as Record<string, unknown> | null
    if (data === null || typeof data !== 'object' || !(relayKey in data)) return
    const port = event.ports[0]
    if (!port) return
    const msg = data[relayKey] as ResultPortMessage
    if (handlers.size === 0) {
      pending.push({ msg, port })
      return
    }
    for (const handler of handlers) handler(msg, port)
  })

  // Unwrap the read-only RPC response envelope here: on ok hand back the data,
  // otherwise throw an Error carrying the original message, which the renderer
  // turns into a toast. The PeekError itself is not rethrown, so callers never
  // have to reach for instanceof.
  async function unwrap<T>(promise: Promise<DriverRpcResponse>): Promise<T> {
    const res = await promise
    if (res.ok) return res.data as T
    const err = new Error(res.error.message)
    err.name = res.error.code
    throw err
  }

  const api: PeekBridge = {
    invoke<K extends CommandName>(
      name: K,
      input: CommandInput<K>,
      source?: CommandSource,
    ): Promise<CommandResultFor<K>> {
      return bridge.invoke(name, input, source) as Promise<CommandResultFor<K>>
    },
    getSnapshot() {
      return bridge.getSnapshot()
    },
    onPatch(handler) {
      return bridge.onPatch(handler)
    },
    onResultPort(handler) {
      handlers.add(handler)
      while (pending.length > 0) {
        const item = pending.shift()
        if (item) handler(item.msg, item.port)
      }
      return () => {
        handlers.delete(handler)
      }
    },
    onNotify(handler) {
      return bridge.onNotify(handler)
    },

    introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> {
      return unwrap<NamespaceNode[]>(
        bridge.driverRpc({
          kind: 'introspect',
          connId,
          parentId,
          ...(refresh === undefined ? {} : { refresh }),
        }),
      )
    },
    peekValue(
      connId: ConnId,
      ref: ValueRef,
      range?: { offset: number; length: number },
    ): Promise<PeekedValue> {
      return unwrap<PeekedValue>(
        bridge.driverRpc({ kind: 'peekValue', connId, ref, ...(range === undefined ? {} : { range }) }),
      )
    },
    getKeyValue(connId: ConnId, ref: ValueRef, window?: KeyValueWindow): Promise<KeyValueResult> {
      return unwrap<KeyValueResult>(
        bridge.driverRpc({
          kind: 'keyValue',
          connId,
          ref,
          ...(window === undefined ? {} : { window }),
        }),
      )
    },

    onResultRowsRequest(handler) {
      return bridge.onResultRowsRequest(handler)
    },
    replyResultRows(msg) {
      bridge.replyResultRows(msg)
    },
    onChatDelta(handler) {
      return bridge.onChatDelta(handler)
    },
  }

  Object.defineProperty(window, bridgeKey, {
    value: Object.freeze(api),
    enumerable: true,
    writable: false,
    configurable: false,
  })
  return true
}

contextBridge.exposeInMainWorld(INTERNAL_KEY, internal)

let bootstrapped = false
try {
  bootstrapped =
    contextBridge.executeInMainWorld({
      func: bootstrapMainWorld,
      args: [INTERNAL_KEY, PORT_RELAY_KEY, PEEK_BRIDGE_KEY],
    }) === true
} catch (error) {
  bootstrapped = false
  console.error('[peek/preload] main-world bootstrap failed; the data-plane port will be unavailable', error)
}

if (!bootstrapped) {
  // Degraded path: at least keep the control plane usable (commands + patches +
  // read-only RPC). On this path onResultPort never gets a usable MessagePort —
  // see the note at the top of this file.
  const unwrapFallback = async <T,>(promise: Promise<DriverRpcResponse>): Promise<T> => {
    const res = await promise
    if (res.ok) return res.data as T
    const err = new Error(res.error.message)
    err.name = res.error.code
    throw err
  }

  const fallback: PeekBridge = {
    invoke<K extends CommandName>(
      name: K,
      input: CommandInput<K>,
      source?: CommandSource,
    ): Promise<CommandResultFor<K>> {
      return internal.invoke(name, input, source) as Promise<CommandResultFor<K>>
    },
    getSnapshot: () => internal.getSnapshot(),
    onPatch: (handler) => internal.onPatch(handler),
    onNotify: (handler) => internal.onNotify(handler),
    onResultPort: () => () => {
      // No port channel is available here
    },
    introspect: (connId, parentId, refresh) =>
      unwrapFallback<NamespaceNode[]>(
        internal.driverRpc({
          kind: 'introspect',
          connId,
          parentId,
          ...(refresh === undefined ? {} : { refresh }),
        }),
      ),
    peekValue: (connId, ref, range) =>
      unwrapFallback<PeekedValue>(
        internal.driverRpc({ kind: 'peekValue', connId, ref, ...(range === undefined ? {} : { range }) }),
      ),
    getKeyValue: (connId, ref, window) =>
      unwrapFallback<KeyValueResult>(
        internal.driverRpc({
          kind: 'keyValue',
          connId,
          ref,
          ...(window === undefined ? {} : { window }),
        }),
      ),
    onResultRowsRequest: (handler) => internal.onResultRowsRequest(handler),
    replyResultRows: (msg) => {
      internal.replyResultRows(msg)
    },
    onChatDelta: (handler) => internal.onChatDelta(handler),
  }

  contextBridge.exposeInMainWorld(PEEK_BRIDGE_KEY, fallback)
}

// Port handover: as soon as ipcRenderer receives one it is relayed to the main
// world, and preload never holds on to it. Result chunks therefore travel
// driver host → renderer directly, through neither main nor preload.
ipcRenderer.on(IPC.RESULT_PORT, (event: IpcRendererEvent, msg: ResultPortMessage) => {
  const port = event.ports[0]
  if (!port) return
  window.postMessage({ [PORT_RELAY_KEY]: msg }, '*', [port])
})
