import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectPanels,
  createEmptyWorkspace,
  asPanelId,
  asViewId,
  peekError,
  type Capability,
  type ConnId,
  type PostgresConnectionConfig,
  type ResultId,
  type ViewId,
} from '@peek/core'
import { failResult } from '../../store/mutations'
import { WorkspaceStore } from '../../store/workspace-store'
import { redactPatches, redactWorkspace } from '../../store/sanitize'
import { CommandBus } from '../command-bus'
import { coreHandlers } from '../handlers'
import { createSeqIdFactory } from '../ids'
import { createUnavailableDeps, type CommandDeps } from '../deps'

/* ------------------------------------------------------------------ */
/* 测试装置                                                             */
/* ------------------------------------------------------------------ */

interface DepsCalls {
  open: { connId: ConnId }[]
  close: ConnId[]
  runQuery: { resultId: ResultId; text: string }[]
  scan: { resultId: ResultId; offset?: number; limit?: number }[]
  vectorSearch: { resultId: ResultId; topK: number }[]
  cancel: ResultId[]
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  calls: DepsCalls
  rootPanel: ReturnType<typeof asPanelId>
}

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres:example-password@localhost:5432/postgres',
  password: 'example-password',
}

const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

function harness(options: { openFails?: boolean } = {}): Harness {
  const calls: DepsCalls = { open: [], close: [], runQuery: [], scan: [], vectorSearch: [], cancel: [] }
  const deps: CommandDeps = {
    connections: {
      async open(req) {
        calls.open.push({ connId: req.connId })
        if (options.openFails) throw new Error('connect refused')
        return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 4242 }
      },
      async close(connId) {
        calls.close.push(connId)
      },
    },
    results: {
      async runQuery(req) {
        calls.runQuery.push({ resultId: req.resultId, text: req.text })
      },
      async scanCollection(req) {
        calls.scan.push({ resultId: req.resultId, offset: req.offset, limit: req.limit })
      },
      async vectorSearch(req) {
        calls.vectorSearch.push({ resultId: req.resultId, topK: req.topK })
      },
      async cancel(req) {
        calls.cancel.push(req.resultId)
        return true
      },
    },
  }

  const rootPanel = asPanelId('panel_root')
  const store = new WorkspaceStore(createEmptyWorkspace(rootPanel))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  return { bus, store, calls, rootPanel }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

/* ------------------------------------------------------------------ */
/* 校验与错误收敛                                                        */
/* ------------------------------------------------------------------ */

test('入参不合法回结构化错误，不抛异常，也不动状态', async () => {
  const h = harness()
  const before = h.store.rev
  const res = await h.bus.dispatch('layout.focus', { panelId: 123 }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.equal(h.store.rev, before, '校验失败不 bump rev')
})

test('找不到目标回 NOT_FOUND，且 reduce 的半成品被整体丢弃', async () => {
  const h = harness()
  const res = await h.bus.dispatch('layout.close', { panelId: 'panel_ghost' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'NOT_FOUND')
})

test('UI 与 MCP 走同一条路径，只有日志里的 source 不同', async () => {
  const h = harness()
  const connId = await connect(h)
  await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'mcp')

  const opens = h.bus.log.entries().filter((e) => e.name === 'view.open')
  assert.deepEqual(
    opens.map((e) => e.source),
    ['ui', 'mcp'],
  )
  assert.equal(opens[0].ok && opens[1].ok, true)
})

/* ------------------------------------------------------------------ */
/* conn.*                                                             */
/* ------------------------------------------------------------------ */

test('conn.open：connecting → ready，能力集由驱动回填', async () => {
  const h = harness()
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG, openTree: true }, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(res.data.status, 'ready', 'finalize 用副作用后的真源修正了返回值')
  assert.deepEqual(res.data.capabilities, PG_CAPS)
  assert.equal(res.data.serverInfo?.version, '16.4')
  assert.ok(res.data.treeViewId)
  assert.equal(h.calls.open.length, 1)

  const conn = h.store.getState().connections[res.data.connId]
  assert.equal(conn.status, 'ready')
  assert.equal(conn.pid, 4242)
  assert.equal(conn.config.driverId, 'postgres')
})

test('conn.open 失败：状态落到 error，命令回 CONNECTION_FAILED', async () => {
  const h = harness({ openFails: true })
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONNECTION_FAILED')

  const conns = Object.values(h.store.getState().connections)
  assert.equal(conns.length, 1)
  assert.equal(conns[0].status, 'error')
  assert.equal(conns[0].error?.code, 'CONNECTION_FAILED')
})

test('conn.close：连带关掉名下视图并断开驱动', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)

  const res = await h.bus.dispatch('conn.close', { connId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.closedViewIds.length, 1)
  assert.deepEqual(h.calls.close, [connId])
  assert.deepEqual(h.store.getState().views, {})
  assert.equal(h.store.getState().connections[connId], undefined)
})

