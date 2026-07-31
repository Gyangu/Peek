import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { PanelNode, ViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import { useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import { useConnections, useFocusedPanel, useView } from '../state/workspaceStore'
import { ViewHost } from './ViewHost'

/** A leaf of the tiled layout: one panel, holding at most one view. */
export function PanelView({ panel }: { panel: PanelNode }): ReactElement {
  const t = useT()
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
        {/* The kind badge shows the raw `ViewState.kind`, which is the same token
            MCP addresses views by — an identifier, not a label. */}
        {view ? <span className="panel-kind">{view.kind}</span> : null}
        <span className="panel-title">{view ? panelTitle(t, view) : t('panel.empty')}</span>
        {view?.status === 'loading' ? <span style={{ color: 'var(--warn)' }}>●</span> : null}
        <button className="ghost" title={t('panel.splitRow')} onClick={split('row')}>
          ⊞
        </button>
        <button className="ghost" title={t('panel.splitCol')} onClick={split('col')}>
          ⊟
        </button>
        <button
          className="ghost"
          title={view ? t('panel.closeView') : t('panel.closePanel')}
          onClick={closeView}
        >
          ✕
        </button>
      </div>
      <div className="panel-body">
        {panel.viewId ? <ViewHost viewId={panel.viewId} /> : <EmptyPanel panelId={panel.id} />}
      </div>
    </div>
  )
}

/**
 * Title of a view, for the window only.
 *
 * Deliberately not `viewTitle()` from core: that one feeds MCP and the workspace
 * snapshot and is therefore fixed to English, whereas this line is read by a
 * human. An explicit `title` (set by whoever opened the view) always wins, and a
 * collection label such as `public.orders` is an identifier that stays as it is.
 */
function panelTitle(t: TFunction, view: ViewState): string {
  if (view.title) return view.title
  switch (view.kind) {
    case 'table':
      return collectionRefLabel(view.ref)
    case 'vector':
      return `${t('view.kind.vector')} · ${view.collection}`
    default:
      return t(`view.kind.${view.kind}`)
  }
}

/* ------------------------------------------------------------------ */

function EmptyPanel({ panelId }: { panelId: PanelNode['id'] }): ReactElement {
  const t = useT()
  const conns = useConnections()
  const ready = conns.filter((c) => c.status === 'ready')

  if (ready.length === 0) {
    return (
      <div className="panel-empty">
        <div>{t('panel.empty')}</div>
        <div style={{ color: 'var(--fg-faint)' }}>{t('panel.emptyHint')}</div>
      </div>
    )
  }

  const first = ready[0]
  return (
    <div className="panel-empty">
      <div style={{ color: 'var(--fg-faint)' }}>
        {t('panel.emptyWithConn', { label: first.label })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'query', connId: first.id },
              panelId,
            })
          }}
        >
          {t('panel.newQuery')}
        </button>
        <button
          onClick={() => {
            void dispatch('view.open', {
              spec: { kind: 'tree', connId: first.id },
              panelId,
            })
          }}
        >
          {t('panel.objectTree')}
        </button>
      </div>
    </div>
  )
}
