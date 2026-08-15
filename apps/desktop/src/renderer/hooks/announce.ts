/**
 * Screen-reader announcements for layout and tab changes.
 *
 * ## Why this exists at all, and why it is deliberately small
 *
 * Most of the time nothing here should fire. When focus really moves, the
 * `role="group"` label on the panel and the `role="tab"` semantics in the strip
 * are announced by the screen reader on their own; adding a spoken sentence on
 * top of that is a stutter, and a stutter on every arrow key is worse than
 * silence. So the live region covers exactly the cases where the accessibility
 * tree changed and **focus did not move**, which are real and otherwise
 * completely inaudible:
 *
 *   - an MCP command changes `focusedPanel` while the human is typing in the
 *     sidebar, so `usePanelFocus`'s R2 politely declines to take the caret;
 *   - a `view.activate` brings a different tab to the front of a panel that is
 *     not the one holding focus;
 *   - a panel's last tab closes and the panel stays behind, empty, without the
 *     caret ending up inside it.
 *
 * In both, the window visibly changed and a screen-reader user would have no way
 * to know.
 *
 * ## One region, and only layout messages in it
 *
 * There is exactly one live region in the window (mounted by `App`). A live
 * region per panel would announce four things at once on a re-layout. And
 * nothing about streaming results goes through it: a region that speaks on every
 * row batch drowns out everything else a screen reader has to say, which is the
 * usual way `aria-live` gets turned into noise.
 *
 * ## Positions, not identifiers
 *
 * Every message names a position — "Query, tab 2 of 3, panel 1 of 4". A view id
 * is the right thing for MCP and useless out loud; and "Query" alone does not
 * tell a user who cannot see the strip that there are two more tabs behind it.
 * The positions come from the same depth-first panel order that `⌘⌥1 … ⌘⌥9`
 * addresses and that `read_workspace` lists, so a user and the AI count panels
 * the same way.
 */

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { LayoutNode, PanelId, PanelNode, ViewId, Workspace } from '@peek/core'
import { collectPanels } from '@peek/core'
import { viewTitleOf } from '../components/panelTitle'
import { useT, type TFunction } from '../i18n'
import { useWorkspace } from '../state/workspaceStore'

/* ================================================================== */
/* 1. Positions (pure)                                                 */
/* ================================================================== */

/** A one-based position, ready to be read out. */
export interface Position {
  index: number
  total: number
}

/** Where a panel sits in the depth-first visual order, or null if it is not in the tree. */
export function panelPositionOf(root: LayoutNode, panelId: PanelId): Position | null {
  const panels = collectPanels(root)
  const i = panels.findIndex((p) => p.id === panelId)
  return i < 0 ? null : { index: i + 1, total: panels.length }
}

/** Where a tab sits in its strip, or null if that view is not in this panel. */
export function tabPositionOf(panel: PanelNode, viewId: ViewId): Position | null {
  const i = panel.viewIds.indexOf(viewId)
  return i < 0 ? null : { index: i + 1, total: panel.viewIds.length }
}

/* ================================================================== */
/* 2. Phrases (pure)                                                   */
/* ================================================================== */

/**
 * What a panel is currently showing, as a phrase.
 *
 * The tab position is folded in **only when there is more than one tab**: "Query,
 * tab 1 of 1" spends three extra words to say the panel has one view, which the
 * absence of a position already said. This is the single builder behind both
 * announcements and the panel's own `aria-label`, so a view is never called one
 * thing on entering a panel and another when its tab is selected.
 */
export function panelContentPhrase(t: TFunction, ws: Workspace, panel: PanelNode): string {
  const viewId = panel.activeViewId
  if (viewId === null) return t('panel.empty')
  const view = ws.views[viewId]
  // A tab whose view has already been dropped from the map: name it by position
  // rather than printing a raw id at someone who cannot check it against a screen.
  const title = view ? viewTitleOf(t, view) : t('panel.empty')
  const pos = tabPositionOf(panel, viewId)
  if (!pos || pos.total < 2) return title
  return t('a11y.tab.position', { title, index: pos.index, total: pos.total })
}

/**
 * `aria-label` for the panel element, which is a `role="group"`.
 *
 * Read out whenever focus enters the panel, so it has to answer "which panel am
 * I in" — hence the position, which is also the number `⌘⌥N` addresses.
 */
export function panelAriaLabel(t: TFunction, ws: Workspace, panel: PanelNode): string {
  const pos = panelPositionOf(ws.layout, panel.id)
  const index = pos?.index ?? 1
  if (panel.activeViewId === null) return t('a11y.panel.empty', { index })
  return t('a11y.panel.label', { index, title: panelContentPhrase(t, ws, panel) })
}

/**
 * "Panel 2 of 4, Query, tab 1 of 3" — focus moved, but the caret did not follow.
 *
 * Panel first: the news is *where you now are*, and the content is the context.
 */
