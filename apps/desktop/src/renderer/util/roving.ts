/* ==================================================================
 * Moving a selection around a ring.
 *
 * Two places in the renderer step through a fixed list and wrap at both ends:
 * Tab inside a modal's focus trap, and the arrow keys inside a segmented
 * control. They were written months apart and arrived at the same arithmetic
 * with different signatures — `nextFocusIndex(count, current, shift)` and
 * `nextIndex(count, current, delta)` — which is the shape this session has spent
 * its time removing everywhere else. One implementation, two thin callers.
 *
 * The interesting cases are the ones that look too obvious to test: an empty
 * list, and a `current` that is not in the list at all. Both are real —
 * a dialog can contain no focusables, and a segmented control can hold a value
 * that is not among its options — and both are where an off-by-one turns into a
 * control the keyboard cannot enter.
 * ================================================================== */

/**
 * The index `delta` steps away from `current`, wrapping.
 *
 * Returns `-1` for an empty list. A `current` outside `[0, count)` resolves to
 * an end rather than to arithmetic on a meaningless number: pressing an arrow on
 * a group with nothing selected should select something, not nothing.
 */
export function wrapIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return delta >= 0 ? 0 : count - 1
  return (((current + delta) % count) + count) % count
}

/**
 * Which option holds `value`, or `-1`.
 *
 * `Object.is` rather than `===` so the numeric cases behave: the zoom control's
 * values come off a step table and round-trip through a settings file, and
 * `Object.is` additionally lets `NaN` find itself instead of reporting "nothing
 * selected" — which, under a roving tabindex, is a group with no `tabindex="0"`
 * and therefore one Tab cannot reach.
 */
export function indexOfValue<T>(options: readonly { value: T }[], value: T): number {
  return options.findIndex((o) => Object.is(o.value, value))
}
