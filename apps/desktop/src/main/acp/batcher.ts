/**
 * Coalescing transcript deltas before they cross IPC.
 *
 * ## The problem this solves
 *
 * `agent_message_chunk` notifications arrive per token — a short turn produces
 * tens, a long one hundreds, and they land in bursts far faster than any display
 * refreshes. Forwarding each one as its own IPC message saturates the channel
 * with messages carrying a few characters each, and it does that while the same
 * event loop is serving the agent's MCP calls back into peek. Sending nothing
 * until the turn ends fixes the traffic and destroys the feature: streaming that
 * arrives all at once is not streaming.
 *
 * ## The resolution
 *
 * Buffer only what is safe to delay, delay it by less than a reader can perceive,
 * and merge whatever accumulates.
 *
 *  - **Prose waits.** `text.append` and `thought.append` buffer, and consecutive
 *    ones for the same message merge into a single delta carrying the
 *    concatenated string. This is where the traffic reduction comes from; the
 *    timer only decides when it is realised.
 *  - **A tool row appears at once, then its arguments buffer.** The first
 *    `tool.upsert` for a `toolCallId` flushes immediately, because a row the
 *    user is about to watch must not be late. The updates that follow it are the
 *    model streaming its JSON arguments in — each one a *complete replacement*
 *    of the previous — so a queued upsert is overwritten in place instead of
 *    being appended. A single tool call was observed emitting four of these; the
 *    user sees the final arguments either way, and the intermediate ones are
 *    pure noise. A terminal status (`completed` / `failed`) flushes immediately
 *    again: that is a spinner resolving.
 *  - **Everything else is immediate**: a message opening or closing, a reset.
 *    Whatever prose was queued goes out ahead of it, so ordering is exact.
 *  - **Three ceilings, whichever comes first**: ~50 ms of wall clock, a character
 *    budget, a delta-count budget. The last two keep one flush from becoming an
 *    enormous payload when the agent dumps a large block at once.
 *
 * ## What this actually bought, measured
 *
 * Against a real Claude agent the honest answer is: on prose, usually nothing.
 * Its chunks arrived further apart than the 50 ms window, so most flushed alone
 * — the coalescer is a **ceiling on the worst case**, not a typical-case
 * optimisation, and it costs nothing when the stream is already slow. The place
 * it demonstrably helps is tool-argument streaming, which is bursty by
 * construction. The budget is sized for the burst because that is the only case
 * that can hurt, and because a faster agent (a local model, a cached replay)
 * turns the typical case into the burst case.
 *
 * The class is deliberately free of Node and Electron imports, with timers
 * injectable, so its behaviour is testable without a clock or an agent.
 */

import type { ChatDelta, ChatId } from '@peek/core'
import type { DeltaBatchBudget } from './types'

type TimerHandle = ReturnType<typeof setTimeout>

export interface BatcherTimers {
  setTimer(fn: () => void, ms: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

const REAL_TIMERS: BatcherTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle)
  },
}

type AppendDelta = Extract<ChatDelta, { type: 'text.append' | 'thought.append' }>
type ToolDelta = Extract<ChatDelta, { type: 'tool.upsert' }>

/** Prose deltas, the ones that merge by concatenation. */
function isAppend(delta: ChatDelta): delta is AppendDelta {
  return delta.type === 'text.append' || delta.type === 'thought.append'
}

function isTerminalTool(delta: ToolDelta): boolean {
  return delta.call.status === 'completed' || delta.call.status === 'failed'
}

export class DeltaBatcher {
  #pending: ChatDelta[] = []
  #pendingChars = 0
  #timer: TimerHandle | null = null
  #disposed = false
  /** Tool calls whose first row has already been sent. */
  #announcedTools = new Set<string>()

  readonly #chatId: ChatId
  readonly #budget: DeltaBatchBudget
  readonly #sink: (chatId: ChatId, deltas: readonly ChatDelta[]) => void
  readonly #timers: BatcherTimers

