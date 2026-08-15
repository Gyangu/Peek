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
  type ResultId,
  type ViewId,
} from '@peek/core'
import { failResult, finishResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { ResultDeadlines, type DeadlineTimerApi, type TimerId } from '../../connections/deadline'
import {
  DEFAULT_EXECUTION_TIMEOUTS,
  DEFAULT_TIMEOUTS,
  clearConnectionTimeouts,
  getTimeoutSettings,
  resetTimeoutSettings,
  resolveExecutionTimeout,
  setConnectionTimeouts,
  setTimeoutSettings,
} from '../../connections/timeouts'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import { CommandFailure } from '../failure'
import type { CommandDeps } from '../deps'

/* ==================================================================
 * M6 — cancellation and timeouts, end to end.
 *
 * Three separate guarantees are pinned here, because they failed separately:
 *
 *   1. every fetch runs under a deadline, the deadline is configurable, and
 *      expiring it stops the work rather than just complaining about it;
 *   2. `query.cancel` is reachable and honest about what it did;
 *   3. **a fetch that is refused does not take the previous page of data with
 *      it** — the regression this file exists for. Before the fix, a filter
 *      typo or a dropped connection replaced a screen of rows with an error bar
 *      over an empty grid.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** Make the next runQuery / scan effect reject with this error. */
  failNext(error: unknown): void
  cancelCalls: ResultId[]
  queryTimeouts: (number | undefined)[]
}

function harness(): Harness {
  let pending: unknown = null
  const cancelCalls: ResultId[] = []
  const queryTimeouts: (number | undefined)[] = []

  const takeFailure = (): void => {
    if (pending === null) return
    const err = pending
    pending = null
    throw err
  }

  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: PG_CAPS, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery(req) {
        queryTimeouts.push(req.timeoutMs)
        takeFailure()
      },
      async scanCollection() {
        takeFailure()
      },
      async vectorSearch() {
        takeFailure()
      },
      async cancel(req) {
        cancelCalls.push(req.resultId)
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
    cancelCalls,
    queryTimeouts,
  }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function runQuery(
  h: Harness,
  input: Record<string, unknown>,
): Promise<{ resultId: ResultId; viewId: ViewId; ok: boolean }> {
  const res = await h.bus.dispatch('query.run', input, 'ui')
  if (!res.ok) return { resultId: '' as ResultId, viewId: '' as ViewId, ok: false }
  return { resultId: res.data.resultId, viewId: res.data.viewId, ok: true }
}

/* ================================================================== */
/* 1. The deadline itself                                              */
/* ================================================================== */

/** A timer table under the test's control: nothing here ever waits. */
function fakeTimers(): DeadlineTimerApi & { fire(id: number): void; live: number } {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    set(cb) {
      const id = next
      next += 1
      pending.set(id, cb)
      return id as unknown as TimerId
    },
    clear(id) {
      pending.delete(id as unknown as number)
    },
    fire(id) {
      const cb = pending.get(id)
      pending.delete(id)
      cb?.()
    },
    get live() {
      return pending.size
    },
  }
}

describe('ResultDeadlines', () => {
  it('arms, fires once, and reports the budget it fired on', () => {
    const timers = fakeTimers()
    const deadlines = new ResultDeadlines(timers)
    const fired: number[] = []

    deadlines.arm('res_1', 5_000, (ms) => fired.push(ms))
    assert.equal(deadlines.has('res_1'), true)
    assert.equal(deadlines.budgetOf('res_1'), 5_000)

    timers.fire(1)
    assert.deepEqual(fired, [5_000])
    // The entry is dropped *before* the callback runs, so a callback that cancels
    // the result cannot re-enter and clear a deadline that has already fired.
    assert.equal(deadlines.has('res_1'), false)
    assert.equal(deadlines.size, 0)
  })

  it('a settled result disarms: clearing prevents the callback entirely', () => {
    const timers = fakeTimers()
    const deadlines = new ResultDeadlines(timers)
    let fired = 0
    deadlines.arm('res_1', 5_000, () => {
      fired += 1
    })
    deadlines.clear('res_1')
    timers.fire(1)
    assert.equal(fired, 0, 'a result that finished on time must never be reported as timed out')
    assert.equal(timers.live, 0, 'the timer is released, not merely ignored')
  })

  it('re-arming the same result replaces the old timer instead of stacking a second one', () => {
    const timers = fakeTimers()
    const deadlines = new ResultDeadlines(timers)
    const fired: number[] = []
    deadlines.arm('res_1', 1_000, (ms) => fired.push(ms))
    deadlines.arm('res_1', 9_000, (ms) => fired.push(ms))
    assert.equal(timers.live, 1)
    timers.fire(2)
    assert.deepEqual(fired, [9_000])
  })

  it('no budget means no timer — callers can pass an unset timeout straight through', () => {
    const timers = fakeTimers()
    const deadlines = new ResultDeadlines(timers)
    deadlines.arm('a', undefined, () => assert.fail('must not fire'))
    deadlines.arm('b', 0, () => assert.fail('must not fire'))
    deadlines.arm('c', -1, () => assert.fail('must not fire'))
    assert.equal(deadlines.size, 0)
    assert.equal(timers.live, 0)
  })

  it('clearAll releases every timer (connection closed, process exited, shutdown)', () => {
    const timers = fakeTimers()
    const deadlines = new ResultDeadlines(timers)
    deadlines.arm('a', 1_000, () => assert.fail('must not fire'))
    deadlines.arm('b', 1_000, () => assert.fail('must not fire'))
    deadlines.clearAll()
    assert.equal(timers.live, 0)
    assert.equal(deadlines.size, 0)
  })
})

