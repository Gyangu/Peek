import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  MCP_DEFAULT_MAX_ROWS,
  asPanelId,
  createEmptyWorkspace,
  hasUsableRows,
  isSettledResultStatus,
  peekError,
  snapshotWorkspace,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
  type ResultId,
  type ViewId,
} from '@peek/core'
import { failResult, finishResult, pauseResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'
import type { ToolContext, ToolOutput } from '../../mcp/types'
import runQueryTool from '../../mcp/tools/run-query'
import readWorkspaceTool from '../../mcp/tools/read-workspace'
import { briefResult } from '../../mcp/summary'
import { redactRulesFor } from '../../../drivers/manifests'

/* ==================================================================
 * Regression net: "paused by design" has to stay completely separate from
 * "the query failed".
 *
 * Three layers are covered:
 *   1. core's state machine semantics (paused is terminal, its data is usable)
 *   2. the transition in main's source of truth (the view stays ready, no red
 *      error bar)
 *   3. MCP's run_query receipt (isError is falsy, and the wording lets an AI
 *      tell the two apart)
 * ================================================================== */

/**
 * The backpressure pause reason, worded exactly as the postgres driver words it
 * (see StreamPump in @peek/db-postgres). It is driver text, so it travels
 * untranslated all the way to the UI and to MCP.
 */
const PAUSE_REASON =
  'Result stream paused: no consumption ack for 60s,' +
  ' the server-side cursor and connection have been released'

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  runQueryCalls: { resultId: ResultId; maxRows?: number }[]
}

function harness(): Harness {
  const runQueryCalls: { resultId: ResultId; maxRows?: number }[] = []
  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery(req) {
        runQueryCalls.push({ resultId: req.resultId, maxRows: req.maxRows })
      },
      async scanCollection() {},
      async vectorSearch() {},
      async cancel() {
        return true
      },
    },
  }
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return { bus, store, runQueryCalls }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function runningQuery(h: Harness): Promise<{ resultId: ResultId; viewId: ViewId }> {
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select * from harness' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) throw new Error('unreachable')
  return { resultId: run.data.resultId, viewId: run.data.viewId }
}

/* ------------------------------------------------------------------ */
/* 1. core semantics                                                    */
/* ------------------------------------------------------------------ */

test('paused is terminal and its data is usable; only error data is untrustworthy', () => {
  assert.equal(isSettledResultStatus('paused'), true)
  assert.equal(isSettledResultStatus('running'), false)
  assert.equal(hasUsableRows('paused'), true)
  assert.equal(hasUsableRows('cancelled'), true)
  assert.equal(hasUsableRows('done'), true)
  assert.equal(hasUsableRows('error'), false)
})

/* ------------------------------------------------------------------ */
/* 2. Source-of-truth transitions                                       */
/* ------------------------------------------------------------------ */

test('backpressure pause: the result set lands on paused + truncated + resumable while the view stays ready', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)

  h.store.apply(
    (draft) => {
      pauseResult(draft, resultId, {
        rows: 901_000,
        elapsedMs: 61_234,
        reason: PAUSE_REASON,
      })
    },
    { source: 'system' },
  )

  const state = h.store.getState()
  const meta = state.results[resultId]
  assert.equal(meta.status, 'paused')
  assert.equal(meta.rows, 901_000)
  assert.equal(meta.elapsedMs, 61_234)
  assert.equal(meta.truncated, true, 'more rows are still waiting')
  assert.equal(meta.resumable, true, 're-running continues from here')
  assert.equal(meta.error, undefined, 'a pause must never carry an error object')
  assert.ok(meta.pausedReason?.includes('the server-side cursor'))

  // The crux: the view must not turn red
  assert.equal(state.views[viewId].status, 'ready')
  assert.equal(state.views[viewId].error, undefined)
})

