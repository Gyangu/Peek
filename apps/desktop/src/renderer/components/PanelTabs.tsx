import { useCallback, useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { PanelId, PanelNode, ViewId } from '@peek/core'
import { useT } from '../i18n'
import {
  panelTabWidgetRoles,
  useTabRoving,
  type PanelFocusApi,
  type TabRovingApi,
} from '../hooks/usePanelFocus'
import { dispatch } from '../state/dispatch'
import { useView } from '../state/workspaceStore'
import { beginViewDrag, registerPanelHeadEl, usePanelTabCaret } from './dragStore'
import { viewTitleOf } from './panelTitle'

/**
 * A panel's tab strip, and the panel's action buttons beside it.
 *
 * ## It replaces the head; it is not a second bar under it
 *
 * The strip took over `.panel-head` rather than being added below it, and the
 * reason is the scroll subsystem: the body is a pixel-virtualised grid, so any
 * design in which the body's available height changes at runtime is a design
 * that has to negotiate with `vscroll`. A strip that appears when a second tab
 * arrives would do exactly that. Occupying the existing bar keeps the net height
 * change at zero for every tab count, one tab included.
 *
 * That is also why the strip is **always shown**, never hidden for a single tab.
 * Two more reasons stack on top of the first: the strip is the drag handle and
 * the drop target, so hiding it would remove the gesture precisely in the
 * commonest one-view-per-panel case; and the panel's own buttons live here.
 *
 * ## Overflow scrolls, it does not fold into a menu
 *
 * A dropdown would be a second focus trap and a second ARIA widget to get right,
 * for no gain: horizontal scrolling plus `scrollIntoView` on activation is ten
 * lines, and every tab stays in one flat tab sequence a screen reader can walk.
 * `MAX_PANEL_TABS` (12) bounds how long the strip can get. Tabs are never
 * squeezed below `--tab-min-width` to avoid scrolling — an unreadable tab is
 * worse than a scrollbar.
 *
 * ## No local state
 *
 * Which tab is active lives in main's Workspace, so pressing one dispatches
 * `view.activate` and waits for the patch, exactly as a drag waits for
 * `layout.moveView`. Nothing here writes the mirror.
 */

interface PanelTabsProps {
  panel: PanelNode
  /**
   * From `usePanelFocus`, owned by the panel. The one object the tab strip and
   * the panel share: it decides the tab order across panels, and it names the
   * ids that pair each tab with the body it controls.
   */
  focus: PanelFocusApi
}

export function PanelTabs({ panel, focus }: PanelTabsProps): ReactElement {
  const t = useT()
  const roving = useTabRoving({
    panelId: panel.id,
    viewIds: panel.viewIds,
    activeViewId: panel.activeViewId,
  })
  /* An empty panel emits neither `tablist` nor `tabpanel` — see
   * `panelTabWidgetRoles`, which decides both from one number so that `Panel`
   * and this file cannot disagree about when the pattern applies. */
  const roles = panelTabWidgetRoles(panel.viewIds.length)
  const empty = roles.tablist === undefined
  // Only used to mark the strip while it is the drop target; the line itself is
  // drawn once, in viewport coordinates, by `TabInsertCaret`.
  const caret = usePanelTabCaret(panel.id)

  // The head is measured on every drag: its height is the band that separates a
  // strip drop from a body drop, and the tabs inside it resolve the caret.
  const headRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerPanelHeadEl(panel.id, el)
    },
    [panel.id],
  )

  /* Keep the visible tab visible.
   *
   * `useTabRoving` scrolls too, but only when focus is already on a tab — it must
   * not pull the caret across the window for a remote `view.activate`. Scrolling
   * a strip is not moving focus, though, and without this a view activated by
   * ⌘9, by the sidebar or by an AI would be shown while its tab sits off the end
   * of a scrolled strip. `nearest` on both axes means an already-visible tab
   * scrolls nothing at all, in particular not the page. */
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [panel.activeViewId])

  const split = (dir: 'row' | 'col') => (e: ReactMouseEvent): void => {
    e.stopPropagation()
    void dispatch('layout.split', { panelId: panel.id, dir })
  }

  /* The panel's ✕ always closes the *panel*. Before tabs it had to guess —
   * closing the view when there was one and the panel when there was not — and
   * that guess is now spelled out: every tab carries its own ✕ for `view.close`,
   * which leaves this button with one unambiguous job. */
  const closePanel = (e: ReactMouseEvent): void => {
    e.stopPropagation()
    void dispatch('layout.close', { panelId: panel.id })
  }

  return (
    <div className="panel-head" ref={headRef} data-tab-caret={caret ?? undefined}>
      {empty ? <span className="panel-tabs-empty">{t('panel.empty')}</span> : null}
      <div
        ref={listRef}
        className="panel-tabs"
        role={roles.tablist}
        aria-orientation={empty ? undefined : 'horizontal'}
        aria-label={empty ? undefined : t('panel.tabs.listLabel')}
        onKeyDown={roving.onKeyDown}
      >
        {panel.viewIds.map((viewId, index) => (
          <PanelTab
            key={viewId}
            panelId={panel.id}
            viewId={viewId}
            index={index}
            active={viewId === panel.activeViewId}
            focus={focus}
            roving={roving}
          />
        ))}
      </div>
      {/*
        The glyph is decorative, so it is hidden and the label carries the name.
        Element content outranks `title` when an accessible name is computed, so
        a bare glyph plus a `title` would have a screen reader announce the
        glyph and never the title.
      */}
      <div className="panel-actions">
        <button
          className="ghost"
          tabIndex={focus.childTabIndex}
          title={t('panel.splitRow')}
          aria-label={t('panel.splitRow')}
          onClick={split('row')}
        >
          <span aria-hidden="true">⊞</span>
        </button>
        <button
          className="ghost"
          tabIndex={focus.childTabIndex}
          title={t('panel.splitCol')}
          aria-label={t('panel.splitCol')}
          onClick={split('col')}
        >
          <span aria-hidden="true">⊟</span>
        </button>
        <button
          className="ghost"
          tabIndex={focus.childTabIndex}
          title={t('panel.closePanel')}
          aria-label={t('panel.closePanel')}
          onClick={closePanel}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface PanelTabProps {
  panelId: PanelId
  viewId: ViewId
  index: number
  active: boolean
  focus: PanelFocusApi
  roving: TabRovingApi
}

/**
 * One tab.
 *
 * A `div` with `role="tab"` rather than a `<button>`, for a plain HTML reason:
 * it contains the close button, and a button inside a button is invalid and
 * behaves unpredictably. The roving `tabIndex` comes from `useTabRoving`, so
 * only the focused panel's active tab is ever in the document's tab order.
 */
function PanelTab({ panelId, viewId, index, active, focus, roving }: PanelTabProps): ReactElement {
  const t = useT()
  const view = useView(viewId)
  const title = view ? viewTitleOf(t, view) : String(viewId)

  /* Pressing a tab shows it immediately, before any drag is decided — the same
   * order every tabbed editor uses, and what makes `active: true` below true by
   * the time a drop is resolved: whatever else this gesture turns into, the view
   * is the visible one from now on. `beginViewDrag` ignores presses that landed
   * on the ✕, and a press that never travels the threshold stays a click. */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('button')) return
    if (!active) void dispatch('view.activate', { viewId, focusPanel: true })
    beginViewDrag(e, viewId, panelId, { index, active: true })
  }

  /** Middle-click closes, as it does in every browser and editor. */
  const onAuxClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.button !== 1) return
    e.preventDefault()
    void dispatch('view.close', { viewId })
  }

  const onClose = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    void dispatch('view.close', { viewId })
  }

  const classes = ['panel-tab']
  if (active) classes.push('active')

  return (
    <div
      ref={roving.registerTab(viewId)}
      className={classes.join(' ')}
      role="tab"
      id={focus.tabId(viewId)}
      aria-selected={active}
      aria-controls={focus.tabpanelId}
      tabIndex={roving.tabIndexOf(viewId)}
      data-view-id={viewId}
      title={title}
      onPointerDown={onPointerDown}
      onAuxClick={onAuxClick}
    >
      {view?.status === 'loading' ? <span className="tab-busy" /> : null}
      <span className="tab-title">{title}</span>
      {/* Not a tab stop of its own: a strip of twelve tabs would otherwise be
          twenty-four stops. The keyboard closes a tab with Delete/Backspace
          (see `useTabRoving`), the mouse clicks this. */}
      <button
        className="tab-close"
        tabIndex={-1}
        aria-hidden="true"
        title={t('panel.tab.close', { title })}
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  )
}
