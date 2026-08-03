/**
 * The human gate, as `pi-agent-core`'s `beforeToolCall` needs it.
 *
 * A module of its own rather than a method on the manager, for one reason worth
 * stating: this is the function that decides whether the chat panel's central
 * promise holds — *a tool call the user did not approve does not run* — and a
 * promise like that should be testable without constructing an agent, a model
 * and a transcript around it.
 *
 * It owns no state, and it does not decide what is on screen either — the broker
 * owns both the pending requests and the queue that says which of them the user
 * is currently being asked about. This only turns an answer into
 * `beforeToolCall`'s vocabulary.
 */

import type { ChatId, ChatPermissionMode } from '@peek/core'
import type { PermissionBroker, RawPermissionOption } from '../permissions'

/**
 * The options the gate offers.
 *
 * Structurally what an ACP agent would send, built here because there is no
 * protocol to receive them from. `allow_always` is deliberately absent: a
 * standing grant belongs to a permission *mode*, which is a setting the user
 * changes in front of a dialog that says what it means — not something to
 * acquire by clicking quickly.
 */
export const PERMISSION_OPTIONS: readonly RawPermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

/** Answered when the user does not, and it authorises nothing. */
export const PERMISSION_TIMEOUT_MS = 300_000

export interface GateRequest {
  chatId: ChatId
  toolCallId: string
  toolName: string
  args: unknown
  mode: ChatPermissionMode
}

export interface GateDeps {
  broker: PermissionBroker
  timeoutMs?: number
}

/**
 * `undefined` to allow, `{ block, reason }` to refuse — `beforeToolCall`'s
 * vocabulary.
 *
 * Everything short of an explicit yes is a no. The three refusals differ only in
 * *why* nobody approved: the user said no, the turn was cancelled underneath the
 * question, or nobody answered at all. Collapsing them here is the point — an
 * absent user is not a consenting user, and the broker's timeout answers
 * `cancelled` rather than inventing an approval.
 *
 * `bypassPermissions` skips the prompt because it is a mode the user chose
 * deliberately. Note what is *not* consulted: nothing the model sent. A tool call
 * cannot describe itself in a way that lowers its own bar.
 */
export async function requestToolPermission(
  request: GateRequest,
  deps: GateDeps,
): Promise<{ block: true; reason: string } | undefined> {
  if (request.mode === 'bypassPermissions') return undefined

  const ticket = deps.broker.open({
    chatId: request.chatId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    rawInput: request.args,
    options: PERMISSION_OPTIONS,
    timeoutMs: deps.timeoutMs ?? PERMISSION_TIMEOUT_MS,
  })

  // Announcing is the broker's job, not this function's: with several tool calls
  // in flight — `pi-agent-core` runs them in parallel by default — this request
  // may have to wait behind one the user is still reading. Showing it here would
  // overwrite that prompt and make it unanswerable, which is the bug
  // `design/2026-08-03-concurrent-permission-prompts.md` exists to fix.
  const decision = await ticket.decision

  if (decision.kind === 'selected' && decision.optionId === 'allow') return undefined
  return {
    block: true,
    reason: decision.kind === 'cancelled' ? cancelReason(decision.reason) : 'The user declined this tool call.',
  }
}

function cancelReason(reason: string): string {
  switch (reason) {
    case 'timeout':
      return 'No answer arrived in time, so the call was not made.'
    case 'turn-cancelled':
      return 'The turn was cancelled before this call ran.'
    case 'shutdown':
      return 'peek was shutting down.'
    default:
      return 'The call was not approved.'
  }
}
