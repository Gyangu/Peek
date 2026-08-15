/**
 * The window's global shortcuts.
 *
 * Structure worth keeping: this file only *translates*. `resolveShortcut`
 * decides what a keystroke means, `layout-nav` decides which panel is that way,
 * and everything that changes anything leaves as a Command. Nothing here writes
 * to the store — the keyboard is the accessible twin of dragging a view, so it
 * goes through exactly the same Commands a drop does, and the UI moves when the
 * patch comes back, never before.
 *
 * That twinning is also why the tab chords look the way they do. `⌘1`, `⌃Tab`
 * and `⌘W` send `view.activate` / `view.close`, the same Commands a click on a
 * tab and a click on its ✕ send; there is no keyboard-only path into the layout
 * tree, and nothing here that MCP could not also ask for.
 */

import { useEffect } from 'react'
import { findPanel, type PanelNode } from '@peek/core'
import { loadBindings, readBindings } from '../keys/store'
import { dispatch } from '../state/dispatch'
import { openSettings } from '../state/settingsDialogStore'
import { toggleShortcutSheet } from '../state/shortcutSheetStore'
import { readWorkspace } from '../state/workspaceStore'
import { directionPlacement, findPanelInDirection, panelIdAt, type Direction } from './layout-nav'
import { chordOf, resolveShortcut, type ShortcutAction } from './shortcuts'

