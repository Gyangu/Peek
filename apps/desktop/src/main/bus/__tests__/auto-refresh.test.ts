import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  asPanelId,
  createEmptyWorkspace,
  isRefreshableViewKind,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
  type RefreshableView,
  type ResultId,
  type ViewId,
} from '@peek/core'
import { createAutoRefreshScheduler, AUTO_REFRESH_ERROR_LIMIT } from '../../auto-refresh'
import { failResult, finishResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'

/* ==================================================================
 * Auto-refresh: the timer that presses ⟳ for you.
 *
 * Everything here runs on a hand-cranked clock. Real timers would make the
 * suite slow *and* flaky, and the questions worth asking are all about ordering
 * — does a tick skip while a fetch is running, does a closed view stop being
 * ticked, does a run of failures switch the thing off — none of which needs wall
 * time.
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres:example-password@localhost:5432/postgres',
  password: 'example-password',
}

const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

/** A hand-cranked clock: one queue of pending one-shots, fired by `advance`. */
class FakeTimers {
  private seq = 0
  private readonly pending = new Map<number, { fn: () => void; at: number }>()
  now = 0

  readonly set = (fn: () => void, ms: number): number => {
    this.seq += 1
    this.pending.set(this.seq, { fn, at: this.now + ms })
    return this.seq
  }

  readonly clear = (handle: number): void => {
    this.pending.delete(handle)
  }

  get count(): number {
    return this.pending.size
  }

  /** Fire everything due within `ms`, in due order, honouring re-arms. */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let nextId: number | null = null
      let nextAt = Infinity
      for (const [id, entry] of this.pending) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at
          nextId = id
        }
      }
      if (nextId === null) break
      const entry = this.pending.get(nextId)
      this.pending.delete(nextId)
      this.now = nextAt
      entry?.fn()
    }
    this.now = target
  }
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  timers: FakeTimers
  scheduler: ReturnType<typeof createAutoRefreshScheduler>
  /** Every result the deps were asked to start, in order. */
  started: { resultId: ResultId; what: 'query' | 'scan' | 'vector' }[]
  dispose(): void
}

function harness(): Harness {
  const started: Harness['started'] = []
  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 1 }
      },
      async close() {
        /* nothing to tear down in a stub */
      },
    },
    results: {
      async runQuery(req) {
        started.push({ resultId: req.resultId, what: 'query' })
      },
      async scanCollection(req) {
        started.push({ resultId: req.resultId, what: 'scan' })
      },
      async vectorSearch(req) {
        started.push({ resultId: req.resultId, what: 'vector' })
      },
      async cancel() {
        return true
      },
    },
  }

  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  const timers = new FakeTimers()
  const scheduler = createAutoRefreshScheduler({
    store,
    bus,
    setTimer: timers.set as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
    clearTimer: timers.clear as unknown as (handle: ReturnType<typeof setTimeout>) => void,
  })
  return {
    bus,
    store,
    timers,
    scheduler,
    started,
    dispose: () => {
      scheduler.dispose()
    },
  }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function openTable(h: Harness, connId: ConnId): Promise<ViewId> {
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'orders' } } },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

/**
 * Finish whatever result the view is currently streaming.
 *
 * The stubbed deps start results and never end them, so without this every view
 * sits at `running` forever and the scheduler — correctly — refuses to stack a
 * second fetch on the first. Opening a view auto-fetches, so this is the normal
 * preamble to anything that wants to observe a *tick*.
 */
function land(h: Harness, viewId: ViewId, outcome: 'done' | 'error' = 'done'): void {
  const resultId = currentResult(h, viewId)
  if (!resultId) return
  h.store.apply((draft) => {
    if (outcome === 'done') finishResult(draft, resultId, { rows: 3, elapsedMs: 7 })
    else failResult(draft, resultId, { code: 'QUERY_FAILED', message: 'relation does not exist' })
  }, { source: 'system' })
}

/** The result a view is currently bound to, if it has one. */
function currentResult(h: Harness, viewId: ViewId): ResultId | undefined {
  const view = h.store.getState().views[viewId]
  return view && 'resultId' in view ? view.resultId : undefined
}

