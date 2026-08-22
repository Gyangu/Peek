/**
 * Pre-flight checks shared by the layout tools (set_layout / move_view).
 *
 * These do **not** re-implement any tree logic — the Command handlers in
 * `bus/handlers/layout.ts` remain the only authority on what a layout change
 * does, and they reject every condition checked here as well. What this module
 * adds is the one thing a handler cannot: the *list of ids that would have
 * worked*. An AI that is told "view_9 does not exist" resends the same tree with
 * a different guess; an AI that is told "view_9 does not exist; open views are
 * view_1, view_2" fixes it in one step. Everything here is therefore diagnostic
 * only, and stays read-only against the snapshot.
 */

import {
  collectPanels,
  findPanel,
  findSplit,
  peekError,
  type ConnId,
  type LayoutNode,
  type LayoutSpecNode,
  type LayoutSpecPanel,
  type PanelId,
  type PeekError,
  type PeekErrorCode,
  type SplitId,
  type ViewId,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'

/* ================================================================== */
/* 1. Failing out of a tool mapping                                     */
/* ================================================================== */

/**
 * Abort a tool's `toCommands` with a structured error.
 *
 * The PeekError *is* what gets thrown: `toPeekError` recognises the shape and
 * passes it through untouched, whereas wrapping it in an `Error` would collapse
 * the code down to INTERNAL and lose the reason the AI needs.
 */
export function toolFail(code: PeekErrorCode, message: string, detail?: string): never {
  const error: PeekError = peekError(code, message, detail === undefined ? undefined : { detail })
  throw error
}

/* ================================================================== */
/* 2. Reading ids out of a snapshot                                     */
/* ================================================================== */

export function listViewIds(snap: WorkspaceSnapshot): string[] {
  return snap.views.map((v) => String(v.id))
}

export function listPanelIds(snap: WorkspaceSnapshot): string[] {
  return collectPanels(snap.layout).map((p) => String(p.id))
}

/**
 * Every split in the tree, depth-first, rendered the way `set_ratio` needs to read
 * them: which way it divides, how many children it has (which is how long a `ratio`
 * must be), and what the shares are today.
 *
 * Core has `findSplit` but no `collectSplits` — nothing in the app needs the list,
 * only this diagnostic does, so the walk lives here rather than widening core's
 * surface for an error message.
 */
export function describeSplits(snap: WorkspaceSnapshot): string[] {
  const out: string[] = []
  const walk = (node: LayoutNode): void => {
    if (node.type === 'panel') return
    const shares = node.ratio.map((r) => r.toFixed(2)).join('/')
    out.push(
      `${String(node.id)} (dir=${node.dir}, ${String(node.children.length)} children, ratio ${shares})`,
    )
    for (const child of node.children) walk(child)
  }
  walk(snap.layout)
  return out
}

/** Views that exist but sit in no panel — the ones only `layout.moveView` / `set_layout` can bring back. */
export function unplacedViews(snap: WorkspaceSnapshot): ViewSummary[] {
  return snap.views.filter((v) => v.panelId === null)
}

/**
 * A compact catalogue of everything addressable, attached as `detail` on a
 * failure so the retry can be made from data rather than from memory.
 *
 * Panels list their whole tab stack, not just what is on screen. A caller
 * repairing a rejected tree has to be able to name a background tab — and, more
 * to the point, the commonest way to break invariant P4 is to place a view that
 * some *other* panel is already holding out of sight, which a catalogue of
 * active tabs alone could not explain.
 */
export function addressableIds(snap: WorkspaceSnapshot): string {
  const panels = collectPanels(snap.layout)
    .map((p) => {
      if (p.viewIds.length === 0) return `${String(p.id)}[empty]`
      const tabs = p.viewIds
        .map((viewId) => `${String(viewId)}${viewId === p.activeViewId ? '*' : ''}`)
        .join(', ')
      return `${String(p.id)}[${tabs}]`
    })
    .join(', ')
  const views = snap.views
    .map((v) => {
      const where =
        v.panelId === null ? '(unplaced)' : v.visible ? '' : `(background tab of ${String(v.panelId)})`
      return `${String(v.id)}${where} ${v.describe}`
    })
    .join('; ')
  const conns = snap.connections.map((c) => `${String(c.id)} ${c.label} (${c.status})`).join('; ')
  return [
    `rev: ${String(snap.rev)}`,
    `panels (tabs in tab-bar order, * = the visible one): ${panels.length > 0 ? panels : '(none)'}`,
    `views: ${views.length > 0 ? views : '(none)'}`,
    `connections: ${conns.length > 0 ? conns : '(none)'}`,
  ].join('\n')
}

/* ================================================================== */
/* 3. Walking a target tree                                            */
/* ================================================================== */

/** Every leaf of a target tree, in depth-first (visual) order — the order the result reports. */
export function collectSpecPanels(node: LayoutSpecNode, out: LayoutSpecPanel[] = []): LayoutSpecPanel[] {
  if (node.type === 'panel') {
    out.push(node)
    return out
  }
  for (const child of node.children) collectSpecPanels(child, out)
  return out
}

/* ================================================================== */
/* 4. Existence checks                                                 */
/* ================================================================== */

export function requireViewExists(snap: WorkspaceSnapshot, viewId: ViewId, where: string): void {
  if (snap.views.some((v) => v.id === viewId)) return
  toolFail(
    'NOT_FOUND',
    `${where}: view ${String(viewId)} does not exist. Open views are: ${listViewIds(snap).join(', ') || '(none)'}`,
    addressableIds(snap),
  )
}

/**
 * Stronger than `requireViewExists`: the view must also be sitting on a panel.
 *
 * `view.activate` switches to a tab, and an unplaced view has no tab to switch to.
 * The handler refuses it as well (`error.view.notMounted`); checking here is what
 * lets the message name the repair — `move_view` — instead of leaving the caller to
 * work out why an id that read_workspace definitely listed was rejected.
 */
export function requireViewMounted(snap: WorkspaceSnapshot, viewId: ViewId, where: string): void {
  requireViewExists(snap, viewId, where)
  const view = snap.views.find((v) => v.id === viewId)
  if (view !== undefined && view.panelId !== null) return
  toolFail(
    'CONFLICT',
    `${where}: view ${String(viewId)} is open but sits in no panel, so it has no tab to bring forward. ` +
      'Place it on a panel with move_view first (read_workspace lists these as unplacedViews).',
    addressableIds(snap),
  )
}

/**
 * Refuse a `set_layout` that leaves views out without saying what becomes of them.
 *
 * The Command's own default is `close`, and it stays that way — a tree built from a
 * file (`workspace-restore.ts`) never forgets a view, because it is not written from
 * memory. A model is: it reads a snapshot, thinks, and writes a tree, and "close
 * these three" and "I forgot these three" arrive as byte-identical JSON. So the tool
 * makes the destructive reading the one that has to be spelled out, and names the
 * views at stake — with their `describe`, which is the only thing that tells the
 * caller whether losing them matters.
 *
 * A tree that covers everything needs no policy and gets no ceremony.
 */
export function requireUnplacedPolicy(
  snap: WorkspaceSnapshot,
  tree: LayoutSpecNode,
  policy: 'close' | 'keep' | 'error' | undefined,
): void {
  if (policy !== undefined) return
  const placed = new Set<ViewId>(collectSpecPanels(tree).flatMap((leaf) => leaf.viewIds ?? []))
  const absent = snap.views.filter((v) => !placed.has(v.id))
  if (absent.length === 0) return
  const named = absent.map((v) => `${String(v.id)} (${v.describe})`).join(', ')
  toolFail(
    'CONFLICT',
    `${String(absent.length)} open view(s) are absent from this tree and the call did not say what should ` +
      `happen to them: ${named}. Add them to the tree, or pass unplaced:"close" to close them, ` +
      '"keep" to park them offscreen, or "error" if you believe the tree already covers everything.',
    addressableIds(snap),
  )
}

export function requirePanelExists(
  snap: WorkspaceSnapshot,
  panelId: PanelId,
  where: string,
  code: PeekErrorCode = 'NOT_FOUND',
): void {
  if (findPanel(snap.layout, panelId) !== null) return
  toolFail(
    code,
    `${where}: panel ${String(panelId)} does not exist. Current panels are: ${listPanelIds(snap).join(', ') || '(none)'}`,
    addressableIds(snap),
  )
}

/**
 * The split must exist, and the ratio must have one entry per child.
 *
 * Both are refused by `layout.setRatio` as well. What is added here is the shape of
 * the tree the caller was aiming at: a split id that has gone stale is indistinguishable
 * from a typo unless the reply says which splits are there now, and "ratio has 3
 * entries but the split has 2 children" is only actionable next to the split it is
 * about. Returns nothing — like every check in this file, it either passes or throws.
 */
export function requireSplitRatio(snap: WorkspaceSnapshot, splitId: SplitId, ratio: number[]): void {
  const split = findSplit(snap.layout, splitId)
  if (split === null) {
    const known = describeSplits(snap)
    toolFail(
      'NOT_FOUND',
      `split ${String(splitId)} does not exist. Splits in the current layout: ${known.join('; ') || '(none — the window is a single panel, so there is nothing to resize)'}`,
      addressableIds(snap),
    )
  }
  if (ratio.length === split.children.length) return
  toolFail(
    'BAD_REQUEST',
    `split ${String(splitId)} has ${String(split.children.length)} children but ratio has ${String(ratio.length)} entries. ` +
      'Pass one positive number per child, in the same order as the split divides the space.',
    addressableIds(snap),
  )
}

export function requireConnExists(snap: WorkspaceSnapshot, connId: ConnId, where: string): void {
  if (snap.connections.some((c) => c.id === connId)) return
  const known = snap.connections.map((c) => `${String(c.id)} (${c.label})`).join(', ')
  toolFail(
    'NOT_FOUND',
    `${where}: connection ${String(connId)} does not exist. Open connections are: ${known || '(none) — call connect first'}`,
    addressableIds(snap),
  )
}

/**
 * Optimistic concurrency, checked before anything is dispatched.
 *
 * The Command handler checks this too and is the authority; doing it here as
 * well only means the failure names the revision the caller should re-read from,
 * instead of arriving as a generic conflict.
 */
export function requireRev(snap: WorkspaceSnapshot, expectRev: number | undefined): void {
  if (expectRev === undefined || expectRev === snap.rev) return
  toolFail(
    'CONFLICT',
    `expectRev ${String(expectRev)} does not match the workspace revision ${String(snap.rev)}: ` +
      'something changed the layout in between. Call read_workspace again and rebuild the tree from what it returns.',
    addressableIds(snap),
  )
}