export function useGlobalKeys(): void {
  useEffect(() => {
    // The user's own bindings, once. The listener below reads the table on every
    // keystroke rather than closing over it, so a rebinding made in settings
    // takes effect on the next key — no re-registration, no stale closure.
    void loadBindings()

    const onKey = (e: KeyboardEvent): void => {
      const action = resolveShortcut(chordOf(e), { textEntry: isTextEntry(eventElement(e)) }, readBindings())
      if (!action) return
      if (action.kind === 'leaveTextEntry') {
        // No preventDefault: Esc may mean something to whatever else is listening
        // (a modal, a drag in progress). Dropping focus is additive.
        blurActive()
        return
      }
      e.preventDefault()
      // The two actions here that are not Commands. "A dialog is open" is not
      // Workspace state — nothing persistent changes, and MCP has no use for the
      // panel a human would have clicked through. See `settingsDialogStore`.
      if (action.kind === 'openSettings') {
        openSettings()
        return
      }
      if (action.kind === 'openShortcuts') {
        // Toggles: ⌘/ is how the sheet is dismissed as well as summoned.
        toggleShortcutSheet()
        return
      }
      runAction(action)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

/* ================================================================== */
/* Intent → Command                                                    */
/* ================================================================== */

function runAction(action: ShortcutAction): void {
  const ws = readWorkspace()
  if (!ws) return

  if (action.kind === 'focusIndex') {
    const panelId = panelIdAt(ws.layout, action.index)
    if (panelId && panelId !== ws.focusedPanel) void dispatch('layout.focus', { panelId })
    return
  }

  const panelId = ws.focusedPanel
  if (!panelId) return
  const panel = findPanel(ws.layout, panelId)

  switch (action.kind) {
    case 'split':
      void dispatch('layout.split', { panelId, dir: action.dir })
      return
    case 'closePanel':
      void dispatch('layout.close', { panelId })
      return
    case 'closeTab':
      // An empty panel has no tab to close, and ⌘W on one can only sensibly mean
      // "get rid of this". That is what keeps ⌘\ then ⌘W an undo of itself now
      // that ⌘W no longer closes panels outright.
      if (!panel || panel.activeViewId === null) void dispatch('layout.close', { panelId })
      else void dispatch('view.close', { viewId: panel.activeViewId })
      return
    case 'activateTab':
      if (panel) activateTabAt(panel, action.index)
      return
    case 'cycleTab':
      if (panel) cycleTab(panel, action.delta)
      return
    case 'focusDirection': {
      const target = findPanelInDirection(ws.layout, panelId, action.dir)
      // No panel that way: the focused panel is already against that edge of the
      // window. Silence is the right answer — nothing failed.
      if (!target || target === panelId) return
      void dispatch('layout.focus', { panelId: target })
      return
    }
    case 'moveViewDirection':
      moveFocusedView(action.dir, 'stack')
      return
    case 'splitWithViewDirection':
      moveFocusedView(action.dir, 'split')
      return
  }
}

/* ================================================================== */
/* Tabs                                                                */
/* ================================================================== */

/**
 * Show the Nth tab, or the last one.
 *
 * Out of range is silence, not an error: `⌘5` on a three-tab panel means the
 * user guessed, and the honest response is for nothing to happen. A no-op is
 * filtered here rather than left to main so that holding `⌘1` on the tab that is
 * already showing does not fill the bus with commands that change nothing.
 */
function activateTabAt(panel: PanelNode, index: number | 'last'): void {
  const i = index === 'last' ? panel.viewIds.length - 1 : index
  const viewId = panel.viewIds[i]
  if (viewId === undefined || viewId === panel.activeViewId) return
  void dispatch('view.activate', { viewId, focusPanel: true })
}

/**
 * Step through the tabs of the focused panel, wrapping at both ends.
 *
 * Tab-bar order, not most-recently-used. Order is what the user can see: the
 * next tab is the one to the right of the one they are looking at, which they
 * can predict before pressing the key. An MRU ring would need a per-panel
 * history stack — extra state for main to own, for immer to patch across, and
 * for an AI reading `read_workspace` to reason about — in exchange for an order
 * nobody can see.
 */
function cycleTab(panel: PanelNode, delta: 1 | -1): void {
  const count = panel.viewIds.length
  if (count < 2) return
  const current = panel.activeViewId === null ? 0 : panel.viewIds.indexOf(panel.activeViewId)
  const viewId = panel.viewIds[((((current < 0 ? 0 : current) + delta) % count) + count) % count]
  if (viewId === undefined || viewId === panel.activeViewId) return
  void dispatch('view.activate', { viewId, focusPanel: true })
}

/* ================================================================== */
/* Directional moves                                                   */
/* ================================================================== */

/**
 * The keyboard equivalent of dragging the focused panel's visible view.
 *
 * `stack` is a centre drop on the neighbour: the view is appended as a tab there
 * and becomes the one showing. It deliberately **does not** swap any more.
 * Swapping survives as a Command mode an AI can name, but no gesture produces
 * it — with tabs in the model, displacing whatever the neighbour was showing is
 * strictly more surprising than adding to it, and the mouse made the same
 * choice, so the two gestures cannot drift apart.
 *
 * `split` is a drop on the neighbour's *far* edge, so the view ends up in a new
 * panel beyond it. Both resolve the neighbour with the same geometry the focus
 * keys use, and `split` takes its direction from `dropZonePlacement`, the table
 * the mouse path reads.
 *
 * With no neighbour in that direction there is nothing to do. Splitting the
 * focused panel itself would be an identity transform (the source panel empties
 * and collapses straight back), so it is not offered as a consolation.
 *
 * An empty focused panel — what ⌘\ leaves behind — has no view to move either.
 * Filling it stays a directional move made from the other side: ⌘⌥ over to a
 * panel that holds something, then ⌘⇧ back towards the empty one. Deliberately
 * no "pull the neighbour's view here" gesture: it would be the only chord where
 * the arrow points opposite to the direction the view travels.
 */
function moveFocusedView(dir: Direction, mode: 'stack' | 'split'): void {
  const ws = readWorkspace()
  if (!ws?.focusedPanel) return
  const from = ws.focusedPanel
  // The *visible* tab. A chord that moved a hidden view would move something the
  // user cannot see, which no arrow key should ever do.
  const viewId = findPanel(ws.layout, from)?.activeViewId
  if (!viewId) return
  const target = findPanelInDirection(ws.layout, from, dir)
  if (!target || target === from) return

  if (mode === 'stack') {
    void dispatch('layout.moveView', { viewId, toPanelId: target, onOccupied: 'stack' })
    return
  }
  const placement = directionPlacement(dir)
  void dispatch('layout.splitWithView', {
    viewId,
    panelId: target,
    dir: placement.dir,
    insert: placement.insert,
  })
}

/* ================================================================== */
/* Text-entry detection                                                */
/* ================================================================== */

function eventElement(e: KeyboardEvent): Element | null {
  if (e.target instanceof Element) return e.target
  return document.activeElement
}

/**
 * Whether focus is somewhere that owns the arrow keys.
 *
 * `.cm-editor` is matched on the ancestor chain rather than on the focused node
 * alone: CodeMirror focuses `.cm-content`, and its tooltips and panels put focus
 * on other descendants.
 */
function isTextEntry(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type)
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return el.closest('.cm-editor') !== null
}

/** Input types that do not consume arrow keys for text editing. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'reset',
  'submit',
])

function blurActive(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) el.blur()
}
