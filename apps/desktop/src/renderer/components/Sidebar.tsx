import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnectionState, SavedConnection } from '@peek/core'
import { connectionDetail } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../i18n'
import { connCanUse, connHas } from '../state/capabilities'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { useConnections } from '../state/workspaceStore'
import { buildConnectionRows, type ConnectionRow } from './connectionRows'
import { ConnectDialog } from './ConnectDialog'
import { FirstRunGuide } from './FirstRunGuide'
import { McpSettingsDialog } from './McpSettingsDialog'

/**
 * Connection list sidebar.
 *
 * **One** list. A connection is a persistent thing the user has; whether a driver
 * process exists for it right now is a *state* of that thing, not a different
 * kind of thing — so the live connections and the connection book are merged into
 * a single row per connection by `buildConnectionRows`.
 *
 * The objection this replaces was that a merged list would make "disconnect" and
 * "forget" look like the same action. They never appear together: a row with a
 * live connection offers disconnect and no remove, a row without one offers
 * remove and no disconnect. See docs/design/2026-08-02-connection-list.md.
 *
 * The book is read on demand rather than mirrored into the Workspace: it is a
 * file, it changes only when this window changes it, and a second copy kept in
 * sync through patches would buy nothing. Everything that edits it re-reads it in
 * the same breath — `conn.book.forget` even answers with the new list.
 */
