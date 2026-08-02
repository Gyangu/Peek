import { useCallback, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { PanelNode } from '@peek/core'
import { useT } from '../i18n'
import { composeRefs, panelTabWidgetRoles, usePanelFocus } from '../hooks/usePanelFocus'
import { dispatch } from '../state/dispatch'
import { useConnections, useView } from '../state/workspaceStore'
import { PanelDropOverlay } from './DropZoneOverlay'
import { registerPanelEl, useIsDragSource, usePanelDropZone, usePanelTabCaret } from './dragStore'
import { PanelTabs } from './PanelTabs'
import { viewTitleOf } from './panelTitle'
import { ViewHost } from './ViewHost'
import { Button } from '../ui/Button'

/**
 * A leaf of the tiled layout: one panel, holding a stack of views as tabs, of
 * which exactly one is visible.
 *
 * The panel owns three things and delegates the rest:
 * - the container element, which is a single roving stop in the window's tab
 *   order and the rectangle a drop is hit-tested against;
 * - the body, which is the `tabpanel` the active tab controls;
 * - the `PanelFocusApi` object, created here and handed to `PanelTabs`. That
 *   object is the entire contact surface between the two files: the strip needs
 *   the panel's focus state to decide its own roving indices, and both need the
 *   same DOM ids or `aria-controls` and `aria-labelledby` stop pairing up.
 *
 * Only the active view is mounted. A background tab is a `ViewId` in a list, not
 * a rendered component: mounting twelve grids per panel to preserve scroll
 * offsets would cost far more than it saves, and the view keeps its `resultId`
 * either way, so switching back re-renders from the cache rather than re-running
 * anything.
 */
export function PanelView({ panel, index }: { panel: PanelNode; index: number }): ReactElement {
  const t = useT()
  // The active view is passed in as the content key: it is what R2 watches to
  // notice that the element holding the caret has just been unmounted (closing
  // the last tab takes the whole body with it), so that focus lands back on this
  // panel instead of on `document.body`.
  const focus = usePanelFocus(panel.id, panel.activeViewId)
  const activeView = useView(panel.activeViewId)
  const dropZone = usePanelDropZone(panel.id)
  const tabCaret = usePanelTabCaret(panel.id)
  const dragSource = useIsDragSource(panel.id)
  const title = activeView ? viewTitleOf(t, activeView) : null
  const roles = panelTabWidgetRoles(panel.viewIds.length)

  // The registry is what a drag hit-tests against. A callback ref keeps it in
  // step with mount/unmount without an effect, and the `panel.id` dependency
  // makes React re-run it (null, then the node) if a panel is ever re-keyed.
  const dragRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerPanelEl(panel.id, el)
    },
    [panel.id],
  )
  // Memoised, not composed inline: a fresh callback ref on every render makes
  // React detach and re-attach the node each time, which would deregister the
  // panel from the drop registry mid-drag.
  const panelRef = useMemo(() => composeRefs<HTMLDivElement>(dragRef, focus.ref), [dragRef, focus.ref])

  const onMouseDown = (): void => {
    if (!focus.focused) void dispatch('layout.focus', { panelId: panel.id })
  }

  const classes = ['panel']
  if (focus.focused) classes.push('focused')
  // Dimmed while it is the panel a view is leaving — but not while the pointer
  // is in its own strip, where the gesture is a reorder and the user needs to
  // read the very tabs being dimmed.
  if (dragSource && tabCaret === null) classes.push('drag-source')
  if (dropZone || tabCaret !== null) classes.push('drop-target')

  const label =
    title === null
      ? t('a11y.panel.empty', { index: index + 1 })
      : t('a11y.panel.label', { index: index + 1, title })

  return (
    <div
      ref={panelRef}
      className={classes.join(' ')}
      /* `group`, deliberately not `region`: a region is a landmark, and sixteen
         landmarks in one window is noise. There is no `aria-current` for "this
         is the active panel" either — the honest signal for that is real DOM
         focus and a visible focus ring, which is what `usePanelFocus` maintains. */
      role="group"
      aria-label={label}
      tabIndex={focus.panelTabIndex}
      onFocus={focus.onFocus}
      data-panel-id={panel.id}
      data-drop-zone={dropZone ?? undefined}
      onMouseDown={onMouseDown}
    >
      <PanelTabs panel={panel} focus={focus} />
      <div
        className="panel-body"
        /* An empty panel is not a tab panel: with no tabs there is nothing to
           label it and nothing pointing `aria-controls` at it, so the role and
           the id would describe an orphan — a tab panel no tab controls,
           carrying no accessible name. `panelTabWidgetRoles` decides this and
           the strip's `tablist` from the same number, because dropping one
           without the other is what produced the orphan in the first place.
           `tabIndex` stays -1 either way: the body holds focusable things of its
           own (the grid, the editor), and 0 would add a second stop beside the
           panel's own. */
        role={roles.tabpanel}
        id={roles.tabpanel === undefined ? undefined : focus.tabpanelId}
        aria-labelledby={panel.activeViewId === null ? undefined : focus.tabId(panel.activeViewId)}
        tabIndex={-1}
      >
        {panel.activeViewId === null ? (
          <EmptyPanel panelId={panel.id} tabIndex={focus.childTabIndex} />
        ) : (
          <ViewHost viewId={panel.activeViewId} />
        )}
        {/* Inside the body, not the panel: the five-zone geometry now measures
            the body rectangle (the strip took its own band off the top), and
            anchoring the preview to the same box is what keeps the highlight and
            the resulting split describing one thing. A drop on the strip draws a
            caret instead, which is painted in viewport coordinates elsewhere. */}
        <PanelDropOverlay panelId={panel.id} occupantTitle={title} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * `tabIndex` is threaded in rather than defaulted: these buttons are interactive
 * descendants of a panel, and an unfocused panel keeps every one of its
 * descendants out of the document tab order (level 1 of the roving model).
 * Sixteen empty panels would otherwise be dozens of stops between the sidebar
 * and the grid.
 *
 * The chat button sits in **both** branches while the data buttons sit in only
 * one, and that asymmetry is the point: a conversation is a peer of the
 * connections rather than a window onto one, so it is the single thing here that
 * is worth offering to somebody who has not connected to anything yet.
 */
function EmptyPanel({ panelId, tabIndex }: { panelId: PanelNode['id']; tabIndex: 0 | -1 }): ReactElement {
  const t = useT()
  const conns = useConnections()
  const ready = conns.filter((c) => c.status === 'ready')

  const newChat = (
    <Button
      tabIndex={tabIndex}
      onClick={() => {
        void dispatch('view.open', { spec: { kind: 'chat' }, panelId })
      }}
    >
      {t('panel.newChat')}
    </Button>
  )

  if (ready.length === 0) {
    return (
      <div className="panel-empty">
        <div>{t('panel.empty')}</div>
        <div style={{ color: 'var(--fg-faint)' }}>{t('panel.emptyHint')}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>{newChat}</div>
      </div>
    )
  }

  const first = ready[0]
  return (
    <div className="panel-empty">
      <div style={{ color: 'var(--fg-faint)' }}>
        {t('panel.emptyWithConn', { label: first.label })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button
          tabIndex={tabIndex}
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'query', connId: first.id },
              panelId,
            })
          }}
        >
          {t('panel.newQuery')}
        </Button>
        <Button
          tabIndex={tabIndex}
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'tree', connId: first.id },
              panelId,
            })
          }}
        >
          {t('panel.objectTree')}
        </Button>
        {newChat}
      </div>
    </div>
  )
}
