import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// 运行时常量只能从 core 的 ipc.ts **直接**取：ipc.ts 没有任何运行时依赖，
// 而 '@peek/core' 桶文件会把 zod 带进来 —— sandbox 里的 preload 不能 require 第三方包。
// 纯类型的 import type 走 '@peek/core' 无所谓（编译期就被抹掉了）。
import { IPC, PEEK_BRIDGE_KEY } from '../../../../packages/core/src/ipc'
import type {
  DriverRpcRequest,
  DriverRpcResponse,
  NotifyMessage,
  PeekBridge,
  ResultPortMessage,
  ResultRowsReplyMessage,
  ResultRowsRequestMessage,
  StatePatchMessage,
  StateSnapshotMessage,
} from '../../../../packages/core/src/ipc'
import type {
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
 * preload 窄桥。
 *
 * 安全基线：contextIsolation + sandbox 全开，**绝不把 ipcRenderer 本体暴露出去**，
 * renderer 只能看到 PeekBridge 上的五个方法。
 *
 * 关于 MessagePort（实测结论，别改回去）：
 *   contextBridge 会把 MessagePort 复制成一个普通对象，主世界拿到的东西
 *   连 start() 都没有，数据面直接废掉。所以端口必须走 Electron 官方推荐的
 *   `window.postMessage(msg, '*', [port])` 移交，而接收方**必须是主世界的代码**。
 *   为此 window.peek 本体由 executeInMainWorld 在主世界里就地创建，
 *   contextBridge 只用来传 clone 安全的那部分（invoke / patch / notify）。
 */

/**
 * preload ↔ 主世界引导之间的内部键。
 * contextBridge 挂上去的属性不可 delete，所以它在主世界里是可见的；
 * 但它暴露的能力与 window.peek 完全相同（同一批 ipcRenderer 包装），不构成额外权限。
 */
const INTERNAL_KEY = '__peekPreloadInternal'
/** 端口移交消息的判别键 */
const PORT_RELAY_KEY = '__peekResultPort'

type Unsubscribe = () => void

/** contextBridge 只承载这些 clone 安全的能力 */
interface InternalBridge {
  invoke(name: string, input: unknown, source?: string): Promise<unknown>
  getSnapshot(): Promise<StateSnapshotMessage>
  onPatch(handler: (msg: StatePatchMessage) => void): Unsubscribe
  onNotify(handler: (msg: NotifyMessage) => void): Unsubscribe
  /** 非命令类只读 RPC：introspect / peekValue / keyValue */
  driverRpc(req: DriverRpcRequest): Promise<DriverRpcResponse>
  onResultRowsRequest(handler: (msg: ResultRowsRequestMessage) => void): Unsubscribe
  replyResultRows(msg: ResultRowsReplyMessage): void
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
}

/**
 * 在主世界里就地组装 window.peek。
 *
 * **这个函数会被序列化后在另一个 world 里执行**：
 * 只能引用自己的参数和全局对象，不许有任何闭包引用（类型注解无所谓，会被编译掉）。
 */
function bootstrapMainWorld(internalKey: string, relayKey: string, bridgeKey: string): boolean {
  const globals = window as unknown as Record<string, unknown>
  const bridge = globals[internalKey] as InternalBridge | undefined
  if (!bridge) return false

  type PortHandler = (msg: ResultPortMessage, port: MessagePort) => void
  const handlers = new Set<PortHandler>()
  // 端口可能先于 renderer 注册回调到达，先兜住再补发
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

  // 只读 RPC 的应答信封在这里拆开：ok 就给数据，否则抛一个带原始 message 的 Error，
  // renderer 侧统一转 toast。PeekError 本体不往上抛，避免调用方去 instanceof。
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
    getKeyValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult> {
      return unwrap<KeyValueResult>(bridge.driverRpc({ kind: 'keyValue', connId, ref }))
    },

    onResultRowsRequest(handler) {
      return bridge.onResultRowsRequest(handler)
    },
    replyResultRows(msg) {
      bridge.replyResultRows(msg)
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
  console.error('[peek/preload] 主世界引导失败，数据面端口将不可用', error)
}

if (!bootstrapped) {
  // 退化路径：至少让控制面（命令 + patch + 只读 RPC）能用；
  // onResultPort 在这条路径上拿不到可用的 MessagePort，见文件头说明。
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
      // 无可用端口通道
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
    getKeyValue: (connId, ref) =>
      unwrapFallback<KeyValueResult>(internal.driverRpc({ kind: 'keyValue', connId, ref })),
    onResultRowsRequest: (handler) => internal.onResultRowsRequest(handler),
    replyResultRows: (msg) => {
      internal.replyResultRows(msg)
    },
  }

  contextBridge.exposeInMainWorld(PEEK_BRIDGE_KEY, fallback)
}

// 端口移交：ipcRenderer 收到后立刻转交主世界，preload 自己不持有端口，
// 结果 chunk 因此是 driver host → renderer 直连，不经过 main 也不经过 preload。
ipcRenderer.on(IPC.RESULT_PORT, (event: IpcRendererEvent, msg: ResultPortMessage) => {
  const port = event.ports[0]
  if (!port) return
  window.postMessage({ [PORT_RELAY_KEY]: msg }, '*', [port])
})
