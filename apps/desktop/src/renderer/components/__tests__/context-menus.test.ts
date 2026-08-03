import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  Capability,
  ConnId,
  ConnectionState,
  NamespaceNode,
  PanelNode,
  SortSpec,
  ViewId,
} from '@peek/core'

import { columnMenuNodes } from '../columnMenu'
import { connectionMenuNodes } from '../connectionMenu'
import type { ConnectionRow } from '../connectionRows'
import { tabMenuNodes } from '../tabMenu'
import { treeMenuNodes } from '../views/treeMenu'
import type { MenuNode } from '../../ui/menuModel'

/* ==================================================================
 * What each surface offers on a right-click.
 *
 * The menus themselves are DOM; *what is in them* is a pure function per
 * surface, which is the half worth pinning down — a menu that offers an act the
 * driver cannot perform, or that offers "Disconnect" and "Remove" side by side,
 * is wrong before a single pixel is drawn.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md §4
 * ================================================================== */

/** The identity translator: these assertions are about structure, not wording. */
const t = ((key: string) => key) as never

function ids(nodes: readonly MenuNode[]): string[] {
  return nodes.filter((n) => n.kind === 'item').map((n) => n.id)
}

const NO_OP = {
  open: () => {},
  vectorSearch: () => {},
  copyName: () => {},
  refresh: () => {},
}

/* ------------------------------------------------------------------
 * The namespace tree
 * ------------------------------------------------------------------ */

function node(over: Partial<NamespaceNode> = {}): NamespaceNode {
  return { id: 'n1', name: 'users', kind: 'table', hasChildren: false, ...over } as NamespaceNode
}

const CONN = 'c1' as ConnId

describe('the object tree menu', () => {
  test('a table offers Open, because a double-click would open it', () => {
    const nodes = treeMenuNodes(CONN, node({ ref: { kind: 'relation', schema: 'public', name: 'users' } }), [], t, NO_OP)
    assert.ok(ids(nodes).includes('tree.open'))
  })

  test('a container that only expands does not offer Open', () => {
    // `openSpecForNode` returns null for it, so an Open line would promise
    // something the double-click does not do either.
    assert.ok(!ids(treeMenuNodes(CONN, node({ kind: 'schema', hasChildren: true }), [], t, NO_OP)).includes('tree.open'))
  })

  test('vector search appears only on a vector collection', () => {
    const caps: Capability[] = ['vectorSearch']
    const collection = node({ ref: { kind: 'vectorCollection', collection: 'docs' } })
    assert.ok(ids(treeMenuNodes(CONN, collection, caps, t, NO_OP)).includes('tree.vectorSearch'))
    assert.ok(!ids(treeMenuNodes(CONN, node(), caps, t, NO_OP)).includes('tree.vectorSearch'))
  })

  test('vector search needs the capability, not just the node kind', () => {
    const collection = node({ ref: { kind: 'vectorCollection', collection: 'docs' } })
    assert.ok(!ids(treeMenuNodes(CONN, collection, [], t, NO_OP)).includes('tree.vectorSearch'))
  })

  test('a leaf offers no reload — there is no level under it to reload', () => {
    assert.ok(!ids(treeMenuNodes(CONN, node(), [], t, NO_OP)).includes('tree.refresh'))
    assert.ok(ids(treeMenuNodes(CONN, node({ hasChildren: true }), [], t, NO_OP)).includes('tree.refresh'))
  })

  test('copy name is always there — every node has one', () => {
    assert.ok(ids(treeMenuNodes(CONN, node(), [], t, NO_OP)).includes('tree.copyName'))
  })
})

/* ------------------------------------------------------------------
 * Panel tabs
 * ------------------------------------------------------------------ */

const TAB_HANDLERS = {
  close: () => {},
  closeOthers: () => {},
  splitRow: () => {},
  splitCol: () => {},
  closePanel: () => {},
}

function panel(viewIds: string[]): PanelNode {
  return { id: 'p1', kind: 'panel', viewIds, activeViewId: viewIds[0] } as unknown as PanelNode
}

describe('the tab menu', () => {
  test('a lone tab is not offered "close other tabs"', () => {
    const nodes = tabMenuNodes(panel(['v1']), 'v1' as ViewId, t, TAB_HANDLERS)
    assert.ok(!ids(nodes).includes('tab.closeOthers'))
  })

  test('two tabs are', () => {
    const nodes = tabMenuNodes(panel(['v1', 'v2']), 'v1' as ViewId, t, TAB_HANDLERS)
    assert.ok(ids(nodes).includes('tab.closeOthers'))
  })

  test('closing the panel is marked danger — it takes tabs the user is not pointing at', () => {
    const nodes = tabMenuNodes(panel(['v1', 'v2']), 'v1' as ViewId, t, TAB_HANDLERS)
    const close = nodes.find((n) => n.kind === 'item' && n.id === 'panel.close')
    assert.equal(close?.kind === 'item' ? close.tone : null, 'danger')
  })

  test('the tab acts and the panel acts are separated', () => {
    const nodes = tabMenuNodes(panel(['v1', 'v2']), 'v1' as ViewId, t, TAB_HANDLERS)
    assert.ok(nodes.some((n) => n.kind === 'sep'))
  })
})

/* ------------------------------------------------------------------
 * The connection list
 * ------------------------------------------------------------------ */

const CONN_HANDLERS = {
  connect: () => {},
  disconnect: () => {},
  openTree: () => {},
  openQuery: () => {},
  openPluginView: () => {},
  edit: () => {},
  forget: () => {},
}

