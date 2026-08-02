import { z } from 'zod'
import {
  CollectionRefSchema,
  ConnectionConfigSchema,
  FilterSpecSchema,
  SortSpecSchema,
  ValueRefSchema,
  type Capability,
  type ConnectionConfig,
  type DriverId,
  type ServerInfo,
} from './capability'
import {
  CHAT_PERMISSION_MODES,
  type ChatAgentStatus,
  type ChatAttachment,
  type ChatPermissionMode,
  type ChatSessionInfo,
} from './chat'
import { MAX_PAGE_LIMIT } from './chunk'
import { peekErrorMsg, type PeekError } from './errors'
import {
  AttachmentIdSchema,
  ConnIdSchema,
  PanelIdSchema,
  ResultIdSchema,
  SplitIdSchema,
  ViewIdSchema,
  type AttachmentId,
  type ChatId,
  type ChatMessageId,
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from './ids'
import { MAX_LAYOUT_DEPTH, MAX_LAYOUT_PANELS, MAX_PANEL_TABS, MAX_SPLIT_CHILDREN } from './workspace'
import type { ConnStatus, ViewKind, WorkspaceSnapshot } from './workspace'

/* ================================================================== */
/* 0. Command names (PLAN §6, domain.verb)                             */
/* ================================================================== */

export const COMMAND_NAMES = [
  'conn.open',
  'conn.close',
  'view.open',
  'view.update',
  'view.close',
  'view.activate',
  'query.run',
  'query.cancel',
  'layout.split',
  'layout.focus',
  'layout.setRatio',
  'layout.close',
  'layout.moveView',
  'layout.splitWithView',
  'layout.setLayout',
  'chat.send',
  'chat.cancel',
  'chat.clear',
  'chat.attach',
  'chat.detach',
  'chat.respondPermission',
  'chat.setMode',
  'chat.sessions.list',
  'chat.sessions.delete',
  'state.read',
  'conn.book.list',
  'conn.book.forget',
  'mcp.read',
  'mcp.configure',
  'settings.read',
  'settings.write',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMAND_NAMES as readonly string[]).includes(value)
}

/**
 * Where a command came from; used by the command log and for auditing (the log is
 * a recording of every action, and replayable).
 *
 * `source` is metadata: it is written to the log and forwarded with the patch
 * broadcast, and it **never forks the execution path**. A human clicking a button
 * and a model calling a tool run the same handler with the same validation, which
 * is the property that keeps the two from ever seeing different state.
 *
 * The two places it is allowed to change an *outcome* are both policy, not a
 * second code path: `chat.setMode` refuses to hand a non-`ui` caller a permission
 * mode that disables the human gate, and `chat.respondPermission` refuses an
 * `agent` caller outright. Both are rules about who may ask.
 *
 * - `ui`     the human, through the renderer.
 * - `mcp`    an MCP client outside peek (an editor, another agent's Claude Code).
 * - `agent`  peek's **own embedded chat panel** driving the UI back through MCP.
 *            Wired via a second bearer credential on the same endpoint: the panel
 *            authenticates with a token that is minted per process and never
 *            written to `~/.peek/mcp.json`, so it is the one caller an external
 *            client cannot impersonate. It is also the one caller refused
 *            `chat.respondPermission` — an agent that can answer a permission
 *            prompt, including one raised for a different conversation in the
 *            same window, has no permission system.
 *            This comment described the wiring for a long time before anything
 *            performed it, and every request in the process arrived as `mcp`.
 *            See design/2026-08-02-agent-source-and-permission-scope.md.
 * - `system` main's own write-back (driver host events, agent stream events).
 */
export const CommandSourceSchema = z.enum(['ui', 'mcp', 'agent', 'system'])
export type CommandSource = z.infer<typeof CommandSourceSchema>

/* ================================================================== */
/* 1. View-open specs and incremental updates                          */
/* ================================================================== */

const pageLimit = z.number().int().positive().max(MAX_PAGE_LIMIT)
const pageOffset = z.number().int().nonnegative()

export const TableViewSpecSchema = z.object({
  kind: z.literal('table'),
  connId: ConnIdSchema,
  ref: CollectionRefSchema,
  filter: z.array(FilterSpecSchema).optional(),
  sort: z.array(SortSpecSchema).optional(),
  offset: pageOffset.optional(),
  limit: pageLimit.optional(),
  title: z.string().optional(),
})

export const QueryViewSpecSchema = z.object({
  kind: z.literal('query'),
  connId: ConnIdSchema,
  /** Omitted means an empty editor */
  text: z.string().optional(),
  /** Run it as soon as the view opens */
  run: z.boolean().optional(),
  title: z.string().optional(),
})

export const InspectorViewSpecSchema = z.object({
  kind: z.literal('inspector'),
  connId: ConnIdSchema,
  ref: ValueRefSchema,
  title: z.string().optional(),
})

export const TreeViewSpecSchema = z.object({
  kind: z.literal('tree'),
  connId: ConnIdSchema,
  expanded: z.array(z.string()).optional(),
  title: z.string().optional(),
})

export const VectorViewSpecSchema = z.object({
  kind: z.literal('vector'),
  connId: ConnIdSchema,
  collection: z.string().min(1),
  queryVec: z.array(z.number()).optional(),
  /**
   * Search by an existing point instead of a literal vector. Mutually exclusive
   * with `queryVec`; main rejects a spec carrying both (error.vector.queryRequired).
   */
  queryPointId: z.union([z.string().min(1), z.number()]).optional(),
  queryText: z.string().optional(),
  /** Named vector field; omitted means the collection's default (unnamed) vector */
  vectorName: z.string().min(1).optional(),
  topK: z.number().int().positive().max(10_000).optional(),
  /** Drop matches scoring below this */
  scoreThreshold: z.number().optional(),
  filter: z.array(FilterSpecSchema).optional(),
  title: z.string().optional(),
})

/* ---- Chat ---------------------------------------------------------- */

/**
 * Ceilings on the chat command surface.
 *
 * Same argument as the layout caps: a Command can now be authored by a model, and
 * an unbounded `text` or a loop of `chat.attach` must not be able to hand the
 * agent a hundred megabytes or the Workspace a thousand descriptors. These are
 * generous for a human and fatal only to a runaway generation.
 */
export const MAX_CHAT_ATTACHMENTS = 16
/** Rows one `rows` / `result` attachment may carry into the prompt. */
export const MAX_CHAT_ATTACHMENT_ROWS = 500
export const MAX_CHAT_PROMPT_CHARS = 100_000

export const ChatPermissionModeSchema = z.enum(CHAT_PERMISSION_MODES)

/**
 * An attachment as a *caller* describes it: no `id` (main mints one) and no
 * `label` unless the caller wants to override the derived one.
 *
 * Deliberately mirrors `ChatAttachment` field for field rather than embedding
 * payload. The reasoning is in `chat.ts`: a descriptor is resolved at **send**
 * time, so re-running a query and then sending attaches the new rows, and a
 * descriptor whose data has been evicted can report that instead of silently
 * shipping a stale snapshot.
 */
export const ChatAttachmentSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rows'),
    viewId: ViewIdSchema,
    resultId: ResultIdSchema,
    rowIndexes: z.array(z.number().int().nonnegative()).min(1).max(MAX_CHAT_ATTACHMENT_ROWS),
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('result'),
    viewId: ViewIdSchema,
    resultId: ResultIdSchema,
    maxRows: z.number().int().positive().max(MAX_CHAT_ATTACHMENT_ROWS).optional(),
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('cell'),
    viewId: ViewIdSchema,
    resultId: ResultIdSchema,
    rowIndex: z.number().int().nonnegative(),
    column: z.string().min(1),
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('schema'),
    connId: ConnIdSchema,
    ref: CollectionRefSchema,
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('query'),
    viewId: ViewIdSchema,
    label: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('workspace'),
    label: z.string().min(1).max(120).optional(),
  }),
])
export type ChatAttachmentSpec = z.infer<typeof ChatAttachmentSpecSchema>

