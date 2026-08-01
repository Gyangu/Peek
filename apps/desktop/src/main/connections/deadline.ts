/**
 * Whole-fetch deadlines.
 *
 * ## Why main has to hold the clock
 *
 * `timeoutMs` already travels to the driver, and every driver is expected to
 * honour it. That covers the case the driver can see — a statement the server is
 * still chewing on. It does not cover the cases that actually strand a view:
 *
 * - the driver host is wedged (event loop blocked, a native client stuck in a
 *   syscall) and its own timer never fires;
 * - the driver honours the deadline for the *statement* but the stream then
 *   stalls between chunks;
 * - the driver has no notion of a deadline at all.
 *
 * In all three the result set sits at `running` forever, the view spins, and the
 * user's only exit is Cancel — which is exactly the M6 complaint. A timer in main
 * is the one clock that keeps running when the host stops, so this is where the
 * guarantee has to live.
 *
 * ## Shape
 *
 * Deliberately free of Electron, of `ConnectionManager`, and of `Date.now` — the
 * timer functions are injected. That is what lets the whole expiry path be driven
 * synchronously from a unit test instead of being verified by waiting two minutes.
 */

export type TimerId = ReturnType<typeof setTimeout>

export interface DeadlineTimerApi {
  set(cb: () => void, ms: number): TimerId
  clear(id: TimerId): void
}

const REAL_TIMERS: DeadlineTimerApi = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (id) => {
    clearTimeout(id)
  },
}

interface Armed {
  id: TimerId
  ms: number
}

/**
 * A set of armed deadlines, keyed by result id.
 *
 * Every method is idempotent: arming over an existing deadline replaces it,
 * clearing an unknown id is a no-op, and a deadline is removed from the table
 * *before* its callback runs — so a callback that cancels the result cannot
 * re-enter and clear a deadline that has already fired.
 */
export class ResultDeadlines {
  readonly #timers: DeadlineTimerApi
  readonly #armed = new Map<string, Armed>()

  constructor(timers: DeadlineTimerApi = REAL_TIMERS) {
    this.#timers = timers
  }

  /**
   * Arm a deadline for `resultId`. A non-positive or absent `ms` disarms instead
   * of arming, so callers can pass `resolveExecutionTimeout(...)` straight
   * through without branching.
   */
  arm(resultId: string, ms: number | undefined, onExpire: (ms: number) => void): void {
    this.clear(resultId)
    if (ms === undefined || ms <= 0) return
    const id = this.#timers.set(() => {
      // Drop the entry first: onExpire cancels the result, which unwinds through
      // paths that clear deadlines, and this one has already fired.
      this.#armed.delete(resultId)
      onExpire(ms)
    }, ms)
    this.#armed.set(resultId, { id, ms })
  }

  /** Disarm one deadline. Safe to call for a result that never had one. */
  clear(resultId: string): void {
    const armed = this.#armed.get(resultId)
    if (!armed) return
    this.#armed.delete(resultId)
    this.#timers.clear(armed.id)
  }

  /** Disarm everything (a connection closing, the process exiting, shutdown). */
  clearAll(): void {
    for (const armed of this.#armed.values()) this.#timers.clear(armed.id)
    this.#armed.clear()
  }

  has(resultId: string): boolean {
    return this.#armed.has(resultId)
  }

  /** The budget a result was armed with, for reporting. */
  budgetOf(resultId: string): number | undefined {
    return this.#armed.get(resultId)?.ms
  }

  get size(): number {
    return this.#armed.size
  }
}
