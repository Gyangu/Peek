import type { ReactElement } from 'react'
import { RESULT_CACHE_MAX_BYTES, describeView, findPanel } from '@peek/core'
import { useBusyStore } from '../state/dispatch'
import { useCacheStats, useResult } from '../state/useResult'
import { useWorkspace, useWorkspaceStore } from '../state/workspaceStore'
import { formatBytes, formatCount, formatMs } from '../util/format'

/** 底部状态栏：连接状态、当前视图、查询耗时与行数、结果缓存水位 */
export function StatusBar(): ReactElement {
  const ws = useWorkspace()
  const stats = useCacheStats()
  const inflight = useBusyStore((s) => s.inflight)
  const resyncCount = useWorkspaceStore((s) => s.resyncCount)
  const bridgeMissing = useWorkspaceStore((s) => s.bridgeMissing)

  const panel = ws?.focusedPanel ? findPanel(ws.layout, ws.focusedPanel) : null
  const view = panel?.viewId && ws ? (ws.views[panel.viewId] ?? null) : null
  const resultId = view && 'resultId' in view ? view.resultId : undefined
  const snap = useResult(resultId)
  const meta = resultId && ws ? (ws.results[resultId] ?? null) : null

  const conns = ws ? Object.values(ws.connections) : []
  const readyCount = conns.filter((c) => c.status === 'ready').length
  const cachePct = Math.round((stats.bytes / RESULT_CACHE_MAX_BYTES) * 100)

  return (
    <div className="statusbar">
      <span className="seg">
        <span className={`dot ${readyCount > 0 ? 'ready' : ''}`} />
        {readyCount}/{conns.length} 已连接
      </span>

      {view ? (
        <>
          <span className="sep" />
          <span className="seg" title={describeView(view)}>
            {describeView(view)}
          </span>
        </>
      ) : null}

      {resultId ? (
        <>
          <span className="sep" />
          <span className="seg mono">
            {formatCount(snap.rowCount)} 行
            {meta?.elapsedMs !== undefined ? ` · ${formatMs(meta.elapsedMs)}` : ''}
            {snap.status === 'running' ? ' · 接收中' : ''}
          </span>
        </>
      ) : null}

      <span className="grow" />

      {inflight > 0 ? <span className="seg">命令在途 {inflight}</span> : null}

      <span className={cachePct > 85 ? 'seg warn' : 'seg'} title="renderer 结果缓存（上限 200MB，LRU 淘汰）">
        缓存 {formatBytes(stats.bytes)} / {cachePct}%
      </span>

      {resyncCount > 0 ? (
        <span className="seg warn" title="patch rev 断层后重新对齐的次数">
          重对齐 {resyncCount}
        </span>
      ) : null}

      {bridgeMissing ? <span className="seg err">preload 未就绪</span> : null}

      <span className="seg mono" title="Workspace 修订号">
        rev {ws?.rev ?? '—'}
      </span>
    </div>
  )
}
