import assert from 'node:assert/strict'
import { produce, produceWithPatches, type Patch } from 'immer'
import { test } from 'node:test'
import {
  MAX_LAYOUT_PANELS,
  MAX_PANEL_TABS,
  asConnId,
  asPanelId,
  asSplitId,
  asViewId,
  collectPanels,
  findPanel,
  findPanelOfView,
  findSplit,
  makePanel,
  parseCommandInput,
  type CommandInput,
  type CommandName,
  type CommandResultData,
  type LayoutNode,
  type LayoutSpecNode,
  type PanelId,
  type PanelNode,
  type PeekError,
  type SplitNode,
  type ViewId,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { CommandFailure } from '../failure'
import { layoutHandlers } from '../handlers/layout'
import { viewHandlers } from '../handlers/view'
import { createSeqIdFactory, type IdFactory } from '../ids'
import type { EffectIntent } from '../intents'
import type { CommandReducer, ReduceCtx } from '../types'
import {
  activateViewInTree,
  buildLayoutFromSpec,
  clearViewFromPanels,
  closePanel,
  firstEmptyPanel,
  mountViewInPanel,
  moveViewToPanel,
  nextFocusAfterRemoval,
  removedPanelIds,
  setSplitRatio,
  splitPanel,
  splitPanelWithView,
} from '../layout-ops'
import { assertPanelInvariants } from './panel-invariants'

/* ------------------------------------------------------------------ */
/* Construction helpers                                                */
/* ------------------------------------------------------------------ */

const P = (n: string): PanelId => asPanelId(`panel_${n}`)

/**
 * A panel leaf.
 *
 * `views` accepts a bare string so that the many single-tab fixtures below read
 * exactly as they did before tabs — `panel('a', 'view_1')` is still one panel
 * showing one view, it simply has a one-entry tab bar now. Passing an array
 * builds a stack, and `active` names the visible tab (defaulting to the first,
 * per P1/P2, which `makePanel` enforces rather than trusting this helper).
 */
const panel = (n: string, views: string | string[] | null = null, active?: string): PanelNode =>
  makePanel(
    P(n),
    views === null ? [] : (Array.isArray(views) ? views : [views]).map((v) => asViewId(v)),
    active === undefined ? undefined : asViewId(active),
  )

const asSplit = (node: LayoutNode): SplitNode => {
  assert.equal(node.type, 'split')
  return node as SplitNode
}

const panelIds = (node: LayoutNode): string[] => collectPanels(node).map((p) => p.id)
const sum = (nums: number[]): number => nums.reduce((a, b) => a + b, 0)

/**
 * Every panel's tab bar, in visual order, **with the visible tab marked by a
 * trailing `*`**.
 *
 * The marker is the whole point. The pre-tab assertions read
 * `assert.deepEqual(tabs(tree), [['view_2*'], ['view_1*']])`, and the mechanical
 * translation of that — comparing `viewIds` arrays — quietly drops half of what
 * used to be asserted: with one view per panel, naming the view *was* naming what
 * was on screen. Folding the active tab into the same value makes it impossible
 * to check the contents of a tab bar while forgetting which of its tabs the user
 * is actually looking at, and it keeps the assertions to one line.
 *
 * Order is never sorted, here or anywhere below: `viewIds` order **is** tab order
 * (P6), so sorting before comparing would destroy precisely the thing under test.
 */
const tabs = (node: LayoutNode): string[][] =>
  collectPanels(node).map((p) => p.viewIds.map((v) => (v === p.activeViewId ? `${v}*` : String(v))))

/** The visible view of each panel, in visual order; null for an empty panel. */
const activeViews = (node: LayoutNode): (string | null)[] => collectPanels(node).map((p) => p.activeViewId)

const rowOf = (...children: LayoutNode[]): LayoutNode => ({
  type: 'split',
  id: asSplitId('split_root'),
  dir: 'row',
  ratio: children.map(() => 1 / children.length),
  children,
})

const splitOpts = (panelId: string, dir: 'row' | 'col', extra: Record<string, unknown> = {}) => ({
  panelId: P(panelId),
  dir,
  newPanelId: P('new'),
  newSplitId: asSplitId('split_new'),
  ...extra,
})

/* ------------------------------------------------------------------ */
/* split                                                              */
/* ------------------------------------------------------------------ */

test('split: splitting the root panel promotes it to a split with an even ratio', () => {
  const outcome = splitPanel(panel('a', 'view_1'), splitOpts('a', 'row'))
  assert.ok(outcome)
  const root = asSplit(outcome.layout)
  assert.equal(root.dir, 'row')
  assert.deepEqual(panelIds(root), ['panel_a', 'panel_new'])
  assert.deepEqual(root.ratio, [0.5, 0.5])
  // The tab bar of the original panel is untouched, and the new panel is empty
  assert.deepEqual(tabs(root), [['view_1*'], []])
  assert.equal(outcome.splitId, 'split_new')
  assert.equal(outcome.panelId, 'panel_new')
  assertPanelInvariants(root, 'split root panel')
})

test('split: the panel being split keeps its whole tab stack, not just the visible tab', () => {
  const outcome = splitPanel(panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'), splitOpts('a', 'row'))
  assert.ok(outcome)
  assert.deepEqual(tabs(outcome.layout), [['view_1', 'view_2*', 'view_3'], []])
  assertPanelInvariants(outcome.layout, 'split keeps the stack')
})

test('split: insert=before puts the new panel first', () => {
  const outcome = splitPanel(panel('a'), splitOpts('a', 'col', { insert: 'before' }))
  assert.ok(outcome)
  assert.deepEqual(panelIds(outcome.layout), ['panel_new', 'panel_a'])
})

test('split: an explicit ratio is normalized; a mismatched length falls back to an even split', () => {
  const ok = splitPanel(panel('a'), splitOpts('a', 'row', { ratio: [3, 1] }))
  assert.deepEqual(asSplit(ok!.layout).ratio, [0.75, 0.25])

  const bad = splitPanel(panel('a'), splitOpts('a', 'row', { ratio: [1, 2, 3] }))
  assert.deepEqual(asSplit(bad!.layout).ratio, [0.5, 0.5])
})

test('split: the same direction merges into the parent split instead of nesting, halving the split panel share', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a'), panel('b')],
  }
  const outcome = splitPanel(root, splitOpts('a', 'row'))
  assert.ok(outcome)
  const next = asSplit(outcome.layout)

  assert.equal(next.children.length, 3, 'merged into the parent split, no nesting')
  assert.deepEqual(panelIds(next), ['panel_a', 'panel_new', 'panel_b'])
  assert.deepEqual(next.ratio, [0.25, 0.25, 0.5])
  assert.equal(outcome.splitId, 'split_root', 'returns the existing split it merged into')
})

test('split: a direction change nests a new split in place', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a'), panel('b')],
  }
  const outcome = splitPanel(root, splitOpts('b', 'col'))
  assert.ok(outcome)
  const next = asSplit(outcome.layout)
  assert.equal(next.children.length, 2)
  const nested = asSplit(next.children[1])
  assert.equal(nested.dir, 'col')
  assert.deepEqual(panelIds(nested), ['panel_b', 'panel_new'])
  assert.equal(outcome.splitId, 'split_new')
})

test('split: returns null when the target panel does not exist, and does not mutate its argument', () => {
  const root = panel('a')
  assert.equal(splitPanel(root, splitOpts('zzz', 'row')), null)
  assert.deepEqual(root, panel('a'))
})

/* ------------------------------------------------------------------ */
/* close                                                              */
/* ------------------------------------------------------------------ */

test('close: the last panel is not removed, only emptied', () => {
  const outcome = closePanel(panel('a', 'view_1'), P('a'))
  assert.ok(outcome)
  assert.equal(outcome.removedPanelId, null, 'a layout always keeps at least one panel')
  assert.deepEqual(outcome.viewIds, ['view_1'])
  assert.deepEqual(outcome.layout, panel('a'))
})

test('close: a panel closes its whole tab stack, not only the tab on screen', () => {
  // The background tabs are the ones at risk here: leaving them out of `viewIds`
  // strands them in `views` with a live connection and no panel to reach them
  // from, and nothing on screen would ever say so.
  const outcome = closePanel(panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'), P('a'))
  assert.ok(outcome)
  assert.deepEqual(outcome.viewIds, ['view_1', 'view_2', 'view_3'], 'in tab order (P6)')
  assert.deepEqual(outcome.layout, panel('a'))
})

test('close: closing an already-empty last panel returns the tree by identity', () => {
  // `clearPanelTabs` is identity-preserving, and that has to survive the trip
  // through closePanel: writeLayout compares by reference, so a fresh-but-equal
  // panel here becomes a `remove` patch that wipes the renderer's layout.
  const root = panel('a')
  const outcome = closePanel(root, P('a'))
  assert.ok(outcome)
  assert.deepEqual(outcome.viewIds, [])
  assert.equal(outcome.layout, root)
})

test('close: a two-child split collapses into the surviving sibling', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.3, 0.7],
    children: [panel('a', 'view_a'), panel('b', 'view_b')],
  }
  const outcome = closePanel(root, P('a'))
  assert.ok(outcome)
  assert.equal(outcome.removedPanelId, 'panel_a')
  assert.deepEqual(outcome.viewIds, ['view_a'])
  assert.deepEqual(outcome.layout, panel('b', 'view_b'))
})

test('close: with three children only one goes, and the remaining ratio renormalizes to 1', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'col',
    ratio: [0.2, 0.3, 0.5],
    children: [panel('a'), panel('b'), panel('c')],
  }
  const outcome = closePanel(root, P('b'))
  assert.ok(outcome)
  const next = asSplit(outcome.layout)
  assert.deepEqual(panelIds(next), ['panel_a', 'panel_c'])
  assert.equal(Math.abs(sum(next.ratio) - 1) < 1e-9, true)
  assert.deepEqual(
    next.ratio.map((r) => Number(r.toFixed(4))),
    [0.2857, 0.7143],
  )
})

test('close: in a nested tree the collapse affects only that level', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [
      panel('a'),
      {
        type: 'split',
        id: asSplitId('split_inner'),
        dir: 'col',
        ratio: [0.5, 0.5],
        children: [panel('b'), panel('c')],
      },
    ],
  }
  const outcome = closePanel(root, P('c'))
  assert.ok(outcome)
  const next = asSplit(outcome.layout)
  assert.deepEqual(panelIds(next), ['panel_a', 'panel_b'])
  assert.equal(next.children[1].type, 'panel', 'the inner split collapsed')
  assert.deepEqual(next.ratio, [0.5, 0.5], 'the outer ratio is unaffected')
})

test('close: returns null when the panel does not exist', () => {
  assert.equal(closePanel(panel('a'), P('zzz')), null)
})

/* ------------------------------------------------------------------ */
/* setRatio                                                           */
/* ------------------------------------------------------------------ */

test('setRatio: normalizes, and changes only the target split', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [
      panel('a'),
      {
        type: 'split',
        id: asSplitId('split_inner'),
        dir: 'col',
        ratio: [0.5, 0.5],
        children: [panel('b'), panel('c')],
      },
    ],
  }
  const outcome = setSplitRatio(root, asSplitId('split_inner'), [3, 1])
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(outcome.ratio, [0.75, 0.25])
  assert.deepEqual(findSplit(outcome.layout, asSplitId('split_inner'))?.ratio, [0.75, 0.25])
  assert.deepEqual(asSplit(outcome.layout).ratio, [0.5, 0.5])
})

test('setRatio: a mismatched length reports lengthMismatch instead of silently evening out', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a'), panel('b')],
  }
  const outcome = setSplitRatio(root, asSplitId('split_root'), [1, 1, 1])
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'lengthMismatch')
  assert.equal(outcome.expected, 2)

  const missing = setSplitRatio(root, asSplitId('nope'), [1, 1])
  assert.equal(missing.ok, false)
})

/* ------------------------------------------------------------------ */
/* Panels and views                                                    */
/* ------------------------------------------------------------------ */