test('pauses and real errors never contaminate each other: a SQL error still lands on error plus a red view', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)

  h.store.apply(
    (draft) => {
      failResult(draft, resultId, peekError('QUERY_FAILED', 'relation "nope" does not exist'))
    },
    { source: 'system' },
  )

  const state = h.store.getState()
  assert.equal(state.results[resultId].status, 'error')
  assert.equal(state.results[resultId].resumable, undefined)
  assert.equal(state.views[viewId].status, 'error')
  assert.ok(state.views[viewId].error)
})

test('a result set already in a terminal state is not rewritten by a late pause (cancel/finish wins)', async () => {
  const h = harness()
  const a = await runningQuery(h)
  h.store.apply(
    (draft) => {
      finishResult(draft, a.resultId, { rows: 12, elapsedMs: 3 })
    },
    { source: 'system' },
  )
  h.store.apply(
    (draft) => {
      pauseResult(draft, a.resultId, { rows: 999, elapsedMs: 9, reason: 'late' })
    },
    { source: 'system' },
  )
  assert.equal(h.store.getState().results[a.resultId].status, 'done')
  assert.equal(h.store.getState().results[a.resultId].rows, 12)

  const b = await runningQuery(h)
  await h.bus.dispatch('query.cancel', { resultId: b.resultId }, 'ui')
  h.store.apply(
    (draft) => {
      pauseResult(draft, b.resultId, { rows: 999, elapsedMs: 9, reason: 'late' })
    },
    { source: 'system' },
  )
  assert.equal(h.store.getState().results[b.resultId].status, 'cancelled')
})

/* ------------------------------------------------------------------ */
/* 3. MCP receipts                                                      */
/* ------------------------------------------------------------------ */

function toolCtx(h: Harness): ToolContext {
  return {
    dispatch: (name, input, source) => h.bus.dispatch(name, input, source),
    getSnapshot: () => snapshotWorkspace(h.store.getState(), redactRulesFor),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger: { log: () => {} },
  }
}

/** Runs the real tool (validate → toCommands → dispatch → render), just without the MCP transport */
function runTool(h: Harness, input: Record<string, unknown>): Promise<ToolOutput> {
  return runQueryTool.run(input, toolCtx(h))
}

test('run_query applies the server-side ceiling when maxRows is omitted, so an AI select * does not run straight into a pause', async () => {
  const h = harness()
  const connId = await connect(h)
  await runTool(h, { connId, text: 'select * from harness', waitMs: 0, previewRows: 0 })
  assert.equal(h.runQueryCalls.length, 1)
  assert.equal(h.runQueryCalls[0].maxRows, MCP_DEFAULT_MAX_ROWS)
})

test('run_query does not override an explicitly supplied maxRows', async () => {
  const h = harness()
  const connId = await connect(h)
  await runTool(h, { connId, text: 'select 1', maxRows: 5, waitMs: 0, previewRows: 0 })
  assert.equal(h.runQueryCalls[0].maxRows, 5)
})

test('run_query receipt: paused is not isError, and it says outright that the data is valid and re-running continues', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  // Re-run inside the same query view, then push it into paused
  const out = await new Promise<ToolOutput>((resolve) => {
    void runTool(h, { viewId: first.data.viewId, waitMs: 500, previewRows: 0 }).then(resolve)
    // Let query.run land and mint its new resultId first, then move it to paused
    setTimeout(() => {
      const ws = h.store.getState()
      const running = Object.values(ws.results).find((r) => r.status === 'running')
      assert.ok(running, 'there should be exactly one running result set')
      h.store.apply(
        (draft) => {
          pauseResult(draft, running.id, {
            rows: 200_000,
            elapsedMs: 61_000,
            reason: PAUSE_REASON,
          })
        },
        { source: 'system' },
      )
    }, 0)
  })

  assert.notEqual(out.isError, true, 'paused must never be reported as a failure')
  assert.ok(out.text.includes('Paused'), `the receipt must name the pause: ${out.text}`)
  assert.ok(out.text.includes('not a failure'), 'it must explicitly deny the "failure" reading')
  assert.ok(out.text.includes('run the query again'), 'it must tell the AI how to continue')
  const data = out.data as { status: string; rowsUsable: boolean; resumable: boolean; rows: number }
  assert.equal(data.status, 'paused')
  assert.equal(data.rowsUsable, true)
  assert.equal(data.resumable, true)
  assert.equal(data.rows, 200_000)
})

