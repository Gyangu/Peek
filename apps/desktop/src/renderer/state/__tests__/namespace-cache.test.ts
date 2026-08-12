import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import type { ConnId, ConnStatus, ConnectionState, NamespaceNode, Workspace } from '@peek/core'

/* ==================================================================
 * The namespace cache against the connection lifecycle.
 *
 * `conn.open` opens the tree view in the same tick it marks the connection
 * `connecting` — the handshake is an async effect that runs afterwards. So the
 * tree always fires its first introspect at a connection that cannot answer yet.
 * Before this net, main's `requireReady` rejection was cached as a permanent
 * "load failed" and only a manual refresh cleared it.
 *
 * See docs/design/2026-08-02-namespace-cache-follows-connection.md.
 * ================================================================== */

/* ---- bridge stand-in: must be installed before namespaceStore is imported ---- */
interface IntrospectCall {
  connId: string
  parentId: string | null
  refresh: boolean | undefined
}

const calls: IntrospectCall[] = []
let answer: (call: IntrospectCall) => Promise<NamespaceNode[]> = () => Promise.resolve([])

// `sync.ts` pulls in resultCache, which lives on the data plane's rAF loop.
;(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number })
  .requestAnimationFrame = (): number => 0
;(globalThis as unknown as { window: Record<string, unknown> }).window = {
  peek: {
    invoke: () => Promise.resolve(),
    getSnapshot: () => Promise.resolve(),
    introspect: (connId: string, parentId: string | null, refresh?: boolean) => {
      const call = { connId, parentId, refresh }
      calls.push(call)
      return answer(call)
    },
  },
}

const {
  getNodes,
  invalidateConnection,
  loadChildren,
  nodesKey,
  refetchConnection,
  useNamespaceStore,
} = await import('../namespaceStore')
const { useWorkspaceStore } = await import('../workspaceStore')
const { syncNamespaceCache } = await import('../sync')

/* ---- helpers ---- */

const CONN = 'conn_a' as ConnId
const OTHER = 'conn_b' as ConnId

function node(id: string): NamespaceNode {
  return { id, name: id, kind: 'table', hasChildren: false }
}

function conn(id: ConnId, status: ConnStatus): ConnectionState {
  return {
    id,
    driverId: 'postgres',
    identity: id,
    label: id,
    detail: id,
    endpoint: id,
    config: { driverId: 'postgres' } as ConnectionState['config'],
    status,
    capabilities: [],
  }
}

/** Put connections into the workspace mirror the way a patch broadcast would. */
function setConns(...list: ConnectionState[]): void {
  const connections: Record<string, ConnectionState> = {}
  for (const c of list) connections[c.id] = c
  const ws = {
    rev: 1,
    connections,
    views: {},
    results: {},
    layout: null,
    focusedPanel: null,
  } as unknown as Workspace
  useWorkspaceStore.setState({ workspace: ws, ready: true })
}