/* ================================================================== */
/* 2. Where the deadline's number comes from                           */
/* ================================================================== */

describe('timeout settings', () => {
  it('ships defaults for both families, and every fetch kind has a budget', () => {
    resetTimeoutSettings()
    const settings = getTimeoutSettings()
    assert.equal(settings.connectMs, DEFAULT_TIMEOUTS.connectMs)
    assert.equal(settings.queryMs, DEFAULT_EXECUTION_TIMEOUTS.queryMs)
    // The point of M6 item 1: nothing runs unbounded just because nobody typed a number.
    assert.ok(resolveExecutionTimeout('conn_x', 'query')! > 0)
    assert.ok(resolveExecutionTimeout('conn_x', 'scan')! > 0)
    assert.ok(resolveExecutionTimeout('conn_x', 'vectorSearch')! > 0)
  })

  it('the caller wins, then the connection override, then the global default', () => {
    resetTimeoutSettings()
    setTimeoutSettings({ queryMs: 30_000 })
    assert.equal(resolveExecutionTimeout('conn_a', 'query'), 30_000)

    setConnectionTimeouts('conn_a', { queryMs: 90_000 })
    assert.equal(resolveExecutionTimeout('conn_a', 'query'), 90_000)
    assert.equal(resolveExecutionTimeout('conn_b', 'query'), 30_000, 'the override is per connection')

    assert.equal(resolveExecutionTimeout('conn_a', 'query', 1_234), 1_234, "the caller's own budget wins")

    clearConnectionTimeouts('conn_a')
    assert.equal(resolveExecutionTimeout('conn_a', 'query'), 30_000)
    resetTimeoutSettings()
  })

  it('0 means "no deadline", from either the settings or the caller', () => {
    resetTimeoutSettings()
    setTimeoutSettings({ scanMs: 0 })
    assert.equal(resolveExecutionTimeout('conn_a', 'scan'), undefined)
    resetTimeoutSettings()
    assert.equal(resolveExecutionTimeout('conn_a', 'scan', 0), undefined)
  })

  it('rejects nonsense without dropping the settings that were already good', () => {
    resetTimeoutSettings()
    const applied = setTimeoutSettings({
      queryMs: 45_000,
      connectMs: Number.NaN,
      rpcMs: -5,
      cancelMs: 0, // a stage timeout may not be switched off
    })
    assert.equal(applied.queryMs, 45_000, 'the valid entry landed')
    assert.equal(applied.connectMs, DEFAULT_TIMEOUTS.connectMs)
    assert.equal(applied.rpcMs, DEFAULT_TIMEOUTS.rpcMs)
    assert.equal(applied.cancelMs, DEFAULT_TIMEOUTS.cancelMs)
    resetTimeoutSettings()
  })

  it('the read accessor hands out a copy — a settings screen cannot mutate the source', () => {
    resetTimeoutSettings()
    const a = getTimeoutSettings() as { queryMs: number }
    a.queryMs = 1
    assert.equal(getTimeoutSettings().queryMs, DEFAULT_EXECUTION_TIMEOUTS.queryMs)
  })
})

/* ================================================================== */
/* 3. query.cancel through the bus                                     */
/* ================================================================== */

describe('query.cancel', () => {
  it('cancels a running result and reports it honestly', async () => {
    const h = harness()
    const connId = await connect(h)
    const { resultId, viewId } = await runQuery(h, { connId, text: 'select 1' })

    const res = await h.bus.dispatch('query.cancel', { viewId }, 'mcp')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.equal(res.data.resultId, resultId)
    assert.equal(res.data.cancelled, true)
    assert.deepEqual(h.cancelCalls, [resultId])

    const state = h.store.getState()
    assert.equal(state.results[resultId].status, 'cancelled')
    // A cancel is not a failure: no red bar, and the rows that arrived stay.
    assert.equal(state.views[viewId].status, 'idle')
    assert.equal(state.views[viewId].error, undefined)
  })

  it('a result that already finished reports cancelled=false and is left alone', async () => {
    const h = harness()
    const connId = await connect(h)
    const { resultId, viewId } = await runQuery(h, { connId, text: 'select 1' })
    h.store.apply(
      (draft) => {
        finishResult(draft, resultId, { rows: 3, elapsedMs: 1 })
      },
      { source: 'system' },
    )

    const res = await h.bus.dispatch('query.cancel', { viewId }, 'mcp')
    assert.equal(res.ok, true)
    if (!res.ok) throw new Error('unreachable')
    assert.equal(res.data.cancelled, false)
    assert.deepEqual(h.cancelCalls, [], 'the driver is not disturbed for work that is over')
    assert.equal(h.store.getState().results[resultId].status, 'done')
  })
})

