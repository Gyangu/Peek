import { applyPatches, enablePatches } from 'immer'
import { create } from 'zustand'
import type {
  ConnId,
  ConnectionState,
  LayoutNode,
  PanelId,
  ResultId,
  ResultMeta,
  StatePatchMessage,
  StateSnapshotMessage,
  ViewId,
  ViewState,
  Workspace,
} from '@peek/core'
import { tryBridge } from '../bridge'
import { tStatic } from '../i18n'
import { notify } from './notifyStore'

// immer's patch support is a plugin; applyPatches needs it switched on first
enablePatches()

/**
 * The Workspace **mirror**. The source of truth is in main, and the renderer does
 * exactly two things with it: apply patches, and check revision continuity.
 * No component may write `workspace` here — the only way in is a patch broadcast
 * by main.
 */
interface WorkspaceMirrorState {
  workspace: Workspace | null
  /** At least one full snapshot has arrived. */
  ready: boolean
  /** The bridge is unavailable (preload was not injected) — read-only demo mode. */
  bridgeMissing: boolean
  /** A snapshot realignment is in progress. */
  resyncing: boolean
  /** How many realignments a revision gap has forced; shown in the status bar so
   *  dropped broadcasts are visible. */
  resyncCount: number
}

export const useWorkspaceStore = create<WorkspaceMirrorState>(() => ({
  workspace: null,
  ready: false,
  bridgeMissing: false,
  resyncing: false,
  resyncCount: 0,
}))

const setState = useWorkspaceStore.setState
const getState = useWorkspaceStore.getState

/* ==================================================================== */
/* patch / snapshot synchronization                                       */
/* ==================================================================== */

/** Patches that arrive mid-realignment are buffered and re-applied by revision
 *  once the snapshot lands. */
const pending: StatePatchMessage[] = []
let resyncInflight: Promise<void> | null = null

function applySnapshot(msg: StateSnapshotMessage): void {
  const ws: Workspace = { ...msg.workspace, rev: msg.rev }
  setState({ workspace: ws, ready: true, resyncing: false })
  drainPending()
}

function drainPending(): void {
  if (pending.length === 0) return
  // Sort by fromRev, then splice them on one at a time; anything that no longer
  // fits is dropped, because the snapshot is already newer than it
  pending.sort((a, b) => a.fromRev - b.fromRev)
  const queued = pending.splice(0, pending.length)
  for (const msg of queued) {
    const ws = getState().workspace
    if (!ws) break
    if (msg.rev <= ws.rev) continue // already contained in the snapshot
    if (msg.fromRev !== ws.rev) {
      void resync('a buffered patch no longer splices on')
      return
    }
    commitPatch(ws, msg)
  }
}

function commitPatch(base: Workspace, msg: StatePatchMessage): void {
  let next: Workspace
  try {
    next = applyPatches(base, msg.patches)
  } catch (e) {
    void resync(`patch application failed: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  // main usually writes rev into the patch itself; fill it in otherwise, so the
  // mirror's revision stays authoritative
  setState({ workspace: next.rev === msg.rev ? next : { ...next, rev: msg.rev } })
}

function onPatch(msg: StatePatchMessage): void {
  const st = getState()
  if (!st.ready || st.resyncing || !st.workspace) {
    pending.push(msg)
    if (!st.resyncing && !st.ready) void resync('the first snapshot has not arrived yet')
    return
  }
  const ws = st.workspace
  if (msg.rev <= ws.rev) return // duplicate broadcast, ignore
  if (msg.fromRev !== ws.rev) {
    // A revision gap means a dropped broadcast, and the only cure is a full
    // snapshot realignment (PLAN §5, synchronization)
    pending.push(msg)
    void resync(`revision gap: local ${ws.rev}, received fromRev ${msg.fromRev}`)
    return
  }
  commitPatch(ws, msg)
}

/**
 * Realign by pulling a full snapshot. Concurrent calls collapse into one request.
 *
 * `reason` is an internal diagnostic and stays English: it names revisions and
 * patch state, and it travels straight into bug reports.
 */
export function resync(reason?: string): Promise<void> {
  if (resyncInflight) return resyncInflight
  const bridge = tryBridge()
  if (!bridge) {
    setState({ bridgeMissing: true, resyncing: false })
    return Promise.resolve()
  }
  const bumped = getState().ready
  setState({ resyncing: true, ...(bumped ? { resyncCount: getState().resyncCount + 1 } : {}) })
  if (reason && bumped) notify('warn', tStatic('app.notify.resync'), reason)

  resyncInflight = bridge
    .getSnapshot()
    .then((snap) => {
      applySnapshot(snap)
    })
    .catch((e: unknown) => {
      setState({ resyncing: false })
      notify('error', tStatic('app.notify.snapshotFailed'), e instanceof Error ? e.message : String(e))
    })
    .finally(() => {
      resyncInflight = null
    })
  return resyncInflight
}

let started = false

/**
 * Wire up preload: subscribe to patches and notifications, pull the first
 * snapshot. Called once at module load — not from an effect, because StrictMode
 * would subscribe twice.
 */
export function startWorkspaceSync(): void {
  if (started) return
  started = true
  const bridge = tryBridge()
  if (!bridge) {
    setState({ bridgeMissing: true })
    notify('error', tStatic('app.bridgeNotReady'), tStatic('app.notify.bridgeMissingDetail'))
    return
  }
  bridge.onPatch(onPatch)
  bridge.onNotify((m) => {
    notify(m.level, m.message, m.detail)
  })
  void resync()
}

/* ==================================================================== */
/* Read-only selectors                                                    */
/* ==================================================================== */

const EMPTY_CONNS: ConnectionState[] = []
const EMPTY_VIEWS: ViewState[] = []

export function useWorkspace(): Workspace | null {
  return useWorkspaceStore((s) => s.workspace)
}

export function useLayout(): LayoutNode | null {
  return useWorkspaceStore((s) => s.workspace?.layout ?? null)
}

export function useFocusedPanel(): PanelId | null {
  return useWorkspaceStore((s) => s.workspace?.focusedPanel ?? null)
}

/** The connection map. immer's structural sharing keeps the reference stable
 *  while the object is unchanged, so it can be used as a dependency directly. */
export function useConnectionsMap(): Record<ConnId, ConnectionState> | null {
  return useWorkspaceStore((s) => s.workspace?.connections ?? null)
}

export function useConnections(): ConnectionState[] {
  const map = useConnectionsMap()
  return map ? Object.values(map) : EMPTY_CONNS
}

export function useConnection(connId: ConnId | null | undefined): ConnectionState | null {
  return useWorkspaceStore((s) => (connId && s.workspace ? (s.workspace.connections[connId] ?? null) : null))
}

export function useView(viewId: ViewId | null | undefined): ViewState | null {
  return useWorkspaceStore((s) => (viewId && s.workspace ? (s.workspace.views[viewId] ?? null) : null))
}

export function useViews(): ViewState[] {
  const map = useWorkspaceStore((s) => s.workspace?.views ?? null)
  return map ? Object.values(map) : EMPTY_VIEWS
}

export function useResultMeta(resultId: ResultId | null | undefined): ResultMeta | null {
  return useWorkspaceStore((s) => (resultId && s.workspace ? (s.workspace.results[resultId] ?? null) : null))
}

/** Non-hook read, for event callbacks. */
export function readWorkspace(): Workspace | null {
  return getState().workspace
}
