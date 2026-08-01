import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnId, ConnectionState, SavedConnection } from '@peek/core'
import { defaultConnectionLabel } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../i18n'
import { connCanUse, connHas } from '../state/capabilities'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { useConnections } from '../state/workspaceStore'
import { ConnectDialog } from './ConnectDialog'
import { FirstRunGuide } from './FirstRunGuide'
import { McpSettingsDialog } from './McpSettingsDialog'

/**
 * Connection list sidebar.
 *
 * Two lists, and the split matters: **live** connections come from the Workspace
 * mirror, **saved** ones from `~/.peek/connections.json`. They are different
 * kinds of thing — one is a driver process that exists right now, the other is a
 * description of how to make one — and merging them into a single list with a
 * status dot would make "disconnect" and "forget" look like the same action.
 *
 * The saved list is read on demand rather than mirrored into the Workspace: it
 * is a file, it changes only when this window changes it, and a second copy kept
 * in sync through patches would buy nothing. Everything that edits it re-reads
 * it in the same breath — `conn.book.forget` even answers with the new list.
 */
export function Sidebar(): ReactElement {
  const t = useT()
  const conns = useConnections()
  const [dialog, setDialog] = useState<{ initial?: SavedConnection } | null>(null)
  const [settings, setSettings] = useState(false)
  const [active, setActive] = useState<ConnId | null>(null)
  const [saved, setSaved] = useState<SavedConnection[]>([])
  const [secretsAvailable, setSecretsAvailable] = useState(true)

  const reloadBook = useCallback((): void => {
    void dispatch('conn.book.list', {}).then((res) => {
      if (!res) return
      setSaved(res.entries)
      setSecretsAvailable(res.secretsAvailable)
    })
  }, [])

  // Re-read whenever the live list changes: an open writes the book, so the
  // moment a connection appears the saved list has a new (or refreshed) row.
  useEffect(() => {
    reloadBook()
  }, [reloadBook, conns.length])

  const openConnectDialog = useCallback((initial?: SavedConnection): void => {
    setDialog(initial ? { initial } : {})
  }, [])

  // A saved entry whose connection is already open is offered as an edit, not as
  // a second "connect" that would land on the same server twice.
  const liveLabels = new Set(conns.map((conn) => conn.label || defaultConnectionLabel(conn.config)))

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>{t('sidebar.connections')}</span>
        <button
          className="ghost"
          title={t('sidebar.settings')}
          aria-label={t('sidebar.settings')}
          onClick={() => {
            setSettings(true)
          }}
        >
          ⚙
        </button>
        <button
          className="ghost"
          title={t('sidebar.newConnection')}
          aria-label={t('sidebar.newConnection')}
          onClick={() => {
            openConnectDialog()
          }}
        >
          ＋
        </button>
      </div>
      <div className="sidebar-list">
        {conns.length === 0 && saved.length === 0 ? (
          <FirstRunGuide
            onConnect={() => {
              openConnectDialog()
            }}
            onOpenSettings={() => {
              setSettings(true)
            }}
          />
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

        {saved.length > 0 ? (
          <div className="sidebar-head" style={{ marginTop: 8 }}>
            <span>{t('sidebar.saved')}</span>
          </div>
        ) : null}
        {saved.map((entry) => (
          <SavedItem
            key={entry.id}
            entry={entry}
            alreadyOpen={liveLabels.has(entry.label)}
            onEdit={() => {
              openConnectDialog(entry)
            }}
            onForgotten={(entries) => {
              setSaved(entries)
            }}
          />
        ))}
        {saved.length > 0 && !secretsAvailable ? (
          // Not a warning about this session: it explains why every saved
          // connection will ask for its password again.
          <div className="empty-hint">{t('sidebar.noKeychain')}</div>
        ) : null}
      </div>

      {dialog ? (
        <ConnectDialog
          {...(dialog.initial === undefined ? {} : { initial: dialog.initial })}
          onClose={() => {
            setDialog(null)
            reloadBook()
          }}
        />
      ) : null}
      {settings ? (
        <McpSettingsDialog
          onClose={() => {
            setSettings(false)
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* A saved connection                                                  */
/* ------------------------------------------------------------------ */

interface SavedItemProps {
  entry: SavedConnection
  alreadyOpen: boolean
  onEdit: () => void
  onForgotten: (entries: SavedConnection[]) => void
}

/**
 * One row of the connection book.
 *
 * "Connect" here is the same `conn.open` the dialog sends, with the config
 * exactly as it came out of the file — main puts the stored credential back on
 * the way to the driver. That is what makes reuse a single click and still keeps
 * the password out of this process.
 */
function SavedItem({ entry, alreadyOpen, onEdit, onForgotten }: SavedItemProps): ReactElement {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const connect = (): void => {
    setBusy(true)
    void dispatch('conn.open', { config: entry.config, openTree: true }).finally(() => {
      setBusy(false)
    })
  }

  const forget = (): void => {
    void dispatch('conn.book.forget', { id: entry.id }).then((res) => {
      if (res) onForgotten(res.entries)
    })
  }

  return (
    <div className="conn-item">
      <div className="conn-row">
        <span className="dot idle" />
        <span className="conn-name">{entry.label}</span>
        {/* Driver id is an identifier and stays untranslated. */}
        <span style={{ color: 'var(--fg-faint)', fontSize: 10 }}>{entry.driverId}</span>
      </div>
      <div className="conn-sub">
        {entry.hasSecret ? t('sidebar.saved.withSecret') : t('sidebar.saved.noSecret')}
      </div>
      <div className="conn-actions">
        <button className="ghost" disabled={busy || alreadyOpen} onClick={connect}>
          {alreadyOpen ? t('sidebar.saved.open') : t('sidebar.saved.connect')}
        </button>
        <button className="ghost" onClick={onEdit}>
          {t('sidebar.saved.edit')}
        </button>
        {confirming ? (
          // Two clicks rather than a modal: forgetting drops a stored credential,
          // which cannot be undone, but it is also not destructive enough to
          // deserve a dialog in front of it.
          <button
            className="ghost"
            style={{ color: 'var(--err)' }}
            onClick={forget}
            onBlur={() => {
              setConfirming(false)
            }}
          >
            {t('sidebar.saved.forgetConfirm')}
          </button>
        ) : (
          <button
            className="ghost"
            onClick={() => {
              setConfirming(true)
            }}
          >
            {t('sidebar.saved.forget')}
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

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
