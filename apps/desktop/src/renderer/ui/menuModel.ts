import type { MenuTone } from './spec'

/* ==================================================================
 * The parts of a popup menu that are decisions rather than DOM.
 *
 * Placement, "which lines can the arrow keys reach", and the confirm swap are
 * all pure functions here, so they can be asserted without a browser — the same
 * split `contextActionsFor` already uses for menu *contents*. What is left in
 * `Menu.tsx` is markup and event wiring.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md
 * ================================================================== */

/* ------------------------------------------------------------------
 * What a menu is made of
 * ------------------------------------------------------------------ */

export interface MenuItemNode {
  kind: 'item'
  /** Unique within one menu; also the test handle. */
  id: string
  label: string
  /** Tooltip, for the part the label had to leave out. */
  title?: string
  disabled?: boolean
  tone?: MenuTone
  /**
   * Turns this item into a two-step act.
   *
   * Choosing it does **not** call `onSelect`. The menu replaces its whole
   * contents with a cancel line — which takes the focus — and this item again,
   * relabelled with the string given here. That is `ConfirmPair`'s actual
   * guarantee: not "two clicks", but "the second click lands somewhere
   * harmless", which a menu can only offer by moving the item.
   */
  confirm?: string
  onSelect: () => void
}

export type MenuNode =
  | MenuItemNode
  /** A heading over a group. Not reachable, not clickable. */
  | { kind: 'head'; id: string; text: string }
  /** A line that explains why the items nearby are missing or greyed. */
  | { kind: 'note'; id: string; text: string; tone?: MenuTone }
  | { kind: 'sep'; id: string }

/** The lines the arrow keys visit: enabled items, in order. */
export function selectableItems(nodes: readonly MenuNode[]): MenuItemNode[] {
  return nodes.filter((n): n is MenuItemNode => n.kind === 'item' && n.disabled !== true)
}

/**
 * Where ↑/↓/Home/End go from here.
 *
 * Wraps at both ends, the way every native menu does, and returns `null` for a
 * menu with nothing to land on so the caller does not have to special-case an
 * all-disabled menu.
 */
export function nextItemIndex(
  count: number,
  current: number,
  key: 'up' | 'down' | 'home' | 'end',
): number | null {
  if (count === 0) return null
  switch (key) {
    case 'home':
      return 0
    case 'end':
      return count - 1
    case 'down':
      return current < 0 || current >= count - 1 ? 0 : current + 1
    case 'up':
      return current <= 0 ? count - 1 : current - 1
  }
}

/* ------------------------------------------------------------------
 * The confirm swap
 * ------------------------------------------------------------------ */

export interface ConfirmLabels {
  cancel: string
}

/**
 * The menu a `confirm` item turns into.
 *
 * Cancel comes first on purpose — it is what the arrow keys land on and what
 * `Menu` focuses, so the gesture that armed this cannot also fire it. The armed
 * item keeps its id, so a test can assert the same act is being offered.
 */
export function confirmNodes(item: MenuItemNode, labels: ConfirmLabels, onCancel: () => void): MenuNode[] {
  return [
    { kind: 'item', id: `${item.id}.cancel`, label: labels.cancel, onSelect: onCancel },
    {
      kind: 'item',
      id: item.id,
      label: item.confirm ?? item.label,
      tone: 'danger',
      onSelect: item.onSelect,
    },
  ]
}

/* ------------------------------------------------------------------
 * Placement
 * ------------------------------------------------------------------ */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** How close a menu may come to the window edge. */
export const MENU_EDGE_GAP = 8

/**
 * Put the menu at the pointer, and keep all of it on screen.
 *
 * Down-and-right first, because that is where a pointer user expects the menu to
 * unfold. When it does not fit, the menu **flips to the other side of the
 * pointer** rather than sliding — sliding is what the old fixed-size estimate
 * did, and it put the menu's middle under the cursor when you right-clicked near
 * the bottom of the window. Clamping is the last resort, for a menu taller than
 * the viewport itself.
 */
export function placeMenu(at: Point, size: Size, viewport: Size): Point {
  return {
    x: axis(at.x, size.width, viewport.width),
    y: axis(at.y, size.height, viewport.height),
  }
}

function axis(at: number, extent: number, limit: number): number {
  const forward = at + extent + MENU_EDGE_GAP <= limit
  if (forward) return at
  const flipped = at - extent
  if (flipped >= MENU_EDGE_GAP) return flipped
  return Math.max(MENU_EDGE_GAP, limit - extent - MENU_EDGE_GAP)
}
