/* ==================================================================
 * The vertical virtual-scroll driver — the vertical axis has no DOM size at all.
 *
 * ## Why a `rowCount × ROW_H` spacer cannot work
 *
 * Chromium caps the layout height of a single element (≈ 2^25 device pixels /
 * devicePixelRatio: dpr=1 → 33,554,248px, dpr=2 → 16,777,214px, dpr=3 →
 * 11,184,809px). 901k rows × 24px = 21,624,026px gets **silently** clamped to
 * 16,777,214 on a Retina display, so the last reachable row is 694,060 and the
 * 200k rows behind it can never be seen. The cap is not even a constant, so
 * hardcoding a "safe" value just moves the failure to the next external display
 * or the next zoomFactor change.
 *
 * The fix: **no dimension anywhere in the DOM is derived from rowCount**.
 * - `.grid-scroll` becomes `overflow-x: auto; overflow-y: hidden`, so the horizontal
 *   axis stays native scrolling (total width tops out in the hundreds of
 *   thousands of pixels — two orders of magnitude below the cap — and colVirt
 *   and the sticky gutter need no changes at all);
 * - the vertical position is just a JS double `top` in virtual pixels. Nothing
 *   reads a DOM size for it, so there is nothing left to clamp. 100M rows × 24px
 *   = 2.4e9, still a safe integer.
 *
 * ## Two precision traps (both avoided)
 *
 * A. Changing every row's top every frame would change row props every frame,
 *    and GridRow's memo would stop bailing out entirely.
 * B. Putting the whole offset on the parent's transform means 2.4e8 px at 10M
 *    rows, and the compositor's transform matrix is float32 on some paths — one
 *    ULP at 2.4e8 is already 16px, enough to visibly misplace text.
 *
 * The answer is a **block origin**: origin = floor(top / ORIGIN_BLOCK_PX) *
 * ORIGIN_BLOCK_PX.
 * - the surface transform is origin - top, always within (-98304, 0];
 * - a row's top is i*ROW_H - origin + HEAD_H, which only changes when a 4096-row
 *   boundary is crossed.
 * Every vertical pixel quantity that reaches the DOM therefore stays under 100k
 * px (float32 ULP there is 0.0078px, i.e. lossless), while memo bail-out stays at
 * ~99.98%.
 *
 * ## This module is deliberately pure
 * computeScroll never touches the DOM, so node:test can assert on 1M / 10M / 100M
 * rows directly.
 * ================================================================== */

export const ROW_H = 24
export const HEAD_H = 26
export const ROW_OVERSCAN = 10

/** Block size of the origin: 4096 rows = 98,304px. */
export const ORIGIN_BLOCK_ROWS = 4096
export const ORIGIN_BLOCK_PX = ORIGIN_BLOCK_ROWS * ROW_H

/** Minimum height of the hand-drawn thumb. */
export const MIN_THUMB_H = 24

export interface ScrollSnapshot {
  /** Vertical offset in virtual pixels — the single source of truth. */
  readonly top: number
  /** The current block origin. */
  readonly origin: number
  readonly maxTop: number
  readonly rowCount: number
  /** Visible height below the header. */
  readonly bodyH: number
  /** Rows to render, overscan included; with rowCount 0, renderLast < renderFirst. */
  readonly renderFirst: number
  readonly renderLast: number
  /** Rows actually visible (reported to resultCache for LRU protection and ack release). */
  readonly visibleFirst: number
  readonly visibleLast: number
  /** Pinned to the end of the scrollable range, unable to advance (the fallback
   *  signal for ack backpressure). */
  readonly atBottom: boolean
}

export const EMPTY_SCROLL: ScrollSnapshot = {
  top: 0,
  origin: 0,
  maxTop: 0,
  rowCount: 0,
  bodyH: 0,
  renderFirst: 0,
  renderLast: -1,
  visibleFirst: 0,
  visibleLast: -1,
  atBottom: true,
}

/**
 * The **single implementation** of the geometry. Pure, never touches the DOM.
 *
 * @param dpr Device pixel ratio: quantizes `top` onto the device pixel grid, so a
 *            fractional transform cannot blur the monospace text.
 */
