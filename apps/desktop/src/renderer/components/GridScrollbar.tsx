import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useT } from '../i18n'
import { ROW_H, thumbGeom, type ScrollSnapshot, type VScrollDriver } from './vscroll'

/* ==================================================================
 * The hand-drawn vertical scrollbar.
 *
 * Why it has to be hand-drawn: `.grid-scroll` is `overflow-y: hidden` (the vertical axis
 * has no DOM size at all — see the top of vscroll.ts), so there is no native
 * vertical scrollbar to have.
 *
 * The physical floor on drag precision: a 600px track over 1M rows is ~1736 rows
 * per pixel, and ~17,361 rows per pixel over 10M. **A native scrollbar is exactly
 * the same**; that ratio is inherent to mapping unbounded rows onto a bounded
 * track, not something this implementation introduces. What it does add is a way
 * out: Shift-drag for 10× precision, Option-drag for 50×, and a live row-number
 * bubble while dragging.
 * ================================================================== */

interface DragState {
  pointerId: number
  grabY: number
  startTop: number
}

export interface GridScrollbarProps {
  driver: VScrollDriver
  snap: ScrollSnapshot
  /** ref callback for the thumb: the driver writes its transform directly, bypassing React. */
  thumbRef: (el: HTMLDivElement | null) => void
}

export function GridScrollbar(p: GridScrollbarProps): ReactElement | null {
  const t = useT()
  const { driver, snap, thumbRef } = p
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bubbleRow, setBubbleRow] = useState(0)

  const geom = thumbGeom(snap, snap.bodyH)

  const onThumbDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { pointerId: e.pointerId, grabY: e.clientY, startTop: driver.metrics.top }
      setBubbleRow(driver.metrics.visibleFirst)
      setDragging(true)
    },
    [driver],
  )

  const onThumbMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      const m = driver.metrics
      const g = thumbGeom(m, m.bodyH)
      if (g.travel <= 0) return
      // Shift 10×, Option 50×: a coarse mode of 1736 rows per pixel needs a fine one
      const gain = e.altKey ? 0.02 : e.shiftKey ? 0.1 : 1
      driver.scrollTo(d.startTop + ((e.clientY - d.grabY) * gain * m.maxTop) / g.travel)
      setBubbleRow(driver.metrics.visibleFirst)
    },
    [driver],
  )

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
  }, [])

  const onTrackDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const m = driver.metrics
      const g = thumbGeom(m, m.bodyH)
      if (!g.visible) return
      const y = e.clientY - e.currentTarget.getBoundingClientRect().top
      // Matching macOS: page by default, Option-click jumps straight to the spot
      if (e.altKey) {
        driver.scrollTo(g.travel > 0 ? ((y - g.height / 2) / g.travel) * m.maxTop : 0)
      } else {
        driver.scrollBy(y < g.y ? -m.bodyH : m.bodyH)
      }
    },
    [driver],
  )

  if (!geom.visible) return null

  return (
    /*
     * The track. Positioned against `.grid-wrap`, **not** `.grid-scroll` — see the note
     * on wrapRef in DataGrid.tsx: absolute descendants of a horizontal scroll
     * container travel with scrollLeft, so inside `.grid-scroll` this whole control
     * slides out of view and stops taking clicks on the first sideways scroll.
     * `grid-vsb` stays a name because that containment is what
     * grid-layout.test.ts guards, and it identifies the node by it.
     *
     * `w-2.75` is 11px, the same 11px `::-webkit-scrollbar` is given in base.css
     * — a hand-drawn scrollbar that is not the width of the native one reads as
     * a different kind of thing. The two are written as two numbers because the
     * theme has no token for a scrollbar's width; if a third ever appears, that
     * is the moment to name it.
     */
    <div className="grid-vsb absolute top-head right-0 bottom-0 w-2.75 z-6" onPointerDown={onTrackDown}>
      {/*
       * Solid, not a 40%-opacity wash. There is no native vertical scrollbar
       * behind this one (see the top of vscroll.ts), so it is the only vertical
       * navigation affordance a million-row result set has — and at
       * --color-fg-faint × 0.4 it measured 1.46:1 against the grid, i.e. you had
       * to know it was there. It now clears the 3:1 that WCAG 1.4.11 asks of a
       * control boundary, and brightens to full --color-fg-faint under the
       * pointer. Asserted in theme-contrast.test.ts.
       *
       * The two states are alternatives rather than a base plus an override: a
       * class list has no cascade, so `bg-border-strong bg-fg-faint` would be
       * decided by Tailwind's emission order and not by ours.
       */}
      <div
        ref={thumbRef}
        className={
          dragging
            ? 'absolute top-0 left-0.5 right-0.5 rounded-control cursor-default will-change-transform bg-fg-faint'
            : 'absolute top-0 left-0.5 right-0.5 rounded-control cursor-default will-change-transform bg-border-strong hover:bg-fg-faint'
        }
        style={{ height: geom.height, transform: `translate3d(0,${geom.y}px,0)` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="scrollbar"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={snap.rowCount}
        aria-valuenow={snap.visibleFirst + 1}
        aria-label={t('grid.scrollbarLabel')}
        tabIndex={-1}
      />
      {dragging ? (
        /* 3px of corner radius became 4 (`rounded-control`), the one number in this
           module that is not what it was. The theme's radius scale has no 3px
           rung, and a token whose only argument is "the old number was that" is
           not a token — the same call phase 1 made for the gallery card. It is
           a transient drag-time readout and it now matches the thumb beside it. */
        <div
          className="absolute right-3.75 py-px px-tight border border-border-strong rounded-control bg-bg-3 text-fg text-micro whitespace-nowrap pointer-events-none font-mono tabular-nums"
          style={{ top: Math.max(0, Math.min(snap.bodyH - ROW_H, geom.y)) }}
        >
          {bubbleRow + 1}
        </div>
      ) : null}
    </div>
  )
}
