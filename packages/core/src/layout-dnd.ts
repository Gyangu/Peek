/**
 * Drop-zone geometry for dragging a view between panels.
 *
 * This lives in core, not in the renderer, for the same reason the layout tree
 * does: the mapping from "where the cursor is" to "which Command runs" is part
 * of the contract, not an implementation detail of one component. The renderer
 * measures a rectangle and calls `resolveDropZone`; main's handlers and the unit
 * tests reason about the same five zones. Nothing here touches the DOM, so it is
 * testable without a browser.
 *
 * The model follows VS Code / JetBrains: a band along each of the four edges
 * means "split in that direction and put the dragged view in the new panel", and
 * everything inside means "move the view into this panel".
 */

/* ================================================================== */
/* 1. Zones                                                            */
/* ================================================================== */

export const DROP_ZONES = ['center', 'left', 'right', 'top', 'bottom'] as const
export type DropZone = (typeof DROP_ZONES)[number]

/** An edge zone; `center` is deliberately excluded, because it maps to a different Command. */
export type DropEdgeZone = Exclude<DropZone, 'center'>

export function isDropEdgeZone(zone: DropZone): zone is DropEdgeZone {
  return zone !== 'center'
}

/* ================================================================== */
/* 2. Band geometry                                                    */
/* ================================================================== */

/**
 * Thickness of an edge band as a fraction of the panel dimension, clamped into
 * `[DROP_EDGE_MIN_PX, DROP_EDGE_MAX_PX]`.
 *
 * A pure fraction is wrong at both ends: at 25% a 2000px-wide panel would give a
 * 500px band that swallows most of the panel, and a 120px panel would give a
 * 30px band that is hard to hit on either side of the centre. The clamp keeps the
 * band a comfortable target at every size.
 */
export const DROP_EDGE_RATIO = 0.25
export const DROP_EDGE_MIN_PX = 24
export const DROP_EDGE_MAX_PX = 96

export function edgeBand(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0
  return Math.min(DROP_EDGE_MAX_PX, Math.max(DROP_EDGE_MIN_PX, size * DROP_EDGE_RATIO))
}

/** Panel rectangle, in CSS pixels. Only the size matters; the caller converts to panel-local coordinates. */
export interface DropRect {
  width: number
  height: number
}

/**
 * Which zone a panel-local point falls into.
 *
 * `x` / `y` are relative to the panel's top-left corner and are clamped into the
 * rectangle, so a cursor a pixel outside still resolves to the nearest edge
 * rather than to `center`.
 *
 * The comparison is on **normalized penetration** — the distance to an edge
 * divided by that edge's own band thickness — which is what makes corners
 * behave: on a wide, short panel the top and bottom bands are thin, so a corner
 * point resolves to the edge it is proportionally deepest into, not to whichever
 * happens to be fewer pixels away.
 *
 * A band pair switches off entirely when the panel is too small to host it
 * (`2 * band >= size`), leaving `center` as the only outcome along that axis.
 * Without that rule a 60px-tall panel would have no reachable centre at all.
 *
 * Ties resolve in the order left, right, top, bottom. The order is arbitrary but
 * fixed, so the same pixel always produces the same Command.
 */
export function resolveDropZone(rect: DropRect, x: number, y: number): DropZone {
  const { width, height } = rect
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'center'

  const px = Math.min(Math.max(x, 0), width)
  const py = Math.min(Math.max(y, 0), height)

  const bandX = edgeBand(width)
  const bandY = edgeBand(height)
  const horizontal = bandX > 0 && bandX * 2 < width
  const vertical = bandY > 0 && bandY * 2 < height

  const nl = horizontal ? px / bandX : Number.POSITIVE_INFINITY
  const nr = horizontal ? (width - px) / bandX : Number.POSITIVE_INFINITY
  const nt = vertical ? py / bandY : Number.POSITIVE_INFINITY
  const nb = vertical ? (height - py) / bandY : Number.POSITIVE_INFINITY

  const best = Math.min(nl, nr, nt, nb)
  if (!(best < 1)) return 'center'
  if (nl === best) return 'left'
  if (nr === best) return 'right'
  if (nt === best) return 'top'
  return 'bottom'
}

/* ================================================================== */
/* 3. Zone → split placement                                           */
/* ================================================================== */

export interface DropSplitPlacement {
  dir: 'row' | 'col'
  insert: 'before' | 'after'
}

/**
 * The split a given edge zone asks for. Shared so the renderer, the handler and
 * the tests cannot disagree about which way "top" splits.
 */
export function dropZonePlacement(zone: DropEdgeZone): DropSplitPlacement {
  switch (zone) {
    case 'left':
      return { dir: 'row', insert: 'before' }
    case 'right':
      return { dir: 'row', insert: 'after' }
    case 'top':
      return { dir: 'col', insert: 'before' }
    case 'bottom':
      return { dir: 'col', insert: 'after' }
  }
}