test('mountViewInPanel / clearViewFromPanels: mount and detach', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a'), panel('b')],
  }
  const mounted = mountViewInPanel(root, P('b'), asViewId('view_1'))
  assert.ok(mounted)
  assert.deepEqual(tabs(mounted), [[], ['view_1*']])
  assert.deepEqual(tabs(root), [[], []], 'does not mutate its argument')

  const cleared = clearViewFromPanels(mounted, asViewId('view_1'))
  assert.equal(cleared.panelId, 'panel_b')
  assert.equal(cleared.activatedViewId, null, 'that was the last tab, so the panel shows nothing')
  assert.deepEqual(tabs(cleared.layout), [[], []])

  const miss = clearViewFromPanels(mounted, asViewId('view_404'))
  assert.equal(miss.panelId, null)
  assert.equal(miss.activatedViewId, null)
  assert.equal(miss.layout, mounted)

  assert.equal(mountViewInPanel(root, P('zzz'), asViewId('view_1')), null)
})

test('mountViewInPanel: appends and activates by default, honours an explicit index and activate:false', () => {
  const root = panel('a', ['view_1', 'view_2'])

  const appended = mountViewInPanel(root, P('a'), asViewId('view_3'))
  assert.ok(appended)
  assert.deepEqual(tabs(appended), [['view_1', 'view_2', 'view_3*']])

  const inserted = mountViewInPanel(root, P('a'), asViewId('view_3'), { index: 1 })
  assert.ok(inserted)
  assert.deepEqual(tabs(inserted), [['view_1', 'view_3*', 'view_2']])

  const background = mountViewInPanel(root, P('a'), asViewId('view_3'), { activate: false })
  assert.ok(background)
  assert.deepEqual(tabs(background), [['view_1*', 'view_2', 'view_3']], 'the screen did not change')
})

test('clearViewFromPanels: detaching the visible tab reports its successor, and the panel survives', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'), panel('b', 'view_4'))

  const active = clearViewFromPanels(root, asViewId('view_2'))
  assert.equal(active.panelId, 'panel_a')
  assert.equal(active.activatedViewId, 'view_3', 'right neighbour first')
  assert.deepEqual(tabs(active.layout), [['view_1', 'view_3*'], ['view_4*']])

  // A background tab leaving must not change what is on screen — the common case.
  const background = clearViewFromPanels(root, asViewId('view_3'))
  assert.equal(background.activatedViewId, 'view_2')
  assert.deepEqual(tabs(background.layout), [['view_1', 'view_2*'], ['view_4*']])

  // The last tab leaves the panel in place, empty. Removing a panel is
  // layout.close's job, never view.close's.
  const last = clearViewFromPanels(root, asViewId('view_4'))
  assert.equal(last.activatedViewId, null)
  assert.deepEqual(panelIds(last.layout), ['panel_a', 'panel_b'])
  assert.deepEqual(tabs(last.layout), [['view_1', 'view_2*', 'view_3'], []])
})

/* ------------------------------------------------------------------ */
/* activateViewInTree — the tree half of view.activate                 */
/* ------------------------------------------------------------------ */

test('activateViewInTree: brings a background tab to the front and names what it replaced', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2', 'view_3'], 'view_1'), panel('b', 'view_4'))
  const outcome = activateViewInTree(root, asViewId('view_3'))
  assert.ok(outcome)
  assert.equal(outcome.panelId, 'panel_a')
  assert.equal(outcome.previousViewId, 'view_1')
  assert.deepEqual(tabs(outcome.layout), [['view_1', 'view_2', 'view_3*'], ['view_4*']])
  assert.deepEqual(
    collectPanels(outcome.layout)[0].viewIds,
    ['view_1', 'view_2', 'view_3'],
    'activating never reorders the tab bar',
  )
})

test('activateViewInTree: re-activating the visible tab returns the tree by identity', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2'], 'view_2'), panel('b'))
  const outcome = activateViewInTree(root, asViewId('view_2'))
  assert.ok(outcome)
  assert.equal(outcome.layout, root, 'a no-op must produce no patch at all')
  assert.equal(outcome.previousViewId, 'view_2', 'equal to the target, which is how a caller sees the no-op')
})

test('activateViewInTree: a view mounted nowhere is reported, not silently ignored', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b'))
  assert.equal(activateViewInTree(root, asViewId('view_ghost')), null)
})

/* ------------------------------------------------------------------ */
/* moveView — the M2 reference operation                               */
/* ------------------------------------------------------------------ */

test('moveView: into an empty panel — the source panel is removed and the split collapses', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b'))
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('b') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, true)
  assert.equal(outcome.fromPanelId, 'panel_a')
  assert.equal(outcome.toIndex, 0)
  assert.deepEqual(outcome.removedPanelIds, ['panel_a'])
  assert.equal(outcome.displacedViewId, null)
  assert.deepEqual(outcome.layout, panel('b', 'view_1'), 'the split collapsed into the surviving panel')
  assert.deepEqual(root, rowOf(panel('a', 'view_1'), panel('b')), 'does not mutate its argument')
})

test('moveView: an occupied destination stacks by default — nothing is displaced', () => {
  // This replaces the pre-tab "an occupied destination swaps by default". The old
  // premise is gone rather than relaxed: `stack` is now the default and the only
  // mode any gesture produces, so a centre drop adds a tab instead of trading two
  // views. The swap behaviour it used to assert is still covered — explicitly,
  // by the test below.
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('b') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.swapped, false)
  assert.equal(outcome.displacedViewId, null, 'stacking displaces nothing, so there is nothing to name')
  assert.equal(outcome.toIndex, 1, 'appended after the view already there')
  assert.deepEqual(outcome.removedPanelIds, ['panel_a'], 'the source emptied and went')
  assert.deepEqual(tabs(outcome.layout), [['view_2', 'view_1*']])
  assertPanelInvariants(outcome.layout, 'stack default')
})

test('moveView: onOccupied swap still trades the two panels contents, as an explicit request', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_1'),
    toPanelId: P('b'),
    onOccupied: 'swap',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.swapped, true)
  assert.equal(outcome.displacedViewId, 'view_2')
  assert.deepEqual(outcome.removedPanelIds, [], 'a swap empties nothing, so nothing is removed')
  assert.deepEqual(tabs(outcome.layout), [['view_2*'], ['view_1*']])
})

test('moveView: a swap trades with the destination active tab and takes the index the mover vacated', () => {
  const root = rowOf(
    panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'),
    panel('b', ['view_4', 'view_5'], 'view_5'),
  )
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_2'),
    toPanelId: P('b'),
    onOccupied: 'swap',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.displacedViewId, 'view_5', 'the destination visible tab, not its whole stack')
  assert.deepEqual(
    tabs(outcome.layout),
    [
      ['view_1', 'view_5*', 'view_3'],
      ['view_4', 'view_2*'],
    ],
    'view_5 took the slot view_2 vacated, and shows because view_2 had been showing',
  )
  assertPanelInvariants(outcome.layout, 'swap between stacks')
})

test('moveView: a swap of a background tab does not change what the source panel shows', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2'], 'view_1'), panel('b', 'view_3'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_2'),
    toPanelId: P('b'),
    onOccupied: 'swap',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(tabs(outcome.layout), [['view_1*', 'view_3'], ['view_2*']])
  assert.deepEqual(activeViews(outcome.layout), ['view_1', 'view_2'], 'panel_a still shows view_1')
})

test('moveView: onOccupied replace displaces the destination visible tab and leaves its stack alone', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', ['view_2', 'view_3'], 'view_2'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_1'),
    toPanelId: P('b'),
    onOccupied: 'replace',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.swapped, false)
  assert.equal(outcome.displacedViewId, 'view_2', 'reported, so the handler can close it exactly once')
  assert.deepEqual(outcome.removedPanelIds, ['panel_a'])
  assert.deepEqual(tabs(outcome.layout), [['view_3', 'view_1*']], 'only the active tab went')
})

test('moveView: dropping a view where it already is, at the same index, is a no-op', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b'))
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('a') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, false)
  assert.equal(outcome.toIndex, 0)
  assert.equal(outcome.layout, root, 'the tree is returned by identity')
  assert.deepEqual(outcome.removedPanelIds, [])
  assert.equal(outcome.focusHint, 'panel_a')
})

test('moveView: within one panel it is a reorder — "already in this panel" is no longer a no-op', () => {
  // The rule that changed. Before tabs, a view landing on its own panel could
  // only mean "nothing happened"; now position within the panel is real state,
  // and moving view_1 to index 2 is the whole of tab reordering.
  const root = panel('a', ['view_1', 'view_2', 'view_3'], 'view_2')
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('a'), index: 2 })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, true)
  assert.equal(outcome.toIndex, 2, 'the index is the final position, so the result is checkable')
  assert.equal(outcome.fromPanelId, 'panel_a')
  assert.deepEqual(outcome.removedPanelIds, [], 'a reorder never removes the panel it happens in')
  assert.deepEqual(tabs(outcome.layout), [['view_2', 'view_3', 'view_1*']])
  assertPanelInvariants(outcome.layout, 'same-panel reorder')
})

test('moveView: a same-panel move to the index it already holds is still a no-op, by identity', () => {
  const root = panel('a', ['view_1', 'view_2', 'view_3'], 'view_1')
  const same = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('a'), index: 0 })
  assert.equal(same.ok, true)
  if (!same.ok) return
  assert.equal(same.moved, false)
  assert.equal(same.layout, root)

  // ...but only while the active tab is unchanged too: the same index with a
  // different visible tab is a real change.
  const activates = moveViewToPanel(panel('a', ['view_1', 'view_2'], 'view_2'), {
    viewId: asViewId('view_1'),
    toPanelId: P('a'),
    index: 0,
  })
  assert.equal(activates.ok, true)
  if (!activates.ok) return
  assert.equal(activates.moved, true, 'the panel now shows something else, so something moved')
  assert.deepEqual(tabs(activates.layout), [['view_1*', 'view_2']])
})

test('moveView: activate:false lands the view as a background tab', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2'], 'view_1'), panel('b', 'view_3'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_2'),
    toPanelId: P('b'),
    activate: false,
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(tabs(outcome.layout), [['view_1*'], ['view_3*', 'view_2']])
  assert.equal(outcome.toIndex, 1)
})

test('moveView: an out-of-range index is clamped, never rejected', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', ['view_2', 'view_3']))
  const high = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('b'), index: 99 })
  assert.equal(high.ok, true)
  if (!high.ok) return
  assert.equal(high.toIndex, 2)
  assert.deepEqual(tabs(high.layout), [['view_2', 'view_3', 'view_1*']])

  const low = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('b'), index: 0 })
  assert.equal(low.ok, true)
  if (!low.ok) return
  assert.equal(low.toIndex, 0)
  assert.deepEqual(tabs(low.layout), [['view_1*', 'view_2', 'view_3']])
})

test('moveView: a source panel that still has tabs left is neither emptied nor removed', () => {
  const root = rowOf(panel('a', ['view_1', 'view_2'], 'view_1'), panel('b', 'view_3'))
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('b') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.deepEqual(outcome.removedPanelIds, [])
  assert.deepEqual(panelIds(outcome.layout), ['panel_a', 'panel_b'])
  // The tab that left was the one on screen, so the source falls to its successor.
  assert.deepEqual(tabs(outcome.layout), [['view_2*'], ['view_3', 'view_1*']])
})

test('moveView: keepSourcePanel leaves the emptied panel in place', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_1'),
    toPanelId: P('b'),
    keepSourcePanel: true,
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.deepEqual(outcome.removedPanelIds, [])
  assert.deepEqual(panelIds(outcome.layout), ['panel_a', 'panel_b'])
  assert.deepEqual(tabs(outcome.layout), [[], ['view_1*']])
})

