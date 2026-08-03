import type { ConnectionState, PluginViewKind, SavedConnection } from '@peek/core'
import type { TFunction } from '../i18n'
import { viewKindsForDriver } from '../plugins/viewKinds'
import { connCanUse, connHas } from '../state/capabilities'
import type { MenuNode } from '../ui/menuModel'
import type { ConnectionRow } from './connectionRows'

/**
 * What right-clicking a connection offers.
 *
 * This function is where `2026-08-02-connection-list.md` §2.1's rule now lives,
 * unchanged in substance and moved in form: **disconnect and remove never appear
 * together.** A row with a live driver offers disconnect and no remove; a row
 * without one offers remove and no disconnect. That was the answer to the
 * objection against merging the two lists into one — the distinction is carried
 * by the acts on offer, not by which list a row sits in — and it survives the
 * move from an action strip into a menu because it was never about the strip.
 *
 * The strip itself is gone (design record §1.3): the acts are here now. What
 * that costs is discoverability, taken knowingly — see §3.2.
 *
 * Two different questions decide each live act, and both are needed: `connHas`
 * says whether to draw a line at all (redis will never have a SQL editor, and
 * offering a greyed one is a promise the driver cannot keep), `connCanUse` says
 * whether it is usable yet.
 */
export interface ConnectionMenuHandlers {
  connect: () => void
  disconnect: () => void
  openTree: () => void
  openQuery: () => void
  /** Open a view kind contributed by a package — see `plugins/viewKinds`. */
  openPluginView: (kind: PluginViewKind) => void
  edit: () => void
  forget: () => void
}

export function connectionMenuNodes(
  row: ConnectionRow,
  t: TFunction,
  on: ConnectionMenuHandlers,
  options: { busy: boolean },
): MenuNode[] {
  const { conn, entry } = row
  const nodes: MenuNode[] = []

  if (conn === undefined) {
    if (entry !== undefined) {
      nodes.push({
        kind: 'item',
        id: 'conn.connect',
        label: t('sidebar.action.connect'),
        disabled: options.busy,
        onSelect: on.connect,
      })
    }
  } else {
    nodes.push(...liveNodes(conn, t, on))
  }

  if (editableOf(row) !== undefined) {
    if (nodes.length > 0) nodes.push({ kind: 'sep', id: 'conn.sep.edit' })
    nodes.push({ kind: 'item', id: 'conn.edit', label: t('sidebar.action.edit'), onSelect: on.edit })
  }

  /* Remove only when nothing is connected. Not merely to keep it away from
     "Disconnect": an entry cannot be forgotten while its connection is open,
     because the next successful open writes it straight back. */
  if (conn === undefined && entry !== undefined) {
    nodes.push({
      kind: 'item',
      id: 'conn.forget',
      label: t('sidebar.action.remove'),
      tone: 'danger',
      // It drops a stored credential and cannot be undone. `confirm` turns the
      // menu into Cancel + this line, which is what `ConfirmPair` was buying in
      // the strip this replaces — the second press lands somewhere harmless.
      confirm: t('sidebar.action.removeConfirm'),
      onSelect: on.forget,
    })
  }

  return nodes
}

function liveNodes(conn: ConnectionState, t: TFunction, on: ConnectionMenuHandlers): MenuNode[] {
  const nodes: MenuNode[] = []

  // A failed connection has nothing to browse; it has something to disconnect.
  if (conn.status !== 'error') {
    nodes.push({
      kind: 'item',
      id: 'conn.tree',
      label: t('sidebar.action.tree'),
      disabled: !connCanUse(conn, 'introspect'),
      onSelect: on.openTree,
    })
    if (connHas(conn, 'tabularQuery')) {
      nodes.push({
        kind: 'item',
        id: 'conn.query',
        label: t('sidebar.action.query'),
        disabled: !connCanUse(conn, 'tabularQuery'),
        onSelect: on.openQuery,
      })
    } else {
      // Not a disabled item: "temporarily unavailable" and "this database has no
      // query language" are different statements, and only the second is true.
      nodes.push({
        kind: 'note',
        id: 'conn.noQuery',
        text: t('sidebar.action.noQueryTitle', { driverId: conn.driverId }),
      })
    }

    /* Views a package contributes for this driver, after the two built-in ways
       in and before the separator.
     *
     * Position is the claim being made: a `graph` is another way to look at this
     * connection, not a different class of thing, so it sits with Browse and
     * Query rather than in a "Plugins" submenu of its own. DataGrip's own answer
     * to the same question is the opposite one, and §1.6b records what that cost
     * it — a plugin ghetto is where features go to be undiscoverable.
     *
     * The label is the kind's own `titleKey`, checked against the catalog when
     * the kind registered, so a package cannot put an unlocalized string here. */
    for (const entry of viewKindsForDriver(conn.driverId)) {
      nodes.push({
        kind: 'item',
        id: `conn.plugin.${entry.contract.kind}`,
        label: t(entry.titleKey),
        // `connCanUse` and not `connHas`: the driver declared this kind for
        // itself, so "this database cannot do it" is not a case that exists —
        // only "not connected yet".
        disabled: !connCanUse(conn, 'introspect'),
        onSelect: () => {
          on.openPluginView(entry.contract.kind)
        },
      })
    }

    nodes.push({ kind: 'sep', id: 'conn.sep.live' })
  }

  nodes.push({
    kind: 'item',
    id: 'conn.disconnect',
    label: t('sidebar.action.disconnect'),
    onSelect: on.disconnect,
  })

  return nodes
}

/**
 * The row as something the connect dialog can be seeded from.
 *
 * A failed open is never written to the book, so an error row usually has no
 * entry — but the live config is the same shape, redacted, which is exactly what
 * the dialog unpacks.
 */
export function editableOf(row: ConnectionRow): SavedConnection | undefined {
  const { conn, entry } = row
  if (entry !== undefined) return entry
  if (conn === undefined) return undefined
  return {
    id: conn.id,
    driverId: conn.driverId,
    label: row.label,
    config: conn.config,
    hasSecret: false,
    createdAt: '',
    lastUsedAt: '',
  }
}
