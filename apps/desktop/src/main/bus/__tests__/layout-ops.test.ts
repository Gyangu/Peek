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
/* 构造辅助                                                             */
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

test('split：根面板被劈开后升级成 split，占比对半', () => {
  const outcome = splitPanel(panel('a', 'view_1'), splitOpts('a', 'row'))
  assert.ok(outcome)
  const root = asSplit(outcome.layout)
  assert.equal(root.dir, 'row')
  assert.deepEqual(panelIds(root), ['panel_a', 'panel_new'])
  assert.deepEqual(root.ratio, [0.5, 0.5])
  // 原面板上的视图不动
  assert.equal(collectPanels(root)[0].viewId, 'view_1')
  assert.equal(outcome.splitId, 'split_new')
  assert.equal(outcome.panelId, 'panel_new')
})

test('split：insert=before 时新面板排在前面', () => {
  const outcome = splitPanel(panel('a'), splitOpts('a', 'col', { insert: 'before' }))
  assert.ok(outcome)
  assert.deepEqual(panelIds(outcome.layout), ['panel_new', 'panel_a'])
})

test('split：显式 ratio 被归一化，长度不符则退化为均分', () => {
  const ok = splitPanel(panel('a'), splitOpts('a', 'row', { ratio: [3, 1] }))
  assert.deepEqual(asSplit(ok!.layout).ratio, [0.75, 0.25])

  const bad = splitPanel(panel('a'), splitOpts('a', 'row', { ratio: [1, 2, 3] }))
  assert.deepEqual(asSplit(bad!.layout).ratio, [0.5, 0.5])
})

test('split：同方向并入父 split 而不是嵌套，份额从被劈面板身上对半切', () => {
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

  assert.equal(next.children.length, 3, '并入父 split，不产生嵌套')
  assert.deepEqual(panelIds(next), ['panel_a', 'panel_new', 'panel_b'])
  assert.deepEqual(next.ratio, [0.25, 0.25, 0.5])
  assert.equal(outcome.splitId, 'split_root', '返回的是被并入的既有 split')
})

test('split：换方向时就地嵌套出新 split', () => {
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

test('split：目标面板不存在时返回 null，且不修改入参', () => {
  const root = panel('a')
  assert.equal(splitPanel(root, splitOpts('zzz', 'row')), null)
  assert.deepEqual(root, panel('a'))
})

/* ------------------------------------------------------------------ */
/* close                                                              */
/* ------------------------------------------------------------------ */

test('close：最后一个面板不被摘除，只清空视图', () => {
  const outcome = closePanel(panel('a', 'view_1'), P('a'))
  assert.ok(outcome)
  assert.equal(outcome.removedPanelId, null, '布局至少要留一个面板')
  assert.equal(outcome.viewId, 'view_1')
  assert.deepEqual(outcome.layout, panel('a'))
})

test('close：两子节点的 split 塌缩成兄弟节点本身', () => {
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

test('close：三子节点时只去掉一个，剩余占比重新归一化到 1', () => {
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

test('close：嵌套结构里塌缩只影响那一层', () => {
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
  assert.equal(next.children[1].type, 'panel', '内层 split 塌缩')
  assert.deepEqual(next.ratio, [0.5, 0.5], '外层占比不受影响')
})

test('close：面板不存在返回 null', () => {
  assert.equal(closePanel(panel('a'), P('zzz')), null)
})

/* ------------------------------------------------------------------ */
/* setRatio                                                           */
/* ------------------------------------------------------------------ */

test('setRatio：归一化并只改目标 split', () => {
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

test('setRatio：长度不符不静默均分，而是明确报 lengthMismatch', () => {
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
/* 面板 ↔ 视图                                                          */
/* ------------------------------------------------------------------ */

test('setPanelView / clearViewFromPanels：挂载与摘除', () => {
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
  assert.equal(collectPanels(root)[1].viewId, null, '不修改入参')

  const cleared = clearViewFromPanels(mounted, asViewId('view_1'))
  assert.equal(cleared.panelId, 'panel_b')
  assert.equal(collectPanels(cleared.layout)[1].viewId, null)

  const miss = clearViewFromPanels(mounted, asViewId('view_404'))
  assert.equal(miss.panelId, null)
  assert.equal(miss.layout, mounted)

  assert.equal(setPanelView(root, P('zzz'), null), null)
})

test('firstEmptyPanel：优先落到空面板', () => {
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
