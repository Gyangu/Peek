import {
  activatePanelTab,
  clearPanelTabs,
  collectPanels,
  findPanel,
  findPanelOfView,
  findParentSplit,
  findSplit,
  insertPanelTab,
  isPanelEmpty,
  makePanel,
  normalizeRatio,
  panelTabIndex,
  removePanelTab,
  type LayoutNode,
  type LayoutSpecNode,
  type PanelId,
  type PanelNode,
  type SplitId,
  type SplitNode,
  type ViewId,
  type ViewOpenSpec,
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
 *
 * ## The one rule that is not about trees
 *
 * **A tree operation that changes nothing returns its argument by identity.**
 * Every panel primitive in `@peek/core` already does this, and the composition
 * here must not throw it away — `writeLayout` decides whether to touch the immer
 * draft by reference equality, and assigning an equal-but-fresh tree emits a
 * `remove` patch that wipes the renderer's layout while main's own state stays
 * perfectly correct (see handlers/shared.ts). `mapPanels` is where this is
 * earned: it hands back the original split node when no child changed, so a
 * no-op deep in the tree propagates all the way to the root as identity.
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
  const created: PanelNode = makePanel(opts.newPanelId)
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
      const created: PanelNode = makePanel(opts.newPanelId)
      const at = opts.insert === 'before' ? i : i + 1
      const children = [...split.children]
      children.splice(at, 0, created)
      return {
        layout: {
          ...split,
          children,
          ratio: ratioAfterInsert(split.ratio, i, at, children.length, opts.ratio),
        },
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
  /**
   * Every view the panel was holding, in tab-bar order.
   *
   * Closing a panel closes its whole stack, not just the visible tab. This is the
   * sharpest consequence of the tab model for `layout.close`: with one view per
   * panel the singular field was the entire content, and a caller that keeps
   * reading only the first entry now silently leaks every background tab —
   * views left in `views` with a live connection and a running result set, and
   * no panel anywhere to reach them from.
   */
  viewIds: ViewId[]
}

/** Close a panel: siblings take over, and a parent split collapses once it is down to one child. Returns null when not found. */
export function closePanel(root: LayoutNode, panelId: PanelId): ClosePanelOutcome | null {
  const target = findPanel(root, panelId)
  if (!target) return null
  const viewIds = [...target.viewIds]

  // The last panel: keep the node itself, just empty it. `clearPanelTabs` returns
  // the panel by identity when it is already empty, so closing an empty root
  // panel produces no patch at all.
  if (collectPanels(root).length <= 1) {
    return { layout: clearPanelTabs(target), removedPanelId: null, viewIds }
  }

  const layout = removePanel(root, panelId)
  if (!layout) return null
  return { layout, removedPanelId: target.id, viewIds }
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

/**
 * Where focus lands once `removedPanelId` is gone: the next panel in visual
 * order, or the previous one when the removed panel was last.
 *
 * Call it with the tree **before** the removal — the removed panel's position is
 * the whole input. Falling back to "the first panel in the tree" instead (which
 * is all `ensureFocusedPanel` can do) means closing the bottom-right panel throws
 * focus to the top-left, which reads as the window losing its place.
 */
export function nextFocusAfterRemoval(rootBefore: LayoutNode, removedPanelId: PanelId): PanelId | null {
  const ids = collectPanels(rootBefore).map((p) => p.id)
  const i = ids.indexOf(removedPanelId)
  if (i < 0) return null
  return ids[i + 1] ?? ids[i - 1] ?? null
}

/* ================================================================== */
/* moveView — the tree half of a centre drop                           */
/* ================================================================== */

export interface MoveViewOptions {
  viewId: ViewId
  toPanelId: PanelId
  /** Final position in the destination's tab bar; omitted means append. Clamped, never rejected. */
  index?: number
  /** Show the view once it lands (default true) */
  activate?: boolean
  /** How an occupied destination is handled; see the Command's doc comment. Default 'stack'. */
  onOccupied?: 'stack' | 'swap' | 'replace'
  /** Leave the source panel behind once it empties (default false) */
  keepSourcePanel?: boolean
}

export type MoveViewOutcome =
  | { ok: false; reason: 'destinationNotFound' }
  | {
      ok: true
      layout: LayoutNode
      fromPanelId: PanelId | null
      /** The view's final position in the destination's tab bar */
      toIndex: number
      /** False when the tree came out identical: a no-op, and not an error */
      moved: boolean
      /**
       * The destination's former active view, when `swap` or `replace` pushed it
       * out. **`stack` displaces nothing**, so on the default path this is always
       * null — the pre-tab contract had to name a view that might have been
       * silently unmounted, and stacking removed the situation rather than the
       * reporting of it.
       */
      displacedViewId: ViewId | null
      /** True when `displacedViewId` was moved into the source panel rather than closed */
      swapped: boolean
      removedPanelIds: PanelId[]
      /** Panel to focus if the caller's focused panel just disappeared */
      focusHint: PanelId
    }

/**
 * Move an already-open view into another panel, or to another position within
 * its own panel.
 *
 * This is the reference for the rest of the layout tree operations, so the
 * invariants it upholds are worth stating outright:
 *
 * - **A view is mounted in at most one panel, once** (P3 + P4). The move detaches
 *   and re-attaches in a single `mapPanels` pass, so no intermediate tree ever
 *   holds the view twice.
 * - **A move within one panel is a reorder, not a no-op.** This is the rule that
 *   changed with tabs, and it changed because the tab bar made "position within a
 *   panel" into real state. The no-op test is now the honest one: the operation
 *   is a no-op exactly when the resulting tree is identical, which folds panel,
 *   index and active tab into one comparison rather than three hand-maintained
 *   ones. It is still not an error — the user let go two pixels from where they
 *   picked up.
 * - **An emptied source panel is removed**, and its parent split collapses when
 *   that leaves a single child — the same rule `closePanel` follows, so a drag
 *   leaves no holes behind. A source panel that still has tabs left is untouched.
 * - **The destination panel is never removed**, whatever else happens.
 * - **The last panel survives.** A layout always has at least one panel, so when
 *   the source is the only panel it is emptied rather than removed.
 *
 * The view itself is never created or destroyed here; `onOccupied: 'replace'`
 * only reports the displaced view, and the handler closes it through `closeView`,
 * so a running result set is cancelled exactly once.
 */
export function moveViewToPanel(root: LayoutNode, opts: MoveViewOptions): MoveViewOutcome {
  const dest = findPanel(root, opts.toPanelId)
  if (!dest) return { ok: false, reason: 'destinationNotFound' }

  const source = findPanelOfView(root, opts.viewId)
  const samePanel = source !== null && source.id === dest.id
  const mode = opts.onOccupied ?? 'stack'

  // Only a genuinely occupied *other* panel can displace anything. Within one
  // panel there is nothing to trade with: the view is already there.
  const occupied = !samePanel && dest.activeViewId !== null
  // `swap` needs a source panel to send the displaced view back to. Without one
  // it degrades to `stack` rather than unmounting a view nobody asked about —
  // the pre-tab contract had no stacking to fall back on and had to choose
  // between unplacing and refusing.
  const swapped = occupied && mode === 'swap' && source !== null
  const replacing = occupied && mode === 'replace'
  const displacedViewId = swapped || replacing ? dest.activeViewId : null

  // Where the moved view sat in its source panel, and whether it was the tab on
  // screen there. A swap puts the displaced view into exactly that slot, and
  // only takes over the screen if the view that left was the one being shown.
  const vacatedIndex = source === null ? 0 : panelTabIndex(source, opts.viewId)
  const sourceWasShowing = source !== null && source.activeViewId === opts.viewId

  let layout = mapPanels(root, (panel) => {
    if (panel.id === dest.id) {
      // Detaching the displaced view first keeps the requested `index` meaning
      // what the Command promises: a final position, measured once every removal
      // has happened.
      const cleared = displacedViewId === null ? panel : removePanelTab(panel, displacedViewId)
      return insertPanelTab(cleared, opts.viewId, {
        ...(opts.index === undefined ? {} : { index: opts.index }),
        activate: opts.activate !== false,
      })
    }
    if (source !== null && panel.id === source.id) {
      const detached = removePanelTab(panel, opts.viewId)
      if (!swapped || displacedViewId === null) return detached
      return insertPanelTab(detached, displacedViewId, {
        index: vacatedIndex,
        activate: sourceWasShowing,
      })
    }
    return panel
  })

  // Identity is the no-op test, and it is exact: `mapPanels` and every panel
  // primitive return their input unchanged when nothing moved, so an unchanged
  // tree here means panel, index and active tab all stayed put.
  if (layout === root) {
    return {
      ok: true,
      layout: root,
      fromPanelId: source?.id ?? null,
      toIndex: panelTabIndex(dest, opts.viewId),
      moved: false,
      displacedViewId: null,
      swapped: false,
      removedPanelIds: [],
      focusHint: dest.id,
    }
  }

  const removedPanelIds: PanelId[] = []
  if (source !== null && !samePanel && opts.keepSourcePanel !== true) {
    const sourceAfter = findPanel(layout, source.id)
    if (sourceAfter && isPanelEmpty(sourceAfter) && collectPanels(layout).length > 1) {
      const pruned = removePanel(layout, source.id)
      if (pruned) {
        layout = pruned
        removedPanelIds.push(source.id)
      }
    }
  }

  return {
    ok: true,
    layout,
    fromPanelId: source?.id ?? null,
    toIndex: panelTabIndex(findPanel(layout, dest.id) ?? dest, opts.viewId),
    moved: true,
    displacedViewId,
    swapped,
    removedPanelIds,
    focusHint: dest.id,
  }
}

/* ================================================================== */
/* splitWithView — the tree half of an edge drop                       */
/* ================================================================== */

export interface SplitWithViewOptions {
  viewId: ViewId
  /** The panel being split; the view lands in the panel that appears */
  panelId: PanelId
  dir: 'row' | 'col'
  insert?: 'before' | 'after'
  ratio?: readonly number[]
  keepSourcePanel?: boolean
  newPanelId: PanelId
  newSplitId: SplitId
}

export type SplitWithViewOutcome =
  | { ok: false; reason: 'targetNotFound' }
  | {
      ok: true
      layout: LayoutNode
      /** The split the new panel belongs to — an existing one when the direction matched */
      splitId: SplitId
      /** The panel now holding the view */
      panelId: PanelId
      fromPanelId: PanelId | null
      /** False when the split would have been undone immediately; see below */
      moved: boolean
      removedPanelIds: PanelId[]
      focusHint: PanelId
    }

/**
 * Split a panel and move an already-open view into the panel that appears.
 *
 * It is `splitPanel` followed by `moveViewToPanel`, in that order and with no
 * state in between, so every invariant those two uphold holds here too: the
 * emptied source panel is removed, its parent split collapses, a view is never
 * mounted twice, and the last panel survives.
 *
 * **Dropping a view on the edge of the panel it already occupies is a no-op —
 * but only when it is that panel's only tab.** Not an arbitrary special case: in
 * that case the split would create a panel, the move would empty the source panel
 * next to it, and the collapse would put the tree back exactly where it started,
 * with a different panel id. Reporting that churn as a change would hand the
 * caller a dead id for no reason.
 *
 * Tabs made the condition narrower rather than removing it. Tearing one tab out of
 * a three-tab panel and dropping it on that same panel's edge empties nothing, so
 * nothing collapses and the split stands — "pull this tab out beside its
 * neighbours" is a real operation, and refusing it because the source and target
 * ids happen to match would be a bug, not a guard. `keepSourcePanel` is treated
 * the same way: it asks for the emptied panel to survive, which makes the result
 * a genuine change (an empty panel appears next to the view) rather than churn.
 *
 * With `moved: false` nothing was created: `panelId` echoes the panel the view is
 * already in and `splitId` its parent split (falling back to the unused
 * `newSplitId` when that panel is the whole tree).
 */
export function splitPanelWithView(root: LayoutNode, opts: SplitWithViewOptions): SplitWithViewOutcome {
  const target = findPanel(root, opts.panelId)
  if (!target) return { ok: false, reason: 'targetNotFound' }

  const source = findPanelOfView(root, opts.viewId)
  const wouldCollapseBack =
    source !== null && source.id === target.id && source.viewIds.length === 1 && opts.keepSourcePanel !== true
  if (source && wouldCollapseBack) {
    return {
      ok: true,
      layout: root,
      splitId: findParentSplit(root, target.id)?.id ?? opts.newSplitId,
      panelId: target.id,
      fromPanelId: source.id,
      moved: false,
      removedPanelIds: [],
      focusHint: target.id,
    }
  }

  const split = splitPanel(root, {
    panelId: opts.panelId,
    dir: opts.dir,
    ...(opts.insert ? { insert: opts.insert } : {}),
    ...(opts.ratio ? { ratio: opts.ratio } : {}),
    newPanelId: opts.newPanelId,
    newSplitId: opts.newSplitId,
  })
  // Unreachable: the panel was just found. Kept as a total function rather than a
  // non-null assertion so a future change to splitPanel cannot fail silently.
  if (!split) return { ok: false, reason: 'targetNotFound' }

  const moved = moveViewToPanel(split.layout, {
    viewId: opts.viewId,
    toPanelId: split.panelId,
    ...(opts.keepSourcePanel === undefined ? {} : { keepSourcePanel: opts.keepSourcePanel }),
  })
  if (!moved.ok) return { ok: false, reason: 'targetNotFound' }

  return {
    ok: true,
    layout: moved.layout,
    splitId: split.splitId,
    panelId: split.panelId,
    fromPanelId: moved.fromPanelId,
    moved: true,
    removedPanelIds: moved.removedPanelIds,
    focusHint: split.panelId,
  }
}

/* ================================================================== */
/* setLayout — building a whole tree from a declarative spec           */
/* ================================================================== */

/** One leaf of a spec tree, resolved against the current layout */
export interface BuiltLeaf {
  panelId: PanelId
  /** Echoed from the spec leaf */
  key?: string
  /** Existing views this leaf mounts, in tab-bar order. Empty for an empty leaf and for a pure `open` leaf. */
  viewIds: ViewId[]
  /**
   * Views to create in this panel, appended after `viewIds` in order.
   *
   * Deferred to the handler because creating a view is not a tree operation, and
   * a list rather than a single spec because a leaf now describes a tab stack —
   * the pre-tab schema made `viewId` and `open` mutually exclusive, which only
   * ever encoded "a panel holds one thing".
   */
  open: ViewOpenSpec[]
  /**
   * The tab the spec asked to show, when it named one. Null means "the first
   * tab", which the handler resolves after the `open` specs have become real
   * views — that is the only point at which the first tab of an `open`-only leaf
   * has an id at all.
   */
  activeViewId: ViewId | null
  /** True when this leaf got a freshly minted panel id rather than inheriting one */
  created: boolean
}

export type BuildLayoutOutcome =
  | { ok: false; reason: 'panelNotFound' | 'panelTaken'; panelId: PanelId }
  | { ok: true; layout: LayoutNode; leaves: BuiltLeaf[] }

export interface BuildLayoutIds {
  panel(): PanelId
  split(): SplitId
}

/**
 * Turn a declarative `LayoutSpecNode` into a real layout tree.
 *
 * Panel identity is the whole difficulty here, and it is resolved in two passes
 * rather than one:
 *
 * 1. every leaf that **pins** an explicit `panelId` reserves it first. The id has
 *    to exist in the current tree — a spec that names a panel which is already
 *    gone is a mistake worth reporting, not something to paper over by minting a
 *    fresh id under the same name;
 * 2. every remaining leaf that carries a `viewId` inherits the panel that view is
 *    sitting in right now, when nothing pinned it;
 * 3. anything left gets a fresh id.
 *
 * Reserving the pins first is what keeps the common case free of spurious
 * failures: with a single pass, a leaf that merely mentions a view could claim
 * the very panel a later leaf pins by name, and a perfectly coherent tree would
 * be rejected on leaf ordering alone.
 *
 * Split ids are **always** fresh. There is no honest notion of "the same split"
 * once the shape changes, and inventing a heuristic for it would only produce ids
 * that are stable by accident. The result reports the new tree instead.
 *
 * Views are neither created nor destroyed here: `open` leaves are passed through
 * for the handler, which runs the same `openView` helper `view.open` uses.
 */
export function buildLayoutFromSpec(
  current: LayoutNode,
  spec: LayoutSpecNode,
  ids: BuildLayoutIds,
): BuildLayoutOutcome {
  const specPanels = collectSpecPanels(spec)
  const taken = new Set<PanelId>()

  // Pass 1: explicit pins, which must name a panel that exists today.
  for (const leaf of specPanels) {
    if (leaf.panelId === undefined) continue
    if (!findPanel(current, leaf.panelId))
      return { ok: false, reason: 'panelNotFound', panelId: leaf.panelId }
    if (taken.has(leaf.panelId)) return { ok: false, reason: 'panelTaken', panelId: leaf.panelId }
    taken.add(leaf.panelId)
  }

  // Pass 2: inherit the panel a mentioned view already lives in.
  //
  // Leaves are addressed by position, never by object identity: a caller is free
  // to build its spec by repeating one node object, and two positions must still
  // come out as two panels with two ids.
  //
  // A leaf now lists several views, which may currently live in several different
  // panels, so "the panel this leaf inherits" needs a tie-break. The first listed
  // view whose panel is still free wins: tab order is the caller's own statement
  // of what this panel primarily is, and scanning past a view whose panel another
  // leaf already pinned is what keeps a coherent tree from being refused on leaf
  // ordering alone.
  const kept: (PanelId | null)[] = specPanels.map((leaf) => leaf.panelId ?? null)
  specPanels.forEach((leaf, i) => {
    if (kept[i] !== null) return
    for (const viewId of leaf.viewIds ?? []) {
      const host = findPanelOfView(current, viewId)
      if (!host || taken.has(host.id)) continue
      taken.add(host.id)
      kept[i] = host.id
      return
    }
  })

  // Pass 3: mint the rest, in visual order.
  const resolved: PanelId[] = kept.map((panelId) => panelId ?? ids.panel())

  const leaves: BuiltLeaf[] = []
  let cursor = 0
  const build = (node: LayoutSpecNode): LayoutNode => {
    if (node.type === 'panel') {
      const panelId = resolved[cursor]
      const created = kept[cursor] === null
      cursor += 1
      const viewIds = [...(node.viewIds ?? [])]
      leaves.push({
        panelId,
        ...(node.key === undefined ? {} : { key: node.key }),
        viewIds,
        open: [...(node.open ?? [])],
        activeViewId: node.activeViewId ?? null,
        created,
      })
      // `makePanel` enforces P1/P2 rather than trusting the spec: an
      // `activeViewId` outside `viewIds` is corrected to the first tab here as
      // well as rejected by the schema, so a tree built by a caller that bypassed
      // validation still cannot produce a panel showing a view it does not hold.
      return makePanel(panelId, viewIds, node.activeViewId ?? null)
    }
    const children = node.children.map(build)
    return {
      type: 'split',
      id: ids.split(),
      dir: node.dir,
      ratio: normalizeRatio(node.ratio ?? [], children.length),
      children,
    }
  }

  return { ok: true, layout: build(spec), leaves }
}

type LayoutSpecPanelNode = Extract<LayoutSpecNode, { type: 'panel' }>

/** Every panel leaf of a spec tree, in depth-first (visual) order */
function collectSpecPanels(node: LayoutSpecNode, out: LayoutSpecPanelNode[] = []): LayoutSpecPanelNode[] {
  if (node.type === 'panel') {
    out.push(node)
    return out
  }
  for (const child of node.children) collectSpecPanels(child, out)
  return out
}

/** Panels present in `before` but gone from `after` */
export function removedPanelIds(before: LayoutNode, after: LayoutNode): PanelId[] {
  const surviving = new Set<PanelId>(collectPanels(after).map((p) => p.id))
  return collectPanels(before)
    .map((p) => p.id)
    .filter((id) => !surviving.has(id))
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

export interface MountViewOptions {
  /** Final position in the tab bar; omitted means append */
  index?: number
  /** Show it once mounted (default true) */
  activate?: boolean
}

/**
 * Add a view to a panel's tab bar. Returns null when the panel does not exist.
 *
 * This replaces the pre-tab `setPanelView(root, panelId, viewId | null)`, whose
 * signature carried the old model in two places at once: it could only ever hold
 * one view, and it doubled as the way to clear a panel by passing null. Detaching
 * is now `clearViewFromPanels`, which is a different question (*which* panel holds
 * it) with a different answer (a succession rule).
 */
export function mountViewInPanel(
  root: LayoutNode,
  panelId: PanelId,
  viewId: ViewId,
  opts: MountViewOptions = {},
): LayoutNode | null {
  if (!findPanel(root, panelId)) return null
  return mapPanels(root, (panel) =>
    panel.id === panelId
      ? insertPanelTab(panel, viewId, {
          ...(opts.index === undefined ? {} : { index: opts.index }),
          activate: opts.activate !== false,
        })
      : panel,
  )
}

/**
 * Show a view that is already mounted. Returns null when no panel holds it —
 * which is a real failure for `view.activate` rather than a silent no-op: "bring
 * this tab to the front" cannot be honoured for a view that is in no tab bar.
 */
export interface ActivateViewOutcome {
  layout: LayoutNode
  panelId: PanelId
  /** The tab that was showing before; equal to `viewId` when the command changed nothing */
  previousViewId: ViewId | null
}

export function activateViewInTree(root: LayoutNode, viewId: ViewId): ActivateViewOutcome | null {
  const host = findPanelOfView(root, viewId)
  if (!host) return null
  return {
    // Identity is preserved when the view is already the active tab, so an
    // idempotent activation broadcasts nothing.
    layout: mapPanels(root, (panel) => (panel.id === host.id ? activatePanelTab(panel, viewId) : panel)),
    panelId: host.id,
    previousViewId: host.activeViewId,
  }
}

/**
 * Detach a view from whichever panel holds it; `panelId` is null when no panel
 * does.
 *
 * `activatedViewId` is the succession result — the tab that took over, or null
 * for a panel that is now empty. It is reported because closing a tab changes
 * what is on screen, and the alternative is every caller re-reading the tree to
 * find out what it is now looking at.
 */
export function clearViewFromPanels(
  root: LayoutNode,
  viewId: ViewId,
): { layout: LayoutNode; panelId: PanelId | null; activatedViewId: ViewId | null } {
  const host = findPanelOfView(root, viewId)
  if (!host) return { layout: root, panelId: null, activatedViewId: null }
  const detached = removePanelTab(host, viewId)
  return {
    layout: mapPanels(root, (panel) => (panel.id === host.id ? detached : panel)),
    panelId: host.id,
    activatedViewId: detached.activeViewId,
  }
}

/**
 * Rebuild a tree with every panel passed through `fn`.
 *
 * **Returns the original node when no child changed**, all the way up. Without
 * this, every operation that touches one panel allocates a fresh spine of split
 * objects, no tree operation can ever be compared by reference, and
 * `writeLayout`'s no-op guard silently stops working — see the file header.
 */
export function mapPanels(node: LayoutNode, fn: (panel: PanelNode) => PanelNode): LayoutNode {
  if (node.type === 'panel') return fn(node)
  let changed = false
  const children = node.children.map((child) => {
    const next = mapPanels(child, fn)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

/* ================================================================== */
/* Lookup helpers                                                      */
/* ================================================================== */

/** The first empty panel — where view.open lands when no panel was given and nothing has focus. */
export function firstEmptyPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root).find(isPanelEmpty) ?? null
}

export function firstPanel(root: LayoutNode): PanelNode | null {
  return collectPanels(root)[0] ?? null
}
