/**
 * Geometric navigation over the tiled layout tree.
 *
 * Everything here is a pure function of `(tree, panelId, direction)`. That is
 * deliberate and it is the whole point of the file: the user perceives a
 * *spatial* arrangement, not a tree, so "focus the panel to the right" cannot be
 * answered by walking siblings — in `row(A, col(B, C))` the panel right of `A`
 * is `B`, which is a nephew, not a sibling. The answer only falls out once the
 * tree is turned back into rectangles.
 *
 * The rectangles are computed from the split ratios in a normalized unit square
 * rather than measured from the DOM. Two reasons:
 *   - it makes the whole thing testable in node, with no layout engine;
 *   - it matches what the user sees, because the DOM geometry is derived from
 *     exactly these ratios (`LayoutTree` sets `flexGrow` from them).
 * Panel margins and divider thickness are the only difference, and they are
 * uniform, so they cannot change which panel is on which side.
 *
 * Nothing here dispatches or reads state; the caller feeds it a `LayoutNode`.
 */

import type { LayoutNode, PanelId } from '@peek/core'
import { collectPanels, dropZonePlacement, normalizeRatio, type DropEdgeZone, type DropSplitPlacement } from '@peek/core'

/* ================================================================== */
/* 1. Directions                                                       */
/* ================================================================== */

export const DIRECTIONS = ['left', 'right', 'up', 'down'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** Arrow keys, mapped to directions. Anything else is not a navigation key. */
export function arrowDirection(key: string): Direction | null {
  switch (key) {
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    default:
      return null
  }
}

/**
 * The drop zone a direction corresponds to.
 *
 * This is what keeps the keyboard and the mouse honest: pushing a view right
 * with the keyboard resolves through the same `dropZonePlacement` table that a
 * drop on a panel's right edge does, so the two gestures can never drift into
 * producing different Commands.
 */
export function directionZone(dir: Direction): DropEdgeZone {
  switch (dir) {
    case 'left':
      return 'left'
    case 'right':
      return 'right'
    case 'up':
      return 'top'
    case 'down':
      return 'bottom'
  }
}

/** Convenience wrapper: the split a directional move asks for. */
export function directionPlacement(dir: Direction): DropSplitPlacement {
  return dropZonePlacement(directionZone(dir))
}

/* ================================================================== */
/* 2. Tree → rectangles                                                */
/* ================================================================== */

/** A panel's rectangle in a unit square: `0..1` on both axes, y pointing down. */
export interface PanelBox {
  panelId: PanelId
  left: number
  top: number
  width: number
  height: number
}

/**
 * Every panel's rectangle, depth-first (so the array order is the visual order,
 * the same order `collectPanels` produces).
 *
 * The boxes tile the unit square exactly: no gaps, no overlaps.
 */
export function panelBoxes(root: LayoutNode): PanelBox[] {
  const out: PanelBox[] = []
  layoutBoxes(root, 0, 0, 1, 1, out)
  return out
}

function layoutBoxes(
  node: LayoutNode,
  left: number,
  top: number,
  width: number,
  height: number,
  out: PanelBox[],
): void {
  if (node.type === 'panel') {
    out.push({ panelId: node.id, left, top, width, height })
    return
  }
  const ratio = normalizeRatio(node.ratio, node.children.length)
  let offset = 0
  node.children.forEach((child, i) => {
    const share = ratio[i]
    if (node.dir === 'row') {
      layoutBoxes(child, left + offset * width, top, share * width, height, out)
    } else {
      layoutBoxes(child, left, top + offset * height, width, share * height, out)
    }
    offset += share
  })
}

/** The panel at a visual position (0-based), for the "focus the Nth panel" shortcut. */
export function panelIdAt(root: LayoutNode, index: number): PanelId | null {
  const panels = collectPanels(root)
  if (index < 0 || index >= panels.length) return null
  return panels[index].id
}

/* ================================================================== */
/* 3. Directional lookup                                               */
/* ================================================================== */

/**
 * Tolerance for "is this edge the same as that one". Boxes are built from
 * repeated multiplications of ratios, so two panels that share an edge agree on
 * it to within rounding, not exactly.
 */
const EPS = 1e-9

interface Candidate {
  panelId: PanelId
  /** Distance along the direction axis, from the source's far edge to the candidate's near edge. */
  gap: number
  /** Length of the shared span on the perpendicular axis. */
  overlap: number
  /** The candidate's near coordinate on the perpendicular axis, used to break ties top-first / left-first. */
  perpStart: number
}

/**
 * The panel a directional move lands on, or `null` when the source panel already
 * touches that side of the window.
 *
 * Selection rules, in order:
 *   1. only panels **beyond** the source's far edge on that axis are candidates;
 *   2. panels that overlap the source's perpendicular span win over ones that do
 *      not — a neighbour you can see across the shared edge beats one reachable
 *      only diagonally;
 *   3. then the smallest gap: the panel immediately adjacent, not one behind it;
 *   4. then the largest overlap: with `A` facing `B` (top) and `C` (bottom),
 *      whichever shares more of `A`'s edge is the better answer;
 *   5. then the smaller perpendicular start (top-most, then left-most), and
 *      finally the panel id.
 *
 * Rules 4 and 5 exist so the function is **total and deterministic**: in a
 * symmetric layout several panels are equally good, and picking by id last means
 * the same tree and the same keypress always move focus to the same place. A
 * navigation key that lands somewhere different each time is worse than one that
 * lands somewhere arguable.
 */
export function findPanelInDirection(
  root: LayoutNode,
  from: PanelId,
  dir: Direction,
): PanelId | null {
  const boxes = panelBoxes(root)
  const source = boxes.find((b) => b.panelId === from)
  if (!source) return null

  const horizontal = dir === 'left' || dir === 'right'
  const candidates: Candidate[] = []

  for (const box of boxes) {
    if (box.panelId === source.panelId) continue
    const gap = gapAlong(source, box, dir)
    if (gap < -EPS) continue
    candidates.push({
      panelId: box.panelId,
      gap,
      overlap: horizontal
        ? spanOverlap(source.top, source.height, box.top, box.height)
        : spanOverlap(source.left, source.width, box.left, box.width),
      perpStart: horizontal ? box.top : box.left,
    })
  }
  if (candidates.length === 0) return null

  candidates.sort(compareCandidates)
  return candidates[0].panelId
}

/** Distance from the source's far edge to the candidate's near edge; negative means the candidate is not on that side. */
function gapAlong(source: PanelBox, box: PanelBox, dir: Direction): number {
  switch (dir) {
    case 'left':
      return source.left - (box.left + box.width)
    case 'right':
      return box.left - (source.left + source.width)
    case 'up':
      return source.top - (box.top + box.height)
    case 'down':
      return box.top - (source.top + source.height)
  }
}

function spanOverlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart))
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const aTouches = a.overlap > EPS
  const bTouches = b.overlap > EPS
  if (aTouches !== bTouches) return aTouches ? -1 : 1
  if (Math.abs(a.gap - b.gap) > EPS) return a.gap - b.gap
  if (Math.abs(a.overlap - b.overlap) > EPS) return b.overlap - a.overlap
  if (Math.abs(a.perpStart - b.perpStart) > EPS) return a.perpStart - b.perpStart
  return a.panelId < b.panelId ? -1 : a.panelId > b.panelId ? 1 : 0
}
