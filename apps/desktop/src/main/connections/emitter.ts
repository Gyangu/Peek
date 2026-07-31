/**
 * 微型类型安全事件发射器。
 *
 * 不用 Node 的 EventEmitter：它的 listener 签名是 `(...args: any[]) => void`，
 * 在"禁止 any"的约束下没法安全用。这里用事件名 → payload 的映射表把类型钉死。
 */

export type Listener<P> = (payload: P) => void

/** 事件表：键是事件名，值是该事件的 payload 类型 */
export class TypedEmitter<M extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof M, Set<Listener<unknown>>>()

  /** 订阅，返回取消订阅函数（幂等） */
  on<K extends keyof M>(event: K, listener: Listener<M[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set<Listener<unknown>>()
      this.handlers.set(event, set)
    }
    // 类型擦除后存储；emit 时按同一张表还原，外部看不到 unknown
    const erased = listener as Listener<unknown>
    set.add(erased)
    return () => {
      this.handlers.get(event)?.delete(erased)
    }
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event)
    if (!set || set.size === 0) return
    // 拷贝一份再遍历：处理器里退订不会影响本次派发
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        // 事件处理器抛错不能反噬发射方（连接管理器要保持崩溃隔离）
        console.error('[peek/connections] 事件处理器抛错', event, err)
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
