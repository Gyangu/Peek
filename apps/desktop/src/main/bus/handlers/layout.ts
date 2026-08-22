import type { Draft } from 'immer'
import {
  findPanel,
  type LayoutCloseResult,
  type LayoutMoveViewResult,
  type LayoutNode,
  type LayoutSetLayoutResult,
  type LayoutSplitWithViewResult,
  type PanelId,
  type ViewId,
  type Workspace,
} from '@peek/core'
import { plain } from '../../store/workspace-store'
import { ensureFocusedPanel } from '../../store/mutations'
import { failMsg } from '../failure'
import {
  activateViewInTree,
  buildLayoutFromSpec,
  closePanel,
  moveViewToPanel,
  nextFocusAfterRemoval,
  removedPanelIds,
  setSplitRatio,
  splitPanel,
  splitPanelWithView,
  type BuiltLeaf,
} from '../layout-ops'
import type { CommandHandlerMap } from '../types'
import {
  assertPanelTabsWithinLimit,
  assertWithinLimits,
  closeView,
  openView,
  requireView,
  writeLayout,
} from './shared'

/**
 * The pure state implementation of layout.*. Layout operations have no side
 * effects at all, and they are the only thing that moves along the "AI arranges
 * the workspace" path (PLAN sections 5 and 6).
 *
 * Two rules run through every handler below, both enforced by helpers shared
 * with `view.open` (see handlers/shared.ts): `assertWithinLimits` guards the tree
 * caps wherever a panel can be created, and `writeLayout` installs the tree only
 * when it actually changed — an unconditional assignment turns a no-op into a
 * `remove` patch that wipes the renderer's layout.
 */

/**
 * Put focus somewhere sensible after the tree changed shape.
 *
 * Only used when the focused panel did not survive; a focus that is still valid
 * is never moved. The neighbour comes first and `ensureFocusedPanel`'s "first
 * panel in the tree" only last, because closing the bottom-right panel and
 * finding focus in the top-left corner reads as the window losing its place —
 * every tiling window manager walks to the adjacent pane instead.
 *
 * `before` has to be the tree as it was, since the removed panel's position in
 * visual order is the entire question.
 */
function repairFocus(draft: Draft<Workspace>, before: LayoutNode): void {
  const focused = draft.focusedPanel
  const layout = plain(draft.layout)
  if (focused !== null && !findPanel(layout, focused)) {
    const neighbour = nextFocusAfterRemoval(before, focused)
    if (neighbour !== null && findPanel(layout, neighbour)) draft.focusedPanel = neighbour
  }
  ensureFocusedPanel(draft)
}