test('moveView: an unplaced view mounts, and swap degrades to stack rather than unplacing another view', () => {
  // The pre-tab contract had to unplace the displaced view here — there was no
  // source panel to send it to and no way to stack. That situation is gone: with
  // nowhere to trade, `swap` falls back to stacking, and nothing leaves the
  // screen. Nothing to report is better than reporting a disappearance.
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = moveViewToPanel(root, {
    viewId: asViewId('view_ghost'),
    toPanelId: P('b'),
    onOccupied: 'swap',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.fromPanelId, null)
  assert.equal(outcome.swapped, false, 'there is no source panel to swap into')
  assert.equal(outcome.displacedViewId, null, 'so nothing was displaced at all')
  assert.deepEqual(tabs(outcome.layout), [['view_1*'], ['view_2', 'view_ghost*']])
})

test('moveView: the tab cap is not enforced by the tree operation — the handler is the gate', () => {
  // The primitives are total functions on purpose: `insertPanelTab` refusing
  // would push a policy decision into every caller. This records that division so
  // nobody "fixes" it here and leaves the handlers silently unguarded.
  const full = Array.from({ length: MAX_PANEL_TABS }, (_, i) => `view_${String(i)}`)
  const root = rowOf(panel('a', 'view_over'), panel('b', full))
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_over'), toPanelId: P('b') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(collectPanels(outcome.layout)[0].viewIds.length, MAX_PANEL_TABS + 1)
})

test('moveView: the only panel is never removed, and a missing destination is reported', () => {
  const single = panel('a', 'view_1')
  const noop = moveViewToPanel(single, { viewId: asViewId('view_1'), toPanelId: P('a') })
  assert.equal(noop.ok, true)
  if (noop.ok) assert.equal(collectPanels(noop.layout).length, 1)

  const missing = moveViewToPanel(single, { viewId: asViewId('view_1'), toPanelId: P('zzz') })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason, 'destinationNotFound')
})

/* ------------------------------------------------------------------ */
/* Focus transfer                                                      */
/* ------------------------------------------------------------------ */

test('nextFocusAfterRemoval: the next panel in visual order, falling back to the previous one', () => {
  const root = rowOf(panel('a'), panel('b'), panel('c'))
  assert.equal(nextFocusAfterRemoval(root, P('a')), 'panel_b')
  assert.equal(nextFocusAfterRemoval(root, P('b')), 'panel_c')
  assert.equal(nextFocusAfterRemoval(root, P('c')), 'panel_b', 'the last panel falls back to its predecessor')
  assert.equal(nextFocusAfterRemoval(root, P('zzz')), null)
  assert.equal(nextFocusAfterRemoval(panel('a'), P('a')), null, 'nothing survives a one-panel tree')
})

test('firstEmptyPanel: prefers an empty panel', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a', 'view_1'), panel('b')],
  }
  assert.equal(firstEmptyPanel(root)?.id, 'panel_b')
  assert.equal(firstEmptyPanel(panel('a', 'view_1')), null)
})

/* ------------------------------------------------------------------ */
/* More construction helpers, for the M2 operations                    */
/* ------------------------------------------------------------------ */

const splitOf = (id: string, dir: 'row' | 'col', children: LayoutNode[], ratio?: number[]): LayoutNode => ({
  type: 'split',
  id: asSplitId(id),
  dir,
  ratio: ratio ?? children.map(() => 1 / children.length),
  children,
})

const round = (nums: number[]): number[] => nums.map((n) => Number(n.toFixed(4)))

const swvOpts = (
  viewId: string,
  panelId: string,
  dir: 'row' | 'col',
  extra: Record<string, unknown> = {},
) => ({
  viewId: asViewId(viewId),
  panelId: P(panelId),
  dir,
  newPanelId: P('new'),
  newSplitId: asSplitId('split_new'),
  ...extra,
})

/**
 * No dangling view id, and no panel id used twice (treeInvariants I8, structural
 * half).
 *
 * The "a view is mounted at most once" half used to live here as a local
 * `assertMountedAtMostOnce` that looked at one `panel.viewId` each. It now
 * delegates to `assertPanelInvariants` from panel-node.test.ts, which walks the
 * whole `viewIds` array — so the same call site checks strictly more than before:
 * a view repeated **within** one tab bar (P3) as well as claimed by two panels
 * (P4), plus P1, P2 and P5 for free. The two checkers are meant to be called
 * together on every operation's output, and this is where that pairing is made
 * automatic.
 */
function assertStructurallySound(node: LayoutNode, known: string[], label: string): void {
  assertPanelInvariants(node, label)
  const panels = collectPanels(node)
  assert.equal(new Set(panels.map((p) => p.id)).size, panels.length, `${label}: duplicate panel id`)
  assert.ok(panels.length >= 1, `${label}: a layout always keeps at least one panel`)
  for (const panel of panels) {
    for (const viewId of panel.viewIds) {
      assert.ok(known.includes(viewId), `${label}: ${viewId} is not an open view`)
    }
  }
  const walk = (n: LayoutNode): void => {
    if (n.type === 'panel') return
    assert.ok(n.children.length >= 2, `${label}: a split with fewer than two children survived`)
    assert.equal(n.ratio.length, n.children.length, `${label}: ratio length does not match child count`)
    assert.ok(Math.abs(sum(n.ratio) - 1) < 1e-9, `${label}: ratio does not sum to 1`)
    assert.ok(
      n.ratio.every((r) => r > 0),
      `${label}: a non-positive ratio survived`,
    )
    n.children.forEach(walk)
  }
  walk(node)
}

/* ------------------------------------------------------------------ */
/* moveView — the remaining tree invariants                            */
/* ------------------------------------------------------------------ */

test('moveView (I3a): the removed source panel share is shared out proportionally', () => {
  const root = splitOf('split_root', 'row', [panel('a', 'view_1'), panel('b'), panel('c')], [0.2, 0.3, 0.5])
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_1'), toPanelId: P('c') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  const next = asSplit(outcome.layout)
  assert.deepEqual(panelIds(next), ['panel_b', 'panel_c'])
  assert.deepEqual(round(next.ratio), [0.375, 0.625], 'the survivors keep their relative shares')
})

test('moveView (I3b): a collapsing split hands its slot ratio to the surviving child, unchanged', () => {
  const root = splitOf(
    'split_root',
    'row',
    [panel('a'), splitOf('split_inner', 'col', [panel('b', 'view_b'), panel('c', 'view_c')])],
    [0.3, 0.7],
  )
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_b'), toPanelId: P('a') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  const next = asSplit(outcome.layout)
  assert.deepEqual(panelIds(next), ['panel_a', 'panel_c'], 'the inner split collapsed into panel_c')
  assert.deepEqual(next.ratio, [0.3, 0.7], 'panel_c inherits the slot the inner split held')
  assert.deepEqual(tabs(next), [['view_b*'], ['view_c*']])
})

test('moveView (I2): a removal collapses exactly one level — the grandparent keeps its child count', () => {
  // row[ A, col[ B, row[ C(view_c), D ] ] ]  — four levels deep counting the panels
  const root = splitOf('split_root', 'row', [
    panel('a', 'view_a'),
    splitOf('split_mid', 'col', [
      panel('b', 'view_b'),
      splitOf('split_leaf', 'row', [panel('c', 'view_c'), panel('d', 'view_d')]),
    ]),
  ])
  const outside = moveViewToPanel(root, { viewId: asViewId('view_c'), toPanelId: P('e') })
  assert.equal(outside.ok, false, 'a destination outside the tree is not found')

  const moved = moveViewToPanel(root, {
    viewId: asViewId('view_c'),
    toPanelId: P('a'),
    onOccupied: 'swap',
  })
  assert.equal(moved.ok, true)
  if (!moved.ok) return

  // panel_a was occupied and the caller asked to swap: nothing empties, nothing
  // collapses. (The mode is explicit now — it used to be the default.)
  assert.equal(moved.swapped, true)
  assert.deepEqual(panelIds(moved.layout), ['panel_a', 'panel_b', 'panel_c', 'panel_d'])
  assert.deepEqual(tabs(moved.layout), [['view_c*'], ['view_b*'], ['view_a*'], ['view_d*']])
  assertStructurallySound(moved.layout, ['view_a', 'view_b', 'view_c', 'view_d'], 'deep swap')

  // The same drop under the default stacks instead: panel_c empties, so
  // split_leaf collapses and panel_a ends up with two tabs.
  const stacked = moveViewToPanel(root, { viewId: asViewId('view_c'), toPanelId: P('a') })
  assert.equal(stacked.ok, true)
  if (!stacked.ok) return
  assert.deepEqual(stacked.removedPanelIds, ['panel_c'])
  assert.deepEqual(panelIds(stacked.layout), ['panel_a', 'panel_b', 'panel_d'])
  assert.deepEqual(tabs(stacked.layout), [['view_a', 'view_c*'], ['view_b*'], ['view_d*']])
  assertStructurallySound(stacked.layout, ['view_a', 'view_b', 'view_c', 'view_d'], 'deep stack')
})

test('moveView (I2, I5): emptying a panel four levels down collapses its split and reports focus', () => {
  const root = splitOf('split_root', 'row', [
    panel('a'),
    splitOf('split_mid', 'col', [
      panel('b', 'view_b'),
      splitOf('split_leaf', 'row', [panel('c', 'view_c'), panel('d', 'view_d')], [0.25, 0.75]),
    ]),
  ])
  const outcome = moveViewToPanel(root, { viewId: asViewId('view_c'), toPanelId: P('a') })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.deepEqual(outcome.removedPanelIds, ['panel_c'])
  assert.deepEqual(panelIds(outcome.layout), ['panel_a', 'panel_b', 'panel_d'])
  const mid = asSplit(asSplit(outcome.layout).children[1])
  assert.equal(mid.id, 'split_mid')
  assert.equal(mid.children[1].type, 'panel', 'split_leaf collapsed into panel_d')
  assert.deepEqual(mid.ratio, [0.5, 0.5], 'the grandparent ratio is untouched by the collapse')
  assert.equal(nextFocusAfterRemoval(root, P('c')), 'panel_d', 'focus goes to the next panel in visual order')
  assertStructurallySound(outcome.layout, ['view_b', 'view_c', 'view_d'], 'deep collapse')
})

test('moveView (I7): a run of moves never mounts a view in two panels', () => {
  let layout: LayoutNode = splitOf('split_root', 'row', [
    panel('a', 'view_1'),
    panel('b', 'view_2'),
    splitOf('split_inner', 'col', [panel('c', 'view_3'), panel('d')]),
  ])
  const known = ['view_1', 'view_2', 'view_3']
  const moves: [string, string][] = [
    ['view_1', 'panel_d'],
    ['view_3', 'panel_b'],
    ['view_2', 'panel_d'],
    ['view_1', 'panel_a'],
    ['view_3', 'panel_a'],
  ]
  for (const [viewId, panelId] of moves) {
    const target = findPanel(layout, asPanelId(panelId))
    if (!target) continue
    const outcome = moveViewToPanel(layout, { viewId: asViewId(viewId), toPanelId: asPanelId(panelId) })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    layout = outcome.layout
    assertStructurallySound(layout, known, `after moving ${viewId} to ${panelId}`)
  }
  // Nothing was closed or duplicated along the way. The exact final tree is
  // asserted rather than a sorted set of ids: sorting would throw away tab order,
  // which is the one thing a run of stacking moves actually decides (P6).
  assert.deepEqual(tabs(layout), [['view_3*'], ['view_1', 'view_2*']])
  for (const viewId of known) {
    assert.ok(findPanelOfView(layout, asViewId(viewId)), `${viewId} is still mounted somewhere`)
  }
})

/* ------------------------------------------------------------------ */
/* splitWithView — the tree half of an edge drop                       */
/* ------------------------------------------------------------------ */