/* ------------------------------------------------------------------ */
/* view.* / query.*                                                   */
/* ------------------------------------------------------------------ */

test('view.open table：自动起一次 scan，视图落到焦点面板', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(res.data.panelId, h.rootPanel)
  assert.ok(res.data.resultId)
  assert.equal(h.calls.scan.length, 1)
  assert.equal(h.calls.scan[0].resultId, res.data.resultId)

  const state = h.store.getState()
  assert.equal(state.views[res.data.viewId].status, 'loading')
  assert.equal(state.results[res.data.resultId!].status, 'running')
  assert.equal(state.focusedPanel, h.rootPanel)
  assert.equal(collectPanels(state.layout)[0].viewId, res.data.viewId)
})

test('view.open：连接没 ready 时不取数，视图安静地停在 idle', async () => {
  const h = harness({ openFails: true })
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId

  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.resultId, undefined)
  assert.equal(h.calls.scan.length, 0)
  assert.equal(h.store.getState().views[res.data.viewId].status, 'idle')
})

test('view.open replace=false：占用的面板会被劈开而不是覆盖', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const second = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'tree', connId }, replace: false },
    'ui',
  )
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 2)
  assert.equal(collectPanels(state.layout).length, 2)
  assert.notEqual(first.data.panelId, second.data.panelId)
})

test('view.open 覆盖同一面板：旧视图被关掉', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  const second = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 1)
  assert.equal(state.views[first.data.viewId], undefined)
  assert.equal(collectPanels(state.layout).length, 1)
})

test('view.update：翻页触发重取，且作废旧的续拉游标', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  const res = await h.bus.dispatch(
    'view.update',
    { viewId, patch: { kind: 'table', offset: 200, limit: 50 } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.data.resultId)
  assert.equal(h.calls.scan.length, 2)
  assert.deepEqual(
    { offset: h.calls.scan[1].offset, limit: h.calls.scan[1].limit },
    { offset: 200, limit: 50 },
  )

  const view = h.store.getState().views[viewId]
  assert.equal(view.kind === 'table' && view.page.offset, 200)
})

test('view.update：换页前先取消上一个还在跑的结果集', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'table', connId, ref: { kind: 'relation', schema: 'public', name: 'harness' } } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const firstResult = opened.data.resultId
  assert.ok(firstResult)

  const res = await h.bus.dispatch(
    'view.update',
    { viewId: opened.data.viewId, patch: { kind: 'table', offset: 200 }, refresh: true },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.deepEqual(h.calls.cancel, [firstResult], '旧结果集必须在换页时被取消')
  const state = h.store.getState()
  assert.equal(state.results[firstResult!].status, 'cancelled')
  assert.equal(state.results[res.data.resultId!].status, 'running')
  // 取消的是旧结果集，不能把视图本身打回 idle
  assert.equal(state.views[opened.data.viewId].status, 'loading')
})

test('query.run 连按两次：前一次的结果集被取消，不留孤儿流', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = await h.bus.dispatch(
    'query.run',
    { connId, viewId: first.data.viewId, text: 'select 1' },
    'ui',
  )
  assert.equal(second.ok, true)
  if (!second.ok) return

  assert.deepEqual(h.calls.cancel, [first.data.resultId])
  assert.equal(h.store.getState().results[first.data.resultId].status, 'cancelled')
})

test('driver 报 CANCELLED：视图回 idle，不出现红色错误条', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const cancelled = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'ui')
  assert.equal(cancelled.ok, true)

  // driver host 的 StreamPump 取消后必然再发一条 result.error(CANCELLED)
  h.store.apply((draft) => {
    failResult(draft, run.data.resultId, peekError('CANCELLED', '结果流已被取消'))
  }, { source: 'system' })

  const state = h.store.getState()
  assert.equal(state.views[run.data.viewId].status, 'idle', '取消不是错误')
  assert.equal(state.views[run.data.viewId].error, undefined)
  assert.equal(state.results[run.data.resultId].status, 'cancelled')
})

test('driver 报真错误：视图仍然落到 error 并带上结构化错误', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select boom' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  h.store.apply((draft) => {
    failResult(draft, run.data.resultId, peekError('SYNTAX_ERROR', '列 boom 不存在', { driverCode: '42703' }))
  }, { source: 'system' })

  const state = h.store.getState()
  assert.equal(state.views[run.data.viewId].status, 'error')
  assert.equal(state.views[run.data.viewId].error?.driverCode, '42703')
  assert.equal(state.results[run.data.resultId].status, 'error')
})

test('view.update：补丁 kind 与视图不符回 BAD_REQUEST', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const res = await h.bus.dispatch(
    'view.update',
    { viewId: opened.data.viewId, patch: { kind: 'query', text: 'select 1' } },
    'mcp',
  )
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
})