/**
 * Highlight rectangle for a drop zone, as fractions of the panel rectangle
 * (`0..1`). The renderer multiplies by the panel's own size; expressing it here
 * keeps the preview and the resulting layout describing the same thing.
 *
 * An edge preview covers half the panel because that is what the split produces:
 * `splitPanel` gives the new panel an even share of the panel it split.
 */
export interface DropHighlight {
  left: number
  top: number
  width: number
  height: number
}

export function dropZoneHighlight(zone: DropZone): DropHighlight {
  switch (zone) {
    case 'center':
      return { left: 0, top: 0, width: 1, height: 1 }
    case 'left':
      return { left: 0, top: 0, width: 0.5, height: 1 }
    case 'right':
      return { left: 0.5, top: 0, width: 0.5, height: 1 }
    case 'top':
      return { left: 0, top: 0, width: 1, height: 0.5 }
    case 'bottom':
      return { left: 0, top: 0.5, width: 1, height: 0.5 }
  }
}

/* ================================================================== */
/* 4. The tab strip                                                    */
/* ================================================================== */

/**
 * A layer **above** the five zones, not a sixth zone.
 *
 * Adding `'tabbar'` to `DROP_ZONES` was considered and rejected: every one of
 * `dropZonePlacement`, `dropZoneHighlight` and `isDropEdgeZone` is total over
 * `DropZone`, and widening the union would force all three (and their tests) to
 * grow a case that means something different in kind — a caret between two tabs
 * is not a rectangle to highlight. The discriminated union below keeps the two
 * kinds of answer apart, and leaves the functions above untouched.
 *
 * The other half of the split matters just as much: **the five-zone geometry now
 * runs on the panel's body rectangle, not on the whole panel.** The strip takes
 * its own band off the top, and the edge bands have to be measured against what
 * is left — otherwise on a short panel the top band would swallow the entire
 * body, and no point in it would resolve to `center` at all.
 */

/** One tab's horizontal extent, in the same coordinate space as the `x` it is tested against. */
export interface TabRect {
  left: number
  width: number
}

export type PanelDrop =
  | { kind: 'zone'; zone: DropZone }
  | { kind: 'tab'; caret: number }

/**
 * The insertion caret for a pointer over the tab strip: the number of tabs whose
 * midpoint lies to the left of `x`, so the result is in `[0, tabRects.length]`
 * and names a gap rather than a tab. Zero is "before the first tab", `length` is
 * "after the last one".
 *
 * A midpoint exactly under the pointer counts as being to the right, so the
 * caret sits *before* that tab; the choice is arbitrary but fixed, for the same
 * reason `resolveDropZone` breaks its ties in a documented order.
 *
 * `tabRects` is expected in tab-bar order (P6). Nothing here sorts it — the
 * order *is* the state under test.
 */
export function resolveTabInsertCaret(tabRects: readonly TabRect[], x: number): number {
  let caret = 0
  for (const rect of tabRects) {
    const mid = rect.left + rect.width / 2
    if (Number.isFinite(mid) && mid < x) caret += 1
  }
  return caret
}

/**
 * Caret position → the `index` field of `layout.moveView`.
 *
 * The two are not the same number, and the difference is the classic off-by-one
 * of every tab strip. A caret counts gaps in the strip **as it looks now**, with
 * the dragged tab still in it; `index` is the view's position **after** it has
 * been detached (see `LayoutMoveViewInputSchema.index`). Dragging a tab
 * rightwards within its own panel therefore has to lose one, because every gap
 * past the tab's old home shifts left when it is lifted out.
 *
 * `fromIndex` is the dragged view's current index in *this* panel, or `null`
 * when it comes from somewhere else (or from nowhere) and so is not occupying a
 * slot in this strip.
 */
export function tabDropIndex(caret: number, fromIndex: number | null): number {
  if (fromIndex === null) return caret
  return caret > fromIndex ? caret - 1 : caret
}

/** A panel's drop geometry: its own box, the strip's band, and the tabs in it. */
export interface PanelDropGeometry {
  width: number
  height: number
  /** Height of the tab strip band along the top. 0 for a panel measured without one. */
  tabBarHeight: number
  /** Tab extents in panel-local x, in tab-bar order. */
  tabRects: readonly TabRect[]
}

/**
 * Where a drop on this panel would land, given a panel-local point.
 *
 * The strip band wins outright when the pointer is inside it — including the
 * part of the band occupied by the panel's action buttons, where the caret comes
 * out past the last tab and the drop appends. Everything below the band is
 * resolved by `resolveDropZone` against the **body** rectangle, with `y` rebased
 * so that the body's own top edge is 0.
 */
export function resolvePanelDrop(geom: PanelDropGeometry, x: number, y: number): PanelDrop {
  const band = Number.isFinite(geom.tabBarHeight) ? Math.max(0, geom.tabBarHeight) : 0
  if (band > 0 && y >= 0 && y < band) {
    return { kind: 'tab', caret: resolveTabInsertCaret(geom.tabRects, x) }
  }
  const body = { width: geom.width, height: geom.height - band }
  return { kind: 'zone', zone: resolveDropZone(body, x, y - band) }
}
