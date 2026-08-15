/**
 * The human gate on tool calls.
 *
 * `session/request_permission` is a **request**, not a notification: the agent
 * blocks on the answer. So this module turns it into something the UI can render
 * and the user can answer at their own pace, while guaranteeing that an answer
 * always arrives.
 *
 * ## Three rules that decide the design
 *
 * **An absent user is not a consenting user.** The timeout answers `cancelled`,
 * never `allow`. `cancelled` is the protocol's own "no decision was made"
 * outcome: it authorises nothing and records no standing rule, so a laptop left
 * unattended cannot grant anything.
 *
 * **The agent must never be able to wedge peek, and peek must never wedge the
 * agent.** Every request is registered before it is announced, and every exit
 * path — user answer, timeout, turn cancelled, agent gone, shutdown — settles the
 * promise exactly once and clears the timer.
 *
 * **One prompt at a time, per chat.** An agent may ask for several tools in
 * parallel, and `ChatViewState.pendingPermission` holds exactly one. Before this
 * was a queue, the second request overwrote the first on screen and the first
 * became unanswerable — the turn then sat there until a five-minute timeout, with
 * the panel still claiming to be streaming. So the broker owns the ordering:
 * requests queue per chat, the active one is announced through `onActive`, and
 * answering it promotes the next. See
 * `docs/design/2026-08-03-concurrent-permission-prompts.md`.
 *
 * The clock is part of that rule. `timeoutMs` is the budget for a *person to
 * read and decide*, so it starts when a request becomes active, never when it is
 * queued — otherwise the third request could expire before anyone had a chance to
 * see it, which is punishing the user for not doing something they were never
 * offered.
 */

import { randomBytes } from 'node:crypto'
import type { ChatId, PendingPermission, PermissionOption } from '@peek/core'
import { previewInput } from './redact'

export type PermissionDecision =
  { kind: 'selected'; optionId: string } | { kind: 'cancelled'; reason: PermissionCancelReason }

export type PermissionCancelReason = 'timeout' | 'user' | 'turn-cancelled' | 'agent-gone' | 'shutdown'

/**
 * An option as the backend states it, before peek has vouched for it.
 *
 * Structural rather than imported from the ACP SDK, so this module carries no
 * backend dependency: an ACP `PermissionOption` satisfies it as-is, and the
 * endpoint backend — which has no protocol to take options from and builds its
 * own — satisfies it too. `kind` is `string` on purpose. It is the untrusted
 * field, and {@link toPermissionOptions} is where it stops being untrusted.
 */
export interface RawPermissionOption {
  optionId: string
  name: string
  kind: string
}

const OPTION_KINDS: ReadonlySet<string> = new Set<PermissionOption['kind']>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
])

/**
 * Convert a backend's options into peek's shape.
 *
 * `optionId` and `kind` are **different strings** — the id for "allow once" is
 * `allow` while its kind is `allow_once` — and the id is what must be sent back.
 * Keeping both, and never deriving one from the other, is the whole point of
 * this function. An option with an unrecognised `kind` is presented as
 * `reject_once`, so a kind peek does not understand can never be the permissive
 * one.
 *
 * That last rule is why this stayed in the shared layer when the ACP-specific
 * code moved out: it is a safety property, and every backend needs it to hold.
 */
export function toPermissionOptions(raw: readonly RawPermissionOption[]): PermissionOption[] {
  return raw.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: OPTION_KINDS.has(option.kind) ? (option.kind as PermissionOption['kind']) : 'reject_once',
  }))
}

export interface PermissionRequestInput {
  chatId: ChatId
  toolCallId: string
  toolName: string
  rawInput: unknown
  options: readonly RawPermissionOption[]
  timeoutMs: number
}

export interface PermissionTicket {
  /** What goes into `ChatViewState.pendingPermission`. */
  pending: PendingPermission
  /** Settles exactly once. */
  decision: Promise<PermissionDecision>
}

interface Entry {
  chatId: ChatId
  pending: PendingPermission
  settle: (decision: PermissionDecision) => void
  /** How long the person gets, once they can actually see it. See the note above. */
  timeoutMs: number
  /** Null while queued. Started on activation, cleared on settle. */
  timer: ReturnType<typeof setTimeout> | null
  /** Exactly the ids that were offered; nothing else may be sent back. */
  allowed: ReadonlySet<string>
}

export interface PermissionBrokerDeps {
  /**
   * The prompt this chat should be showing now, or null when there is none.
   *
   * Called by the broker, and only when the active request *changes*: the first
   * one arriving, the next one being promoted after an answer, the queue running
   * dry. Callers write it to `pendingPermission` and no longer decide the timing
   * themselves — with a queue, "which one should be on screen" is not something a
   * single caller can know, because it depends on who else is waiting.
   */
  onActive(chatId: ChatId, pending: PendingPermission | null): void
  now?: () => number
}

export class PermissionBroker {
  readonly #entries = new Map<string, Entry>()

  /** Request ids per chat, oldest first. The head is the active one. */
  readonly #queues = new Map<ChatId, string[]>()

  readonly #now: () => number
  readonly #onActive: (chatId: ChatId, pending: PendingPermission | null) => void

