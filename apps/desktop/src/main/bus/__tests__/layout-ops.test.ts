import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asPanelId,
  asSplitId,
  asViewId,
  collectPanels,
  findSplit,
  type LayoutNode,
  type PanelId,
  type SplitNode,
} from '@peek/core'
import {
  clearViewFromPanels,
  closePanel,
  firstEmptyPanel,
  setPanelView,
  setSplitRatio,
  splitPanel,
} from '../layout-ops'

/* ------------------------------------------------------------------ */
/* Construction helpers                                                */
/* ------------------------------------------------------------------ */

const P = (n: string): PanelId => asPanelId(`panel_${n}`)
const panel = (n: string, viewId: string | null = null): LayoutNode => ({
  type: 'panel',
  id: P(n),
  viewId: viewId === null ? null : asViewId(viewId),
})

const asSplit = (node: LayoutNode): SplitNode => {
  assert.equal(node.type, 'split')
  return node as SplitNode
}

const panelIds = (node: LayoutNode): string[] => collectPanels(node).map((p) => p.id)
const sum = (nums: number[]): number => nums.reduce((a, b) => a + b, 0)

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
  // The view on the original panel is untouched
  assert.equal(collectPanels(root)[0].viewId, 'view_1')
  assert.equal(outcome.splitId, 'split_new')
  assert.equal(outcome.panelId, 'panel_new')
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
  assert.equal(outcome.viewId, 'view_1')
  assert.deepEqual(outcome.layout, panel('a'))
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
  assert.equal(outcome.viewId, 'view_a')
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

test('setPanelView / clearViewFromPanels: mount and detach', () => {
  const root: LayoutNode = {
    type: 'split',
    id: asSplitId('split_root'),
    dir: 'row',
    ratio: [0.5, 0.5],
    children: [panel('a'), panel('b')],
  }
  const mounted = setPanelView(root, P('b'), asViewId('view_1'))
  assert.ok(mounted)
  assert.equal(collectPanels(mounted)[1].viewId, 'view_1')
  assert.equal(collectPanels(root)[1].viewId, null, 'does not mutate its argument')

  const cleared = clearViewFromPanels(mounted, asViewId('view_1'))
  assert.equal(cleared.panelId, 'panel_b')
  assert.equal(collectPanels(cleared.layout)[1].viewId, null)

  const miss = clearViewFromPanels(mounted, asViewId('view_404'))
  assert.equal(miss.panelId, null)
  assert.equal(miss.layout, mounted)

  assert.equal(setPanelView(root, P('zzz'), null), null)
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
