import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnId, ConnectionState } from '@peek/core'
import { defaultConnectionLabel } from '@peek/core'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { useConnections } from '../state/workspaceStore'
import { ConnectDialog } from './ConnectDialog'

/** 连接列表侧栏 */
export function Sidebar(): ReactElement {
  const conns = useConnections()
  const [dialog, setDialog] = useState(false)
  const [active, setActive] = useState<ConnId | null>(null)

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>连接</span>
        <button
          className="ghost"
          title="新建连接"
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
            还没有连接
            <br />
            点右上角 ＋ 新建
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
  const ready = conn.status === 'ready'
  const label = conn.label || defaultConnectionLabel(conn.config)

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
        <span style={{ color: 'var(--fg-faint)', fontSize: 10 }}>{conn.driverId}</span>
      </div>
      <div className="conn-sub">
        {conn.status === 'error' && conn.error
          ? conn.error.message
          : conn.serverInfo
            ? `${conn.serverInfo.flavor ?? conn.driverId} ${conn.serverInfo.version}`
            : statusText(conn.status)}
      </div>
      {active ? (
        <div className="conn-actions">
          <button className="ghost" disabled={!ready} onClick={openTree}>
            对象树
          </button>
          <button className="ghost" disabled={!ready} onClick={openQuery}>
            查询
          </button>
          <button className="ghost" onClick={close}>
            断开
          </button>
        </div>
      ) : null}
    </div>
  )
}

function statusText(s: ConnectionState['status']): string {
  switch (s) {
    case 'idle':
      return '未连接'
    case 'connecting':
      return '连接中…'
    case 'ready':
      return '已连接'
    case 'error':
      return '连接失败'
  }
}
