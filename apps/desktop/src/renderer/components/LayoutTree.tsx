import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { LayoutNode, SplitId, SplitNode } from '@peek/core'
import { normalizeRatio } from '@peek/core'
import { dispatch } from '../state/dispatch'
import { useLayout } from '../state/workspaceStore'
import { PanelView } from './Panel'

/** 分屏时单个子区域的最小像素尺寸 */
const MIN_CHILD_PX = 80

/**
 * 平铺布局渲染。布局即状态：这里只把 LayoutNode 树画出来，
 * 尺寸调整通过 layout.setRatio 命令回到 main，不在本地改树。
 */
export function LayoutTree(): ReactElement {
  const layout = useLayout()
  if (!layout) {
    return <div className="layout-root" />
  }
  return (
    <div className="layout-root">
      <LayoutNodeView node={layout} />
    </div>
  )
}

function LayoutNodeView({ node }: { node: LayoutNode }): ReactElement {
  if (node.type === 'panel') return <PanelView panel={node} />
  return <SplitView node={node} />
}

function SplitView({ node }: { node: SplitNode }): ReactElement {
  const ratio = normalizeRatio(node.ratio, node.children.length)
  const children: ReactElement[] = []
  node.children.forEach((child, i) => {
    if (i > 0) {
      children.push(<Divider key={`d${String(i)}`} splitId={node.id} index={i} dir={node.dir} />)
    }
    const style: CSSProperties = { flexGrow: ratio[i] * 100, flexBasis: 0 }
    children.push(
      <div className="split-child" style={style} key={childKey(child, i)}>
        <LayoutNodeView node={child} />
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
/* 分隔条：拖拽时只画一条跟手的辅助线（纯视觉），松手才发 layout.setRatio。   */
/* 这样既有实时反馈，又不做本地乐观更新 —— 布局树的唯一真源仍在 main。       */
/* ------------------------------------------------------------------ */

interface DividerProps {
  splitId: SplitId
  /** 分隔条右/下方那个子节点的下标 */
  index: number
  dir: 'row' | 'col'
}

function Divider({ splitId, index, dir }: DividerProps): ReactElement {
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

  return <div className="divider" onMouseDown={onMouseDown} />
}
