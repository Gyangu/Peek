import type { CSSProperties, ReactElement } from 'react'
import { dropZoneHighlight, isDropEdgeZone, type DropZone, type PanelId } from '@peek/core'
import { useT, type TFunction } from '../i18n'
import { useView } from '../state/workspaceStore'
import { useDragPointer, useDraggingViewId, usePanelDropZone, useTabCaretLine } from './dragStore'
import { viewTitleOf } from './panelTitle'

/**
 * The drop preview.
 *
 * Two pieces, both purely visual and both drawn only while a drag is in flight:
 * a highlight block inside the panel under the cursor, and a small label that
 * follows the cursor itself. Neither touches the workspace — the layout does not
 * move until main's patch arrives, exactly like the divider's guide line.
 *
 * The highlight's geometry comes from `dropZoneHighlight()` in core, the same
 * function the layout invariants are written against, so the preview and the
 * result describe the same rectangle: half the panel for an edge drop, because
 * that is the share the split hands the new panel.
 */

interface PanelDropOverlayProps {
  panelId: PanelId
  /**
   * Title of the view this panel already holds, or `null` when it is empty.
   * Passed in rather than looked up, because the panel rendering the overlay has
   * it to hand and the two must never disagree.
   */
  occupantTitle: string | null
}

/** Rendered by every panel; draws nothing unless this panel is the drop target. */
export function PanelDropOverlay({ panelId, occupantTitle }: PanelDropOverlayProps): ReactElement | null {
  const t = useT()
  const zone = usePanelDropZone(panelId)
  if (!zone) return null

  const rect = dropZoneHighlight(zone)
  const style: CSSProperties = {
    left: pct(rect.left),
    top: pct(rect.top),
    width: pct(rect.width),
    height: pct(rect.height),
  }
  return (
    <div className="panel-drop-overlay">
      <div className="drop-highlight" style={style}>
        <span className="drop-label">{dropLabel(t, zone, occupantTitle)}</span>
      </div>
    </div>
  )
}

function pct(fraction: number): string {
  return `${String(fraction * 100)}%`
}

/**
 * What releasing here would do, in one line.
 *
 * The centre zone still has two readings, but they are no longer two different
 * outcomes: an occupied panel gains a tab (nothing is displaced — the M2 "swap
 * with …" is gone along with the gesture that produced it), while an empty one
 * simply receives the view. Saying "add as a tab in public.orders" when there is
 * no tab bar to add to would be the confusing half of that.
 */
export function dropLabel(t: TFunction, zone: DropZone, occupantTitle: string | null): string {
  if (isDropEdgeZone(zone)) return t(`panel.drop.split.${zone}`)
  return occupantTitle === null ? t('panel.drop.move') : t('panel.drop.stack', { title: occupantTitle })
}

/* ------------------------------------------------------------------ */

/**
 * The insertion line for a drop on a tab strip.
 *
 * Drawn once for the whole window, in viewport coordinates, for the same reason
 * `DragGhost` is: the strip clips its own horizontal overflow, so a line
 * rendered inside it would be cut off at exactly the position that matters most
 * — the gap past the last tab of a full strip.
 *
 * Its position comes from the same measured rectangles the caret was resolved
 * against, never from a second read of the DOM, so the line and the Command can
 * never point at different gaps. There is no "tabs slide apart to make room"
 * animation on purpose: the strip is a horizontal scroll container, and an
 * animation that changes tab widths fights with its scroll position.
 */
export function TabInsertCaret(): ReactElement | null {
  const t = useT()
  const line = useTabCaretLine()
  if (!line) return null
  return (
    <div className="tab-insert-caret" style={{ left: line.x, top: line.top, height: line.height }}>
      {/* The strip's counterpart of the highlight's label: the line says *where*,
          this says *what*. Without it a drop on the strip is the one gesture with
          no words attached to it. */}
      <span className="drop-label">{t('panel.drop.tab')}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The label that rides under the cursor, naming what is being dragged.
 *
 * `position: fixed` places it in viewport coordinates, so no portal is needed,
 * and `pointer-events: none` keeps it from ever becoming its own drop target.
 * It subscribes to the pointer, so it is the only component that re-renders on
 * every move — panels only re-render when their own highlight changes.
 */
export function DragGhost(): ReactElement | null {
  const t = useT()
  const viewId = useDraggingViewId()
  const pointer = useDragPointer()
  const view = useView(viewId)
  if (!pointer) return null
  return (
    <div className="view-drag-ghost" style={{ left: pointer.x, top: pointer.y }}>
      {view ? viewTitleOf(t, view) : t('panel.dragView')}
    </div>
  )
}
