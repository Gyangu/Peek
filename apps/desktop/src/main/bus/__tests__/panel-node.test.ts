import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PANEL_TABS,
  activatePanelTab,
  asConnId,
  asPanelId,
  asSplitId,
  asViewId,
  clearPanelTabs,
  collectMountedViewIds,
  collectVisibleViewIds,
  createEmptyWorkspace,
  findPanelOfView,
  insertPanelTab,
  isPanelEmpty,
  makePanel,
  nextActiveTab,
  overflowingPanel,
  panelTabIndex,
  removePanelTab,
  snapshotWorkspace,
  type LayoutNode,
  type PanelId,
  type PanelNode,
  type ViewId,
  type ViewState,
} from '@peek/core'
import { assertPanelInvariants } from './panel-invariants'

/**
 * The reference tests for the panel-tab data model.
 *
 * This file is the worked example the four parallel paths build against: every
 * rule the tab contract states is asserted here once, against the pure
 * primitives in `@peek/core/workspace`, with no tree, no draft and no React in
 * the way. `layout-ops.test.ts` composes these over the layout tree; it should
 * not restate them.
 *
 * `assertPanelInvariants` — imported from `./panel-invariants`, which is not a
 * test file, because `node:test` re-registers every case in a `.test.ts` module
 * that another test file imports — is the shared checker. Every operation that
 * produces a panel, in this file and in layout-ops, is expected to run its
 * output through it, so P1 through P6 are enforced by construction rather than
 * remembered case by case. The cases just below prove the checker itself
 * rejects each way of breaking them.
 */

/* ------------------------------------------------------------------ */
/* Construction helpers                                                */
/* ------------------------------------------------------------------ */

const P = (n: string): PanelId => asPanelId(`panel_${n}`)
const V = (n: string): ViewId => asViewId(`view_${n}`)
const panelOf = (n: string, views: string[] = [], active?: string): PanelNode =>
  makePanel(P(n), views.map(V), active === undefined ? undefined : V(active))

/* ------------------------------------------------------------------ */
/* makePanel — P1 and P2 hold by construction                          */
/* ------------------------------------------------------------------ */

test('makePanel: an empty panel has no active tab (P1)', () => {
  const panel = makePanel(P('a'))
  assert.deepEqual(panel.viewIds, [])
  assert.equal(panel.activeViewId, null)
  assert.equal(isPanelEmpty(panel), true)
})

test('makePanel: a non-empty panel always shows something — the first tab by default (P1)', () => {
  const panel = panelOf('a', ['1', '2', '3'])
  assert.deepEqual(panel.viewIds, ['view_1', 'view_2', 'view_3'])
  assert.equal(panel.activeViewId, 'view_1')
})

test('makePanel: an activeViewId outside viewIds is corrected to the first tab, never kept (P2)', () => {
  const panel = makePanel(P('a'), [V('1'), V('2')], V('ghost'))
  assert.equal(panel.activeViewId, 'view_1')
})

/* ------------------------------------------------------------------ */
/* insertPanelTab                                                      */
/* ------------------------------------------------------------------ */

test('insertPanelTab: appends at the end and activates by default', () => {
  const next = insertPanelTab(panelOf('a', ['1', '2']), V('3'))
  assert.deepEqual(next.viewIds, ['view_1', 'view_2', 'view_3'])
  assert.equal(next.activeViewId, 'view_3')
})

test('insertPanelTab: an explicit index is the final position, and it is clamped, not rejected', () => {
  const base = panelOf('a', ['1', '2', '3'])
  assert.deepEqual(insertPanelTab(base, V('x'), { index: 0 }).viewIds, [
    'view_x',
    'view_1',
    'view_2',
    'view_3',
  ])
  assert.deepEqual(insertPanelTab(base, V('x'), { index: 2 }).viewIds, [
    'view_1',
    'view_2',
    'view_x',
    'view_3',
  ])
  assert.deepEqual(insertPanelTab(base, V('x'), { index: 99 }).viewIds, [
    'view_1',
    'view_2',
    'view_3',
    'view_x',
  ])
  assert.deepEqual(insertPanelTab(base, V('x'), { index: -5 }).viewIds, [
    'view_x',
    'view_1',
    'view_2',
    'view_3',
  ])
})

test('insertPanelTab: activate:false leaves the visible tab alone', () => {
  const next = insertPanelTab(panelOf('a', ['1', '2']), V('3'), { activate: false })
  assert.deepEqual(next.viewIds, ['view_1', 'view_2', 'view_3'])
  assert.equal(next.activeViewId, 'view_1', 'a background tab arrived; nothing on screen changed')
})

test('insertPanelTab: activate:false on an empty panel still has to show the newcomer (P1)', () => {
  const next = insertPanelTab(makePanel(P('a')), V('1'), { activate: false })
  assert.deepEqual(next.viewIds, ['view_1'])
  assert.equal(next.activeViewId, 'view_1', 'P1 is not negotiable: a non-empty panel shows something')
})