  constructor(
    chatId: ChatId,
    budget: DeltaBatchBudget,
    sink: (chatId: ChatId, deltas: readonly ChatDelta[]) => void,
    timers: BatcherTimers = REAL_TIMERS,
  ) {
    this.#chatId = chatId
    this.#budget = budget
    this.#sink = sink
    this.#timers = timers
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  /**
   * Queue one delta.
   *
   * Never throws and never blocks: this runs inside an ACP notification handler,
   * and main's event loop is on the critical path of the agent's own calls back
   * into peek.
   */
  push(delta: ChatDelta): void {
    if (this.#disposed) return

    if (delta.type === 'reset') this.#announcedTools.clear()

    if (isAppend(delta)) {
      if (!this.#mergeAppendIntoTail(delta)) this.#pending.push(delta)
      this.#pendingChars += delta.text.length
      this.#afterBuffered()
      return
    }

    if (delta.type === 'tool.upsert' && this.#isBufferableTool(delta)) {
      if (!this.#replaceQueuedTool(delta)) this.#pending.push(delta)
      this.#afterBuffered()
      return
    }

    if (delta.type === 'tool.upsert') {
      this.#announcedTools.add(delta.call.toolCallId)
      // A queued update for the same call is superseded by this one; sending
      // both would make the renderer apply a record it is about to overwrite.
      this.#dropQueuedTool(delta.call.toolCallId)
    }
    this.#pending.push(delta)
    this.flush()
  }

  /**
   * True for the argument-streaming updates in the middle of a tool call.
   *
   * The first update for a call and its terminal update both flush at once —
   * they are the row appearing and the row resolving, the two moments the user
   * is actually looking at.
   */
  #isBufferableTool(delta: ToolDelta): boolean {
    return this.#announcedTools.has(delta.call.toolCallId) && !isTerminalTool(delta)
  }

  #afterBuffered(): void {
    if (this.#pending.length >= this.#budget.maxDeltas || this.#pendingChars >= this.#budget.maxChars) {
      this.flush()
      return
    }
    this.#arm()
  }

  /**
   * Merge an append into the tail when it continues the same block.
   *
   * Only the immediate tail is considered. Merging across an intervening delta
   * would reorder the transcript, and a reordered transcript is a wrong one —
   * text that arrived after a tool call must render after it.
   */
  #mergeAppendIntoTail(delta: AppendDelta): boolean {
    const tail = this.#pending[this.#pending.length - 1]
    if (!tail || tail.type !== delta.type) return false
    if (tail.messageId !== delta.messageId) return false
    tail.text += delta.text
    return true
  }

  /**
   * Overwrite a queued update for the same tool call, wherever it sits.
   *
   * Safe at any position, unlike the append merge: `tool.upsert` is
   * idempotent-by-id and carries the whole record, so a later one entirely
   * supersedes an earlier one. Replacing in place keeps the row's position in
   * the transcript exactly where it was.
   */
  #dropQueuedTool(toolCallId: string): void {
    this.#pending = this.#pending.filter(
      (queued) => queued.type !== 'tool.upsert' || queued.call.toolCallId !== toolCallId,
    )
  }

  #replaceQueuedTool(delta: ToolDelta): boolean {
    for (let i = this.#pending.length - 1; i >= 0; i -= 1) {
      const queued = this.#pending[i]
      if (queued?.type === 'tool.upsert' && queued.call.toolCallId === delta.call.toolCallId) {
        this.#pending[i] = delta
        return true
      }
    }
    return false
  }

  #arm(): void {
    if (this.#timer !== null) return
    this.#timer = this.#timers.setTimer(() => {
      this.#timer = null
      this.flush()
    }, this.#budget.intervalMs)
  }

  /** Send everything queued right now. Safe to call when empty. */
  flush(): void {
    if (this.#timer !== null) {
      this.#timers.clearTimer(this.#timer)
      this.#timer = null
    }
    if (this.#pending.length === 0) return
    const batch = this.#pending
    this.#pending = []
    this.#pendingChars = 0
    try {
      this.#sink(this.#chatId, batch)
    } catch (error) {
      // The sink is an IPC send. A dead renderer must not take the agent down
      // with it, and the transcript in main stays authoritative regardless.
      console.error('[peek/acp] delta sink threw', error)
    }
  }

  /** Flush what is queued, then refuse further work. */
  dispose(): void {
    this.flush()
    this.#disposed = true
  }
}
