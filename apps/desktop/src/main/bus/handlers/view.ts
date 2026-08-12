import type { Draft } from 'immer'
import { collectionBrowseStyle } from '@peek/core'
import type {
  ConnId,
  DriverId,
  PackageViewAnswer,
  PackageViewState,
  PackageViewStateShape,
  ViewActivateResult,
  ViewCloseResult,
  ViewPatch,
  ViewId,
  ViewPromoteResult,
  ViewUpdateResult,
  ViewState,
  Workspace,
} from '@peek/core'
import { setAutoRefresh, setAutoRefreshOn } from '../../store/mutations'
import { plain } from '../../store/workspace-store'
import { failMsg } from '../failure'
import { activateViewInTree } from '../layout-ops'
import type { CommandHandler, CommandPreparation, CommandReducer } from '../types'
import { autoFetch, closeView, openView, packageTextOf, packageViewOf, requireView, writeLayout } from './shared'

/* ================================================================== */
/* Asking a package about its own view                                 */
/* ================================================================== */

/**
 * Where `view.open` / `view.update` get a package view's fetch plan, title and
 * description from.
 *
 * An injected service rather than a function call because the answer comes from
 * another process (design 2026-08-07 §2.4bis) — the same reason `CommandDeps`
 * exists, and the same shape: the bus must not import the package host registry,
 * or these handlers stop being testable without forking anything.
 *
 * **`null` means "nobody answered"**, and it is an ordinary outcome rather than
 * a failure to report: no installed package registers the kind, the package's
 * host crashed, or it ran past its deadline. Each of those is a view that does
 * not fetch this time round, which is a state the kernel already has (see
 * `startPackageFetch`). An implementation is expected to swallow and attribute
 * its own transport failures for that reason; what it must not do is reject,
 * because that would fail a Command over a title.
 */
export interface PackageViewSource {
  answer(req: PackageViewQuestion): Promise<PackageViewAnswer | null>
}

/**
 * One question about one package view.
 *
 * `driverId` is here because the view carries a `ConnId` and a routing decision
 * needs a driver: which package is asked follows from which one ships the driver
 * this view is connected to. Resolving it is the caller's job rather than the
 * service's — the connection table is workspace state, and a service that read
 * the workspace would be a second reader of it racing the reducer.
 */
export interface PackageViewQuestion {
  driverId: DriverId
  view: PackageViewStateShape
}

/**
 * The placeholder, exactly analogous to `createUnavailableDeps`.
 *
 * A build with no package hosts wired up still opens, patches, moves and closes
 * package views; they simply never fetch and keep whatever text they were
 * restored with. That is the same degradation an uninstalled package produces,
 * so it needs no second code path.
 */
export function createUnavailablePackageViews(): PackageViewSource {
  return { answer: async () => null }
}

/**
 * The `view.*` slice of the handler map, with every key **required** — so
 * `coreHandlers` keeps proving `satisfies Required<CommandHandlerMap>` and a new
 * view command cannot be added without being implemented.
 *
 * Each entry's `reduce` is required too, which `Required<Pick<…>>` would not
 * say: several tests drive a reducer directly rather than through the bus, and
 * an optional `reduce` would make every one of those call sites a null check
 * over something that has always been there.
 */
export type ViewHandlerMap = {
  [K in 'view.open' | 'view.update' | 'view.close' | 'view.activate' | 'view.promote']: CommandHandler<K> & {
    reduce: CommandReducer<K>
  }
}

/**
 * The pure state implementation of view.*.
 * In PLAN, "open a table", "change a filter" and "page through results" are all
 * view.* — which is why `update` is the hottest path here.
 *
 * Two of the five have a `prepare` in front of them, and it is the only thing in
 * this file that is not pure: it asks a package what its view should fetch and
 * what to call it, *before* the reducer runs, so that the reducer itself stays
 * synchronous (§2.4bis e, and `CommandPreparer`). A command carrying no package
 * view answers that question without leaving the tick.
 */