  /** True while `cancelAll` is settling a batch; see the note there. */
  #draining = false

  constructor(deps: PermissionBrokerDeps = { onActive: () => undefined }) {
    this.#now = deps.now ?? Date.now
    this.#onActive = deps.onActive
  }

  get pendingCount(): number {
    return this.#entries.size
  }

  /** The prompt currently on screen for a chat, if any. */
  activeFor(chatId: ChatId): PendingPermission | null {
    const head = this.#queues.get(chatId)?.[0]
    return head ? (this.#entries.get(head)?.pending ?? null) : null
  }

  /**
   * Register a request and hand back what to show and what to await.
   *
   * The caller awaits `decision`. It does **not** announce `pending` — the broker
   * does that through `onActive`, when and only when this request is the one the
   * chat should be showing. A request that arrives while another is being
   * answered waits its turn, with its clock not yet running.
   */
  open(input: PermissionRequestInput): PermissionTicket {
    const requestId = `perm_${randomBytes(9).toString('base64url')}`

    let settle!: (decision: PermissionDecision) => void
    const decision = new Promise<PermissionDecision>((resolve) => {
      settle = (value: PermissionDecision) => {
        const entry = this.#entries.get(requestId)
        if (!entry) return // Already settled; a second answer is a no-op.
        this.#entries.delete(requestId)
        if (entry.timer) clearTimeout(entry.timer)
        this.#dequeue(entry.chatId, requestId)
        resolve(value)
        // After the promise settles, so a caller awaiting it sees the next prompt
        // appear rather than racing it.
        this.#promote(entry.chatId)
      }
    })

    const options = toPermissionOptions(input.options)
    const pending: PendingPermission = {
      requestId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      inputPreview: previewInput(input.rawInput),
      options,
      askedAt: this.#now(),
    }

    this.#entries.set(requestId, {
      chatId: input.chatId,
      pending,
      settle,
      timeoutMs: input.timeoutMs,
      timer: null,
      allowed: new Set(options.map((option) => option.optionId)),
    })

    const queue = this.#queues.get(input.chatId) ?? []
    queue.push(requestId)
    this.#queues.set(input.chatId, queue)
    // First in line: it becomes visible, and only now does its clock start.
    if (queue.length === 1) this.#activate(input.chatId, requestId)

    return { pending, decision }
  }

  /* ---------------- The queue ---------------- */

  /**
   * Put a request on screen and start its clock.
   *
   * The two happen together on purpose. A prompt that is being timed but not
   * shown is the failure this whole queue exists to prevent.
   */
  #activate(chatId: ChatId, requestId: string): void {
    const entry = this.#entries.get(requestId)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.settle({ kind: 'cancelled', reason: 'timeout' })
    }, entry.timeoutMs)
    // A pending permission must never hold the process open on quit.
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

  /**
   * Show whatever is next, or report that nothing is.
   *
   * This is the exact inverse of the bug this design fixes: answering a prompt
   * does not clear `pendingPermission`, it *replaces* it — with null only when
   * the queue is genuinely empty.
   */
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
   * Apply the user's choice. Returns false when the request is unknown — already
   * timed out, already answered, or from a session that has since died.
   *
   * The id is checked against the options that were actually offered. It arrives
   * as a Command payload, and a Command payload is untrusted input like any
   * other; peek must not forward an arbitrary string to the agent as a
   * permission decision. An unrecognised id is treated as no answer at all,
   * which leaves the prompt standing rather than silently deciding it.
   */
  resolve(requestId: string, optionId: string): boolean {
    const entry = this.#entries.get(requestId)
    if (!entry || !entry.allowed.has(optionId)) return false
    entry.settle({ kind: 'selected', optionId })
    return true
  }

  /** Answer `cancelled` for one request. */
  cancel(requestId: string, reason: PermissionCancelReason): boolean {
    const entry = this.#entries.get(requestId)
    if (!entry) return false
    entry.settle({ kind: 'cancelled', reason })
    return true
  }

  /**
   * Answer `cancelled` for every outstanding request of a chat.
   *
   * Called when a turn is cancelled, when the agent process dies and on
   * shutdown. Leaving a promise unsettled would leak a timer and, worse, leave
   * `pendingPermission` set in the Workspace forever — a modal the user can never
   * dismiss.
   */
  cancelAll(chatId: ChatId | null, reason: PermissionCancelReason): number {
    const touched = new Set<ChatId>()
    let count = 0
    // Promotion is suppressed for the duration: settling these one at a time
    // would walk the queue, briefly putting each doomed request on screen and
    // starting a timer for it, before the next iteration cancelled that one too.
    this.#draining = true
    try {
      for (const [requestId, entry] of [...this.#entries]) {
        if (chatId !== null && entry.chatId !== chatId) continue
        touched.add(entry.chatId)
        void requestId
        entry.settle({ kind: 'cancelled', reason })
        count += 1
      }
    } finally {
      this.#draining = false
    }
    // One announcement per affected chat, after the dust settles. A chat that had
    // requests left over (cancelAll for a different chat cannot happen here, but
    // a future caller might cancel a subset) gets its next prompt; an emptied one
    // gets the null that dismisses the dialog.
    for (const affected of touched) this.#promote(affected)
    return count
  }
}
