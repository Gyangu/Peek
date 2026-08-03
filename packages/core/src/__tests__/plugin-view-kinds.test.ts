import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUILTIN_VIEW_KINDS,
  VIEW_KINDS,
  createEmptyWorkspace,
  describeView,
  displayViewKind,
  isBuiltinViewKind,
  snapshotWorkspace,
  validateViewKindRegistration,
  viewTitle,
  type ConnId,
  type PanelId,
  type PluginViewState,
  type TableViewState,
  type ViewId,
  type ViewState,
  type ViewSummary,
  type Workspace,
  type ViewKind,
  type ViewKindLookup,
  type ViewKindRegistration,
} from '../index'

/* ==================================================================
 * The seventh member of the ViewState union.
 *
 * `view-kinds.ts` argues that a plugin kind can be added **without** giving up
 * the compile-time exhaustiveness the six built-ins have, by growing the union
 * by one member with a literal discriminant rather than replacing it with a
 * registry. These tests pin the runtime half of that claim; the compile-time
 * half is pinned by the code failing to build, which is not something a test can
 * assert and is the reason `_exhaustive` below exists as a type-level check.
 *
 * Nothing here connects to anything: view state is data.
 * ================================================================== */

const CONN = 'conn_test' as ConnId

function pluginView(over: Partial<PluginViewState> = {}): PluginViewState {
  return {
    id: 'view_1' as ViewId,
    kind: 'plugin',
    pluginKind: 'documents',
    connId: CONN,
    status: 'ready',
    state: { collection: 'orders' },
    ...over,
  }
}

/** A complete registration, so each test can remove exactly the field it is about. */
function registration(over: Partial<ViewKindRegistration> = {}): ViewKindRegistration {
  return {
    kind: 'documents',
    driverIds: ['postgres'],
    describe: (v) => `Documents in ${String(v.state['collection'])}`,
    title: (v) => String(v.state['collection']),
    titleKey: 'view.kind.documents',
    autoFetch: () => null,
    collectionRef: () => null,
    ...over,
  }
}

const lookupFor = (reg: ViewKindRegistration): ViewKindLookup => (k) => (k === reg.kind ? reg : null)

describe('the plugin view kind is a real member of the union', () => {
  it('the discriminant stays a closed set of literals, and covers every built-in', () => {
    // The property that keeps every `switch (view.kind)` exhaustive. If a
    // built-in is ever added without extending VIEW_KINDS, this fails — the two
    // lists are hand-written precisely so that they can disagree and be caught.
    assert.deepEqual([...VIEW_KINDS].sort(), [...BUILTIN_VIEW_KINDS, 'plugin'].sort())
    for (const kind of BUILTIN_VIEW_KINDS) {
      assert.equal(isBuiltinViewKind(kind), true, `${kind} must read as built-in`)
    }
    assert.equal(isBuiltinViewKind('plugin'), false, "'plugin' is the kernel's own escape member, not a built-in")
    assert.equal(isBuiltinViewKind('documents'), false, 'a plugin kind is not a built-in')
  })

  it('a built-in view still narrows to its exact type — the reason the discriminant is a literal', () => {
    // The first attempt made PluginViewState.kind a branded string. It compiled
    // and silently stopped `case 'table':` from narrowing, because a
    // string-based discriminant is not a discriminant. This asserts the fix at
    // runtime; the compile-time proof is that `table.ref` below type-checks.
    const table: TableViewState = {
      id: 'view_t' as ViewId,
      kind: 'table',
      connId: CONN,
      status: 'ready',
      ref: { kind: 'relation', schema: 'public', name: 'orders' },
      page: { offset: 0, limit: 100 },
    }
    assert.equal(describeView(table), 'Table public.orders · offset 0 limit 100')
    assert.equal(viewTitle(table), 'public.orders')
  })
})

describe('describeView / viewTitle route a plugin view through its registration', () => {
  it('uses the plugin’s own text when the kind is registered', () => {
    const lookup = lookupFor(registration())
    assert.equal(describeView(pluginView(), lookup), 'Documents in orders')
    assert.equal(viewTitle(pluginView(), lookup), 'orders')
  })

  it('an explicit title still wins, exactly as it does for a built-in', () => {
    assert.equal(viewTitle(pluginView({ title: 'Pinned' }), lookupFor(registration())), 'Pinned')
  })

  it('names the kind when no plugin can speak for it, rather than going blank', () => {
    // A view outliving its plugin is an ordinary state — the workspace is
    // restored, the plugin was uninstalled. Both readers need to tell that apart
    // from an empty view: a model reading read_workspace has to know a pane it
    // cannot interpret is there, and a person has to work out what to reinstall.
    const text = describeView(pluginView())
    assert.match(text, /documents/, 'the kind must be named')
    assert.match(text, /no plugin loaded/i, 'and the reason must be stated')

    // No lookup at all and a lookup that misses must agree: both mean "nobody
    // can speak for this view".
    assert.equal(describeView(pluginView()), describeView(pluginView(), () => null))
    assert.equal(viewTitle(pluginView()), 'documents')
  })

  it('a lookup for a different kind does not answer for this one', () => {
    const lookup = lookupFor(registration({ kind: 'graph' }))
    assert.match(describeView(pluginView(), lookup), /no plugin loaded/i)
  })
})

