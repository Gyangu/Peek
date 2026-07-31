import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnId, ConnectionState } from '@peek/core'
import { defaultConnectionLabel } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { useConnections } from '../state/workspaceStore'
import { ConnectDialog } from './ConnectDialog'

/** Connection list sidebar. */
export function Sidebar(): ReactElement {
  const t = useT()
  const conns = useConnections()
  const [dialog, setDialog] = useState(false)
  const [active, setActive] = useState<ConnId | null>(null)

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>{t('sidebar.connections')}</span>
        <button
          className="ghost"
          title={t('sidebar.newConnection')}
          onClick={() => {
            setDialog(true)
          }}
        >
          ＋
        </button>
      </div>
      <div className="sidebar-list">
        {conns.length === 0 ? (
          <div className="empty-hint">
            {t('sidebar.empty')}
            <br />
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          conns.map((c) => (
            <ConnectionItem
              key={c.id}
              conn={c}
              active={active === c.id}
              onActivate={() => {
                setActive(active === c.id ? null : c.id)
              }}
            />
          ))
        )}
      </div>
      {dialog ? (
        <ConnectDialog
          onClose={() => {
            setDialog(false)
          }}
        />
      ) : null}
    </div>
  )
}

interface ItemProps {
  conn: ConnectionState
  active: boolean
  onActivate: () => void
}

function ConnectionItem({ conn, active, onActivate }: ItemProps): ReactElement {
  const t = useT()
  const ready = conn.status === 'ready'
  const label = conn.label || defaultConnectionLabel(conn.config)
  // A failed connection usually carries the driver's own words: `useErrorText`
  // shows those verbatim and localizes only the errors peek itself wrote.
  const errorText = useErrorText(conn.error)

  const openTree = (): void => {
    void dispatch('view.open', { spec: { kind: 'tree', connId: conn.id } })
  }
  const openQuery = (): void => {
    void dispatch('view.open', { spec: { kind: 'query', connId: conn.id } })
  }
  const close = (): void => {
    invalidateConnection(conn.id)
    void dispatch('conn.close', { connId: conn.id })
  }

  return (
    <div className={active ? 'conn-item active' : 'conn-item'} onClick={onActivate}>
      <div className="conn-row">
        <span className={`dot ${conn.status}`} />
        <span className="conn-name">{label}</span>
        {/* Driver id and server version are identifiers and stay untranslated. */}
        <span style={{ color: 'var(--fg-faint)', fontSize: 10 }}>{conn.driverId}</span>
      </div>
      <div className="conn-sub">
        {conn.status === 'error' && conn.error
          ? errorText
          : conn.serverInfo
            ? `${conn.serverInfo.flavor ?? conn.driverId} ${conn.serverInfo.version}`
            : statusText(t, conn.status)}
      </div>
      {active ? (
        <div className="conn-actions">
          <button className="ghost" disabled={!ready} onClick={openTree}>
            {t('sidebar.action.tree')}
          </button>
          <button className="ghost" disabled={!ready} onClick={openQuery}>
            {t('sidebar.action.query')}
          </button>
          <button className="ghost" onClick={close}>
            {t('sidebar.action.disconnect')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function statusText(t: TFunction, s: ConnectionState['status']): string {
  switch (s) {
    case 'idle':
      return t('sidebar.status.idle')
    case 'connecting':
      return t('sidebar.status.connecting')
    case 'ready':
      return t('sidebar.status.ready')
    case 'error':
      return t('sidebar.status.error')
  }
}
