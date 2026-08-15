import { newConnId, type ConnId, type LayoutSpecNode, type PanelId, type ViewId } from '@peek/core'
import type { CommandBus } from './bus'
import type { ConnectionBook } from './config'
import type { PersistedNode, PersistedView, PersistedWorkspace } from './config/workspace-file'

/**
 * Putting the desk back, using nothing but the commands a person or a model
 * could have sent.
 *
 * ## Why it is a sequence of Commands and not a `setState`
 *
 * Restoring by writing straight into the Workspace Store would be shorter, and
 * would be the second write path into main's source of truth — the one thing
 * PLAN §1 and §3 are organised around not having. Going through the bus means
 * the file gets no privileges: `layout.setLayout` checks the tree caps and the
 * panel invariants, each `view.open` runs its spec through that kind's zod
 * schema, and a hand-edited `workspace.json` can therefore cost a view but
 * cannot produce a workspace the rest of the app does not believe in.
 *
 * The source is `system` — "main acting on its own, nobody asked for this right
 * now", the same label auto-refresh ticks carry.
 *
 * ## The order, and the one thing it does not wait for
 *
 *   1. `conn.open` per connection, **not awaited**
 *   2. `layout.setLayout` — the tree, every panel empty and keyed
 *   3. `view.open` per tab, in tab-bar order
 *   4. `view.update` for the two things a spec cannot carry
 *   5. `view.activate` per panel
 *
 * Step 1 is the interesting one. `conn.open`'s reducer runs synchronously and
 * puts a `connecting` connection into the workspace immediately; the handshake
 * is an effect that the returned promise waits on. Awaiting it would hold the
 * whole restore — and therefore the window — behind the slowest database in the
 * file, and a server that is down would take its half of the layout with it. So
 * the promise is left running: the layout is built on connections that are still
 * dialling, every view opens `idle`, and `main/connection-wake.ts` fetches them
 * when their connection reports ready.
 */

export interface RestoreWorkspaceOptions {
  workspace: PersistedWorkspace
  bus: CommandBus
  book: ConnectionBook
  /** Where a partial restore is explained. Absent in tests. */
  notify?: (message: string, detail?: string) => void
}

export interface RestoreReport {
  /** Connections asked to open. They are still connecting when this returns. */
  connectionsOpened: number
  /** Identities the connection book no longer has an entry for; their views were skipped. */
  connectionsMissing: string[]
  viewsOpened: number
  /** Views whose `view.open` was refused — a spec this build cannot parse, most plausibly. */
  viewsFailed: number
  /** Set when the layout itself was refused, in which case nothing else was attempted. */
  layoutError?: string
}

export async function restoreWorkspace(options: RestoreWorkspaceOptions): Promise<RestoreReport> {
  const { workspace, bus, book } = options
  const report: RestoreReport = {
    connectionsOpened: 0,
    connectionsMissing: [],
    viewsOpened: 0,
    viewsFailed: 0,
  }

  /* 1. Connections ------------------------------------------------- */

  const byIdentity = new Map(book.list().map((entry) => [entry.identity, entry]))
  const connIds = new Map<string, ConnId>()

  for (const saved of workspace.connections) {
    const entry = byIdentity.get(saved.identity)
    if (entry === undefined) {
      // Forgotten between sessions. Its views are dropped in step 3; saying so
      // once per connection beats saying it once per view.
      report.connectionsMissing.push(saved.identity)
      continue
    }

    const connId = newConnId()
    connIds.set(saved.ref, connId)
    report.connectionsOpened += 1

    // The id is minted here rather than read off the result precisely because
    // the result is not awaited — see the header.
    void bus
      .dispatch('conn.open', { config: book.hydrate(entry.config), connId }, 'system')
      .then((result) => {
        // A failed reconnect is not a failed restore: the connection lands in
        // `error`, its views are on screen, and the sidebar can retry. The error
        // centre already has the failure; this only names the connection.
        if (!result.ok) {
          options.notify?.(`Could not reconnect to ${entry.label || saved.identity}.`, result.error.message)
        }
      })
      .catch(() => {
        // `dispatch` resolves its own failures; this is belt and braces so an
        // unexpected rejection cannot become an unhandled promise on the launch
        // path.
      })
  }

  /* 2. The tree ---------------------------------------------------- */

  const keys = new Set<string>()
  const tree = toLayoutSpec(workspace.layout, keys)
  const focusKey =
    workspace.focusPanel !== undefined && keys.has(workspace.focusPanel) ? workspace.focusPanel : undefined

  const layout = await bus.dispatch(
    'layout.setLayout',
    { tree, ...(focusKey === undefined ? {} : { focusKey }) },
    'system',
  )
  if (!layout.ok) {
    report.layoutError = layout.error.message
    return report
  }

  const panelIds = new Map<string, PanelId>()
  for (const panel of layout.data.panels) {
    if (panel.key !== undefined) panelIds.set(panel.key, panel.panelId)
  }

  /* 3–5. The views ------------------------------------------------- */

  const viewsByRef = new Map(workspace.views.map((view) => [view.ref, view]))

  for (const panel of panelsOf(workspace.layout)) {
    const panelId = panelIds.get(panel.key)
    if (panelId === undefined) continue

    const opened = new Map<string, ViewId>()

    for (const ref of panel.views) {
      const view = viewsByRef.get(ref)
      if (view === undefined) continue

      const spec = specFor(view, connIds)
      if (spec === null) continue

      const result = await bus.dispatch(
        'view.open',
        // `focus: false` keeps the focused panel where `focusKey` put it. Every
        // open activates its own tab, which is why step 5 exists.
        { spec, panelId, focus: false },
        'system',
      )
      if (!result.ok) {
        report.viewsFailed += 1
        continue
      }

      report.viewsOpened += 1
      opened.set(ref, result.data.viewId)
      await applyExtras(bus, result.data.viewId, view)
    }

    const activeRef = panel.active
    const activeViewId = activeRef === undefined ? undefined : opened.get(activeRef)
    if (activeViewId !== undefined) {
      await bus.dispatch('view.activate', { viewId: activeViewId, focusPanel: false }, 'system')
    }
  }

  return report
}