/* ================================================================== */
/* 4. REGRESSION — a refused fetch must not blank the grid             */
/* ================================================================== */

describe('a rejected fetch falls back to the previous result', () => {
  it('keeps the last good result on screen and shows the error over it', async () => {
    const h = harness()
    const connId = await connect(h)

    // A first query that really did produce rows.
    const first = await runQuery(h, { connId, text: 'select * from orders' })
    h.store.apply(
      (draft) => {
        finishResult(draft, first.resultId, { rows: 500, elapsedMs: 12 })
      },
      { source: 'system' },
    )

    // A second run in the same view, refused by the driver before a single frame.
    h.failNext(new CommandFailure(peekError('QUERY_FAILED', 'relation "odrers" does not exist')))
    const second = await h.bus.dispatch(
      'query.run',
      { viewId: first.viewId, text: 'select * from odrers' },
      'ui',
    )
    assert.equal(second.ok, false, 'the command itself fails — that part was never in doubt')

    const state = h.store.getState()
    const view = state.views[first.viewId]
    assert.ok(view.kind === 'query')

    // The regression: this used to be the *failed* result id, so the grid had
    // nothing to render and 500 rows of perfectly good data vanished because a
    // table name was misspelled.
    assert.equal(view.resultId, first.resultId, 'the view is back on the last result that has rows')
    assert.equal(state.results[first.resultId].status, 'done')
    assert.equal(state.results[first.resultId].rows, 500)

    // The error is still reported — it is layered over the data, not instead of it.
    assert.equal(view.status, 'error')
    assert.equal(view.error?.code, 'QUERY_FAILED')
  })

  it('with nothing worth falling back to, the view stays on the failed result', async () => {
    const h = harness()
    const connId = await connect(h)

    h.failNext(new CommandFailure(peekError('CONNECTION_LOST', 'socket hang up')))
    const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
    assert.equal(res.ok, false)

    const state = h.store.getState()
    const view = Object.values(state.views).find((v) => v.kind === 'query')
    assert.ok(view && view.kind === 'query')
    // There is no older result, so there is nothing to restore. What matters is
    // that the view is in error rather than stuck loading.
    assert.equal(view.status, 'error')
    assert.equal(view.error?.code, 'CONNECTION_LOST')
  })

  it('does not fall back onto an older failure — one empty grid is not repaired by an older empty grid', async () => {
    const h = harness()
    const connId = await connect(h)

    const first = await runQuery(h, { connId, text: 'select 1' })
    h.store.apply(
      (draft) => {
        failResult(draft, first.resultId, peekError('QUERY_FAILED', 'boom'))
      },
      { source: 'system' },
    )

    h.failNext(new CommandFailure(peekError('QUERY_FAILED', 'boom again')))
    await h.bus.dispatch('query.run', { viewId: first.viewId, text: 'select 2' }, 'ui')

    const view = h.store.getState().views[first.viewId]
    assert.ok(view.kind === 'query')
    assert.notEqual(view.resultId, first.resultId, 'an errored result holds no rows to go back to')
    assert.equal(view.error?.message, 'boom again')
  })

  it('a cancelled result is a valid fallback: its rows are real', async () => {
    const h = harness()
    const connId = await connect(h)

    const first = await runQuery(h, { connId, text: 'select * from big' })
    // Rows arrived, then the user pressed Cancel — core is explicit that those
    // rows stay usable (hasUsableRows('cancelled') === true).
    h.store.apply(
      (draft) => {
        const meta = draft.results[first.resultId]
        meta.rows = 40_000
        meta.status = 'cancelled'
      },
      { source: 'system' },
    )

    h.failNext(new CommandFailure(peekError('SYNTAX_ERROR', 'syntax error at or near "slect"')))
    await h.bus.dispatch('query.run', { viewId: first.viewId, text: 'slect 1' }, 'ui')

    const view = h.store.getState().views[first.viewId]
    assert.ok(view.kind === 'query')
    assert.equal(view.resultId, first.resultId)
    assert.equal(view.error?.code, 'SYNTAX_ERROR')
  })

  it('the same protection covers a refused collection scan, not just queries', async () => {
    const h = harness()
    const connId = await connect(h)

    const opened = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'orders' } } },
      'ui',
    )
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')
    const viewId = opened.data.viewId
    const firstResultId = opened.data.resultId
    assert.ok(firstResultId !== undefined, 'opening a table starts a scan')
    h.store.apply(
      (draft) => {
        finishResult(draft, firstResultId, { rows: 200, elapsedMs: 4 })
      },
      { source: 'system' },
    )

    // Paging forward, and the driver refuses.
    h.failNext(new CommandFailure(peekError('CONNECTION_LOST', 'the driver process has exited')))
    await h.bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'table', offset: 200 }, refresh: true },
      'ui',
    )

    const view = h.store.getState().views[viewId]
    assert.ok(view.kind === 'table')
    assert.equal(view.resultId, firstResultId, 'page one is still on screen')
    assert.equal(view.error?.code, 'CONNECTION_LOST')
  })
})
