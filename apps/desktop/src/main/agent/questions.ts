/**
 * The agent asking a person a question, and waiting for the answer.
 *
 * ## The same shape as `permissions.ts`, and why it is not the same module
 *
 * Register → announce through `onActive` → the caller awaits a promise → exactly
 * one settlement, whatever happens. Queued per chat, because one panel can show
 * one prompt and a second question arriving mid-read must not overwrite the
 * first (`design/2026-08-03-concurrent-permission-prompts.md` is the record of
 * what happens when it does).
 *
 * Three things differ, and they are why the two brokers are not one:
 *
 * 1. **Timeout means the opposite.** A permission that times out must answer
 *    `cancelled`, because "nobody agreed" is the same as "not authorised" — the
 *    absent-user rule in `permissions.ts`. A question that times out authorises
 *    nothing and refuses nothing; it comes back as "no answer", and deciding what
 *    to do about that is the agent's job, not peek's.
 * 2. **The caller is different.** A permission request comes from a *backend
 *    protocol*, so `PermissionBroker` is instantiated once per backend. A
 *    question comes from a **tool call**, which may be the embedded agent or a
 *    Claude Code in a terminal — neither of which belongs to a backend. So this
 *    is one per window, assembled in `main/index.ts`.
 * 3. **Who may answer.** Enforced by the `chat.answer` handler rather than here,
 *    but it is the reason the two prompts are separate fields in Workspace at
 *    all — see `PendingQuestion` in core.
 *
 * Deliberately *not* factored into a shared queue with `PermissionBroker`. That
 * path has its own design record and its own test suite pinning behaviour that
 * this one does not share; an abstraction satisfying both semantics, built to
 * save sixty lines, is a worse trade than the duplication. Rule of three — when a
 * third thing has to stop and wait for a person, that is the moment to look at
 * what all three actually have in common.
 */

import { randomBytes } from 'node:crypto'
import type { ChatId, PendingQuestion, QuestionOption } from '@peek/core'

/** What the user said, or why they did not. */
export type QuestionOutcome =
  | { kind: 'answered'; optionIds: string[]; other?: string }
  | { kind: 'unanswered'; reason: QuestionCancelReason }

export type QuestionCancelReason = 'timeout' | 'turn-cancelled' | 'view-gone' | 'shutdown'

export interface QuestionRequestInput {
  chatId: ChatId
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
  /** How long a person has to notice and answer. Starts when the prompt is shown. */
  timeoutMs: number
}

export interface QuestionTicket {
  pending: PendingQuestion
  outcome: Promise<QuestionOutcome>
}

interface Entry {
  chatId: ChatId
  pending: PendingQuestion
  settle: (outcome: QuestionOutcome) => void
  timeoutMs: number
  timer: NodeJS.Timeout | null
  /** The ids actually offered. A Command payload is untrusted input like any other. */
  allowed: ReadonlySet<string>
  multiSelect: boolean
}

export interface QuestionBrokerDeps {
  /** Called with the question a chat should be showing, or null when there is none. */
  onActive: (chatId: ChatId, pending: PendingQuestion | null) => void
  now?: () => number
}

export class QuestionBroker {
  readonly #entries = new Map<string, Entry>()
  readonly #queues = new Map<ChatId, string[]>()
  readonly #now: () => number
  readonly #onActive: (chatId: ChatId, pending: PendingQuestion | null) => void
  #draining = false

  constructor(deps: QuestionBrokerDeps = { onActive: () => undefined }) {
    this.#now = deps.now ?? Date.now
    this.#onActive = deps.onActive
  }

  get pendingCount(): number {
    return this.#entries.size
  }