describe('displayViewKind reports what a reader needs, not the discriminant', () => {
  it('a plugin view reports its own kind, so MCP can tell two of them apart', () => {
    // Every plugin view has kind === 'plugin'. Reporting that over MCP would
    // make six different plugin views indistinguishable in the one place they
    // most need telling apart.
    assert.equal(displayViewKind(pluginView()), 'documents')
    assert.equal(displayViewKind(pluginView({ pluginKind: 'graph' })), 'graph')
  })

  it('a built-in reports its kind unchanged', () => {
    const table: TableViewState = {
      id: 'view_t' as ViewId,
      kind: 'table',
      connId: CONN,
      status: 'ready',
      ref: { kind: 'relation', schema: '', name: 't' },
      page: { offset: 0, limit: 10 },
    }
    assert.equal(displayViewKind(table), 'table')
  })

  it('also answers for a ViewSummary, which is the side that was silently getting it wrong', () => {
    // The function shipped taking `ViewState` only, so `snapshotWorkspace` — on
    // the other side of the boundary, holding `ViewSummary` — could not call it
    // and wrote `kind: v.kind` instead. The result was that every plugin view on
    // the MCP wire said `plugin`, which is the exact failure this function's own
    // comment exists to prevent, live, with the fix sitting unused next to it.
    // Structural typing is what lets one implementation serve both.
    const summary: ViewSummary = {
      id: 'view_s' as ViewId,
      kind: 'plugin',
      pluginKind: 'graph',
      connId: CONN,
      panelId: null,
      tabIndex: -1,
      visible: false,
      title: 'Graph',
      status: 'ready',
      describe: 'Neo4j graph',
    }
    assert.equal(displayViewKind(summary), 'graph')
    assert.equal(displayViewKind({ ...summary, kind: 'table', pluginKind: undefined }), 'table')
  })
})

describe('a plugin view carries its own kind through the snapshot', () => {
  function workspaceWith(view: ViewState): Workspace {
    const ws = createEmptyWorkspace('panel_1' as PanelId)
    return { ...ws, views: { [view.id]: view } }
  }

  it('reports pluginKind beside kind, so a tool can name the view it wants', () => {
    const snap = snapshotWorkspace(workspaceWith(pluginView({ pluginKind: 'graph' })))
    const [summary] = snap.views
    assert.equal(summary?.kind, 'plugin', 'the discriminant is still the literal — every switch depends on it')
    assert.equal(summary?.pluginKind, 'graph')
  })

  it('omits it entirely for a built-in, rather than sending undefined', () => {
    // Same shape as `browse` and `chat`: present exactly when the kind says so.
    // A key holding `undefined` survives JSON.stringify as an absent key here but
    // not everywhere, and a reader that does `'pluginKind' in view` would be
    // answered wrongly.
    const table: TableViewState = {
      id: 'view_t' as ViewId,
      kind: 'table',
      connId: CONN,
      status: 'ready',
      ref: { kind: 'relation', schema: '', name: 't' },
      page: { offset: 0, limit: 10 },
    }
    const [summary] = snapshotWorkspace(workspaceWith(table)).views
    assert.ok(summary !== undefined)
    assert.equal('pluginKind' in summary, false)
  })
})

describe('a registration is refused unless it is total', () => {
  it('accepts a complete one', () => {
    assert.equal(validateViewKindRegistration(registration()), null)
  })

  /**
   * The compensation for the exhaustiveness a plugin kind cannot have.
   *
   * Each of these fields answers a call site that used to be a `case`. Two of
   * them are the ones that degraded *silently* before this change — `autoFetch`
   * (a view that opened and never fetched) and `titleKey` (the raw message key
   * painted into the tab strip) — so a registration that omits them has to be
   * refused rather than defaulted.
   */
  it('names every field a call site depends on, one at a time', () => {
    for (const field of ['driverIds', 'describe', 'title', 'titleKey', 'autoFetch', 'collectionRef'] as const) {
      const partial = registration()
      delete (partial as unknown as Record<string, unknown>)[field]
      const problem = validateViewKindRegistration(partial)
      assert.ok(problem, `${field} missing must be refused`)
      assert.deepEqual(problem.missing, [field], `the report must name ${field} and nothing else`)
      assert.equal(problem.kind, 'documents', 'and say which kind it was')
    }
  })

  it('reports every missing field at once, not just the first', () => {
    const problem = validateViewKindRegistration({ kind: 'bare' })
    assert.ok(problem)
    assert.deepEqual(problem.missing, [
      'driverIds',
      'describe',
      'title',
      'titleKey',
      'autoFetch',
      'collectionRef',
    ])
  })

  it('refuses a non-object and a nameless kind without throwing', () => {
    // The loader is walking several plugins; a bad one has to become a report,
    // not an exception that stops the rest from loading.
    assert.ok(validateViewKindRegistration(null))
    assert.ok(validateViewKindRegistration('nope'))
    assert.equal(validateViewKindRegistration({})?.kind, '(no kind)')
    assert.ok(validateViewKindRegistration(registration({ kind: '' }))?.missing.includes('kind'))
  })

  it('refuses an empty driver list, which is a kind nothing can ever offer', () => {
    // Not a pedantic check: `driverIds` is what the connection menu filters on,
    // so an empty list registers a view kind that no connection offers and no
    // user can reach — indistinguishable from the plugin having failed to load.
    const problem = validateViewKindRegistration(registration({ driverIds: [] }))
    assert.deepEqual(problem?.missing, ['driverIds'])
  })
})

/**
 * Compile-time, not runtime: `VIEW_KINDS` must stay in step with the union.
 *
 * A built-in added to `ViewState` without being added to `VIEW_KINDS` makes this
 * assignment fail, which is the half of the guarantee the assertions above
 * cannot reach.
 */
const _exhaustive: readonly ViewKind[] = VIEW_KINDS
void _exhaustive
