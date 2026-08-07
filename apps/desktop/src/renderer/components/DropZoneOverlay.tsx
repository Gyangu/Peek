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
    /*
     * `panel-drop-overlay` keeps two declarations — `position: absolute` and
     * `pointer-events: none` — because `view-drag.test.ts` reads them by
     * selector: the overlay covers the panel, and a hit-testable one would eat
     * the release that ends the drag. `inset-0` and the layer it sits on are
     * here.
     *
     * `drop-highlight` keeps its name for a different reason: `base.css` turns
     * the slide off under `prefers-reduced-motion` by selecting it. The rule it
     * used to have is gone, so nothing here is outranked.
     *
     * `bg-accent/18` replaces `color-mix(in srgb, var(--color-accent) 18%,
     * transparent)`. Tailwind's slash modifier mixes in oklab rather than sRGB,
     * and that is the same colour here rather than a near miss: mixing *with
     * `transparent`* is premultiplied, so the second colour contributes nothing
     * and only the alpha moves, whichever space the mix names. Confirmed by
     * reading the composited value back out of Electron.
     */
    <div className="panel-drop-overlay pointer-events-none absolute inset-0 z-5">
      <div
        className="drop-highlight absolute flex items-center justify-center rounded-control bg-accent/18 px-tight outline-2 -outline-offset-2 outline-accent transition-all duration-90 ease-out"
        style={style}
      >
        <span className="max-w-full truncate rounded-control bg-bg/82 px-snug py-inset text-fg">
          {dropLabel(t, zone, occupantTitle)}
        </span>
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
    /* `tab-insert-caret` keeps three declarations: `position: fixed` and
       `pointer-events: none`, which `view-drag.test.ts` reads by selector, and
       the 6px accent glow, which has no `--shadow-*` token and is not worth
       inventing one for — the theme's five shadows each name a *kind of surface
       that floats*, and this is a 2px line. The rule has to exist for the first
       two anyway, so the glow costs nothing extra by staying in it. */
    <div className="tab-insert-caret pointer-events-none fixed z-998 w-0.5 bg-accent shadow-caret" style={{ left: line.x, top: line.top, height: line.height }}>
      {/* The strip's counterpart of the highlight's label: the line says *where*,
          this says *what*. Without it a drop on the strip is the one gesture with
          no words attached to it.

          Deliberately *not* the same string as the highlight's label, and the
          difference is the whole rule this replaces (`.tab-insert-caret
          .drop-label`): `max-w-full` is right against a half-panel and wrong
          here, where the containing block is the 2px caret itself — the label
          would shrink to two pixels and clip its first glyph in half. The line
          is drawn in viewport coordinates precisely so nothing clips it; its
          label inherits that and sizes to the words it carries. */}
      <span className="absolute top-full left-0 mt-inset rounded-control border border-accent-dim bg-bg/82 px-snug py-inset whitespace-nowrap text-fg">
        {t('panel.drop.tab')}
      </span>
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
    /* `view-drag-ghost` keeps exactly one declaration — `pointer-events: none`,
       which `view-drag.test.ts` reads by selector and which is what keeps the
       label from ever becoming its own drop target. The rest is here.

       `translate-3.5` is the 14px offset that puts the label below and right of
       the cursor rather than under it. `z-999` is the top of this window's
       stack, shared with the divider's guide line: both are things the pointer
       is carrying. */
    <div
      className="view-drag-ghost pointer-events-none fixed z-999 max-w-65 translate-3.5 truncate rounded-control border border-accent-dim bg-bg-3 px-snug py-inset text-fg shadow-drag"
      style={{ left: pointer.x, top: pointer.y }}
    >
      {view ? viewTitleOf(t, view) : t('panel.dragView')}
    </div>
  )
}
