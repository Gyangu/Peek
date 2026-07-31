import assert from 'node:assert/strict'
import { test } from 'node:test'
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

/* ==================================================================
 * MAJOR 的回归网：「按设计暂停」必须与「查询失败」彻底分开。
 *
 * 覆盖三段：
 *   1. core 的状态机语义（paused 是终态、数据可用）
 *   2. main 真源的迁移（视图保持 ready，不出红色错误条）
 *   3. MCP run_query 回执（isError 为假、措辞能让 AI 分清）
 * ================================================================== */

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
/* 1. core 语义                                                         */
/* ------------------------------------------------------------------ */

test('paused 是终态，且数据可用；只有 error 的数据不可信', () => {
  assert.equal(isSettledResultStatus('paused'), true)
  assert.equal(isSettledResultStatus('running'), false)
  assert.equal(hasUsableRows('paused'), true)
  assert.equal(hasUsableRows('cancelled'), true)
  assert.equal(hasUsableRows('done'), true)
  assert.equal(hasUsableRows('error'), false)
})

/* ------------------------------------------------------------------ */
/* 2. 真源迁移                                                          */
/* ------------------------------------------------------------------ */

test('背压暂停：结果集落 paused + truncated + resumable，视图保持 ready 不报错', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)

  h.store.apply((draft) => {
    pauseResult(draft, resultId, {
      rows: 901_000,
      elapsedMs: 61_234,
      reason: '结果流已暂停：60 秒没有新的消费确认，已释放服务端游标与连接',
    })
  }, { source: 'system' })

  const state = h.store.getState()
  const meta = state.results[resultId]
  assert.equal(meta.status, 'paused')
  assert.equal(meta.rows, 901_000)
  assert.equal(meta.elapsedMs, 61_234)
  assert.equal(meta.truncated, true, '还有更多行没取')
  assert.equal(meta.resumable, true, '重新执行即可继续')
  assert.equal(meta.error, undefined, '暂停绝不能带错误对象')
  assert.ok(meta.pausedReason?.includes('已释放服务端游标'))

  // 关键：视图不能变成红色错误态
  assert.equal(state.views[viewId].status, 'ready')
  assert.equal(state.views[viewId].error, undefined)
})

test('暂停与真错误互不污染：SQL 报错仍然落 error + 红色视图', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)

  h.store.apply((draft) => {
    failResult(draft, resultId, peekError('QUERY_FAILED', 'relation "nope" does not exist'))
  }, { source: 'system' })

  const state = h.store.getState()
  assert.equal(state.results[resultId].status, 'error')
  assert.equal(state.results[resultId].resumable, undefined)
  assert.equal(state.views[viewId].status, 'error')
  assert.ok(state.views[viewId].error)
})

test('已进终态的结果集不会被迟到的暂停改写（取消/完成 说了算）', async () => {
  const h = harness()
  const a = await runningQuery(h)
  h.store.apply((draft) => {
    finishResult(draft, a.resultId, { rows: 12, elapsedMs: 3 })
  }, { source: 'system' })
  h.store.apply((draft) => {
    pauseResult(draft, a.resultId, { rows: 999, elapsedMs: 9, reason: 'late' })
  }, { source: 'system' })
  assert.equal(h.store.getState().results[a.resultId].status, 'done')
  assert.equal(h.store.getState().results[a.resultId].rows, 12)

  const b = await runningQuery(h)
  await h.bus.dispatch('query.cancel', { resultId: b.resultId }, 'ui')
  h.store.apply((draft) => {
    pauseResult(draft, b.resultId, { rows: 999, elapsedMs: 9, reason: 'late' })
  }, { source: 'system' })
  assert.equal(h.store.getState().results[b.resultId].status, 'cancelled')
})

/* ------------------------------------------------------------------ */
/* 3. MCP 回执                                                          */
/* ------------------------------------------------------------------ */

function toolCtx(h: Harness): ToolContext {
  return {
    dispatch: (name, input, source) => h.bus.dispatch(name, input, source),
    getSnapshot: () => snapshotWorkspace(h.store.getState()),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger: { log: () => {} },
  }
}

/** 走工具本尊（校验 → toCommands → dispatch → render），只是不经 MCP transport */
function runTool(h: Harness, input: Record<string, unknown>): Promise<ToolOutput> {
  return runQueryTool.run(input, toolCtx(h))
}

test('run_query 缺省 maxRows 时套服务端上限，AI 一条 select * 不会直奔暂停', async () => {
  const h = harness()
  const connId = await connect(h)
  await runTool(h, { connId, text: 'select * from harness', waitMs: 0, previewRows: 0 })
  assert.equal(h.runQueryCalls.length, 1)
  assert.equal(h.runQueryCalls[0].maxRows, MCP_DEFAULT_MAX_ROWS)
})

