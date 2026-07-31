import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { PanelNode } from '@peek/core'
import { viewTitle } from '@peek/core'
import { dispatch } from '../state/dispatch'
import { useConnections, useFocusedPanel, useView } from '../state/workspaceStore'
import { ViewHost } from './ViewHost'

/** 平铺树的叶子：一个面板，最多挂一个视图 */
export function PanelView({ panel }: { panel: PanelNode }): ReactElement {
  const focusedPanel = useFocusedPanel()
  const view = useView(panel.viewId)
  const focused = focusedPanel === panel.id

  const onMouseDown = (): void => {
    if (!focused) void dispatch('layout.focus', { panelId: panel.id })
  }

  const split = (dir: 'row' | 'col') => (e: ReactMouseEvent): void => {
    e.stopPropagation()
    void dispatch('layout.split', { panelId: panel.id, dir })
  }

  const closeView = (e: ReactMouseEvent): void => {
    e.stopPropagation()
    if (panel.viewId) void dispatch('view.close', { viewId: panel.viewId })
    else void dispatch('layout.close', { panelId: panel.id })
  }

  return (
    <div className={focused ? 'panel focused' : 'panel'} onMouseDown={onMouseDown}>
      <div className="panel-head">
        {view ? <span className="panel-kind">{view.kind}</span> : null}
        <span className="panel-title">{view ? viewTitle(view) : '空面板'}</span>
        {view?.status === 'loading' ? <span style={{ color: 'var(--warn)' }}>●</span> : null}
        <button className="ghost" title="左右分屏" onClick={split('row')}>
          ⊞
        </button>
        <button className="ghost" title="上下分屏" onClick={split('col')}>
          ⊟
        </button>
        <button className="ghost" title={view ? '关闭视图' : '关闭面板'} onClick={closeView}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {panel.viewId ? <ViewHost viewId={panel.viewId} /> : <EmptyPanel panelId={panel.id} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function EmptyPanel({ panelId }: { panelId: PanelNode['id'] }): ReactElement {
  const conns = useConnections()
  const ready = conns.filter((c) => c.status === 'ready')

  if (ready.length === 0) {
    return (
      <div className="panel-empty">
        <div>空面板</div>
        <div style={{ color: 'var(--fg-faint)' }}>先在左侧连接一个数据库</div>
      </div>
    )
  }

  const first = ready[0]
  return (
    <div className="panel-empty">
      <div style={{ color: 'var(--fg-faint)' }}>空面板 · {first.label}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'query', connId: first.id },
              panelId,
            })
          }}
        >
          新建查询
        </button>
        <button
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'tree', connId: first.id },
              panelId,
            })
          }}
        >
          对象树
        </button>
      </div>
    </div>
  )
}
