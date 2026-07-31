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
 * Pure operations on the tiled layout tree (PLAN section 5, "layout is state").
 *
 * Every input and output is a plain LayoutNode: these functions **never mutate
 * their arguments**, they return a new tree. Command handlers pull a plain tree
 * out with `plain(draft.layout)`, compute, then assign the whole tree back onto
 * the draft. A layout tree is the size of the panel count (a handful, at most a
 * dozen), so replacing it wholesale is far simpler than editing node by node —
 * and it yields a single patch instead of many.
 */

/* ================================================================== */
/* split                                                               */
/* ================================================================== */

export interface SplitPanelOptions {
  /** The panel being split */
  panelId: PanelId
  dir: 'row' | 'col'
  /** Whether the new panel goes before or after the original (default: after) */
  insert?: 'before' | 'after'
  /** Desired ratio; ignored when its length does not match the resulting split's child count (falls back to an even split) */
  ratio?: readonly number[]
  newPanelId: PanelId
  newSplitId: SplitId
}

export interface SplitPanelOutcome {
  layout: LayoutNode
  /** The split the new panel belongs to: the existing one it merged into when directions match, otherwise the newly created split */
  splitId: SplitId
  /** The panel that was created */
  panelId: PanelId
}

/**
 * Split a panel. Returns null when the target panel does not exist (the caller
 * turns that into NOT_FOUND).
 *
 * When the direction matches, the new panel **merges into the parent split**
 * rather than nesting a new one — otherwise repeated horizontal splits pile up
 * row(row(row(...))), a tree that is equivalent but impossible to resize by
 * dragging.
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
      // Same direction: the new panel joins the current split directly
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

    // Direction change: promote this panel in place into a new split
    const children = [...split.children]
    children[i] = wrapPanelInSplit(child, opts)
    return { layout: { ...split, children }, splitId: opts.newSplitId, panelId: opts.newPanelId }
  }
  return null
}

/** Ratio when merging into an existing split: an explicit ratio wins, otherwise the split panel's share is halved with the newcomer. */
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
   * The id of the panel that was removed. When it is the only panel left it is
   * kept rather than removed (a layout always has at least one panel) and merely
   * emptied, in which case this is null.
   */
  removedPanelId: PanelId | null
  /** The view that panel was holding */
  viewId: ViewId | null
}

/** Close a panel: siblings take over, and a parent split collapses once it is down to one child. Returns null when not found. */
export function closePanel(root: LayoutNode, panelId: PanelId): ClosePanelOutcome | null {
  const target = findPanel(root, panelId)
  if (!target) return null

  // The last panel: keep the node itself, just clear its view
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
      // Down to one child: the split collapses and the child takes its place
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
 * Adjust one split's ratio.
 * The length must match the child count — a mismatch is reported as
 * `lengthMismatch` rather than silently evened out, so whoever sent the command
 * (an AI in particular) gets unambiguous feedback.
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
/* Mounting views onto panels                                          */
/* ================================================================== */

/** Mount a view onto a panel (pass null to clear it). Returns null when the panel does not exist. */
export function setPanelView(root: LayoutNode, panelId: PanelId, viewId: ViewId | null): LayoutNode | null {
  if (!findPanel(root, panelId)) return null
  return mapPanels(root, (panel) => (panel.id === panelId ? { ...panel, viewId } : panel))
}

/** Detach a view from whichever panel holds it; `panelId` is null when no panel does. */
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
/* Lookup helpers                                                      */
/* ================================================================== */

/** The first empty panel — where view.open lands when no panel was given and nothing has focus. */
export function firstEmptyPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root).find((panel) => panel.viewId === null) ?? null
}

export function firstPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root)[0] ?? null
}