/* ------------------------------------------------------------------ */
/* 4. read_workspace: the AI's main window onto the UI, so a bare        */
/*    'paused' label is not enough                                      */
/* ------------------------------------------------------------------ */

test('read_workspace: a paused result set carries rowsUsable/resumable/pausedReason', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)
  h.store.apply(
    (draft) => {
      pauseResult(draft, resultId, {
        rows: 207_000,
        elapsedMs: 60_278,
        reason: PAUSE_REASON,
      })
    },
    { source: 'system' },
  )

  const out = await readWorkspaceTool.run({}, toolCtx(h))
  const data = out.data as { results: Record<string, unknown>[]; panels: Record<string, unknown>[] }
  const brief = data.results.find((r) => r['resultId'] === String(resultId))
  assert.ok(brief, 'read_workspace must report this result set')
  assert.equal(brief['status'], 'paused')
  assert.equal(brief['rowsUsable'], true, 'the rows already loaded are good, and that must be said outright')
  assert.equal(brief['resumable'], true)
  assert.equal(brief['truncated'], true)
  assert.ok(
    String(brief['pausedReason']).includes('the server-side cursor'),
    'it must give a human-readable reason',
  )
  assert.notEqual(out.isError, true)

  // The text view — the first thing an AI reads — must deny the "failure" reading too
  assert.ok(
    out.text.includes('not a failure'),
    `the layout outline has to spell this out: ${out.text.slice(0, 400)}`,
  )
  assert.ok(String(viewId).length > 0)
})

test('read_workspace: a genuinely failed result set has rowsUsable=false; the two paths never merge', async () => {
  const h = harness()
  const { resultId } = await runningQuery(h)
  h.store.apply(
    (draft) => {
      failResult(draft, resultId, peekError('QUERY_FAILED', 'relation "nope" does not exist'))
    },
    { source: 'system' },
  )

  const out = await readWorkspaceTool.run({}, toolCtx(h))
  const data = out.data as { results: Record<string, unknown>[] }
  const brief = data.results.find((r) => r['resultId'] === String(resultId))
  assert.ok(brief)
  assert.equal(brief['status'], 'error')
  assert.equal(brief['rowsUsable'], false)
  assert.equal(brief['resumable'], undefined)
  assert.ok(String(brief['error']).includes('QUERY_FAILED'))
})

test('briefResult: rowsUsable for all five statuses is decided in exactly one place', () => {
  const base = {
    id: 'res_x' as ResultId,
    connId: 'conn_x' as ConnId,
    viewId: 'view_x' as ViewId,
    rows: 10,
    startedAt: 0,
  }
  const usable = (status: 'running' | 'done' | 'paused' | 'error' | 'cancelled'): boolean =>
    briefResult({ ...base, status }).rowsUsable
  assert.equal(usable('running'), true)
  assert.equal(usable('done'), true)
  assert.equal(usable('paused'), true)
  assert.equal(usable('cancelled'), true)
  assert.equal(usable('error'), false)
})

test('run_query receipt: a real error is still isError=true', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  const out = await new Promise<ToolOutput>((resolve) => {
    void runTool(h, { viewId: first.data.viewId, waitMs: 500, previewRows: 0 }).then(resolve)
    setTimeout(() => {
      const ws = h.store.getState()
      const running = Object.values(ws.results).find((r) => r.status === 'running')
      assert.ok(running)
      h.store.apply(
        (draft) => {
          failResult(draft, running.id, peekError('QUERY_FAILED', 'syntax error at or near "slect"'))
        },
        { source: 'system' },
      )
    }, 0)
  })

  assert.equal(out.isError, true)
  assert.ok(out.text.includes('QUERY_FAILED'))
})
