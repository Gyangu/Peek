import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  asPanelId,
  createEmptyWorkspace,
  peekError,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
  type ViewId,
} from '@peek/core'
import { finishResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import { CommandFailure } from '../failure'
import type { CommandDeps } from '../deps'

/* ==================================================================
 * A refused fetch must roll back the *whole* request, not half of it.
 *
 * `cancel-and-timeout.test.ts` pins the first half: a rejected fetch puts the
 * previous result id back, so a filter typo does not blank a screen of rows.
 * This file pins the half that was missing.
 *
 * `view.update` writes the new sort / filter / page into the view during the
 * pure state phase, before the driver has agreed to anything. When the driver
 * then refuses, restoring only `resultId` left the two halves of the view
 * describing different requests: the column header drew a sort arrow and the
 * pager showed the new offset, over rows fetched under the *old* conditions. The
 * view was describing a request the server had rejected — which is worse than
 * the empty grid it replaced, because an empty grid with an error bar is at
 * least honest about having nothing.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const CAPS: Capability[] = [
  'introspect',
  'tabularQuery',
  'collectionScan',
  'vectorSearch',
  'valuePeek',
  'cancel',
]

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** Make the next fetch effect reject with this error. */
  failNext(error: unknown): void
}

function harness(): Harness {
  let pending: unknown = null
  const takeFailure = (): void => {
    if (pending === null) return
    const err = pending
    pending = null
    throw err
  }

  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: CAPS, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery() {
        takeFailure()
      },
      async scanCollection() {
        takeFailure()
      },
      async vectorSearch() {
        takeFailure()
      },
      async cancel() {
        return true
      },
    },
  }

  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return {
    bus,
    store,
    failNext(error) {
      pending = error
    },
  }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

/** Open a table view and let its first scan land with rows on screen. */
async function openTableWithRows(h: Harness, connId: ConnId): Promise<{ viewId: ViewId; resultId: string }> {
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'orders' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) throw new Error('unreachable')
  const resultId = opened.data.resultId
  assert.ok(resultId !== undefined, 'opening a table starts a scan')
  h.store.apply(
    (draft) => {
      finishResult(draft, resultId, { rows: 200, elapsedMs: 4 })
    },
    { source: 'system' },
  )
  return { viewId: opened.data.viewId, resultId }
}

describe('a rejected fetch rolls the view back to the request that produced its rows', () => {
  it('a refused sort leaves no sort arrow over rows fetched unsorted', async () => {
    const h = harness()
    const connId = await connect(h)
    const { viewId, resultId } = await openTableWithRows(h, connId)

    h.failNext(
      new CommandFailure(
        peekError('BAD_REQUEST', 'Cannot order by total: this collection cannot be ordered'),
      ),
    )
    const res = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', sort: [{ column: 'total', dir: 'desc' }] } },
      'ui',
    )
    assert.equal(res.ok, false, 'the command itself fails — that part was never in doubt')

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'table')
    assert.equal(view.resultId, resultId, 'the rows that arrived are still on screen')
    // The regression: this used to still be the refused sort, so the header drew
    // a descending arrow over rows the server had returned in table order.
    assert.equal(view.sort, undefined, 'the toolbar describes the request that produced these rows')
    assert.equal(view.error?.code, 'BAD_REQUEST', 'the error is still reported, layered over the data')
  })

  it('a refused page leaves the pager on the page that is actually shown', async () => {
    const h = harness()
    const connId = await connect(h)
    const { viewId, resultId } = await openTableWithRows(h, connId)

    h.failNext(new CommandFailure(peekError('CONNECTION_LOST', 'the driver process has exited')))
    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', offset: 200 } }, 'ui')

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'table')
    assert.equal(view.resultId, resultId)
    assert.equal(view.page.offset, 0, 'page one is on screen, so the pager says page one')
  })

  it('a refused filter does not leave a filter chip describing rows that were never filtered', async () => {
    const h = harness()
    const connId = await connect(h)
    const { viewId, resultId } = await openTableWithRows(h, connId)

    h.failNext(new CommandFailure(peekError('BAD_REQUEST', 'unknown column "totl"')))
    await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', filter: [{ column: 'totl', op: 'eq', value: 1 }] } },
      'ui',
    )

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'table')
    assert.equal(view.resultId, resultId)
    assert.equal(view.filter, undefined)
  })

  it('an accepted change is not rolled back — only the refused one is', async () => {
    const h = harness()
    const connId = await connect(h)
    const { viewId } = await openTableWithRows(h, connId)

    const ok = await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', sort: [{ column: 'id', dir: 'asc' }], offset: 400 } },
      'ui',
    )
    assert.equal(ok.ok, true)
    if (!ok.ok) throw new Error('unreachable')
    const secondResultId = ok.data.resultId
    assert.ok(secondResultId !== undefined)
    h.store.apply(
      (draft) => {
        finishResult(draft, secondResultId, { rows: 200, elapsedMs: 5 })
      },
      { source: 'system' },
    )

    // A third request is refused; the view must fall back to the *second*
    // request's parameters, not all the way to the first.
    h.failNext(new CommandFailure(peekError('BAD_REQUEST', 'nope')))
    await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', sort: [{ column: 'total', dir: 'desc' }], offset: 800 } },
      'ui',
    )

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'table')
    assert.equal(view.resultId, secondResultId)
    assert.deepEqual(view.sort, [{ column: 'id', dir: 'asc' }])
    assert.equal(view.page.offset, 400)
  })

  it('the same protection covers a vector search', async () => {
    const h = harness()
    const connId = await connect(h)

    const opened = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'vector', connId, collection: 'docs', queryVec: [0.1, 0.2], topK: 10 } },
      'ui',
    )
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')
    const viewId = opened.data.viewId
    const resultId = opened.data.resultId
    assert.ok(resultId !== undefined, 'a vector view with a query vector searches on open')
    h.store.apply(
      (draft) => {
        finishResult(draft, resultId, { rows: 10, elapsedMs: 3 })
      },
      { source: 'system' },
    )

    h.failNext(new CommandFailure(peekError('BAD_REQUEST', 'topK exceeds the collection limit')))
    await h.bus.dispatch('view.update', { viewId, patch: { kind: 'vector', topK: 5_000 } }, 'ui')

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'vector')
    assert.equal(view.resultId, resultId)
    assert.equal(view.topK, 10, 'the control says 10 because 10 is what these matches came from')
  })

  it('a query view keeps the statement the user typed, refused or not', async () => {
    const h = harness()
    const connId = await connect(h)

    const first = await h.bus.dispatch('query.run', { connId, text: 'select * from orders' }, 'ui')
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('unreachable')
    h.store.apply(
      (draft) => {
        finishResult(draft, first.data.resultId, { rows: 500, elapsedMs: 12 })
      },
      { source: 'system' },
    )

    h.failNext(new CommandFailure(peekError('SYNTAX_ERROR', 'syntax error at or near "slect"')))
    await h.bus.dispatch('query.run', { viewId: first.data.viewId, text: 'slect 1' }, 'ui')

    const view = h.store.getState().views[first.data.viewId]
    assert.ok(view.kind === 'query')
    // Rolling this back would rewrite the editor under the user's cursor. The
    // rows go back; the statement they typed is theirs to fix.
    assert.equal(view.text, 'slect 1')
    assert.equal(view.resultId, first.data.resultId, 'the previous rows are still on screen')
  })
})
