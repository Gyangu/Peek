import type {
  ChatViewState,
  ConnId,
  LayoutNode,
  PanelId,
  ViewOpenSpec,
  ViewState,
  Workspace,
} from '@peek/core'
import {
  writeWorkspaceFile,
  WORKSPACE_FILE_VERSION,
  type PersistedConnection,
  type PersistedNode,
  type PersistedView,
  type PersistedWorkspace,
} from './config/workspace-file'
import type { WorkspaceStore } from './store/workspace-store'

/**
 * Turning the live workspace into the file, and keeping the file up to date.
 *
 * ## What "up to date" costs
 *
 * Nothing on the hot path, and that falls out of *what* is projected rather than
 * from any throttling cleverness. A running query rewrites `ResultMeta.rows`
 * several times a second and every one of those changes reaches this
 * subscriber — but `results` is not in the projection, so the projection is
 * identical and no write is scheduled. Only a change to the shape of the desk
 * (a tab opened, a split dragged, a statement edited) produces a different
 * projection, and those arrive at human speed.
 *
 * The debounce on top of that is for the burst a single gesture makes: dragging
 * a divider emits a `layout.setRatio` per frame, and each one *is* a real
 * projection change.
 *
 * ## Why the projection is typed as `ViewOpenSpec`
 *
 * `specOf` below could have returned a hand-built record, and then "does the
 * file contain a `cursorToken`?" would be a question about whether somebody
 * remembered. Building an actual `ViewOpenSpec` makes it a question the compiler
 * answers: a spec has no field for a cursor, a result id or a status, and an
 * object literal carrying one does not type-check.
 */

/** The file, minus the two fields that are about the file rather than the desk. */
export type WorkspaceProjection = Omit<PersistedWorkspace, 'version' | 'savedAt'>

export function projectWorkspace(state: Workspace): WorkspaceProjection {
  const connRefs = new Map<ConnId, string>()
  const connections: PersistedConnection[] = []
  const views: PersistedView[] = []
  const viewRefs = new Map<string, string>()
  const panelKeys = new Map<PanelId, string>()

  const connRefOf = (connId: ConnId): string | null => {
    const existing = connRefs.get(connId)
    if (existing !== undefined) return existing
    const conn = state.connections[connId]
    // A view whose connection is gone cannot name what it was looking at, so it
    // is dropped rather than saved pointing at nothing.
    if (!conn || conn.identity.length === 0) return null
    const ref = `c${String(connections.length + 1)}`
    connRefs.set(connId, ref)
    connections.push({ ref, identity: conn.identity })
    return ref
  }

  /** Depth-first, so the same tree always produces the same keys and refs. */
  const project = (node: LayoutNode): PersistedNode => {
    if (node.type === 'split') {
      return {
        type: 'split',
        dir: node.dir,
        ratio: [...node.ratio],
        children: node.children.map(project),
      }
    }

    const key = `p${String(panelKeys.size + 1)}`
    panelKeys.set(node.id, key)

    const tabs: string[] = []
    for (const viewId of node.viewIds) {
      const view = state.views[viewId]
      if (!view) continue
      const saved = saveView(view, connRefOf, views.length)
      if (saved === null) continue
      views.push(saved)
      viewRefs.set(viewId, saved.ref)
      tabs.push(saved.ref)
    }

    const activeRef = node.activeViewId === null ? undefined : viewRefs.get(node.activeViewId)
    return {
      type: 'panel',
      key,
      views: tabs,
      // P1/P2 restated in the file's own terms: the active tab is one of this
      // panel's tabs, and absent exactly when there are none. A view that was
      // dropped above (provisional, or its connection is gone) takes the active
      // marker with it, and the restore falls back to the first tab.
      ...(activeRef !== undefined && tabs.includes(activeRef) ? { active: activeRef } : {}),
    }
  }

  const layout = project(state.layout)
  const focusPanel = state.focusedPanel === null ? undefined : panelKeys.get(state.focusedPanel)

  return {
    connections,
    views,
    layout,
    ...(focusPanel === undefined ? {} : { focusPanel }),
  }
}

/**
 * One view, or null when it is not something to come back to.
 *
 * Three ways to be dropped, all of them saying "there is nothing here to
 * restore" rather than "this failed":
 *
 * - **provisional** — a view opened to be glanced at, which by definition was
 *   not being kept (`ViewBase.provisional`);
 * - **no connection** — the connection it belongs to is no longer in the
 *   workspace, so the file cannot say which server it was reading;
 * - **a chat with no session** — see below.
 */
function saveView(
  view: ViewState,
  connRefOf: (connId: ConnId) => string | null,
  index: number,
): PersistedView | null {
  if (view.provisional === true) return null

  const spec = specOf(view)
  if (spec === null) return null

  const { connId, ...rest } = spec
  const conn = connId === undefined ? null : connRefOf(connId)
  // Every kind but chat is a window onto exactly one connection and cannot be
  // opened without it (`ConnectedViewBase`).
  if (conn === null && view.kind !== 'chat') return null

  const ref = `v${String(index + 1)}`
  const autoRefreshMs = 'autoRefreshMs' in view ? view.autoRefreshMs : undefined

  return {
    ref,
    spec: rest,
    ...(conn === null ? {} : { conn }),
    ...(autoRefreshMs === undefined ? {} : { autoRefreshMs }),
    // `expanded` is on the spec; the selected node is not, so it rides alongside.
    ...(view.kind === 'tree' && view.selected !== undefined ? { treeSelected: view.selected } : {}),
  }
}