export function computeScroll(
  rowCount: number,
  viewportH: number,
  rawTop: number,
  dpr = 1,
): ScrollSnapshot {
  const rows = Math.max(0, Math.floor(rowCount))
  const bodyH = Math.max(0, viewportH - HEAD_H)
  const maxTop = Math.max(0, rows * ROW_H - bodyH)

  const q = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const raw = Number.isFinite(rawTop) ? rawTop : 0
  const top = Math.min(maxTop, Math.max(0, Math.round(raw * q) / q))

  if (rows === 0) return { ...EMPTY_SCROLL, bodyH, maxTop: 0 }

  const lastRow = rows - 1
  const visibleFirst = Math.min(lastRow, Math.max(0, Math.floor(top / ROW_H)))
  const visibleLast = Math.min(lastRow, Math.max(visibleFirst, Math.ceil((top + bodyH) / ROW_H) - 1))

  return {
    top,
    origin: Math.floor(top / ORIGIN_BLOCK_PX) * ORIGIN_BLOCK_PX,
    maxTop,
    rowCount: rows,
    bodyH,
    renderFirst: Math.max(0, visibleFirst - ROW_OVERSCAN),
    renderLast: Math.min(lastRow, visibleLast + ROW_OVERSCAN),
    visibleFirst,
    visibleLast,
    // Content that fits entirely (maxTop === 0) also counts as "cannot advance":
    // what you see is already everything
    atBottom: maxTop <= 0 || top >= maxTop - 0.5,
  }
}

/** Top of row `i` in surface coordinates (the surface itself carries an
 *  `origin - top` transform on top of this). */
export function rowTopIn(index: number, origin: number): number {
  return index * ROW_H + HEAD_H - origin
}

/** Geometry of the hand-drawn thumb. `trackH` is simply `bodyH`. */
export interface ThumbGeom {
  /** A scrollbar is needed at all (the content does not fit). */
  readonly visible: boolean
  readonly height: number
  readonly y: number
  /** Pixels of travel available to the thumb. */
  readonly travel: number
}

export function thumbGeom(snap: ScrollSnapshot, trackH: number): ThumbGeom {
  const contentH = snap.rowCount * ROW_H
  if (snap.maxTop <= 0 || trackH <= 0 || contentH <= 0) {
    return { visible: false, height: 0, y: 0, travel: 0 }
  }
  const height = Math.max(MIN_THUMB_H, Math.min(trackH, Math.round((trackH * snap.bodyH) / contentH)))
  const travel = Math.max(0, trackH - height)
  return { visible: true, height, y: Math.round((snap.top / snap.maxTop) * travel), travel }
}

export type ViewportSink = (first: number, last: number, atBottom: boolean) => void

/**
 * The driver: owns `top`, derives the snapshot, writes the two DOM transforms
 * (surface and thumb) directly, and only notifies React when the **row window
 * actually moves**.
 *
 * In other words, scrolling within a screenful never reaches React at all: one
 * style write, composited, no layout and no repaint.
 */
export class VScrollDriver {
  /** The row surface; its transform is origin - top. */
  surface: HTMLElement | null = null
  /** The hand-drawn thumb; the driver writes its height/transform, bypassing React. */
  thumb: HTMLElement | null = null
  /**
   * Where the viewport is reported. Called **synchronously**, without waiting for
   * a React commit — which is what decouples "does backpressure engage" from
   * render timing.
   */
  onViewport: ViewportSink | null = null

  private rawTop = 0
  private viewportH = 0
  private rowCount = 0
  private dpr = 1
  /**
   * **The block origin the rows currently in the DOM were laid out against**,
   * written back by the render layer after React commits.
   *
   * The surface transform must match this value rather than `snap.origin`: the
   * instant a 4096-row boundary is crossed, snap.origin changes, but the rows in
   * the DOM still carry the old origin (React only swaps them on the next
   * commit). Writing the transform against the new origin right then would put
   * the two a full block apart (98,304px) — one blank frame on screen. With
   * domOrigin, the transform and the row tops always come from the same origin,
   * so a late React commit costs at most a stalled frame, never a misplaced one.
   */
  private domOrigin = 0
  private snap: ScrollSnapshot = EMPTY_SCROLL
  /** The copy useSyncExternalStore reads: a new reference only when subscribers
   *  are notified, so it can never tear. */
  private viewSnap: ScrollSnapshot = EMPTY_SCROLL
  private readonly subs = new Set<() => void>()