export function createViewHandlers(packages: PackageViewSource): ViewHandlerMap {
  return {
    'view.open': {
      prepare(state, input) {
        const spec = input.spec
        if (spec.kind !== 'package') return NOTHING
        const driverId = driverOf(state, spec.connId)
        return driverId === null ? NOTHING : ask(packages, driverId, packageViewOf(spec))
      },

      reduce(draft, input, ctx) {
        return openView(draft, input.spec, ctx, {
          ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
          ...(input.provisional !== undefined ? { provisional: input.provisional } : {}),
          ...(input.index !== undefined ? { index: input.index } : {}),
          ...(input.focus !== undefined ? { focus: input.focus } : {}),
          run: input.spec.kind === 'query' && input.spec.run === true,
        })
      },
    },

    'view.update': {
      /**
       * The package is asked about the state the patch **will** produce, not the
       * one on screen: what it answers is what the reducer is about to make true,
       * and asking about the old state would fetch the previous page.
       *
       * It is asked for every patch to a package view, including one that changes
       * nothing (auto-refresh sends an empty patch and asks for the fetch by
       * setting `refresh`). Cheap enough — these commands come from a click or a
       * model call, never from a frame — and the alternative is main deciding
       * which of a package's own keys matter, which is exactly what it cannot do.
       */
      prepare(state, input) {
        const view = packageViewIn(state, input.viewId)
        if (view === null || input.patch.kind !== 'package') return NOTHING
        const driverId = driverOf(state, view.connId)
        if (driverId === null) return NOTHING
        const next = mergePackageState(view.state, input.patch.state) ?? view.state
        return ask(packages, driverId, shapeOf(view, next))
      },

      reduce(draft, input, ctx) {
        const view = requireView(draft, input.viewId)
        if (view.kind !== input.patch.kind) {
          failMsg('BAD_REQUEST', 'error.view.kindMismatch', {
            viewId: input.viewId,
            actual: view.kind,
            expected: input.patch.kind,
          })
        }

        // Read before the patch is applied: "was this a page-forward?" is a
        // question about the state the gesture arrived in.
        const pagedForward = isCursorPageForward(view, input.patch)

        const affectsFetch = applyViewPatch(view, input.patch)
        if (pagedForward) setAutoRefresh(draft, view.id, null, 'paged')
        // The answer describes the state that now exists, so it lands whether or
        // not this patch refetches: a package view whose title tracked only the
        // patches that happened to fetch would drift from what it is showing.
        const text = packageTextOf(ctx)
        if (view.kind === 'package' && text !== undefined) view.packageText = text
        // Changing fetch parameters on a table / vector view refetches by default;
        // a query view needs an explicit query.run.
        const refresh = input.refresh ?? (affectsFetch && view.kind !== 'query')

        const result: ViewUpdateResult = { viewId: view.id }
        if (refresh) {
          const resultId = autoFetch(draft, view.id, ctx, true)
          if (resultId !== undefined) result.resultId = resultId
        }
        return result
      },
    },

    'view.close': {
      reduce(draft, input, ctx) {
        requireView(draft, input.viewId)
        const { panelId, activatedViewId } = closeView(draft, input.viewId, ctx)
        const result: ViewCloseResult = { viewId: input.viewId, panelId, activatedViewId }
        return result
      },
    },

    /**
     * Show a view that is already open — the tab bar's one irreducible operation.
     *
     * It is a Command rather than renderer-local state for the same reason
     * everything else here is: `activeViewId` lives on the layout tree, main owns
     * that tree, the renderer is a read-only mirror, and an AI that cannot reach
     * this cannot bring a hidden view to the front.
     *
     * A view that exists but sits in no panel is `NOT_FOUND` with its own message
     * rather than a silent no-op: "show this tab" has no meaning for a view that is
     * in no tab bar, and the fix (`layout.moveView`) is different from the fix for
     * a view that does not exist.
     */
    'view.activate': {
      reduce(draft, input) {
        requireView(draft, input.viewId)

        const outcome = activateViewInTree(plain(draft.layout), input.viewId)
        if (!outcome) failMsg('NOT_FOUND', 'error.view.notMounted', { viewId: input.viewId })

        // Identity-preserving: activating the tab that is already showing writes
        // nothing to the draft and broadcasts no patch.
        writeLayout(draft, outcome.layout)
        if (input.focusPanel !== false) draft.focusedPanel = outcome.panelId

        const result: ViewActivateResult = {
          viewId: input.viewId,
          panelId: outcome.panelId,
          previousViewId: outcome.previousViewId,
          focusedPanel: draft.focusedPanel,
        }
        return result
      },
    },

    /**
     * Keep a provisional view. See `ViewBase.provisional`.
     *
     * Not an error when the view was never provisional — every caller is a user
     * saying "I am using this", and that is already true of a kept view. The
     * result says which of the two happened so a caller that cares can tell.
     */
    'view.promote': {
      reduce(draft, input) {
        const view = requireView(draft, input.viewId)
        const promoted = view.provisional === true
        if (promoted) delete view.provisional
        const result: ViewPromoteResult = { viewId: input.viewId, promoted }
        return result
      },
    },
  }
}

