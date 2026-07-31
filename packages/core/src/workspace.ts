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

// The branded types are re-exported here so they can be pulled straight from
// workspace, the way PLAN §5 describes them.
export {
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from './ids'

/* ================================================================== */
/* 1. Connection state machine                                         */
/* ================================================================== */

/** The connection state machine from PLAN §5: idle → connecting → ready / error */
export type ConnStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface ConnectionState {
  id: ConnId
  driverId: DriverId
  /** User-visible name */
  label: string
  /**
   * The full connection config, password included. **It may exist only inside
   * main's source of truth.** Anything headed for the renderer or MCP goes through
   * redactConnectionConfig first.
   */
  config: ConnectionConfig
  status: ConnStatus
  /** The capabilities the driver host reported once ready */
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** Set when status === 'error' */
  error?: PeekError
  /** Timestamp of a successful connect (ms) */
  readyAt?: number
  /** Pid of the driver host's utilityProcess, handy when debugging */
  pid?: number
}

/* ================================================================== */
/* 2. View state (the five kinds from PLAN §5)                         */
/* ================================================================== */

export type ViewStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ViewBase {
  id: ViewId
  connId: ConnId
  /** Tab title; when absent the UI derives one from the content */
  title?: string
  status: ViewStatus
  error?: PeekError
}

/** Collection browsing: tables, keyspaces and collections all use this one */
export interface TableViewState extends ViewBase {
  kind: 'table'
  ref: CollectionRef
  filter?: FilterSpec[]
  sort?: SortSpec[]
  page: { offset: number; limit: number }
  /** The result set currently streaming */
  resultId?: ResultId
  /** Continuation cursor (redis SCAN / qdrant scroll) */
  cursorToken?: string
}

/** Free-form query (SQL and friends) */
export interface QueryViewState extends ViewBase {
  kind: 'query'
  text: string
  resultId?: ResultId
}

/** Single-value / single-row inspector */
export interface InspectorViewState extends ViewBase {
  kind: 'inspector'
  ref: ValueRef
}

/** Namespace tree */
export interface TreeViewState extends ViewBase {
  kind: 'tree'
  /** NamespaceNode.ids that are expanded */
  expanded: string[]
  /** The currently selected NamespaceNode.id */
  selected?: string
}

/** Vector search */
export interface VectorViewState extends ViewBase {
  kind: 'vector'
  collection: string
  queryVec?: number[]
  /** Text entry point; a layer above embeds it and fills queryVec — drivers never do embedding */
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

/** Narrow ViewState down to one concrete kind */
export type ViewStateOf<K extends ViewKind> = Extract<ViewState, { kind: K }>

/* ================================================================== */
/* 3. Tiled layout tree                                                */
/* ================================================================== */

export interface SplitNode {
  type: 'split'
  /** How layout.setRatio addresses this node. PLAN's tree drawing omits ids, but commands cannot address a split without one. */
  id: SplitId
  dir: 'row' | 'col'
  /** Share of space per child; same length as `children`, summing to 1 */
  ratio: number[]
  children: LayoutNode[]
}

export interface PanelNode {
  type: 'panel'
  id: PanelId
  /** null means an empty panel */
  viewId: ViewId | null
}

export type LayoutNode = SplitNode | PanelNode

/* ================================================================== */
/* 4. Result-set metadata                                              */
/* ================================================================== */

/**
 * Result-set state machine.
 *
 * Of the five values, `paused` is the only terminal state meaning "unfinished, yet
 * nothing is wrong": backpressure stopped the stream and the driver deliberately
 * released the server-side cursor and connection, so **every row already loaded is
 * valid**. It is deliberately kept separate from `error` — both the AI and the user
 * must be able to tell "the query failed" from "it just stopped, and the data is
 * good" at a glance.
 *
 *   running ─┬─► done       finished normally
 *            ├─► paused     backpressure idle timeout; re-run to keep fetching (truncated + resumable)
 *            ├─► error      a real failure (SQL error, dropped connection, missing frame, …)
 *            └─► cancelled  cancelled on purpose by the user or a layer above
 */
export type ResultStatus = 'running' | 'done' | 'paused' | 'error' | 'cancelled'

/** The only place "is it settled?" is implemented, so nobody re-derives `!== 'running'` and drifts */
export function isSettledResultStatus(status: ResultStatus): boolean {
  return status !== 'running'
}

/** Whether the loaded rows can be trusted as real data; only `error` fails this */
export function hasUsableRows(status: ResultStatus): boolean {
  return status !== 'error'
}

/**
 * **Metadata** about a result set, never the data itself — data goes straight over
 * the MessagePort into the renderer's cache. Main holds this metadata, and MCP's
 * read_workspace uses it to report what ran, how many rows, and how long it took.
 */
export interface ResultMeta {
  id: ResultId
  connId: ConnId
  /** The view that triggered this execution */
  viewId: ViewId
  status: ResultStatus
  /** Filled in once the first frame arrives */
  schema?: ColumnDef[]
  /** Rows confirmed received */
  rows: number
  startedAt: number
  elapsedMs?: number
  /** More data remains unfetched (hit the maxRows ceiling, or paused by backpressure) */
  truncated?: boolean
  /** Re-running continues the fetch; always true when `status === 'paused'` */
  resumable?: boolean
  /** Human-readable reason, set when status === 'paused' */
  pausedReason?: string
  error?: PeekError
  /** Short description of the statement or scan, for MCP to read */
  summary?: string
}

/* ================================================================== */
/* 5. Workspace (main holds the source of truth)                       */
/* ================================================================== */

export interface Workspace {
  /** Revision number, +1 per committed Command; patch broadcasts carry it so the renderer can detect a dropped update */
  rev: number
  connections: Record<ConnId, ConnectionState>
  layout: LayoutNode
  views: Record<ViewId, ViewState>
  results: Record<ResultId, ResultMeta>
  focusedPanel: PanelId | null
}

/**
 * An empty workspace: one root panel, no views.
 * @param rootPanelId pass a fixed id to keep tests reproducible
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
/* Read-only layout-tree helpers (pure functions, usable from main and  */
/* renderer alike)                                                      */
/* ------------------------------------------------------------------ */

/** Collect every panel node depth-first; the order is the visual order */
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

/** Find the panel hosting a given view */
export function findPanelOfView(node: LayoutNode, viewId: ViewId): PanelNode | null {
  for (const panel of collectPanels(node)) {
    if (panel.viewId === viewId) return panel
  }
  return null
}

/** Normalize ratios so they sum to 1; fall back to an even split on a length mismatch */
export function normalizeRatio(ratio: readonly number[], count: number): number[] {
  if (ratio.length !== count || ratio.some((r) => !Number.isFinite(r) || r <= 0)) {
    return Array.from({ length: count }, () => 1 / count)
  }
  const sum = ratio.reduce((a, b) => a + b, 0)
  return ratio.map((r) => r / sum)
}

/* ================================================================== */
/* 6. Outward-facing snapshot (read-only view for MCP and the renderer, */
/*    already redacted)                                                 */
/* ================================================================== */

export interface ConnectionSummary {
  id: ConnId
  driverId: DriverId
  label: string
  status: ConnStatus
  capabilities: Capability[]
  /** Redacted */
  config: ConnectionConfig
  serverInfo?: ServerInfo
  error?: PeekError
}

export interface ViewSummary {
  id: ViewId
  kind: ViewKind
  connId: ConnId
  /** The panel it currently sits in; null means unmounted */
  panelId: PanelId | null
  title: string
  status: ViewStatus
  /** One sentence about what this view is showing, so the AI can perceive the window */
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

/**
 * One-sentence description of a view, used by read_workspace and by UI titles.
 *
 * **Always English, never localized.** MCP reads this string, so it has to stay
 * stable and locale-independent; a window that wants the view kind spelled out in
 * the user's language uses the `view.kind.*` messages instead.
 */
export function describeView(view: ViewState): string {
  switch (view.kind) {
    case 'table':
      return `Table ${collectionRefLabel(view.ref)} · offset ${view.page.offset} limit ${view.page.limit}`
    case 'query': {
      const oneLine = view.text.replace(/\s+/g, ' ').trim()
      return `Query ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`
    }
    case 'inspector':
      return `Inspector ${view.ref.kind}`
    case 'tree':
      return `Namespace tree · ${view.expanded.length} nodes expanded`
    case 'vector':
      return `Vector search ${view.collection} · topK ${view.topK}`
  }
}

/**
 * Title of a view: an explicit `title` wins, otherwise one is derived from the
 * content. English only, for the same reason as `describeView`.
 */
export function viewTitle(view: ViewState): string {
  if (view.title) return view.title
  switch (view.kind) {
    case 'table':
      return collectionRefLabel(view.ref)
    case 'query':
      return 'Query'
    case 'inspector':
      return 'Inspector'
    case 'tree':
      return 'Object tree'
    case 'vector':
      return `Vector · ${view.collection}`
  }
}

/**
 * Reduce the source-of-truth Workspace to a read-only snapshot that is safe to
 * leave main: redacted and flattened. Both MCP's read_workspace and state.read
 * return this.
 */
export function snapshotWorkspace(ws: Workspace): WorkspaceSnapshot {
  const panels = collectPanels(ws.layout)
  const panelOfView = new Map<ViewId, PanelId>()
  for (const p of panels) {
    if (p.viewId !== null) panelOfView.set(p.viewId, p.id)
  }

  const connections: ConnectionSummary[] = Object.values(ws.connections).map((c) => {
    // Redact before deriving the label: an empty label falls back to the connection
    // URL, and the raw URL carries a plaintext password.
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