/** Let the introspect promise chain settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

beforeEach(() => {
  answer = () => Promise.resolve([])
  // The detector's memory of previous statuses is module state; an empty mirror
  // makes every connection it remembers "gone", which is exactly a reset.
  setConns()
  syncNamespaceCache()
  useNamespaceStore.setState({ entries: {} })
  useWorkspaceStore.setState({ workspace: null, ready: false })
  calls.length = 0
})

describe('the gate in front of introspect', () => {
  test('a connecting connection parks the level instead of failing it', async () => {
    setConns(conn(CONN, 'connecting'))
    loadChildren(CONN, null)
    await settle()

    assert.deepEqual(calls, [], 'nothing may be asked of a connection still handshaking')
    const entry = getNodes(CONN, null)
    assert.equal(entry.status, 'waiting')
    assert.equal(entry.error, undefined, 'waiting is not a failure and carries no error text')
  })

  test('a connection absent from the mirror is treated as not ready', async () => {
    setConns()
    loadChildren(CONN, null)
    await settle()

    assert.deepEqual(calls, [])
    assert.equal(getNodes(CONN, null).status, 'waiting')
  })

  test('a ready connection is fetched as before', async () => {
    answer = () => Promise.resolve([node('t1')])
    setConns(conn(CONN, 'ready'))
    loadChildren(CONN, null)
    await settle()

    assert.equal(calls.length, 1)
    const entry = getNodes(CONN, null)
    assert.equal(entry.status, 'ready')
    assert.deepEqual(
      entry.nodes.map((n) => n.id),
      ['t1'],
    )
  })

  test('a real rejection still lands as an error', async () => {
    // The gate must not swallow the failures it was never about: a permission
    // error is the user's to deal with, and it stays sticky on purpose.
    answer = () => Promise.reject(new Error('permission denied for schema public'))
    setConns(conn(CONN, 'ready'))
    loadChildren(CONN, null)
    await settle()

    const entry = getNodes(CONN, null)
    assert.equal(entry.status, 'error')
    assert.match(entry.error ?? '', /permission denied/)
  })
})

describe('replaying parked levels once the connection comes up', () => {
  test('the level parked while connecting is fetched on ready', async () => {
    setConns(conn(CONN, 'connecting'))
    loadChildren(CONN, null)
    await settle()
    assert.equal(getNodes(CONN, null).status, 'waiting')

    // What sync.ts does on the connecting → ready transition.
    answer = () => Promise.resolve([node('public')])
    setConns(conn(CONN, 'ready'))
    refetchConnection(CONN)
    await settle()

    assert.equal(calls.length, 1, 'exactly one fetch, once the connection could answer')
    const entry = getNodes(CONN, null)
    assert.equal(entry.status, 'ready')
    assert.deepEqual(
      entry.nodes.map((n) => n.id),
      ['public'],
    )
  })

  test('every cached level is replayed, including collapsed ones', async () => {
    // A collapsed level is unmounted, so nothing in React would re-request it;
    // the replay has to be driven off the cache, not off the component tree.
    answer = () => Promise.resolve([])
    setConns(conn(CONN, 'connecting'))
    loadChildren(CONN, null)
    loadChildren(CONN, 'public')
    await settle()

    setConns(conn(CONN, 'ready'))
    refetchConnection(CONN)
    await settle()

    assert.deepEqual(
      calls.map((c) => c.parentId).sort(),
      [null, 'public'].sort(),
    )
    assert.equal(
      calls.every((c) => c.refresh === true),
      true,
      'a replay must bypass the cache check, not be short-circuited by it',
    )
  })

  test('a reconnect refetches rather than showing the previous session', async () => {
    answer = () => Promise.resolve([node('old')])
    setConns(conn(CONN, 'ready'))
    loadChildren(CONN, null)
    await settle()
    assert.deepEqual(
      getNodes(CONN, null).nodes.map((n) => n.id),
      ['old'],
    )

    // Dropped, then back up. The tree kept its nodes across the failure (they are
    // better than a blank panel), but they must not survive the reconnect.
    setConns(conn(CONN, 'error'))
    assert.deepEqual(
      getNodes(CONN, null).nodes.map((n) => n.id),
      ['old'],
      'a failed connection keeps its tree; the sidebar is what reports the failure',
    )

    answer = () => Promise.resolve([node('new')])
    setConns(conn(CONN, 'ready'))
    refetchConnection(CONN)
    await settle()

    assert.deepEqual(
      getNodes(CONN, null).nodes.map((n) => n.id),
      ['new'],
    )
  })

  test('a connection nobody opened a tree for fetches nothing', async () => {
    setConns(conn(CONN, 'ready'))
    refetchConnection(CONN)
    await settle()

    assert.deepEqual(calls, [], 'an unopened tree loads itself when opened, not before')
  })
})

describe('dropping the cache with the connection', () => {
  test('closing one connection leaves the others alone', async () => {
    answer = () => Promise.resolve([node('x')])
    setConns(conn(CONN, 'ready'), conn(OTHER, 'ready'))
    loadChildren(CONN, null)
    loadChildren(CONN, 'public')
    loadChildren(OTHER, null)
    await settle()

    invalidateConnection(CONN)

    const entries = useNamespaceStore.getState().entries
    assert.equal(entries[nodesKey(CONN, null)], undefined)
    assert.equal(entries[nodesKey(CONN, 'public')], undefined)
    assert.equal(getNodes(OTHER, null).status, 'ready', 'the other connection is untouched')
  })
})

describe('the transition detector behind the subscription', () => {
  test('only a transition into ready refetches', async () => {
    setConns(conn(CONN, 'connecting'))
    syncNamespaceCache()
    loadChildren(CONN, null)
    await settle()
    assert.deepEqual(calls, [])

    answer = () => Promise.resolve([node('public')])
    setConns(conn(CONN, 'ready'))
    syncNamespaceCache()
    await settle()
    assert.equal(calls.length, 1)

    // Every patch fires the subscription; an unchanged status is not an event.
    syncNamespaceCache()
    syncNamespaceCache()
    await settle()
    assert.equal(calls.length, 1, 'a re-broadcast of the same status must not refetch')
  })

  test('a connection that disappears takes its cache with it', async () => {
    answer = () => Promise.resolve([node('x')])
    setConns(conn(CONN, 'ready'), conn(OTHER, 'ready'))
    syncNamespaceCache()
    loadChildren(CONN, null)
    loadChildren(OTHER, null)
    await settle()

    // conn.close removes it from the mirror outright.
    setConns(conn(OTHER, 'ready'))
    syncNamespaceCache()

    assert.equal(useNamespaceStore.getState().entries[nodesKey(CONN, null)], undefined)
    assert.equal(getNodes(OTHER, null).status, 'ready')
  })

  test('reconnecting after a failure refetches through the detector', async () => {
    answer = () => Promise.resolve([node('old')])
    setConns(conn(CONN, 'ready'))
    syncNamespaceCache()
    loadChildren(CONN, null)
    await settle()

    setConns(conn(CONN, 'error'))
    syncNamespaceCache()
    await settle()
    assert.equal(calls.length, 1, 'a failure alone does not refetch')

    answer = () => Promise.resolve([node('new')])
    setConns(conn(CONN, 'ready'))
    syncNamespaceCache()
    await settle()

    assert.equal(calls.length, 2)
    assert.deepEqual(
      getNodes(CONN, null).nodes.map((n) => n.id),
      ['new'],
    )
  })
})
