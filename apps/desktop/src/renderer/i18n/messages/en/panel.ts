/** Panels, the tiled layout and the view host. */
export const panel = {
  'panel.empty': 'Empty panel',
  'panel.emptyWithConn': 'Empty panel · {label}',
  'panel.emptyHint': 'Connect a database in the sidebar first',
  'panel.splitRow': 'Split left/right',
  'panel.splitCol': 'Split top/bottom',
  'panel.closeView': 'Close view',
  'panel.closePanel': 'Close panel',
  'panel.newQuery': 'New query',
  'panel.objectTree': 'Object tree',

  'view.gone': 'View {viewId} no longer exists',

  /* View-kind labels. `viewTitle()` in core stays English because MCP reads it;
   * the window uses these instead when it wants the kind spelled out. */
  'view.kind.table': 'Table',
  'view.kind.query': 'Query',
  'view.kind.inspector': 'Inspector',
  'view.kind.tree': 'Object tree',
  'view.kind.vector': 'Vector search',

  /* One-line view descriptions for the status bar — the localized counterpart of
   * `describeView()` in core, which stays English because MCP reads it.
   *
   * `{kind}` is filled from the `view.kind.*` message above rather than written
   * out again, so the status bar and the panel title can never end up calling the
   * same view two different things. Everything else interpolated here is an
   * identifier (collection label, query text, the inspector's ref kind) and is
   * passed through verbatim. */
  'view.describe.table': '{kind} {ref} · offset {offset} limit {limit}',
  'view.describe.query': '{kind} {text}',
  'view.describe.inspector': '{kind} {ref}',
  'view.describe.tree': {
    one: '{kind} · {count} node expanded',
    other: '{kind} · {count} nodes expanded',
  },
  'view.describe.vector': '{kind} {collection} · topK {topK}',
} as const

export type PanelMessages = typeof panel