test('splitWithView (I4): the view lands in the new panel and the emptied source is removed', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'b', 'col'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, true)
  assert.equal(outcome.splitId, 'split_new')
  assert.equal(outcome.panelId, 'panel_new')
  assert.equal(outcome.fromPanelId, 'panel_a')
  assert.deepEqual(outcome.removedPanelIds, ['panel_a'])
  // panel_a vanished, so the root row collapsed into the split that was just made
  const next = asSplit(outcome.layout)
  assert.equal(next.id, 'split_new')
  assert.equal(next.dir, 'col')
  assert.deepEqual(panelIds(next), ['panel_b', 'panel_new'])
  assert.deepEqual(tabs(next), [['view_2*'], ['view_1*']])
  assert.deepEqual(root, rowOf(panel('a', 'view_1'), panel('b', 'view_2')), 'does not mutate its argument')
})

test('splitWithView: insert=before puts the new panel ahead of the one being split', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'b', 'col', { insert: 'before' }))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(panelIds(outcome.layout), ['panel_new', 'panel_b'])
  assert.deepEqual(tabs(outcome.layout), [['view_1*'], ['view_2*']])
})

test('splitWithView (I3c): the same direction merges into the existing split, which is what gets reported', () => {
  const root = splitOf(
    'split_root',
    'row',
    [panel('a', 'view_1'), panel('b', 'view_2'), panel('c')],
    [0.2, 0.3, 0.5],
  )
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'c', 'row'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.splitId, 'split_root', 'no nesting: the new panel joined the parent split')
  const next = asSplit(outcome.layout)
  assert.deepEqual(panelIds(next), ['panel_b', 'panel_c', 'panel_new'])
  // panel_c halved its 0.5 with the newcomer, then panel_a's 0.2 was shared out
  assert.deepEqual(round(next.ratio), [0.375, 0.3125, 0.3125])
  assertStructurallySound(next, ['view_1', 'view_2'], 'merge split')
})

test('splitWithView (I6): dropping a view on the edge of its own panel is a no-op, not an error', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'a', 'col'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, false)
  assert.equal(outcome.layout, root, 'the tree is returned by identity')
  assert.deepEqual(outcome.removedPanelIds, [])
  assert.equal(outcome.panelId, 'panel_a', 'echoes the panel the view is already in')
  assert.equal(outcome.splitId, 'split_root', 'echoes that panel parent split')
  assert.equal(outcome.fromPanelId, 'panel_a')
})

test('splitWithView (I1, I13): on a one-panel tree the same drop is still a no-op, and the panel survives', () => {
  const root = panel('a', 'view_1')
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'a', 'row'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.moved, false)
  assert.equal(outcome.layout, root)
  assert.equal(collectPanels(outcome.layout).length, 1)
  assert.equal(outcome.splitId, 'split_new', 'no parent split exists, so the unused new id is echoed')
})

test('splitWithView: an unplaced view mounts without removing anything', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = splitPanelWithView(root, swvOpts('view_ghost', 'a', 'row'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.equal(outcome.fromPanelId, null)
  assert.deepEqual(outcome.removedPanelIds, [])
  assert.deepEqual(panelIds(outcome.layout), ['panel_a', 'panel_new', 'panel_b'])
  assert.deepEqual(tabs(outcome.layout), [['view_1*'], ['view_ghost*'], ['view_2*']])
})

test('splitWithView: keepSourcePanel leaves the emptied source behind', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'b', 'col', { keepSourcePanel: true }))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.deepEqual(outcome.removedPanelIds, [])
  assert.deepEqual(panelIds(outcome.layout), ['panel_a', 'panel_b', 'panel_new'])
  assert.deepEqual(tabs(outcome.layout), [[], ['view_2*'], ['view_1*']])
})

test('splitWithView: an unknown target panel is reported, and the tree is untouched', () => {
  const root = rowOf(panel('a', 'view_1'), panel('b'))
  const outcome = splitPanelWithView(root, swvOpts('view_1', 'zzz', 'row'))
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'targetNotFound')
  assert.deepEqual(root, rowOf(panel('a', 'view_1'), panel('b')))
})

test('splitWithView: four levels down, the split nests locally and the source collapse stays local', () => {
  const root = splitOf('split_root', 'row', [
    panel('a', 'view_a'),
    splitOf('split_mid', 'col', [
      panel('b', 'view_b'),
      splitOf('split_leaf', 'row', [panel('c', 'view_c'), panel('d', 'view_d')]),
    ]),
  ])
  const outcome = splitPanelWithView(root, swvOpts('view_a', 'd', 'col'))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return

  assert.deepEqual(outcome.removedPanelIds, ['panel_a'], 'the emptied source went, nothing else')
  // root collapsed (one child left), split_leaf kept both children, panel_d nested a new col split
  const next = asSplit(outcome.layout)
  assert.equal(next.id, 'split_mid')
  assert.deepEqual(panelIds(next), ['panel_b', 'panel_c', 'panel_d', 'panel_new'])
  assert.deepEqual(tabs(next), [['view_b*'], ['view_c*'], ['view_d*'], ['view_a*']])
  assertStructurallySound(next, ['view_a', 'view_b', 'view_c', 'view_d'], 'deep edge drop')
})

/* ------------------------------------------------------------------ */
/* buildLayoutFromSpec — the tree half of layout.setLayout             */
/* ------------------------------------------------------------------ */

const seqIds = (prefix = 'n') => {
  const factory = createSeqIdFactory(prefix)
  return { panel: () => factory.panel(), split: () => factory.split() }
}

test('buildLayoutFromSpec: a leaf mentioning a view inherits the panel that view is already in', () => {
  const current = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const spec: LayoutSpecNode = {
    type: 'split',
    dir: 'col',
    children: [
      { type: 'panel', viewIds: [asViewId('view_2')] },
      { type: 'panel', viewIds: [asViewId('view_1')] },
    ],
  }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, true)
  if (!built.ok) return

  assert.deepEqual(panelIds(built.layout), ['panel_b', 'panel_a'], 'reordering keeps every panel id valid')
  assert.deepEqual(tabs(built.layout), [['view_2*'], ['view_1*']])
  assert.deepEqual(
    built.leaves.map((l) => l.created),
    [false, false],
  )
  assert.equal(asSplit(built.layout).id, 'n_split1', 'split ids are always freshly minted')
  assert.deepEqual(asSplit(built.layout).ratio, [0.5, 0.5])
})

test('buildLayoutFromSpec: a pinned panelId wins over inheritance, whatever order the leaves come in', () => {
  const current = rowOf(panel('a', 'view_1'), panel('b', 'view_2'))
  const spec: LayoutSpecNode = {
    type: 'split',
    dir: 'row',
    children: [
      // This leaf would inherit panel_a by mentioning view_1 — but the next leaf
      // pins panel_a by name, and a pin is never outbid by a mere mention.
      { type: 'panel', viewIds: [asViewId('view_1')] },
      { type: 'panel', viewIds: [asViewId('view_2')], panelId: P('a') },
    ],
  }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, true)
  if (!built.ok) return

  assert.deepEqual(panelIds(built.layout), ['n_panel1', 'panel_a'])
  assert.deepEqual(tabs(built.layout), [['view_1*'], ['view_2*']])
  assert.deepEqual(
    built.leaves.map((l) => l.created),
    [true, false],
  )
})

test('buildLayoutFromSpec: a pinned panel that no longer exists is reported, not silently minted', () => {
  const current = rowOf(panel('a', 'view_1'), panel('b'))
  const spec: LayoutSpecNode = { type: 'panel', panelId: P('ghost'), viewIds: [asViewId('view_1')] }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, false)
  if (built.ok) return
  assert.equal(built.reason, 'panelNotFound')
  assert.equal(built.panelId, 'panel_ghost')
})

test('buildLayoutFromSpec: ratios are normalized, and an omitted ratio divides evenly', () => {
  const current = panel('a')
  const spec: LayoutSpecNode = {
    type: 'split',
    dir: 'row',
    ratio: [3, 1],
    children: [
      { type: 'panel' },
      { type: 'split', dir: 'col', children: [{ type: 'panel' }, { type: 'panel' }, { type: 'panel' }] },
    ],
  }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, true)
  if (!built.ok) return

  const root = asSplit(built.layout)
  assert.deepEqual(root.ratio, [0.75, 0.25])
  assert.deepEqual(round(asSplit(root.children[1]).ratio), [0.3333, 0.3333, 0.3333])
  assert.equal(built.leaves.length, 4)
  assert.deepEqual(
    built.leaves.map((l) => l.viewIds),
    [[], [], [], []],
  )
  assert.deepEqual(
    built.leaves.map((l) => l.activeViewId),
    [null, null, null, null],
  )
})

test('buildLayoutFromSpec: an open leaf is passed through untouched — building a tree never creates a view', () => {
  const current = panel('a', 'view_1')
  const spec: LayoutSpecNode = {
    type: 'split',
    dir: 'row',
    children: [
      { type: 'panel', viewIds: [asViewId('view_1')], key: 'left' },
      {
        type: 'panel',
        open: [{ kind: 'query', connId: asConnId('conn_1'), text: 'select 1' }],
        key: 'right',
      },
    ],
  }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, true)
  if (!built.ok) return

  assert.deepEqual(
    built.leaves.map((l) => l.key),
    ['left', 'right'],
  )
  assert.deepEqual(built.leaves[1].viewIds, [], 'the panel stays empty until the handler opens the view')
  assert.equal(built.leaves[1].activeViewId, null)
  assert.equal(built.leaves[1].open.length, 1)
  assert.equal(built.leaves[1].open[0].kind, 'query')
  assert.deepEqual(tabs(built.layout), [['view_1*'], []])
})

test('buildLayoutFromSpec: a leaf mounts a whole tab stack, in the order it listed them (P6)', () => {
  const current = rowOf(panel('a', ['view_1', 'view_2']), panel('b', 'view_3'))
  const spec: LayoutSpecNode = {
    type: 'panel',
    viewIds: [asViewId('view_3'), asViewId('view_1'), asViewId('view_2')],
    activeViewId: asViewId('view_1'),
  }
  const built = buildLayoutFromSpec(current, spec, seqIds())
  assert.equal(built.ok, true)
  if (!built.ok) return

  // view_3's panel is inherited: it is the first listed view whose panel is free.
  assert.deepEqual(panelIds(built.layout), ['panel_b'])
  assert.deepEqual(tabs(built.layout), [['view_3', 'view_1*', 'view_2']])
  assert.deepEqual(built.leaves[0].viewIds, ['view_3', 'view_1', 'view_2'])
  assert.equal(built.leaves[0].activeViewId, 'view_1')
  assertStructurallySound(built.layout, ['view_1', 'view_2', 'view_3'], 'stacked leaf')
})

test('buildLayoutFromSpec: an activeViewId outside the leaf viewIds cannot survive into the tree (P2)', () => {
  // The schema rejects this shape, so the tree builder is the second line of
  // defence rather than the first — but a caller that bypassed validation must
  // still not be able to produce a panel showing a view it does not hold.
  const built = buildLayoutFromSpec(
    panel('a', ['view_1', 'view_2']),
    { type: 'panel', viewIds: [asViewId('view_1')], activeViewId: asViewId('view_2') },
    seqIds(),
  )
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.deepEqual(tabs(built.layout), [['view_1*']], 'corrected to the first tab, never kept')
  assertPanelInvariants(built.layout, 'active outside viewIds')
})

test('removedPanelIds: exactly the panels the rewrite dropped', () => {
  const before = rowOf(panel('a'), panel('b'), panel('c'))
  const after = rowOf(panel('b'), panel('d'))
  assert.deepEqual(removedPanelIds(before, after), ['panel_a', 'panel_c'])
  assert.deepEqual(removedPanelIds(before, before), [])
})

/* ================================================================== */
/* Command handlers                                                    */
/* ================================================================== */

/**
 * The handlers are exercised directly on an immer draft rather than through the
 * whole bus: what is under test here is the reducer's contract — atomicity,
 * focus, the unplaced policy — and a real store would add a dispatch, a patch
 * broadcast and an effect runner without adding a single assertion.
 */

const CONN = asConnId('conn_1')
const START_REV = 7

function queryView(id: string): ViewState {
  return { id: asViewId(id), connId: CONN, kind: 'query', text: '', status: 'idle' }
}

