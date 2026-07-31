import type { Draft } from 'immer'
import type {
  Capability,
  ColumnDef,
  ConnId,
  ConnStatus,
  ConnectionState,
  PanelId,
  PeekError,
  ResultId,
  ResultMeta,
  ServerInfo,
  ViewId,
  ViewState,
  Workspace,
} from '@peek/core'
import { collectPanels } from '@peek/core'
import { clearViewFromPanels } from '../bus/layout-ops'
import { plain } from './workspace-store'

/**
 * 纯 draft 变更函数集合。
 *
 * 命令 handler 的"纯状态阶段"和 Connection Manager / driver host 事件回填
 * 都只能通过这些函数改真源，保证状态机转换只有一处实现。
 */

/** 结果集元信息保留上限：只是元信息（不含数据本体），超了从最老的已结束结果开始丢 */
export const MAX_RESULT_META = 200

/* ------------------------------------------------------------------ */
/* 连接                                                                */
/* ------------------------------------------------------------------ */

export function putConnection(draft: Draft<Workspace>, conn: ConnectionState): void {
  draft.connections[conn.id] = conn as Draft<ConnectionState>
}

export interface ConnectionReadyPatch {
  capabilities?: Capability[]
  serverInfo?: ServerInfo
  pid?: number
  readyAt?: number
  error?: PeekError
}

/** 连接状态机迁移：idle → connecting → ready / error */
export function setConnectionStatus(
  draft: Draft<Workspace>,
  connId: ConnId,
  status: ConnStatus,
  patch: ConnectionReadyPatch = {},
): void {
  const conn = draft.connections[connId]
  if (!conn) return
  conn.status = status
  if (patch.capabilities) conn.capabilities = [...patch.capabilities]
  if (patch.serverInfo) conn.serverInfo = patch.serverInfo
  if (patch.pid !== undefined) conn.pid = patch.pid
  if (patch.readyAt !== undefined) conn.readyAt = patch.readyAt
  if (patch.error) conn.error = patch.error
  else if (status !== 'error') delete conn.error
}

/**
 * 移除连接。closeViews 为 true 时连带关掉它名下所有视图（并从面板上摘掉）。
 * 返回被关掉的视图 id，供命令结果与副作用（取消在跑的结果集）使用。
 */
export function removeConnection(
  draft: Draft<Workspace>,
  connId: ConnId,
  closeViews: boolean,
): { closedViewIds: ViewId[]; abortedResultIds: ResultId[] } {
  const closedViewIds: ViewId[] = []
  if (closeViews) {
    for (const view of Object.values(draft.views)) {
      if (view.connId === connId) closedViewIds.push(view.id)
    }
    for (const viewId of closedViewIds) removeView(draft, viewId)
  }

  const abortedResultIds: ResultId[] = []
  for (const meta of Object.values(draft.results)) {
    if (meta.connId !== connId) continue
    if (meta.status === 'running') {
      abortedResultIds.push(meta.id)
      meta.status = 'cancelled'
    }
  }

  delete draft.connections[connId]
  return { closedViewIds, abortedResultIds }
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

export function putView(draft: Draft<Workspace>, view: ViewState): void {
  draft.views[view.id] = view as Draft<ViewState>
}

/** 删除视图并把它从所在面板上摘掉（面板本身保留，只是变空） */
export function removeView(draft: Draft<Workspace>, viewId: ViewId): PanelId | null {
  const detached = clearViewFromPanels(plain(draft.layout), viewId)
  if (detached.panelId !== null) draft.layout = detached.layout as Draft<Workspace>['layout']
  delete draft.views[viewId]
  return detached.panelId
}

/** 视图当前挂着的、仍在跑的结果集（关视图/换视图时要顺手取消） */
export function runningResultOf(draft: Draft<Workspace>, viewId: ViewId): ResultId | null {
  const view = draft.views[viewId]
  if (!view || !('resultId' in view) || view.resultId === undefined) return null
  const meta = draft.results[view.resultId]
  return meta && meta.status === 'running' ? meta.id : null
}

/* ------------------------------------------------------------------ */
/* 结果集元信息（数据本体永远只走 MessagePort，这里只存控制面）              */
/* ------------------------------------------------------------------ */

export function startResult(draft: Draft<Workspace>, meta: ResultMeta): void {
  draft.results[meta.id] = meta as Draft<ResultMeta>
  pruneResults(draft)
}

export function setResultSchema(draft: Draft<Workspace>, resultId: ResultId, schema: ColumnDef[]): void {
  const meta = draft.results[resultId]
  if (!meta) return
  meta.schema = schema as Draft<ColumnDef[]>
}

export function setResultProgress(draft: Draft<Workspace>, resultId: ResultId, rows: number): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.rows = rows
}

