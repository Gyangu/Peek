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
import { notify } from './notifyStore'

// immer 的 patch 能力是插件式的，applyPatches 用前必须启用
enablePatches()

/**
 * Workspace **镜像**。真源在 main：
 * renderer 只做两件事——应用 patch、按 rev 校验连续性。
 * 任何组件都不允许直接写这里的 workspace（唯一入口是 main 广播的 patch）。
 */
interface WorkspaceMirrorState {
  workspace: Workspace | null
  /** 已经拿到过至少一次全量快照 */
  ready: boolean
  /** 桥不可用（preload 未注入）——UI 进只读演示态 */
  bridgeMissing: boolean
  /** 正在重新对齐快照 */
  resyncing: boolean
  /** 累计因 rev 断层触发的重新对齐次数，状态栏会显示，便于发现丢包 */
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
/* patch / snapshot 同步                                                 */
/* ==================================================================== */

/** 重新对齐期间到达的 patch 先缓冲，快照落地后再按 rev 续上 */
const pending: StatePatchMessage[] = []
let resyncInflight: Promise<void> | null = null

function applySnapshot(msg: StateSnapshotMessage): void {
  const ws: Workspace = { ...msg.workspace, rev: msg.rev }
  setState({ workspace: ws, ready: true, resyncing: false })
  drainPending()
}

function drainPending(): void {
  if (pending.length === 0) return
  // 按 fromRev 排序后逐条尝试续接，接不上的直接丢（快照已经比它新）
  pending.sort((a, b) => a.fromRev - b.fromRev)
  const queued = pending.splice(0, pending.length)
  for (const msg of queued) {
    const ws = getState().workspace
    if (!ws) break
    if (msg.rev <= ws.rev) continue // 已包含在快照里
    if (msg.fromRev !== ws.rev) {
      void resync('缓冲 patch 无法续接')
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
    void resync(`patch 应用失败：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  // main 通常会把 rev 一起写进 patch；没写就在这里补齐，保证镜像 rev 权威
  setState({ workspace: next.rev === msg.rev ? next : { ...next, rev: msg.rev } })
}

function onPatch(msg: StatePatchMessage): void {
  const st = getState()
  if (!st.ready || st.resyncing || !st.workspace) {
    pending.push(msg)
    if (!st.resyncing && !st.ready) void resync('尚未拿到首个快照')
    return
  }
  const ws = st.workspace
  if (msg.rev <= ws.rev) return // 重复广播，忽略
  if (msg.fromRev !== ws.rev) {
    // rev 断层 = 丢包，必须走全量快照重新对齐（PLAN 第 5 节同步机制）
    pending.push(msg)
    void resync(`rev 断层：本地 ${ws.rev}，收到 fromRev ${msg.fromRev}`)
    return
  }
  commitPatch(ws, msg)
}

/** 拉全量快照重新对齐。并发调用会合并成同一次请求。 */
export function resync(reason?: string): Promise<void> {
  if (resyncInflight) return resyncInflight
  const bridge = tryBridge()
  if (!bridge) {
    setState({ bridgeMissing: true, resyncing: false })
    return Promise.resolve()
  }
  const bumped = getState().ready
  setState({ resyncing: true, ...(bumped ? { resyncCount: getState().resyncCount + 1 } : {}) })
  if (reason && bumped) notify('warn', '状态重新对齐', reason)

  resyncInflight = bridge
    .getSnapshot()
    .then((snap) => {
      applySnapshot(snap)
    })
    .catch((e: unknown) => {
      setState({ resyncing: false })
      notify('error', '读取状态快照失败', e instanceof Error ? e.message : String(e))
    })
    .finally(() => {
      resyncInflight = null
    })
  return resyncInflight
}

let started = false

/**
 * 接线 preload：订阅 patch / notify，拉首个快照。
 * 在模块加载阶段调用一次（不放 effect 里，避免 StrictMode 双订阅）。
 */
export function startWorkspaceSync(): void {
  if (started) return
  started = true
  const bridge = tryBridge()
  if (!bridge) {
    setState({ bridgeMissing: true })
    notify('error', 'preload 桥未就绪', '窗口以只读演示态运行；请确认 preload/index.cjs 已构建并挂载。')
    return
  }
  bridge.onPatch(onPatch)
  bridge.onNotify((m) => {
    notify(m.level, m.message, m.detail)
  })
  void resync()
}

/* ==================================================================== */
/* 只读选择器                                                            */
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

/** 连接表：immer 结构共享保证对象未变时引用不变，可以直接当依赖 */
export function useConnectionsMap(): Record<ConnId, ConnectionState> | null {
  return useWorkspaceStore((s) => s.workspace?.connections ?? null)
}

export function useConnections(): ConnectionState[] {
  const map = useConnectionsMap()
  return map ? Object.values(map) : EMPTY_CONNS
}

export function useConnection(connId: ConnId | null | undefined): ConnectionState | null {
  return useWorkspaceStore((s) =>
    connId && s.workspace ? (s.workspace.connections[connId] ?? null) : null,
  )
}

export function useView(viewId: ViewId | null | undefined): ViewState | null {
  return useWorkspaceStore((s) => (viewId && s.workspace ? (s.workspace.views[viewId] ?? null) : null))
}

export function useViews(): ViewState[] {
  const map = useWorkspaceStore((s) => s.workspace?.views ?? null)
  return map ? Object.values(map) : EMPTY_VIEWS
}

export function useResultMeta(resultId: ResultId | null | undefined): ResultMeta | null {
  return useWorkspaceStore((s) =>
    resultId && s.workspace ? (s.workspace.results[resultId] ?? null) : null,
  )
}

/** 非 hook 读取，供事件回调使用 */
export function readWorkspace(): Workspace | null {
  return getState().workspace
}