test('query.run：没有 viewId 时按 connId + text 新开查询视图', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.equal(h.calls.runQuery.length, 1)
  assert.equal(h.calls.runQuery[0].text, 'select 1')
  const view = h.store.getState().views[res.data.viewId]
  assert.equal(view.kind, 'query')
  assert.equal(view.status, 'loading')
  assert.equal(h.store.getState().results[res.data.resultId].summary, 'select 1')
})

test('query.run：连接没 ready 时回 CONFLICT', async () => {
  const h = harness({ openFails: true })
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId

  const res = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'mcp')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONFLICT')
  assert.equal(h.calls.runQuery.length, 0)
})

test('query.cancel：在跑的结果集被取消，已结束的如实回 false', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select pg_sleep(60)' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const cancelled = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'mcp')
  assert.equal(cancelled.ok, true)
  if (!cancelled.ok) return
  assert.equal(cancelled.data.cancelled, true)
  assert.deepEqual(h.calls.cancel, [run.data.resultId])
  assert.equal(h.store.getState().results[run.data.resultId].status, 'cancelled')

  const again = await h.bus.dispatch('query.cancel', { resultId: run.data.resultId }, 'mcp')
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.data.cancelled, false)
  assert.equal(h.calls.cancel.length, 1, '已结束的不再打扰驱动')
})

test('view.close：面板保留，在跑的结果集被顺手取消', async () => {
  const h = harness()
  const connId = await connect(h)
  const run = await h.bus.dispatch('query.run', { connId, text: 'select 1' }, 'ui')
  assert.equal(run.ok, true)
  if (!run.ok) return

  const res = await h.bus.dispatch('view.close', { viewId: run.data.viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.panelId, h.rootPanel)
  assert.deepEqual(h.calls.cancel, [run.data.resultId])
  assert.equal(collectPanels(h.store.getState().layout)[0].viewId, null)
})

/* ------------------------------------------------------------------ */
/* layout.*                                                           */
/* ------------------------------------------------------------------ */

test('layout.split：可以顺手在新面板里开视图，焦点跟过去', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch(
    'layout.split',
    { panelId: h.rootPanel, dir: 'row', view: { kind: 'tree', connId } },
    'mcp',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.data.viewId)

  const state = h.store.getState()
  assert.equal(state.focusedPanel, res.data.panelId)
  assert.equal(collectPanels(state.layout).length, 2)
})

test('layout.close：关掉焦点面板后焦点自动回落', async () => {
  const h = harness()
  const split = await h.bus.dispatch('layout.split', { panelId: h.rootPanel, dir: 'row' }, 'ui')
  assert.equal(split.ok, true)
  if (!split.ok) return
  assert.equal(h.store.getState().focusedPanel, split.data.panelId)

  const res = await h.bus.dispatch('layout.close', { panelId: split.data.panelId }, 'ui')
  assert.equal(res.ok, true)
  const state = h.store.getState()
  assert.equal(collectPanels(state.layout).length, 1)
  assert.equal(state.focusedPanel, h.rootPanel, '焦点回落到仅剩的面板')
})

test('layout.close：关掉最后一个面板只是清空它，视图一并关闭', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const res = await h.bus.dispatch('layout.close', { panelId: h.rootPanel }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.data.closedViewIds, [opened.data.viewId])

  const state = h.store.getState()
  assert.equal(collectPanels(state.layout).length, 1)
  assert.equal(collectPanels(state.layout)[0].viewId, null)
  assert.deepEqual(state.views, {})
  assert.equal(state.focusedPanel, h.rootPanel)
})

test('layout.setRatio：ratio 长度不符回 BAD_REQUEST', async () => {
  const h = harness()
  const split = await h.bus.dispatch('layout.split', { panelId: h.rootPanel, dir: 'row' }, 'ui')
  assert.equal(split.ok, true)
  if (!split.ok) return

  const good = await h.bus.dispatch('layout.setRatio', { splitId: split.data.splitId, ratio: [3, 1] }, 'mcp')
  assert.equal(good.ok, true)
  if (!good.ok) return
  assert.deepEqual(good.data.ratio, [0.75, 0.25])

  const bad = await h.bus.dispatch(
    'layout.setRatio',
    { splitId: split.data.splitId, ratio: [1, 1, 1] },
    'mcp',
  )
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.equal(bad.error.code, 'BAD_REQUEST')
})

/* ------------------------------------------------------------------ */
/* state.read                                                         */
/* ------------------------------------------------------------------ */

