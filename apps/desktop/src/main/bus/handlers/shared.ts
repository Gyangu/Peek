import type { Draft } from 'immer'
import {
  DEFAULT_PAGE_LIMIT,
  collectionRefLabel,
  findPanel,
  type Capability,
  type ConnId,
  type ConnectionState,
  type PanelId,
  type PanelNode,
  type QueryViewState,
  type ResultId,
  type TableViewState,
  type VectorViewState,
  type ViewId,
  type ViewOpenSpec,
  type ViewOpenResult,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { plain } from '../../store/workspace-store'
import { putView, removeView, runningResultOf, startResult } from '../../store/mutations'
import { fail } from '../failure'
import { firstEmptyPanel, firstPanel, setPanelView, splitPanel } from '../layout-ops'
import type { ReduceCtx } from '../types'

/** 向量视图默认 topK */
const DEFAULT_TOP_K = 10

/* ================================================================== */
/* 取用与校验                                                           */
/* ================================================================== */

export function requireConnection(draft: Draft<Workspace>, connId: ConnId): Draft<ConnectionState> {
  const conn = draft.connections[connId]
  if (!conn) fail('NOT_FOUND', `连接 ${connId} 不存在`)
  return conn
}

export function requireView(draft: Draft<Workspace>, viewId: ViewId): Draft<ViewState> {
  const view = draft.views[viewId]
  if (!view) fail('NOT_FOUND', `视图 ${viewId} 不存在`)
  return view
}

/** 连接必须已 ready 且具备某能力，否则给出可执行的错误（而不是让驱动层报奇怪的错） */
export function requireReadyWithCapability(conn: Draft<ConnectionState>, cap: Capability): void {
  if (conn.status !== 'ready') {
    fail('CONFLICT', `连接 ${conn.label} 当前状态是 ${conn.status}，还不能执行`, {
      detail: conn.error?.message,
    })
  }
  if (!conn.capabilities.includes(cap)) {
    fail('UNSUPPORTED_CAPABILITY', `驱动 ${conn.driverId} 不支持 ${cap}`)
  }
}

/** 能否自动取数：连上了且有对应能力。不满足时视图安静地停在 idle，不报错。 */
function canFetch(draft: Draft<Workspace>, connId: ConnId, cap: Capability): boolean {
  const conn = draft.connections[connId]
  return conn !== undefined && conn.status === 'ready' && conn.capabilities.includes(cap)
}

/**
 * 决定视图落到哪个面板：显式指定 → 焦点面板 → 第一个空面板 → 第一个面板。
 * 显式指定但不存在时报 NOT_FOUND（AI 用了过期的 panelId 要能立刻知道）。
 */
export function resolvePanel(draft: Draft<Workspace>, panelId?: PanelId): PanelNode {
  const layout = plain(draft.layout)
  if (panelId !== undefined) {
    const explicit = findPanel(layout, panelId)
    if (!explicit) fail('NOT_FOUND', `面板 ${panelId} 不存在`)
    return explicit
  }
  const focused = draft.focusedPanel
  if (focused !== null) {
    const hit = findPanel(layout, focused)
    if (hit) return hit
  }
  return firstEmptyPanel(layout) ?? firstPanel(layout) ?? fail('INTERNAL', '布局树里没有任何面板')
}

/* ================================================================== */
/* 开视图                                                              */
/* ================================================================== */

export interface OpenViewOptions {
  panelId?: PanelId
  /** 目标面板已有视图时：true 覆盖，false 另劈一个面板。默认 true */
  replace?: boolean
  /** 默认 true */
  focus?: boolean
  /** query 视图开完立刻执行 */
  run?: boolean
}

export function openView(
  draft: Draft<Workspace>,
  spec: ViewOpenSpec,
  ctx: ReduceCtx,
  opts: OpenViewOptions = {},
): ViewOpenResult {
  // 连接必须存在（可以还没 ready —— 视图先开着，连上再取数）
  requireConnection(draft, spec.connId)

  const target = resolvePanel(draft, opts.panelId)
  let panelId: PanelId = target.id

  if (target.viewId !== null) {
    if (opts.replace === false) {
      const outcome = splitPanel(plain(draft.layout), {
        panelId: target.id,
        dir: 'row',
        newPanelId: ctx.ids.panel(),
        newSplitId: ctx.ids.split(),
      })
      if (!outcome) fail('INTERNAL', `面板 ${target.id} 无法劈分`)
      draft.layout = outcome.layout as Draft<Workspace>['layout']
      panelId = outcome.panelId
    } else {
      closeView(draft, target.viewId, ctx)
    }
  }

  const view = buildViewState(spec, ctx.ids.view())
  putView(draft, view)

  const layout = setPanelView(plain(draft.layout), panelId, view.id)
  if (layout) draft.layout = layout as Draft<Workspace>['layout']
  if (opts.focus !== false) draft.focusedPanel = panelId

  const resultId = autoFetch(draft, view.id, ctx, opts.run === true)
  const result: ViewOpenResult = { viewId: view.id, panelId, kind: view.kind }
  if (resultId !== undefined) result.resultId = resultId
  return result
}

/** 关掉一个视图：从面板摘下、从 views 删除，顺手取消它还在跑的结果集 */
export function closeView(draft: Draft<Workspace>, viewId: ViewId, ctx: ReduceCtx): PanelId | null {
  const view = draft.views[viewId]
  if (!view) return null
  const running = runningResultOf(draft, viewId)
  if (running !== null) {
    // best-effort：取消失败不影响关视图这件事
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: running, soft: true })
  }
  return removeView(draft, viewId)
}

