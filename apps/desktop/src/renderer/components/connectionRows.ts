import {
  connectionIdentity,
  defaultConnectionLabel,
  type ConnectionState,
  type SavedConnection,
} from '@peek/core'

/**
 * One line of the sidebar.
 *
 * The two halves the sidebar used to draw — live connections from the Workspace
 * mirror, saved ones from `~/.peek/connections.json` — are the same connections.
 * The book is written as a side effect of a `conn.open` that succeeded and from
 * nowhere else, so `live ⊆ saved` holds, and drawing them as two lists means
 * every open connection appears twice: once live, once as a greyed "already
 * open" row underneath. See docs/design/2026-08-02-connection-list.md.
 *
 * A row therefore has a live side, a saved side, or both:
 *
 *   - both — the ordinary case, one connection the user opened;
 *   - saved only — in the book, not currently connected;
 *   - live only — `remember` failed (it never throws, it returns null), or the
 *     open failed before it could be remembered, which is every error row.
 */
export interface ConnectionRow {
  /** Stable across re-renders, and unique across the list. */
  key: string
  conn?: ConnectionState
  entry?: SavedConnection
  /** `conn.label` when live, otherwise the entry's — never empty. */
  label: string
}

/**
 * Merge the live connections and the book into one list.
 *
 * Rows are matched by `connectionIdentity`, not by label. A label is a display
 * string two different servers can share, and pairing on it made the connect
 * button of one host go dead because another host happened to have a database of
 * the same name. Identity survives the trip through redaction — see the note on
 * `connectionIdentity` — so the config in the renderer hashes to the same string
 * as the stripped one in the book.
 *
 * Order is `lastUsedAt`, newest first, which is the order the book already comes
 * in. A live connection with no entry has no timestamp and sorts first: it is
 * either brand new or the one thing in the list that failed to be recorded, and
 * both are worth seeing. Opening a connection refreshes its `lastUsedAt` and so
 * moves its row to the top — accepted, it is the same feedback as appearing in
 * the live list used to be.
 */
export function buildConnectionRows(
  conns: readonly ConnectionState[],
  saved: readonly SavedConnection[],
): ConnectionRow[] {
  const entryByIdentity = new Map<string, SavedConnection>()
  for (const entry of saved) entryByIdentity.set(connectionIdentity(entry.config), entry)

  // Which entries the live side has spoken for. Two connections on one config
  // (the UI does not offer it; MCP can) both claim the same entry, and both keep
  // their own row — one row silently standing for two live connections would put
  // a "disconnect" on screen that closes an arbitrary one of them.
  const claimed = new Set<string>()

  const live: ConnectionRow[] = conns.map((conn) => {
    const identity = connectionIdentity(conn.config)
    const entry = entryByIdentity.get(identity)
    if (entry) claimed.add(entry.id)
    return {
      key: conn.id,
      conn,
      ...(entry === undefined ? {} : { entry }),
      label: conn.label || defaultConnectionLabel(conn.config),
    }
  })

  const rest: ConnectionRow[] = saved
    .filter((entry) => !claimed.has(entry.id))
    .map((entry) => ({ key: entry.id, entry, label: entry.label }))

  // A stable sort, so live-without-entry rows keep the workspace's own order
  // among themselves and the rest keep the book's.
  return [...live, ...rest].sort((a, b) => compare(sortKey(b), sortKey(a)))
}

/** ISO timestamps compare correctly as strings; `'~'` is above any of them. */
function sortKey(row: ConnectionRow): string {
  return row.entry?.lastUsedAt ?? '~'
}

/** Code-point order, not `localeCompare`, whose collation reorders punctuation. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