/**
 * The spec that would open this view again.
 *
 * Written as a `switch` over the seven kinds rather than by copying "everything
 * except a deny-list" — an eighth kind must be a compile error here, because the
 * failure of the other shape is silent: a new field would be saved, restored,
 * and quietly wrong.
 */
function specOf(view: ViewState): ViewOpenSpec | null {
  const title = view.title === undefined ? {} : { title: view.title }

  switch (view.kind) {
    case 'table':
      return {
        kind: 'table',
        connId: view.connId,
        ref: view.ref,
        ...(view.filter === undefined ? {} : { filter: view.filter }),
        ...(view.sort === undefined ? {} : { sort: view.sort }),
        offset: view.page.offset,
        limit: view.page.limit,
        ...title,
      }

    case 'query':
      // Deliberately no `run`. Restoring a desk must not execute the statement
      // somebody left in an editor — see the design's §2.4 step 7.
      return { kind: 'query', connId: view.connId, text: view.text, ...title }

    case 'inspector':
      return { kind: 'inspector', connId: view.connId, ref: view.ref, ...title }

    case 'tree':
      return { kind: 'tree', connId: view.connId, expanded: [...view.expanded], ...title }

    case 'vector':
      return {
        kind: 'vector',
        connId: view.connId,
        collection: view.collection,
        ...(view.queryVec === undefined ? {} : { queryVec: view.queryVec }),
        ...(view.queryPointId === undefined ? {} : { queryPointId: view.queryPointId }),
        ...(view.queryText === undefined ? {} : { queryText: view.queryText }),
        ...(view.vectorName === undefined ? {} : { vectorName: view.vectorName }),
        topK: view.topK,
        ...(view.scoreThreshold === undefined ? {} : { scoreThreshold: view.scoreThreshold }),
        ...(view.filter === undefined ? {} : { filter: view.filter }),
        ...title,
      }

    case 'chat':
      return chatSpecOf(view, title)

    case 'package':
      return {
        kind: 'package',
        packageKind: view.packageKind,
        connId: view.connId,
        state: { ...view.state },
        ...title,
      }
  }
}

/**
 * A conversation is stored as **one id**, and the id is the agent's.
 *
 * Not the transcript, not `messageCount`, not `lastMessagePreview`. The rule
 * `2026-08-03-chat-history-ownership.md` set and `2026-08-06` §2.2 restated is
 * that an ACP conversation belongs to Claude Code or Codex, and peek may
 * remember what it *showed* — which it already does, per session id, under
 * `~/.peek/chat/snapshots/`. So the workspace file contributes the id and
 * nothing else, and a restored chat view takes exactly the path a conversation
 * opened from the session rail takes: snapshot first, the agent's own copy when
 * `session/load` returns, and the §2.4 failure posture when it does not.
 *
 * A conversation with no agent session — opened, never spoken to — has nothing
 * to resume and is dropped. Restoring an empty chat panel and restoring no chat
 * panel differ by one keystroke; restoring one that *looks* like a conversation
 * and cannot answer is the failure that rule exists to prevent.
 */
function chatSpecOf(view: ChatViewState, title: { title?: string }): ViewOpenSpec | null {
  const sessionId = view.agentSessionId ?? view.resumeSessionId
  if (sessionId === undefined || sessionId === null || sessionId.length === 0) return null
  return {
    kind: 'chat',
    ...(view.connId === undefined ? {} : { connId: view.connId }),
    permissionMode: view.permissionMode,
    resumeSessionId: sessionId,
    ...title,
  }
}

/* ------------------------------------------------------------------ */
/* Keeping the file current                                            */
/* ------------------------------------------------------------------ */

export interface WorkspacePersister {
  /** Write now if anything is pending. Called on quit, where a timer would never fire. */
  flush(): void
  dispose(): void
}

export interface WorkspacePersisterOptions {
  store: WorkspaceStore
  path: string
  /** Coalesce a gesture's worth of changes. A divider drag is one `setRatio` per frame. */
  delayMs?: number
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** Reported rather than thrown: a workspace that cannot be saved must not break the session. */
  onError?: (message: string, detail: string) => void
}

export const WORKSPACE_SAVE_DELAY_MS = 250

export function createWorkspacePersister(options: WorkspacePersisterOptions): WorkspacePersister {
  const { store, path } = options
  const delayMs = options.delayMs ?? WORKSPACE_SAVE_DELAY_MS
  const now = options.now ?? ((): Date => new Date())
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ??
    ((handle): void => {
      clearTimeout(handle)
    })
  const onError = options.onError ?? ((): void => {})

  /**
   * The last projection written, serialized. Comparing strings rather than
   * revisions is what makes the result-row storm free: `rev` moves on every
   * committed command, this only moves when the desk does.
   */
  let written: string | null = null
  let pending: { text: string; projection: WorkspaceProjection } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const write = (): void => {
    const next = pending
    pending = null
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (next === null) return

    const file: PersistedWorkspace = {
      version: WORKSPACE_FILE_VERSION,
      savedAt: now().toISOString(),
      ...next.projection,
    }
    try {
      writeWorkspaceFile(path, file)
      written = next.text
    } catch (error) {
      onError(
        'The workspace could not be saved.',
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const consider = (state: Workspace): void => {
    const projection = projectWorkspace(state)
    const text = JSON.stringify(projection)
    if (text === written || text === pending?.text) return
    pending = { text, projection }
    if (timer !== null) clearTimer(timer)
    timer = setTimer(write, delayMs)
  }

  const unsubscribe = store.subscribe((_change, state) => {
    consider(state)
  })

  return {
    flush() {
      write()
    },
    dispose() {
      unsubscribe()
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
  }
}
