import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnectionState, SavedConnection } from '@peek/core'
import { manifestDriverIds } from '../../drivers/manifests'
import { useErrorText, useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import { invalidateConnection } from '../state/namespaceStore'
import { usePackagesRevision } from '../state/packagesStore'
import { openSettings } from '../state/settingsDialogStore'
import { setSidebarCollapsed, useSidebarStore } from '../state/sidebarStore'
import { useConnections } from '../state/workspaceStore'
import { connectionMenuNodes, editableOf } from './connectionMenu'
import { buildConnectionRows, type ConnectionRow } from './connectionRows'
import { ConnectDialog } from './ConnectDialog'
import { FirstRunGuide } from './FirstRunGuide'
import { CONN_DOT, LIST_HEAD, LIST_HEAD_TITLE } from './shellClasses'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { useContextMenu } from '../ui/useContextMenu'

/**
 * The sidebar's box, minus its width.
 *
 * The two widths sit on the branches below rather than here: 240px expanded,
 * and 28px collapsed, which is a strip rather than an absence — the toggle stays
 * on the same pixel in both states, so collapsing and expanding are two clicks
 * on one button rather than a button that moves elsewhere when you use it. See
 * `design/2026-08-04-sidebar-collapse.md`, and `RAIL_BOX` in
 * `components/chat/ChatSessionsRail.tsx` for the mirror of it on the other side.
 */
const SIDEBAR_BOX = 'flex min-h-0 flex-none flex-col border-r border-border bg-bg-1'

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
 *
 * ## Collapsing
 *
 * A 28px strip, not an absence — the same shape as the conversation rail on the
 * other side, and for the same reason: the toggle stays at the same pixel in both
 * states, so collapsing and expanding are two clicks on one button rather than a
 * button that moves somewhere else the moment you use it. Wide tables are what
 * this is for; a 40-column result in a 1440px window is already scrolling
 * sideways. See docs/design/2026-08-04-sidebar-collapse.md.
 *
 * The book is still re-read while collapsed. It is one small file and the effect
 * only fires when the live list changes, so skipping it would trade nothing for a
 * list that can be stale at the moment it comes back into view.
 */
export function Sidebar(): ReactElement {
  const t = useT()
  const conns = useConnections()
  // The new-connection controls below are drawn from what is installed, so this
  // subscription is what makes installing or uninstalling a package while the
  // window is open change them. Same reason `ConnectDialog` takes it; the value
  // is deliberately unused.
  usePackagesRevision()
  const collapsed = useSidebarStore((s) => s.collapsed)
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
  /**
   * Whether there is any database to start a connection *to*.
   *
   * False is a legal state since Phase C made every package uninstallable
   * (design 2026-08-07 decision 1), and both entrances below are disabled in it
   * rather than opening a dialog with an empty picker and no fields — which is
   * what a rendering fault looks like (design 2026-08-11 §2.2).
   *
   * This says *what*; the *why and where* is already on the error centre, where
   * `packageLoadNotices` puts "No database packages are installed" with the
   * directory it read. Two surfaces, one fact, and no second judgement about it
   * implemented here.
   */
  const canConnect = manifestDriverIds().length > 0

  if (collapsed) {
    return (
      <div className={`${SIDEBAR_BOX} w-7`}>
        {/* The collapsed sidebar is 28px of chrome and this is all of it, so the
            handle is meant to fill the width rather than sit as a 24px square
            inside. Layout only — `ghost` still says what it looks like, and the
            height stays the size rung's: a rule that quietly made one control
            30px while every other `md` is 24px is how a scale stops meaning
            anything.

            **Measured, and it does not currently work.** In Electron this button
            comes out 24×24 inside the 28px strip: the width class here and the
            one the icon size rung states are two classes from one utility family
            on one element, so which wins is Tailwind's emission order and not
            this file's — the rung wins. The conversation rail's handle is the
            same shape and has the same gap. Recorded rather than fixed because
            the fix is either a change to `ui/spec.ts` or a wrapper element, and
            both are outside the round that found it. See the migration record's
            §12.3. */}
        <Button
          variant="ghost"
          icon
          className="w-full"
          label={t('sidebar.expand')}
          aria-expanded={false}
          onClick={() => {
            setSidebarCollapsed(false)
          }}
        >
          ›
        </Button>
      </div>
    )
  }

  return (
    <div className={`${SIDEBAR_BOX} w-60`}>
      <div className={LIST_HEAD}>
        {/* First, not last — the mirror of the rail's trailing `›`. This panel
            closes leftwards, so its outer edge is the left one, and that is the
            only position where this button and the `›` that reopens it are the
            same pixel. Putting it at the head's right end reads as symmetric with
            the rail and measures as a 200px jump. */}
        <Button
          variant="ghost"
          icon
          label={t('sidebar.collapse')}
          aria-expanded={true}
          onClick={() => {
            setSidebarCollapsed(true)
          }}
        >
          ‹
        </Button>
        <span className={LIST_HEAD_TITLE}>{t('sidebar.connections')}</span>
        <Button
          variant="ghost"
          title={canConnect ? t('sidebar.newConnection') : t('connect.noPackages')}
          aria-label={t('sidebar.newConnection')}
          disabled={!canConnect}
          onClick={() => {
            openConnectDialog()
          }}
        >
          ＋
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-tight">
        {rows.length === 0 ? (
          <FirstRunGuide
            canConnect={canConnect}
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
          <div className="px-snug py-loose text-center leading-prose text-fg-faint">{t('sidebar.noKeychain')}</div>
        ) : null}
      </div>

      {dialog ? (
        <ConnectDialog
          {...(dialog.initial === undefined ? {} : { initial: dialog.initial })}
          saved={saved}
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
    /*
     * A connection is one line. The list is the sidebar's index, not its content
     * — the object tree below it is what the user reads — so a row costs 24px
     * and grows only for a row that has an error to report.
     *
     * Selected and hover are written as alternatives rather than stacked, and
     * that is not a style choice. A class list has no cascade: `bg-bg-sel` and
     * `hover:bg-bg-2` on one element are resolved by Tailwind's emission order,
     * where the variant wins, so a selected row would go grey under the pointer.
     * The CSS this replaces got the same answer from source order — `.conn-item.
     * active` written after `.conn-item:hover` — which is exactly the kind of
     * fact that does not survive a translation. See the migration record §7.2.
     */
    <div
      className={
        active
          ? 'mb-px cursor-default rounded-control bg-bg-sel px-snug py-inset select-none'
          : 'mb-px cursor-default rounded-control px-snug py-inset select-none hover:bg-bg-2'
      }
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
      <div className="flex items-center gap-tight">
        <span className={CONN_DOT[status]} />
        {/* Gives up its own width first: the label is the long part of the row,
            and everything after it is fixed-width. */}
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {entry?.hasSecret ? (
          <span className="conn-key flex-none text-micro opacity-85" title={t('sidebar.secretStored')}>
            🔑
          </span>
        ) : null}
        {/* Driver id is an identifier and stays untranslated. */}
        <span className="flex-none text-micro text-fg-faint">{config?.driverId ?? ''}</span>
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
              // No initial state: every field a package view needs has a default
              // in its own `readGraphState`-style reader, and seeding one here
              // would be the window guessing at a shape only the package knows.
              openPackageView: (packageKind) => {
                if (conn) void dispatch('view.open', { spec: { kind: 'package', packageKind, connId: conn.id } })
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
  if (conn.status === 'connecting') {
    return <div className="mt-px truncate text-micro text-fg-faint">{t('sidebar.status.connecting')}</div>
  }
  if (conn.status === 'error') {
    // A failed connection usually carries the driver's own words: `useErrorText`
    // shows those verbatim and localizes only the errors peek itself wrote.
    return (
      <div className="mt-px truncate text-micro text-fg-faint">
        {conn.error ? errorText : t('sidebar.status.error')}
      </div>
    )
  }
  return null
}

/**
 * The tooltip: what the row had to leave out.
 *
 * The name is the part that tells connections apart — a file name, a database, a
 * host — so the full path or address, and the server it turned out to be, live
 * here instead of on a second line nobody needs most of the time.
 *
 * The long form is **read**, not derived. This used to be `connectionDetail(config)`
 * — a `switch` in core over the six databases peek compiled in — and spelling an
 * address is the package's job now (`DriverDisplay.detail`), which runs in the
 * package host because the window may never execute a package's code. A config
 * does not change once a connection exists, so the string is computed once when
 * it opens and travels with it.
 *
 * The fallback to the label is the same unreachable arm the `config === undefined`
 * branch was: a row always has a live side or a saved side, and both carry a
 * detail. It stays for the same reason — a tooltip whose first line is blank says
 * less than one that repeats the row.
 */
function rowTitle(t: TFunction, row: ConnectionRow): string {
  const { conn, entry } = row
  const detail = conn?.detail ?? entry?.detail
  const lines = [detail === undefined || detail === '' ? row.label : detail]
  if (conn?.serverInfo) lines.push(`${conn.serverInfo.flavor ?? conn.driverId} ${conn.serverInfo.version}`)
  else if (conn === undefined) lines.push(t('sidebar.connectHint'))
  // The only place the row admits it has a menu. A hover-revealed "⋯" would say
  // it louder, but that is the action strip back in a narrower costume.
  lines.push(t('menu.hint'))
  return lines.join('\n')
}
