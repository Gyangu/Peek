import type {
  ConnId,
  KeyValueResult,
  NamespaceNode,
  PeekBridge,
  PeekedValue,
  ValueRef,
} from '@peek/core'

/**
 * preload 窄桥的访问入口。
 *
 * `window.peek` 的类型由 @peek/core 的 `declare global` 提供（非可选），
 * 但 main 在 preload 尚未落地时也允许起窗，所以这里一律做运行时判空，
 * 绝不直接解引用。
 */
export function tryBridge(): PeekBridge | null {
  const w = window as unknown as Record<string, unknown>
  const b = w['peek']
  if (typeof b !== 'object' || b === null) return null
  const cand = b as Partial<PeekBridge>
  if (typeof cand.invoke !== 'function' || typeof cand.getSnapshot !== 'function') return null
  return b as PeekBridge
}

/** 桥不存在时抛这个，调用方统一转成 toast，不让 UI 崩 */
export class BridgeUnavailable extends Error {
  constructor() {
    super('preload 桥未就绪：window.peek 不可用')
    this.name = 'BridgeUnavailable'
  }
}

export function requireBridge(): PeekBridge {
  const b = tryBridge()
  if (!b) throw new BridgeUnavailable()
  return b
}

/* ==================================================================== */
/* 契约缺口的可选扩展通道                                                  */
/* ==================================================================== */

/**
 * ⚠️ 契约缺口（已在交付说明里上报）：
 *
 * `COMMAND_NAMES` 里没有 introspect / valuePeek / keyValue 对应的命令，
 * `ViewState` 里也没有承载命名空间节点或单值内容的字段。
 * 也就是说 **renderer 目前没有任何合法途径拿到树的子节点和大 value 全量**。
 *
 * 这里定义一组**可选**的桥扩展方法作为唯一约定的补洞点：
 * - preload 若实现了它们，树视图和检查器就能工作；
 * - 没实现时，UI 只降级展示（树给提示、大 value 只显示 4KB 预览），不报错、不崩。
 *
 * 全部运行时探测，不改动 @peek/core 的 PeekBridge 接口。
 */
export interface PeekBridgeExtras {
  /** 对应 HostRpcMap['introspect.children'] */
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>
  /** 对应 HostRpcMap['value.peek'] */
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>
  /** 对应 HostRpcMap['keyvalue.get'] */
  getKeyValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult>
}

type ExtraName = keyof PeekBridgeExtras

function extra<K extends ExtraName>(name: K): PeekBridgeExtras[K] | null {
  const b = tryBridge()
  if (!b) return null
  const fn = (b as unknown as Record<string, unknown>)[name]
  return typeof fn === 'function' ? (fn as PeekBridgeExtras[K]) : null
}

export const bridgeExtras = {
  hasIntrospect: (): boolean => extra('introspect') !== null,
  hasPeekValue: (): boolean => extra('peekValue') !== null,

  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> {
    const fn = extra('introspect')
    if (!fn) return Promise.reject(new Error('桥未提供 introspect 通道'))
    return fn(connId, parentId, refresh)
  },

  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue> {
    const fn = extra('peekValue')
    if (!fn) return Promise.reject(new Error('桥未提供 peekValue 通道'))
    return fn(connId, ref, range)
  },

  getKeyValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult> {
    const fn = extra('getKeyValue')
    if (!fn) return Promise.reject(new Error('桥未提供 getKeyValue 通道'))
    return fn(connId, ref)
  },
} as const