export function panelFocusMessage(t: TFunction, ws: Workspace, panelId: PanelId): string | null {
  const panels = collectPanels(ws.layout)
  const i = panels.findIndex((p) => p.id === panelId)
  if (i < 0) return null
  return t('a11y.announce.panelFocused', {
    index: i + 1,
    total: panels.length,
    content: panelContentPhrase(t, ws, panels[i]),
  })
}

/**
 * "Query, tab 2 of 3, panel 1 of 4" — a different tab is showing now.
 *
 * Content first, mirroring the sentence above in reverse: here the news is
 * *what is now on screen*, and the panel is the trailing context.
 */
export function tabActivationMessage(t: TFunction, ws: Workspace, panelId: PanelId): string | null {
  const panels = collectPanels(ws.layout)
  const i = panels.findIndex((p) => p.id === panelId)
  if (i < 0) return null
  return t('a11y.announce.tabActivated', {
    index: i + 1,
    total: panels.length,
    content: panelContentPhrase(t, ws, panels[i]),
  })
}

/* ================================================================== */
/* 3. The region's store                                               */
/* ================================================================== */

interface AnnouncementState {
  text: string
  /** Bumped on every announcement, including a repeat of the same words. */
  seq: number
}

export const useAnnouncementStore = create<AnnouncementState>(() => ({ text: '', seq: 0 }))

export function announce(text: string): void {
  if (text === '') return
  useAnnouncementStore.setState((s) => ({ text, seq: s.seq + 1 }))
}

/**
 * The text to render inside the live region.
 *
 * The trailing space on every other announcement is not decoration. A polite
 * live region is re-read when its content *changes*; moving focus away from
 * panel 2 and straight back produces the identical sentence twice, and a screen
 * reader that diffs the text would say it once. Alternating an invisible
 * character makes every announcement a change. The alternative — two regions
 * written to in turn — costs a second element and a second thing to keep
 * labelled, for the same effect.
 */
export function useAnnouncement(): string {
  const text = useAnnouncementStore((s) => s.text)
  const seq = useAnnouncementStore((s) => s.seq)
  return text === '' ? '' : seq % 2 === 0 ? text : `${text} `
}

/* ================================================================== */
/* 4. The decision (pure)                                              */
/* ================================================================== */

/** What the live region should report about one change. */
export type Announcement =
  | { kind: 'panelFocused'; panelId: PanelId }
  | { kind: 'tabActivated'; panelId: PanelId }
  | { kind: 'panelEmptied'; panelId: PanelId }

/** One reading of the layout, reduced to the two things announcements turn on. */
export interface LayoutSnapshot {
  focusedPanel: PanelId | null
  /** Every panel in the tree mapped to its visible tab, `null` when it has none. */
  active: ReadonlyMap<PanelId, ViewId | null>
}

/**
 * Where the caret actually ended up — asked of the DOM by the caller.
 *
 * Injected rather than looked up here so the decision below is a pure function
 * of two snapshots and two booleans. Every "should this be spoken?" rule is then
 * testable without a DOM, which matters because the rules are all about
 * *silence*: the failure they guard against is a screen reader saying nothing,
 * and that is precisely what an example-free implementation gets wrong.
 */
export interface FocusProbe {
  insidePanel: (panelId: PanelId) => boolean
  onTabIn: (panelId: PanelId) => boolean
  /**
   * The caret is on the panel's own element — the `role="group"` that carries
   * the "Empty panel N" label.
   *
   * Narrower than `insidePanel` on purpose, and only the emptied case uses it. A
   * label is announced by focus landing on the element it labels, and an empty
   * panel has exactly one such element; the body beside it is a `tabIndex={-1}`
   * div that a click can land on and that, once the tabs are gone, carries no
   * role and no name at all. "Somewhere in the panel" would call that silence
   * covered when nothing had been said.
   */
  onPanelElement: (panelId: PanelId) => boolean
}

/**
 * The whole policy of the live region, in one function.
 *
 * Three changes are worth reporting and each is suppressed when focus already
 * reported it:
 *
 *  - `focusedPanel` moved and the caret did not follow (R2's courtesy guard);
 *  - one panel's visible tab changed and the caret is not in that strip;
 *  - one panel emptied — its last tab closed and it stayed behind, which the tab
 *    contract makes an ordinary thing to do — and the caret is not in it.
 *
 * Two or more panels changing at once is a re-layout rather than a tab switch,
 * and reading four sentences would bury the one that mattered, so it says
 * nothing.
 */
