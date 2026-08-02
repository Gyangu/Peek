/**
 * Which dialog owns the Escape key, and where Tab goes at the edge of one.
 *
 * Both are pure functions of state that has nothing to do with the DOM, which is
 * why they live apart from the hook that uses them: the bug they prevent is a
 * behavioural one, and it is asserted directly rather than through a rendered
 * tree.
 *
 * ## The bug this exists for
 *
 * Every modal in peek registered its own `keydown` listener on `window` and
 * closed on Escape without stopping the event. `ValueModal`, `SettingsDialog`,
 * `ContextMenu` and `ConsentDialog` all did it, and so did `DataGrid`, whose
 * Escape clears the row selection. So one press of Escape with a value modal
 * open over a grid did two things: closed the modal **and** discarded a row
 * selection the user may have spent a minute building. Nothing about that is
 * discoverable — the selection is behind the dialog that is closing.
 *
 * A stack fixes it without any component having to know about the others: the
 * topmost dialog consumes the key, everything below it hears nothing.
 */

export type ModalId = symbol

const stack: ModalId[] = []

export function pushModal(label: string): ModalId {
  const id = Symbol(label)
  stack.push(id)
  return id
}

export function popModal(id: ModalId): void {
  const index = stack.lastIndexOf(id)
  // Not necessarily the last one: React can unmount an outer dialog before an
  // inner one in some orders, and removing by identity keeps the rest intact.
  if (index >= 0) stack.splice(index, 1)
}

export function isTopModal(id: ModalId): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

export function modalDepth(): number {
  return stack.length
}

/** Tests only: the stack is process-wide, so a test that leaks one poisons the next. */
export function resetModalStack(): void {
  stack.length = 0
}

/**
 * Where Tab should land, given the focusables inside a dialog.
 *
 * `current` is the index of the focused element, or `-1` when focus has escaped
 * the dialog entirely (which is the case this is really for: a programmatic
 * focus elsewhere, or a browser that moved focus to the document body).
 *
 * Returns `null` when there is nothing to focus, in which case the caller should
 * still swallow the key — a Tab that walks out of a modal into the window behind
 * it is the thing being prevented, and "the dialog has no controls" is not a
 * reason to allow it.
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number | null {
  if (count <= 0) return null
  if (current < 0) return shift ? count - 1 : 0
  if (shift) return current === 0 ? count - 1 : current - 1
  return current === count - 1 ? 0 : current + 1
}
