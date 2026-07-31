import type {
  ConnId,
  KeyValueResult,
  NamespaceNode,
  PeekBridge,
  PeekedValue,
  ValueRef,
} from '@peek/core'

/**
 * Access to the narrow preload bridge.
 *
 * `@peek/core` declares `window.peek` globally and non-optionally, but main will
 * happily open a window before preload has landed — so every access here is
 * null-checked at runtime and the global is never dereferenced directly.
 */
export function tryBridge(): PeekBridge | null {
  const w = window as unknown as Record<string, unknown>
  const b = w['peek']
  if (typeof b !== 'object' || b === null) return null
  const cand = b as Partial<PeekBridge>
  if (typeof cand.invoke !== 'function' || typeof cand.getSnapshot !== 'function') return null
  return b as PeekBridge
}

/**
 * Thrown when the bridge is missing. Callers turn it into a toast rather than
 * letting the UI crash.
 *
 * The message is a plain English literal, not a catalog key: it names a missing
 * global and is aimed at whoever is debugging the build, not at the user.
 */
export class BridgeUnavailable extends Error {
  constructor() {
    super('preload bridge not ready: window.peek is unavailable')
    this.name = 'BridgeUnavailable'
  }
}

export function requireBridge(): PeekBridge {
  const b = tryBridge()
  if (!b) throw new BridgeUnavailable()
  return b
}

/* ==================================================================== */
/* Optional extension channels for a gap in the contract                  */
/* ==================================================================== */

/**
 * ⚠️ Contract gap (already raised in the delivery notes):
 *
 * `COMMAND_NAMES` has no command for introspect / valuePeek / keyValue, and
 * `ViewState` has no field to carry namespace nodes or the body of a single
 * value. In other words, **the renderer currently has no sanctioned way to obtain
 * a tree's child nodes or the full text of a large value**.
 *
 * These optional bridge methods are the one agreed-upon patch for that hole:
 * - if preload implements them, the tree view and the inspector work;
 * - if it does not, the UI degrades visibly (the tree explains itself, a large
 *   value shows its 4KB preview) rather than erroring or crashing.
 *
 * Everything is probed at runtime; `PeekBridge` in @peek/core is untouched.
 */
export interface PeekBridgeExtras {
  /** Maps to HostRpcMap['introspect.children']. */
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>
  /** Maps to HostRpcMap['value.peek']. */
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>
  /** Maps to HostRpcMap['keyvalue.get']. */
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
    if (!fn) return Promise.reject(new Error('The bridge exposes no introspect channel'))
    return fn(connId, parentId, refresh)
  },

  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue> {
    const fn = extra('peekValue')
    if (!fn) return Promise.reject(new Error('The bridge exposes no peekValue channel'))
    return fn(connId, ref, range)
  },

  getKeyValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult> {
    const fn = extra('getKeyValue')
    if (!fn) return Promise.reject(new Error('The bridge exposes no getKeyValue channel'))
    return fn(connId, ref)
  },
} as const