/**
 * A chat view. **The only view spec with no `connId`** — a conversation is a peer
 * of the connections, not a window onto one (see `ConnectedViewBase`). The
 * optional `connId` is advisory: it seeds the attachment picker and appears in
 * the view's description, and a chat opened without one works exactly the same.
 */
export const ChatViewSpecSchema = z.object({
  kind: z.literal('chat'),
  connId: ConnIdSchema.optional(),
  /**
   * Permission mode the conversation starts in. Omitted means `default`, i.e.
   * every tool call asks a human. The agent's own default is `auto` (a classifier
   * decides), which is not a defensible default for something that can rewrite
   * the window the user is looking at.
   */
  permissionMode: ChatPermissionModeSchema.optional(),
  /** Stage context on the new conversation before its first prompt. */
  attachments: z.array(ChatAttachmentSpecSchema).max(MAX_CHAT_ATTACHMENTS).optional(),
  title: z.string().optional(),
  /**
   * Open this view onto an **existing** agent session instead of a new one — the
   * id comes from `chat.sessions.list`.
   *
   * Two things change when it is present, and both are stated in
   * `design/2026-08-02-chat-session-management.md`: the agent is asked to
   * `session/load` rather than `session/new`, and the session is brought up
   * immediately rather than on the first prompt (a conversation opened to be read
   * cannot wait for a prompt that may never come).
   *
   * An id that no longer exists is a failed load reported on the conversation,
   * not a rejected command: the catalogue is the agent's and it can change
   * between the list and the click.
   */
  resumeSessionId: z.string().min(1).optional(),
})

/** Input spec for view.open: no id, because main generates it */
export const ViewOpenSpecSchema = z.discriminatedUnion('kind', [
  TableViewSpecSchema,
  QueryViewSpecSchema,
  InspectorViewSpecSchema,
  TreeViewSpecSchema,
  VectorViewSpecSchema,
  ChatViewSpecSchema,
])
export type ViewOpenSpec = z.infer<typeof ViewOpenSpecSchema>

/**
 * Incremental patch for view.update. `kind` is mandatory: main checks it against
 * the target view's kind and answers BAD_REQUEST on a mismatch, which is what stops
 * the AI from applying a table's `filter` to a query view.
 */
export const ViewPatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    ref: CollectionRefSchema.optional(),
    filter: z.array(FilterSpecSchema).optional(),
    sort: z.array(SortSpecSchema).optional(),
    offset: pageOffset.optional(),
    limit: pageLimit.optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('query'),
    text: z.string().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('inspector'),
    ref: ValueRefSchema.optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tree'),
    expanded: z.array(z.string()).optional(),
    selected: z.string().nullable().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal('vector'),
    collection: z.string().min(1).optional(),
    /** Writing either query field clears the other: the driver contract allows exactly one */
    queryVec: z.array(z.number()).optional(),
    queryPointId: z.union([z.string().min(1), z.number()]).optional(),
    queryText: z.string().optional(),
    /** null clears the choice, falling back to the collection's default (unnamed) vector */
    vectorName: z.string().min(1).nullable().optional(),
    topK: z.number().int().positive().max(10_000).optional(),
    /** null clears the threshold, so every match is returned again */
    scoreThreshold: z.number().nullable().optional(),
    filter: z.array(FilterSpecSchema).optional(),
    title: z.string().optional(),
  }),
  /**
   * A chat has exactly one patchable field, and that is on purpose. Everything
   * else about a conversation either belongs to the agent (`agentSessionId`,
   * `agentStatus`, `usage`), or is a transition with a side effect that
   * `view.update` has no way to carry — changing the permission mode has to reach
   * `session/set_mode`, answering a permission prompt has to unblock a waiting
   * JSON-RPC request. Those are `chat.setMode` and `chat.respondPermission`.
   */
  z.object({
    kind: z.literal('chat'),
    title: z.string().optional(),
  }),
])
export type ViewPatch = z.infer<typeof ViewPatchSchema>

/* ================================================================== */
/* 2. Per-command input schemas — every type is z.infer'd from these,   */
/*    never hand-written a second time                                 */
/* ================================================================== */

export const ConnOpenInputSchema = z.object({
  config: ConnectionConfigSchema,
  /** Reuse an existing connection id (reconnect); omit to create a new one */
  connId: ConnIdSchema.optional(),
  /** Open a tree view automatically once connected */
  openTree: z.boolean().optional(),
})

export const ConnCloseInputSchema = z.object({
  connId: ConnIdSchema,
  /** Also close every view belonging to this connection (default true) */
  closeViews: z.boolean().optional(),
})

export const ViewOpenInputSchema = z.object({
  spec: ViewOpenSpecSchema,
  /** Which panel to open into; falls back to focusedPanel, then to the first empty panel */
  panelId: PanelIdSchema.optional(),
  /**
   * What to do when the target panel is already occupied. **The default changed
   * with tabs, and so did the meaning of `false`.**
   *
   * - `false` (**the new default**) appends the view as a new tab on the target
   *   panel and shows it. Nothing is closed. Before tabs this meant "split off a
   *   new panel", which no longer has a reason to be the fallback: opening a
   *   second table used to have to choose between destroying the first and
   *   halving the window, and tabs are the answer to exactly that. Clicking a
   *   table in the sidebar now behaves the way every database GUI behaves.
   * - `true` closes the panel's **active** view and puts the new one in its tab
   *   position. Still available for callers that mean "reuse this slot", which
   *   is what a re-run into the same pane wants.
   *
   * "Open it in a new panel" is `layout.split` with `view`, which has always
   * been the honest spelling of that intent.
   */
  replace: z.boolean().optional(),
  /** Insert position in the target panel's tab bar; omitted means append. Ignored when `replace` is true. */
  index: z.number().int().nonnegative().optional(),
  /** Focus the view once open (default true) */
  focus: z.boolean().optional(),
})

export const ViewUpdateInputSchema = z.object({
  viewId: ViewIdSchema,
  patch: ViewPatchSchema,
  /** Re-fetch immediately with the new parameters (default true for table/vector, false for query) */
  refresh: z.boolean().optional(),
})

export const ViewCloseInputSchema = z.object({
  viewId: ViewIdSchema,
})

/**
 * Show a view that is already open — switch to its tab.
 *
 * A new command rather than a flag on something else, because it is the one
 * thing the tab bar does that nothing else expressed: the view exists, it is
 * mounted, it is simply behind another one. Making it a Command (rather than
 * renderer-local state) is not ceremony — `activeViewId` lives on the layout
 * tree, main owns that tree, the renderer is a read-only mirror, and MCP has to
 * be able to reach it or an AI cannot bring a hidden view to the front.
 */
export const ViewActivateInputSchema = z.object({
  viewId: ViewIdSchema,
  /** Also make the view's panel the focused panel (default true) */
  focusPanel: z.boolean().optional(),
})