/**
 * The `view.*` handlers a build with no package hosts gets.
 *
 * `createCommandBus` registers these, and assembly overwrites them by name with
 * `createViewHandlers(realSource)` — the same substitution `createChatHandlers`
 * makes, and for the same reason: everything up to the package boundary works
 * before the boundary is wired up.
 */
export const viewHandlers: ViewHandlerMap = createViewHandlers(createUnavailablePackageViews())

/**
 * The answer for a command that has nothing to ask.
 *
 * Returned synchronously, which is the whole reason the two `prepare`s above are
 * not `async`: a table patch must reach its reducer in the tick it arrived in,
 * exactly as it did before package views existed. See `CommandPreparer`.
 */
const NOTHING: CommandPreparation = {}

/** Ask, and turn "nobody answered" into "nothing was prepared". */
async function ask(
  packages: PackageViewSource,
  driverId: DriverId,
  view: PackageViewStateShape,
): Promise<CommandPreparation> {
  const answer = await packages.answer({ driverId, view })
  return answer === null ? NOTHING : { packageView: answer }
}

/**
 * The driver a view is connected to, or null when the connection is not there.
 *
 * Null is not worth failing on: a `view.open` naming a connection that does not
 * exist is the reducer's error to raise, and one whose connection was closed
 * between this tick and that one is a view that opens idle — the same outcome
 * `canFetch` produces for a connection that is merely not ready.
 */
function driverOf(state: Workspace, connId: ConnId): DriverId | null {
  return state.connections[connId]?.driverId ?? null
}

/**
 * The view a `view.update` is about, when it is a package view; null otherwise.
 *
 * Null covers a view that no longer exists, and that is not worth distinguishing
 * here: `prepare` runs a tick before the reducer, so the answer to "does this
 * view exist" is the reducer's to give (`requireView`), not this one's.
 */
function packageViewIn(state: Workspace, viewId: ViewId): PackageViewState | null {
  const view = state.views[viewId]
  return view?.kind === 'package' ? view : null
}

/**
 * The view as the package sees it.
 *
 * Rebuilt field by field rather than spread, so that what crosses the boundary
 * is exactly `PackageViewStateShape` — the kernel's own additions (`id`,
 * `status`, `resultId`, the previous answer) are not the package's business, and
 * a package that started reading one of them would be depending on a field the
 * contract never promised it.
 */
function shapeOf(view: PackageViewState, state: Readonly<Record<string, unknown>>): PackageViewStateShape {
  return {
    kind: 'package',
    packageKind: view.packageKind,
    connId: view.connId,
    state,
    ...(view.ref === undefined ? {} : { ref: view.ref }),
  }
}