test('insertPanelTab: re-inserting a view already present is a reorder, not a duplicate (P3)', () => {
  const next = insertPanelTab(panelOf('a', ['1', '2', '3'], '2'), V('1'), { index: 2, activate: false })
  assert.deepEqual(next.viewIds, ['view_2', 'view_3', 'view_1'])
  assert.equal(next.activeViewId, 'view_2')
})

test('insertPanelTab: the index is measured after the view is detached, so a rightward reorder needs no adjustment', () => {
  // ['1','2','3'], move view_1 to final index 1 -> after removal the rest is
  // ['2','3'], inserting at 1 gives ['2','1','3']. The moved view really does
  // end up at index 1, which is what the Command's `index` promises.
  const next = insertPanelTab(panelOf('a', ['1', '2', '3']), V('1'), { index: 1 })
  assert.deepEqual(next.viewIds, ['view_2', 'view_1', 'view_3'])
  assert.equal(next.viewIds.indexOf(V('1')), 1)
})

test('insertPanelTab: a move that changes nothing returns the panel by identity (writeLayout depends on it)', () => {
  const base = panelOf('a', ['1', '2'], '2')
  assert.equal(insertPanelTab(base, V('2'), { index: 1 }), base)
  assert.equal(insertPanelTab(base, V('2')), base, 'append is already its position')
})

test('insertPanelTab: a reorder that only changes the active tab is still a change', () => {
  const base = panelOf('a', ['1', '2'], '2')
  const next = insertPanelTab(base, V('1'), { index: 0 })
  assert.notEqual(next, base)
  assert.deepEqual(next.viewIds, ['view_1', 'view_2'])
  assert.equal(next.activeViewId, 'view_1')
})

/* ------------------------------------------------------------------ */
/* removePanelTab and the succession rule                              */
/* ------------------------------------------------------------------ */

test('removePanelTab: closing the active tab activates the right neighbour', () => {
  const next = removePanelTab(panelOf('a', ['1', '2', '3'], '2'), V('2'))
  assert.deepEqual(next.viewIds, ['view_1', 'view_3'])
  assert.equal(next.activeViewId, 'view_3')
})

test('removePanelTab: with no right neighbour it falls back to the left', () => {
  const next = removePanelTab(panelOf('a', ['1', '2', '3'], '3'), V('3'))
  assert.deepEqual(next.viewIds, ['view_1', 'view_2'])
  assert.equal(next.activeViewId, 'view_2')
})

test('removePanelTab: closing a background tab does not change what is on screen', () => {
  const next = removePanelTab(panelOf('a', ['1', '2', '3'], '2'), V('3'))
  assert.deepEqual(next.viewIds, ['view_1', 'view_2'])
  assert.equal(next.activeViewId, 'view_2')
})

test('removePanelTab: closing the last tab empties the panel; the panel itself survives (P1)', () => {
  const next = removePanelTab(panelOf('a', ['1']), V('1'))
  assert.deepEqual(next.viewIds, [])
  assert.equal(next.activeViewId, null)
  assert.equal(next.id, 'panel_a', 'view.close never removes a panel — that is layout.close')
})

test('removePanelTab: a view this panel does not hold leaves it untouched, by identity', () => {
  const base = panelOf('a', ['1', '2'])
  assert.equal(removePanelTab(base, V('ghost')), base)
})

test('nextActiveTab: the succession rule on its own', () => {
  const ids = [V('1'), V('2'), V('3')]
  assert.equal(nextActiveTab(ids, V('2'), V('2')), 'view_3', 'right neighbour')
  assert.equal(nextActiveTab(ids, V('3'), V('3')), 'view_2', 'then left')
  assert.equal(nextActiveTab([V('1')], V('1'), V('1')), null, 'then nothing')
  assert.equal(nextActiveTab(ids, V('1'), V('3')), 'view_3', 'a background close keeps the active tab')
})

/* ------------------------------------------------------------------ */
/* activatePanelTab / clearPanelTabs                                   */
/* ------------------------------------------------------------------ */

test('activatePanelTab: shows an existing background tab', () => {
  const next = activatePanelTab(panelOf('a', ['1', '2', '3']), V('3'))
  assert.equal(next.activeViewId, 'view_3')
  assert.deepEqual(next.viewIds, ['view_1', 'view_2', 'view_3'], 'activating never reorders')
})

test('activatePanelTab: already active, or not held at all, returns the panel by identity', () => {
  const base = panelOf('a', ['1', '2'], '2')
  assert.equal(activatePanelTab(base, V('2')), base)
  assert.equal(activatePanelTab(base, V('ghost')), base)
})

test('clearPanelTabs: empties in one step and is idempotent by identity', () => {
  const cleared = clearPanelTabs(panelOf('a', ['1', '2', '3']))
  assert.deepEqual(cleared.viewIds, [])
  assert.equal(cleared.activeViewId, null)
  assert.equal(clearPanelTabs(cleared), cleared)
})