test('state.read：只读、不 bump rev、config 已脱敏', async () => {
  const h = harness()
  const connId = await connect(h)
  const revBefore = h.store.rev

  const res = await h.bus.dispatch('state.read', {}, 'mcp')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(h.store.rev, revBefore, '只读命令不产生新 rev')

  const conn = res.data.snapshot.connections[0]
  assert.equal(conn.id, connId)
  assert.equal(conn.config.driverId === 'postgres' && conn.config.password, '***')
  assert.equal(conn.config.driverId === 'postgres' && conn.config.url?.includes('example-password'), false)
})

test('state.read：include 与 viewId 能裁剪返回内容', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const partial = await h.bus.dispatch('state.read', { include: ['layout'] }, 'mcp')
  assert.equal(partial.ok, true)
  if (!partial.ok) return
  assert.deepEqual(partial.data.snapshot.connections, [])
  assert.deepEqual(partial.data.snapshot.views, [])

  const one = await h.bus.dispatch('state.read', { viewId: opened.data.viewId }, 'mcp')
  assert.equal(one.ok, true)
  if (!one.ok) return
  assert.equal(one.data.snapshot.views.length, 1)
  assert.equal(one.data.snapshot.views[0].panelId, h.rootPanel)

  const missing = await h.bus.dispatch('state.read', { viewId: asViewId('view_404') }, 'mcp')
  assert.equal(missing.ok, false)
})

/* ------------------------------------------------------------------ */
/* Command 日志                                                        */
/* ------------------------------------------------------------------ */

test('Command 日志：环形缓冲、口令脱敏、失败也记账', async () => {
  const h = harness()
  await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'mcp')
  await h.bus.dispatch('layout.focus', { panelId: 'panel_ghost' }, 'ui')

  const entries = h.bus.log.entries()
  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2],
  )

  const open = entries[0]
  const logged = open.input as { config: { password: string; url: string } }
  assert.equal(logged.config.password, '***', '口令绝不能进日志')
  assert.equal(logged.config.url.includes('example-password'), false)
  assert.equal(open.ok, true)
  assert.equal(typeof open.elapsedMs, 'number')

  assert.equal(entries[1].ok, false)
  assert.equal(entries[1].errorCode, 'NOT_FOUND')
})

/* ------------------------------------------------------------------ */
/* Store：patch 与脱敏                                                  */
/* ------------------------------------------------------------------ */

test('store：每条命令 rev +1，订阅者收到连续的 patch', async () => {
  const h = harness()
  const seen: { fromRev: number; rev: number }[] = []
  h.store.subscribe((change) => {
    seen.push({ fromRev: change.fromRev, rev: change.rev })
  })

  await connect(h)
  assert.ok(seen.length >= 2, 'conn.open 至少产生 connecting 与 ready 两批 patch')
  for (let i = 1; i < seen.length; i += 1) {
    assert.equal(seen[i].fromRev, seen[i - 1].rev, 'rev 必须连续，否则 renderer 会判定漏包')
  }
  assert.equal(seen[seen.length - 1].rev, h.store.rev)
})

test('store：广播出去的 patch 与快照都不含明文口令', async () => {
  const h = harness()
  const patches: unknown[] = []
  h.store.subscribe((change) => {
    patches.push(...redactPatches(change.patches))
  })
  await connect(h)

  const dumped = JSON.stringify(patches)
  assert.equal(dumped.includes('example-password'), false, 'patch 泄露了口令')
  assert.equal(dumped.includes('***'), true)

  const snapshot = JSON.stringify(redactWorkspace(h.store.getState()))
  assert.equal(snapshot.includes('example-password'), false, '快照泄露了口令')
  // 真源里必须留着明文，Connection Manager 重连要用
  assert.equal(JSON.stringify(h.store.getState()).includes('example-password'), true)
})

test('store：reduce 抛错时状态完全不动（原子性）', async () => {
  const h = harness()
  const connId = await connect(h)
  const before = h.store.getState()

  // panelId 不存在 → openView 在挂载前就抛错，此前登记的 view 必须一起作废
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'tree', connId }, panelId: asPanelId('panel_ghost') },
    'mcp',
  )
  assert.equal(res.ok, false)
  assert.equal(h.store.getState(), before, '失败的命令不产生任何新状态')
})

test('未注册的 handler 回 INTERNAL 而不是崩掉', async () => {
  const h = harness()
  const bare = new CommandBus({ store: h.store, deps: createUnavailableDeps() })
  const res = await bare.dispatch('layout.focus', { panelId: h.rootPanel }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'INTERNAL')
})

/* ------------------------------------------------------------------ */
/* 视图 id 品牌类型的使用示例（编译期即可验证）                              */
/* ------------------------------------------------------------------ */

test('品牌 id 在结果里保持类型', async () => {
  const h = harness()
  const connId = await connect(h)
  const res = await h.bus.dispatch('view.open', { spec: { kind: 'tree', connId } }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  const viewId: ViewId = res.data.viewId
  assert.equal(typeof viewId, 'string')
})
