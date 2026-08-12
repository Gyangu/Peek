import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  asPanelId,
  createEmptyWorkspace,
  snapshotWorkspace,
  type Capability,
  type ConnId,
  type MysqlConnectionConfig,
  type PostgresConnectionConfig,
  type ResultId,
  type ViewId,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import type { CommandDeps } from '../deps'
import type { ToolContext, ToolOutput } from '../../mcp/types'
import runQueryTool from '../../mcp/tools/run-query'
import { redactRulesFor } from '../../../drivers/manifests'

/**
 * `query.run` used to accept a viewId and a connId that disagreed, and answer
 * from the view.
 *
 * The reproduction was deterministic and silent: open a query view on PostgreSQL,
 * then `run_query({ viewId, connId: <mysql>, text: 'SELECT VERSION() AS v' })`.
 * The receipt came back `status done · 1 rows`, the version string was
 * PostgreSQL's, the view was still bound to PostgreSQL, and nothing in the
 * receipt mentioned that the connId had been dropped. `QueryRunInputSchema`'s
 * refine only requires "a viewId, **or** connId together with text", so the two
 * arriving together was never rejected, and `resolveQueryView` returned early on
 * `input.viewId` without ever looking at `input.connId`.
 *
 * For an agent this is the worst shape a failure can take: "run this on MySQL, in
 * that panel" produces rows from another server, and they look like the answer.
 */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const MYSQL_CONFIG: MysqlConnectionConfig = {
  driverId: 'mysql',
  url: 'mysql://root@localhost:3307/peek_test',
}
const CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** Every statement that actually reached a driver, with the connection it went to. */
  runs: { resultId: ResultId; text: string }[]
}

function harness(): Harness {
  const runs: { resultId: ResultId; text: string }[] = []
  const deps: CommandDeps = {
    connections: {
      async open() {
        return { capabilities: CAPS, serverInfo: { version: '0', flavor: 'test' }, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery(req) {
        runs.push({ resultId: req.resultId, text: req.text })
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
  return { bus, store, runs }
}

async function connect(h: Harness, config: PostgresConnectionConfig | MysqlConnectionConfig): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function queryViewOn(h: Harness, connId: ConnId): Promise<ViewId> {
  const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

function toolCtx(h: Harness): ToolContext {
  return {
    dispatch: (name, input, source) => h.bus.dispatch(name, input, source),
    getSnapshot: () => snapshotWorkspace(h.store.getState(), redactRulesFor),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger: { log: () => {} },
  }
}

function runTool(h: Harness, input: Record<string, unknown>): Promise<ToolOutput> {
  return runQueryTool.run(input, toolCtx(h))
}

describe('query.run: a viewId and a connId that disagree', () => {
  test('is refused, rather than silently answered from the view’s own connection', async () => {
    const h = harness()
    const pg = await connect(h, PG_CONFIG)
    const mysql = await connect(h, MYSQL_CONFIG)
    const viewId = await queryViewOn(h, pg)
    const before = h.runs.length

    const res = await h.bus.dispatch(
      'query.run',
      { viewId, connId: mysql, text: 'SELECT VERSION() AS v' },
      'mcp',
    )

    assert.equal(res.ok, false)
    if (res.ok) throw new Error('unreachable')
    assert.equal(res.error.code, 'BAD_REQUEST')
    // Both connections are named: the caller has to be able to tell which of the
    // two it got wrong without another round trip.
    assert.ok(res.error.message.includes(String(pg)), res.error.message)
    assert.ok(res.error.message.includes(String(mysql)), res.error.message)

    // Nothing ran, and nothing moved
    assert.equal(h.runs.length, before, 'the statement must not reach any driver')
    assert.equal(h.store.getState().views[viewId].connId, pg, 'the view keeps its own connection')
  })

  test('the same request through run_query is an isError receipt, not rows from the wrong server', async () => {
    const h = harness()
    const pg = await connect(h, PG_CONFIG)
    const mysql = await connect(h, MYSQL_CONFIG)
    const viewId = await queryViewOn(h, pg)

    const out = await runTool(h, { viewId, connId: mysql, text: 'SELECT VERSION() AS v' })

    assert.equal(out.isError, true)
    assert.match(out.text, /BAD_REQUEST/)
    assert.ok(out.text.includes(String(mysql)), out.text)
  })

  test('a connId that agrees with the view is accepted — only the contradiction is refused', async () => {
    const h = harness()
    const pg = await connect(h, PG_CONFIG)
    const viewId = await queryViewOn(h, pg)
    const before = h.runs.length

    const res = await h.bus.dispatch('query.run', { viewId, connId: pg, text: 'select 2' }, 'mcp')

    assert.equal(res.ok, true)
    assert.equal(h.runs.length, before + 1)
    assert.equal(h.runs[h.runs.length - 1]?.text, 'select 2')
  })

  test('the two single-argument forms are untouched', async () => {
    const h = harness()
    const pg = await connect(h, PG_CONFIG)

    // connId + text opens a new view on that connection
    const opened = await h.bus.dispatch('query.run', { connId: pg, text: 'select 3' }, 'mcp')
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')
    assert.equal(h.store.getState().views[opened.data.viewId].connId, pg)

    // viewId alone re-runs in that view
    const again = await h.bus.dispatch('query.run', { viewId: opened.data.viewId, text: 'select 4' }, 'mcp')
    assert.equal(again.ok, true)
    assert.equal(h.runs[h.runs.length - 1]?.text, 'select 4')
  })
})
