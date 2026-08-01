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

  /* The tab strip. */
  'panel.tabs.listLabel': 'Panel tabs',
  'panel.tab.close': 'Close {title}',

  /* Drag and drop. These label the highlight that appears under the cursor while
   * a view is being dragged, so each one has to say what releasing *here* would
   * do — the whole point of the preview is that nothing is a surprise.
   *
   * `panel.drop.swap` is gone: no gesture produces a swap any more (a centre
   * drop stacks), and a label for an outcome nothing can reach is a promise the
   * window cannot keep. `swap` survives only as a Command an AI can name. */
  'panel.dragView': 'Drag to move this view',
  'panel.drop.move': 'Move view here',
  'panel.drop.stack': 'Add as a tab in {title}',
  'panel.drop.tab': 'Insert tab here',
  'panel.drop.split.left': 'Split left',
  'panel.drop.split.right': 'Split right',
  'panel.drop.split.top': 'Split above',
  'panel.drop.split.bottom': 'Split below',

  /* Accessible names for the layout. Keyed `a11y.*` per the shared contract; they
   * live in this file because they name panels and their tabs, and a key's file
   * is only about who edits it. */
  'a11y.panel.label': 'Panel {index}: {title}',
  'a11y.panel.empty': 'Empty panel {index}',

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
