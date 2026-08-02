import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useModalDialog } from '../../hooks'
import { useT } from '../../i18n'
import { hasContextConsent } from './consent'
import { ConsentDialog } from './ConsentDialog'
import { contextActionsFor, type ContextTarget } from './descriptors'
import { useContextActions } from './useContextActions'
import './context-actions.css'

/**
 * The right-click menu: "add what I am pointing at to the chat".
 *
 * The menu's *contents* are decided by `contextActionsFor`, a pure function, so
 * the same set of offers backs the keyboard path and can be asserted in a test
 * without a DOM. This component is only the presentation and the dismissal rules.
 *
 * ## Placement
 *
 * Positioned at the pointer and then pulled back inside the window. A menu that
 * opens half off-screen because the user right-clicked near the bottom edge is
 * the single most common way a custom context menu is worse than the native one.
 *
 * ## Dismissal
 *
 * Escape, a click anywhere else, and choosing an item all close it. The outside
 * click is captured on the backdrop rather than on `window`, so the menu cannot
 * dismiss itself on the very click that opened it.
 *
 * The one exception is the disclosure gate. `useContextActions` holds the chosen
 * attachment while `ConsentDialog` is up, and that hook instance belongs to *this*
 * component — so closing on the choosing click would throw the held attachment
 * away along with the dialog. Until consent has been given the menu therefore
 * stays mounted and renders the dialog in its own place.
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

/** Roughly the menu's size, used to keep it inside the viewport before it has been measured. */
const MENU_W = 260
const MENU_H = 260
const EDGE_GAP = 8

export function ContextMenu(props: ContextMenuProps): ReactElement | null {
  const { x, y, target, onClose, extraItems = [] } = props
  const t = useT()
  const actions = useContextActions()
  // Escape, focus containment and focus restoration, from the same place every
  // dialog gets them. It matters here for a specific reason: this menu opens
  // over the grid, whose own Escape clears the row selection — and the menu is
  // frequently open *because* of that selection. Before the stack, dismissing
  // the menu with Escape threw the selection away in the same keystroke.
  const ref = useModalDialog({ label: 'context-menu', onClose })

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

  const vw = typeof window === 'undefined' ? MENU_W * 4 : window.innerWidth
  const vh = typeof window === 'undefined' ? MENU_H * 4 : window.innerHeight
  const left = Math.max(EDGE_GAP, Math.min(x, vw - MENU_W - EDGE_GAP))
  const top = Math.max(EDGE_GAP, Math.min(y, vh - MENU_H - EDGE_GAP))

  return (
    <div className="ctx-menu-backdrop" onClick={onClose} onContextMenu={preventAndClose(onClose)}>
      <div
        className="ctx-menu"
        role="menu"
        tabIndex={-1}
        ref={ref}
        style={{ left, top }}
        onClick={stop}
      >
        {/* Copy first: it is the commonest thing anyone wants from a cell, and
            it needs neither a chat panel nor the disclosure gate. */}
        {extraItems.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="ctx-menu-item"
            {...(item.title === undefined ? {} : { title: item.title })}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            {item.label}
          </button>
        ))}
        {extraItems.length > 0 ? <div className="ctx-menu-sep" /> : null}

        <div className="ctx-menu-head">{t('context.menu.title')}</div>

        {!actions.hasChatTarget ? (
          <div className="ctx-menu-note" title={t('context.menu.noChatTitle')}>
            {t('context.menu.noChat')}
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="ctx-menu-note">{t('context.menu.empty')}</div>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="ctx-menu-item"
              {...(item.title === undefined ? {} : { title: item.title })}
              onClick={() => {
                // Read the gate *before* dispatching: `add()` resolves too late
                // to decide whether this menu may go away.
                const consented = hasContextConsent()
                // `build()` runs only now, so a descriptor is never minted for an
                // offer the user did not take.
                void actions.add(item.build())
                // Closing here when consent is still pending unmounts the hook
                // that is *holding* the attachment, which destroys both the held
                // gesture and the disclosure that was about to be shown — the
                // observed symptom being a right-click menu item that silently
                // did nothing at all on first use. When the gate has yet to be
                // passed the menu stays mounted and swaps itself for the dialog
                // (above); `onAccept`/`onCancel` are what close it then.
                if (consented) onClose()
              }}
            >
              {item.label}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function stop(e: React.MouseEvent): void {
  e.stopPropagation()
}

function preventAndClose(onClose: () => void) {
  return (e: React.MouseEvent): void => {
    e.preventDefault()
    onClose()
  }
}