export interface ResultDonePatch {
  rows: number
  elapsedMs: number
  truncated?: boolean
  nextCursor?: string
}

export function finishResult(draft: Draft<Workspace>, resultId: ResultId, done: ResultDonePatch): void {
  const meta = draft.results[resultId]
  if (!meta) return
  meta.status = 'done'
  meta.rows = done.rows
  meta.elapsedMs = done.elapsedMs
  if (done.truncated !== undefined) meta.truncated = done.truncated

  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'ready'
    delete view.error
    // 续拉游标只对集合浏览有意义（redis SCAN / qdrant scroll）
    if (view.kind === 'table') view.cursorToken = done.nextCursor
  }
}

export interface ResultPausePatch {
  rows: number
  elapsedMs: number
  reason: string
}

/**
 * 结果流**按设计暂停**（背压空闲超时，驱动已主动释放服务端游标与连接）。
 *
 * 这是 `done` 的兄弟而不是 `error` 的兄弟：
 * - 已加载的行**全部有效**，视图保持 ready（绿色），不弹红色错误条；
 * - 打上 truncated + resumable，读方（UI / MCP）据此提示"重新执行可继续取数"。
 *
 * 唯一的例外：已经进过终态的结果集不再被暂停覆盖（比如取消与暂停竞态时，
 * 先到的那个说了算，不能让"取消"被改写成"暂停"）。
 */
export function pauseResult(
  draft: Draft<Workspace>,
  resultId: ResultId,
  patch: ResultPausePatch,
): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.status = 'paused'
  meta.rows = patch.rows
  meta.elapsedMs = patch.elapsedMs
  meta.truncated = true
  meta.resumable = true
  meta.pausedReason = patch.reason
  delete meta.error

  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'ready'
    delete view.error
  }
}

/** 该视图当前是否正挂着这个结果集（inspector / tree 没有 resultId 字段） */
function ownsResult(view: Draft<ViewState>, resultId: ResultId): boolean {
  return 'resultId' in view && view.resultId === resultId
}

/**
 * 结果流异常终止。
 *
 * CANCELLED 走与 cancelResult 完全一致的判定：**取消不是错误**。
 * driver host 的 StreamPump 被取消时唯一的终止途径就是发 result.error(CANCELLED)，
 * 这条路径必然会到达这里；若在这里把视图打成 error，用户点了"取消"却看到红色错误条，
 * MCP 的 read_workspace 也会把视图汇报成 status=error，让 AI 误判成查询失败。
 * 结果元信息与视图状态的判定只有这一处，保证两者不会给出相反结论。
 */
export function failResult(draft: Draft<Workspace>, resultId: ResultId, error: PeekError): void {
  const cancelled = error.code === 'CANCELLED'
  const meta = draft.results[resultId]
  if (meta) {
    meta.status = cancelled ? 'cancelled' : 'error'
    meta.error = error
  }
  const viewId = meta?.viewId
  if (viewId === undefined) return
  const view = draft.views[viewId]
  if (!view || !ownsResult(view, resultId)) return
  if (cancelled) {
    view.status = 'idle'
    delete view.error
  } else {
    view.status = 'error'
    view.error = error
  }
}

export function cancelResult(draft: Draft<Workspace>, resultId: ResultId): void {
  const meta = draft.results[resultId]
  if (!meta || meta.status !== 'running') return
  meta.status = 'cancelled'
  const view = draft.views[meta.viewId]
  if (view && ownsResult(view, resultId)) {
    view.status = 'idle'
    delete view.error
  }
}

/** 只保留最近的结果元信息；正在跑的和还被视图引用的永远不丢 */
export function pruneResults(draft: Draft<Workspace>, max: number = MAX_RESULT_META): void {
  const all = Object.values(draft.results)
  if (all.length <= max) return

  const referenced = new Set<string>()
  for (const view of Object.values(draft.views)) {
    if ('resultId' in view && view.resultId !== undefined) referenced.add(view.resultId)
  }

  const droppable = all
    .filter((m) => m.status !== 'running' && !referenced.has(m.id))
    .sort((a, b) => a.startedAt - b.startedAt)

  let overflow = all.length - max
  for (const meta of droppable) {
    if (overflow <= 0) break
    delete draft.results[meta.id]
    overflow -= 1
  }
}

/* ------------------------------------------------------------------ */
/* 焦点                                                                */
/* ------------------------------------------------------------------ */

/** 焦点面板被移除后的兜底：回落到树里的第一个面板 */
export function ensureFocusedPanel(draft: Draft<Workspace>): void {
  const panels = collectPanels(plain(draft.layout))
  if (panels.length === 0) {
    draft.focusedPanel = null
    return
  }
  const focused = draft.focusedPanel
  if (focused !== null && panels.some((p) => p.id === focused)) return
  draft.focusedPanel = panels[0].id
}
