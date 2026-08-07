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
 * The panel's box, minus the border colour, which is a state.
 *
 * `group/panel` is **named**, and the name is load-bearing rather than tidy: the
 * tab strip reads the panel's focus state through `group-data-focused/panel:`,
 * and a bare `group` here would also answer the `group-hover:` variants the grid
 * writes on its cells (`util/format.ts`) — every cell in the panel would light
 * up the moment the pointer entered it. Verified by reading what those variants
 * compile to, not by reasoning about them.
 */
const PANEL_BOX =
  'panel group/panel relative m-inset flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden rounded-control border bg-bg-1'

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

  /*
   * The panel's box, in three parts, and each part is somewhere different on
   * purpose.
   *
   * 1. **`PANEL_BOX`** — the geometry and the resting paint, as utilities.
   * 2. **`relative` and `overflow-hidden` inside `PANEL_BOX`** — the overlay
   *    is positioned against this box, and the tab strip's horizontal scroll
   *    must not leak out of it. Both were a `.panel` rule in the stylesheet
   *    until §29.11.8; `view-drag.test.ts` pinned them there by reading the rule
   *    body, and now pins them here by reading the class *and* checking what
   *    that class compiles to in the shipped artifact. The `panel` name stays,
   *    for the drop registry and for the tests.
   * 3. **`base.css`'s `.layout-root .panel.focused`** — the focus emphasis.
   *    That selector is three levels deep and unlayered, so it beats both the
   *    `.panel.focused` rule that used to sit beside `.panel` *and* any utility
   *    written here. It was already winning: measured in Electron, a focused
   *    panel draws `--color-accent`, never the `--color-accent-dim` the app.css
   *    rule named. So that rule was dead, and deleting it changes nothing on
   *    screen — the `focused` class stays because it is what base.css selects.
   *
   * `border-accent` for a drop target is written as an alternative to
   * `border-border` rather than stacked on it: two classes from one utility
   * family on one element are resolved by Tailwind's emission order, not by the
   * order they are pushed here. See `ui/CLAUDE.md`.
   *
   * The one rounding: 5px → `rounded-control` (4px). There is no 5px rung, and the
   * record already took the same 1px on the crash box and the gallery row.
   */
  const classes = [
    PANEL_BOX,
    focus.focused || dropZone || tabCaret !== null ? 'border-accent' : 'border-border',
  ]
  // `focused` is still a name, and now it is *only* a name: the ring and the
  // glow it used to trigger from `.layout-root .panel.focused` are the
  // `shadow-panel-focused` beside it, and the head's leading bar reads the same
  // state through `group-data-focused/panel`. What the class still does is mark
  // the panel for `usePanelFocus` and for the drag tests.
  if (focus.focused) classes.push('focused', 'shadow-panel-focused')
  // Dimmed while it is the panel a view is leaving — but not while the pointer
  // is in its own strip, where the gesture is a reorder and the user needs to
  // read the very tabs being dimmed.
  //
  // 0.75, not the 0.55 this shipped with: only "dimmed" was ever argued for, the
  // number was not, and at 0.55 the panel's own --color-fg-dim text composited
  // to 3.23:1 against the desktop behind it. 0.75 keeps the intent and clears AA
  // (--color-fg 7.10, --color-fg-dim 4.87) — legibility baseline §2.2.1. The
  // alpha is under `theme-contrast.test.ts`'s ALPHA_SITES either way; the key is
  // `components/Panel.tsx:opacity-75` now that it is a class rather than
  // `styles.css:.panel.drag-source`.
  if (dragSource && tabCaret === null) classes.push('drag-source', 'opacity-75')

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
      /* The same boolean as the `focused` class above, in the spelling a
         Tailwind variant can match: `group-data-focused/panel:` is an attribute
         selector, and matching a bare class from a group variant needs the
         arbitrary-value syntax the migration record bans. Two spellings, one
         source — the class is what `base.css` selects, the attribute is what the
         tab strip's variants read. */
      data-focused={focus.focused ? '' : undefined}
      data-panel-id={panel.id}
      data-drop-zone={dropZone ?? undefined}
      onMouseDown={onMouseDown}
    >
      <PanelTabs panel={panel} focus={focus} />
      <div
        /* `panel-body` is a name now and nothing else. It was a rule until
           §29.11.8, held there by `view-drag.test.ts` matching the exact string
           `className="panel-body"` — an assertion that could not survive the
           attribute growing a single utility, which is a fence that forbids the
           migration it was not written to have an opinion about. That test reads
           the name now, so the geometry is here. The name still earns its keep:
           the focus ring selects through it, and the drag test finds the element
           by it. */
        className="panel-body relative flex min-h-0 flex-1 flex-col"
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
      <div className="flex flex-1 flex-col items-center justify-center gap-tight text-fg-faint">
        <div>{t('panel.empty')}</div>
        <div>{t('panel.emptyHint')}</div>
        <div className="mt-tight flex gap-snug">{newChat}</div>
      </div>
    )
  }

  const first = ready[0]
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-tight text-fg-faint">
      <div>{t('panel.emptyWithConn', { label: first.label })}</div>
      <div className="mt-tight flex gap-snug">
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
