import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { QueryViewState } from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { useConnection, useResultMeta } from '../../state/workspaceStore'
import { formatCount, formatMs } from '../../util/format'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'
import { AutoRefreshControl, CacheGapNotice, CancelButton } from './ResultControls'
import { Button } from '../../ui/Button'

// CodeMirror is the heaviest thing in the bundle, so it gets its own lazily
// loaded chunk — the "cold start to interactive under 1.5s" budget (PLAN §8)
// must not be spent on an editor the user may never open.
const SqlEditor = lazy(async () => {
  const m = await import('../SqlEditor')
  return { default: m.SqlEditor }
})

const MIN_EDITOR_H = 60
const MAX_EDITOR_H = 600

/** Free-form query view: editor on top, result grid below. */
export function QueryView({ view }: { view: QueryViewState }): ReactElement {
  const { id: viewId, connId, text, resultId } = view
  const t = useT()
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
        {/* The title is key notation, not prose: the same symbols in every language. */}
        <Button
          variant="primary"
          action="query.run"
          disabled={running || conn?.status !== 'ready'}
          onClick={() => {
            run(text)
          }}
          title="⌘/Ctrl + Enter"
        >
          ▶ {t('query.run')}
        </Button>
        <CancelButton viewId={viewId} conn={conn} running={running} />
        <AutoRefreshControl
          viewId={viewId}
          kind="query"
          {...(view.autoRefreshMs !== undefined ? { autoRefreshMs: view.autoRefreshMs } : {})}
          {...(view.autoRefreshStoppedBy !== undefined ? { stoppedBy: view.autoRefreshStoppedBy } : {})}
        />
        <span className="sep" />
        <span>{conn?.label ?? connId}</span>
        {meta ? (
          <>
            <span className="sep" />
            <span className="mono">
              {t('grid.rows', { count: meta.rows, rows: formatCount(meta.rows) })}
              {` · ${formatMs(meta.elapsedMs)}`}
            </span>
          </>
        ) : null}
        <span className="grow" />
        <span style={{ color: 'var(--fg-faint)' }}>{t('query.runHint')}</span>
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
      {/* Re-running is the only refill a free-form query has: its rows came from a
          cursor that closed when the statement finished. */}
      <CacheGapNotice
        resultId={resultId}
        disabled={running || conn?.status !== 'ready'}
        onRefetch={() => {
          run(text)
        }}
      />

      <DataGrid connId={connId} view={view} resultId={resultId} emptyHint={t('query.empty')} />
    </div>
  )
}
