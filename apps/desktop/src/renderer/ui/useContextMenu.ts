import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import type { Point } from './menuModel'

/**
 * The gesture half of a right-click menu: turn `contextmenu` into state.
 *
 * Every one of the four surfaces that grew a menu needed the same six lines —
 * hold a point and the thing that was under the pointer, prevent the platform
 * menu, clear it on close. Six lines copied four times is how the row-selection
 * and the tab-close handlers each ended up with their own idea of what a
 * modified click means, so it is one hook instead.
 *
 * `T` is whatever the caller needs back when it builds the nodes — a node, a
 * view id, a connection row. It is stored, never inspected.
 *
 *     const menu = useContextMenu<NamespaceNode>()
 *     …
 *     <div onContextMenu={menu.open(node)} />
 *     {menu.state ? <Menu at={menu.state.at} nodes={nodesFor(menu.state.payload)}
 *                         onClose={menu.close} label="tree" /> : null}
 */
export interface ContextMenuState<T> {
  at: Point
  payload: T
}

export interface ContextMenuApi<T> {
  state: ContextMenuState<T> | null
  /** Bind to `onContextMenu`. Suppresses the platform menu. */
  open: (payload: T) => (e: ReactMouseEvent) => void
  /**
   * Open at a point the caller computed — the keyboard's way in.
   *
   * A menu reachable only by right-click is a menu no keyboard can reach, and
   * the actions inside it (delete, with its confirmation) exist nowhere else. So
   * a surface that binds a key to "show my actions" anchors the menu to its own
   * element's rect rather than to a pointer that is not there.
   */
  openAt: (payload: T, at: Point) => void
  close: () => void
}

export function useContextMenu<T>(): ContextMenuApi<T> {
  const [state, setState] = useState<ContextMenuState<T> | null>(null)

  const open = useCallback(
    (payload: T) =>
      (e: ReactMouseEvent): void => {
        e.preventDefault()
        // The row underneath usually has its own click handler — selecting,
        // expanding, starting a drag. A right-click is none of those.
        e.stopPropagation()
        setState({ at: { x: e.clientX, y: e.clientY }, payload })
      },
    [],
  )

  const openAt = useCallback((payload: T, at: Point): void => {
    setState({ at, payload })
  }, [])

  const close = useCallback((): void => {
    setState(null)
  }, [])

  return { state, open, openAt, close }
}
