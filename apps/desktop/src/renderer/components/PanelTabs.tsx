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
import { tabMenuNodes } from './tabMenu'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { useContextMenu } from '../ui/useContextMenu'

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
  const menu = useContextMenu<ViewId>()

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
    /*
     * The head keeps a rule of its own for one declaration — its height, which
     * `view-drag.test.ts` reads by selector because the virtualised grid below
     * depends on the body's available height being the same at every tab count.
     * Everything else it used to declare is here.
     *
     * `group-data-focused/panel:bg-bg-3` is the `.panel.focused .panel-head`
     * descendant rule, as a variant. `base.css` states a stronger form of the
     * same fact (`.layout-root .panel.focused .panel-head`, which adds the bar
     * down the leading edge) and, being unlayered and three deep, wins on the
     * background too — the two agree on the colour, so this class is what makes
     * the intent readable here rather than only in a file two directories away.
     *
     * Tabs are the drag handle, so `select-none`: suppressing selection in CSS
     * means the pointer handler does not have to call `preventDefault()`, which
     * would also swallow the click that focuses the panel.
     */
    <div
      className="panel-head h-bar flex flex-none items-stretch shadow-rule-b bg-bg-2 select-none group-data-focused/panel:bg-bg-3 group-data-focused/panel:shadow-head-focused"
      ref={headRef}
      data-tab-caret={caret ?? undefined}
    >
      {/* An empty panel has no tabs to label itself with, and a bare strip reads
          as a rendering fault. */}
      {empty ? <span className="flex flex-none items-center px-snug text-fg-faint">{t('panel.empty')}</span> : null}
      <div
        ref={listRef}
        /* `panel-tabs` keeps three declarations and only three: both overflow
           axes, which `view-drag.test.ts` pins (this is a horizontal scroll
           container, it is emphatically not the grid's, and the scroll must not
           reach the panel or the page), and `scrollbar-width: none`, which has
           no utility. An 11px bar inside a 30px strip would eat a third of it,
           so overflow is read from the clipped tab at the edge instead. */
        className="panel-tabs flex min-w-0 flex-auto items-stretch overflow-x-auto overflow-y-hidden scrollbar-none"
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
            onContextMenu={menu.open(viewId)}
          />
        ))}
      </div>
      {/*
        The glyph is decorative, so it is hidden and the label carries the name.
        Element content outranks `title` when an accessible name is computed, so
        a bare glyph plus a `title` would have a screen reader announce the
        glyph and never the title.
      */}
      {/* The fixed half: never scrolls away, however many tabs there are. The
          `panel-actions` name stays because `view-drag.test.ts` slices this file
          from it to check the three buttons carry accessible names. */}
      <div className="panel-actions flex flex-none items-center gap-inset border-l border-border px-tight">
        <Button
          variant="ghost"
          icon
          label={t('panel.splitRow')}
          tabIndex={focus.childTabIndex}
          onClick={split('row')}
        >
          <span aria-hidden="true">⊞</span>
        </Button>
        <Button
          variant="ghost"
          icon
          label={t('panel.splitCol')}
          tabIndex={focus.childTabIndex}
          onClick={split('col')}
        >
          <span aria-hidden="true">⊟</span>
        </Button>
        <Button
          variant="ghost"
          icon
          label={t('panel.closePanel')}
          tabIndex={focus.childTabIndex}
          onClick={closePanel}
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
      {menu.state ? (
        <TabMenu panel={panel} viewId={menu.state.payload} at={menu.state.at} onClose={menu.close} />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface TabMenuProps {
  panel: PanelNode
  viewId: ViewId
  at: { x: number; y: number }
  onClose: () => void
}

/** The tab's right-click menu; see `tabMenuNodes` for what is offered and why. */
function TabMenu({ panel, viewId, at, onClose }: TabMenuProps): ReactElement {
  const t = useT()
  return (
    <Menu
      label={t('menu.tab.label')}
      at={at}
      nodes={tabMenuNodes(panel, viewId, t, {
        close: () => {
          void dispatch('view.close', { viewId })
        },
        closeOthers: () => {
          /* A loop of `view.close` rather than a `view.closeOthers` command.
             Main has no such command, and adding one would put a second
             definition of "which views survive" into a system whose whole point
             is that the buttons and an AI go through the same vocabulary. This
             is exactly what the user could do by hand, at the speed of a click. */
          for (const id of panel.viewIds) {
            if (id !== viewId) void dispatch('view.close', { viewId: id })
          }
        },
        splitRow: () => {
          void dispatch('layout.split', { panelId: panel.id, dir: 'row' })
        },
        splitCol: () => {
          void dispatch('layout.split', { panelId: panel.id, dir: 'col' })
        },
        closePanel: () => {
          void dispatch('layout.close', { panelId: panel.id })
        },
      })}
      onClose={onClose}
    />
  )
}

/* ------------------------------------------------------------------ */

/**
 * The tab's geometry, and the one declaration that is still a CSS rule.
 *
 * `panel-tab` keeps `--tab-min-width: 96px` and the `min-width` that reads it,
 * because `view-drag.test.ts` asserts that pair by selector: tabs shrink towards
 * it and then the strip scrolls, and a tab squeezed narrower than its own text
 * is not a tab, it is a smear. Nothing else is left in that rule, so no utility
 * below is silently outranked by it.
 *
 * `group/tab` is what the ✕ reads to know the tab is hovered. Named, for the
 * same reason `group/panel` is.
 */
const TAB_BOX =
  'panel-tab group/tab relative flex max-w-55 shrink grow-0 items-center gap-tight border-r border-border py-0 pr-tight pl-snug cursor-grab focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2'

/** The visible tab: its own surface, and the 2px accent mark along its top. */
const TAB_ACTIVE =
  'bg-bg-1 text-fg before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent-dim group-data-focused/panel:before:bg-accent'

/** Every other tab. The hover variant lives here and not on the active one. */
const TAB_REST = 'text-fg-dim hover:bg-bg-hover hover:text-fg'

interface PanelTabProps {
  panelId: PanelId
  viewId: ViewId
  index: number
  active: boolean
  focus: PanelFocusApi
  roving: TabRovingApi
  onContextMenu: (e: ReactMouseEvent) => void
}

/**
 * One tab.
 *
 * A `div` with `role="tab"` rather than a `<button>`, for a plain HTML reason:
 * it contains the close button, and a button inside a button is invalid and
 * behaves unpredictably. The roving `tabIndex` comes from `useTabRoving`, so
 * only the focused panel's active tab is ever in the document's tab order.
 */
function PanelTab({ panelId, viewId, index, active, focus, roving, onContextMenu }: PanelTabProps): ReactElement {
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

  /**
   * A provisional tab keeps itself until the user says otherwise — and says so
   * in italics, the same word editors have used for this for years.
   *
   * Double-click is the promotion gesture here as well as on the session row,
   * and it is on `dblclick` rather than on any single press because the single
   * press already means "show me this one".
   */
  const provisional = view?.provisional === true
  const onDoubleClick = (): void => {
    if (provisional) void dispatch('view.promote', { viewId })
  }

  /*
   * One tab, in two states written as whole alternatives rather than as a base
   * plus overrides.
   *
   * That is not neatness. The old rules got their answer from source order —
   * `.panel-tab.active` is written after `.panel-tab:hover` and wins the
   * specificity tie, so the active tab does *not* change under the pointer — and
   * source order is exactly the fact a translation into a class list loses: a
   * list has no cascade, and `bg-bg-1` beside `hover:bg-bg-hover` would be
   * decided by Tailwind's emission order, where the variant wins. So the active
   * tab simply carries no hover variant.
   *
   * The active tab's marker is a `::before`, and it replaces `box-shadow: inset
   * 0 2px 0`. Same reason as the shadow had: an inset mark changes nothing's
   * size, so the strip does not reflow when the active tab moves — a top border
   * would push the label down two pixels. `before:` needs `relative` on the tab,
   * which adds no stacking context (no `z-index`), checked against the built
   * stylesheet and in Electron.
   *
   * `group-data-focused/panel:before:bg-accent` is `.panel.focused .panel-tab.
   * active`, as a variant. The group is named `/panel` because the grid writes
   * unnamed `group-hover:` variants on its cells; see `PANEL_BOX`.
   */
  const classes = [TAB_BOX, active ? TAB_ACTIVE : TAB_REST]

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
      title={provisional ? t('panel.tab.provisional', { title }) : title}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
    >
      {/* Still loading. A dot rather than a spinner: it sits in a 30px strip
          next to eleven others, and eleven spinners is a disco. */}
      {view?.status === 'loading' ? <span className="size-1.5 flex-none rounded-full bg-warn" /> : null}
      {/* A tab opened to be looked at, not yet kept — `ViewBase.provisional`.
          Italic is the editors' word for it and costs no layout: the strip must
          not reflow at the moment a tab is promoted. It is never the *only*
          signal — the tab's `title` says it in words, for anyone the slant does
          not reach.

          This was `.panel-tab.provisional .tab-title`, a descendant selector,
          and a `group-data-provisional/tab:` variant would say the same thing.
          It is a plain conditional instead because the state is a `const` three
          lines up: reading it off the DOM to feed it back into the same
          component is machinery, not expression. */}
      <span className={provisional ? 'min-w-0 flex-1 truncate italic' : 'min-w-0 flex-1 truncate'}>{title}</span>
      {/* Not a tab stop of its own: a strip of twelve tabs would otherwise be
          twenty-four stops. The keyboard closes a tab with Delete/Backspace
          (see `useTabRoving`), the mouse clicks this. */}
      {/*
       * `aria-hidden`, so `icon`'s mandatory label would be a name nothing can
       * read. It is hidden on purpose — the keyboard closes a tab with
       * Delete/Backspace, and exposing this would double the strip's stops — so
       * `title` alone is right, and the `icon` prop deliberately not used.
       *
       * Hidden until the tab is hovered — **space reserved, not revealed**: a ✕
       * that appears under the cursor shifts the title beside it, and a strip
       * that reflows while being read is worse than a permanently visible glyph.
       * That is `visibility`, and `LAYOUT_ONLY_PROPERTIES` has said so all
       * along: whether the surrounding UI reveals a control at all is the
       * caller's business, in exactly the way `position` is.
       *
       * `.panel-tab:hover .tab-close` and `.panel-tab.active .tab-close` were
       * the migration record's stock example of something a class list cannot
       * express — an *ancestor's* state deciding a descendant's appearance.
       * `group-hover/tab:` is exactly that, and the active case needs no variant
       * at all: this component already knows.
       *
       * Written out in full on both branches rather than pulled from a constant,
       * because the className fence in `ui/__tests__/control-spec.test.ts` reads
       * the attribute itself — a class reached through an identifier is a class
       * no fence can attribute to an element.
       *
       * The `tab-close` name survives, and not for styling:
       * `scripts/verify-chat-restore.mjs` finds this button over CDP as
       * `.panel-tabs .tab-close` and clicks it, the same way it finds the chat
       * panel by `.chat-view`. That is also why it is still on
       * `CLASSNAME_LEDGER` — the ledger's contract is that a name passed to a
       * `<Button>` be defined by some stylesheet and declare nothing outside
       * `LAYOUT_ONLY_PROPERTIES`, and the one declaration that used to be on `.tab-close`
       * is the `flex: 0 0 auto` this button needs anyway. Emptying the ledger
       * would mean retiring the handle, which is an edit to a script this round
       * does not own.
       */}
      <Button
        variant="ghost"
        size="sm"
        className={
          active
            ? 'tab-close flex-none'
            : 'tab-close flex-none invisible group-hover/tab:visible focus-visible:visible'
        }
        tabIndex={-1}
        aria-hidden="true"
        title={t('panel.tab.close', { title })}
        onClick={onClose}
      >
        ✕
      </Button>
    </div>
  )
}