export const QueryRunInputSchema = z
  .object({
    /** Run inside an existing query view */
    viewId: ViewIdSchema.optional(),
    /** Without a viewId, connId + text are required and main opens a new query view */
    connId: ConnIdSchema.optional(),
    /** Override the view's statement text; omit to run whatever the view currently holds */
    text: z.string().optional(),
    params: z.array(z.unknown()).optional(),
    maxRows: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Which panel a newly opened view lands in */
    panelId: PanelIdSchema.optional(),
  })
  // Zod issue messages surface in PeekError.detail, which is never translated.
  .refine(
    (v) => v.viewId !== undefined || (v.connId !== undefined && v.text !== undefined),
    { message: 'Provide either viewId, or connId together with text' },
  )

export const QueryCancelInputSchema = z
  .object({
    resultId: ResultIdSchema.optional(),
    /** Cancel whatever result set this view is currently running */
    viewId: ViewIdSchema.optional(),
  })
  .refine((v) => v.resultId !== undefined || v.viewId !== undefined, {
    message: 'Provide either resultId or viewId',
  })

export const LayoutSplitInputSchema = z.object({
  /** The panel to split */
  panelId: PanelIdSchema,
  dir: z.enum(['row', 'col']),
  /** Place the new panel before or after the original one (default after) */
  insert: z.enum(['before', 'after']).optional(),
  /** Ratios after the split; the length must equal the new split's child count, otherwise the space is divided evenly */
  ratio: z.array(z.number().positive()).optional(),
  /** Optionally open a view in the new panel right away */
  view: ViewOpenSpecSchema.optional(),
})

export const LayoutFocusInputSchema = z.object({
  panelId: PanelIdSchema,
})

export const LayoutSetRatioInputSchema = z.object({
  splitId: SplitIdSchema,
  ratio: z.array(z.number().positive()).min(2),
})

export const LayoutCloseInputSchema = z.object({
  panelId: PanelIdSchema,
  /** Close the panel's view along with it (default true) */
  closeView: z.boolean().optional(),
})

/* ---- Moving an existing view between panels (M2) ------------------- */

/**
 * Move a view that is already open into another panel, or to another position
 * within its own panel — the Command behind a centre drop, a tab-bar drop, a
 * tab reorder, and the only way to re-mount a view that has been left unplaced.
 *
 * Note what this is *not*: it never creates or destroys a view (`onOccupied:
 * 'replace'` excepted, and that mode is not reachable from any gesture).
 * `view.open` creates, `view.close` destroys, this one relocates. Keeping the
 * three apart is what lets a drag be undone by dragging back.
 *
 * **Reordering is a move.** Sending a view to the panel it is already in used to
 * be an unconditional no-op; now it is one only when the resulting tab index and
 * active tab are also unchanged. That is the whole of tab reordering — there is
 * no separate command for it, because "put this view at position 2 of that
 * panel" already describes it exactly.
 */
export const LayoutMoveViewInputSchema = z.object({
  viewId: ViewIdSchema,
  toPanelId: PanelIdSchema,
  /**
   * Where the view lands in the destination's tab bar. Omitted means append.
   *
   * The index is the view's **final** position in `toPanelId`'s `viewIds`,
   * measured after it has been detached from wherever it was, and clamped into
   * range rather than rejected. Final-position indexing is the only version a
   * caller can check against the result, and it removes the off-by-one that
   * caret-position indexing forces on every same-panel reorder.
   */
  index: z.number().int().nonnegative().optional(),
  /** Make the moved view the destination's active tab (default true) */
  activate: z.boolean().optional(),
  /**
   * What happens to the destination's existing views.
   *
   * - `stack` (**the default, and the only thing any gesture produces**) leaves
   *   them alone: the moved view becomes one more tab. Nothing is displaced, so
   *   nothing has to be caught — which is why the elaborate swap-or-unplace
   *   dance the pre-tab contract needed is gone from the default path.
   * - `swap` trades places with the destination's **active** view: it moves to
   *   the source panel, at the index the moved view vacated. Lossless, its own
   *   undo, and unreachable by mouse or keyboard on purpose — a modifier-drag
   *   for it would be undiscoverable, and stacking is strictly less surprising.
   *   It survives as a Command mode because an AI can name it explicitly, and
   *   because "these two panes should trade contents" is a real instruction.
   *   With no source panel (the view was unplaced) there is nowhere to send the
   *   displaced view, and `swap` degrades to `stack` rather than unmounting it.
   * - `replace` closes the destination's active view. Destructive, never what a
   *   drag does, and kept for callers that mean it.
   */
  onOccupied: z.enum(['stack', 'swap', 'replace']).optional(),
  /** Keep the source panel after its last tab leaves instead of removing it (default false) */
  keepSourcePanel: z.boolean().optional(),
  /** Focus the destination panel afterwards (default true) */
  focus: z.boolean().optional(),
})

/**
 * Split a panel and move an already-open view into the panel that appears — the
 * Command behind an edge drop.
 *
 * Deliberately separate from `layout.split`, whose optional `view` is a
 * `ViewOpenSpec` and therefore *opens* something new. Folding both into one
 * command would mean a mutually exclusive pair of fields and a result type that
 * sometimes reports a created view and sometimes a moved one.
 */
export const LayoutSplitWithViewInputSchema = z.object({
  viewId: ViewIdSchema,
  /** The panel being split; the moved view lands in the newly created panel */
  panelId: PanelIdSchema,
  dir: z.enum(['row', 'col']),
  /** Place the new panel before or after the one being split (default after) */
  insert: z.enum(['before', 'after']).optional(),
  /** Ratios after the split; ignored unless the length matches the split's child count */
  ratio: z.array(z.number().positive()).optional(),
  /** Keep the source panel after it empties instead of removing it (default false) */
  keepSourcePanel: z.boolean().optional(),
  /** Focus the new panel afterwards (default true) */
  focus: z.boolean().optional(),
})

/* ---- Declarative whole-tree layout (M2) ---------------------------- */

/**
 * One node of a **target** layout tree.
 *
 * Structurally the same discriminated union as `LayoutNode`, minus the ids the
 * system owns: a caller describes the shape it wants, and main decides which
 * panel keeps which id. The two mirror each other on purpose, so an AI that has
 * just read a `LayoutNode` out of `read_workspace` can edit it and send it back
 * with the ids stripped.
 */
export type LayoutSpecNode = LayoutSpecPanel | LayoutSpecSplit

/**
 * A panel leaf of a target tree.
 *
 * The singular `viewId` / `open` pair became `viewIds` / `open[]`, and the two
 * stopped being mutually exclusive — that exclusivity only ever encoded "a panel
 * holds one thing". A leaf now says: mount these existing views in this order,
 * then append these newly opened ones, and show that one.
 *
 * No singular alias is accepted. A model reads this schema as JSON Schema
 * through `commandInputJsonSchema` before it writes a tree, so there is nothing
 * to be backward compatible *with* — and two spellings for one field would cost
 * a paragraph of explanation in every tool description forever.
 */
export interface LayoutSpecPanel {
  type: 'panel'
  /** Mount views that already exist, in tab-bar order. */
  viewIds?: ViewId[]
  /** Open brand new views into this panel; they are appended after `viewIds`, in order. */
  open?: ViewOpenSpec[]
  /**
   * Which tab is visible. Must be one of `viewIds`; a newly `open`ed view cannot
   * be named here because it has no id until the command runs. Omitted means the
   * first tab — `viewIds[0]`, or the first `open` leaf when `viewIds` is empty.
   */
  activeViewId?: ViewId
  /** Pin this leaf to an existing panel id, keeping panel identity across the rewrite */
  panelId?: PanelId
  /** Caller-chosen label, echoed back in the result so the caller can find this leaf's panel id */
  key?: string
}

