import type { NamespaceElision } from '@peek/core'
import type { TFunction } from '../../i18n'

/**
 * How a tree row words "there is more here than this list shows".
 *
 * A pure function in its own module, like `browseControls` and `openTarget`
 * beside it, because the wording is the whole point of the feature and a
 * component is the one place it cannot be tested.
 *
 * The driver's own `detail` is English on purpose — MCP reads it — so the
 * sidebar cannot pass it through: the reader who most needs this row is the one
 * being told the tree in front of them is incomplete, and that has to arrive in
 * their language.
 *
 * The branch is on `remaining` being present, not on a flag beside it, so the
 * unknown case has no number available to leak into the wording. That is the
 * defect this row exists for: a count that is exact over a truncated sample and
 * a lower bound over the level reads as the whole remainder, and it dresses an
 * imprecise fact in a precise number.
 */
export function elisionLabel(elision: NamespaceElision, t: TFunction): string {
  const remaining = elision.remaining
  return remaining === undefined ? t('tree.elision.unknown') : t('tree.elision.more', { count: remaining })
}
