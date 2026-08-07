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
/*
 * `layout-root` survives as a bare name, written out at both call sites below.
 *
 * It styles nothing — the box is the utilities beside it — but two files outside
 * this one select it: `base.css` hangs the keyboard focus emphasis off
 * `.layout-root .panel.focused` and the grid's focus ring off
 * `.layout-root .grid-wrap:focus-visible`, and `usePanelFocus` finds the tiling
 * with `el.closest('.layout-root')` to decide whether it may adopt focus.
 *
 * Written out rather than shared through a constant on purpose: three tests read
 * class strings straight out of the `className=` attribute (the colour ban, the
 * type floor, the control layer's fence), and a name reached through an
 * identifier is a name none of them can see.
 */
export function LayoutTree(): ReactElement {
  const layout = useLayout()
  if (!layout) {
    return <div className="layout-root flex min-h-0 flex-1 p-tight" />
  }
  /* Panels are numbered in visual order, depth-first, and the number is what a
     screen reader announces ("Panel 3: public.orders"). Computed once here
     rather than in each panel: a panel node knows its own id and nothing about
     its position among its siblings' siblings. */
  const order = new Map<PanelId, number>(collectPanels(layout).map((p, i) => [p.id, i]))
  return (
    <div className="layout-root flex min-h-0 flex-1 p-tight">
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
      /* `split-child` is not a style — the box beside it is. It is the name
         `Divider`'s pointer handler filters this row's children by, and the
         divider elements between them have to be excluded from that list or the
         ratio arithmetic counts the gaps as panes. */
      <div className="split-child flex min-w-0 min-h-0" style={style} key={childKey(child, i)}>
        <LayoutNodeView node={child} order={order} />
      </div>,
    )
  })
  /* `flex-row` / `flex-col` written out on both branches rather than derived,
     for the reason the migration record gives throughout: a class name built out
     of a variable is a class Tailwind never sees and therefore never compiles.
     `data-dir` stays because it is what a person reads off the DOM when a split
     is nested three deep; nothing styles from it any more. */
  return (
    <div
      className={node.dir === 'row' ? 'flex flex-1 min-w-0 min-h-0 flex-row' : 'flex flex-1 min-w-0 min-h-0 flex-col'}
      data-dir={node.dir}
    >
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
    /* The guide line that follows the cursor for the length of one drag. It
       never passes through JSX — it is created, moved and removed by this
       closure — so its class string is written here, which is a place Tailwind
       reads: the scanner takes candidates out of raw bytes and does not care
       that this is an assignment rather than an attribute. Verified against a
       build, like everything else in this migration.

       `z-999` is the same rung as the tear-out ghost: both are "a thing the
       pointer is carrying", and both have to clear the panel borders, the drop
       overlay (`z-5`) and the divider's own `z-3`. */
    ghost.className = 'fixed z-999 bg-accent pointer-events-none'
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
    // An attribute rather than a class, because what reads it is a Tailwind
    // variant (`data-dragging:after:bg-accent` on the element below) and a
    // variant cannot match a bare class without arbitrary-value syntax, which is
    // banned. Same fact, one spelling.
    divider.dataset['dragging'] = ''

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
      delete divider.dataset['dragging']
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
      {/* The line itself is an `::after`, and that is not a leftover: the divider
          is a 5px hit target and the rule inside it is 1px, so the two cannot be
          the same box without either a hairline nobody can grab or a 5px rule.
          `after:` is the variant for exactly this, so no CSS rule is involved any
          more — `content` is supplied by the variant itself, checked in the
          built stylesheet rather than assumed.

          `after:inset-0` plus `after:m-auto` plus one axis of 1px centres the
          line on the other axis, which is what the two
          `.split[data-dir=…] > .divider::after` rules said. Both are quoted with
          the variant they are actually worn under, not as bare stems: a bare
          stem in a comment is a class Tailwind compiles into a rule no element
          wears, which `scripts/audit-shipped-css.mjs` now refuses to ship.
          Written as two whole strings, one per direction, because a class
          assembled from `dir` is a class Tailwind never compiles.

          `data-dragging` is set by the pointer handler above; `hover` and it
          paint the same accent, so their order between themselves does not
          matter, and both sort after the resting `after:bg-border` because
          Tailwind emits variants last. */}
      <div
        className={
          dir === 'row'
            ? 'relative z-3 grow-0 shrink-0 basis-1.25 bg-transparent cursor-col-resize after:absolute after:inset-0 after:m-auto after:w-px after:bg-border hover:after:bg-accent data-dragging:after:bg-accent'
            : 'relative z-3 grow-0 shrink-0 basis-1.25 bg-transparent cursor-row-resize after:absolute after:inset-0 after:m-auto after:h-px after:bg-border hover:after:bg-accent data-dragging:after:bg-accent'
        }
        onMouseDown={onMouseDown}
        onContextMenu={menu.open(null)}
      />
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
