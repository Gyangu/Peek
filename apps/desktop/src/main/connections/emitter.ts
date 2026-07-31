/**
 * A tiny type-safe event emitter.
 *
 * Not Node's EventEmitter: its listener signature is `(...args: any[]) => void`,
 * which cannot be used safely under a no-`any` rule. This pins types down with a
 * map from event name to payload type instead.
 */

export type Listener<P> = (payload: P) => void

/** Event table: keys are event names, values are that event's payload type */
export class TypedEmitter<M extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof M, Set<Listener<unknown>>>()

  /** Subscribe; returns an idempotent unsubscribe function. */
  on<K extends keyof M>(event: K, listener: Listener<M[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set<Listener<unknown>>()
      this.handlers.set(event, set)
    }
    // Stored type-erased and restored from the same table on emit; callers never see the unknown
    const erased = listener as Listener<unknown>
    set.add(erased)
    return () => {
      this.handlers.get(event)?.delete(erased)
    }
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event)
    if (!set || set.size === 0) return
    // Iterate over a copy: unsubscribing inside a handler must not disturb this dispatch
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        // A throwing handler must not bite the emitter back (the Connection Manager has to stay crash-isolated)
        console.error('[peek/connections] event handler threw', event, err)
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