function buildViewState(spec: ViewOpenSpec, id: ViewId): ViewState {
  const base = { id, connId: spec.connId, status: 'idle' as const, ...(spec.title ? { title: spec.title } : {}) }
  switch (spec.kind) {
    case 'table':
      return {
        ...base,
        kind: 'table',
        ref: spec.ref,
        ...(spec.filter ? { filter: spec.filter } : {}),
        ...(spec.sort ? { sort: spec.sort } : {}),
        page: { offset: spec.offset ?? 0, limit: spec.limit ?? DEFAULT_PAGE_LIMIT },
      }
    case 'query':
      return { ...base, kind: 'query', text: spec.text ?? '' }
    case 'inspector':
      return { ...base, kind: 'inspector', ref: spec.ref }
    case 'tree':
      return { ...base, kind: 'tree', expanded: spec.expanded ?? [] }
    case 'vector':
      return {
        ...base,
        kind: 'vector',
        collection: spec.collection,
        ...(spec.queryVec ? { queryVec: spec.queryVec } : {}),
        ...(spec.queryText ? { queryText: spec.queryText } : {}),
        topK: spec.topK ?? DEFAULT_TOP_K,
        ...(spec.filter ? { filter: spec.filter } : {}),
      }
  }
}

/* ================================================================== */
/* 起取数                                                              */
/* ================================================================== */

/**
 * 视图开启/更新后的自动取数。
 * 连接没 ready 或驱动没这个能力时**不报错**，视图停在 idle，等连上再刷新。
 */
export function autoFetch(
  draft: Draft<Workspace>,
  viewId: ViewId,
  ctx: ReduceCtx,
  runQuery = false,
): ResultId | undefined {
  const view = draft.views[viewId]
  if (!view) return undefined
  switch (view.kind) {
    case 'table':
      return canFetch(draft, view.connId, 'collectionScan') ? startScan(draft, view, ctx) : undefined
    case 'vector':
      return view.queryVec !== undefined && canFetch(draft, view.connId, 'vectorSearch')
        ? startVectorSearch(draft, view, ctx)
        : undefined
    case 'query':
      return runQuery && view.text.trim() !== '' && canFetch(draft, view.connId, 'tabularQuery')
        ? startQuery(draft, view, ctx, {})
        : undefined
    default:
      return undefined
  }
}

/** 结果集元信息 + 视图状态的统一起手式 */
function beginResult(
  draft: Draft<Workspace>,
  view: Draft<ViewState>,
  ctx: ReduceCtx,
  summary: string,
): ResultId {
  // 换页 / 重跑之前，先把这个视图上一个仍在跑的结果集取消掉。
  // 必须在改写 view.resultId 之前做：一旦指向新结果集，旧的就再也没人能寻址取消
  // （query.cancel 只按 view.resultId 定位），它会继续占着服务端游标、连接和只读事务；
  // 而 renderer 那边没有任何视图给它上报视口，背压对它完全失效，
  // 这条孤儿流会全速跑完把 200MB 缓存预算吃掉（PLAN 第 8 节）。
  const prev = runningResultOf(draft, view.id)
  if (prev !== null) {
    // soft：取消失败只是告警，不能把本次取数命令判死
    ctx.plan({ type: 'cancel', connId: view.connId, resultId: prev, soft: true })
  }

  const resultId = ctx.ids.result()
  // 注意用 kind 判断而不是 `'resultId' in view`：属性可选，没赋过值时 in 是 false
  if (view.kind === 'table' || view.kind === 'query' || view.kind === 'vector') {
    view.resultId = resultId
  }
  view.status = 'loading'
  delete view.error
  startResult(draft, {
    id: resultId,
    connId: view.connId,
    viewId: view.id,
    status: 'running',
    rows: 0,
    startedAt: ctx.now,
    summary,
  })
  return resultId
}

export function startScan(draft: Draft<Workspace>, view: Draft<TableViewState>, ctx: ReduceCtx): ResultId {
  const ref = plain(view.ref)
  const resultId = beginResult(draft, view, ctx, `扫描 ${collectionRefLabel(ref)}`)
  ctx.plan({
    type: 'scan',
    connId: view.connId,
    viewId: view.id,
    resultId,
    ref,
    ...(view.filter ? { filter: plain(view.filter) } : {}),
    ...(view.sort ? { sort: plain(view.sort) } : {}),
    offset: view.page.offset,
    limit: view.page.limit,
    ...(view.cursorToken !== undefined ? { cursorToken: view.cursorToken } : {}),
  })
  return resultId
}

export function startVectorSearch(
  draft: Draft<Workspace>,
  view: Draft<VectorViewState>,
  ctx: ReduceCtx,
): ResultId {
  const resultId = beginResult(draft, view, ctx, `向量检索 ${view.collection} topK ${view.topK}`)
  ctx.plan({
    type: 'vectorSearch',
    connId: view.connId,
    viewId: view.id,
    resultId,
    collection: view.collection,
    ...(view.queryVec ? { queryVec: plain(view.queryVec) } : {}),
    topK: view.topK,
    ...(view.filter ? { filter: plain(view.filter) } : {}),
  })
  return resultId
}

export interface RunQueryOptions {
  params?: unknown[]
  maxRows?: number
  timeoutMs?: number
}

export function startQuery(
  draft: Draft<Workspace>,
  view: Draft<QueryViewState>,
  ctx: ReduceCtx,
  opts: RunQueryOptions,
): ResultId {
  const text = view.text
  const resultId = beginResult(draft, view, ctx, oneLine(text))
  ctx.plan({
    type: 'runQuery',
    connId: view.connId,
    viewId: view.id,
    resultId,
    text,
    ...(opts.params ? { params: opts.params } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  return resultId
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
