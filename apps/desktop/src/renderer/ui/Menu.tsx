import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'

import { useModalDialog } from '../hooks/useModalDialog'
import { useT } from '../i18n'
import {
  confirmNodes,
  nextItemIndex,
  placeMenu,
  type MenuItemNode,
  type MenuNode,
  type Point,
} from './menuModel'
import { MENU_ITEM_CLASS, menuToneClass } from './spec'
import './menu.css'

/**
 * The one popup menu in peek.
 *
 * Before this primitive the window had exactly one right-clickable surface — a
 * grid row — and its menu was not a menu component at all but the UI of one
 * feature ("add what I am looking at to the conversation"). Its required prop
 * was a `ContextTarget`, its items all had to produce a `ChatAttachment`, and
 * the grid's own copy commands reached it through an `extraItems` bypass. A
 * primitive with a bypass is a primitive with the wrong boundary.
 *
 * So the split is: this file knows about a list of lines, a point, and how to
 * get out. It knows nothing about connections, views, conversations or
 * attachments. Each caller supplies a pure `…MenuNodes()` function, which is
 * where its business goes and where a test can reach it without a DOM.
 *
 * ## What it deliberately does not do
 *
 * No submenus (nothing in this window needs a second level, and the hover
 * timing, flip logic and keyboard traversal they require is where a menu
 * primitive stops being small). No element anchoring — `at` is a point, so the
 * chat panel's attach dropdown is still its own thing. Both are recorded in the
 * design doc's §1.4 rather than left as absences.
 *
 * ## Escape, Tab, focus
 *
 * From `useModalDialog`, the same as every dialog. It matters here for one
 * specific reason inherited from the menu this replaces: the grid's own Escape
 * clears the row selection, and the menu is very often open *because* of that
 * selection — so Escape must reach exactly one of them.
 *
 * Arrow keys are this component's own, because `role="menu"` puts its primary
 * navigation on ↑/↓ rather than on Tab.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md
 */
export interface MenuProps {
  /** Names the menu for the modal stack and for assistive technology. */
  label: string
  /** Where the pointer was, in client coordinates. */
  at: Point
  nodes: readonly MenuNode[]
  onClose: () => void
}

export function Menu(props: MenuProps): ReactElement | null {
  const { label, at, nodes, onClose } = props
  const t = useT()
  const ref = useModalDialog({ label, onClose })

  /** Non-null while a `confirm` item is armed; it owns the menu's contents. */
  const [armed, setArmed] = useState<MenuItemNode | null>(null)

  const shown: readonly MenuNode[] =
    armed === null
      ? nodes
      : confirmNodes(armed, { cancel: t('menu.cancel') }, () => {
          setArmed(null)
        })

  /*
   * Measure, then place.
   *
   * The menu this replaces estimated its own size with two constants (260×260)
   * and clamped against them, so a two-line menu opened near the bottom of the
   * window was pushed a couple of hundred pixels away from the pointer that
   * asked for it. Here the first layout pass renders it hidden at the origin,
   * this effect measures the real box, and the second paints it in place —
   * inside one frame, so there is nothing to see in between.
   */
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<Point | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos(
      placeMenu(
        at,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
    // `shown.length` rather than `shown`: the confirm swap changes the height,
    // and re-placing on every render would fight the measurement.
  }, [at.x, at.y, shown.length])

  /*
   * Arming replaces every line, so the button that had focus is gone and focus
   * would fall to `<body>` — where the arrow keys reach nothing and Escape is
   * the only way out. It goes to the first line, which `confirmNodes` guarantees
   * is Cancel: the keystroke that armed the act must not be able to complete it.
   */
  useEffect(() => {
    if (armed === null) return
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [armed, ref])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const key =
      e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : e.key === 'Home' ? 'home' : e.key === 'End' ? 'end' : null
    if (key === null) return
    e.preventDefault()
    e.stopPropagation()
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const current = buttons.findIndex((b) => b === document.activeElement)
    const next = nextItemIndex(buttons.length, current, key)
    if (next !== null) buttons[next]?.focus()
  }

  const choose = (item: MenuItemNode) => (): void => {
    if (item.confirm !== undefined && armed?.id !== item.id) {
      setArmed(item)
      return
    }
    item.onSelect()
    onClose()
  }

  return (
    <div className="menu-backdrop" onClick={onClose} onContextMenu={preventAndClose(onClose)}>
      <div
        ref={mergeRefs(ref, boxRef)}
        className="menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        // Hidden rather than unmounted for the measuring pass: an unmounted box
        // has no size to measure, and `visibility` keeps it out of the paint
        // without taking it out of layout.
        style={pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.x, top: pos.y }}
        onClick={stop}
        onKeyDown={onKeyDown}
      >
        {shown.map((node) => {
          if (node.kind === 'sep') return <div key={node.id} className="menu-sep" />
          if (node.kind === 'head')
            return (
              <div key={node.id} className="menu-head">
                {node.text}
              </div>
            )
          if (node.kind === 'note')
            return (
              <div key={node.id} className={`menu-note ${menuToneClass(node.tone ?? 'default')}-note`}>
                {node.text}
              </div>
            )
          return (
            <button
              key={node.id}
              type="button"
              role="menuitem"
              className={`${MENU_ITEM_CLASS} ${menuToneClass(node.tone ?? 'default')}`}
              data-menu-item={node.id}
              disabled={node.disabled === true}
              {...(node.title === undefined ? {} : { title: node.title })}
              onClick={choose(node)}
            >
              {node.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}

function preventAndClose(onClose: () => void) {
  return (e: ReactMouseEvent): void => {
    // Right-clicking outside an open menu closes it and does not open a second
    // one; the platform menu must not appear either.
    e.preventDefault()
    onClose()
  }
}

/** `useModalDialog` owns one ref and the measurement needs another; same node. */
function mergeRefs<T extends HTMLElement>(
  ...refs: { current: T | null }[]
): (el: T | null) => void {
  return (el) => {
    for (const ref of refs) ref.current = el
  }
}