/* ------------------------------------------------------------------ */
/* Tree-level readers                                                  */
/* ------------------------------------------------------------------ */

const tree: LayoutNode = {
  type: 'split',
  id: asSplitId('split_root'),
  dir: 'row',
  ratio: [0.5, 0.5],
  children: [panelOf('a', ['1', '2', '3'], '2'), panelOf('b', ['4'])],
}

test('findPanelOfView: finds a view hiding behind another tab, not just the visible one', () => {
  assert.equal(findPanelOfView(tree, V('3'))?.id, 'panel_a')
  assert.equal(findPanelOfView(tree, V('2'))?.id, 'panel_a')
  assert.equal(findPanelOfView(tree, V('4'))?.id, 'panel_b')
  assert.equal(findPanelOfView(tree, V('ghost')), null)
})

test('collectMountedViewIds counts every tab; collectVisibleViewIds only what is on screen', () => {
  assert.deepEqual(collectMountedViewIds(tree), ['view_1', 'view_2', 'view_3', 'view_4'])
  assert.deepEqual(collectVisibleViewIds(tree), ['view_2', 'view_4'])
})

test('panelTabIndex reports the tab-bar position, and -1 for a view the panel does not hold', () => {
  const panel = panelOf('a', ['1', '2', '3'])
  assert.equal(panelTabIndex(panel, V('3')), 2)
  assert.equal(panelTabIndex(panel, V('ghost')), -1)
})

test('overflowingPanel names the panel that broke the tab cap (P5)', () => {
  const ids = Array.from({ length: MAX_PANEL_TABS }, (_, i) => V(String(i)))
  const atLimit: LayoutNode = makePanel(P('a'), ids)
  assert.equal(overflowingPanel(atLimit), null)

  const over = insertPanelTab(atLimit, V('over'))
  assert.equal(overflowingPanel(over)?.id, 'panel_a')
  assert.equal(over.viewIds.length, MAX_PANEL_TABS + 1, 'the primitive is total; the handler is the gate')
})

/* ------------------------------------------------------------------ */
/* Snapshot — what MCP and the renderer are told                       */
/* ------------------------------------------------------------------ */

test('snapshotWorkspace: a background tab is mounted but not visible', () => {
  const ws = createEmptyWorkspace(P('a'))
  const connId = asConnId('conn_1')
  const mkView = (n: string): ViewState => ({
    id: V(n),
    connId,
    kind: 'query',
    text: `select ${n}`,
    status: 'idle',
  })
  ws.views = { [V('1')]: mkView('1'), [V('2')]: mkView('2') }
  ws.layout = panelOf('a', ['1', '2'], '1')

  const snap = snapshotWorkspace(ws)
  const byId = new Map(snap.views.map((v) => [String(v.id), v]))

  const first = byId.get('view_1')
  assert.ok(first)
  assert.equal(first.panelId, 'panel_a')
  assert.equal(first.tabIndex, 0)
  assert.equal(first.visible, true)

  const second = byId.get('view_2')
  assert.ok(second)
  assert.equal(second.panelId, 'panel_a', 'mounted')
  assert.equal(second.tabIndex, 1)
  assert.equal(second.visible, false, 'but behind a tab — panelId !== null no longer means on screen')
})

test('snapshotWorkspace: an unplaced view reports tabIndex -1 and is not visible', () => {
  const ws = createEmptyWorkspace(P('a'))
  ws.views = {
    [V('1')]: { id: V('1'), connId: asConnId('conn_1'), kind: 'query', text: '', status: 'idle' },
  }
  const snap = snapshotWorkspace(ws)
  assert.equal(snap.views[0].panelId, null)
  assert.equal(snap.views[0].tabIndex, -1)
  assert.equal(snap.views[0].visible, false)
})

/* ------------------------------------------------------------------ */
/* The shared invariant checker                                        */
/* ------------------------------------------------------------------ */

test('assertPanelInvariants: accepts a sound tree and rejects each way of breaking it', () => {
  assertPanelInvariants(tree, 'sound')

  const dupAcross: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panelOf('a', ['1']), panelOf('b', ['1'])],
  }
  assert.throws(() => {
    assertPanelInvariants(dupAcross, 'dup')
  }, /mounted twice/)

  const activeGhost: PanelNode = { type: 'panel', id: P('a'), viewIds: [V('1')], activeViewId: V('2') }
  assert.throws(() => {
    assertPanelInvariants(activeGhost, 'ghost')
  }, /breaks P2/)

  const emptyButActive: PanelNode = { type: 'panel', id: P('a'), viewIds: [], activeViewId: V('1') }
  assert.throws(() => {
    assertPanelInvariants(emptyButActive, 'empty')
  }, /breaks P1/)
})
