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
import {
  newPanelId,
  type ChatId,
  type ChatMessageId,
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from './ids'
import type {
  ChatAgentStatus,
  ChatAttachment,
  ChatPermissionMode,
  ChatUsage,
  PendingPermission,
} from './chat'

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

/**
 * Fields every view has.
 *
 * `connId` deliberately lives one level down, on `ConnectedViewBase`. Until the
 * chat view arrived every view was a window onto exactly one database, and
 * "a view" and "a view of a connection" were the same idea; a chat is the first
 * view that is a peer of the connections rather than a child of one. Widening
 * this to `connId?: ConnId` was considered and rejected — it would let a table
 * view compile with no connection, which is the invariant most of the codebase
 * leans on. Splitting the base instead means the compiler points at each site
 * that assumed the old equivalence, which is the same reasoning `PanelNode`
 * records for dropping its `viewId`.
 */
export interface ViewBase {
  id: ViewId
  /** Tab title; when absent the UI derives one from the content */
  title?: string
  status: ViewStatus
  error?: PeekError
}

/** Base for the views that are a window onto one connection — i.e. all but chat. */
export interface ConnectedViewBase extends ViewBase {
  connId: ConnId
}

/** Collection browsing: tables, keyspaces and collections all use this one */
export interface TableViewState extends ConnectedViewBase {
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
export interface QueryViewState extends ConnectedViewBase {
  kind: 'query'
  text: string
  resultId?: ResultId
}

/** Single-value / single-row inspector */
export interface InspectorViewState extends ConnectedViewBase {
  kind: 'inspector'
  ref: ValueRef
}

/** Namespace tree */
export interface TreeViewState extends ConnectedViewBase {
  kind: 'tree'
  /** NamespaceNode.ids that are expanded */
  expanded: string[]
  /** The currently selected NamespaceNode.id */
  selected?: string
}

/** Vector search */
export interface VectorViewState extends ConnectedViewBase {
  kind: 'vector'
  collection: string
  queryVec?: number[]
  /**
   * Search by an existing point ("more like this"), instead of a literal vector.
   *
   * Mutually exclusive with `queryVec` — `VectorSearchRequest` requires exactly
   * one of the two, and a driver handed both rejects with BAD_REQUEST. The view
   * holds it because it is the only query entry point a human can actually
   * operate: nothing in peek turns text into a vector, and nobody types 1024
   * floats. Whoever writes one of the two fields clears the other.
   */
  queryPointId?: string | number
  /** Text entry point; a layer above embeds it and fills queryVec — drivers never do embedding */
  queryText?: string
  /**
   * Named vector field, for a collection that defines several.
   *
   * Absent means the collection's default (unnamed) vector, which is the common
   * case. It is part of the *view* and not only of the request because a
   * multi-vector collection cannot be searched at all without it: qdrant answers
   * "please specify using which vector" and there is nowhere in the UI to say so
   * if the view cannot hold the choice.
   */
  vectorName?: string
  topK: number
  /** Drop matches scoring below this; the collection's metric decides whether that means far or near */
  scoreThreshold?: number
  filter?: FilterSpec[]
  resultId?: ResultId
}

/**
 * Conversation with an ACP agent.
 *
 * **Metadata only — the transcript is not here.** `chat.ts` carries the full
 * argument; the short version is that this object is diffed by immer and
 * broadcast on every committed Command, and is echoed to the model by
 * `read_workspace`, so a growing transcript in it would make both costs scale
 * with how much the user has chatted. Messages live in main's `ChatId`-keyed
 * transcript store and reach the renderer as `ChatDelta`s.
 *
 * Everything that *is* here earns its place by being small **and** by being
 * something either the AI or the layout needs to see: whether a turn is in
 * flight, whether a human is being asked for permission, what is staged for the
 * next prompt.
 */
export interface ChatViewState extends ViewBase {
  kind: 'chat'
  /** peek's conversation id; the key into the transcript store. Stable for the view's life. */
  chatId: ChatId
  /**
   * The agent's own session id, once `session/new` has returned. Null before the
   * agent process is up, and again after it dies — the two ids have different
   * lifetimes on purpose (see `ChatIdSchema`).
   */
  agentSessionId: string | null
  agentStatus: ChatAgentStatus
  /** Permission mode in effect. peek defaults to a restrictive one, never `bypassPermissions`. */
  permissionMode: ChatPermissionMode
  /**
   * The message currently streaming, or null between turns. Its presence is what
   * a "stop" button binds to, and what tells the AI a turn is already in flight.
   */
  streamingMessageId: ChatMessageId | null
  /** Total messages in the transcript, so the UI and MCP can report size without reading it. */
  messageCount: number
  /**
   * First ~200 characters of the most recent message. Feeds the tab title and
   * `describeView`; it is a *preview*, and nothing may reconstruct the
   * conversation from a sequence of these.
   */
  lastMessagePreview?: string
  /** Staged for the next prompt. Descriptors, never payloads — see `ChatAttachment`. */
  attachments: ChatAttachment[]
  /** Set while the agent is blocked on a human decision. Small, modal, and the AI must see it. */
  pendingPermission?: PendingPermission
  /** Context-window usage the agent last reported. */
  usage?: ChatUsage
  /**
   * The connection this chat is "about", when the user opened it from one.
   * Purely advisory — it seeds attachment pickers and nothing more. A chat works
   * with no connection at all, which is why it is optional here and absent from
   * `ConnectedViewBase`.
   */
  connId?: ConnId
}

export type ViewState =
  | TableViewState
  | QueryViewState
  | InspectorViewState
  | TreeViewState
  | VectorViewState
  | ChatViewState

export type ViewKind = ViewState['kind']

export const VIEW_KINDS = ['table', 'query', 'inspector', 'tree', 'vector', 'chat'] as const

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

/**
 * A leaf of the tiled layout: one panel, holding a **stack of views** shown as
 * tabs, of which exactly one is visible.
 *
 * ## Why a list, and why no `viewId` compatibility getter
 *
 * The singular `viewId: ViewId | null` this replaces was not merely a narrower
 * shape, it was a different set of rules — "opening a view here destroys what
 * was here" and "a centre drop swaps two panels" both fall straight out of it.
 * A derived `get viewId() { return this.activeViewId }` shim was considered and
 * **deliberately rejected**, for three reasons, in increasing order of severity:
 *
 * 1. a `PanelNode` is not a local object. It travels through immer patches to
 *    the renderer, through IPC, and out of `read_workspace` as raw JSON. An
 *    accessor does not survive structured cloning or `JSON.stringify`, so the
 *    shim would be present in main and silently `undefined` everywhere else —
 *    the worst failure mode available, since main's own tests would stay green;
 * 2. immer drafts these nodes. A getter reading `this.activeViewId` off a draft
 *    changes meaning mid-`produce`, and `writeLayout`'s reference-equality guard
 *    (see handlers/shared.ts) reasons about plain data;
 * 3. the point of the migration is that every site which assumed one view per
 *    panel gets *found*. Roughly forty call sites read `panel.viewId` today and
 *    a good half of them are now semantically wrong, not just differently
 *    spelled: closing a panel must close every tab, "the first empty panel" must
 *    test the list, and "a view is mounted at most once" must walk it. A shim
 *    keeps all of them compiling and wrong. Removing the field makes the
 *    compiler enumerate the work.
 *
 * ## Invariants (referenced by id throughout the codebase and its tests)
 *
 * - **P1** `activeViewId === null` **exactly when** `viewIds.length === 0`. Not
 *   "null is allowed when empty" — the two are equivalent, in both directions.
 *   A non-empty panel always shows something.
 * - **P2** `activeViewId`, when non-null, is a member of `viewIds`.
 * - **P3** `viewIds` contains no duplicates.
 * - **P4** a given `ViewId` appears in at most one panel in the whole tree
 *   (the generalisation of the old I7; note P3 makes it "at most once, full stop").
 * - **P5** `viewIds.length <= MAX_PANEL_TABS`.
 * - **P6** `viewIds` order **is** the tab-bar order, left to right. It is
 *   meaningful state, never to be sorted or normalised on read.
 *
 * ## Empty panels
 *
 * An empty panel is legal and ordinary — `createEmptyWorkspace` is one, `⌘\`
 * leaves one behind, and `layout.split` creates one on purpose. The rule is
 * about *who* empties it:
 *
 * - a panel emptied because its last view **left** (a drag, `layout.moveView`)
 *   is removed, and its parent split collapses — unless `keepSourcePanel`;
 * - a panel emptied because its last view was **closed** (`view.close`, the ✕ on
 *   a tab) stays, empty. This is deliberately unchanged from the pre-tab
 *   contract: `ViewCloseResult` has always promised the panel survives, and
 *   making the last ⌘W behave differently from the first would be a surprise.
 *   Removing a panel is `layout.close`'s job, and that is what the ✕ in the
 *   panel's action area sends.
 */
export interface PanelNode {
  type: 'panel'
  id: PanelId
  /** The stacked views, in tab-bar order (P3, P5, P6). Empty means an empty panel. */
  viewIds: ViewId[]
  /** The visible tab: a member of `viewIds`, or null exactly when `viewIds` is empty (P1, P2). */
  activeViewId: ViewId | null
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
    layout: makePanel(panelId),
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

/** Find the panel hosting a given view, whether it is the active tab or a background one */
export function findPanelOfView(node: LayoutNode, viewId: ViewId): PanelNode | null {
  for (const panel of collectPanels(node)) {
    if (panelHasView(panel, viewId)) return panel
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Panel tab primitives                                                 */
/*                                                                      */
/* Pure `PanelNode -> PanelNode` functions, living in core rather than   */
/* in main's layout-ops for one reason: the succession rule and the      */
/* index arithmetic below are the whole of the tab contract, and four    */
/* independent re-derivations of them would disagree within a week.      */
/* layout-ops composes these over the tree; the renderer reads them.     */
/*                                                                      */
/* Every one of them **returns its argument by identity when nothing    */
/* changes**. That is not an optimisation: `writeLayout` decides whether */
/* to touch the immer draft by reference equality, and an unconditional  */
/* assignment turns a no-op into a `remove` patch that wipes the         */
/* renderer's layout (see handlers/shared.ts). Tree-level operations     */
/* must preserve the same discipline and early-return the root.          */
/* ------------------------------------------------------------------ */

/** Build a panel, enforcing P1/P2 rather than trusting the caller. */
export function makePanel(
  id: PanelId,
  viewIds: readonly ViewId[] = [],
  activeViewId?: ViewId | null,
): PanelNode {
  const ids = [...viewIds]
  const active =
    activeViewId !== undefined && activeViewId !== null && ids.includes(activeViewId)
      ? activeViewId
      : (ids[0] ?? null)
  return { type: 'panel', id, viewIds: ids, activeViewId: active }
}

export function isPanelEmpty(panel: PanelNode): boolean {
  return panel.viewIds.length === 0
}

export function panelHasView(panel: PanelNode, viewId: ViewId): boolean {
  return panel.viewIds.includes(viewId)
}

/** Position of a view in the tab bar, or -1 when this panel does not hold it. */
export function panelTabIndex(panel: PanelNode, viewId: ViewId): number {
  return panel.viewIds.indexOf(viewId)
}

/** The visible view, or null for an empty panel. Reads P1/P2 rather than restating them. */
export function activeViewOf(panel: PanelNode): ViewId | null {
  return panel.activeViewId
}

/**
 * Which tab takes over when `removed` leaves `viewIdsBefore`.
 *
 * Right neighbour, then left, then nothing — the rule every tabbed application
 * the user already knows follows (VS Code, Chrome, Finder). Most-recently-used
 * was considered and rejected: it needs a per-panel history stack, which is
 * state the AI would have to read and reason about through `read_workspace`,
 * that immer patches would have to carry, and whose next pick a human cannot
 * predict by looking at the screen. Positional succession is legible from the
 * tab bar alone.
 *
 * Closing a **background** tab never changes what is on screen; that is the
 * `activeBefore !== removed` branch, and it is the common case.
 */
export function nextActiveTab(
  viewIdsBefore: readonly ViewId[],
  removed: ViewId,
  activeBefore: ViewId | null,
): ViewId | null {
  if (activeBefore !== null && activeBefore !== removed) {
    return viewIdsBefore.includes(activeBefore) ? activeBefore : null
  }
  const i = viewIdsBefore.indexOf(removed)
  if (i < 0) return activeBefore
  return viewIdsBefore[i + 1] ?? viewIdsBefore[i - 1] ?? null
}

export interface InsertPanelTabOptions {
  /**
   * Where the view ends up in `viewIds`, clamped to `[0, length]` **after** the
   * view has been removed from wherever it was. Omitted means append.
   *
   * Post-removal indexing is the contract because it is the only version a
   * caller can verify: it is the index the view is reported at afterwards. The
   * caret-position arithmetic a tab-bar drag needs (where dragging rightwards
   * within one panel shifts every index past the source) is the renderer's
   * problem and is resolved before the Command is built — see `tabDropIndex`
   * in layout-dnd.
   */
  index?: number
  /** Show it once inserted. Default true. */
  activate?: boolean
}

/**
 * Add a view to a panel, or move it within the panel it is already in.
 *
 * One function for both because they are the same edit: remove, then insert at
 * the requested position. Splitting them would give two functions that must
 * agree about index arithmetic, which is exactly the bug this avoids. A tab-bar
 * reorder is therefore `insertPanelTab(panel, viewId, { index })` with the view
 * already present, and it is **not** a no-op — the pre-tab rule "dropping a view
 * on the panel it already occupies changes nothing" now holds only when the
 * resulting index and active tab are also unchanged.
 */
export function insertPanelTab(
  panel: PanelNode,
  viewId: ViewId,
  opts: InsertPanelTabOptions = {},
): PanelNode {
  const rest = panel.viewIds.filter((id) => id !== viewId)
  const at = clampIndex(opts.index ?? rest.length, rest.length)
  const viewIds = [...rest.slice(0, at), viewId, ...rest.slice(at)]
  const activeViewId = opts.activate === false ? (panel.activeViewId ?? viewId) : viewId
  return samePanelContent(panel, viewIds, activeViewId)
    ? panel
    : { ...panel, viewIds, activeViewId }
}

/**
 * Drop a view from a panel, applying the succession rule.
 * A view the panel does not hold leaves it untouched (by identity).
 */
export function removePanelTab(panel: PanelNode, viewId: ViewId): PanelNode {
  if (!panelHasView(panel, viewId)) return panel
  const activeViewId = nextActiveTab(panel.viewIds, viewId, panel.activeViewId)
  return { ...panel, viewIds: panel.viewIds.filter((id) => id !== viewId), activeViewId }
}

/** Show an existing tab. A view this panel does not hold leaves it untouched. */
export function activatePanelTab(panel: PanelNode, viewId: ViewId): PanelNode {
  if (!panelHasView(panel, viewId) || panel.activeViewId === viewId) return panel
  return { ...panel, activeViewId: viewId }
}

/** Empty a panel in one step; used by `layout.close`, which closes every tab it holds. */
export function clearPanelTabs(panel: PanelNode): PanelNode {
  if (isPanelEmpty(panel)) return panel
  return { ...panel, viewIds: [], activeViewId: null }
}

function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max
  return Math.min(Math.max(Math.trunc(index), 0), max)
}

function samePanelContent(
  panel: PanelNode,
  viewIds: readonly ViewId[],
  activeViewId: ViewId | null,
): boolean {
  return (
    panel.activeViewId === activeViewId &&
    panel.viewIds.length === viewIds.length &&
    panel.viewIds.every((id, i) => id === viewIds[i])
  )
}

/** Normalize ratios so they sum to 1; fall back to an even split on a length mismatch */
export function normalizeRatio(ratio: readonly number[], count: number): number[] {
  if (ratio.length !== count || ratio.some((r) => !Number.isFinite(r) || r <= 0)) {
    return Array.from({ length: count }, () => 1 / count)
  }
  const sum = ratio.reduce((a, b) => a + b, 0)
  return ratio.map((r) => r / sum)
}

/* ------------------------------------------------------------------ */
/* Layout limits                                                       */
/* ------------------------------------------------------------------ */

/**
 * Ceilings on the shape of the layout tree.
 *
 * They exist for one reason: a Command can now carry a **whole tree**
 * (`layout.setLayout`), so a malformed or runaway generation from a model must
 * not be able to hand the renderer a thousand panels or a hundred nesting
 * levels. Reaching either of these by hand is practically impossible — a
 * same-direction split merges into its parent instead of nesting, so passing
 * `MAX_LAYOUT_DEPTH` requires alternating row/col six times.
 *
 * Every panel-creating operation enforces `MAX_LAYOUT_PANELS`, not just
 * `layout.setLayout`: the cap has to be a property of the tree, not of one entry
 * point, or a loop of `layout.split` walks straight past it.
 */
export const MAX_LAYOUT_PANELS = 16
/** Depth of the root node is 0, so a tree may nest at most this many splits. */
export const MAX_LAYOUT_DEPTH = 6
/** Children of a single split node. Beyond this a row is unreadable anyway. */
export const MAX_SPLIT_CHILDREN = 8
/**
 * Tabs in a single panel (P5).
 *
 * Same argument as `MAX_LAYOUT_PANELS`, and it has to be enforced in the same
 * places: a Command can now stack views onto one panel (`view.open` with
 * `replace: false`, `layout.moveView`, a `layout.setLayout` leaf listing
 * `viewIds`), so a runaway generation from a model must not be able to hand the
 * renderer eight hundred tabs on one strip. Twelve is already past the point
 * where a human reads the bar rather than scanning it, and 16 panels x 12 tabs
 * bounds the whole workspace at 192 mounted views.
 */
export const MAX_PANEL_TABS = 12

export function countPanels(node: LayoutNode): number {
  if (node.type === 'panel') return 1
  return node.children.reduce((n, child) => n + countPanels(child), 0)
}

/** Depth of the deepest node; a bare root panel is 0. */
export function layoutDepth(node: LayoutNode): number {
  if (node.type === 'panel') return 0
  return 1 + Math.max(0, ...node.children.map(layoutDepth))
}

/** The split holding a given node, or null when the node is the root (or absent). */
export function findParentSplit(root: LayoutNode, childId: PanelId | SplitId): SplitNode | null {
  if (root.type === 'panel') return null
  for (const child of root.children) {
    if (child.id === childId) return root
    const deeper = findParentSplit(child, childId)
    if (deeper) return deeper
  }
  return null
}

/**
 * Every view currently mounted on a panel, in visual order — panels depth-first,
 * tabs left to right within each. Includes background tabs.
 */
export function collectMountedViewIds(node: LayoutNode): ViewId[] {
  const out: ViewId[] = []
  for (const panel of collectPanels(node)) out.push(...panel.viewIds)
  return out
}

/**
 * The views actually on screen: one per non-empty panel.
 *
 * Kept separate from `collectMountedViewIds` because with tabs the two stopped
 * being the same set, and conflating them is the easy mistake to make. A reader
 * asking "what can the human see right now" wants this one.
 */
export function collectVisibleViewIds(node: LayoutNode): ViewId[] {
  const out: ViewId[] = []
  for (const panel of collectPanels(node)) {
    if (panel.activeViewId !== null) out.push(panel.activeViewId)
  }
  return out
}

/** The first panel holding more tabs than P5 allows, or null. Used by the handlers' limit guard. */
export function overflowingPanel(node: LayoutNode): PanelNode | null {
  return collectPanels(node).find((panel) => panel.viewIds.length > MAX_PANEL_TABS) ?? null
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

/**
 * The machine-readable half of a chat view's summary.
 *
 * `describe` already says all of this in one English sentence, and that sentence
 * is the right thing for a reader skimming the window. It is the wrong thing for a
 * reader that has to *act*: answering a permission prompt needs the exact
 * `optionId` strings, and those are not derivable from prose — note in particular
 * that an option's `optionId` and its `kind` differ (`allow` versus `allow_once`),
 * so a caller that guesses from the description gets its answer rejected.
 *
 * Still **no messages**: the transcript is not in the Workspace and must not leak
 * into the snapshot by this or any other route (see `chat.ts`). Everything here is
 * bounded by a small constant.
 */
export interface ChatViewSummary {
  chatId: ChatId
  agentStatus: ChatAgentStatus
  permissionMode: ChatPermissionMode
  /** True while a turn is in flight; `chat.send` refuses a second one. */
  streaming: boolean
  messageCount: number
  /** Staged for the next prompt — descriptors, never payloads. */
  attachments: ChatAttachment[]
  /** Set while the conversation is blocked on a human decision. */
  pendingPermission?: PendingPermission
  usage?: ChatUsage
}

export interface ViewSummary {
  id: ViewId
  kind: ViewKind
  /**
   * Absent on a chat view that is not tied to a connection. Every other kind
   * always has one, so a reader narrowing on `kind` keeps the guarantee it had.
   */
  connId?: ConnId
  /** The panel it currently sits in; null means unmounted */
  panelId: PanelId | null
  /** Position in that panel's tab bar; -1 when unmounted */
  tabIndex: number
  /**
   * Whether a human can actually see this view right now — i.e. it is its
   * panel's active tab.
   *
   * This field is the reason tabs cannot ship without touching the snapshot. Up
   * to now "mounted in a panel" and "on screen" were the same statement, and
   * every reader, the AI most of all, treats `panelId !== null` as "visible". With
   * a stack of six views in one panel that reading is wrong five times out of
   * six, and an AI that believes it will happily report on a table the user
   * cannot see.
   */
  visible: boolean
  title: string
  status: ViewStatus
  /** One sentence about what this view is showing, so the AI can perceive the window */
  describe: string
  resultId?: ResultId
  /** Present exactly when `kind === 'chat'`. */
  chat?: ChatViewSummary
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
    case 'chat': {
      // Deliberately reports the *state* of the conversation, not its contents:
      // read_workspace consumes this, and feeding the transcript back to the
      // model that wrote it is both expensive and circular.
      const parts = [`Chat · ${view.messageCount} message(s) · ${view.agentStatus}`]
      if (view.pendingPermission) parts.push(`awaiting permission for ${view.pendingPermission.toolName}`)
      if (view.attachments.length > 0) parts.push(`${view.attachments.length} attachment(s) staged`)
      return parts.join(' · ')
    }
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
    case 'chat':
      return 'Chat'
  }
}

/**
 * The structured facts about a conversation, for a caller that has to act on them.
 *
 * Nothing is redacted, because nothing here is a secret: ids, counts, a mode, and
 * the options of a question the user is already being shown on screen. The one
 * thing that would need redacting — what was said — is not in the Workspace at all.
 */
function summarizeChat(view: ChatViewState): ChatViewSummary {
  return {
    chatId: view.chatId,
    agentStatus: view.agentStatus,
    permissionMode: view.permissionMode,
    streaming: view.streamingMessageId !== null,
    messageCount: view.messageCount,
    attachments: view.attachments,
    ...(view.pendingPermission === undefined ? {} : { pendingPermission: view.pendingPermission }),
    ...(view.usage === undefined ? {} : { usage: view.usage }),
  }
}

/**
 * Reduce the source-of-truth Workspace to a read-only snapshot that is safe to
 * leave main: redacted and flattened. Both MCP's read_workspace and state.read
 * return this.
 */
export function snapshotWorkspace(ws: Workspace): WorkspaceSnapshot {
  const panels = collectPanels(ws.layout)
  const placement = new Map<ViewId, { panelId: PanelId; tabIndex: number; visible: boolean }>()
  for (const p of panels) {
    p.viewIds.forEach((viewId, tabIndex) => {
      placement.set(viewId, { panelId: p.id, tabIndex, visible: p.activeViewId === viewId })
    })
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

  const views: ViewSummary[] = Object.values(ws.views).map((v) => {
    const at = placement.get(v.id)
    return {
      id: v.id,
      kind: v.kind,
      ...(v.connId === undefined ? {} : { connId: v.connId }),
      panelId: at?.panelId ?? null,
      tabIndex: at?.tabIndex ?? -1,
      visible: at?.visible ?? false,
      title: viewTitle(v),
      status: v.status,
      describe: describeView(v),
      ...('resultId' in v && v.resultId !== undefined ? { resultId: v.resultId } : {}),
      ...(v.kind === 'chat' ? { chat: summarizeChat(v) } : {}),
      ...(v.error === undefined ? {} : { error: v.error }),
    }
  })

  return {
    rev: ws.rev,
    layout: ws.layout,
    focusedPanel: ws.focusedPanel,
    connections,
    views,
    results: Object.values(ws.results),
  }
}
