import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnectionState, SavedConnection } from '@peek/core'
import { connectionDetail } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { openSettings } from '../state/settingsDialogStore'
import { useConnections } from '../state/workspaceStore'
import { connectionMenuNodes, editableOf } from './connectionMenu'
import { buildConnectionRows, type ConnectionRow } from './connectionRows'
import { ConnectDialog } from './ConnectDialog'
import { FirstRunGuide } from './FirstRunGuide'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { useContextMenu } from '../ui/useContextMenu'

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
        <Button
          variant="ghost"
          title={t('sidebar.newConnection')}
          aria-label={t('sidebar.newConnection')}
          onClick={() => {
            openConnectDialog()
          }}
        >
          ＋
        </Button>
      </div>
      <div className="sidebar-list">
        {rows.length === 0 ? (
          <FirstRunGuide
            onConnect={() => {
              openConnectDialog()
            }}
            onOpenSettings={() => {
              openSettings('mcp')
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
 * One connection: a single 24px line, and a right-click menu.
 *
 * Click selects, double-click connects. Click-to-connect would be one gesture
 * shorter, but then a row that is *not* connected could never be selected.
 * Double-click to open is also what every other database client does.
 *
 * ## The action strip is gone
 *
 * Until 2026-08-03 a selected row unfolded a strip of five or six buttons.
 * `2026-08-02-connection-list.md` chose that on purpose, over a menu, because no
 * general popup-menu primitive existed and building one for the sidebar alone
 * was not worth it. `<Menu>` exists now — four surfaces needed it — so the acts
 * moved into it and the sidebar got its vertical space back.
 *
 * What that costs is that the acts are invisible until someone tries the
 * gesture. The tooltip says so; nothing else does. It was taken as a knowing
 * trade, not as an oversight — design record §3.2.
 *
 * The second line is drawn only when it has something to say — a driver's error,
 * or "connecting". A line reading "no password saved" under four rows out of five
 * is a repeated negative that carries no information; a stored password shows as
 * a key glyph instead, and only when there is one.
 */
function ConnectionRowItem({ row, active, onActivate, onEdit, onForgotten }: RowProps): ReactElement {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const menu = useContextMenu<null>()
  const { conn, entry } = row
  const status = conn?.status ?? 'idle'
  const config = conn?.config ?? entry?.config
  const editable = editableOf(row)

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

  const close = (): void => {
    if (conn === undefined) return
    invalidateConnection(conn.id)
    void dispatch('conn.close', { connId: conn.id })
  }

  return (
    <div
      className={active ? 'conn-item active' : 'conn-item'}
      onClick={onActivate}
      onDoubleClick={connect}
      // Right-click selects the row as well: the menu acts on this connection,
      // so the highlight must agree with it before the menu opens.
      onContextMenu={(e) => {
        if (!active) onActivate()
        menu.open(null)(e)
      }}
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
      {menu.state ? (
        <Menu
          label={t('menu.conn.label')}
          at={menu.state.at}
          nodes={connectionMenuNodes(
            row,
            t,
            {
              connect,
              disconnect: close,
              openTree: () => {
                if (conn) void dispatch('view.open', { spec: { kind: 'tree', connId: conn.id } })
              },
              openQuery: () => {
                if (conn) void dispatch('view.open', { spec: { kind: 'query', connId: conn.id } })
              },
              // No initial state: every field a plugin view needs has a default
              // in its own `readGraphState`-style reader, and seeding one here
              // would be the window guessing at a shape only the package knows.
              openPluginView: (pluginKind) => {
                if (conn) void dispatch('view.open', { spec: { kind: 'plugin', pluginKind, connId: conn.id } })
              },
              edit: () => {
                if (editable) onEdit(editable)
              },
              forget,
            },
            { busy },
          )}
          onClose={menu.close}
        />
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
  // The only place the row admits it has a menu. A hover-revealed "⋯" would say
  // it louder, but that is the action strip back in a narrower costume.
  lines.push(t('menu.hint'))
  return lines.join('\n')
}