export interface LayoutSpecSplit {
  type: 'split'
  dir: 'row' | 'col'
  /** Share of space per child; must match `children.length` when given, otherwise the space is divided evenly */
  ratio?: number[]
  children: LayoutSpecNode[]
}

export const LayoutSpecPanelSchema = z.object({
  type: z.literal('panel'),
  viewIds: z.array(ViewIdSchema).max(MAX_PANEL_TABS).optional(),
  open: z.array(ViewOpenSpecSchema).max(MAX_PANEL_TABS).optional(),
  activeViewId: ViewIdSchema.optional(),
  panelId: PanelIdSchema.optional(),
  key: z.string().min(1).max(64).optional(),
})

/**
 * The recursion is expressed with `z.lazy` plus an explicit type annotation,
 * which is the only way zod can describe a self-referential schema without
 * losing the inferred type. Cross-node rules (duplicate ids, depth, panel count)
 * are *not* enforced here but in `LayoutSetLayoutInputSchema`'s refinement,
 * where the whole tree is in scope and an issue can carry the exact path to the
 * offending node.
 */
export const LayoutSpecNodeSchema: z.ZodType<LayoutSpecNode> = z.lazy(() =>
  z.discriminatedUnion('type', [LayoutSpecPanelSchema, LayoutSpecSplitSchema]),
)

export const LayoutSpecSplitSchema = z.object({
  type: z.literal('split'),
  dir: z.enum(['row', 'col']),
  ratio: z.array(z.number().positive()).optional(),
  children: z.array(LayoutSpecNodeSchema).min(2).max(MAX_SPLIT_CHILDREN),
})

/** What becomes of views that are open but absent from the target tree */
export const UnplacedPolicySchema = z.enum(['close', 'keep', 'error'])
export type UnplacedPolicy = z.infer<typeof UnplacedPolicySchema>

/**
 * The plain object half of `layout.setLayout`'s input.
 *
 * Exported because `LayoutSetLayoutInputSchema` carries a `superRefine` and is
 * therefore no longer a `ZodObject` — an MCP tool that wants to add its own
 * fields (the way `open_view` uses `.safeExtend`) extends this and re-applies
 * whatever refinement it needs.
 */
export const LayoutSetLayoutObjectSchema = z.object({
  tree: LayoutSpecNodeSchema,
  /**
   * Views that are open but do not appear in `tree`:
   * - `close` (default) closes them, so the tree really is the whole window;
   * - `keep` unmounts them — they stay in `views` with `panelId: null`, still
   *   addressable by `layout.moveView`, but invisible to the human at the screen;
   * - `error` refuses the whole command, which is how a caller says "I believe I
   *   listed everything" and finds out when it did not.
   */
  unplaced: UnplacedPolicySchema.optional(),
  /** Focus the panel that ends up holding this view */
  focusViewId: ViewIdSchema.optional(),
  /** Focus the panel produced by the leaf carrying this `key` (the only way to focus an empty panel) */
  focusKey: z.string().min(1).max(64).optional(),
  /**
   * Optimistic concurrency: refuse with CONFLICT unless the workspace is still
   * at this revision. A model reads the workspace, thinks, then submits a tree —
   * and in between the human may have dragged something. Without this the later
   * write silently wins; with it the model is told to look again.
   */
  expectRev: z.number().int().nonnegative().optional(),
})

/**
 * Whole-tree validation. Everything here is a rule that cannot be expressed on a
 * single node, and every issue carries the path of the node that broke it, so an
 * AI reading the failure can fix that node instead of resending the tree blind.
 */
export const LayoutSetLayoutInputSchema = LayoutSetLayoutObjectSchema.superRefine((value, ctx) => {
  const viewIds = new Set<string>()
  const panelIds = new Set<string>()
  const keys = new Set<string>()
  let panelCount = 0

  const walk = (node: LayoutSpecNode, path: (string | number)[], depth: number): void => {
    if (depth > MAX_LAYOUT_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `Layout nests deeper than ${String(MAX_LAYOUT_DEPTH)} levels`,
      })
      return
    }
    if (node.type === 'panel') {
      panelCount += 1
      // P5, counted across both halves of the leaf: a panel that mounts eight
      // views and opens eight more holds sixteen tabs, which neither array's own
      // `.max()` can see.
      const tabCount = (node.viewIds?.length ?? 0) + (node.open?.length ?? 0)
      if (tabCount > MAX_PANEL_TABS) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `A panel holds at most ${String(MAX_PANEL_TABS)} tabs, got ${String(tabCount)}`,
        })
      }
      for (const [i, viewId] of (node.viewIds ?? []).entries()) {
        // P3 and P4 at once: one flat set across the whole tree catches both a
        // view listed twice in one panel and a view claimed by two panels, and
        // the path names the offending entry either way.
        if (viewIds.has(viewId)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'viewIds', i],
            message: `View ${viewId} appears more than once; a view is mounted in at most one panel, once`,
          })
        }
        viewIds.add(viewId)
      }
      if (node.activeViewId !== undefined && !(node.viewIds ?? []).includes(node.activeViewId)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'activeViewId'],
          message:
            `activeViewId ${node.activeViewId} is not among this panel's viewIds. ` +
            'A view opened by `open` cannot be named here — it has no id yet; omit the field to show the first tab.',
        })
      }
      if (node.panelId !== undefined) {
        if (panelIds.has(node.panelId)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'panelId'],
            message: `Panel ${node.panelId} appears more than once`,
          })
        }
        panelIds.add(node.panelId)
      }
      if (node.key !== undefined) {
        if (keys.has(node.key)) {
          ctx.addIssue({ code: 'custom', path: [...path, 'key'], message: `Duplicate key ${node.key}` })
        }
        keys.add(node.key)
      }
      return
    }
    if (node.ratio !== undefined && node.ratio.length !== node.children.length) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'ratio'],
        message: `ratio has ${String(node.ratio.length)} entries but the split has ${String(node.children.length)} children`,
      })
    }
    node.children.forEach((child, i) => {
      walk(child, [...path, 'children', i], depth + 1)
    })
  }

  walk(value.tree, ['tree'], 0)

  if (panelCount < 1) {
    ctx.addIssue({ code: 'custom', path: ['tree'], message: 'A layout needs at least one panel' })
  }
  if (panelCount > MAX_LAYOUT_PANELS) {
    ctx.addIssue({
      code: 'custom',
      path: ['tree'],
      message: `A layout holds at most ${String(MAX_LAYOUT_PANELS)} panels, got ${String(panelCount)}`,
    })
  }
  if (value.focusViewId !== undefined && value.focusKey !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['focusKey'], message: 'Pass focusViewId or focusKey, not both' })
  }
  if (value.focusKey !== undefined && !keys.has(value.focusKey)) {
    ctx.addIssue({
      code: 'custom',
      path: ['focusKey'],
      message: `No panel in the tree carries key ${value.focusKey}`,
    })
  }
  if (value.focusViewId !== undefined && !viewIds.has(value.focusViewId)) {
    ctx.addIssue({
      code: 'custom',
      path: ['focusViewId'],
      message: `View ${value.focusViewId} is not placed anywhere in the tree`,
    })
  }
})

/* ---- Chat (M6) ----------------------------------------------------- */