function workspaceOf(layout: LayoutNode, openViewIds: string[], focused?: string): Workspace {
  const views: Record<ViewId, ViewState> = {}
  for (const id of openViewIds) views[asViewId(id)] = queryView(id)
  return {
    rev: START_REV,
    connections: {
      [CONN]: {
        id: CONN,
        driverId: 'postgres',
        identity: 'postgres\u0000postgresql://localhost:5432/test',
        label: 'test',
        detail: 'postgresql://localhost:5432/test',
        endpoint: 'localhost:5432/test',
        config: { driverId: 'postgres', url: 'postgresql://localhost:5432/test' },
        status: 'ready',
        capabilities: ['tabularQuery'],
      },
    },
    layout,
    views,
    results: {},
    focusedPanel: focused === undefined ? collectPanels(layout)[0].id : P(focused),
  }
}

interface RunOutcome<K extends CommandName> {
  state: Workspace
  result: CommandResultData<K>
  effects: EffectIntent[]
}

/**
 * One reducer run, applied the way WorkspaceStore.applyWith would apply it (rev
 * bump included).
 *
 * `ids` defaults to a fresh sequence, which is what makes single-command tests
 * readable (`n_panel1` every time). Chaining several commands over one state
 * means passing one factory through them all — the real bus has exactly one, and
 * a per-call factory would hand out the same id twice and quietly build a tree
 * with duplicate panels.
 */
function runReduce<K extends CommandName>(
  state: Workspace,
  reduce: CommandReducer<K>,
  input: CommandInput<K>,
  ids: IdFactory = createSeqIdFactory('n'),
): RunOutcome<K> {
  const effects: EffectIntent[] = []
  const ctx: ReduceCtx = {
    source: 'mcp',
    commandId: 'cmd_test',
    now: 1_000,
    ids,
    plan: (intent) => {
      effects.push(intent)
    },
  }
  let result!: CommandResultData<K>
  const next = produce(state, (draft) => {
    result = reduce(draft, input, ctx)
    draft.rev += 1
  })
  return { state: next, result, effects }
}

const runSplitWithView = (state: Workspace, input: CommandInput<'layout.splitWithView'>) =>
  runReduce<'layout.splitWithView'>(state, layoutHandlers['layout.splitWithView'].reduce, input)
const runSetLayout = (state: Workspace, input: CommandInput<'layout.setLayout'>) =>
  runReduce<'layout.setLayout'>(state, layoutHandlers['layout.setLayout'].reduce, input)
const runMoveView = (state: Workspace, input: CommandInput<'layout.moveView'>) =>
  runReduce<'layout.moveView'>(state, layoutHandlers['layout.moveView'].reduce, input)

/** Run a reducer expected to fail, and return the structured error it failed with */
function expectFailure(run: () => unknown): PeekError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof CommandFailure, 'handlers signal failure with CommandFailure')
    return error.error
  }
  throw new Error('expected the command to fail')
}

/* ------------------------------------------------------------------ */
/* layout.splitWithView                                                */
/* ------------------------------------------------------------------ */

test('layout.splitWithView: focuses the new panel and reports what the tree did', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runSplitWithView(state, {
    viewId: asViewId('view_1'),
    panelId: P('b'),
    dir: 'col',
  })

  assert.equal(result.moved, true)
  assert.equal(result.panelId, 'n_panel1')
  assert.equal(result.splitId, 'n_split1')
  assert.equal(result.fromPanelId, 'panel_a')
  assert.deepEqual(result.removedPanelIds, ['panel_a'])
  assert.equal(result.focusedPanel, 'n_panel1')
  assert.equal(next.focusedPanel, 'n_panel1', 'the focused panel was the one that just vanished (I5)')
  assert.deepEqual(tabs(next.layout), [['view_2*'], ['view_1*']])
})

test('layout.splitWithView: focus:false keeps focus put, and a vanished focus still gets repaired (I5)', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'b')
  const kept = runSplitWithView(state, {
    viewId: asViewId('view_1'),
    panelId: P('b'),
    dir: 'row',
    focus: false,
  })
  assert.equal(kept.state.focusedPanel, 'panel_b', 'panel_b survived, so focus stays there')

  // Focus sits on the panel the move empties: it cannot stay, and must not be null
  const orphaned = runSplitWithView(
    workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a'),
    {
      viewId: asViewId('view_1'),
      panelId: P('b'),
      dir: 'row',
      focus: false,
    },
  )
  assert.equal(orphaned.state.focusedPanel !== null, true)
  assert.ok(
    findPanel(orphaned.state.layout, orphaned.state.focusedPanel!),
    'focus always lands on a panel that exists',
  )
})

test('layout.splitWithView: an unknown view is NOT_FOUND and an unknown panel is NOT_FOUND', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b')), ['view_1'])
  const noView = expectFailure(() =>
    runSplitWithView(state, { viewId: asViewId('view_404'), panelId: P('b'), dir: 'row' }),
  )
  assert.equal(noView.code, 'NOT_FOUND')
  assert.match(noView.message, /view_404/)

  const noPanel = expectFailure(() =>
    runSplitWithView(state, { viewId: asViewId('view_1'), panelId: P('zzz'), dir: 'row' }),
  )
  assert.equal(noPanel.code, 'NOT_FOUND')
})

test('view.open (I10, P5): replace:false stacks tabs, so it is capped by MAX_PANEL_TABS now, not by the panel cap', () => {
  // The premise of this test flipped with tabs. `view.open { replace: false }`
  // used to *split* the target panel to make room, which made it an unbounded way
  // to mint panels — 30 calls yielded 31. It now appends a tab and creates no
  // panel at all, so the ceiling it can run into is P5's, and MCP's open_view
  // still exposes the flag verbatim with a description that recommends it.
  let state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')
  let calls = 0
  // One id factory for the whole run, as the bus has: a fresh one per call would
  // reissue `n_view1` every time and the count would be a fiction.
  const ids = createSeqIdFactory('n')
  const failure = expectFailure(() => {
    for (let i = 0; i < 30; i += 1) {
      calls += 1
      state = runReduce<'view.open'>(
        state,
        viewHandlers['view.open'].reduce,
        { spec: { kind: 'query', connId: CONN }, replace: false },
        ids,
      ).state
    }
  })

  assert.equal(failure.code, 'CONFLICT')
  assert.match(failure.message, /at most 12 tabs/)
  assert.equal(calls, MAX_PANEL_TABS, 'the cap bites on the call that would have made tab 13')
  assert.equal(collectPanels(state.layout).length, 1, 'stacking creates no panels whatsoever')
  assert.equal(collectPanels(state.layout)[0].viewIds.length, MAX_PANEL_TABS)
  // Atomicity: the refused call left neither a tab nor a view behind.
  assert.equal(Object.keys(state.views).length, MAX_PANEL_TABS)
})

test('view.open: the default appends a tab and shows it, closing nothing (the replace default flipped)', () => {
  const state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')
  const { state: next, result } = runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'query', connId: CONN } },
    createSeqIdFactory('n'),
  )
  assert.equal(result.panelId, 'panel_a', 'no new panel: clicking a table no longer halves the window')
  assert.deepEqual(tabs(next.layout), [['view_1', 'n_view1*']])
  assert.ok(next.views[asViewId('view_1')], 'and it destroys nothing either')
})

test('view.open: replace:true still reuses the slot — it closes the active view and takes its tab position', () => {
  const state = workspaceOf(
    panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next } = runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'query', connId: CONN }, replace: true },
    createSeqIdFactory('n'),
  )
  assert.equal(next.views[asViewId('view_2')], undefined, 'the active view was closed')
  assert.deepEqual(
    tabs(next.layout),
    [['view_1', 'n_view1*', 'view_3']],
    'and the newcomer took its position rather than appending, so the bar does not reshuffle',
  )
})

test('view.open: an explicit index inserts the new tab there', () => {
  const state = workspaceOf(panel('a', ['view_1', 'view_2']), ['view_1', 'view_2'], 'a')
  const { state: next } = runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'query', connId: CONN }, index: 0 },
    createSeqIdFactory('n'),
  )
  assert.deepEqual(tabs(next.layout), [['n_view1*', 'view_1', 'view_2']])
})

test('layout.splitWithView (I10): the panel cap is enforced here too, not only on setLayout', () => {
  // A row of MAX_LAYOUT_PANELS panels; one more must be refused.
  const children = Array.from({ length: MAX_LAYOUT_PANELS }, (_, i) =>
    panel(`p${String(i)}`, i === 0 ? 'view_1' : null),
  )
  const state = workspaceOf(splitOf('split_root', 'row', children), ['view_1'])

  const failure = expectFailure(() =>
    runSplitWithView(state, {
      viewId: asViewId('view_1'),
      panelId: P('p5'),
      dir: 'col',
      keepSourcePanel: true,
    }),
  )
  assert.equal(failure.code, 'CONFLICT')
  assert.match(failure.message, /at most 16 panels/)
})

test('layout.moveView (I6): a no-op still runs the reducer, so rev moves but the tree does not', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b')), ['view_1'], 'a')
  const { state: next, result } = runMoveView(state, { viewId: asViewId('view_1'), toPanelId: P('a') })
  assert.equal(result.moved, false)
  assert.equal(
    next.rev,
    START_REV + 1,
    'the store bumps rev unconditionally; a no-op simply produces no patches',
  )
  assert.deepEqual(next.layout, state.layout)
})

test('layout.moveView: an unplaced view landing on an occupied panel stacks — swap degrades rather than unplacing anyone', () => {
  // The premise here flipped. A swap with no source panel used to have nowhere to
  // send the displaced view, so it pushed that view *out* of the tree: alive,
  // still holding its connection and its result set, but nowhere on screen, and
  // the result field existed only so somebody was told. Stacking removed the
  // situation rather than the reporting of it — there is now somewhere for both
  // views to be, so nothing is displaced and nothing has to be named.
  const state = workspaceOf(panel('a', 'view_1'), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_2'),
    toPanelId: P('a'),
    onOccupied: 'swap',
  })

  assert.equal(result.moved, true)
  assert.equal(result.fromPanelId, null, 'the moved view had no panel of its own')
  assert.equal(result.swappedViewId, undefined, 'nothing was displaced, so nothing is named')
  assert.deepEqual(result.closedViewIds, [], 'a swap closes nothing, ever')
  assert.equal(result.toIndex, 1)
  assert.deepEqual(tabs(next.layout), [['view_1', 'view_2*']])
  assert.ok(next.views[asViewId('view_1')], 'still open, and still on the tab bar')
})

test('layout.moveView: an explicit swap between two panels does trade contents, and names what it traded', () => {
  // The mode a gesture never produces, kept because an AI can name it: "these two
  // panes should trade contents" is a real instruction.
  const state = workspaceOf(
    rowOf(panel('a', ['view_1', 'view_2'], 'view_2'), panel('b', 'view_3')),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_2'),
    toPanelId: P('b'),
    onOccupied: 'swap',
  })

  assert.equal(result.swappedViewId, 'view_3', 'the destination active tab came back the other way')
  assert.deepEqual(result.closedViewIds, [])
  assert.deepEqual(
    tabs(next.layout),
    [['view_1', 'view_3*'], ['view_2*']],
    'view_3 took the index view_2 vacated, and the screen followed because view_2 was showing',
  )
  assert.deepEqual(result.removedPanelIds, [], 'neither panel emptied, so neither was removed')
  assertStructurallySound(next.layout, ['view_1', 'view_2', 'view_3'], 'explicit swap')
})

test('layout.moveView: onOccupied=replace reports the destroyed view under closedViewIds, never as a swap', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_1'),
    toPanelId: P('b'),
    onOccupied: 'replace',
  })
  assert.deepEqual(result.closedViewIds, ['view_2'])
  assert.equal(result.swappedViewId, undefined, 'a closed view was not swapped anywhere')
  assert.equal(next.views[asViewId('view_2')], undefined)
})