  getSnapshot = (): ScrollSnapshot => this.viewSnap

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb)
    return (): void => {
      this.subs.delete(cb)
    }
  }

  /** The current geometry, read imperatively — for event handlers. */
  get metrics(): ScrollSnapshot {
    return this.snap
  }

  get maxTop(): number {
    return this.snap.maxTop
  }

  setGeometry(viewportH: number, rowCount: number, dpr: number): void {
    if (viewportH === this.viewportH && rowCount === this.rowCount && dpr === this.dpr) return
    this.viewportH = viewportH
    this.rowCount = rowCount
    this.dpr = dpr
    // rawTop is left alone, so rows streaming in keep the user's eye on the same
    // row instead of drifting under it
    this.commit(this.rawTop, true)
  }

  scrollTo(px: number): void {
    this.commit(px, false)
  }

  scrollBy(dy: number): void {
    this.commit(this.rawTop + dy, false)
  }

  /** Jump to a row. Exact at any row count — the key win over native scrolling. */
  scrollToRow(index: number, align: 'start' | 'center' = 'start'): void {
    const base = index * ROW_H
    this.commit(align === 'center' ? base - (this.snap.bodyH - ROW_H) / 2 : base, false)
  }

  /** New result set: back to the top. */
  reset(): void {
    this.rawTop = 0
    this.commit(0, true)
  }

  /**
   * The render layer reporting which origin the current batch of rows was laid
   * out against. Must be called after React commits (useLayoutEffect), and only
   * ever with the origin used by that very render.
   */
  syncDomOrigin(origin: number): void {
    if (this.domOrigin === origin) return
    this.domOrigin = origin
    this.paint()
  }

  /** The origin the current surface transform is based on (for tests and asserts). */
  get paintedOrigin(): number {
    return this.domOrigin
  }

  /** Repaint once the DOM node is attached (React ref callbacks run after commit). */
  paint(): void {
    const { surface, thumb, snap } = this
    // domOrigin, not snap.origin — see the note on domOrigin
    if (surface) surface.style.transform = `translate3d(0,${this.domOrigin - snap.top}px,0)`
    if (thumb) {
      const g = thumbGeom(snap, snap.bodyH)
      thumb.style.display = g.visible ? '' : 'none'
      thumb.style.height = `${g.height}px`
      thumb.style.transform = `translate3d(0,${g.y}px,0)`
    }
  }

  private commit(next: number, force: boolean): void {
    const prev = this.snap
    const snap = computeScroll(this.rowCount, this.viewportH, next, this.dpr)
    if (!force && snap.top === prev.top && snap.rowCount === prev.rowCount
      && snap.bodyH === prev.bodyH) {
      return
    }
    this.snap = snap
    // Always store the clamped position: a fling that hits the end must not bank
    // the overshoot, or the user has to scroll a long way back before anything moves
    this.rawTop = snap.top

    // Report the viewport synchronously: ack release and LRU protection do not wait for React
    if (snap.visibleLast >= snap.visibleFirst) {
      this.onViewport?.(snap.visibleFirst, snap.visibleLast, snap.atBottom)
    }

    this.paint()

    // The row window did not move, so leave React alone: scrolling within a
    // screenful is nothing but the two style writes above
    if (
      snap.renderFirst !== prev.renderFirst
      || snap.renderLast !== prev.renderLast
      || snap.origin !== prev.origin
      || snap.rowCount !== prev.rowCount
      || snap.maxTop !== prev.maxTop
    ) {
      // viewSnap and the notification must move together: getSnapshot may only
      // return a new reference after subscribers have been told, or React reads
      // it as a tear
      this.viewSnap = snap
      for (const cb of [...this.subs]) cb()
    }
  }
}