/**
 * ## Why the chat panel has a Command surface at all
 *
 * Nothing about typing into a text box *needs* to leave the renderer. It gets a
 * Command surface for the same reason the tab bar did: main owns the Workspace,
 * the renderer is a read-only mirror, and anything the renderer can do that main
 * cannot observe is a place where the human's screen and the AI's `read_workspace`
 * can disagree.
 *
 * The consequence is the interesting part. Because these are ordinary Commands,
 * they are reachable from MCP like everything else — so an agent outside peek can
 * put a task into the conversation with the agent *inside* peek, and a human
 * watching the window sees both. That is not a special integration; it falls out
 * of refusing to build a side door.
 *
 * ## Addressed by `viewId`, never by `chatId`
 *
 * Every one of these takes the chat's **view** id. `read_workspace` reports view
 * ids and nothing else, so a caller can always name its target from what it has
 * already read; `ChatId` is main's key into the transcript store and is not in the
 * snapshot on purpose. One address, and it is the one already in the caller's hand.
 *
 * ## What is *not* here
 *
 * There is no command for "the agent produced a token". Streaming write-back is
 * main's own event path (`ChatEventSink`), exactly as driver-host result events
 * are — a Command per token would put the whole transcript through immer's patch
 * generator, which is the cost `chat.ts` exists to avoid.
 */

/**
 * Send the next turn.
 *
 * Refused with CONFLICT while a turn is already streaming, or while the agent is
 * blocked on a permission prompt. That guard is what stops an embedded agent from
 * prompting the conversation it is *itself* running in: it can only reach this
 * command from inside a turn, and inside a turn the conversation is busy.
 */
export const ChatSendInputSchema = z
  .object({
    viewId: ViewIdSchema,
    text: z.string().max(MAX_CHAT_PROMPT_CHARS),
    /**
     * Extra context for this turn only, appended after whatever the user has
     * already staged with `chat.attach`. Both sets are consumed by the send.
     */
    attachments: z.array(ChatAttachmentSpecSchema).max(MAX_CHAT_ATTACHMENTS).optional(),
  })
  // A turn must actually say something. Zod issue messages surface in
  // PeekError.detail, which is never translated.
  .refine((v) => v.text.trim() !== '' || (v.attachments?.length ?? 0) > 0, {
    message: 'Provide text, or at least one attachment',
  })

/**
 * Stop the turn in flight.
 *
 * A no-op when nothing is running, reported as `cancelled: false` rather than as
 * an error — the same contract `query.cancel` has, and for the same reason: the
 * caller asked for a state ("not running"), and it already held.
 */
export const ChatCancelInputSchema = z.object({
  viewId: ViewIdSchema,
})

/**
 * Empty the conversation, keeping the view.
 *
 * Cancels an in-flight turn on the way rather than refusing: "start over" is a
 * button a user presses precisely when the current turn has gone wrong, and
 * making them stop it first would be ceremony.
 */
export const ChatClearInputSchema = z.object({
  viewId: ViewIdSchema,
})

/** Stage context for the next prompt. Descriptors only — see `ChatAttachmentSpec`. */
export const ChatAttachInputSchema = z.object({
  viewId: ViewIdSchema,
  attachments: z.array(ChatAttachmentSpecSchema).min(1).max(MAX_CHAT_ATTACHMENTS),
})

/** Unstage. Omitting `attachmentIds` clears everything staged. */
export const ChatDetachInputSchema = z.object({
  viewId: ViewIdSchema,
  attachmentIds: z.array(AttachmentIdSchema).optional(),
})

/**
 * Answer the permission prompt the agent is blocked on.
 *
 * `requestId` is optional but strongly recommended: with it, an answer that
 * arrives after the prompt it was meant for has been replaced is refused with
 * CONFLICT instead of silently approving whatever is being asked *now*. That race
 * is not hypothetical — a turn can raise a second permission request while a
 * human is still reading the first.
 */
export const ChatRespondPermissionInputSchema = z.object({
  viewId: ViewIdSchema,
  requestId: z.string().min(1).optional(),
  /**
   * One of `pendingPermission.options[].optionId`. Note that an option's
   * `optionId` and its `kind` are **not** the same string (`allow` vs
   * `allow_once`); the agent only accepts the `optionId`.
   */
  optionId: z.string().min(1),
})

/**
 * Change how tool calls are gated.
 *
 * A non-`ui` caller cannot select a mode that removes the human from the loop.
 * The whole value of the permission prompt is that a person sees what the model
 * is about to do; a model that can turn that off has been handed the keys, and
 * "an agent asked nicely" is not consent.
 */
export const ChatSetModeInputSchema = z.object({
  viewId: ViewIdSchema,
  mode: ChatPermissionModeSchema,
})

/**
 * Read the agent's catalogue of past conversations.
 *
 * A read-only command, with `conn.book.list` as its precedent: it changes no
 * Workspace state and exists to answer a question the window has to ask before
 * it can draw anything. The answer is not mirrored into Workspace either —
 * it belongs to the agent, it can change without peek's involvement, and a copy
 * kept in sync through patches would buy nothing.
 */
export const ChatSessionsListInputSchema = z.object({})

/**
 * Delete one of the agent's stored conversations.
 *
 * The **only** destructive command in the chat family, and the only one that
 * reaches outside peek's own state: what it destroys is a transcript the agent
 * wrote under its working directory. It is deliberately absent from the MCP tool
 * surface (`mcp/tools/` has no file for it) — an embedded agent that can delete
 * its own history, or its neighbours', is an attack surface with no matching
 * benefit.
 */
export const ChatSessionsDeleteInputSchema = z.object({
  sessionId: z.string().min(1),
})

export const StateReadInputSchema = z.object({
  /** Ask for only the parts you need, to save tokens; omit for everything */
  include: z.array(z.enum(['layout', 'views', 'connections', 'results'])).optional(),
  /** Pass a view id when only that view matters; `views` in the response then holds just this one */
  viewId: ViewIdSchema.optional(),
})

/* ------------------------------------------------------------------ */
/* The connection book, and the MCP endpoint                           */
/* ------------------------------------------------------------------ */

/**
 * Read the saved connections (`~/.peek/connections.json`).
 *
 * There is deliberately **no `conn.book.save`**. An entry is written as a
 * side effect of a `conn.open` that succeeded, which keeps `conn.open` the one
 * and only way a connection is described to peek — a second write path would be
 * a second place for a config to be wrong, and the only one of the two that is
 * ever proven to work is the one that actually connected.
 */
export const ConnBookListInputSchema = z.object({})

export const ConnBookForgetInputSchema = z.object({
  /** Id of the saved entry, as returned by `conn.book.list` */
  id: z.string().min(1),
})

export const McpReadInputSchema = z.object({})

/**
 * Change the MCP endpoint.
 *
 * Both members are about credentials the user has already handed to an AI
 * client, so both are answered with the same warning: a rotated token or a moved
 * port invalidates every `claude mcp add` the user has run.
 */
export const McpConfigureInputSchema = z
  .object({
    /**
     * Preferred port. Persisted, so it survives a restart. Port 0 is not
     * accepted here even though the kernel would allocate one: an endpoint that
     * moves on every launch cannot be registered with a client.
     */
    port: z.number().int().min(1).max(65535).optional(),
    /** Mint a fresh bearer token, invalidating the one clients hold. */
    rotateToken: z.boolean().optional(),
  })
  .refine((value) => value.port !== undefined || value.rotateToken === true, {
    message: 'mcp.configure needs a port, a token rotation, or both',
  })

export const SettingsReadInputSchema = z.object({})

/**
 * A whole-fetch deadline, in milliseconds.
 *
 * `0` is legal and means **no deadline** — the honest spelling of "let it run",
 * and the reason this is non-negative rather than positive. The ceiling matches
 * the one main enforces (~1 hour), so a value that passes here is one main will
 * actually keep rather than silently drop.
 */
const ExecutionTimeoutMsSchema = z.number().int().min(0).max(3_600_000)