/* ------------------------------------------------------------------ */
/* Patches — what a command actually broadcasts to the renderer         */
/*                                                                      */
/* The renderer holds a mirror it can only edit by applying patches, so  */
/* a wrong patch is not a cosmetic problem: it corrupts the mirror while */
/* main's own state stays perfectly valid, and every later command       */
/* reports success on top of a window that can no longer draw itself.    */
/* ------------------------------------------------------------------ */

/** One reducer run, produced the way WorkspaceStore.applyWith produces it — patches included. */
function runPatches<K extends CommandName>(
  state: Workspace,
  reduce: CommandReducer<K>,
  input: CommandInput<K>,
): { state: Workspace; patches: Patch[] } {
  const ctx: ReduceCtx = {
    source: 'mcp',
    commandId: 'cmd_test',
    now: 1_000,
    ids: createSeqIdFactory('n'),
    plan: () => undefined,
  }
  const [next, patches] = produceWithPatches(state, (draft) => {
    reduce(draft, input, ctx)
    draft.rev += 1
  })
  return { state: next, patches }
}

/** Everything the change said about the layout subtree. */
const layoutPatches = (patches: Patch[]): Patch[] => patches.filter((p) => p.path[0] === 'layout')

test('layout.moveView (I6): a no-op broadcasts nothing about the layout', () => {
  // Assigning the unchanged tree back onto the draft is not free: immer sees the
  // property being written over the child draft it made when the handler read it,
  // records it as "assigned back to the original", and emits `remove layout`.
  // The renderer applies that faithfully and loses its whole layout.
  const state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')
  const { patches } = runPatches<'layout.moveView'>(state, layoutHandlers['layout.moveView'].reduce, {
    viewId: asViewId('view_1'),
    toPanelId: P('a'),
    onOccupied: 'swap',
  })
  assert.deepEqual(layoutPatches(patches), [], 'a no-op must leave the mirror untouched')
})

test('layout.splitWithView (I6): an edge drop on its own panel broadcasts nothing either', () => {
  const state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')
  const { patches } = runPatches<'layout.splitWithView'>(
    state,
    layoutHandlers['layout.splitWithView'].reduce,
    {
      viewId: asViewId('view_1'),
      panelId: P('a'),
      dir: 'row',
      insert: 'after',
    },
  )
  assert.deepEqual(layoutPatches(patches), [])
})

test('a real move still broadcasts the whole tree — the no-op guard must not silence genuine changes', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b')), ['view_1'], 'a')
  const { patches, state: next } = runPatches<'layout.moveView'>(
    state,
    layoutHandlers['layout.moveView'].reduce,
    {
      viewId: asViewId('view_1'),
      toPanelId: P('b'),
    },
  )
  const layout = layoutPatches(patches)
  assert.equal(layout.length, 1)
  assert.equal(layout[0].op, 'replace', 'a changed tree is replaced wholesale, never removed')
  assert.deepEqual(layout[0].path, ['layout'])
  // And the patch is the tree the store ended up with, so the mirror converges.
  assert.deepEqual(layout[0].value, next.layout)
})

/* ------------------------------------------------------------------ */
/* layout.setLayout                                                    */
/* ------------------------------------------------------------------ */

/**
 * A spec leaf. `views` takes a bare string so the single-tab fixtures below read
 * as they did before tabs, and an array to describe a stack — the singular
 * `viewId` field it replaces is gone from the schema entirely, with no alias.
 */
const specPanel = (views?: string | string[], extra: Record<string, unknown> = {}): LayoutSpecNode => ({
  type: 'panel',
  ...(views === undefined
    ? {}
    : { viewIds: (Array.isArray(views) ? views : [views]).map((v) => asViewId(v)) }),
  ...extra,
})

/** The `panels` entry a setLayout result is expected to report for one leaf. */
const appliedPanel = (
  panelId: PanelId,
  views: string[],
  active: string | null,
  key?: string,
): Record<string, unknown> => ({
  ...(key === undefined ? {} : { key }),
  panelId,
  viewIds: views.map((v) => asViewId(v)),
  activeViewId: active === null ? null : asViewId(active),
})

test('layout.setLayout: rearranging existing views keeps their panel ids and reports the tree in visual order', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runSetLayout(state, {
    tree: {
      type: 'split',
      dir: 'col',
      ratio: [1, 3],
      children: [specPanel('view_2'), specPanel('view_1')],
    },
  })

  assert.deepEqual(result.panels, [
    appliedPanel(P('b'), ['view_2'], 'view_2'),
    appliedPanel(P('a'), ['view_1'], 'view_1'),
  ])
  assert.deepEqual(result.createdPanelIds, [], 'nothing new had to be minted')
  assert.deepEqual(result.removedPanelIds, [])
  assert.deepEqual(result.closedViewIds, [])
  assert.deepEqual(asSplit(next.layout).ratio, [0.25, 0.75])
  assert.equal(asSplit(next.layout).dir, 'col')
  assertStructurallySound(next.layout, ['view_1', 'view_2'], 'setLayout rearrange')
})

test('layout.setLayout: an expectRev that no longer matches is a CONFLICT, and nothing moves', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b')), ['view_1'])
  const failure = expectFailure(() =>
    runSetLayout(state, { tree: specPanel('view_1'), expectRev: START_REV - 1 }),
  )
  assert.equal(failure.code, 'CONFLICT')
  assert.match(failure.message, /revision 6/)
  assert.match(failure.message, /now 7/)

  const ok = runSetLayout(state, { tree: specPanel('view_1'), expectRev: START_REV })
  assert.equal(collectPanels(ok.state.layout).length, 1, 'the matching revision goes through')
})

test('layout.setLayout: unplaced defaults to closing the views the tree left out', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runSetLayout(state, { tree: specPanel('view_1') })

  assert.deepEqual(result.closedViewIds, [asViewId('view_2')])
  assert.deepEqual(result.unplacedViewIds, [])
  assert.deepEqual(Object.keys(next.views), ['view_1'])
  assert.deepEqual(result.removedPanelIds, ['panel_b'])
  assert.deepEqual(next.layout, panel('a', 'view_1'))
})

test('layout.setLayout: unplaced=keep unmounts instead, leaving the view addressable by layout.moveView', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runSetLayout(state, { tree: specPanel('view_1'), unplaced: 'keep' })

  assert.deepEqual(result.unplacedViewIds, [asViewId('view_2')])
  assert.deepEqual(result.closedViewIds, [])
  assert.deepEqual(Object.keys(next.views).sort(), ['view_1', 'view_2'], 'still open, just nowhere (I8)')
  assert.deepEqual(tabs(next.layout), [['view_1*']])

  // And it really can be moved back in — as a tab alongside view_1 now, rather
  // than on top of it: the default onOccupied flipped from 'swap' to 'stack'.
  const back = runMoveView(next, { viewId: asViewId('view_2'), toPanelId: P('a') })
  assert.equal(back.result.fromPanelId, null)
  assert.equal(back.result.toIndex, 1)
  assert.deepEqual(tabs(back.state.layout), [['view_1', 'view_2*']])
})

test('layout.setLayout: unplaced=error refuses the whole command rather than dropping a view quietly', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const failure = expectFailure(() => runSetLayout(state, { tree: specPanel('view_1'), unplaced: 'error' }))
  assert.equal(failure.code, 'CONFLICT')
  assert.match(failure.message, /leaves out 1 open view/)
})

test('layout.setLayout: an open leaf creates its view through the same helper view.open uses', () => {
  const state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')
  const { state: next, result } = runSetLayout(state, {
    tree: {
      type: 'split',
      dir: 'row',
      children: [
        specPanel('view_1', { key: 'left' }),
        specPanel(undefined, {
          key: 'right',
          open: [{ kind: 'query', connId: CONN, text: 'select 1' }],
        }),
      ],
    },
    focusKey: 'right',
  })

  assert.deepEqual(result.openedViewIds, [asViewId('n_view1')])
  assert.deepEqual(result.panels, [
    appliedPanel(P('a'), ['view_1'], 'view_1', 'left'),
    // P1 still forces the first arrival onto the screen even though the handler
    // appends opened views as background tabs — the documented fallback for a leaf
    // that mounts nothing and names no activeViewId.
    appliedPanel(asPanelId('n_panel1'), ['n_view1'], 'n_view1', 'right'),
  ])
  assert.deepEqual(result.createdPanelIds, [asPanelId('n_panel1')])
  assert.equal(next.focusedPanel, 'n_panel1')
  assert.equal(next.views[asViewId('n_view1')]?.kind, 'query')
  assert.deepEqual(tabs(next.layout), [['view_1*'], ['n_view1*']])
})

test('layout.setLayout (I12): a failing open leaf takes the whole command down, leaving no half-built tree', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const failure = expectFailure(() =>
    runSetLayout(state, {
      tree: {
        type: 'split',
        dir: 'col',
        children: [
          specPanel('view_1'),
          specPanel(undefined, {
            open: [{ kind: 'query', connId: asConnId('conn_gone'), text: 'select 1' }],
          }),
        ],
      },
    }),
  )
  assert.equal(failure.code, 'NOT_FOUND')
  // The draft is discarded by immer, so the caller's state object is untouched:
  // view_2 was about to be closed by the default unplaced policy and still is not.
  assert.deepEqual(Object.keys(state.views).sort(), ['view_1', 'view_2'])
  assert.deepEqual(state.layout, rowOf(panel('a', 'view_1'), panel('b', 'view_2')))
})

test('layout.setLayout: a viewId that no longer exists is NOT_FOUND before anything is installed', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const failure = expectFailure(() =>
    runSetLayout(state, {
      tree: { type: 'split', dir: 'row', children: [specPanel('view_1'), specPanel('view_404')] },
    }),
  )
  assert.equal(failure.code, 'NOT_FOUND')
  assert.match(failure.message, /view_404/)
  assert.deepEqual(state.layout, rowOf(panel('a', 'view_1'), panel('b', 'view_2')))
})

test('layout.setLayout: a pinned panel that is already gone is NOT_FOUND, never quietly re-minted', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const failure = expectFailure(() =>
    runSetLayout(state, { tree: specPanel('view_1', { panelId: P('ghost') }) }),
  )
  assert.equal(failure.code, 'NOT_FOUND')
  assert.match(failure.message, /panel_ghost/)
})

test('layout.setLayout: focusViewId focuses the panel carrying that view; otherwise a surviving focus stays', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const focused = runSetLayout(state, {
    tree: { type: 'split', dir: 'row', children: [specPanel('view_1'), specPanel('view_2')] },
    focusViewId: asViewId('view_2'),
  })
  assert.equal(focused.state.focusedPanel, 'panel_b')

  const untouched = runSetLayout(state, {
    tree: { type: 'split', dir: 'col', children: [specPanel('view_1'), specPanel('view_2')] },
  })
  assert.equal(untouched.state.focusedPanel, 'panel_a', 'panel_a survived the rewrite, so focus stays on it')

  const rebuilt = runSetLayout(state, { tree: specPanel(undefined, { key: 'empty' }), unplaced: 'keep' })
  assert.equal(
    rebuilt.state.focusedPanel,
    'n_panel1',
    'the old focus is gone; focus falls back into the new tree',
  )
  assert.ok(findPanel(rebuilt.state.layout, rebuilt.state.focusedPanel!))
})

test('layout.setLayout (I1, I13): a single-panel tree is legal, and the last panel survives an empty rewrite', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'b')
  const { state: next, result } = runSetLayout(state, { tree: specPanel(undefined, { panelId: P('a') }) })

  assert.equal(collectPanels(next.layout).length, 1)
  assert.deepEqual(next.layout, panel('a'))
  assert.deepEqual(result.closedViewIds, [asViewId('view_1'), asViewId('view_2')])
  assert.equal(next.focusedPanel, 'panel_a')
})