function saved(): ConnectionRow {
  return {
    key: 'k',
    label: 'local',
    entry: {
      id: 'e1',
      driverId: 'postgres',
      label: 'local',
      config: { driverId: 'postgres' },
      hasSecret: true,
      createdAt: '',
      lastUsedAt: '',
    },
  } as unknown as ConnectionRow
}

function live(over: Partial<ConnectionState> = {}): ConnectionRow {
  const conn = {
    id: 'c1',
    driverId: 'postgres',
    status: 'ready',
    config: { driverId: 'postgres' },
    capabilities: ['introspect', 'tabularQuery'],
    ...over,
  } as unknown as ConnectionState
  return { ...saved(), conn } as ConnectionRow
}

describe('the connection menu', () => {
  /*
   * The rule inherited from 2026-08-02-connection-list.md §2.1, which was the
   * answer to "a merged list makes disconnect and remove look like the same
   * act". It never depended on the action strip, so it survives the strip's
   * removal — and it is now a test rather than a paragraph.
   */
  test('a live connection offers Disconnect and never Remove', () => {
    const list = ids(connectionMenuNodes(live(), t, CONN_HANDLERS, { busy: false }))
    assert.ok(list.includes('conn.disconnect'))
    assert.ok(!list.includes('conn.forget'))
  })

  test('a saved connection offers Remove and never Disconnect', () => {
    const list = ids(connectionMenuNodes(saved(), t, CONN_HANDLERS, { busy: false }))
    assert.ok(list.includes('conn.forget'))
    assert.ok(!list.includes('conn.disconnect'))
  })

  test('Remove is two-step — it drops a stored credential for good', () => {
    const nodes = connectionMenuNodes(saved(), t, CONN_HANDLERS, { busy: false })
    const forget = nodes.find((n) => n.kind === 'item' && n.id === 'conn.forget')
    assert.ok(forget?.kind === 'item' && forget.confirm !== undefined)
    assert.equal(forget?.kind === 'item' ? forget.tone : null, 'danger')
  })

  test('a failed connection offers nothing to browse, only a way out', () => {
    const list = ids(connectionMenuNodes(live({ status: 'error' }), t, CONN_HANDLERS, { busy: false }))
    assert.deepEqual(list.filter((id) => id.startsWith('conn.')).includes('conn.tree'), false)
    assert.ok(list.includes('conn.disconnect'))
  })

  test('a driver with no query language gets a sentence, not a greyed line', () => {
    // "Temporarily unavailable" and "this database has no statement interface"
    // are different claims, and a disabled item makes the first one.
    const nodes = connectionMenuNodes(
      live({ driverId: 'redis', capabilities: ['introspect', 'keyValue'] } as Partial<ConnectionState>),
      t,
      CONN_HANDLERS,
      { busy: false },
    )
    assert.ok(!ids(nodes).includes('conn.query'))
    assert.ok(nodes.some((n) => n.kind === 'note' && n.id === 'conn.noQuery'))
  })

  test('connecting is disabled while an open is already in flight', () => {
    const nodes = connectionMenuNodes(saved(), t, CONN_HANDLERS, { busy: true })
    const connect = nodes.find((n) => n.kind === 'item' && n.id === 'conn.connect')
    assert.equal(connect?.kind === 'item' ? connect.disabled : null, true)
  })
})

/* ------------------------------------------------------------------
 * Grid column headers
 * ------------------------------------------------------------------ */

const COLUMN_HANDLERS = { setSort: () => {}, copyName: () => {} }

describe('the column header menu', () => {
  test('an unsorted column offers both directions and no way to clear', () => {
    const nodes = columnMenuNodes('name', [], t, COLUMN_HANDLERS, { sortable: true })
    assert.deepEqual(ids(nodes), ['column.sortAsc', 'column.sortDesc', 'column.copyName'])
  })

  test('the direction already in force is not offered again', () => {
    const sort: SortSpec[] = [{ column: 'name', dir: 'asc' }]
    assert.deepEqual(ids(columnMenuNodes('name', sort, t, COLUMN_HANDLERS, { sortable: true })), [
      'column.sortDesc',
      'column.sortClear',
      'column.copyName',
    ])
  })

  test('a sorted column can be unsorted — the thing a cycling click cannot reach directly', () => {
    const sort: SortSpec[] = [{ column: 'name', dir: 'desc' }]
    assert.ok(ids(columnMenuNodes('name', sort, t, COLUMN_HANDLERS, { sortable: true })).includes('column.sortClear'))
  })

  test('another column being sorted says nothing about this one', () => {
    const sort: SortSpec[] = [{ column: 'other', dir: 'asc' }]
    assert.deepEqual(ids(columnMenuNodes('name', sort, t, COLUMN_HANDLERS, { sortable: true })), [
      'column.sortAsc',
      'column.sortDesc',
      'column.copyName',
    ])
  })

  test('a view that cannot sort offers no sorting at all, not disabled sorting', () => {
    // A query result has no sort to set — the statement decided the order. A
    // greyed "Sort ascending" would suggest it is temporarily unavailable.
    const nodes = columnMenuNodes('name', undefined, t, COLUMN_HANDLERS, { sortable: false })
    assert.deepEqual(ids(nodes), ['column.copyName'])
    assert.ok(!nodes.some((n) => n.kind === 'sep'))
  })

  test('setSort is called with the direction the line names', () => {
    const seen: (string | null)[] = []
    const nodes = columnMenuNodes('name', [], t, { setSort: (d) => seen.push(d), copyName: () => {} }, {
      sortable: true,
    })
    for (const n of nodes) if (n.kind === 'item' && n.id !== 'column.copyName') n.onSelect()
    assert.deepEqual(seen, ['asc', 'desc'])
  })
})