/** The auto-refresh fields, read off a view the tests know is refreshable. */
function refreshState(h: Harness, viewId: ViewId): { ms?: number; stoppedBy?: string } {
  const view = h.store.getState().views[viewId]
  assert.ok(view, 'the view is still open')
  assert.ok(isRefreshableViewKind(view.kind), 'these tests only open refreshable views')
  const { autoRefreshMs, autoRefreshStoppedBy } = view as RefreshableView
  return { ms: autoRefreshMs, stoppedBy: autoRefreshStoppedBy }
}

/** Let the dispatch promises the scheduler fired settle before asserting. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function refreshCommands(h: Harness): { name: string; source: string }[] {
  return h.bus.log
    .entries()
    .filter((e) => e.source === 'system')
    .map((e) => ({ name: e.name, source: e.source }))
}

/* ------------------------------------------------------------------ */
/* The beat                                                            */
/* ------------------------------------------------------------------ */

test('an interval fires a refresh one interval later, as system', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  land(h, viewId)
  const before = h.started.length

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  assert.equal(refreshState(h, viewId).ms, 5_000)

  // Setting the interval does not itself fetch: the button next to it means "now".
  assert.equal(h.started.length, before, 'switching the timer on is not a fetch')

  h.timers.advance(5_000)
  await settle()
  assert.equal(h.started.length, before + 1)
  assert.deepEqual(refreshCommands(h), [{ name: 'view.update', source: 'system' }])
})

test('a tick while a fetch is still running is skipped, and the next one is still scheduled', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')

  h.timers.advance(5_000)
  await settle()
  const afterFirst = h.started.length
  const inFlight = currentResult(h, viewId)
  assert.ok(inFlight)
  assert.equal(h.store.getState().results[inFlight].status, 'running')

  // The first fetch never finished, so the second beat has to stand down.
  h.timers.advance(5_000)
  await settle()
  assert.equal(h.started.length, afterFirst, 'no second fetch stacked on top of the first')
  assert.equal(h.scheduler.size, 1, 'the view is still being ticked')

  // Once it lands, the beat resumes on its own.
  land(h, viewId)
  h.timers.advance(5_000)
  await settle()
  assert.equal(h.started.length, afterFirst + 1)
})

test('a tick on a connection that is not ready is skipped, and resumes when it is', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  land(h, viewId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  const before = h.started.length

  h.store.apply((draft) => {
    draft.connections[connId].status = 'error'
  }, { source: 'system' })
  h.timers.advance(15_000)
  await settle()
  assert.equal(h.started.length, before, 'nothing was asked of a connection that is down')
  assert.equal(h.scheduler.size, 1, 'the timer is paused, not cancelled')

  h.store.apply((draft) => {
    draft.connections[connId].status = 'ready'
  }, { source: 'system' })
  h.timers.advance(5_000)
  await settle()
  assert.equal(h.started.length, before + 1)
})

/* ------------------------------------------------------------------ */
/* Giving up                                                           */
/* ------------------------------------------------------------------ */

test('three failures in a row switch auto-refresh off, with the reason on the view', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  land(h, viewId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')

  for (let i = 0; i < AUTO_REFRESH_ERROR_LIMIT; i += 1) {
    h.timers.advance(5_000)
    await settle()
    assert.ok(currentResult(h, viewId), `round ${i} started a result`)
    land(h, viewId, 'error')
  }

  // The tick after the third failure is the one that grades it and gives up.
  h.timers.advance(5_000)
  await settle()

  assert.equal(refreshState(h, viewId).ms, undefined, 'the interval is gone')
  assert.equal(refreshState(h, viewId).stoppedBy, 'error')
  assert.equal(h.scheduler.size, 0, 'and so is the timer')
})

test('a success resets the failure count, so an intermittent error never accumulates', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  land(h, viewId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')

  for (let i = 0; i < 6; i += 1) {
    h.timers.advance(5_000)
    await settle()
    assert.ok(currentResult(h, viewId))
    land(h, viewId, i % 2 === 0 ? 'error' : 'done')
  }

  h.timers.advance(5_000)
  await settle()
  assert.equal(refreshState(h, viewId).ms, 5_000, 'still on')
})

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test('closing the view stops the timer', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  assert.equal(h.scheduler.size, 1)

  await h.bus.dispatch('view.close', { viewId }, 'ui')
  assert.equal(h.scheduler.size, 0)

  const before = h.started.length
  h.timers.advance(60_000)
  await settle()
  assert.equal(h.started.length, before)
})