test('layout.setLayout (I10, I9): the caps are guarded in the handler, not only in the schema', () => {
  const state = workspaceOf(panel('a', 'view_1'), ['view_1'], 'a')

  // 18 panels: past MAX_LAYOUT_PANELS while every split stays within MAX_SPLIT_CHILDREN
  const eight = (): LayoutSpecNode => ({
    type: 'split',
    dir: 'col',
    children: Array.from({ length: 8 }, () => specPanel()),
  })
  const tooMany = expectFailure(() =>
    runSetLayout(state, {
      tree: { type: 'split', dir: 'row', children: [eight(), eight(), specPanel(), specPanel()] },
      unplaced: 'keep',
    }),
  )
  assert.equal(tooMany.code, 'CONFLICT')
  assert.match(tooMany.message, /at most 16 panels/)

  // Seven nested splits: one level past MAX_LAYOUT_DEPTH
  let deep: LayoutSpecNode = specPanel()
  for (let i = 0; i < 7; i += 1) {
    deep = { type: 'split', dir: i % 2 === 0 ? 'row' : 'col', children: [specPanel(), deep] }
  }
  const tooDeep = expectFailure(() => runSetLayout(state, { tree: deep, unplaced: 'keep' }))
  assert.equal(tooDeep.code, 'CONFLICT')
  assert.match(tooDeep.message, /at most 6 levels/)
})

/* ------------------------------------------------------------------ */
/* layout.setLayout — malformed trees never reach the reducer          */
/* ------------------------------------------------------------------ */

test('layout.setLayout: the schema rejects malformed trees with a path to the offending node', () => {
  const bad = (input: unknown, needle: RegExp): void => {
    const parsed = parseCommandInput('layout.setLayout', input)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.error.code, 'BAD_REQUEST')
    assert.match(parsed.error.detail ?? '', needle)
  }

  bad(
    { tree: { type: 'split', dir: 'row', children: [specPanel('view_1'), specPanel('view_1')] } },
    /view_1 appears more than once/,
  )
  bad(
    { tree: { type: 'split', dir: 'row', ratio: [1, 2, 3], children: [specPanel(), specPanel()] } },
    /ratio has 3 entries but the split has 2 children/,
  )
  bad({ tree: { type: 'split', dir: 'row', children: [specPanel()] } }, /children/)
  bad(
    {
      tree: {
        type: 'split',
        dir: 'row',
        children: Array.from({ length: 9 }, () => specPanel()),
      },
    },
    /children/,
  )
  // `viewIds` and `open` stopped being mutually exclusive — that exclusivity only
  // ever encoded "a panel holds one thing", and a leaf now legitimately says
  // "mount these, then open those". What replaces it as the per-leaf rule is the
  // tab cap, counted across **both** halves, which neither array's own `.max()`
  // can see on its own.
  const ok = parseCommandInput('layout.setLayout', {
    tree: specPanel('view_1', { open: [{ kind: 'query', connId: CONN }] }),
  })
  assert.equal(ok.ok, true, 'mounting a view and opening another in one leaf is legal now')
  bad(
    {
      tree: specPanel(
        Array.from({ length: 7 }, (_, i) => `view_${String(i)}`),
        { open: Array.from({ length: 6 }, () => ({ kind: 'query', connId: CONN })) },
      ),
    },
    /A panel holds at most 12 tabs, got 13/,
  )
  // P2 on a spec leaf: naming a tab the leaf does not list, including one it is
  // about to `open` — that view has no id until the command runs.
  bad(
    { tree: specPanel('view_1', { activeViewId: asViewId('view_2') }) },
    /activeViewId view_2 is not among this panel's viewIds/,
  )
  bad({ tree: specPanel(), focusKey: 'nope' }, /No panel in the tree carries key nope/)
  bad(
    { tree: specPanel('view_1'), focusViewId: asViewId('view_2') },
    /view_2 is not placed anywhere in the tree/,
  )
  bad({ tree: specPanel('view_1'), focusViewId: asViewId('view_1'), focusKey: 'k' }, /not both/)
})

test('layout.setLayout: a well-formed tree parses, and the parsed input is what the reducer runs on', () => {
  const parsed = parseCommandInput('layout.setLayout', {
    tree: { type: 'split', dir: 'row', ratio: [1, 1], children: [specPanel('view_1'), specPanel('view_2')] },
    unplaced: 'keep',
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return

  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next } = runSetLayout(state, parsed.input)
  assert.deepEqual(tabs(next.layout), [['view_1*'], ['view_2*']])
})

/* ------------------------------------------------------------------ */
/* Focus transfer through the handlers (I5)                            */
/* ------------------------------------------------------------------ */

const runClose = (state: Workspace, input: CommandInput<'layout.close'>) =>
  runReduce<'layout.close'>(state, layoutHandlers['layout.close'].reduce, input)

test('layout.close (I5): focus walks to the neighbouring panel, not back to the top left', () => {
  const state = workspaceOf(
    splitOf('split_root', 'row', [panel('a', 'view_1'), panel('b', 'view_2'), panel('c', 'view_3')]),
    ['view_1', 'view_2', 'view_3'],
    'c',
  )
  const { state: next } = runClose(state, { panelId: P('c') })
  assert.equal(next.focusedPanel, 'panel_b', 'the last panel falls back to its predecessor')

  const middle = runClose(
    workspaceOf(
      splitOf('split_root', 'row', [panel('a', 'view_1'), panel('b', 'view_2'), panel('c', 'view_3')]),
      ['view_1', 'view_2', 'view_3'],
      'a',
    ),
    { panelId: P('a') },
  )
  assert.equal(middle.state.focusedPanel, 'panel_b', 'otherwise the next panel in visual order')
})

test('layout.moveView (I5): with focus:false, a removed source panel hands focus to its neighbour', () => {
  const state = workspaceOf(
    splitOf('split_root', 'row', [panel('a', 'view_1'), panel('b', 'view_2'), panel('c')]),
    ['view_1', 'view_2'],
    'a',
  )
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_1'),
    toPanelId: P('c'),
    focus: false,
  })
  assert.deepEqual(result.removedPanelIds, ['panel_a'])
  assert.equal(next.focusedPanel, 'panel_b')
  assert.equal(result.focusedPanel, 'panel_b')
})

test('layout.setLayout (I5): a focus that survives is left alone, and one that does not falls into the tree', () => {
  const state = workspaceOf(
    splitOf('split_root', 'row', [panel('a', 'view_1'), panel('b', 'view_2'), panel('c', 'view_3')]),
    ['view_1', 'view_2', 'view_3'],
    'c',
  )
  const dropped = runSetLayout(state, {
    tree: { type: 'split', dir: 'row', children: [specPanel('view_1'), specPanel('view_2')] },
  })
  assert.deepEqual(dropped.result.removedPanelIds, ['panel_c'])
  assert.equal(dropped.state.focusedPanel, 'panel_b', 'panel_c is gone; its neighbour takes over')

  const survives = runSetLayout(state, {
    tree: {
      type: 'split',
      dir: 'col',
      children: [specPanel('view_3'), specPanel('view_1'), specPanel('view_2')],
    },
  })
  assert.equal(survives.state.focusedPanel, 'panel_c')
})

test('buildLayoutFromSpec: leaves are addressed by position, so a repeated node object still yields two panels', () => {
  // Two empty leaves are a legal spec, and a caller may well build them by
  // repeating one object. Resolving panels by object identity would then collapse
  // both positions onto a single panel id.
  const shared: LayoutSpecNode = { type: 'panel' }
  const built = buildLayoutFromSpec(
    panel('a', 'view_1'),
    {
      type: 'split',
      dir: 'row',
      children: [shared, shared, { type: 'panel', viewIds: [asViewId('view_1')] }],
    },
    seqIds(),
  )
  assert.equal(built.ok, true)
  if (!built.ok) return

  assert.deepEqual(panelIds(built.layout), ['n_panel1', 'n_panel2', 'panel_a'])
  assert.deepEqual(
    built.leaves.map((l) => l.created),
    [true, true, false],
  )
  assertStructurallySound(built.layout, ['view_1'], 'repeated spec node')
})

/* ================================================================== */
/* The empty-panel lifecycle                                           */
/*                                                                     */
/* An empty panel is legal and ordinary in peek — `createEmptyWorkspace` */
/* is one, `⌘\` leaves one behind, `layout.split` creates one on        */
/* purpose. The rule is about *who* emptied it, and getting that wrong  */
/* is the difference between "the last ⌘W behaves like the ones before  */
/* it" and a panel vanishing under the cursor.                         */
/* ================================================================== */

const runViewClose = (state: Workspace, input: CommandInput<'view.close'>) =>
  runReduce<'view.close'>(state, viewHandlers['view.close'].reduce, input)
const runActivate = (state: Workspace, input: CommandInput<'view.activate'>) =>
  runReduce<'view.activate'>(state, viewHandlers['view.activate'].reduce, input)

