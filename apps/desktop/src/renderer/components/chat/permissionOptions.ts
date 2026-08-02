/**
 * How a permission request is *presented* — kept apart from the component that
 * presents it.
 *
 * These are the decisions that decide whether the gate between an agent and a
 * database is honest: which answer looks like the recommended one, what order
 * the answers come in, and which mode changes are allowed to happen on a single
 * click. Every one of them is a pure function of its inputs, so they are asserted
 * directly rather than inferred from a rendered tree.
 *
 * See `design/2026-08-02-ui-legibility-baseline.md` §2.6.
 */

import type { ChatPermissionMode, PermissionOption } from '@peek/core'
import type { ButtonVariant } from '../../ui/spec'

/**
 * The order the answers are drawn in.
 *
 * The agent decides what it offers; the window decides how the offer reads. Both
 * one-shot answers come first, because they are what the question is actually
 * about, and the two that change future behaviour follow. Unknown kinds keep
 * their relative order at the end rather than being dropped — an option this
 * build does not recognise still has to be answerable.
 */
const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  reject_once: 1,
  allow_always: 2,
  reject_always: 3,
}

export function orderPermissionOptions(options: readonly PermissionOption[]): PermissionOption[] {
  return [...options].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
}

/**
 * The variant a permission button gets — and, more to the point, the one it does
 * not.
 *
 * **Nothing here returns `primary`.** `allow_once` used to, which made the
 * brightest control on the screen the one that says yes. The fix is not to move
 * the emphasis onto reject: that manufactures confirmation fatigue, and a user
 * trained that the loud button is the safe one will press it on the call that
 * mattered. The two one-shot answers are equal, and the visual budget goes to
 * the single option that changes anything beyond this call.
 *
 * This used to return CSS class names — `chat-perm-reject` and
 * `chat-perm-always`, two classes that existed nowhere else and that the rest of
 * the codebase had no way to discover. `chat-perm-reject` was in fact a
 * byte-for-byte copy of `.confirm-danger` in styles.css, written independently.
 * Returning a variant from the shared spec is what makes "reject reads as the
 * negative answer" a statement about meaning rather than about a stylesheet.
 * See design/2026-08-02-control-spec.md §2.3.
 */
export function permissionButtonVariant(option: PermissionOption): ButtonVariant {
  // Not `danger`: granting a standing permission destroys nothing, it just
  // stops asking. What makes it worth marking is that its consequence outlives
  // the moment — which is exactly what `caution` names.
  if (option.kind === 'allow_always') return 'caution'
  if (option.kind === 'reject_once' || option.kind === 'reject_always') return 'danger'
  return 'default'
}

/**
 * Modes that take the human out of the loop.
 *
 * Flagged rather than hidden. The contract is explicit that this list "exists to
 * be presented, not to be silently defaulted to its most permissive member" — so
 * the user may pick one, and the select says what they picked.
 */
export function isPermissiveMode(mode: ChatPermissionMode): boolean {
  return mode === 'dontAsk' || mode === 'bypassPermissions'
}

/**
 * Whether switching to `next` deserves a second question.
 *
 * Any move *into* a permissive mode does, including from one permissive mode to
 * the other: `dontAsk` and `bypassPermissions` are not the same authority, and
 * "I already turned the asking off" is not consent to turn something else off.
 * Moving back towards asking never does — restoring an approval gate is not a
 * decision anyone needs protecting from.
 */
export function needsModeConfirmation(next: ChatPermissionMode, current: ChatPermissionMode): boolean {
  return isPermissiveMode(next) && next !== current
}