test('run_query 显式给了 maxRows 就不覆盖', async () => {
  const h = harness()
  const connId = await connect(h)
  await runTool(h, { connId, text: 'select 1', maxRows: 5, waitMs: 0, previewRows: 0 })
  assert.equal(h.runQueryCalls[0].maxRows, 5)
})

test('run_query 回执：paused 不是 isError，且明说数据有效、可重跑续取', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  // 复用同一个 query 视图重跑，然后把它打成 paused
  const out = await new Promise<ToolOutput>((resolve) => {
    void runTool(h, { viewId: first.data.viewId, waitMs: 500, previewRows: 0 }).then(resolve)
    // 让 query.run 先落地拿到新的 resultId，再迁移到 paused
    setTimeout(() => {
      const ws = h.store.getState()
      const running = Object.values(ws.results).find((r) => r.status === 'running')
      assert.ok(running, '应当有一个在跑的结果集')
      h.store.apply((draft) => {
        pauseResult(draft, running.id, {
          rows: 200_000,
          elapsedMs: 61_000,
          reason: '结果流已暂停：60 秒没有新的消费确认，已释放服务端游标与连接',
        })
      }, { source: 'system' })
    }, 0)
  })

  assert.notEqual(out.isError, true, 'paused 绝不能被报成失败')
  assert.ok(out.text.includes('已暂停'), `回执必须点明暂停：${out.text}`)
  assert.ok(out.text.includes('不是失败'), '必须显式否定"失败"这个解读')
  assert.ok(out.text.includes('重新执行'), '必须告诉 AI 怎么继续')
  const data = out.data as { status: string; rowsUsable: boolean; resumable: boolean; rows: number }
  assert.equal(data.status, 'paused')
  assert.equal(data.rowsUsable, true)
  assert.equal(data.resumable, true)
  assert.equal(data.rows, 200_000)
})

/* ------------------------------------------------------------------ */
/* 4. read_workspace：AI 感知界面的主入口，不能只给一个 'paused' 字样      */
/* ------------------------------------------------------------------ */

test('read_workspace：paused 结果集带上 rowsUsable/resumable/pausedReason', async () => {
  const h = harness()
  const { resultId, viewId } = await runningQuery(h)
  h.store.apply((draft) => {
    pauseResult(draft, resultId, {
      rows: 207_000,
      elapsedMs: 60_278,
      reason: '结果流已暂停：60 秒没有新的消费确认，已释放服务端游标与连接',
    })
  }, { source: 'system' })

  const out = await readWorkspaceTool.run({}, toolCtx(h))
  const data = out.data as { results: Record<string, unknown>[]; panels: Record<string, unknown>[] }
  const brief = data.results.find((r) => r['resultId'] === String(resultId))
  assert.ok(brief, 'read_workspace 必须报出这个结果集')
  assert.equal(brief['status'], 'paused')
  assert.equal(brief['rowsUsable'], true, '已加载的行是好的，必须显式说出来')
  assert.equal(brief['resumable'], true)
  assert.equal(brief['truncated'], true)
  assert.ok(String(brief['pausedReason']).includes('已释放服务端游标'), '要给出人可读原因')
  assert.notEqual(out.isError, true)

  // 文本视图（AI 最先读到的那段）也必须否掉"失败"这个解读
  assert.ok(out.text.includes('不是失败'), `布局大纲里要写清楚：${out.text.slice(0, 400)}`)
  assert.ok(String(viewId).length > 0)
})

test('read_workspace：真错误的结果集 rowsUsable=false，两条路径不混流', async () => {
  const h = harness()
  const { resultId } = await runningQuery(h)
  h.store.apply((draft) => {
    failResult(draft, resultId, peekError('QUERY_FAILED', 'relation "nope" does not exist'))
  }, { source: 'system' })

  const out = await readWorkspaceTool.run({}, toolCtx(h))
  const data = out.data as { results: Record<string, unknown>[] }
  const brief = data.results.find((r) => r['resultId'] === String(resultId))
  assert.ok(brief)
  assert.equal(brief['status'], 'error')
  assert.equal(brief['rowsUsable'], false)
  assert.equal(brief['resumable'], undefined)
  assert.ok(String(brief['error']).includes('QUERY_FAILED'))
})

test('briefResult：五种状态的 rowsUsable 判定只有一个出处', () => {
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

test('run_query 回执：真错误仍然 isError=true', async () => {
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
      h.store.apply((draft) => {
        failResult(draft, running.id, peekError('QUERY_FAILED', 'syntax error at or near "slect"'))
      }, { source: 'system' })
    }, 0)
  })

  assert.equal(out.isError, true)
  assert.ok(out.text.includes('QUERY_FAILED'))
})
