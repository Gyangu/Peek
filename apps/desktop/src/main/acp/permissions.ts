/**
 * The human gate on tool calls.
 *
 * `session/request_permission` is a **request**, not a notification: the agent
 * blocks on the answer. So this module turns it into something the UI can render
 * and the user can answer at their own pace, while guaranteeing that an answer
 * always arrives.
 *
 * ## Two rules that decide the design
 *
 * **An absent user is not a consenting user.** The timeout answers `cancelled`,
 * never `allow`. `cancelled` is the protocol's own "no decision was made"
 * outcome: it authorises nothing and records no standing rule, so a laptop left
 * unattended cannot grant anything.
 *
 * **The agent must never be able to wedge peek, and peek must never wedge the
 * agent.** Every request is registered with a timer before it is announced, and
 * every exit path — user answer, timeout, turn cancelled, agent gone, shutdown —
 * settles the promise exactly once and clears the timer.
 */

import { randomBytes } from 'node:crypto'
import type { ChatId, PendingPermission, PermissionOption } from '@peek/core'
import type { PermissionOption as AcpPermissionOption } from '@agentclientprotocol/sdk'
import { previewInput } from './errors'

export type PermissionDecision =
  | { kind: 'selected'; optionId: string }
  | { kind: 'cancelled'; reason: PermissionCancelReason }

export type PermissionCancelReason = 'timeout' | 'user' | 'turn-cancelled' | 'agent-gone' | 'shutdown'

const OPTION_KINDS: ReadonlySet<string> = new Set<PermissionOption['kind']>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
])

/**
 * Convert the agent's options into peek's shape.
 *
 * `optionId` and `kind` are **different strings** — the id for "allow once" is
 * `allow` while its kind is `allow_once` — and the id is what must be sent back.
 * Keeping both, and never deriving one from the other, is the whole point of
 * this function. An option with an unrecognised `kind` is presented as
 * `reject_once`, so a kind peek does not understand can never be the permissive
 * one.
 */
export function toPermissionOptions(raw: readonly AcpPermissionOption[]): PermissionOption[] {
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
  options: readonly AcpPermissionOption[]
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
  settle: (decision: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout>
  /** Exactly the ids that were offered; nothing else may be sent back. */
  allowed: ReadonlySet<string>
}

export class PermissionBroker {
  readonly #entries = new Map<string, Entry>()

  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  get pendingCount(): number {
    return this.#entries.size
  }

  /**
   * Register a request and hand back what to show and what to await.
   *
   * The caller announces `pending` through the Command Bus and awaits `decision`
   * — in that order, and without awaiting anything in between, so the window can
   * never show a prompt whose answer has already been consumed.
   */
  open(input: PermissionRequestInput): PermissionTicket {
    const requestId = `perm_${randomBytes(9).toString('base64url')}`

    let settle!: (decision: PermissionDecision) => void
    const decision = new Promise<PermissionDecision>((resolve) => {
      settle = (value: PermissionDecision) => {
        const entry = this.#entries.get(requestId)
        if (!entry) return // Already settled; a second answer is a no-op.
        this.#entries.delete(requestId)
        clearTimeout(entry.timer)
        resolve(value)
      }
    })

    const timer = setTimeout(() => {
      settle({ kind: 'cancelled', reason: 'timeout' })
    }, input.timeoutMs)
    // A pending permission must never hold the process open on quit.
    timer.unref?.()

    const options = toPermissionOptions(input.options)
    this.#entries.set(requestId, {
      chatId: input.chatId,
      settle,
      timer,
      allowed: new Set(options.map((option) => option.optionId)),
    })

    const pending: PendingPermission = {
      requestId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      inputPreview: previewInput(input.rawInput),
      options,
      askedAt: this.#now(),
    }
    return { pending, decision }
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
    let count = 0
    for (const [requestId, entry] of [...this.#entries]) {
      if (chatId !== null && entry.chatId !== chatId) continue
      entry.settle({ kind: 'cancelled', reason })
      count += 1
    }
    return count
  }
}