export function Sidebar(): ReactElement {
  const t = useT()
  const conns = useConnections()
  const [dialog, setDialog] = useState<{ initial?: SavedConnection } | null>(null)
  const [settings, setSettings] = useState(false)
  const [active, setActive] = useState<string | null>(null)
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

  const rows = buildConnectionRows(conns, saved)

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
        {rows.length === 0 ? (
          <FirstRunGuide
            onConnect={() => {
              openConnectDialog()
            }}
            onOpenSettings={() => {
              setSettings(true)
            }}
          />
        ) : (
          rows.map((row) => (
            <ConnectionRowItem
              key={row.key}
              row={row}
              active={active === row.key}
              onActivate={() => {
                setActive(active === row.key ? null : row.key)
              }}
              onEdit={openConnectDialog}
              onForgotten={(entries) => {
                setSaved(entries)
              }}
            />
          ))
        )}
        {rows.length > 0 && !secretsAvailable ? (
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
/* One row                                                             */
/* ------------------------------------------------------------------ */

interface RowProps {
  row: ConnectionRow
  active: boolean
  onActivate: () => void
  onEdit: (initial: SavedConnection) => void
  onForgotten: (entries: SavedConnection[]) => void
}

/**
 * One connection: a single 24px line, and an action strip while it is selected.
 *
 * Click selects, double-click connects. Click-to-connect would be one gesture
 * shorter, but then a row that is *not* connected could never be selected, and
 * edit and remove would have nowhere to live short of a hover menu. Double-click
 * to open is also what every other database client does.
 *
 * The second line is drawn only when it has something to say — a driver's error,
 * or "connecting". A line reading "no password saved" under four rows out of five
 * is a repeated negative that carries no information; a stored password shows as
 * a key glyph instead, and only when there is one.
 */
function ConnectionRowItem({ row, active, onActivate, onEdit, onForgotten }: RowProps): ReactElement {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { conn, entry } = row
  const status = conn?.status ?? 'idle'
  const config = conn?.config ?? entry?.config
  // A failed open is never remembered, so an error row usually has no entry to
  // seed the dialog from. The live config is the same shape, redacted — which is
  // exactly what the dialog expects to unpack.
  const editable: SavedConnection | undefined =
    entry ??
    (conn === undefined
      ? undefined
      : {
          id: conn.id,
          driverId: conn.driverId,
          label: row.label,
          config: conn.config,
          hasSecret: false,
          createdAt: '',
          lastUsedAt: '',
        })

  const connect = (): void => {
    if (conn !== undefined || entry === undefined || busy) return
    setBusy(true)
    void dispatch('conn.open', { config: entry.config, openTree: true }).finally(() => {
      setBusy(false)
    })
  }

  const forget = (): void => {
    if (entry === undefined) return
    void dispatch('conn.book.forget', { id: entry.id }).then((res) => {
      if (res) onForgotten(res.entries)
    })
  }

  return (
    <div
      className={active ? 'conn-item active' : 'conn-item'}
      onClick={onActivate}
      onDoubleClick={connect}
      title={rowTitle(t, row)}
    >
      <div className="conn-row">
        <span className={`dot ${status}`} />
        <span className="conn-name">{row.label}</span>
        {entry?.hasSecret ? (
          <span className="conn-key" title={t('sidebar.secretStored')}>
            🔑
          </span>
        ) : null}
        {/* Driver id is an identifier and stays untranslated. */}
        <span className="conn-driver">{config?.driverId ?? ''}</span>
      </div>
      <SubLine conn={conn} />
      {active ? (
        <div className="conn-actions">
          {conn === undefined ? (
            <>
              <button className="ghost" disabled={busy} onClick={connect}>
                {t('sidebar.action.connect')}
              </button>
              <EditButton editable={editable} onEdit={onEdit} />
              {confirming ? (
                // Two clicks rather than a modal: removing an entry drops a stored
                // credential, which cannot be undone, but it is also not
                // destructive enough to deserve a dialog in front of it.
                <button
                  className="ghost"
                  style={{ color: 'var(--err)' }}
                  onClick={forget}
                  onBlur={() => {
                    setConfirming(false)
                  }}
                >
                  {t('sidebar.action.removeConfirm')}
                </button>
              ) : (
                <button
                  className="ghost"
                  onClick={() => {
                    setConfirming(true)
                  }}
                >
                  {t('sidebar.action.remove')}
                </button>
              )}
            </>
          ) : (
            <LiveActions conn={conn} editable={editable} onEdit={onEdit} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Connecting and failed have something to report; connected and idle do not. */
function SubLine({ conn }: { conn: ConnectionState | undefined }): ReactElement | null {
  const t = useT()
  const errorText = useErrorText(conn?.error)
  if (conn === undefined) return null
  if (conn.status === 'connecting') return <div className="conn-sub">{t('sidebar.status.connecting')}</div>
  if (conn.status === 'error') {
    // A failed connection usually carries the driver's own words: `useErrorText`
    // shows those verbatim and localizes only the errors peek itself wrote.
    return <div className="conn-sub">{conn.error ? errorText : t('sidebar.status.error')}</div>
  }
  return null
}

function EditButton({
  editable,
  onEdit,
}: {
  editable: SavedConnection | undefined
  onEdit: (initial: SavedConnection) => void
}): ReactElement | null {
  const t = useT()
  if (editable === undefined) return null
  return (
    <button
      className="ghost"
      onClick={() => {
        onEdit(editable)
      }}
    >
      {t('sidebar.action.edit')}
    </button>
  )
}

interface LiveActionProps {
  conn: ConnectionState
  editable: SavedConnection | undefined
  onEdit: (initial: SavedConnection) => void
}

/**
 * What a row with a driver process behind it offers.
 *
 * No "remove" here: an entry cannot be forgotten while its connection is open —
 * the next successful open would write it straight back — and leaving the two out
 * of each other's way is what keeps "disconnect" and "remove" from reading as the
 * same action.
 */
function LiveActions({ conn, editable, onEdit }: LiveActionProps): ReactElement {
  const t = useT()
  // Two different questions, and the actions need both: `connHas` decides
  // whether a control is drawn at all (redis will never have a SQL editor, so
  // offering one and greying it out would be a promise the driver cannot keep),
  // `connCanUse` decides whether it is clickable yet.
  const canTree = connCanUse(conn, 'introspect')
  const hasQuery = connHas(conn, 'tabularQuery')
  const canQuery = connCanUse(conn, 'tabularQuery')

  const close = (): void => {
    invalidateConnection(conn.id)
    void dispatch('conn.close', { connId: conn.id })
  }

  return (
    <>
      {conn.status === 'error' ? null : (
        <>
          <button
            className="ghost"
            disabled={!canTree}
            onClick={() => {
              void dispatch('view.open', { spec: { kind: 'tree', connId: conn.id } })
            }}
          >
            {t('sidebar.action.tree')}
          </button>
          {hasQuery ? (
            <button
              className="ghost"
              disabled={!canQuery}
              onClick={() => {
                void dispatch('view.open', { spec: { kind: 'query', connId: conn.id } })
              }}
            >
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
        </>
      )}
      <button className="ghost" onClick={close}>
        {t('sidebar.action.disconnect')}
      </button>
      <EditButton editable={editable} onEdit={onEdit} />
    </>
  )
}

/**
 * The tooltip: what the row had to leave out.
 *
 * The name is the part that tells connections apart — a file name, a database, a
 * host — so the full path or address, and the server it turned out to be, live
 * here instead of on a second line nobody needs most of the time.
 */
function rowTitle(t: TFunction, row: ConnectionRow): string {
  const { conn, entry } = row
  const config = conn?.config ?? entry?.config
  const lines = [config === undefined ? row.label : connectionDetail(config)]
  if (conn?.serverInfo) lines.push(`${conn.serverInfo.flavor ?? conn.driverId} ${conn.serverInfo.version}`)
  else if (conn === undefined) lines.push(t('sidebar.connectHint'))
  return lines.join('\n')
}
