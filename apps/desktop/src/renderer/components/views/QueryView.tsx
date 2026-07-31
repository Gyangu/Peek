import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { QueryViewState } from '@peek/core'
import { dispatch } from '../../state/dispatch'
import { useConnection, useResultMeta } from '../../state/workspaceStore'
import { formatMs } from '../../util/format'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'

// CodeMirror 是整个包里最重的一块，切成独立 chunk 按需加载，
// 保证"冷启动到可交互 < 1.5s"（PLAN 第 8 节）不被编辑器拖累。
const SqlEditor = lazy(async () => {
  const m = await import('../SqlEditor')
  return { default: m.SqlEditor }
})

const MIN_EDITOR_H = 60
const MAX_EDITOR_H = 600

/** 自由查询视图：上编辑器、下结果表格 */
export function QueryView({ view }: { view: QueryViewState }): ReactElement {
  const { id: viewId, connId, text, resultId } = view
  const conn = useConnection(connId)
  const meta = useResultMeta(resultId)
  const [editorH, setEditorH] = useState(150)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const running = meta?.status === 'running' || view.status === 'loading'

  const run = useCallback(
    (sqlText: string) => {
      void dispatch('query.run', { viewId, text: sqlText })
    },
    [viewId],
  )

  const commit = useCallback(
    (sqlText: string) => {
      if (sqlText === text) return
      void dispatch('view.update', { viewId, patch: { kind: 'query', text: sqlText } })
    },
    [viewId, text],
  )

  const cancel = (): void => {
    void dispatch('query.cancel', { viewId })
  }

  const onResizeDown = (e: ReactMouseEvent): void => {
    dragRef.current = { startY: e.clientY, startH: editorH }
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const next = Math.min(MAX_EDITOR_H, Math.max(MIN_EDITOR_H, d.startH + (ev.clientY - d.startY)))
      setEditorH(next)
    }
    const onUp = (): void => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="query-view">
      <div className="toolbar">
        <button
          className="primary"
          disabled={running || conn?.status !== 'ready'}
          onClick={() => {
            run(text)
          }}
          title="⌘/Ctrl + Enter"
        >
          ▶ 执行
        </button>
        <button className="ghost" disabled={!running} onClick={cancel}>
          ■ 取消
        </button>
        <span className="sep" />
        <span>{conn?.label ?? connId}</span>
        {meta ? (
          <>
            <span className="sep" />
            <span className="mono">
              {meta.rows} 行 · {formatMs(meta.elapsedMs)}
            </span>
          </>
        ) : null}
        <span className="grow" />
        <span style={{ color: 'var(--fg-faint)' }}>⌘⏎ 执行</span>
      </div>

      <Suspense fallback={<div className="editor-wrap" style={{ height: editorH }} />}>
        <SqlEditor
          value={text}
          driverId={conn?.driverId ?? 'postgres'}
          onRun={run}
          onCommit={commit}
          height={editorH}
        />
      </Suspense>
      <div className="h-resizer" onMouseDown={onResizeDown} />

      <ViewError error={view.error} />

      <DataGrid connId={connId} resultId={resultId} emptyHint="⌘⏎ 执行查询" />
    </div>
  )
}
