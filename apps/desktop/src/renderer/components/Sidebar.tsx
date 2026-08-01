import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnId, ConnectionState } from '@peek/core'
import { defaultConnectionLabel } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../i18n'
import { connCanUse, connHas } from '../state/capabilities'
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
  const label = conn.label || defaultConnectionLabel(conn.config)
  // Two different questions, and the actions need both: `connHas` decides
  // whether a control is drawn at all (redis will never have a SQL editor, so
  // offering one and greying it out would be a promise the driver cannot keep),
  // `connCanUse` decides whether it is clickable yet.
  const canTree = connCanUse(conn, 'introspect')
  const hasQuery = connHas(conn, 'tabularQuery')
  const canQuery = connCanUse(conn, 'tabularQuery')
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
          <button className="ghost" disabled={!canTree} onClick={openTree}>
            {t('sidebar.action.tree')}
          </button>
          {hasQuery ? (
            <button className="ghost" disabled={!canQuery} onClick={openQuery}>
              {t('sidebar.action.query')}
            </button>
          ) : (
            // Not a disabled button: "temporarily unavailable" and "this database
            // has no query language" are different statements, and only the
            // second one is true here. The driver id is an identifier, untranslated.
            <span
              style={{ color: 'var(--fg-faint)' }}
              title={t('sidebar.action.noQueryTitle', { driverId: conn.driverId })}
            >
              {t('sidebar.action.noQuery')}
            </span>
          )}
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
