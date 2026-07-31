import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { ROW_H, thumbGeom, type ScrollSnapshot, type VScrollDriver } from './vscroll'

/* ==================================================================
 * 自绘纵向滚动条。
 *
 * 为什么必须自绘：`.grid` 已经是 overflow-y:hidden（纵轴脱离 DOM 尺寸，
 * 见 vscroll.ts 顶部），原生纵向滚动条根本不存在。
 *
 * 拖拽粒度的物理下限：600px 轨道 / 100 万行 ≈ 1px 1736 行，
 * 1000 万行 ≈ 1px 17361 行。**这和原生滚动条一模一样**，是"有限长度轨道映射
 * 无限行"的固有属性，不是自绘引入的。区别在于自绘能补救：
 * Shift 拖拽 10× 精调、Option 拖拽 50× 精调、拖拽时实时显示行号气泡。
 * ================================================================== */

interface DragState {
  pointerId: number
  grabY: number
  startTop: number
}

export interface GridScrollbarProps {
  driver: VScrollDriver
  snap: ScrollSnapshot
  /** thumb 元素的 ref 回调：驱动器直接写它的 transform，不经过 React */
  thumbRef: (el: HTMLDivElement | null) => void
}

export function GridScrollbar(p: GridScrollbarProps): ReactElement | null {
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
      // Shift 10×、Option 50× 精调：1px = 1736 行的粗调必须有细调兜底
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
      // 对齐 macOS：默认翻一屏，Option-click 直接跳到点击处
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
        aria-label="表格纵向滚动"
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