/**
 * How large the whole window is drawn, as Electron's `zoomFactor`.
 *
 * The bounds are not arbitrary. Below 0.8 the 11px text floor
 * (`design/2026-08-02-ui-legibility-baseline.md` §2.1) would be scaled back
 * under 9px, which is the exact thing that document exists to stop — a zoom
 * control that can undo the legibility floor is not a zoom control, it is a
 * loophole. Above 1.5 the sidebar (240px), the conversation rail (260px) and a
 * usable panel no longer fit inside the 900px `minWidth`.
 */
export const UI_ZOOM_MIN = 0.8
export const UI_ZOOM_MAX = 1.5
export const UI_ZOOM_DEFAULT = 1

/**
 * The stops the UI offers, and the ones `⌘+` / `⌘-` step between.
 *
 * Discrete rather than free: a continuous zoom invites 1.03, which costs a
 * fractional-pixel repaint of every rule in the window and buys nothing a person
 * can perceive. Anything outside this list is still *accepted* (MCP or a
 * hand-edited settings file may send it) and merely clamped — refusing it would
 * turn a cosmetic preference into a failed command.
 */
export const UI_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const

const UiZoomSchema = z.number().min(UI_ZOOM_MIN).max(UI_ZOOM_MAX)

/** Nearest legal zoom to `value`, for callers that cannot reject. */
export function clampUiZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_ZOOM_DEFAULT
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value))
}

/**
 * The stop one step away from `from`, in the given direction.
 *
 * Used by the View menu. Returns the current value unchanged at either end, so
 * holding `⌘-` stops rather than wrapping around to the largest size.
 */
export function stepUiZoom(from: number, direction: 1 | -1): number {
  const current = clampUiZoom(from)
  // Nearest stop first: the value may have come from a hand-edited file and land
  // between two of them, and stepping from "between" has to be well defined.
  let index = 0
  for (let i = 1; i < UI_ZOOM_STEPS.length; i += 1) {
    if (Math.abs(UI_ZOOM_STEPS[i] - current) < Math.abs(UI_ZOOM_STEPS[index] - current)) index = i
  }
  const next = index + direction
  return UI_ZOOM_STEPS[next] ?? UI_ZOOM_STEPS[index]
}

/**
 * Change the settings that live in `~/.peek/settings.json`.
 *
 * The stage timeouts of the driver-host protocol are deliberately absent: they
 * bound one leg of an internal protocol and are the app protecting itself from a
 * wedged process, not a preference — see
 * `docs/design/2026-08-02-settings-panel.md` §3.2.
 *
 * Every member is optional and only what is present is changed, so a form that
 * edits one field does not have to send the others back unchanged and risk
 * clobbering a concurrent edit.
 */
export const SettingsWriteInputSchema = z
  .object({
    execution: z
      .object({
        /** Free-form query (`query.run`) */
        queryMs: ExecutionTimeoutMsSchema.optional(),
        /** Collection scan (`collection.scan`) */
        scanMs: ExecutionTimeoutMsSchema.optional(),
        /** Vector search (`vector.search`) */
        vectorSearchMs: ExecutionTimeoutMsSchema.optional(),
      })
      .optional(),
    /** Whole-window zoom factor. See `UI_ZOOM_MIN`. */
    uiZoom: UiZoomSchema.optional(),
  })
  .refine(
    (value) =>
      value.uiZoom !== undefined ||
      (value.execution !== undefined && Object.keys(value.execution).length > 0),
    { message: 'settings.write needs at least one setting to change' },
  )

/* ================================================================== */
/* 3. Registry: command name → input schema                            */
/* ================================================================== */

/**
 * The command registry. **This is the single source of truth**: every input type
 * is `CommandInput<'xxx'>`, z.infer'd from here, so no second hand-written copy
 * exists.
 */
export const commandSchemas = {
  'conn.open': ConnOpenInputSchema,
  'conn.close': ConnCloseInputSchema,
  'view.open': ViewOpenInputSchema,
  'view.update': ViewUpdateInputSchema,
  'view.close': ViewCloseInputSchema,
  'view.activate': ViewActivateInputSchema,
  'query.run': QueryRunInputSchema,
  'query.cancel': QueryCancelInputSchema,
  'layout.split': LayoutSplitInputSchema,
  'layout.focus': LayoutFocusInputSchema,
  'layout.setRatio': LayoutSetRatioInputSchema,
  'layout.close': LayoutCloseInputSchema,
  'layout.moveView': LayoutMoveViewInputSchema,
  'layout.splitWithView': LayoutSplitWithViewInputSchema,
  'layout.setLayout': LayoutSetLayoutInputSchema,
  'chat.send': ChatSendInputSchema,
  'chat.cancel': ChatCancelInputSchema,
  'chat.clear': ChatClearInputSchema,
  'chat.attach': ChatAttachInputSchema,
  'chat.detach': ChatDetachInputSchema,
  'chat.respondPermission': ChatRespondPermissionInputSchema,
  'chat.setMode': ChatSetModeInputSchema,
  'chat.sessions.list': ChatSessionsListInputSchema,
  'chat.sessions.delete': ChatSessionsDeleteInputSchema,
  'state.read': StateReadInputSchema,
  'conn.book.list': ConnBookListInputSchema,
  'conn.book.forget': ConnBookForgetInputSchema,
  'mcp.read': McpReadInputSchema,
  'mcp.configure': McpConfigureInputSchema,
  'settings.read': SettingsReadInputSchema,
  'settings.write': SettingsWriteInputSchema,
} as const satisfies Record<CommandName, z.ZodType>

export type CommandSchemas = typeof commandSchemas

/** Input type of one command */
export type CommandInput<K extends CommandName> = z.infer<CommandSchemas[K]>

/* ================================================================== */
/* 4. Per-command results                                              */
/* ================================================================== */

export interface ConnOpenResult {
  connId: ConnId
  status: ConnStatus
  capabilities: Capability[]
  serverInfo?: ServerInfo
  /** The tree view opened automatically, when openTree was true */
  treeViewId?: ViewId
}

export interface ConnCloseResult {
  connId: ConnId
  closedViewIds: ViewId[]
}

export interface ViewOpenResult {
  viewId: ViewId
  panelId: PanelId
  kind: ViewKind
  /** Present when a table/vector view started fetching on open */
  resultId?: ResultId
}

export interface ViewUpdateResult {
  viewId: ViewId
  /** The new result set, when the update triggered a re-fetch */
  resultId?: ResultId
}

export interface ViewCloseResult {
  viewId: ViewId
  /**
   * The panel the view used to sit in. **The panel always stays** — emptied when
   * that was its last tab. Removing a panel is `layout.close`'s job.
   */
  panelId: PanelId | null
  /**
   * The tab that took over, when the closed view was the active one: right
   * neighbour, else left, else null for a panel that is now empty. Named in the
   * result because closing a tab changes what is on screen, and a caller should
   * not have to re-read the tree to find out what it is now looking at.
   */
  activatedViewId: ViewId | null
}

export interface ViewActivateResult {
  viewId: ViewId
  panelId: PanelId
  /** The tab that was showing before; null when the panel was empty, and equal to `viewId` for a no-op */
  previousViewId: ViewId | null
  focusedPanel: PanelId | null
}

export interface QueryRunResult {
  resultId: ResultId
  viewId: ViewId
}

export interface QueryCancelResult {
  resultId: ResultId
  /** False when the target had already finished */
  cancelled: boolean
}

export interface LayoutSplitResult {
  splitId: SplitId
  /** The newly created panel */
  panelId: PanelId
  /** Present when a `view` was passed in */
  viewId?: ViewId
}