/**
 * "This patch is the Next-page gesture on a cursor-paged collection."
 *
 * A cursor store only addresses forward, so the sole way to advance is to re-run
 * the scan with the token the last page handed back — which is a `view.update`
 * carrying *nothing but* its `kind`. That empty shape is what identifies the
 * gesture, and it is also exactly what auto-refresh must not do: `refreshPatch`
 * sends `offset: 0` on such a collection precisely so a refresh restarts the scan
 * instead of paging.
 *
 * So the two cannot coexist. Once the reader has walked to page four, a timer
 * that restarts the scan every five seconds would drag them back to page one, and
 * a timer that advanced instead would be a page-turner rather than a refresher.
 * Auto-refresh yields, with a reason the toolbar can show.
 *
 * It is decided here rather than in the button's click handler because PLAN §6's
 * rule is that a human and a model reach the same rules through the same command
 * — `move_view`-style tooling that pages a collection forward has to lose the
 * timer too.
 */
function isCursorPageForward(view: Draft<ViewState>, patch: ViewPatch): boolean {
  if (view.kind !== 'table' || patch.kind !== 'table') return false
  if (view.autoRefreshMs === undefined) return false
  if (view.cursorToken === undefined) return false
  if (collectionBrowseStyle(view.ref).offsetPaging) return false
  // Any field at all makes this something other than "give me the next page".
  return (
    patch.ref === undefined
    && patch.filter === undefined
    && patch.sort === undefined
    && patch.offset === undefined
    && patch.limit === undefined
    && patch.autoRefreshMs === undefined
    && patch.title === undefined
  )
}

/**
 * Apply an incremental patch by kind (the caller has already checked that the
 * kind matches the view). Returns whether any field that affects fetching changed.
 */
