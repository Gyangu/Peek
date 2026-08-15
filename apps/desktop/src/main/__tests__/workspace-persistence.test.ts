import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import '../../drivers/__tests__/in-repo-registry'
import {
  asPanelId,
  createEmptyWorkspace,
  type Capability,
  type ConnId,
  type ConnectionConfig,
  type PanelId,
  type PostgresConnectionConfig,
  type SavedConnection,
  type ViewId,
} from '@peek/core'
import { CommandBus } from '../bus/command-bus'
import { coreHandlers } from '../bus/handlers'
import { createSeqIdFactory } from '../bus/ids'
import type { CommandDeps } from '../bus/deps'
import type { ConnectionBook } from '../config'
import { parseWorkspaceFile, readWorkspaceFile, WORKSPACE_FILE_VERSION } from '../config/workspace-file'
import { createConnectionWake } from '../connection-wake'
import { finishResult } from '../store/mutations'
import { WorkspaceStore } from '../store/workspace-store'
import { createWorkspacePersister, projectWorkspace } from '../workspace-persist'
import { restoreWorkspace } from '../workspace-restore'

/* ==================================================================
 * Workspace persistence: the desk survives a restart.
 *
 * The load-bearing claim is that what gets written is a set of
 * `ViewOpenSpec`s — definitions, never session state — and that restoring is
 * nothing but the commands a person could have sent. Both are testable, and
 * most of what follows tests one of them:
 *
 *   - a running query changes the workspace several times a second and must
 *     produce an identical projection (nothing session-shaped is in there);
 *   - a restore drives the real Command Bus, so its output is a real workspace
 *     and can be compared with the one that was saved.
 *
 * Design record: docs/design/2026-08-15-workspace-persistence.md
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres:example-password@localhost:5432/postgres',
  password: 'example-password',
}

const PG_CAPS: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel']

const ORDERS = { kind: 'relation', schema: 'public', name: 'orders' } as const

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  /** Everything the deps were asked to start, in order. */
  started: { what: 'query' | 'scan' | 'vector' }[]
  /** Resolve to let a pending `conn.open` finish its handshake. */
  releaseConnect(): void
}

function harness(options: { holdConnect?: boolean } = {}): Harness {
  const started: Harness['started'] = []
  let release = (): void => {}

  const deps: CommandDeps = {
    connections: {
      async open() {
        if (options.holdConnect === true) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { capabilities: PG_CAPS, serverInfo: { version: '16.4', flavor: 'PostgreSQL' }, pid: 1 }
      },
      async close() {
        /* nothing to tear down in a stub */
      },
    },
    results: {
      async runQuery() {
        started.push({ what: 'query' })
      },
      async scanCollection() {
        started.push({ what: 'scan' })
      },
      async vectorSearch() {
        started.push({ what: 'vector' })
      },
      async cancel() {
        return true
      },
    },
  }

  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)

  return {
    bus,
    store,
    started,
    releaseConnect: () => {
      release()
    },
  }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