export interface LayoutFocusResult {
  panelId: PanelId
}

export interface LayoutSetRatioResult {
  splitId: SplitId
  /** The effective ratios after normalization */
  ratio: number[]
}

export interface LayoutCloseResult {
  panelId: PanelId
  closedViewIds: ViewId[]
}

/**
 * Fields every structural layout change reports, so a caller never has to diff
 * two snapshots to find out what the tree did behind its back. `removedPanelIds`
 * in particular matters: a move can delete the source panel *and* collapse its
 * parent split, invalidating ids the caller was holding.
 */
export interface LayoutChangeReport {
  /** Panels that no longer exist, because they emptied out or their split collapsed */
  removedPanelIds: PanelId[]
  /** The focused panel after the change */
  focusedPanel: PanelId | null
}

export interface LayoutMoveViewResult extends LayoutChangeReport {
  viewId: ViewId
  /** Where the view came from; null when it was unplaced */
  fromPanelId: PanelId | null
  toPanelId: PanelId
  /** The view's final position in the destination's tab bar */
  toIndex: number
  /**
   * False when the command changed nothing — the view was already in this panel,
   * at this index, and already active if `activate` asked for it. A no-op, not a
   * failure: the user let go two pixels from where they picked up.
   */
  moved: boolean
  /**
   * The destination's former active view, traded into the source panel by
   * `onOccupied: 'swap'`.
   *
   * Only ever set for an explicit `swap` that had a source panel to trade with.
   * The default `stack` displaces nothing, so this is absent — which is the
   * point: the pre-tab contract had to name a view that might have been silently
   * unmounted, and stacking removed the situation rather than the reporting.
   */
  swappedViewId?: ViewId
  /** Non-empty only with onOccupied: 'replace' */
  closedViewIds: ViewId[]
}

export interface LayoutSplitWithViewResult extends LayoutChangeReport {
  viewId: ViewId
  /** The split the new panel belongs to (an existing one when the direction matched) */
  splitId: SplitId
  /** The new panel, now holding the view */
  panelId: PanelId
  fromPanelId: PanelId | null
  /** False when the split would have been undone immediately — dropping a view on its own panel's edge */
  moved: boolean
}

/** One leaf of the applied tree, in depth-first (visual) order */
export interface LayoutSetLayoutPanel {
  /** Echoed from the spec leaf, when it carried one */
  key?: string
  panelId: PanelId
  /** Final tab-bar contents, mounted views first then the newly opened ones */
  viewIds: ViewId[]
  activeViewId: ViewId | null
}

export interface LayoutSetLayoutResult extends LayoutChangeReport {
  panels: LayoutSetLayoutPanel[]
  createdPanelIds: PanelId[]
  /** Views created by an `open` leaf, in depth-first order of those leaves */
  openedViewIds: ViewId[]
  /** Views that were open but absent from the tree (with unplaced: 'keep' they are still in `views`, unmounted) */
  unplacedViewIds: ViewId[]
  /** Non-empty only with unplaced: 'close' */
  closedViewIds: ViewId[]
}

/* ---- Chat results --------------------------------------------------- */

/**
 * Every chat result carries `viewId` **and** `chatId`.
 *
 * The caller addressed the view; it gets its own address echoed back so a receipt
 * is self-describing. `chatId` is included because it is the id the transcript is
 * keyed by, and a renderer applying `ChatDelta`s needs to know which conversation
 * the command it just sent belongs to without a second lookup.
 */
export interface ChatResultBase {
  viewId: ViewId
  chatId: ChatId
  /** The conversation's state after the command landed. */
  agentStatus: ChatAgentStatus
}

export interface ChatSendResult extends ChatResultBase {
  /** The user turn that was appended. The agent's reply streams in under its own id. */
  messageId: ChatMessageId
  /** Descriptors resolved into this prompt — staged ones plus any passed inline. */
  attachments: ChatAttachment[]
}

export interface ChatCancelResult extends ChatResultBase {
  /** False when no turn was in flight; a no-op, not a failure. */
  cancelled: boolean
  /** The turn that was stopped, or null for the no-op case. */
  messageId: ChatMessageId | null
}

export interface ChatClearResult extends ChatResultBase {
  /** How many messages the conversation held before it was emptied. */
  clearedMessages: number
  /** True when a turn had to be stopped to clear the conversation. */
  cancelledTurn: boolean
}

export interface ChatAttachResult extends ChatResultBase {
  /** Ids of the descriptors now staged, in the order they were requested. A duplicate returns the existing id. */
  attachmentIds: AttachmentId[]
  /** Everything staged after the command, so a caller never has to re-read the view. */
  attachments: ChatAttachment[]
}

export interface ChatDetachResult extends ChatResultBase {
  removedIds: AttachmentId[]
  attachments: ChatAttachment[]
}

export interface ChatRespondPermissionResult extends ChatResultBase {
  requestId: string
  optionId: string
  /** The tool the answer unblocks, so a receipt reads as an audit line. */
  toolName: string
}

export interface ChatSetModeResult extends ChatResultBase {
  mode: ChatPermissionMode
  previousMode: ChatPermissionMode
}

/**
 * The agent's conversation catalogue.
 *
 * `supported: false` is a first-class answer, not an error. An ACP agent is not
 * obliged to advertise `loadSession`, and one that does not simply has no
 * catalogue to offer — the UI owes the user that sentence rather than an empty
 * list, which would read as "you have never had a conversation".
 */
export interface ChatSessionsListResult {
  sessions: ChatSessionInfo[]
  /** Whether this agent advertises session history at all. */
  supported: boolean
  /** The working directory the catalogue was read from; peek's own chat workdir. */
  cwd: string | null
}

/**
 * The receipt says what peek accepted, not what the agent has finished.
 *
 * A conversation that is **open in a view** is refused with CONFLICT rather than
 * closed on the user's behalf: closing panels as a side effect of a delete makes
 * one click do two things, and the one it does silently is the one that loses
 * work. The window says "close it first", which is a sentence, not a surprise.
 *
 * Past that check the deletion runs as an effect, so this receipt cannot report
 * its outcome — a failure arrives as a notification and the conversation simply
 * reappears the next time the list is opened.
 */
export interface ChatSessionsDeleteResult {
  sessionId: string
}

export interface StateReadResult {
  snapshot: WorkspaceSnapshot
}

/* ------------------------------------------------------------------ */
/* The connection book                                                 */
/* ------------------------------------------------------------------ */

/**
 * One entry of `~/.peek/connections.json`, as everyone outside the main process
 * sees it.
 *
 * `config` is **always redacted** — the password is replaced and any credentials
 * inside a URL are scrubbed, exactly as for a live connection. The real secret
 * never leaves main: it is encrypted with Electron's `safeStorage` and merged
 * back in at the moment `conn.open` reaches the driver. So a window (or an AI)
 * holding this record can describe a connection and ask for it to be opened, and
 * still cannot read the credential.
 */
export interface SavedConnection {
  /** Stable id of the entry; the address `conn.book.forget` takes. */
  id: string
  driverId: DriverId
  /** What to show in a list. Derived from the config when the user gave no label. */
  label: string
  /** Redacted, and safe to display. */
  config: ConnectionConfig
  /**
   * A credential for this entry is held in the vault.
   *
   * False for two very different reasons — the connection genuinely needs no
   * password, or `safeStorage` was unavailable when it was saved and peek
   * refused to write the secret in the clear. `secretsAvailable` on the list
   * result is what tells those two apart.
   */
  hasSecret: boolean
  /** ISO timestamps. */
  createdAt: string
  lastUsedAt: string
}