export const layoutHandlers = {
  'layout.split': {
    reduce(draft, input, ctx) {
      const outcome = splitPanel(plain(draft.layout), {
        panelId: input.panelId,
        dir: input.dir,
        ...(input.insert ? { insert: input.insert } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        newPanelId: ctx.ids.panel(),
        newSplitId: ctx.ids.split(),
      })
      if (!outcome) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })
      assertWithinLimits(outcome.layout)

      writeLayout(draft, outcome.layout)
      draft.focusedPanel = outcome.panelId

      if (!input.view) return { splitId: outcome.splitId, panelId: outcome.panelId }

      const opened = openView(draft, input.view, ctx, { panelId: outcome.panelId })
      return { splitId: outcome.splitId, panelId: outcome.panelId, viewId: opened.viewId }
    },
  },

  'layout.focus': {
    reduce(draft, input) {
      if (!findPanel(plain(draft.layout), input.panelId)) {
        failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })
      }
      draft.focusedPanel = input.panelId
      return { panelId: input.panelId }
    },
  },

  'layout.setRatio': {
    reduce(draft, input) {
      const outcome = setSplitRatio(plain(draft.layout), input.splitId, input.ratio)
      if (!outcome.ok) {
        if (outcome.reason === 'notFound') {
          failMsg('NOT_FOUND', 'error.layout.splitNotFound', { splitId: input.splitId })
        }
        // `expected` is always set on a lengthMismatch, but the type does not say
        // so; String() keeps the rendering identical either way.
        failMsg('BAD_REQUEST', 'error.layout.ratioLength', {
          expected: String(outcome.expected),
          actual: input.ratio.length,
        })
      }
      writeLayout(draft, outcome.layout)
      return { splitId: input.splitId, ratio: outcome.ratio }
    },
  },

  'layout.close': {
    reduce(draft, input, ctx) {
      const before = plain(draft.layout)
      const outcome = closePanel(before, input.panelId)
      if (!outcome) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })

      const closedViewIds: ViewId[] = []
      // Remove the views first (which also cancels any running result sets), then
      // install the new layout: closeView edits the layout too, so the reverse
      // order would overwrite its work.
      //
      // **Every tab, not just the visible one.** Closing a panel closes its whole
      // stack; leaving the background tabs open would strand them in `views` with
      // no panel to reach them from, each still holding a connection and a result
      // set that nothing on screen accounts for.
      if (input.closeView !== false) {
        for (const viewId of outcome.viewIds) {
          closeView(draft, viewId, ctx)
          closedViewIds.push(viewId)
        }
      }

      writeLayout(draft, outcome.layout)
      repairFocus(draft, before)

      const result: LayoutCloseResult = { panelId: input.panelId, closedViewIds }
      return result
    },
  },

  /* ---------------------------------------------------------------- */
  /* M2 — moving an open view between panels                           */
  /* ---------------------------------------------------------------- */

  /**
   * The reference implementation for M2's layout commands, and the shape the
   * other two should follow: validate the ids against the workspace, run one
   * **pure** tree operation from layout-ops, write the tree back in one
   * assignment, then repair focus.
   *
   * Note what stays out of here: no geometry, no drag state, no knowledge that a
   * mouse was involved. The renderer decides which zone the cursor is in and
   * turns that into this command; a drag and an MCP call reach this reducer as
   * the same input.
   */
  'layout.moveView': {
    reduce(draft, input, ctx) {
      // A view that does not exist is NOT_FOUND before anything touches the tree,
      // so a stale viewId in an AI's hand fails loudly rather than silently
      // mounting nothing.
      requireView(draft, input.viewId)

      const before = plain(draft.layout)
      const outcome = moveViewToPanel(before, {
        viewId: input.viewId,
        toPanelId: input.toPanelId,
        ...(input.index === undefined ? {} : { index: input.index }),
        ...(input.activate === undefined ? {} : { activate: input.activate }),
        ...(input.onOccupied ? { onOccupied: input.onOccupied } : {}),
        ...(input.keepSourcePanel === undefined ? {} : { keepSourcePanel: input.keepSourcePanel }),
      })
      if (!outcome.ok) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.toPanelId })
      // Stacking is now the default, so this command adds a tab on the common
      // path and answers to the tab cap like every other way of adding one.
      assertPanelTabsWithinLimit(outcome.layout)

      writeLayout(draft, outcome.layout)

      // 'replace' is the one branch that destroys something. The displaced view
      // has already been detached from the destination by the tree operation, so
      // closeView only drops it from `views` and cancels whatever it was running.
      const closedViewIds: ViewId[] = []
      if (outcome.displacedViewId !== null && !outcome.swapped) {
        closeView(draft, outcome.displacedViewId, ctx)
        closedViewIds.push(outcome.displacedViewId)
      }

      if (input.focus !== false) draft.focusedPanel = outcome.focusHint
      // Repairs a focus left dangling by the removal of the source panel.
      repairFocus(draft, before)

      // `swappedViewId` now appears **only** for an explicit swap that had a
      // source panel to trade with. The pre-tab result had to name a view that
      // might have been silently unmounted by the default path; stacking removed
      // that situation rather than the reporting of it, so on the default path
      // there is simply nothing displaced to name.
      const result: LayoutMoveViewResult = {
        viewId: input.viewId,
        fromPanelId: outcome.fromPanelId,
        toPanelId: input.toPanelId,
        toIndex: outcome.toIndex,
        moved: outcome.moved,
        ...(outcome.swapped && outcome.displacedViewId !== null
          ? { swappedViewId: outcome.displacedViewId }
          : {}),
        closedViewIds,
        removedPanelIds: outcome.removedPanelIds,
        focusedPanel: draft.focusedPanel,
      }
      return result
    },
  },

  /**
   * Edge drop: split `panelId` and move `viewId` into the panel that appears.
   *
   * The mirror image of `layout.moveView` — same validation, same single pure
   * tree operation, same focus repair — and deliberately not folded into
   * `layout.split`, whose optional `view` *opens* something new. Here the view
   * already exists and is only relocated.
   */
  'layout.splitWithView': {
    reduce(draft, input, ctx): LayoutSplitWithViewResult {
      requireView(draft, input.viewId)

      const before = plain(draft.layout)
      const outcome = splitPanelWithView(before, {
        viewId: input.viewId,
        panelId: input.panelId,
        dir: input.dir,
        ...(input.insert ? { insert: input.insert } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(input.keepSourcePanel === undefined ? {} : { keepSourcePanel: input.keepSourcePanel }),
        newPanelId: ctx.ids.panel(),
        newSplitId: ctx.ids.split(),
      })
      if (!outcome.ok) failMsg('NOT_FOUND', 'error.panel.notFound', { panelId: input.panelId })
      // The tree that actually lands is the one after the collapse, so that is
      // the one the caps are measured against.
      assertWithinLimits(outcome.layout)

      writeLayout(draft, outcome.layout)
      if (input.focus !== false) draft.focusedPanel = outcome.focusHint
      repairFocus(draft, before)

      return {
        viewId: input.viewId,
        splitId: outcome.splitId,
        panelId: outcome.panelId,
        fromPanelId: outcome.fromPanelId,
        moved: outcome.moved,
        removedPanelIds: outcome.removedPanelIds,
        focusedPanel: draft.focusedPanel,
      }
    },
  },

  /**
   * Declarative whole-tree layout: the caller describes the window it wants and
   * main works out which panels keep their identity.
   *
   * It exists next to the two fine-grained commands, not instead of them, because
   * the two costs are asymmetric: arranging a four-pane comparison one command at
   * a time is four round trips for a model, each one a chance to act on a stale
   * panel id, while nudging a single view would be a whole tree resent for no
   * reason. Both paths share these same reducers and the same pure functions in
   * layout-ops, so there is one set of semantics, not two.
   *
   * Atomicity comes free from immer: any `throw` below discards the entire draft,
   * which is why an `open` leaf that fails to open cannot leave half a tree
   * behind, and why nothing here tries to unwind by hand.
   */
  'layout.setLayout': {
    reduce(draft, input, ctx): LayoutSetLayoutResult {
      // Optimistic concurrency first: if the workspace moved under the caller,
      // nothing else it says is worth acting on.
      if (input.expectRev !== undefined && input.expectRev !== draft.rev) {
        failMsg('CONFLICT', 'error.layout.revMismatch', { expected: input.expectRev, actual: draft.rev })
      }

      const before = plain(draft.layout)
      const built = buildLayoutFromSpec(before, input.tree, ctx.ids)
      if (!built.ok) {
        // A pinned panel that no longer exists is reported rather than quietly
        // minted: the caller is describing a tree it believes in, and being told
        // its belief is stale is the point of pinning ids at all.
        failMsg(built.reason === 'panelNotFound' ? 'NOT_FOUND' : 'BAD_REQUEST', 'error.panel.notFound', {
          panelId: built.panelId,
        })
      }
      assertWithinLimits(built.layout)

      // Views the tree mounts must exist before anything is installed, so a stale
      // id fails as NOT_FOUND instead of leaving a dangling viewId in a panel.
      for (const leaf of built.leaves) {
        for (const viewId of leaf.viewIds) requireView(draft, viewId)
      }

      const placed = new Set<ViewId>(built.leaves.flatMap((leaf) => leaf.viewIds))
      // Every open view, not just the mounted ones: a view left unplaced by an
      // earlier `unplaced: 'keep'` is equally absent from this tree.
      const absent = Object.values(draft.views)
        .map((view) => view.id)
        .filter((id) => !placed.has(id))
      if (absent.length > 0 && input.unplaced === 'error') {
        failMsg('CONFLICT', 'error.layout.wouldUnplace', { count: absent.length })
      }

      writeLayout(draft, built.layout)

      // `close` is the default so that the tree really is the whole window: a
      // human staring at the screen has no way to discover views floating outside
      // it, still holding a connection and a result set.
      const closedViewIds: ViewId[] = []
      const unplacedViewIds: ViewId[] = []
      for (const viewId of absent) {
        if (input.unplaced === 'keep') {
          unplacedViewIds.push(viewId)
        } else {
          closeView(draft, viewId, ctx)
          closedViewIds.push(viewId)
        }
      }

      // Views are created through the same helper `view.open` uses — connection
      // check, autoFetch and effect planning included. Nothing here reaches past
      // the bus.
      //
      // `activate: false` is what makes a leaf's `activeViewId` mean anything:
      // each opened view is appended as a background tab, so the tab the spec
      // named stays on screen. On a leaf that mounts nothing, P1 still forces the
      // first arrival to become visible — which is exactly the documented
      // fallback, "the first `open` leaf when `viewIds` is empty". A leaf that
      // named `activeOpenIndex` overrides that fallback once its views exist.
      const openedViewIds: ViewId[] = []
      for (const leaf of built.leaves) {
        const mine: ViewId[] = []
        for (const spec of leaf.open) {
          const opened = openView(draft, spec, ctx, {
            panelId: leaf.panelId,
            replace: false,
            activate: false,
            focus: false,
          })
          openedViewIds.push(opened.viewId)
          mine.push(opened.viewId)
        }
        // `activeOpenIndex` is resolved here and nowhere earlier: it exists exactly
        // because the view it names had no id until the loop above ran. The index
        // is in range by schema, and `mine` is this leaf's own opens in spec order,
        // so the lookup cannot reach another leaf's tab.
        const wanted = leaf.activeOpenIndex === null ? undefined : mine[leaf.activeOpenIndex]
        if (wanted !== undefined) {
          const shown = activateViewInTree(plain(draft.layout), wanted)
          if (shown) writeLayout(draft, shown.layout)
        }
      }
      // The schema caps each leaf, but the handler is the gate: `viewIds` and
      // `open` are counted together only once both halves are real.
      assertPanelTabsWithinLimit(plain(draft.layout))

      const focusPanel = resolveSetLayoutFocus(built.leaves, input.focusViewId, input.focusKey)
      if (focusPanel !== null) draft.focusedPanel = focusPanel
      // Otherwise the current focus stands when it survived the rewrite, and
      // repairFocus picks up the case where it did not.
      repairFocus(draft, before)

      // The panels are reported from the **installed tree**, not from the spec
      // leaves: the leaves say what was asked for, and only the tree knows what
      // the opened views and P1 made of it.
      const applied = plain(draft.layout)
      return {
        panels: built.leaves.map((leaf) => {
          const node = findPanel(applied, leaf.panelId)
          return {
            ...(leaf.key === undefined ? {} : { key: leaf.key }),
            panelId: leaf.panelId,
            viewIds: [...(node?.viewIds ?? leaf.viewIds)],
            activeViewId: node?.activeViewId ?? null,
          }
        }),
        createdPanelIds: built.leaves.filter((leaf) => leaf.created).map((leaf) => leaf.panelId),
        openedViewIds,
        unplacedViewIds,
        closedViewIds,
        removedPanelIds: removedPanelIds(before, plain(draft.layout)),
        focusedPanel: draft.focusedPanel,
      }
    },
  },
} satisfies CommandHandlerMap

/**
 * `focusViewId` names a view and `focusKey` a leaf — the second exists because a
 * leaf with no view has no other handle, and focusing an empty panel is a real
 * thing to want. The schema already rules out passing both.
 */
function resolveSetLayoutFocus(
  leaves: BuiltLeaf[],
  focusViewId: ViewId | undefined,
  focusKey: string | undefined,
): PanelId | null {
  if (focusViewId !== undefined) {
    return leaves.find((leaf) => leaf.viewIds.includes(focusViewId))?.panelId ?? null
  }
  if (focusKey !== undefined) {
    return leaves.find((leaf) => leaf.key === focusKey)?.panelId ?? null
  }
  return null
}