function applyViewPatch(view: Draft<ViewState>, patch: ViewPatch): boolean {
  if (patch.title !== undefined) view.title = patch.title
  // Auto-refresh is a property *of* the view, like its title, rather than of what
  // it shows — so it is written for every kind that can carry it, before the
  // per-kind switch, and it deliberately does not count as affecting the fetch:
  // switching the timer on does not mean "and fetch right now". The button next
  // to it means that.
  if ('autoRefreshMs' in patch && patch.autoRefreshMs !== undefined) {
    setAutoRefreshOn(view, patch.autoRefreshMs)
  }

  switch (patch.kind) {
    case 'table': {
      if (view.kind !== 'table') return false
      let affects = false
      let invalidatesCursor = false
      if (patch.ref) {
        view.ref = patch.ref
        affects = true
        invalidatesCursor = true
      }
      if (patch.filter) {
        view.filter = patch.filter
        affects = true
        invalidatesCursor = true
      }
      if (patch.sort) {
        view.sort = patch.sort
        affects = true
        invalidatesCursor = true
      }
      if (patch.offset !== undefined) {
        view.page.offset = patch.offset
        affects = true
        invalidatesCursor = true
      }
      if (patch.limit !== undefined) {
        view.page.limit = patch.limit
        affects = true
      }
      // The fetch conditions changed, so the old continuation cursor (redis SCAN
      // cursor / qdrant scroll) has to be invalidated.
      if (invalidatesCursor) delete view.cursorToken
      return affects
    }

    case 'query': {
      if (view.kind !== 'query') return false
      if (patch.text !== undefined) view.text = patch.text
      return false
    }

    case 'inspector': {
      if (view.kind !== 'inspector') return false
      if (patch.ref) view.ref = patch.ref
      return false
    }

    case 'tree': {
      if (view.kind !== 'tree') return false
      if (patch.expanded) view.expanded = patch.expanded
      if (patch.selected !== undefined) {
        if (patch.selected === null) delete view.selected
        else view.selected = patch.selected
      }
      return false
    }

    case 'vector': {
      if (view.kind !== 'vector') return false
      let affects = false
      if (patch.collection !== undefined) {
        view.collection = patch.collection
        affects = true
        // A different collection invalidates both the point reference and the
        // named vector: neither means anything in the new collection, and
        // carrying them over produces a confident search against nonsense.
        delete view.queryPointId
        delete view.vectorName
      }
      // The two query entry points are mutually exclusive (see VectorViewState):
      // writing one clears the other, so the view can never plan a search the
      // driver is contractually obliged to reject.
      if (patch.queryVec) {
        view.queryVec = patch.queryVec
        delete view.queryPointId
        affects = true
      }
      if (patch.queryPointId !== undefined) {
        view.queryPointId = patch.queryPointId
        delete view.queryVec
        affects = true
      }
      if (patch.queryText !== undefined) view.queryText = patch.queryText
      if (patch.vectorName !== undefined) {
        // null is "use the collection's default vector again", which is a
        // different request from leaving the field alone.
        if (patch.vectorName === null) delete view.vectorName
        else view.vectorName = patch.vectorName
        affects = true
      }
      if (patch.topK !== undefined) {
        view.topK = patch.topK
        affects = true
      }
      if (patch.scoreThreshold !== undefined) {
        if (patch.scoreThreshold === null) delete view.scoreThreshold
        else view.scoreThreshold = patch.scoreThreshold
        affects = true
      }
      if (patch.filter) {
        view.filter = patch.filter
        affects = true
      }
      return affects
    }

    /**
     * A chat has nothing patchable but its title, which `applyViewPatch` has
     * already written above. Every other field is either the agent's
     * (`agentSessionId`, `agentStatus`, `usage` — written by the stream, never by
     * a caller) or a transition with a side effect `view.update` cannot carry:
     * `chat.setMode` has to reach `session/set_mode`, `chat.respondPermission` has
     * to unblock a waiting JSON-RPC request.
     */
    case 'chat':
      return false

    /**
     * A package view's state is merged key by key, and every merge counts as
     * affecting the fetch.
     *
     * **Merged, not replaced**, for the same reason every built-in patch above is
     * a bag of per-field optionals: `{offset: 40}` has to move the page without
     * clearing the filter, and a caller forced to resend the whole state to
     * change one field would race with the user changing another.
     *
     * **`null` deletes.** A patch cannot express "remove this key" any other way,
     * and the built-in patches already use `null` for exactly that (the vector
     * view's `vectorName` and `scoreThreshold`).
     *
     * **`affects` is unconditionally true when anything changed**, unlike the
     * built-ins which know which of their fields feed a fetch. The kernel does
     * not know which of a package's keys matter, and the two possible mistakes are
     * not symmetric: over-fetching costs a redundant scan, under-fetching leaves
     * a view showing stale rows with nothing on screen to say so. The
     * registration's `autoFetch` is what decides whether that turns into a real
     * request — returning `null` there makes this free.
     */
    case 'package': {
      if (view.kind !== 'package') return false
      const next = mergePackageState(view.state, patch.state)
      if (next === null) return false
      view.state = next
      return true
    }
  }
}

/**
 * Apply a package view's state patch, or null when nothing changed.
 *
 * Extracted from the `case` above because `prepare` runs it too: the package is
 * asked about the state this merge is going to produce, so the two have to be
 * the same merge. Two implementations would disagree the first time one of the
 * rules below was refined, and the symptom would be a package answering about a
 * state that never existed.
 *
 * Null for "nothing changed" rather than a fresh copy, so the caller can tell a
 * no-op patch from one that rewrote every key — `applyViewPatch` reports that as
 * `affects`, and `prepare` uses it to keep the state it already has.
 */
function mergePackageState(
  state: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
  if (patch === undefined) return null
  const next: Record<string, unknown> = { ...state }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in next) {
        delete next[key]
        changed = true
      }
      continue
    }
    if (next[key] !== value) changed = true
    next[key] = value
  }
  return changed ? next : null
}