export interface ConnBookListResult {
  entries: SavedConnection[]
  /**
   * Whether the OS keychain backing `safeStorage` is usable in this session.
   * When false, peek saves connections **without** their passwords rather than
   * writing them to disk unprotected, and a UI should say so.
   */
  secretsAvailable: boolean
}

export interface ConnBookForgetResult {
  id: string
  /** False when the id was already gone; a no-op, not a failure. */
  removed: boolean
  /** The book after the removal, so a caller never has to re-list. */
  entries: SavedConnection[]
}

/* ------------------------------------------------------------------ */
/* The MCP endpoint                                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything needed to register peek with an AI client, plus enough to explain
 * the endpoint being down.
 */
export interface McpStatus {
  /** True only while the HTTP server is actually bound. */
  listening: boolean
  host: string
  /** The port really in use. May differ from `preferredPort` after a fallback. */
  port: number
  /** What the user asked for, persisted in `~/.peek/settings.json`. */
  preferredPort: number
  path: string
  url: string
  /** The bearer token, in full. A UI is expected to mask it until asked. */
  token: string
  /** A ready-to-paste `claude mcp add` line. */
  hint: string
  /** Absolute path of the file an AI client can also read this from. */
  configFile: string
  /** Set when the last start or restart failed; the reason, in English. */
  error?: PeekError
  /** A restart is in flight; re-read shortly. */
  restarting: boolean
}

export type McpReadResult = McpStatus

export interface McpConfigureResult extends McpStatus {
  /**
   * True when clients must be re-registered: the token changed, or the endpoint
   * moved. Never inferred by the caller — peek knows which of the two happened.
   */
  reregisterRequired: boolean
  tokenRotated: boolean
  /** Null when the port was left alone. */
  previousPort: number | null
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The whole-fetch deadlines in force, in milliseconds. `0` means no deadline.
 *
 * Named after the three things a driver can be asked to stream, because that is
 * what the numbers actually bound — not "the UI", not "a view".
 */
export interface ExecutionBudgets {
  queryMs: number
  scanMs: number
  vectorSearchMs: number
}

/**
 * Where peek keeps what it keeps, as absolute paths.
 *
 * Reported rather than reconstructed by the caller: `~/.peek` moves with
 * `PEEK_CONFIG_DIR`, and a renderer that spelled the path itself would be
 * confidently wrong on exactly the machines where it matters.
 */
export interface SettingsPaths {
  configDir: string
  settingsFile: string
  connectionsFile: string
  mcpFile: string
}

export interface SettingsReadResult {
  execution: ExecutionBudgets
  paths: SettingsPaths
  /** The app version, as Electron reports it. */
  version: string
  /** Whole-window zoom factor; `UI_ZOOM_DEFAULT` when the user has never set one. */
  uiZoom: number
}

export interface SettingsWriteResult {
  /**
   * What actually took effect — not what was asked for. Invalid entries are
   * dropped rather than rejected (see `setTimeoutSettings`), so this is the only
   * honest answer to "what is the timeout now".
   */
  execution: ExecutionBudgets
  /** Likewise: the zoom after clamping, which is what the window is drawing at. */
  uiZoom: number
}

export interface CommandResultMap {
  'conn.open': ConnOpenResult
  'conn.close': ConnCloseResult
  'view.open': ViewOpenResult
  'view.update': ViewUpdateResult
  'view.close': ViewCloseResult
  'view.activate': ViewActivateResult
  'query.run': QueryRunResult
  'query.cancel': QueryCancelResult
  'layout.split': LayoutSplitResult
  'layout.focus': LayoutFocusResult
  'layout.setRatio': LayoutSetRatioResult
  'layout.close': LayoutCloseResult
  'layout.moveView': LayoutMoveViewResult
  'layout.splitWithView': LayoutSplitWithViewResult
  'layout.setLayout': LayoutSetLayoutResult
  'chat.send': ChatSendResult
  'chat.cancel': ChatCancelResult
  'chat.clear': ChatClearResult
  'chat.attach': ChatAttachResult
  'chat.detach': ChatDetachResult
  'chat.respondPermission': ChatRespondPermissionResult
  'chat.setMode': ChatSetModeResult
  'chat.sessions.list': ChatSessionsListResult
  'chat.sessions.delete': ChatSessionsDeleteResult
  'state.read': StateReadResult
  'conn.book.list': ConnBookListResult
  'conn.book.forget': ConnBookForgetResult
  'mcp.read': McpReadResult
  'mcp.configure': McpConfigureResult
  'settings.read': SettingsReadResult
  'settings.write': SettingsWriteResult
}

/** Compile-time assertion: every command needs a result type — miss one and this line goes red */
type MissingResult = Exclude<CommandName, keyof CommandResultMap>
const _assertNoMissingResult: MissingResult extends never ? true : never = true
void _assertNoMissingResult

export type CommandResultData<K extends CommandName> = CommandResultMap[K]

/* ================================================================== */
/* 5. Command and result envelopes                                     */
/* ================================================================== */

/** A single command; `name` and `input` are correlated */
export type Command = { [K in CommandName]: { name: K; input: CommandInput<K> } }[CommandName]

export interface CommandEnvelope<K extends CommandName = CommandName> {
  /** Unique id, carried through the command log, the patch broadcast and the result */
  id: string
  name: K
  input: CommandInput<K>
  source: CommandSource
  /** Timestamp of dispatch (ms) */
  ts: number
}

/** Envelope of any command, keeping `name` and `input` correlated */
export type AnyCommandEnvelope = { [K in CommandName]: CommandEnvelope<K> }[CommandName]

export interface CommandOk<T> {
  ok: true
  commandId: string
  /** Workspace revision after the command was committed */
  rev: number
  data: T
}

export interface CommandErr {
  ok: false
  commandId: string
  error: PeekError
}

export type CommandResult<T = unknown> = CommandOk<T> | CommandErr

/** Full result type of one command */
export type CommandResultFor<K extends CommandName> = CommandResult<CommandResultData<K>>

export function commandOk<T>(commandId: string, rev: number, data: T): CommandOk<T> {
  return { ok: true, commandId, rev, data }
}

export function commandErr(commandId: string, error: PeekError): CommandErr {
  return { ok: false, commandId, error }
}

/* ================================================================== */
/* 6. Validation entry point                                           */
/* ================================================================== */

export type ParsedCommand<K extends CommandName> =
  | { ok: true; input: CommandInput<K> }
  | { ok: false; error: PeekError }

/**
 * Validate one command's input. The UI and the MCP tools **both** have to clear
 * this gate before reaching the Command Bus, which is what guarantees a handler
 * only ever sees well-formed data.
 */
export function parseCommandInput<K extends CommandName>(name: K, raw: unknown): ParsedCommand<K> {
  const schema: z.ZodType = commandSchemas[name]
  const result = schema.safeParse(raw)
  if (result.success) {
    return { ok: true, input: result.data as CommandInput<K> }
  }
  return {
    ok: false,
    // The summary is localizable; the zod issue list in `detail` never is.
    error: peekErrorMsg('BAD_REQUEST', 'error.command.badInput', { name }, {
      detail: formatZodIssues(result.error),
    }),
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('\n')
}

/**
 * Convert one command's input schema to JSON Schema, so an MCP tool can reuse it
 * directly as its `inputSchema`. That makes the first half of "a new MCP tool =
 * declare an inputSchema + map it onto some commands" cost essentially nothing.
 */
export const commandInputJsonSchema = (name: CommandName): unknown =>
  z.toJSONSchema(commandSchemas[name], { io: 'input', unrepresentable: 'any' })