  /** Every outstanding question, as (chat, request) pairs. For the watcher below. */
  waiting(): { chatId: ChatId; requestId: string }[] {
    return [...this.#entries.entries()].map(([requestId, entry]) => ({
      chatId: entry.chatId,
      requestId,
    }))
  }

  /** The question currently on screen for a chat, if any. */
  activeFor(chatId: ChatId): PendingQuestion | null {
    const head = this.#queues.get(chatId)?.[0]
    return head ? (this.#entries.get(head)?.pending ?? null) : null
  }

  /**
   * Register a question and hand back what to show and what to await.
   *
   * The clock starts when the question becomes *visible*, never when it is
   * queued: the budget is for a person to read and decide, and charging them for
   * time they were not shown anything is punishing them for peek's ordering.
   */
  open(input: QuestionRequestInput): QuestionTicket {
    const requestId = `ask_${randomBytes(9).toString('base64url')}`

    let settle!: (outcome: QuestionOutcome) => void
    const outcome = new Promise<QuestionOutcome>((resolve) => {
      settle = (value: QuestionOutcome) => {
        const entry = this.#entries.get(requestId)
        if (!entry) return // Already settled; a second answer is a no-op.
        this.#entries.delete(requestId)
        if (entry.timer) clearTimeout(entry.timer)
        this.#dequeue(entry.chatId, requestId)
        resolve(value)
        // After the promise settles, so the awaiting caller sees the next prompt
        // appear rather than racing it.
        this.#promote(entry.chatId)
      }
    })

    const pending: PendingQuestion = {
      requestId,
      question: input.question,
      ...(input.header === undefined ? {} : { header: input.header }),
      options: input.options,
      multiSelect: input.multiSelect,
      askedAt: this.#now(),
    }

    this.#entries.set(requestId, {
      chatId: input.chatId,
      pending,
      settle,
      timeoutMs: input.timeoutMs,
      timer: null,
      allowed: new Set(input.options.map((option) => option.optionId)),
      multiSelect: input.multiSelect,
    })

    const queue = this.#queues.get(input.chatId) ?? []
    queue.push(requestId)
    this.#queues.set(input.chatId, queue)
    if (queue.length === 1) this.#activate(input.chatId, requestId)

    return { pending, outcome }
  }

  /* ---------------- The queue ---------------- */

  #activate(chatId: ChatId, requestId: string): void {
    const entry = this.#entries.get(requestId)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.settle({ kind: 'unanswered', reason: 'timeout' })
    }, entry.timeoutMs)
    // A question waiting for an answer must never hold the process open on quit.
    entry.timer.unref?.()
    this.#onActive(chatId, entry.pending)
  }

  #dequeue(chatId: ChatId, requestId: string): void {
    const queue = this.#queues.get(chatId)
    if (!queue) return
    const index = queue.indexOf(requestId)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.#queues.delete(chatId)
  }

  /** Show whatever is next, or report that nothing is. */
  #promote(chatId: ChatId): void {
    if (this.#draining) return
    const next = this.#queues.get(chatId)?.[0]
    if (next === undefined) {
      this.#onActive(chatId, null)
      return
    }
    this.#activate(chatId, next)
  }

  /**
   * Apply the user's answer. False when the request is unknown, or when what
   * came back is not a valid answer to *this* question.
   *
   * Three ways it is not valid, and all three leave the prompt standing rather
   * than settling it wrongly:
   *
   *  - an id that was never offered. This arrives as a Command payload, which is
   *    untrusted like any other; peek must not hand the agent a string it made up;
   *  - several ids for a single-select question;
   *  - nothing at all — no options and no text. The schema refuses that too, and
   *    this is the belt: an empty answer is indistinguishable from silence, and
   *    silence has its own outcome.
   */
  resolve(requestId: string, optionIds: readonly string[], other?: string): boolean {
    const entry = this.#entries.get(requestId)
    if (!entry) return false
    if (optionIds.length === 0 && other === undefined) return false
    if (!entry.multiSelect && optionIds.length > 1) return false
    if (optionIds.some((id) => !entry.allowed.has(id))) return false
    entry.settle({
      kind: 'answered',
      optionIds: [...optionIds],
      ...(other === undefined ? {} : { other }),
    })
    return true
  }

  /** Settle one question as unanswered. */
  cancel(requestId: string, reason: QuestionCancelReason): boolean {
    const entry = this.#entries.get(requestId)
    if (!entry) return false
    entry.settle({ kind: 'unanswered', reason })
    return true
  }

  /**
   * Settle every outstanding question of a chat — or of every chat, for `null`.
   *
   * Called when a turn is cancelled, when a chat view closes and on shutdown.
   * Leaving one unsettled would leak a timer and, worse, strand `pendingQuestion`
   * in the Workspace: a prompt the user can see, answer, and have nothing happen.
   *
   * `#draining` suppresses `#promote` while a batch settles, so the fan-out is
   * one `onActive(chatId, null)` at the end rather than one per cancelled entry
   * announcing a question that is itself about to be cancelled.
   */
  cancelAll(chatId: ChatId | null, reason: QuestionCancelReason): number {
    const targets = [...this.#entries.entries()].filter(
      ([, entry]) => chatId === null || entry.chatId === chatId,
    )
    if (targets.length === 0) return 0

    const touched = new Set<ChatId>()
    this.#draining = true
    try {
      for (const [, entry] of targets) {
        touched.add(entry.chatId)
        entry.settle({ kind: 'unanswered', reason })
      }
    } finally {
      this.#draining = false
    }
    for (const id of touched) this.#promote(id)
    return targets.length
  }
}

/**
 * Settle any question the window has stopped showing.
 *
 * The broker and the Workspace can disagree in exactly one direction: the field
 * goes away without the broker being told. Two ways that happens, and neither
 * goes through this module —
 *
 *   the chat view is closed;
 *   `chat.cancel` / `chat.clear` delete the field, because the turn the question
 *   was blocking is being abandoned.
 *
 * Both are reducers on the Command Bus, and neither can reach the broker: the
 * bus must not import an agent module (that is what keeps its handlers testable
 * without an agent). So instead of pushing the news to the broker from three
 * call sites, the broker's state is reconciled against the source of truth,
 * which is one rule and cannot be forgotten by the fourth call site.
 *
 * Without it, a cancelled turn leaves `chat.ask` suspended until its five-minute
 * timeout — the tool call outliving the turn that made it.
 */
export function watchQuestions(
  store: {
    getState: () => {
      views: Record<string, { kind: string; chatId?: ChatId; pendingQuestion?: PendingQuestion }>
    }
    subscribe: (listener: () => void) => () => void
  },
  broker: QuestionBroker,
): () => void {
  const reconcile = (): void => {
    const outstanding = broker.waiting()
    if (outstanding.length === 0) return

    const shown = new Set<string>()
    for (const view of Object.values(store.getState().views)) {
      if (view.kind === 'chat' && view.pendingQuestion !== undefined) {
        shown.add(view.pendingQuestion.requestId)
      }
    }
    for (const { chatId, requestId } of outstanding) {
      if (shown.has(requestId)) continue
      // A queued question is not on screen either, and must not be cancelled for
      // it — only the head of a chat's queue is ever displayed, and the ones
      // behind it are waiting their turn exactly as designed.
      const active = broker.activeFor(chatId)
      if (active !== null && active.requestId !== requestId) continue
      broker.cancel(requestId, 'view-gone')
    }
  }

  return store.subscribe(reconcile)
}
