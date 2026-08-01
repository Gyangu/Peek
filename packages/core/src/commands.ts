import { z } from 'zod'
import {
  CollectionRefSchema,
  ConnectionConfigSchema,
  FilterSpecSchema,
  SortSpecSchema,
  ValueRefSchema,
  type Capability,
  type ServerInfo,
} from './capability'
import { MAX_PAGE_LIMIT } from './chunk'
import { peekErrorMsg, type PeekError } from './errors'
import {
  ConnIdSchema,
  PanelIdSchema,
  ResultIdSchema,
  SplitIdSchema,
  ViewIdSchema,
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
  'state.read',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMAND_NAMES as readonly string[]).includes(value)
}

/** Where a command came from; used by the command log and for auditing (the log is a recording of every action, and replayable) */
export const CommandSourceSchema = z.enum(['ui', 'mcp', 'system'])
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

/** Input spec for view.open: no id, because main generates it */
export const ViewOpenSpecSchema = z.discriminatedUnion('kind', [
  TableViewSpecSchema,
  QueryViewSpecSchema,
  InspectorViewSpecSchema,
  TreeViewSpecSchema,
  VectorViewSpecSchema,
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

export const StateReadInputSchema = z.object({
  /** Ask for only the parts you need, to save tokens; omit for everything */
  include: z.array(z.enum(['layout', 'views', 'connections', 'results'])).optional(),
  /** Pass a view id when only that view matters; `views` in the response then holds just this one */
  viewId: ViewIdSchema.optional(),
})

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
  'state.read': StateReadInputSchema,
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

export interface StateReadResult {
  snapshot: WorkspaceSnapshot
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
  'state.read': StateReadResult
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

/** Assemble an envelope for a command about to be executed */
export function makeCommandEnvelope<K extends CommandName>(
  id: string,
  name: K,
  input: CommandInput<K>,
  source: CommandSource,
): CommandEnvelope<K> {
  return { id, name, input, source, ts: Date.now() }
}

/**
 * Convert one command's input schema to JSON Schema, so an MCP tool can reuse it
 * directly as its `inputSchema`. That makes the first half of "a new MCP tool =
 * declare an inputSchema + map it onto some commands" cost essentially nothing.
 */
export const commandInputJsonSchema = (name: CommandName): unknown =>
  z.toJSONSchema(commandSchemas[name], { io: 'input', unrepresentable: 'any' })