test('setting it to null stops the timer; changing the interval restarts the clock', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  land(h, viewId)

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 30_000 } }, 'ui')
  h.timers.advance(29_000)
  await settle()
  const before = h.started.length

  // A new interval is a new wait, not a shortened one: 29 seconds already spent
  // waiting for "every 30s" must not make "every 10s" fire immediately.
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 10_000 } }, 'ui')
  h.timers.advance(9_000)
  await settle()
  assert.equal(h.started.length, before, 'the clock restarted')
  h.timers.advance(1_000)
  await settle()
  assert.equal(h.started.length, before + 1)

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: null } }, 'ui')
  assert.equal(h.scheduler.size, 0)
  assert.equal(refreshState(h, viewId).ms, undefined)
})

test('dispose clears every timer it holds', async (t) => {
  const h = harness()
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  assert.equal(h.timers.count, 1)

  h.dispose()
  assert.equal(h.timers.count, 0)
  assert.equal(h.scheduler.size, 0)
  t.after(() => {
    /* already disposed */
  })
})

/* ------------------------------------------------------------------ */
/* Per kind                                                            */
/* ------------------------------------------------------------------ */

test('a query view is refreshed with query.run, not with a patch', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'query', connId, text: 'select 1' } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'query', autoRefreshMs: 5_000 } }, 'ui')
  h.timers.advance(5_000)
  await settle()

  assert.deepEqual(refreshCommands(h), [{ name: 'query.run', source: 'system' }])
  assert.equal(h.started.at(-1)?.what, 'query')
})

test('a query view with an empty editor is skipped rather than run', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  await h.bus.dispatch(
    'view.update',
    { viewId: opened.data.viewId, patch: { kind: 'query', autoRefreshMs: 5_000 } },
    'ui',
  )
  h.timers.advance(20_000)
  await settle()
  assert.deepEqual(refreshCommands(h), [], 'nothing to run again is not a reason to run nothing')
  assert.equal(h.scheduler.size, 1)
})

/* ------------------------------------------------------------------ */
/* Cursor collections                                                  */
/* ------------------------------------------------------------------ */

test('paging a cursor collection forward switches auto-refresh off, with the reason', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'keyPattern', pattern: 'user:*' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  // The first page came back with a continuation token: the reader is now able
  // to walk forward, which is the state the rule is about.
  h.store.apply((draft) => {
    const view = draft.views[viewId]
    if (view.kind === 'table') view.cursorToken = 'cursor-1'
  }, { source: 'system' })

  // Exactly the Next-page gesture: a patch with nothing in it but its kind.
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table' }, refresh: true }, 'ui')

  assert.equal(refreshState(h, viewId).ms, undefined)
  assert.equal(refreshState(h, viewId).stoppedBy, 'paged')
  assert.equal(h.scheduler.size, 0)
})

test('an auto-refresh tick on a cursor collection is not mistaken for paging forward', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'keyPattern', pattern: 'user:*' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId
  land(h, viewId)

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')
  h.store.apply((draft) => {
    const view = draft.views[viewId]
    if (view.kind === 'table') view.cursorToken = 'cursor-1'
  }, { source: 'system' })

  // The timer sends `refreshPatch`, which on this kind carries `offset: 0` —
  // "start the scan over" rather than "give me the next page".
  h.timers.advance(5_000)
  await settle()

  assert.equal(refreshState(h, viewId).ms, 5_000, 'the timer did not turn itself off')
  const view = h.store.getState().views[viewId]
  assert.equal(view.kind === 'table' ? view.cursorToken : 'not a table', undefined,
    'and the stale continuation token was dropped')
})

test('paging an offset-paged table forward leaves auto-refresh alone', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const connId = await connect(h)
  const viewId = await openTable(h, connId)
  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', autoRefreshMs: 5_000 } }, 'ui')

  await h.bus.dispatch('view.update', { viewId, patch: { kind: 'table', offset: 100 }, refresh: true }, 'ui')

  assert.equal(refreshState(h, viewId).ms, 5_000,
    'rows here have stable addresses; a page is a place, not a cursor')
  assert.equal(refreshState(h, viewId).stoppedBy, undefined)
})
