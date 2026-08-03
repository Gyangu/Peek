import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { LayoutNode, PanelId, SplitId, SplitNode } from '@peek/core'
import { collectPanels, normalizeRatio } from '@peek/core'
import { useT } from '../i18n'
import { dispatch } from '../state/dispatch'
import { useLayout } from '../state/workspaceStore'
import { DragGhost, TabInsertCaret } from './DropZoneOverlay'
import { PanelView } from './Panel'
import { Menu } from '../ui/Menu'
import { useContextMenu } from '../ui/useContextMenu'

/** Smallest a child region may get while dragging a divider. */
const MIN_CHILD_PX = 80

/**
 * Renders the tiled layout. Layout *is* state: this only draws the LayoutNode
 * tree, and every resize goes back to main as a `layout.setRatio` command — the
 * tree is never edited locally.
 */
export function LayoutTree(): ReactElement {
  const layout = useLayout()
  if (!layout) {
    return <div className="layout-root" />
  }
  /* Panels are numbered in visual order, depth-first, and the number is what a
     screen reader announces ("Panel 3: public.orders"). Computed once here
     rather than in each panel: a panel node knows its own id and nothing about
     its position among its siblings' siblings. */
  const order = new Map<PanelId, number>(collectPanels(layout).map((p, i) => [p.id, i]))
  return (
    <div className="layout-root">
      <LayoutNodeView node={layout} order={order} />
      {/* Fixed-positioned and pointer-transparent, so they can live anywhere in
          the tree; here they are siblings of the layout, where nothing clips
          them — the insertion caret in particular has to be able to draw over a
          strip that clips its own overflow. */}
      <DragGhost />
      <TabInsertCaret />
    </div>
  )
}

interface NodeProps {
  node: LayoutNode
  order: ReadonlyMap<PanelId, number>
}

function LayoutNodeView({ node, order }: NodeProps): ReactElement {
  if (node.type === 'panel') return <PanelView panel={node} index={order.get(node.id) ?? 0} />
  return <SplitView node={node} order={order} />
}

function SplitView({ node, order }: { node: SplitNode; order: ReadonlyMap<PanelId, number> }): ReactElement {
  const ratio = normalizeRatio(node.ratio, node.children.length)
  const children: ReactElement[] = []
  node.children.forEach((child, i) => {
    if (i > 0) {
      children.push(
        <Divider
          key={`d${String(i)}`}
          splitId={node.id}
          index={i}
          dir={node.dir}
          childCount={node.children.length}
        />,
      )
    }
    const style: CSSProperties = { flexGrow: ratio[i] * 100, flexBasis: 0 }
    children.push(
      <div className="split-child" style={style} key={childKey(child, i)}>
        <LayoutNodeView node={child} order={order} />
      </div>,
    )
  })
  return (
    <div className="split" data-dir={node.dir}>
      {children}
    </div>
  )
}

function childKey(node: LayoutNode, index: number): string {
  return node.type === 'panel' ? `p:${node.id}` : `s:${node.id}:${String(index)}`
}

/* ------------------------------------------------------------------ */
/* Divider: dragging paints a guide line that follows the cursor (purely   */
/* visual); `layout.setRatio` is sent on release. Live feedback without an  */
/* optimistic local update — the layout tree's source of truth stays in main. */
/* ------------------------------------------------------------------ */

interface DividerProps {
  splitId: SplitId
  /** Index of the child immediately right of / below the divider. */
  index: number
  dir: 'row' | 'col'
  /** How many panes this split holds; an even split needs the count. */
  childCount: number
}

function Divider({ splitId, index, dir, childCount }: DividerProps): ReactElement {
  const t = useT()
  const menu = useContextMenu<null>()
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const divider = e.currentTarget
    const container = divider.parentElement
    if (!container) return
    const kids = [...container.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('split-child'),
    )
    if (kids.length < 2 || index < 1 || index >= kids.length) return

    const horizontal = dir === 'row'
    const rects = kids.map((el) => el.getBoundingClientRect())
    const sizes = rects.map((r) => (horizontal ? r.width : r.height))
    const total = sizes.reduce((a, b) => a + b, 0)
    const startPos = horizontal ? e.clientX : e.clientY
    const containerRect = container.getBoundingClientRect()

    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    if (horizontal) {
      ghost.style.width = '2px'
      ghost.style.top = `${containerRect.top}px`
      ghost.style.height = `${containerRect.height}px`
      ghost.style.left = `${startPos}px`
    } else {
      ghost.style.height = '2px'
      ghost.style.left = `${containerRect.left}px`
      ghost.style.width = `${containerRect.width}px`
      ghost.style.top = `${startPos}px`
    }
    document.body.appendChild(ghost)
    divider.classList.add('dragging')

    let delta = 0
    const clampDelta = (raw: number): number => {
      const minDelta = MIN_CHILD_PX - sizes[index - 1]
      const maxDelta = sizes[index] - MIN_CHILD_PX
      return Math.max(minDelta, Math.min(maxDelta, raw))
    }

    const onMove = (ev: MouseEvent): void => {
      delta = clampDelta((horizontal ? ev.clientX : ev.clientY) - startPos)
      if (horizontal) ghost.style.left = `${startPos + delta}px`
      else ghost.style.top = `${startPos + delta}px`
    }

    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      ghost.remove()
      divider.classList.remove('dragging')
      if (delta === 0 || total <= 0) return
      const next = sizes.slice()
      next[index - 1] += delta
      next[index] -= delta
      void dispatch('layout.setRatio', {
        splitId,
        ratio: next.map((s) => Math.max(0.001, s / total)),
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /*
   * Dragging is the only thing a divider could do, and a drag is not undoable —
   * nudge it while reading and the ratio is simply wrong now, with no way back
   * short of dragging until it looks even. `layout.setRatio` could always
   * express it; nothing could reach it.
   */
  return (
    <>
      <div className="divider" onMouseDown={onMouseDown} onContextMenu={menu.open(null)} />
      {menu.state ? (
        <Menu
          label={t('menu.divider.label')}
          at={menu.state.at}
          nodes={[
            {
              kind: 'item',
              id: 'divider.even',
              label: t('menu.divider.even'),
              onSelect: () => {
                void dispatch('layout.setRatio', {
                  splitId,
                  ratio: Array.from({ length: childCount }, () => 1 / childCount),
                })
              },
            },
          ]}
          onClose={menu.close}
        />
      ) : null}
    </>
  )
}