test('view.close: closing the active tab hands over to the right neighbour and names it in the result', () => {
  const state = workspaceOf(
    panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runViewClose(state, { viewId: asViewId('view_2') })

  assert.equal(result.panelId, 'panel_a')
  assert.equal(result.activatedViewId, 'view_3', 'right neighbour first')
  assert.deepEqual(tabs(next.layout), [['view_1', 'view_3*']])
  assertStructurallySound(next.layout, ['view_1', 'view_3'], 'close active tab')
})

test('view.close: closing a background tab changes nothing on screen — the common case', () => {
  const state = workspaceOf(
    panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runViewClose(state, { viewId: asViewId('view_3') })
  assert.equal(result.activatedViewId, 'view_2', 'still the same view, still on screen')
  assert.deepEqual(tabs(next.layout), [['view_1', 'view_2*']])
})

test('view.close: the last tab leaves the panel behind, empty — removing a panel is layout.close only', () => {
  const state = workspaceOf(rowOf(panel('a', 'view_1'), panel('b', 'view_2')), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runViewClose(state, { viewId: asViewId('view_1') })

  assert.equal(result.panelId, 'panel_a', 'the panel is named, because it still exists')
  assert.equal(result.activatedViewId, null, 'nothing took over; there was nothing left')
  assert.deepEqual(panelIds(next.layout), ['panel_a', 'panel_b'], 'no collapse, no id invalidated')
  assert.deepEqual(tabs(next.layout), [[], ['view_2*']])
  assert.equal(next.focusedPanel, 'panel_a', 'and focus stays where the user left it')
})

test('empty-panel lifecycle: view.close empties, layout.close removes, and the collapse chains upward', () => {
  // The whole sequence in one place, because the two halves are only correct
  // together: leaving a panel behind on the last ⌘W is what makes the ✕ in the
  // panel's action area a *different* operation rather than a redundant one.
  let state = workspaceOf(
    splitOf('split_root', 'row', [
      panel('a', 'view_1'),
      splitOf('split_inner', 'col', [panel('b', 'view_2'), panel('c', 'view_3')]),
    ]),
    ['view_1', 'view_2', 'view_3'],
    'b',
  )

  state = runViewClose(state, { viewId: asViewId('view_2') }).state
  state = runViewClose(state, { viewId: asViewId('view_3') }).state
  assert.deepEqual(
    panelIds(state.layout),
    ['panel_a', 'panel_b', 'panel_c'],
    'three panels, two of them empty',
  )
  assert.deepEqual(tabs(state.layout), [['view_1*'], [], []])

  const first = runClose(state, { panelId: P('b') })
  assert.deepEqual(first.result.closedViewIds, [], 'an empty panel closes no views')
  assert.deepEqual(panelIds(first.state.layout), ['panel_a', 'panel_c'], 'split_inner collapsed into panel_c')

  const second = runClose(first.state, { panelId: P('c') })
  assert.deepEqual(second.result.closedViewIds, [])
  assert.deepEqual(second.state.layout, panel('a', 'view_1'), 'and the root collapsed too')
  assert.equal(second.state.focusedPanel, 'panel_a')
  assertStructurallySound(second.state.layout, ['view_1'], 'chained collapse')
})

test('layout.close: the panel action ✕ closes every tab it holds, not just the visible one', () => {
  const state = workspaceOf(
    rowOf(panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'), panel('b', 'view_4')),
    ['view_1', 'view_2', 'view_3', 'view_4'],
    'a',
  )
  const { state: next, result } = runClose(state, { panelId: P('a') })

  assert.deepEqual(result.closedViewIds, ['view_1', 'view_2', 'view_3'], 'in tab order (P6)')
  assert.deepEqual(Object.keys(next.views), ['view_4'], 'no background tab was left stranded in `views`')
  assert.deepEqual(next.layout, panel('b', 'view_4'))
})

test('layout.close: closeView:false detaches the whole stack without destroying it', () => {
  const state = workspaceOf(
    rowOf(panel('a', ['view_1', 'view_2']), panel('b', 'view_3')),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runClose(state, { panelId: P('a'), closeView: false })
  assert.deepEqual(result.closedViewIds, [])
  assert.deepEqual(Object.keys(next.views).sort(), ['view_1', 'view_2', 'view_3'], 'unplaced, not closed')
  assert.deepEqual(tabs(next.layout), [['view_3*']])
})

/* ================================================================== */
/* activeViewId can never name a view that is gone                     */
/* ================================================================== */

test('P1/P2 hold after every removal path: no panel is ever left showing a view that no longer exists', () => {
  // The failure this rules out is the quiet one: `activeViewId` pointing at a
  // closed view renders nothing, main's state passes every other check, and the
  // panel just goes blank. Each removal path is run against the same fixture and
  // the result is checked against `views` as well as against P1/P2.
  const fixture = (): Workspace =>
    workspaceOf(
      rowOf(panel('a', ['view_1', 'view_2', 'view_3'], 'view_2'), panel('b', 'view_4')),
      ['view_1', 'view_2', 'view_3', 'view_4'],
      'a',
    )

  const paths: [string, (s: Workspace) => Workspace][] = [
    ['view.close on the active tab', (s) => runViewClose(s, { viewId: asViewId('view_2') }).state],
    ['view.close on a background tab', (s) => runViewClose(s, { viewId: asViewId('view_3') }).state],
    [
      'view.close on a whole panel, tab by tab',
      (s) =>
        ['view_1', 'view_2', 'view_3'].reduce(
          (acc, v) => runViewClose(acc, { viewId: asViewId(v) }).state,
          s,
        ),
    ],
    ['layout.close', (s) => runClose(s, { panelId: P('a') }).state],
    [
      'layout.moveView of the active tab',
      (s) => runMoveView(s, { viewId: asViewId('view_2'), toPanelId: P('b') }).state,
    ],
    [
      'layout.moveView with replace',
      (s) => runMoveView(s, { viewId: asViewId('view_2'), toPanelId: P('b'), onOccupied: 'replace' }).state,
    ],
    [
      'layout.setLayout dropping a panel',
      (s) => runSetLayout(s, { tree: specPanel(['view_1', 'view_4']) }).state,
    ],
  ]

  for (const [label, run] of paths) {
    const next = run(fixture())
    assertPanelInvariants(next.layout, label)
    for (const p of collectPanels(next.layout)) {
      for (const viewId of p.viewIds) {
        assert.ok(next.views[viewId], `${label}: ${p.id} still lists ${viewId}, which is closed`)
      }
      if (p.activeViewId !== null) {
        assert.ok(next.views[p.activeViewId], `${label}: ${p.id} is showing a view that is gone`)
      }
    }
  }
})

test('layout.moveView: the source panel keeps no trace of a view it handed over (P3/P4)', () => {
  // Detach and re-attach happen in one `mapPanels` pass precisely so no
  // intermediate tree holds the view twice; this checks the other half, that the
  // source really lets go — including when the view was a background tab there.
  const state = workspaceOf(
    rowOf(panel('a', ['view_1', 'view_2', 'view_3'], 'view_1'), panel('b', 'view_4')),
    ['view_1', 'view_2', 'view_3', 'view_4'],
    'a',
  )
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_3'),
    toPanelId: P('b'),
    index: 0,
  })

  assert.equal(result.fromPanelId, 'panel_a')
  assert.equal(result.toIndex, 0)
  assert.deepEqual(tabs(next.layout), [
    ['view_1*', 'view_2'],
    ['view_3*', 'view_4'],
  ])
  assert.equal(findPanelOfView(next.layout, asViewId('view_3'))?.id, 'panel_b', 'exactly one panel claims it')
  assertStructurallySound(next.layout, ['view_1', 'view_2', 'view_3', 'view_4'], 'background tab handed over')
})

/* ================================================================== */
/* view.activate through the handler                                   */
/* ================================================================== */

test('view.activate: brings a background tab forward and focuses its panel', () => {
  const state = workspaceOf(
    rowOf(panel('a', 'view_1'), panel('b', ['view_2', 'view_3'], 'view_2')),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runActivate(state, { viewId: asViewId('view_3') })

  assert.equal(result.panelId, 'panel_b')
  assert.equal(result.previousViewId, 'view_2')
  assert.equal(result.focusedPanel, 'panel_b', 'activating a tab across the window moves focus with it')
  assert.deepEqual(tabs(next.layout), [['view_1*'], ['view_2', 'view_3*']])
})

test('view.activate: focusPanel:false switches the tab without stealing focus', () => {
  const state = workspaceOf(
    rowOf(panel('a', 'view_1'), panel('b', ['view_2', 'view_3'], 'view_2')),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next } = runActivate(state, { viewId: asViewId('view_3'), focusPanel: false })
  assert.equal(next.focusedPanel, 'panel_a')
  assert.deepEqual(tabs(next.layout), [['view_1*'], ['view_2', 'view_3*']])
})

test('view.activate: re-activating the visible tab is a no-op that broadcasts no layout patch', () => {
  const state = workspaceOf(panel('a', ['view_1', 'view_2'], 'view_2'), ['view_1', 'view_2'], 'a')
  const { patches } = runPatches<'view.activate'>(state, viewHandlers['view.activate'].reduce, {
    viewId: asViewId('view_2'),
  })
  assert.deepEqual(layoutPatches(patches), [], 'identity all the way up, so immer sees nothing to write')
})

test('view.activate: a view that exists but sits in no panel is NOT_FOUND, not a silent no-op', () => {
  // "Show this tab" has no meaning for a view that is in no tab bar, and the fix
  // (layout.moveView) differs from the fix for a view that does not exist at all.
  const state = workspaceOf(panel('a', 'view_1'), ['view_1', 'view_2'], 'a')
  const unplaced = expectFailure(() => runActivate(state, { viewId: asViewId('view_2') }))
  assert.equal(unplaced.code, 'NOT_FOUND')
  assert.match(unplaced.message, /view_2/)

  const missing = expectFailure(() => runActivate(state, { viewId: asViewId('view_404') }))
  assert.equal(missing.code, 'NOT_FOUND')
})

/* ================================================================== */
/* Tab reordering, and the no-op rule that changed with it             */
/* ================================================================== */

test('layout.moveView: a same-panel move is a tab reorder, and reports the final index', () => {
  const state = workspaceOf(
    panel('a', ['view_1', 'view_2', 'view_3'], 'view_3'),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_1'),
    toPanelId: P('a'),
    index: 2,
    activate: false,
  })

  assert.equal(result.moved, true, '"already in this panel" stopped being an unconditional no-op')
  assert.equal(result.fromPanelId, 'panel_a')
  assert.equal(
    result.toIndex,
    2,
    'the index is the final position, so a caller can check it against the result',
  )
  assert.deepEqual(tabs(next.layout), [['view_2', 'view_3*', 'view_1']], 'order changed, screen did not')
  assert.deepEqual(result.removedPanelIds, [], 'a reorder never empties anything')
})

test('layout.moveView: a same-panel move to the position it already holds is still a no-op, patches included', () => {
  const state = workspaceOf(panel('a', ['view_1', 'view_2'], 'view_1'), ['view_1', 'view_2'], 'a')
  const { result } = runMoveView(state, { viewId: asViewId('view_1'), toPanelId: P('a'), index: 0 })
  assert.equal(result.moved, false, 'panel, index and active tab all unchanged')
  assert.equal(result.toIndex, 0)

  const { patches } = runPatches<'layout.moveView'>(state, layoutHandlers['layout.moveView'].reduce, {
    viewId: asViewId('view_1'),
    toPanelId: P('a'),
    index: 0,
  })
  assert.deepEqual(layoutPatches(patches), [])
})

test('layout.moveView: reordering to the same index but a different active tab is a real change', () => {
  const state = workspaceOf(panel('a', ['view_1', 'view_2'], 'view_2'), ['view_1', 'view_2'], 'a')
  const { state: next, result } = runMoveView(state, {
    viewId: asViewId('view_1'),
    toPanelId: P('a'),
    index: 0,
  })
  assert.equal(result.moved, true, 'the tab bar did not move, but what is on screen did')
  assert.deepEqual(tabs(next.layout), [['view_1*', 'view_2']])
})

/* ================================================================== */
/* layout.setLayout — a refusal must never leave a half-built tree     */
/* ================================================================== */

test('layout.setLayout: a leaf over the tab cap is refused, and the workspace is left exactly as it was', () => {
  // The most dangerous shape of failure for a whole-tree command: the tab guard
  // runs *after* the tree is installed and the `open` leaves have created their
  // views, because `viewIds` and `open` can only be counted together once both
  // halves are real. Atomicity comes from immer discarding the draft on throw —
  // this is the test that says so out loud.
  const views = Array.from({ length: 12 }, (_, i) => `view_${String(i)}`)
  const state = workspaceOf(rowOf(panel('a', views), panel('b')), views, 'a')
  const before = state.layout

  const failure = expectFailure(() =>
    runSetLayout(state, {
      tree: specPanel(views, { open: [{ kind: 'query', connId: CONN, text: 'select 1' }] }),
    }),
  )
  assert.equal(failure.code, 'CONFLICT')
  assert.match(failure.message, /at most 12 tabs/)
  assert.equal(state.layout, before, 'not one node of the caller state moved')
  assert.deepEqual(
    Object.keys(state.views),
    views,
    'and the view the open leaf would have made does not exist',
  )
})

test('layout.setLayout: a leaf may mount a stack and open into it, with activeViewId deciding what shows', () => {
  const state = workspaceOf(
    rowOf(panel('a', ['view_1', 'view_2']), panel('b', 'view_3')),
    ['view_1', 'view_2', 'view_3'],
    'a',
  )
  const { state: next, result } = runSetLayout(state, {
    tree: specPanel(['view_1', 'view_3', 'view_2'], {
      activeViewId: asViewId('view_3'),
      open: [{ kind: 'query', connId: CONN, text: 'select 1' }],
      key: 'only',
    }),
  })

  assert.deepEqual(result.openedViewIds, [asViewId('n_view1')])
  assert.deepEqual(
    tabs(next.layout),
    [['view_1', 'view_3*', 'view_2', 'n_view1']],
    'mounted views in the listed order, opened ones appended behind, and the named tab still showing',
  )
  assert.deepEqual(result.panels, [
    appliedPanel(P('a'), ['view_1', 'view_3', 'view_2', 'n_view1'], 'view_3', 'only'),
  ])
  assert.deepEqual(result.removedPanelIds, ['panel_b'])
  assertStructurallySound(next.layout, ['view_1', 'view_2', 'view_3', 'n_view1'], 'stacked setLayout leaf')
})

test('layout.setLayout: the schema catches a view claimed by two leaves before the reducer can build it (P4)', () => {
  const parsed = parseCommandInput('layout.setLayout', {
    tree: { type: 'split', dir: 'row', children: [specPanel('view_1'), specPanel(['view_2', 'view_1'])] },
  })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.error.detail ?? '', /tree.children.1.viewIds.1/, 'the path names the offending entry')
  assert.match(parsed.error.detail ?? '', /mounted in at most one panel/)
})

test('layout.setLayout: the same view listed twice inside one leaf is caught too (P3)', () => {
  const parsed = parseCommandInput('layout.setLayout', {
    tree: specPanel(['view_1', 'view_2', 'view_1']),
  })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.error.detail ?? '', /tree.viewIds.2/)
})
