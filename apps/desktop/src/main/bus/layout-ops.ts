import {
  collectPanels,
  findPanel,
  findPanelOfView,
  findSplit,
  normalizeRatio,
  type LayoutNode,
  type PanelId,
  type PanelNode,
  type SplitId,
  type SplitNode,
  type ViewId,
} from '@peek/core'

/**
 * 平铺树的纯函数操作集（PLAN 第 5 节"布局即状态"）。
 *
 * 全部输入输出都是普通 LayoutNode：**不修改入参**，返回新树。
 * 命令 handler 里用 `plain(draft.layout)` 取出普通树，算完再整棵赋回 draft。
 * 布局树规模是面板数量级（个位数～十几），整棵替换比逐节点改 draft 简单得多，
 * 产生的 patch 也只有一条。
 */

/* ================================================================== */
/* split                                                               */
/* ================================================================== */

export interface SplitPanelOptions {
  /** 要被劈开的面板 */
  panelId: PanelId
  dir: 'row' | 'col'
  /** 新面板放在原面板之前还是之后（默认 after） */
  insert?: 'before' | 'after'
  /** 期望占比；长度与结果 split 的子节点数不符则忽略（退化为均分/对半分） */
  ratio?: readonly number[]
  newPanelId: PanelId
  newSplitId: SplitId
}

export interface SplitPanelOutcome {
  layout: LayoutNode
  /** 新面板所属的 split（同方向时是被并入的既有 split，否则是新建的 split） */
  splitId: SplitId
  /** 新建出来的面板 */
  panelId: PanelId
}

/**
 * 劈开一个面板。找不到目标面板返回 null（调用方回 NOT_FOUND）。
 *
 * 方向相同时**并入父 split**而不是嵌套新 split —— 否则连续横切会堆出
 * row(row(row(...))) 这种等价但没法拖拽调整的畸形树。
 */
export function splitPanel(root: LayoutNode, opts: SplitPanelOptions): SplitPanelOutcome | null {
  if (root.type === 'panel') {
    if (root.id !== opts.panelId) return null
    return { layout: wrapPanelInSplit(root, opts), splitId: opts.newSplitId, panelId: opts.newPanelId }
  }
  return splitInside(root, opts)
}

function wrapPanelInSplit(panel: PanelNode, opts: SplitPanelOptions): SplitNode {
  const created: PanelNode = { type: 'panel', id: opts.newPanelId, viewId: null }
  const children: LayoutNode[] = opts.insert === 'before' ? [created, panel] : [panel, created]
  return {
    type: 'split',
    id: opts.newSplitId,
    dir: opts.dir,
    ratio: normalizeRatio(opts.ratio ?? [], 2),
    children,
  }
}

function splitInside(split: SplitNode, opts: SplitPanelOptions): SplitPanelOutcome | null {
  for (let i = 0; i < split.children.length; i += 1) {
    const child = split.children[i]

    if (child.type === 'split') {
      const nested = splitInside(child, opts)
      if (!nested) continue
      const children = [...split.children]
      children[i] = nested.layout
      return { ...nested, layout: { ...split, children } }
    }

    if (child.id !== opts.panelId) continue

    if (split.dir === opts.dir) {
      // 同方向：新面板直接并入当前 split
      const created: PanelNode = { type: 'panel', id: opts.newPanelId, viewId: null }
      const at = opts.insert === 'before' ? i : i + 1
      const children = [...split.children]
      children.splice(at, 0, created)
      return {
        layout: { ...split, children, ratio: ratioAfterInsert(split.ratio, i, at, children.length, opts.ratio) },
        splitId: split.id,
        panelId: opts.newPanelId,
      }
    }

    // 换方向：把这个面板就地升级成一个新的 split
    const children = [...split.children]
    children[i] = wrapPanelInSplit(child, opts)
    return { layout: { ...split, children }, splitId: opts.newSplitId, panelId: opts.newPanelId }
  }
  return null
}

/** 并入既有 split 时的占比：显式 ratio 优先，否则把被劈面板的份额对半分给新面板 */
function ratioAfterInsert(
  ratio: readonly number[],
  targetIndex: number,
  insertAt: number,
  nextCount: number,
  explicit?: readonly number[],
): number[] {
  if (explicit && explicit.length === nextCount) return normalizeRatio(explicit, nextCount)
  const next = [...ratio]
  const share = next[targetIndex] ?? 1 / Math.max(1, ratio.length)
  next[targetIndex] = share / 2
  next.splice(insertAt, 0, share / 2)
  return normalizeRatio(next, nextCount)
}

/* ================================================================== */
/* close                                                               */
/* ================================================================== */

