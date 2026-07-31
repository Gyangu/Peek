import type { ColumnDef } from './chunk'
import type {
  Capability,
  CollectionRef,
  ConnectionConfig,
  DriverId,
  FilterSpec,
  ServerInfo,
  SortSpec,
  ValueRef,
} from './capability'
import { collectionRefLabel, defaultConnectionLabel, redactConnectionConfig } from './capability'
import type { PeekError } from './errors'
import { newPanelId, type ConnId, type PanelId, type ResultId, type SplitId, type ViewId } from './ids'

// 品牌类型在这里 re-export，方便按 PLAN 第 5 节从 workspace 直接取
export {
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from './ids'

/* ================================================================== */
/* 1. 连接状态机                                                        */
/* ================================================================== */

/** PLAN 第 5 节的连接状态机：idle → connecting → ready / error */
export type ConnStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface ConnectionState {
  id: ConnId
  driverId: DriverId
  /** 用户可见名 */
  label: string
  /**
   * 完整连接配置（含密码）。**只允许存在于 main 进程的真源里**。
   * 任何要发给 renderer / MCP 的地方一律先过 redactConnectionConfig。
   */
  config: ConnectionConfig
  status: ConnStatus
  /** ready 后由 driver host 回填的实际能力集 */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** status === 'error' 时有值 */
  error?: PeekError
  /** 建连成功时间戳（ms） */
  readyAt?: number
  /** driver host 的 utilityProcess pid，便于排查 */
  pid?: number
}

/* ================================================================== */
/* 2. 视图状态（PLAN 第 5 节五种 kind）                                   */
/* ================================================================== */

export type ViewStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ViewBase {
  id: ViewId
  connId: ConnId
  /** 标签页标题；不填由 UI 从内容推 */
  title?: string
  status: ViewStatus
  error?: PeekError
}

/** 集合浏览：表、keyspace、collection 统一走这个 */
export interface TableViewState extends ViewBase {
  kind: 'table'
  ref: CollectionRef
  filter?: FilterSpec[]
  sort?: SortSpec[]
  page: { offset: number; limit: number }
  /** 当前正在流的结果集 */
  resultId?: ResultId
  /** 续拉游标（redis SCAN / qdrant scroll） */
  cursorToken?: string
}

/** 自由查询（SQL 等） */
export interface QueryViewState extends ViewBase {
  kind: 'query'
  text: string
  resultId?: ResultId
}

/** 单值/单行检查器 */
export interface InspectorViewState extends ViewBase {
  kind: 'inspector'
  ref: ValueRef
}

/** 命名空间树 */
export interface TreeViewState extends ViewBase {
  kind: 'tree'
  /** 已展开的 NamespaceNode.id */
  expanded: string[]
  /** 当前选中的 NamespaceNode.id */
  selected?: string
}

/** 向量检索 */
export interface VectorViewState extends ViewBase {
  kind: 'vector'
  collection: string
  queryVec?: number[]
  /** 文本入口（由上层 embed 后填 queryVec；驱动不做 embedding） */
  queryText?: string
  topK: number
  filter?: FilterSpec[]
  resultId?: ResultId
}

export type ViewState =
  | TableViewState
  | QueryViewState
  | InspectorViewState
  | TreeViewState
  | VectorViewState

export type ViewKind = ViewState['kind']

export const VIEW_KINDS = ['table', 'query', 'inspector', 'tree', 'vector'] as const

/** 按 kind 取到具体的 ViewState 子类型 */
export type ViewStateOf<K extends ViewKind> = Extract<ViewState, { kind: K }>

/* ================================================================== */
/* 3. 平铺布局树                                                        */
/* ================================================================== */

export interface SplitNode {
  type: 'split'
  /** layout.setRatio 靠它定位（PLAN 里的树没画 id，实现上必须有才能被 Command 寻址） */
  id: SplitId
  dir: 'row' | 'col'
  /** 各子节点占比，长度与 children 相同，和为 1 */
  ratio: number[]
  children: LayoutNode[]
}

export interface PanelNode {
  type: 'panel'
  id: PanelId
  /** null 表示空面板 */
  viewId: ViewId | null
}

export type LayoutNode = SplitNode | PanelNode

/* ================================================================== */
/* 4. 结果集元信息                                                      */
/* ================================================================== */

/**
 * 结果集状态机。
 *
 * 五个取值里 `paused` 是唯一一个"没跑完但一切正常"的终态：
 * 背压把流停住、驱动主动释放了服务端游标与连接，**已加载的行全部有效**。
 * 它刻意不与 `error` 合流——AI 与用户都必须能一眼分清
 * 「查询失败了」和「只是停下来了，数据是好的」。
 *
 *   running ─┬─► done       正常收尾
 *            ├─► paused     背压空闲超时，可重跑续取（truncated + resumable）
 *            ├─► error      真失败（SQL 报错、连接断、丢帧…）
 *            └─► cancelled  用户/上层主动取消
 */
export type ResultStatus = 'running' | 'done' | 'paused' | 'error' | 'cancelled'

/** 终态判定只有这一处实现，避免各处各写一遍 `!== 'running'` 后跑偏 */
export function isSettledResultStatus(status: ResultStatus): boolean {
  return status !== 'running'
}

/** 数据可信（已加载的行都是真数据）；只有 error 不满足 */
export function hasUsableRows(status: ResultStatus): boolean {
  return status !== 'error'
}

/**
 * 结果集的**元信息**，不含数据本体。数据只走 MessagePort 直达 renderer 缓存。
 * main 持有这份元信息，MCP 的 read_workspace 靠它汇报"跑了什么、多少行、多久"。
 */
export interface ResultMeta {
  id: ResultId
  connId: ConnId
  /** 触发这次执行的视图 */
  viewId: ViewId
  status: ResultStatus
  /** 首帧到达后回填 */
  schema?: ColumnDef[]
  /** 已确认收到的行数 */
  rows: number
  startedAt: number
  elapsedMs?: number
  /** 还有更多数据没取（maxRows 上限 / 背压暂停） */
  truncated?: boolean
  /** 重新执行即可继续取数；`status === 'paused'` 时恒为 true */
  resumable?: boolean
  /** status === 'paused' 时的人可读原因 */
  pausedReason?: string
  error?: PeekError
  /** 语句/扫描的简短描述，给 MCP 看的 */
  summary?: string
}

/* ================================================================== */
/* 5. Workspace（main 持真源）                                          */
/* ================================================================== */

export interface Workspace {
  /** 修订号，每落地一条 Command +1；patch 广播带上它，renderer 用来检测漏包 */
  rev: number
  connections: Record<ConnId, ConnectionState>
  layout: LayoutNode
  views: Record<ViewId, ViewState>
  results: Record<ResultId, ResultMeta>
  focusedPanel: PanelId | null
}

/**
 * 空工作区：一个根面板，无视图。
 * @param rootPanelId 可传入固定 id 让测试可复现
 */
export function createEmptyWorkspace(rootPanelId?: PanelId): Workspace {
  const panelId = rootPanelId ?? newPanelId()
  return {
    rev: 0,
    connections: {},
    layout: { type: 'panel', id: panelId, viewId: null },
    views: {},
    results: {},
    focusedPanel: panelId,
  }
}

/* ------------------------------------------------------------------ */
/* 布局树只读工具（纯函数，main 和 renderer 都能用）                       */
/* ------------------------------------------------------------------ */

/** 深度优先收集全部面板节点，顺序即视觉顺序 */
export function collectPanels(node: LayoutNode, out: PanelNode[] = []): PanelNode[] {
  if (node.type === 'panel') {
    out.push(node)
    return out
  }
  for (const child of node.children) collectPanels(child, out)
  return out
}

export function findPanel(node: LayoutNode, panelId: PanelId): PanelNode | null {
  if (node.type === 'panel') return node.id === panelId ? node : null
  for (const child of node.children) {
    const hit = findPanel(child, panelId)
    if (hit) return hit
  }
  return null
}

export function findSplit(node: LayoutNode, splitId: SplitId): SplitNode | null {
  if (node.type === 'panel') return null
  if (node.id === splitId) return node
  for (const child of node.children) {
    const hit = findSplit(child, splitId)
    if (hit) return hit
  }
  return null
}

/** 找到承载某视图的面板 */
export function findPanelOfView(node: LayoutNode, viewId: ViewId): PanelNode | null {
  for (const panel of collectPanels(node)) {
    if (panel.viewId === viewId) return panel
  }
  return null
}

/** 把 ratio 归一化到和为 1；长度不匹配时退化成等分 */
export function normalizeRatio(ratio: readonly number[], count: number): number[] {
  if (ratio.length !== count || ratio.some((r) => !Number.isFinite(r) || r <= 0)) {
    return Array.from({ length: count }, () => 1 / count)
  }
  const sum = ratio.reduce((a, b) => a + b, 0)
  return ratio.map((r) => r / sum)
}

/* ================================================================== */
/* 6. 对外快照（MCP / renderer 只读视角，已脱敏）                          */
/* ================================================================== */

export interface ConnectionSummary {
  id: ConnId
  driverId: DriverId
  label: string
  status: ConnStatus
  capabilities: Capability[]
  /** 已脱敏 */
  config: ConnectionConfig
  serverInfo?: ServerInfo
  error?: PeekError
}

export interface ViewSummary {
  id: ViewId
  kind: ViewKind
  connId: ConnId
  /** 当前挂在哪个面板；null 表示未挂载 */
  panelId: PanelId | null
  title: string
  status: ViewStatus
  /** 一句话描述当前视图在看什么，供 AI 感知界面 */
  describe: string
  resultId?: ResultId
  error?: PeekError
}

export interface WorkspaceSnapshot {
  rev: number
  layout: LayoutNode
  focusedPanel: PanelId | null
  connections: ConnectionSummary[]
  views: ViewSummary[]
  results: ResultMeta[]
}

/** 视图的一句话描述，read_workspace 和 UI 标题都用它 */
export function describeView(view: ViewState): string {
  switch (view.kind) {
    case 'table':
      return `表格 ${collectionRefLabel(view.ref)} · offset ${view.page.offset} limit ${view.page.limit}`
    case 'query': {
      const oneLine = view.text.replace(/\s+/g, ' ').trim()
      return `查询 ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`
    }
    case 'inspector':
      return `检查器 ${view.ref.kind}`
    case 'tree':
      return `命名空间树 · 展开 ${view.expanded.length} 个节点`
    case 'vector':
      return `向量检索 ${view.collection} · topK ${view.topK}`
  }
}

/** 视图标题：显式 title 优先，否则从内容推 */
export function viewTitle(view: ViewState): string {
  if (view.title) return view.title
  switch (view.kind) {
    case 'table':
      return collectionRefLabel(view.ref)
    case 'query':
      return '查询'
    case 'inspector':
      return '检查器'
    case 'tree':
      return '对象树'
    case 'vector':
      return `向量 · ${view.collection}`
  }
}

/**
 * 把真源 Workspace 收敛成可以离开 main 的只读快照（脱敏 + 摊平）。
 * MCP 的 read_workspace 和 state.read 都返回这个。
 */
export function snapshotWorkspace(ws: Workspace): WorkspaceSnapshot {
  const panels = collectPanels(ws.layout)
  const panelOfView = new Map<ViewId, PanelId>()
  for (const p of panels) {
    if (p.viewId !== null) panelOfView.set(p.viewId, p.id)
  }

  const connections: ConnectionSummary[] = Object.values(ws.connections).map((c) => {
    // 先脱敏再推 label：label 为空时会退化到连接串，原始连接串里有明文口令
    const config = redactConnectionConfig(c.config)
    return {
      id: c.id,
      driverId: c.driverId,
      label: c.label || defaultConnectionLabel(config),
      status: c.status,
      capabilities: c.capabilities,
      config,
      ...(c.serverInfo === undefined ? {} : { serverInfo: c.serverInfo }),
      ...(c.error === undefined ? {} : { error: c.error }),
    }
  })

  const views: ViewSummary[] = Object.values(ws.views).map((v) => ({
    id: v.id,
    kind: v.kind,
    connId: v.connId,
    panelId: panelOfView.get(v.id) ?? null,
    title: viewTitle(v),
    status: v.status,
    describe: describeView(v),
    ...('resultId' in v && v.resultId !== undefined ? { resultId: v.resultId } : {}),
    ...(v.error === undefined ? {} : { error: v.error }),
  }))

  return {
    rev: ws.rev,
    layout: ws.layout,
    focusedPanel: ws.focusedPanel,
    connections,
    views,
    results: Object.values(ws.results),
  }
}
