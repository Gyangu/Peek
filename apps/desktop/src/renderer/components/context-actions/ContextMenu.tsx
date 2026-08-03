import { useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { useT } from '../../i18n'
import { Menu } from '../../ui/Menu'
import type { MenuNode } from '../../ui/menuModel'
import { hasContextConsent } from './consent'
import { ConsentDialog } from './ConsentDialog'
import { contextActionsFor, type ContextTarget } from './descriptors'
import { useContextActions } from './useContextActions'
import './context-actions.css'

/**
 * The grid's right-click menu: "add what I am pointing at to the chat".
 *
 * ## What this is now, and what it used to be
 *
 * It used to *be* the menu — the popup, the placement, the dismissal rules and
 * the disclosure gate, in one component, because the grid row was the only
 * right-clickable surface in the window. `<Menu>` took the first three, and what
 * is left here is the part that was always this feature's own: which offers
 * exist for a given target, whether a chat panel is there to receive them, and
 * the one-time disclosure in front of the first one.
 *
 * `extraItems` survives as a prop but stops being a bypass. It existed because
 * every `ContextAction` had to produce a `ChatAttachment` and the grid's copy
 * commands produce nothing of the sort; now both sides are just `MenuNode`s, and
 * the prop is an ordinary "the caller has lines of its own" — which is what the
 * grid meant all along.
 *
 * ## Why the menu does not close on the choosing click
 *
 * `useContextActions` holds the chosen attachment while `ConsentDialog` is up,
 * and that hook instance belongs to *this* component. Closing on the click that
 * chose would unmount the hook holding the attachment, destroying both the held
 * gesture and the disclosure about to be shown — observed as a menu item that
 * silently did nothing at all on first use. So until consent has been given this
 * component stays mounted and swaps itself for the dialog.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md §2.6
 */
export interface ContextMenuProps {
  /** Where the pointer was, in client coordinates. */
  x: number
  y: number
  target: ContextTarget
  onClose: () => void
  /**
   * Entries the caller owns, drawn above the "add to chat" group.
   *
   * This is how the grid's copy commands get here without this module learning
   * about the result cache. `contextActionsFor` is built entirely around
   * producing a `ChatAttachment` — every item there has a `build()` — and
   * copying produces nothing of the sort, so folding it in would mean either a
   * discriminated union in `ContextAction` or a `build()` whose null return has
   * a second meaning. A prop keeps "the menu" and "what is in the menu"
   * separable, which is what they always were.
   */
  extraItems?: readonly ContextMenuExtraItem[]
}

export interface ContextMenuExtraItem {
  id: string
  label: string
  title?: string
  onSelect: () => void
}

export function ContextMenu(props: ContextMenuProps): ReactElement | null {
  const { x, y, target, onClose, extraItems = [] } = props
  const t = useT()
  const actions = useContextActions()
  /**
   * Set for the length of one choice, when that choice opened the disclosure.
   *
   * A ref rather than state because it is read by the very next call in the same
   * event — `<Menu>` calls `onSelect` and then `onClose` synchronously — and a
   * state update would not have landed by then.
   */
  const keepOpen = useRef(false)

  const items = useMemo(() => contextActionsFor(target, t), [target, t])

  // The consent dialog replaces the menu rather than stacking on it: two modal
  // surfaces at once is never what the user meant by one right-click.
  if (actions.consentPending) {
    return (
      <ConsentDialog
        onAccept={() => {
          actions.acceptConsent()
          onClose()
        }}
        onCancel={() => {
          actions.cancelConsent()
          onClose()
        }}
      />
    )
  }

  const nodes: MenuNode[] = []

  /* Copy first: it is the commonest thing anyone wants from a cell, and it needs
     neither a chat panel nor the disclosure gate. */
  for (const item of extraItems) {
    nodes.push({
      kind: 'item',
      id: item.id,
      label: item.label,
      ...(item.title === undefined ? {} : { title: item.title }),
      onSelect: item.onSelect,
    })
  }
  if (extraItems.length > 0) nodes.push({ kind: 'sep', id: 'sep.extra' })

  nodes.push({ kind: 'head', id: 'head.chat', text: t('context.menu.title') })

  if (!actions.hasChatTarget) {
    nodes.push({ kind: 'note', id: 'note.noChat', text: t('context.menu.noChat'), tone: 'danger' })
  }

  if (items.length === 0) {
    nodes.push({ kind: 'note', id: 'note.empty', text: t('context.menu.empty'), tone: 'danger' })
  } else {
    for (const item of items) {
      nodes.push({
        kind: 'item',
        id: item.id,
        label: item.label,
        ...(item.title === undefined ? {} : { title: item.title }),
        onSelect: () => {
          // Read the gate *before* dispatching: `add()` resolves too late to
          // decide whether this menu may go away.
          keepOpen.current = !hasContextConsent()
          // `build()` runs only now, so a descriptor is never minted for an
          // offer the user did not take.
          void actions.add(item.build())
        },
      })
    }
  }

  return (
    <Menu
      label="context-menu"
      at={{ x, y }}
      nodes={nodes}
      // `<Menu>` closes on every choice, which is right for every other menu in
      // the window and wrong for exactly one case here — see the header. The
      // flag is set inside the `onSelect` that runs immediately before this.
      onClose={() => {
        const keep = keepOpen.current
        keepOpen.current = false
        if (!keep) onClose()
      }}
    />
  )
}