export function announcementFor(
  before: LayoutSnapshot,
  after: LayoutSnapshot,
  focus: FocusProbe,
): Announcement | null {
  if (before.focusedPanel !== after.focusedPanel) {
    const panelId = after.focusedPanel
    if (panelId === null) return null
    // Focus followed: the group label was announced already.
    if (focus.insidePanel(panelId)) return null
    return { kind: 'panelFocused', panelId }
  }

  const changed: PanelId[] = []
  for (const [panelId, viewId] of after.active) {
    if (before.active.has(panelId) && before.active.get(panelId) !== viewId) changed.push(panelId)
  }
  if (changed.length !== 1) return null
  const panelId = changed[0]

  if (after.active.get(panelId) === null) {
    // The panel's `aria-label` has just become "Empty panel N" — but a label is
    // only read when focus is on the thing it labels, and R2 moves the caret
    // there only when it had it to begin with. Skipping this case entirely, as
    // an earlier version did, left a panel going blank as the one layout change
    // that nothing reported at all: with the caret dropped to `document.body`
    // and no landmark in the layout to Tab back through, a screen-reader user
    // lost both the focus and the news.
    if (focus.onPanelElement(panelId)) return null
    return { kind: 'panelEmptied', panelId }
  }

  // The caret is on a tab in that very strip, so the tab's own role and label
  // were announced by the move that selected it.
  if (focus.onTabIn(panelId)) return null
  return { kind: 'tabActivated', panelId }
}

/** The sentence for an announcement, or null when the panel has left the tree. */
export function announcementMessage(t: TFunction, ws: Workspace, a: Announcement): string | null {
  switch (a.kind) {
    case 'panelFocused':
      return panelFocusMessage(t, ws, a.panelId)
    case 'tabActivated':
      return tabActivationMessage(t, ws, a.panelId)
    case 'panelEmptied': {
      // The panel's own `aria-label`, deliberately: what a reader would have
      // heard had focus landed there. One wording, two routes to it.
      const panel = collectPanels(ws.layout).find((p) => p.id === a.panelId)
      return panel ? panelAriaLabel(t, ws, panel) : null
    }
  }
}

/* ================================================================== */
/* 5. The watcher                                                      */
/* ================================================================== */

/**
 * Watch the layout and speak the changes focus did not already report.
 *
 * Mounted **once**, by `App`. Doing this per panel would mean four panels racing
 * to describe one re-layout; doing it inside `usePanelFocus` would mean the hook
 * that decides whether to move focus also decides what to say about not moving
 * it, and the two would drift.
 *
 * Effect ordering is what makes the "did focus follow?" test honest: React runs
 * child effects before parent ones, so by the time this runs, every panel's R2
 * has already either taken the caret or declined. Asking the DOM is therefore
 * asking about a settled fact, not a race.
 */
export function useLayoutAnnouncer(): void {
  const t = useT()
  const ws = useWorkspace()
  const prev = useRef<LayoutSnapshot | null>(null)

  useEffect(() => {
    if (!ws) return
    const panels = collectPanels(ws.layout)
    const after: LayoutSnapshot = {
      focusedPanel: ws.focusedPanel,
      active: new Map<PanelId, ViewId | null>(panels.map((p) => [p.id, p.activeViewId])),
    }
    const before = prev.current
    prev.current = after
    // First snapshot. Nothing changed — the window just appeared, and announcing
    // its initial state to someone who has not touched it yet is noise.
    if (!before) return

    const a = announcementFor(before, after, domFocusProbe)
    if (a === null) return
    const message = announcementMessage(t, ws, a)
    if (message) announce(message)
  }, [ws, t])
}

const domFocusProbe: FocusProbe = {
  insidePanel: focusIsInsidePanel,
  onTabIn: focusIsOnTabIn,
  onPanelElement: focusIsOnPanelElement,
}

/* ------------------------------------------------------------------ */

/**
 * The panel's DOM element, found by the `data-panel-id` attribute `Panel` sets.
 *
 * Scanned rather than passed through a selector string, because a panel id is
 * data and `CSS.escape` is not available in the headless test environment; a
 * scan over at most `MAX_LAYOUT_PANELS` nodes costs nothing and cannot be made
 * to mean something else by a strange id.
 */
function panelElement(panelId: PanelId): Element | null {
  if (typeof document === 'undefined') return null
  for (const el of document.querySelectorAll('[data-panel-id]')) {
    if (el.getAttribute('data-panel-id') === panelId) return el
  }
  return null
}

function focusIsInsidePanel(panelId: PanelId): boolean {
  const el = panelElement(panelId)
  return el !== null && el.contains(document.activeElement)
}

function focusIsOnPanelElement(panelId: PanelId): boolean {
  const el = panelElement(panelId)
  return el !== null && el === document.activeElement
}

function focusIsOnTabIn(panelId: PanelId): boolean {
  const active = document.activeElement
  if (active === null || active.getAttribute('role') !== 'tab') return false
  const el = panelElement(panelId)
  return el !== null && el.contains(active)
}