async function open(h: Harness, spec: unknown, panelId?: PanelId): Promise<ViewId> {
  const res = await h.bus.dispatch('view.open', { spec, ...(panelId === undefined ? {} : { panelId }) }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

/** A book holding exactly the connections whose identities are handed in. */
function bookOf(identities: string[]): ConnectionBook {
  const entries: SavedConnection[] = identities.map((identity, i) => ({
    id: `entry_${String(i)}`,
    identity,
    driverId: 'postgres',
    label: 'postgres@localhost',
    detail: 'postgresql://postgres@localhost:5432/postgres',
    // What the book stores: the credential is removed, not masked.
    config: { driverId: 'postgres', url: 'postgresql://postgres@localhost:5432/postgres' },
    hasSecret: true,
    createdAt: '2026-08-15T00:00:00.000Z',
    lastUsedAt: '2026-08-15T00:00:00.000Z',
  }))

  return {
    list: () => entries,
    remember: () => null,
    forget: () => false,
    // The keychain's half: the password comes back on the way to the driver.
    hydrate: (config: ConnectionConfig): ConnectionConfig => ({ ...config, password: 'example-password' }),
    secretsAvailable: true,
  }
}

function identityOf(h: Harness, connId: ConnId): string {
  const identity = h.store.getState().connections[connId]?.identity
  assert.ok(identity, 'the connection should carry an identity')
  return identity
}

/* ------------------------------------------------------------------ */
/* Projection: definitions only                                        */
/* ------------------------------------------------------------------ */

test('the projection carries a spec per view, and the tab order they are in', async () => {
  const h = harness()
  const connId = await connect(h)
  await open(h, { kind: 'table', connId, ref: ORDERS })
  await open(h, { kind: 'query', connId, text: 'select 1' })

  const projection = projectWorkspace(h.store.getState())

  assert.equal(projection.connections.length, 1)
  assert.equal(projection.connections[0]?.identity, identityOf(h, connId))
  assert.equal(projection.views.length, 2)
  assert.deepEqual(
    projection.views.map((v) => (v.spec as { kind: string }).kind),
    ['table', 'query'],
  )
  assert.equal(projection.layout.type, 'panel')
  if (projection.layout.type !== 'panel') throw new Error('unreachable')
  assert.deepEqual(projection.layout.views, ['v1', 'v2'])
  // The second open activated itself, and that is what should come back.
  assert.equal(projection.layout.active, 'v2')
  assert.equal(projection.focusPanel, projection.layout.key)
})

test('no session state reaches the file — not a cursor, a result id or a status', async () => {
  const h = harness()
  const connId = await connect(h)
  await open(h, { kind: 'table', connId, ref: ORDERS })

  const text = JSON.stringify(projectWorkspace(h.store.getState()))
  for (const forbidden of ['cursorToken', 'resultId', 'status', 'autoRefreshStoppedBy', 'packageText']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not be persisted`)
  }
})

test('a query that runs, streams and finishes leaves the projection untouched', async () => {
  const h = harness()
  const connId = await connect(h)
  const viewId = await open(h, { kind: 'table', connId, ref: ORDERS })

  const before = JSON.stringify(projectWorkspace(h.store.getState()))

  // Opening the table auto-fetched; land that result the way the driver host
  // would. This is the change that arrives many times a second in real use.
  const resultId = resultIdOf(h, viewId)
  assert.ok(resultId)
  h.store.apply(
    (draft) => {
      finishResult(draft, resultId, { rows: 5_000, elapsedMs: 12 })
    },
    { source: 'system' },
  )

  assert.equal(JSON.stringify(projectWorkspace(h.store.getState())), before)
})

test('a provisional view is not saved: it was never being kept', async () => {
  const h = harness()
  const connId = await connect(h)
  await h.bus.dispatch('view.open', { spec: { kind: 'table', connId, ref: ORDERS }, provisional: true }, 'ui')

  assert.equal(projectWorkspace(h.store.getState()).views.length, 0)
})

test('a chat with no agent session has nothing to resume, so it is not saved', async () => {
  const h = harness()
  await open(h, { kind: 'chat' })

  assert.equal(projectWorkspace(h.store.getState()).views.length, 0)
})

test('a chat that has a session is saved as that id and nothing else', async () => {
  const h = harness()
  const viewId = await open(h, { kind: 'chat' })
  h.store.apply(
    (draft) => {
      const view = draft.views[viewId]
      if (view?.kind === 'chat') {
        view.agentSessionId = 'sess_42'
        view.messageCount = 7
        view.lastMessagePreview = 'the transcript peek drew'
      }
    },
    { source: 'system' },
  )

  const projection = projectWorkspace(h.store.getState())
  assert.equal(projection.views.length, 1)
  assert.deepEqual(projection.views[0]?.spec, {
    kind: 'chat',
    permissionMode: 'default',
    resumeSessionId: 'sess_42',
  })
  // The conversation belongs to the agent; peek stores the id, never the words.
  const text = JSON.stringify(projection)
  assert.equal(text.includes('the transcript peek drew'), false)
  assert.equal(text.includes('messageCount'), false)
})

/* ------------------------------------------------------------------ */
/* The file                                                            */
/* ------------------------------------------------------------------ */

test('a projection survives a round trip through the file', async () => {
  const h = harness()
  const connId = await connect(h)
  await open(h, { kind: 'table', connId, ref: ORDERS })
  await h.bus.dispatch('layout.split', { dir: 'row' }, 'ui')

  const projection = projectWorkspace(h.store.getState())
  const parsed = parseWorkspaceFile({
    version: WORKSPACE_FILE_VERSION,
    savedAt: '2026-08-15T07:55:00.000Z',
    ...projection,
  })

  assert.ok(parsed)
  assert.deepEqual(parsed.connections, projection.connections)
  assert.deepEqual(parsed.views, projection.views)
  assert.deepEqual(parsed.layout, projection.layout)
  assert.equal(parsed.focusPanel, projection.focusPanel)
})

test('a file from another version is refused rather than half-read', () => {
  assert.equal(
    parseWorkspaceFile({
      version: 99,
      savedAt: '',
      connections: [],
      views: [],
      layout: { type: 'panel', key: 'p1', views: [] },
    }),
    null,
  )
})

test('a malformed tree is refused as a file, not repaired', () => {
  const base = { version: WORKSPACE_FILE_VERSION, savedAt: '', connections: [], views: [] }
  // A split with one child is a tree `layout.setLayout` would reject anyway;
  // catching it here makes it a bad *file* rather than a failed command.
  assert.equal(
    parseWorkspaceFile({
      ...base,
      layout: { type: 'split', dir: 'row', children: [{ type: 'panel', key: 'p1', views: [] }] },
    }),
    null,
  )
  assert.equal(parseWorkspaceFile({ ...base, layout: { type: 'panel', views: [] } }), null)
  assert.equal(parseWorkspaceFile({ ...base, layout: null }), null)
})

test('an unreadable file is moved aside, not deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peek-workspace-'))
  try {
    const path = join(dir, 'workspace.json')
    writeFileSync(path, '{ this is not json', 'utf8')

    const outcome = readWorkspaceFile(path)
    assert.equal(outcome.kind, 'corrupt')
    if (outcome.kind !== 'corrupt') throw new Error('unreachable')
    assert.equal(outcome.movedTo, `${path}.bad`)
    assert.equal(existsSync(path), false)
    // The evidence, and somebody's arrangement of their desk, are both still there.
    assert.equal(readFileSync(`${path}.bad`, 'utf8'), '{ this is not json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no file at all is an ordinary first launch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peek-workspace-'))
  try {
    assert.equal(readWorkspaceFile(join(dir, 'workspace.json')).kind, 'absent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the persister writes once per burst, and not at all for a result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peek-workspace-'))
  try {
    const path = join(dir, 'workspace.json')
    const h = harness()
    const timers: (() => void)[] = []
    const persister = createWorkspacePersister({
      store: h.store,
      path,
      setTimer: ((fn: () => void) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimer: () => {
        /* the fake queue is drained by hand */
      },
    })

    const connId = await connect(h)
    const viewId = await open(h, { kind: 'table', connId, ref: ORDERS })
    assert.equal(existsSync(path), false, 'nothing is written before the debounce fires')

    persister.flush()
    assert.equal(existsSync(path), true)
    const afterOpen = readFileSync(path, 'utf8')

    const resultId = resultIdOf(h, viewId)
    assert.ok(resultId)
    h.store.apply(
      (draft) => {
        finishResult(draft, resultId, { rows: 5_000, elapsedMs: 12 })
      },
      { source: 'system' },
    )
    persister.flush()

    assert.equal(readFileSync(path, 'utf8'), afterOpen, 'a result is not part of the desk')
    persister.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

test('a saved desk comes back: the tree, the tabs, their order and the active one', async () => {
  const saved = harness()
  const connId = await connect(saved)
  const split = await saved.bus.dispatch(
    'layout.split',
    { panelId: asPanelId('panel_root'), dir: 'row' },
    'ui',
  )
  assert.equal(split.ok, true)
  if (!split.ok) throw new Error('unreachable')

  await open(saved, { kind: 'table', connId, ref: ORDERS }, asPanelId('panel_root'))
  const queryId = await open(
    saved,
    { kind: 'query', connId, text: 'select count(*) from orders' },
    split.data.panelId,
  )
  const treeId = await open(saved, { kind: 'tree', connId, expanded: ['public'] }, split.data.panelId)
  await saved.bus.dispatch(
    'view.update',
    { viewId: treeId, patch: { kind: 'tree', selected: 'public.orders' } },
    'ui',
  )
  // Leave the *first* tab of the two-tab panel in front, so restoring the active
  // tab is something more than "whichever was opened last".
  await saved.bus.dispatch('view.activate', { viewId: queryId }, 'ui')

  const projection = projectWorkspace(saved.store.getState())
  const file = { version: WORKSPACE_FILE_VERSION, savedAt: '', ...projection }

  const restored = harness()
  const report = await restoreWorkspace({
    workspace: file,
    bus: restored.bus,
    book: bookOf([identityOf(saved, connId)]),
  })

  assert.equal(report.layoutError, undefined)
  assert.equal(report.connectionsOpened, 1)
  assert.deepEqual(report.connectionsMissing, [])
  assert.equal(report.viewsOpened, 3)
  assert.equal(report.viewsFailed, 0)

  // The desk is compared with itself, through the only door there is.
  const after = projectWorkspace(restored.store.getState())
  assert.deepEqual(after.layout, projection.layout)
  assert.deepEqual(after.views, projection.views)
  assert.equal(after.focusPanel, projection.focusPanel)
})

test('a restored query view keeps its text and does not run it', async () => {
  const saved = harness()
  const connId = await connect(saved)
  await open(saved, { kind: 'query', connId, text: 'delete-shaped-but-harmless select 1' })
  const projection = projectWorkspace(saved.store.getState())

  const restored = harness()
  await restoreWorkspace({
    workspace: { version: WORKSPACE_FILE_VERSION, savedAt: '', ...projection },
    bus: restored.bus,
    book: bookOf([identityOf(saved, connId)]),
  })

  const view = Object.values(restored.store.getState().views).find((v) => v.kind === 'query')
  assert.equal(view?.kind === 'query' ? view.text : null, 'delete-shaped-but-harmless select 1')
  assert.equal(
    restored.started.some((s) => s.what === 'query'),
    false,
    'restoring a desk must not execute the statement left in an editor',
  )
})

test('a connection the book has forgotten takes its views with it, and says so', async () => {
  const saved = harness()
  const connId = await connect(saved)
  await open(saved, { kind: 'table', connId, ref: ORDERS })
  const projection = projectWorkspace(saved.store.getState())

  const restored = harness()
  const report = await restoreWorkspace({
    workspace: { version: WORKSPACE_FILE_VERSION, savedAt: '', ...projection },
    bus: restored.bus,
    book: bookOf([]),
  })

  assert.equal(report.connectionsOpened, 0)
  assert.deepEqual(report.connectionsMissing, [identityOf(saved, connId)])
  assert.equal(report.viewsOpened, 0)
  // The layout itself still came back — an empty panel is somewhere to work.
  assert.equal(Object.keys(restored.store.getState().views).length, 0)
})

test('a spec this build cannot parse costs one view, not the file', async () => {
  const saved = harness()
  const connId = await connect(saved)
  await open(saved, { kind: 'table', connId, ref: ORDERS })
  const projection = projectWorkspace(saved.store.getState())
  const damaged = {
    version: WORKSPACE_FILE_VERSION,
    savedAt: '',
    ...projection,
    views: [{ ref: 'v0', conn: 'c1', spec: { kind: 'table' } }, ...projection.views],
  }
  const panel = damaged.layout
  if (panel.type !== 'panel') throw new Error('the fixture is a single panel')
  panel.views = ['v0', ...panel.views]

  const restored = harness()
  const report = await restoreWorkspace({
    workspace: damaged,
    bus: restored.bus,
    book: bookOf([identityOf(saved, connId)]),
  })

  assert.equal(report.viewsFailed, 1)
  assert.equal(report.viewsOpened, 1)
})

/* ------------------------------------------------------------------ */
/* The wake-up                                                         */
/* ------------------------------------------------------------------ */

test('views opened against a connecting connection fetch when it comes up', async () => {
  const h = harness({ holdConnect: true })
  const wake = createConnectionWake({ store: h.store, bus: h.bus })

  // Not awaited: the reducer has already put a `connecting` connection in the
  // workspace, which is exactly the state a restore builds its layout on.
  const connecting = h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'system')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId | undefined
  assert.ok(connId, 'conn.open must publish the connection before its handshake')
  assert.equal(h.store.getState().connections[connId]?.status, 'connecting')

  await open(h, { kind: 'table', connId, ref: ORDERS })
  await open(h, { kind: 'query', connId, text: 'select 1' })
  assert.deepEqual(h.started, [], 'nothing can fetch while the connection is dialling')

  h.releaseConnect()
  await connecting
  // The wake dispatches; let those commands settle.
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(h.started, [{ what: 'scan' }], 'the table fills in, the statement does not run')
  wake.dispose()
})

test('a status event that arrives before the handshake settles does not fetch', async () => {
  const h = harness({ holdConnect: true })
  const wake = createConnectionWake({ store: h.store, bus: h.bus })

  const connecting = h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'system')
  const connId = Object.keys(h.store.getState().connections)[0] as ConnId | undefined
  assert.ok(connId)
  await open(h, { kind: 'table', connId, ref: ORDERS })

  // What the driver host's own `status` event does on its way through
  // `wireConnectionEvents`: the status, and nothing else. The connection manager
  // has not filled in its capability set yet, so a fetch started here comes back
  // UNSUPPORTED_CAPABILITY for a driver that supports it.
  h.store.apply(
    (draft) => {
      const conn = draft.connections[connId]
      if (conn) conn.status = 'ready'
    },
    { source: 'system' },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.started, [], 'ready without a settled handshake is not a reason to fetch')

  // And when the handshake really does settle, it fetches.
  h.releaseConnect()
  await connecting
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(h.started, [{ what: 'scan' }])
  wake.dispose()
})

test('a view that already fetched is left alone when the connection comes back', async () => {
  const h = harness()
  const connId = await connect(h)
  const viewId = await open(h, { kind: 'table', connId, ref: ORDERS })
  const resultId = resultIdOf(h, viewId)
  assert.ok(resultId)
  h.store.apply(
    (draft) => {
      finishResult(draft, resultId, { rows: 3, elapsedMs: 1 })
    },
    { source: 'system' },
  )

  const wake = createConnectionWake({ store: h.store, bus: h.bus })
  const before = h.started.length

  // A reconnect: away, and back with a handshake that really settled (a fresh
  // `readyAt`, which is what the wake watches).
  h.store.apply(
    (draft) => {
      const conn = draft.connections[connId]
      if (conn) conn.status = 'error'
    },
    { source: 'system' },
  )
  h.store.apply(
    (draft) => {
      const conn = draft.connections[connId]
      if (conn) {
        conn.status = 'ready'
        conn.readyAt = (conn.readyAt ?? 0) + 1_000
      }
    },
    { source: 'system' },
  )
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(h.started.length, before, 'rows on screen are not thrown away by a reconnect')
  wake.dispose()
})

function resultIdOf(h: Harness, viewId: ViewId): ReturnType<typeof idOf> {
  return idOf(h, viewId)
}

function idOf(h: Harness, viewId: ViewId) {
  const view = h.store.getState().views[viewId]
  return view && 'resultId' in view ? view.resultId : undefined
}