/**
 * The two fields no `ViewOpenSpec` has room for, replayed as a patch.
 *
 * `refresh: false` on both: a restored view fetches when its connection comes
 * up (`connection-wake.ts`), and asking here would either be refused because the
 * connection is still dialling or — worse — succeed for the one connection that
 * happened to be fast, making the restore's behaviour depend on network timing.
 */
async function applyExtras(bus: CommandBus, viewId: ViewId, view: PersistedView): Promise<void> {
  const kind = kindOf(view.spec)
  if (kind === null) return

  if (view.autoRefreshMs !== undefined && REFRESHABLE.has(kind)) {
    await bus.dispatch(
      'view.update',
      { viewId, patch: { kind, autoRefreshMs: view.autoRefreshMs }, refresh: false },
      'system',
    )
  }

  if (view.treeSelected !== undefined && kind === 'tree') {
    await bus.dispatch(
      'view.update',
      { viewId, patch: { kind: 'tree', selected: view.treeSelected }, refresh: false },
      'system',
    )
  }
}

const REFRESHABLE = new Set(['table', 'query', 'vector', 'package'])

/**
 * The stored spec with its connection put back.
 *
 * Null means "this view cannot be opened in this session": its connection was
 * forgotten from the book, so there is no server for it to be a window onto.
 * A chat is the exception — it may have had no connection to begin with.
 */
function specFor(view: PersistedView, connIds: Map<string, ConnId>): Record<string, unknown> | null {
  const spec = view.spec
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return null
  const fields = { ...(spec as Record<string, unknown>) }

  if (view.conn === undefined) return kindOf(spec) === 'chat' ? fields : null

  const connId = connIds.get(view.conn)
  if (connId === undefined) return null
  fields['connId'] = connId
  return fields
}

function kindOf(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) return null
  const kind = (spec as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** Every panel leaf, in the file's own order. */
function panelsOf(
  node: PersistedNode,
  out: Extract<PersistedNode, { type: 'panel' }>[] = [],
): Extract<PersistedNode, { type: 'panel' }>[] {
  if (node.type === 'panel') {
    out.push(node)
    return out
  }
  for (const child of node.children) panelsOf(child, out)
  return out
}

/**
 * The file's tree as a `layout.setLayout` target: the same shape, every panel
 * empty and carrying its key.
 *
 * The views are deliberately **not** passed as the leaf's `open` array, which
 * would build the whole workspace in one command. A leaf's `activeViewId` can
 * only name a view that already exists — a newly opened one "has no id yet",
 * as the schema puts it — so a panel of four restored tabs could not say which
 * of them was in front. Opening them separately costs a few more commands, all
 * of them before the window exists, and keeps the tab that was on screen the
 * tab that comes back.
 */
function toLayoutSpec(node: PersistedNode, keys: Set<string>): LayoutSpecNode {
  if (node.type === 'panel') {
    keys.add(node.key)
    return { type: 'panel', key: node.key }
  }
  return {
    type: 'split',
    dir: node.dir,
    ...(node.ratio === undefined ? {} : { ratio: [...node.ratio] }),
    children: node.children.map((child) => toLayoutSpec(child, keys)),
  }
}