export interface ClosePanelOutcome {
  layout: LayoutNode
  /**
   * 被摘掉的面板 id。树里只剩这一个面板时不摘除（布局至少要有一个面板），
   * 只把它清空，此时为 null。
   */
  removedPanelId: PanelId | null
  /** 该面板原本挂着的视图 */
  viewId: ViewId | null
}

/** 关闭一个面板：兄弟节点顶上，父 split 只剩一个孩子时塌缩。找不到返回 null。 */
export function closePanel(root: LayoutNode, panelId: PanelId): ClosePanelOutcome | null {
  const target = findPanel(root, panelId)
  if (!target) return null

  // 最后一个面板：保留节点本身，只清空视图
  if (collectPanels(root).length <= 1) {
    return {
      layout: { type: 'panel', id: target.id, viewId: null },
      removedPanelId: null,
      viewId: target.viewId,
    }
  }

  const layout = removePanel(root, panelId)
  if (!layout) return null
  return { layout, removedPanelId: target.id, viewId: target.viewId }
}

function removePanel(node: LayoutNode, panelId: PanelId): LayoutNode | null {
  if (node.type === 'panel') return null

  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i]

    if (child.type === 'panel') {
      if (child.id !== panelId) continue
      const children = node.children.filter((_, j) => j !== i)
      const ratio = node.ratio.filter((_, j) => j !== i)
      // 只剩一个孩子：split 塌缩，孩子顶替它的位置
      if (children.length === 1) return children[0]
      return { ...node, children, ratio: normalizeRatio(ratio, children.length) }
    }

    const replaced = removePanel(child, panelId)
    if (!replaced) continue
    const children = [...node.children]
    children[i] = replaced
    return { ...node, children }
  }
  return null
}

/* ================================================================== */
/* setRatio                                                            */
/* ================================================================== */

export type SetRatioOutcome =
  | { ok: true; layout: LayoutNode; ratio: number[] }
  | { ok: false; reason: 'notFound' | 'lengthMismatch'; expected?: number }

/**
 * 调整某个 split 的占比。
 * 长度必须与子节点数一致 —— 不一致时不静默均分，而是回 lengthMismatch，
 * 让发命令的人（尤其是 AI）拿到明确反馈。
 */
export function setSplitRatio(root: LayoutNode, splitId: SplitId, ratio: readonly number[]): SetRatioOutcome {
  const split = findSplit(root, splitId)
  if (!split) return { ok: false, reason: 'notFound' }
  if (ratio.length !== split.children.length) {
    return { ok: false, reason: 'lengthMismatch', expected: split.children.length }
  }
  const normalized = normalizeRatio(ratio, split.children.length)
  return { ok: true, layout: mapSplits(root, splitId, normalized), ratio: normalized }
}

function mapSplits(node: LayoutNode, splitId: SplitId, ratio: number[]): LayoutNode {
  if (node.type === 'panel') return node
  if (node.id === splitId) return { ...node, ratio }
  return { ...node, children: node.children.map((child) => mapSplits(child, splitId, ratio)) }
}

/* ================================================================== */
/* 面板 ↔ 视图挂载                                                      */
/* ================================================================== */

/** 把视图挂到面板上（viewId 传 null 表示清空）。面板不存在返回 null。 */
export function setPanelView(root: LayoutNode, panelId: PanelId, viewId: ViewId | null): LayoutNode | null {
  if (!findPanel(root, panelId)) return null
  return mapPanels(root, (panel) => (panel.id === panelId ? { ...panel, viewId } : panel))
}

/** 把某个视图从它所在的面板上摘掉；视图没挂在任何面板上时 panelId 为 null */
export function clearViewFromPanels(
  root: LayoutNode,
  viewId: ViewId,
): { layout: LayoutNode; panelId: PanelId | null } {
  const host = findPanelOfView(root, viewId)
  if (!host) return { layout: root, panelId: null }
  const layout = mapPanels(root, (panel) => (panel.id === host.id ? { ...panel, viewId: null } : panel))
  return { layout, panelId: host.id }
}

export function mapPanels(node: LayoutNode, fn: (panel: PanelNode) => PanelNode): LayoutNode {
  if (node.type === 'panel') return fn(node)
  return { ...node, children: node.children.map((child) => mapPanels(child, fn)) }
}

/* ================================================================== */
/* 查询辅助                                                             */
/* ================================================================== */

/** 第一个空面板（view.open 没指定面板且没有焦点时的落点） */
export function firstEmptyPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root).find((panel) => panel.viewId === null) ?? null
}

export function firstPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root)[0] ?? null
}
