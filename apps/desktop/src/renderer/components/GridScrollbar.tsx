import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useT } from '../i18n'
import { ROW_H, thumbGeom, type ScrollSnapshot, type VScrollDriver } from './vscroll'

/* ==================================================================
 * The hand-drawn vertical scrollbar.
 *
 * Why it has to be hand-drawn: `.grid` is `overflow-y: hidden` (the vertical axis
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
    <div className="grid-vsb" onPointerDown={onTrackDown}>
      <div
        ref={thumbRef}
        className={dragging ? 'grid-vsb-thumb dragging' : 'grid-vsb-thumb'}
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
        <div
          className="grid-vsb-bubble mono"
          style={{ top: Math.max(0, Math.min(snap.bodyH - ROW_H, geom.y)) }}
        >
          {bubbleRow + 1}
        </div>
      ) : null}
    </div>
  )
}
