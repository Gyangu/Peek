import { z } from 'zod'
import {
  CollectionRefSchema,
  ConnectionConfigSchema,
  FilterSpecSchema,
  PACKAGE_ID_PATTERN,
  SortSpecSchema,
  ValueRefSchema,
  collectionBrowseStyle,
  type Capability,
  type CollectionRef,
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
import { peekErrorMsg, zodIssueLines, type PeekError, type PeekErrorCode } from './errors'
import type { LogLevel, LogRecord } from './logger'
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
  'view.promote',
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
  'chat.ask',
  'chat.answer',
  'state.read',
  'log.read',
  'log.readCommands',
  'conn.book.list',
  'conn.book.forget',
  'mcp.read',
  'mcp.configure',
  'settings.read',
  'settings.write',
  'packages.read',
  'packages.install',
  'packages.uninstall',
  'packages.restore',
  'app.notify',
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
 * - `system` main acting on its own: the write-back from driver host events and
 *            agent stream events, and — since auto-refresh — the timers that
 *            carry out a standing instruction the user already gave. The label
 *            still means "nobody asked for this *right now*", which is exactly
 *            what makes a command log filtered to `ui` / `mcp` / `agent` a
 *            recording of intent rather than of machinery.
 */
export const CommandSourceSchema = z.enum(['ui', 'mcp', 'agent', 'system'])
export type CommandSource = z.infer<typeof CommandSourceSchema>

/* ================================================================== */
/* 1. View-open specs and incremental updates                          */
/* ================================================================== */

const pageLimit = z.number().int().positive().max(MAX_PAGE_LIMIT)
const pageOffset = z.number().int().nonnegative()

/**
 * What a view is called, on every spec that opens one and every patch that
 * changes one.
 *
 * A module-level constant rather than fourteen copies of the same line, for the
 * same reason as `autoRefreshMs` below: the description is the interesting part,
 * and a description that exists in fourteen places is one that will disagree with
 * itself. It reaches an MCP client through `commandSchemas['view.open']`, which is
 * what `open_view` extends, so the field explains itself wherever it is offered
 * and `open_view` / `update_view` never restate it.
 *
 * The wording carries three things, and dropping any one of them produces a
 * predictable misuse: without "derived when omitted" a model titles everything,
 * including the table browser that already reads `public.orders`; without "a few
 * words" it writes a sentence into a tab strip.
 */
const viewTitle = z
  .string()
  .optional()
  .describe(
    'What this view is called in the tab strip — a few words saying what it is or why it was ' +
      'opened ("Orders after the migration", "Slow queries"), not a sentence. ' +
      'Omitting it is not an error and is usually right: the title is then derived from the ' +
      'content (a collection browser reads `public.orders`, a SQL editor reads `Query`), which ' +
      'already names any view whose content names itself.',
  )

export const TableViewSpecSchema = z.object({
  kind: z.literal('table'),
  connId: ConnIdSchema,
  ref: CollectionRefSchema,
  filter: z.array(FilterSpecSchema).optional(),
  sort: z.array(SortSpecSchema).optional(),
  offset: pageOffset.optional(),
  limit: pageLimit.optional(),
  title: viewTitle,
})

export const QueryViewSpecSchema = z.object({
  kind: z.literal('query'),
  connId: ConnIdSchema,
  /** Omitted means an empty editor */
  text: z.string().optional(),
  /** Run it as soon as the view opens */
  run: z.boolean().optional(),
  title: viewTitle,
})

export const InspectorViewSpecSchema = z.object({
  kind: z.literal('inspector'),
  connId: ConnIdSchema,
  ref: ValueRefSchema,
  title: viewTitle,
})

export const TreeViewSpecSchema = z.object({
  kind: z.literal('tree'),
  connId: ConnIdSchema,
  expanded: z.array(z.string()).optional(),
  title: viewTitle,
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
  title: viewTitle,
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
  z
    .object({
      kind: z.literal('cells'),
      viewId: ViewIdSchema,
      resultId: ResultIdSchema,
      r0: z.number().int().nonnegative(),
      r1: z.number().int().nonnegative(),
      columns: z.array(z.string().min(1)).min(1),
      label: z.string().min(1).max(120).optional(),
    })
    .refine((v) => v.r1 >= v.r0, { message: 'r1 must not be less than r0' })
    .refine((v) => v.r1 - v.r0 + 1 <= MAX_CHAT_ATTACHMENT_ROWS, {
      message: `A cell rectangle may span at most ${MAX_CHAT_ATTACHMENT_ROWS} rows`,
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
  title: viewTitle,
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

/**
 * Opening a view a package contributed.
 *
 * ## Why this is the only thing the Command contract had to open
 *
 * The plan called for turning `COMMAND_NAMES` into a runtime registry so a
 * package could add commands. Reading the list makes that unnecessary: all 32
 * names are kernel-generic — connections, layout, chat, settings — and not one
 * of them belongs to a particular database. What a package actually needs is not
 * a new verb but for two existing ones, `view.open` and `view.update`, to accept
 * its `kind`.
 *
 * So `COMMAND_NAMES` stays closed and every guarantee built on it survives
 * untouched: `CommandInput<K>`, `CommandResultMap`, the
 * `_assertNoMissingResult` compile-time check, `coreHandlers satisfies
 * Required<CommandHandlerMap>`, `parseCommandInput<K>`'s typed return, and the
 * several hundred `dispatch('view.update', …)` call sites in the renderer.
 * Only the two per-kind payload unions grow a member — the same shape as
 * `ViewState` (see `core/view-kinds.ts`).
 *
 * ## `state` is opaque here on purpose
 *
 * The kernel cannot know a package's state shape at compile time, so it checks
 * what it can — that this is a record — and the package's own declared schema
 * checks the rest, exactly once, at the boundary. That is the same division
 * `keyValueReadOptions` makes for a window arriving as JSON from another
 * process: a flat bag on the wire, validated into meaning at one known place.
 */
export const PackageViewSpecSchema = z.object({
  kind: z.literal('package'),
  /**
   * Which package view to open.
   *
   * A kind nobody registers is **not** refused — this said it was, and main has
   * never checked. Keeping the tolerant behaviour is deliberate: the view opens,
   * stays idle because no package can be asked what it should fetch, and the
   * window draws `view.packageMissing` over it. That is what a package which was
   * installed yesterday and uninstalled today has to look like, and it is what
   * lets a persisted workspace containing one still be restored as a whole
   * (`bus/handlers/shared.ts`'s note on `autoFetch` returning undefined).
   */
  packageKind: z.string().min(1),
  connId: ConnIdSchema,
  state: z.record(z.string(), z.unknown()).optional(),
  title: viewTitle,
})

/** Input spec for view.open: no id, because main generates it */
export const ViewOpenSpecSchema = z.discriminatedUnion('kind', [
  TableViewSpecSchema,
  QueryViewSpecSchema,
  InspectorViewSpecSchema,
  TreeViewSpecSchema,
  VectorViewSpecSchema,
  ChatViewSpecSchema,
  PackageViewSpecSchema,
])
export type ViewOpenSpec = z.infer<typeof ViewOpenSpecSchema>

/* ---- Auto-refresh -------------------------------------------------- */

/**
 * Floor on an auto-refresh interval.
 *
 * A second is already short for something that crosses a socket and walks a
 * cursor; below it the tick can only ever land on a fetch that is still running,
 * so the interval would stop describing anything. Design record:
 * docs/design/2026-08-03-auto-refresh.md.
 */
export const MIN_AUTO_REFRESH_MS = 1_000
/** One hour. Past this the timer is indistinguishable from "off, and I'll press it myself". */
export const MAX_AUTO_REFRESH_MS = 3_600_000

/** What the interval menu offers: 1s 5s 10s 30s 1m 5m 10m 30m 1h. */
export const AUTO_REFRESH_PRESETS_MS = [
  1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000,
] as const

/**
 * `null` turns it off, an absent field leaves it alone — the same convention the
 * vector patch's `vectorName` and `scoreThreshold` use.
 *
 * It appears on exactly the four branches whose views can fetch. A TypeScript
 * caller asking a chat or a namespace tree to refresh itself is stopped by the
 * type; a JSON caller has the field **stripped** by the parse, because zod
 * objects drop unknown keys here as everywhere else in this file. Either way it
 * cannot reach a view with nowhere to put it — which is also why
 * `setAutoRefreshOn` in main ignores those kinds rather than trusting the schema
 * to have made them impossible.
 */
const autoRefreshMs = z.number().int().min(MIN_AUTO_REFRESH_MS).max(MAX_AUTO_REFRESH_MS).nullable().optional()

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
    autoRefreshMs,
    title: viewTitle,
  }),
  z.object({
    kind: z.literal('query'),
    text: z.string().optional(),
    autoRefreshMs,
    title: viewTitle,
  }),
  z.object({
    kind: z.literal('inspector'),
    ref: ValueRefSchema.optional(),
    title: viewTitle,
  }),
  z.object({
    kind: z.literal('tree'),
    expanded: z.array(z.string()).optional(),
    selected: z.string().nullable().optional(),
    title: viewTitle,
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
    autoRefreshMs,
    title: viewTitle,
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
    title: viewTitle,
  }),
  /**
   * A package view's patch: a shallow merge into its `state`, plus the title.
   *
   * **Merge, not replace.** Every built-in patch above is a per-field optional,
   * so `{kind:'table', offset: 40}` moves the page and leaves the filter alone.
   * A package patch has to mean the same thing or the two would behave
   * differently for no reason a caller could see — and an MCP client that had to
   * resend the whole state to change one field would race with the user doing
   * the same.
   *
   * `null` inside `state` is how a field is cleared, mirroring the `nullable()`
   * fields in the vector patch above.
   */
  z.object({
    kind: z.literal('package'),
    state: z.record(z.string(), z.unknown()).optional(),
    autoRefreshMs,
    title: viewTitle,
  }),
])
export type ViewPatch = z.infer<typeof ViewPatchSchema>

/**
 * The patch a Refresh sends to a collection browser.
 *
 * On a cursor-paged collection it carries `offset: 0`, and that is load-bearing
 * rather than cosmetic: `offset` is what makes main drop the stored continuation
 * token (`handlers/view.ts`, `invalidatesCursor`), so sending it is precisely
 * "forget where we were". A patch that changed nothing would re-run the scan with
 * the token the last page handed back — that is, refresh would silently page
 * forward.
 *
 * It lives in core rather than in the renderer because main's auto-refresh timer
 * has to send the very same patch, and "a refresh restarts a cursor scan" is a
 * rule that must not have two implementations.
 */
export function refreshPatch(ref: CollectionRef): ViewPatch {
  return collectionBrowseStyle(ref).offsetPaging ? { kind: 'table' } : { kind: 'table', offset: 0 }
}

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
  /**
   * Open it as the one provisional view — see `ViewBase.provisional`.
   *
   * Independent of `replace`, and resolved before it: a provisional open first
   * looks for the existing provisional view and takes *its* slot, wherever it
   * is, because "the tab I was skimming in" is a better target than "whatever
   * panel happens to be focused". With no provisional view around it falls back
   * to the ordinary rules, `replace` and `panelId` included.
   */
  provisional: z.boolean().optional(),
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

/**
 * Keep a provisional view — the counterpart to `view.open provisional`.
 *
 * Separate from `view.activate` because showing a view and keeping it are two
 * intents, and the commonest gesture (one click on a row) means only the first.
 * Separate from `view.update` because `ViewPatch` is discriminated on `kind`,
 * and `provisional` is the same fact for all six — it would have to be written
 * into every branch to say one thing.
 *
 * Idempotent, and not an error on a view that was never provisional: every
 * caller is a *user action* ("I am using this"), and the honest answer to
 * "keep it" for something already kept is yes.
 */
export const ViewPromoteInputSchema = z.object({
  viewId: ViewIdSchema,
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
  .refine((v) => v.viewId !== undefined || (v.connId !== undefined && v.text !== undefined), {
    message: 'Provide either viewId, or connId together with text',
  })

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

/* ------------------------------------------------------------------ */
/* The agent asking a question, and the person answering it            */
/* ------------------------------------------------------------------ */

/**
 * Ask the user a question and **wait** for the answer.
 *
 * The only command in this table that blocks on a person. That is safe here and
 * would not be for `chat.send`, and the difference is who is waiting: this one
 * suspends **the agent's own tool call**, while a blocking `chat.send` would
 * suspend a peek command for an entire turn — during which the agent calls back
 * into this same bus. The bus does not serialise across commands, so a suspended
 * `chat.ask` holds nothing up: the user can still run queries, drag panes and
 * open other conversations while it hangs.
 *
 * See `docs/design/2026-08-15-agent-asks-a-question.md` §2.3.
 */
export const ChatAskInputSchema = z.object({
  /**
   * Where to ask. **Required here**, though the `ask` tool lets a caller omit
   * it: opening a conversation mints an id, and a command cannot both mint and
   * use one in the same call. The tool opens first and passes the id along,
   * exactly as `send_chat` already does.
   */
  viewId: ViewIdSchema,
  /** One line. It is the largest text on the panel and the first thing read. */
  question: z.string().min(1).max(300),
  /** A short category chip, e.g. "Aggregation". Optional. */
  header: z.string().min(1).max(24).optional(),
  /**
   * Two to four answers.
   *
   * The floor is two because a one-option question is not a question. The
   * ceiling is four because past that a person stops choosing and starts
   * scanning — and because a decision needing five distinct answers usually
   * wants to be asked as two questions in sequence, each of which this tool can
   * ask once the first is answered.
   *
   * A free-text escape hatch is **not** declared here; the UI always adds one.
   * See `OTHER_OPTION_ID`.
   */
  options: z
    .array(
      z.object({
        optionId: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        description: z.string().max(400).optional(),
      }),
    )
    .min(2)
    .max(4),
  /** Let the user pick more than one. Default single-select. */
  multiSelect: z.boolean().optional(),
})

/**
 * Answer the question the agent is blocked on.
 *
 * **Refused for `source: 'agent'`**, unconditionally — the third place on this
 * bus where `source` decides an outcome, and the one with the shortest argument:
 * an agent answering its own question manufactures a decision that reads as a
 * person's and never was. `chat.respondPermission` is refused on related but
 * weaker grounds; see `2026-08-02-agent-source-and-permission-scope.md` §2.3bis.
 */
export const ChatAnswerInputSchema = z
  .object({
    viewId: ViewIdSchema,
    /** Same stale-answer guard as `chat.respondPermission`, and for the same race. */
    requestId: z.string().min(1).optional(),
    /**
     * Which options were chosen. Empty is allowed **only** alongside `other`:
     * that is the user saying none of them fit.
     */
    optionIds: z.array(z.string().min(1)).default([]),
    /** What the user typed into "Other". */
    other: z.string().min(1).max(2000).optional(),
  })
  .refine((value) => value.optionIds.length > 0 || value.other !== undefined, {
    message: 'chat.answer needs at least one option or an "other" text',
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
/* Reading the logs                                                    */
/* ------------------------------------------------------------------ */

/**
 * The diagnostic log, most recent entries last.
 *
 * ## Why this is a Command and not an IPC channel
 *
 * PLAN §10 turned down "send main's command log to the renderer" on the grounds
 * that it costs an IPC channel plus a `PeekBridge` member. That price is real,
 * and it is not paid here: `log.read` travels the Command Bus like everything
 * else, so the window reads it through the `invoke` it already has and preload
 * does not change by one line.
 *
 * ## Why adding to a table PLAN §6 calls closed is not a contradiction
 *
 * That sentence is about **packages** — "包不能往里加动词" — and its reasoning is
 * that every name in the table is kernel-general. These two are as well; they
 * sit beside `state.read`, `settings.read` and `mcp.read`, which are the same
 * kind of thing: a read-only question about the app itself.
 *
 * ## The consequence worth knowing
 *
 * Being a Command means an MCP client can call it. That is deliberate — an agent
 * that can read what it just did, and what the human just did, is the point of
 * both surfaces sharing one bus — and it is also why `CommandLog` skips `log.*`
 * when recording: a panel polling this every two seconds would otherwise fill
 * the audit with its own reads.
 */
export const LogReadInputSchema = z.object({
  /** How many records, counting back from the newest. */
  limit: z.number().int().min(1).max(2000).optional(),
  /** Drop anything less severe than this. */
  minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  /** Only this subsystem. */
  ns: z.string().min(1).optional(),
  /** Only records carrying this correlation key — a `chatId`, a `connId`, a `resultId`. */
  tag: z.string().min(1).optional(),
})

/**
 * The command audit, most recent entries last.
 *
 * `source` is the filter that makes this worth a tab of its own: the Command Bus
 * has recorded who asked for every command since M2 (`ui` / `mcp` / `agent` /
 * `system`), and until this existed the only place that distinction surfaced was
 * a label on failures in the error centre.
 */
export const LogReadCommandsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  source: z.enum(['ui', 'mcp', 'agent', 'system']).optional(),
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

/**
 * Which way round the window is painted.
 *
 * `system` is a *third* value rather than the absence of a choice, because the
 * absence already means something here: absent is `dark`, on the same principle
 * as every other member of the settings file — a user who never chose keeps
 * following the default. peek's default is dark because that is what it has
 * always been, and an upgrade is not the moment to hand somebody a white window
 * they did not ask for. See `design/2026-08-15-light-and-dark-theme.md` §3.4.
 */
export const UI_THEMES = ['dark', 'light', 'system'] as const
export type UiTheme = (typeof UI_THEMES)[number]

export const UI_THEME_DEFAULT: UiTheme = 'dark'

const UiThemeSchema = z.enum(UI_THEMES)

/**
 * What `system` resolved to — the answer everything downstream actually paints
 * with, and the reason `theme` alone is never enough on the wire.
 *
 * Resolved in main, once, and sent down rather than recomputed per consumer:
 * the window, the traffic lights and every package iframe have to agree, and
 * `prefers-color-scheme` is unreachable from main while `nativeTheme` is
 * unreachable from a frame. One answer, three consumers. §3.1.
 */
export type ResolvedTheme = 'dark' | 'light'

/**
 * The user's keyboard overrides: shortcut id → chord, or `null` to turn it off.
 *
 * Deliberately opaque here. The chord syntax and the set of shortcut ids belong
 * to the window (`renderer/keys/`), which is where every one of these chords is
 * resolved; main only persists the record and hands it back. Validating the
 * strings in core would put a second, necessarily lagging copy of the keyboard
 * model in the process that does not use it — and the window already has to
 * validate them anyway, because the file is hand-editable.
 *
 * The whole record is sent on every write, not a patch: it is small, and it is
 * the only shape in which "reset this one to its default" (the key disappears)
 * is expressible at all.
 */
const KeybindingsSchema = z.record(z.string(), z.string().nullable())

/* ================================================================== */
/* The chat panel's agent                                              */
/* ================================================================== */

/**
 * Which kind of backend answers in the chat panel.
 *
 * `acp` runs one of the agents peek ships with as a child process — the user
 * brings their existing Claude Code or Codex login and peek never sees a
 * credential. `endpoint` runs peek's own agent loop against an LLM the user
 * configured, which is the path for a self-hosted or company gateway.
 *
 * A conversation is fixed to the backend it was created on: the two keep history
 * in different places and neither can read the other's. Changing this setting
 * therefore decides what the *next* conversation uses, and never moves an
 * existing one. See `docs/design/2026-08-03-pluggable-agent-backends.md` §3.5.
 */
export const AGENT_BACKENDS = ['acp', 'endpoint'] as const
export type AgentBackend = (typeof AGENT_BACKENDS)[number]

/**
 * Which API shape peek should speak to a configured endpoint.
 *
 * Not inferred from the URL. A gateway can serve either shape from any path, and
 * guessing wrong produces a failure at the first token rather than at save time.
 */
export const AGENT_ENDPOINT_APIS = ['openai-completions', 'anthropic-messages'] as const
export type AgentEndpointApi = (typeof AGENT_ENDPOINT_APIS)[number]

const AgentBackendSchema = z.enum(AGENT_BACKENDS)

/**
 * The permission modes a user may set as their **default**: all of them.
 *
 * This was a strict subset until 2026-08-15, excluding `dontAsk` and
 * `bypassPermissions` on the grounds that the panel is where you say "for this,
 * I know what I am doing" and a settings file is not — a default is set once and
 * then forgotten, and applies to every conversation after it.
 *
 * The reasoning was sound and the conclusion was still wrong, because it read
 * "set once and forgotten" as the failure mode when for this user it is the
 * *feature*. Re-picking a mode on every new conversation was the single most
 * repeated manual step in the panel; refusing to persist the choice did not
 * prevent anyone from making it, it only made them make it again tomorrow.
 *
 * What replaced the exclusion is visibility, which is the same trade
 * `2026-08-14-agent-write-switch.md` §2.6 made for the write switch: **the
 * panel's dropdown marks a mode it inherited from settings**, so a conversation
 * that will not ask says so before it does anything. Forgetting is answered by
 * keeping the thing in sight, not by refusing to store it.
 *
 * That marker is not optional decoration — it is the half of this change that
 * makes the other half safe. See
 * `docs/design/2026-08-15-chat-panel-full-capability.md` §2.1.
 */
export const AGENT_DEFAULT_PERMISSION_MODES = CHAT_PERMISSION_MODES
export type AgentDefaultPermissionMode = ChatPermissionMode

/**
 * The endpoint backend's configuration, minus the API key.
 *
 * **The key is deliberately not here.** It goes to the OS keychain through
 * `SecretVault`, the same place connection passwords go, and never into
 * `settings.json` — a file users hand-edit, paste into issues and sync between
 * machines. `apiKeySet` is how a form knows whether one is stored without the
 * value ever crossing back.
 */
export const AgentEndpointSettingsSchema = z.object({
  baseUrl: z.string().url().max(2048),
  model: z.string().min(1).max(200),
  api: z.enum(AGENT_ENDPOINT_APIS),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  contextWindow: z.number().int().min(1_000).max(10_000_000).optional(),
})

export type AgentEndpointSettings = z.infer<typeof AgentEndpointSettingsSchema>

/**
 * Transports peek will describe an MCP server over.
 *
 * `sse` is deliberately absent even though ACP has it: support differs between
 * the two agents peek ships, and a transport that works with one of them is a
 * setting that fails depending on a choice made on another screen. See
 * `docs/design/2026-08-15-chat-panel-full-capability.md` §4.3.
 */
export const AGENT_MCP_TRANSPORTS = ['http', 'stdio'] as const
export type AgentMcpTransport = (typeof AGENT_MCP_TRANSPORTS)[number]

/**
 * One MCP server the user added to the chat panel.
 *
 * ## Why the name is this strict
 *
 * It becomes a tool prefix: every tool the server offers arrives at the agent as
 * `mcp__<name>__<tool>`. A space or a double underscore in there does not produce
 * a badly-named tool, it produces a name the agent cannot address — and the
 * failure surfaces as "the model ignored your server", which is nobody's idea of
 * a validation error.
 *
 * ## Why the credential is one header and not a list
 *
 * A general `headers` array was the first design and bought very little: every
 * value in it is a secret, so each one needs sealing, a "stored" indicator and a
 * never-echo rule of its own, and the form grows a nested editor to hold them.
 * Practically every HTTP MCP server authenticates with a single header —
 * `Authorization: Bearer …`, or an `X-API-Key` — so peek takes the header's name
 * and one sealed value, and the user writes the scheme into the value themselves.
 */
export const AgentMcpServerSchema = z.object({
  /** Tool prefix and display name. Lowercase, and unique across the list. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  transport: z.enum(AGENT_MCP_TRANSPORTS),
  /** `http`: the server's URL. `stdio`: an absolute path to its executable. */
  target: z.string().min(1).max(4096),
  /** `stdio` only. */
  args: z.array(z.string().max(4096)).max(64).optional(),
  /** `http` only. Defaults to `Authorization` when a value is stored. */
  authHeader: z.string().max(128).optional(),
  /**
   * `http` only. Sealed by the OS keychain on arrival and never read back — the
   * same treatment `endpointApiKey` gets, for the same reason. An empty string
   * clears it.
   */
  authValue: z.string().max(4096).optional(),
  /**
   * Off keeps the row and stops sending it. Deleting a server the user is only
   * debugging would make them retype a URL to test a hunch.
   */
  enabled: z.boolean(),
})

export type AgentMcpServerInput = z.infer<typeof AgentMcpServerSchema>

/** One row of the MCP list, as the settings form needs to describe it. */
export interface AgentMcpServerInfo {
  name: string
  transport: AgentMcpTransport
  target: string
  args?: string[]
  authHeader?: string
  /** Whether a credential is stored. The value itself never crosses back. */
  authValueSet: boolean
  enabled: boolean
}

export const AgentSettingsSchema = z.object({
  backend: AgentBackendSchema.optional(),
  /** The mode every new conversation starts in. See `AGENT_DEFAULT_PERMISSION_MODES`. */
  permissionMode: z.enum(AGENT_DEFAULT_PERMISSION_MODES).optional(),
  /** Which ACP agent, by profile id. Unknown ids fall back to the default. */
  acpProfile: z.string().min(1).max(64).optional(),
  /** Overrides the selected ACP agent's own executable. */
  acpExecutablePath: z.string().max(4096).optional(),
  /** Let the ACP agent use its own file and command tools. See the design doc §2.5. */
  acpFullTools: z.boolean().optional(),
  /** Where a new conversation works. An empty string restores peek's own directory. */
  agentWorkdir: z.string().max(4096).optional(),
  /**
   * The user's own MCP servers, sent whole rather than as a patch.
   *
   * Same reasoning as `keybindings`: removing a row has to be expressible, and a
   * member-wise merge can only ever add. The form always holds the full list, so
   * the file cannot lose a row the sender still had.
   */
  mcpServers: z.array(AgentMcpServerSchema).max(32).optional(),
  endpoint: AgentEndpointSettingsSchema.optional(),
  /**
   * Written to the OS keychain, never to `settings.json`, and never read back.
   * An empty string clears the stored key.
   */
  endpointApiKey: z.string().max(4096).optional(),
})

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

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

/**
 * Whether peek may speak outside its own window, and whether it does so on its
 * own initiative.
 *
 * Two switches rather than one, because they answer different questions. `system`
 * is about the channel — "may peek put things in my notification centre at all" —
 * and covers the `notify` tool as much as anything peek decides itself.
 * `agentTurnEnd` is about the initiative: peek raising a notification nobody
 * asked for, when a turn ends or stalls on a permission prompt.
 *
 * A user who wants to be told only what an agent chose to tell them turns the
 * second off and keeps the first. There is no combination that silences the tool
 * while keeping the automatic ones, because a user who does not want to be
 * interrupted does not want it from the tool either.
 *
 * See `docs/design/2026-08-15-notifications.md` §2.5.
 */
export const NotificationSettingsSchema = z.object({
  system: z.boolean().optional(),
  agentTurnEnd: z.boolean().optional(),
})

export interface NotificationSettings {
  /** May peek raise system notifications at all. */
  system: boolean
  /** Announce a finished turn, or one blocked on a permission prompt, unasked. */
  agentTurnEnd: boolean
}

/**
 * Both on.
 *
 * Materialized here rather than left absent-means-default in the reader, because
 * unlike `mcpPort` these are booleans: "absent" and "false" are one keystroke
 * apart in a hand-edited file, and a default that is computed in three places is
 * a default that will disagree with itself.
 */
export const NOTIFICATION_DEFAULTS: NotificationSettings = Object.freeze({
  system: true,
  agentTurnEnd: true,
})

/**
 * What the user has stored, over the defaults.
 *
 * One function so that "unset means on" is stated once. Both readers need it —
 * the settings handler answering the form, and the notifier deciding whether to
 * raise a banner — and two spellings of a default is how the dialog ends up
 * disagreeing with what the app actually does.
 */
export function resolveNotifications(
  stored: Partial<NotificationSettings> | undefined,
): NotificationSettings {
  return { ...NOTIFICATION_DEFAULTS, ...stored }
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
    /** Dark, light, or follow the OS. See `UI_THEMES`. */
    theme: UiThemeSchema.optional(),
    /** Which agent answers in the chat panel, and how to reach it. */
    agent: AgentSettingsSchema.optional(),
    /** The user's keyboard overrides, whole. An empty record means "all defaults". */
    keybindings: KeybindingsSchema.optional(),
    /**
     * How much is written to `peek.log`.
     *
     * Here rather than in a settings dialog because of *when* it is changed: the
     * log panel's picker sends this mid-session, after the thing worth debugging
     * has already happened once. It takes effect immediately and is persisted,
     * so the next launch starts where the user left it.
     */
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    /** Whether peek may notify outside its window, and whether it does so unasked. */
    notifications: NotificationSettingsSchema.optional(),
  })
  .refine(
    (value) =>
      value.uiZoom !== undefined ||
      value.theme !== undefined ||
      value.keybindings !== undefined ||
      value.logLevel !== undefined ||
      (value.agent !== undefined && Object.keys(value.agent).length > 0) ||
      (value.notifications !== undefined && Object.keys(value.notifications).length > 0) ||
      (value.execution !== undefined && Object.keys(value.execution).length > 0),
    { message: 'settings.write needs at least one setting to change' },
  )

/* ------------------------------------------------------------------ */
/* The installed packages                                              */
/* ------------------------------------------------------------------ */

/**
 * The three verbs that manage `~/.peek/packages/`.
 *
 * **Kernel verbs, and they belong to no database** — the same conclusion
 * plugin-architecture §2.3bis(c) reached about the other thirty-two names in
 * this list. A package contributes tools, view kinds and drivers; it does not
 * contribute the ability to install a package, because the thing being installed
 * has by definition not been read yet.
 *
 * Design 2026-08-07 §2.4 fixes the set at four: read, install, uninstall,
 * restore. There is no `packages.upgrade` — an upgrade is an install over an id
 * that is already there, and a second verb for it would be a second copy of the
 * same validate-then-replace path with one extra opinion in it (which of the two
 * versions wins). `PackageListing.upgradeVersion` is what tells a caller that
 * running `packages.install` on the bundled copy would move it forward.
 */
export const PackagesReadInputSchema = z.object({})

/**
 * Install from a **local directory**, and only from one.
 *
 * §1.5 draws "install from a URL" outside this design on purpose: fetching
 * arbitrary executable code from the network is a distribution problem, and
 * peek's answer to it — decision 6, no signature and no hash check — is only
 * defensible while the bytes come from somewhere the user already chose. So the
 * parameter is a path, and the download, if there is ever to be one, is
 * somebody else's step that ends in a directory.
 *
 * ## Two ways to name the directory, one install
 *
 * The second member is what makes §2.5 rule 2's "upgrade" button possible from a
 * window. Rule 2 says peek never takes a shipped upgrade on its own — the user
 * clicks — and §2.4 says there is no `packages.upgrade`, because an upgrade *is*
 * an install over an id that is already there. Put together, the settings panel
 * has to run this command against a directory inside the app bundle, and
 * `PackageListing` deliberately carries no filesystem path: the window is not
 * given home-directory or bundle paths for values it does not need.
 *
 * So the caller names the directory the only way it honestly can — by the id of
 * the package this build ships — and main resolves it. Everything after that is
 * the same code: the same full manifest check, the same staged copy, the same
 * replace, the same receipt. What differs is who spells the path, not what an
 * install means.
 */
export const PackagesInstallInputSchema = z.union([
  z.object({
    /**
     * Absolute path of the package directory — the one holding
     * `peek-package.json`, not its parent.
     *
     * Relative is refused rather than resolved: main's cwd is wherever the app
     * was launched from, which for a double-clicked bundle is `/`. A path that
     * resolved against it would mean something different depending on how peek
     * was started, and the failure would be "no manifest there" rather than
     * "that is not what you meant".
     */
    dir: z.string().min(1),
  }),
  z.object({
    /**
     * Install this build's own copy of a package, by id.
     *
     * The id of the *shipped* directory, which is `<bundled root>/<id>` — not a
     * promise that anything is installed under it today. A build that ships no
     * such package fails like any other bad path, with the id in the message.
     */
    bundledId: z.string().regex(PACKAGE_ID_PATTERN, 'must be lowercase letters, digits and hyphens'),
  }),
])

export const PackagesUninstallInputSchema = z.object({
  /** The directory name under `~/.peek/packages/`, which is also the manifest's `id`. */
  id: z.string().regex(PACKAGE_ID_PATTERN, 'must be lowercase letters, digits and hyphens'),
})

/**
 * Undo every uninstall of a package this build ships — decision 1's safety net.
 *
 * **No parameters, and specifically no id.** The thing being restored is not a
 * directory the caller chose but whatever sits in the app bundle, and the caller
 * has no business knowing that path. A per-id variant was considered and is
 * worse than useless: an id that has been uninstalled is absent from
 * `packages.read`, so the caller would have to name a package it cannot see.
 *
 * Why it is a fourth verb rather than a flag on `packages.install`: the input is
 * not a path, it clears tombstones (which install must never do — installing
 * your own PostgreSQL should not silently revoke "I do not want the shipped
 * one"), and it is plural, while an install result names one id and one version.
 * §2.4 records the reasoning; what it reuses is `layOutBundledPackages`, the
 * same call a first start makes, not a second copy of it.
 */
export const PackagesRestoreInputSchema = z.object({})

/* ------------------------------------------------------------------ */
/* The application talking to the person                               */
/* ------------------------------------------------------------------ */

/**
 * Tell the user something, in a way that reaches them when peek is not the
 * window they are looking at.
 *
 * ## Why this is a command at all
 *
 * Every other verb in this table changes something peek owns — a connection, a
 * view, the layout, a conversation, a preference. This one changes **the user's
 * attention**, which peek does not own and cannot roll back. That asymmetry is
 * the argument for putting it here rather than handing the notifier straight to
 * whoever wants it: an action with no undo should at least leave a record, and
 * `bus/command-log.ts` is the record every command already gets for free.
 *
 * It writes nothing into the Workspace, so it bumps no `rev` and broadcasts no
 * patch. That is not novel — `state.read`, `conn.book.list` and `settings.read`
 * are all in this table without touching Workspace state. The bus carries
 * intent, not only mutation.
 *
 * See `docs/design/2026-08-15-notifications.md`.
 */
export const AppNotifyInputSchema = z.object({
  /**
   * One line. It becomes the notification's title, so it has to survive being
   * read alone in a banner with everything else cut off.
   */
  message: z.string().min(1).max(200),
  /** The body. Optional because a good `message` often needs no second line. */
  detail: z.string().max(2000).optional(),
  /** Defaults to `info`; `warn` and `error` also colour the in-app toast. */
  level: z.enum(['info', 'warn', 'error']).optional(),
  /**
   * A view to bring forward when the user clicks the notification. Left out, the
   * click just brings peek back to the front — which is the honest default,
   * because most notifications are about something that is already on screen.
   */
  focusViewId: ViewIdSchema.optional(),
})

/**
 * Compile-time tie between this schema's `level` and the notification level the
 * rest of peek speaks. A type-only import, so the module cycle
 * (`ipc.ts` imports this file) is erased before it can exist at runtime.
 */
type _AssertNotifyLevel = z.infer<typeof AppNotifyInputSchema>['level'] extends
  import('./ipc').NotifyLevel | undefined
  ? true
  : never
const _assertNotifyLevel: _AssertNotifyLevel = true
void _assertNotifyLevel

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
  'view.promote': ViewPromoteInputSchema,
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
  'chat.ask': ChatAskInputSchema,
  'chat.answer': ChatAnswerInputSchema,
  'state.read': StateReadInputSchema,
  'log.read': LogReadInputSchema,
  'log.readCommands': LogReadCommandsInputSchema,
  'conn.book.list': ConnBookListInputSchema,
  'conn.book.forget': ConnBookForgetInputSchema,
  'mcp.read': McpReadInputSchema,
  'mcp.configure': McpConfigureInputSchema,
  'settings.read': SettingsReadInputSchema,
  'settings.write': SettingsWriteInputSchema,
  'packages.read': PackagesReadInputSchema,
  'packages.install': PackagesInstallInputSchema,
  'packages.uninstall': PackagesUninstallInputSchema,
  'packages.restore': PackagesRestoreInputSchema,
  'app.notify': AppNotifyInputSchema,
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

export interface ViewPromoteResult {
  viewId: ViewId
  /** True when this call is what cleared the flag; false when it was already kept. */
  promoted: boolean
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
 * What the user said — or that they said nothing.
 *
 * `answered: false` is a first-class outcome, not an error, on the same grounds
 * `app.notify` reports rather than throws: an errored tool call invites a retry,
 * and re-asking a question nobody was there to answer is precisely the wrong
 * response. The agent is meant to read this and *decide* — carry on with a
 * stated assumption, or stop and say what it needs.
 */
export interface ChatAskResult extends ChatResultBase {
  requestId: string
  answered: boolean
  /** The options chosen, echoed with their labels so the agent need not re-map ids. */
  selected: { optionId: string; label: string }[]
  /** What the user typed instead of, or alongside, choosing. */
  other?: string
  /** Why there is no answer. Absent when `answered` is true. */
  reason?: 'timeout' | 'cancelled'
}

export interface ChatAnswerResult extends ChatResultBase {
  requestId: string
  /** False when the question had already gone away — a click on a stale prompt. */
  answered: boolean
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

/**
 * One entry of the Command log.
 *
 * Lives in core rather than beside `CommandLog` in main because it now crosses a
 * process boundary: `log.readCommands` hands these to the window, and the panel
 * renders them. Everything in it was already core vocabulary
 * (`CommandName` / `CommandSource` / `PeekErrorCode`), so this is the shape
 * arriving where its members already were.
 */
export interface CommandLogEntry {
  /** Per-process counter, starting at 1. */
  seq: number
  commandId: string
  ts: number
  source: CommandSource
  name: CommandName
  /** Redacted input — a `conn.open` password never reaches this log or the disk. */
  input: unknown
  ok: boolean
  /** The rev after the change landed. */
  rev: number
  elapsedMs: number
  errorCode?: PeekErrorCode
  errorMessage?: string
}

export interface LogReadResult {
  records: LogRecord[]
  /**
   * The level records are currently being captured at.
   *
   * Returned with every read so the panel's level picker cannot show something
   * different from what main is doing — the alternative is a second round trip
   * whose answer can already be stale when it arrives.
   */
  level: LogLevel
  /** Absolute path of `peek.log`, so the panel can tell the user where to find it. */
  path: string
  /**
   * `true` when the ring has dropped records this session.
   *
   * Worth saying out loud in the UI: a panel that silently shows the last 2000
   * of 50000 records looks exactly like one showing all 2000 there ever were.
   */
  truncated: boolean
}

export interface LogReadCommandsResult {
  entries: CommandLogEntry[]
  /** Absolute path of `commands.jsonl`. */
  path: string
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
  /**
   * Which server and account this entry names — the string, not the hash `id`.
   *
   * Sent rather than left to be recomputed because the fields that make it up are
   * the driver package's declaration (`DriverManifest.identity`) and the joining
   * is the kernel's, so a window pairing a saved entry with a live connection has
   * no way to derive one that is guaranteed to agree. It carries no password:
   * `connectionIdentity` strips a URL's credentials before joining.
   */
  identity: string
  /**
   * What to show in a list.
   *
   * Read from the file, not derived on the way out: naming a connection is the
   * owning package's code and a package runs in its own host process, while this
   * list is answered on the launch path with no host started. So the pair below
   * is computed once, when the connection opens, and stored — design 2026-08-07
   * §2.3(b-2), and `StoredDisplay` in `config/connection-book.ts` has the long
   * version.
   *
   * An entry saved before that, or one whose naming did not come back, falls back
   * to the user's own `config.label` and finally to the driver id. It is named
   * properly the next time it connects.
   */
  label: string
  /**
   * The long form, for a tooltip — the same string a live connection carries in
   * `ConnectionState.detail`, stored alongside `label` and empty for the same
   * reasons it can be a fallback.
   */
  detail: string
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
  /** What the user chose; `UI_THEME_DEFAULT` when they never did. */
  theme: UiTheme
  /**
   * What that choice currently means. Equal to `theme` unless it is `system`,
   * in which case this is what the OS says right now — so a reader that only
   * wants to paint never has to know `system` exists.
   */
  resolvedTheme: ResolvedTheme
  /** Which agent the chat panel uses, and what it can be switched to. */
  agent: AgentSettingsReadResult
  /**
   * Only the shortcuts the user changed. Absent entirely when they changed
   * none, which is the state the window starts in and the one it returns to
   * when everything is reset.
   */
  keybindings?: Record<string, string | null>
  /** What is being captured into `peek.log` right now. */
  logLevel: LogLevel
  /** Both switches, resolved — never absent, so no reader has to know the defaults. */
  notifications: NotificationSettings
}

/** One ACP agent this build can run, as the settings form needs to describe it. */
export interface AgentProfileInfo {
  id: string
  displayName: string
  /**
   * Whether peek has actually verified this agent's sandbox holds, only asked
   * for it, or is not asking at all.
   *
   * `unverified` is shown on screen and blocks the automatic permission mode —
   * an agent peek cannot vouch for must not also be unwatched. `relaxed` means
   * the user turned the restrictions off; it is shown and blocks nothing, since
   * the person it would be protecting is the one who decided.
   *
   * **Resolved against the current settings, not a property of the agent.** The
   * same agent reports a different tier once the switch is on, which is the
   * whole point of sending it.
   */
  sandbox: 'enforced' | 'unverified' | 'relaxed'
  /**
   * The tier this agent has when nothing is switched off — i.e. whether peek
   * ever had a probe for it.
   *
   * Sent because `relaxed` swallows that fact and the two are not the same
   * sentence. "You turned the sandbox off" and "peek never verified this agent's
   * sandbox in the first place" are both true of a Codex session with the switch
   * on, and a panel that could only say the first would be quietly dropping the
   * one peek was already admitting to.
   */
  baseSandbox: 'enforced' | 'unverified'
  /** False when the agent's package is not installed in this build. */
  available: boolean
}

export interface AgentSettingsReadResult {
  backend: AgentBackend
  /** What a new conversation starts in; `default` (ask every time) unless changed. */
  permissionMode: AgentDefaultPermissionMode
  acpProfile: string
  /** Every agent this build knows about, for the picker. */
  profiles: AgentProfileInfo[]
  acpExecutablePath?: string
  /** Whether the ACP agent may use its own file and command tools. */
  acpFullTools: boolean
  /**
   * Where a new conversation works, when the user chose a directory.
   *
   * Absent means peek's own chat directory, and the form says which one that is
   * rather than showing an empty field — "nothing here" and "somewhere you
   * cannot see from this screen" look identical otherwise.
   */
  agentWorkdir?: string
  /** peek's own chat directory, so the form can name the default it falls back to. */
  agentWorkdirDefault: string
  /** The user's own MCP servers, credentials replaced by whether one is stored. */
  mcpServers: AgentMcpServerInfo[]
  endpoint?: AgentEndpointSettings
  /**
   * Whether an API key is in the keychain. The key itself never comes back —
   * this is what lets a form show "configured" without ever holding the secret.
   */
  endpointApiKeySet: boolean
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
  /** The choice as it now stands, and what it currently resolves to. */
  theme: UiTheme
  resolvedTheme: ResolvedTheme
  /**
   * The agent settings as they now stand, on the same principle: an unknown
   * profile id is replaced by the default rather than rejected, so this is the
   * only honest answer to "which agent will the next conversation use".
   */
  agent: AgentSettingsReadResult
  /** The overrides as they now stand in the file. */
  keybindings?: Record<string, string | null>
  /** The level now in force — which, unlike the others here, took effect without a restart. */
  logLevel: LogLevel
  /** Both switches as they now stand; live from the next notice, nothing to restart. */
  notifications: NotificationSettings
}

/**
 * One installed package, as everything outside main sees it.
 *
 * A per-package row, unlike `InstalledPackages`, which is three flat lists. The
 * two shapes answer different questions and neither is derivable from the other
 * without a loss: the flat lists are read by everything that asks "which drivers
 * exist", and this is read by the one surface that asks "what is installed, and
 * where did it come from" — the settings panel, and whoever is about to
 * uninstall something.
 *
 * No filesystem path. The directory is `<configDir>/packages/<id>` by
 * construction and the id is here; sending the absolute path would put a
 * home-directory path in the window for a value it can rebuild, which is the
 * line `packages/locations.ts` draws.
 */
export interface PackageListing {
  /** Directory name, manifest `id`, and the host of its `peek-package://` URLs — one string. */
  id: string
  version: string
  /**
   * Whether **this build ships a package under this id**, which is the question
   * both consumers actually ask.
   *
   * It is deliberately not "who put this copy here", because peek cannot answer
   * that: §2.5 rule 2 keeps a user's newer install under a bundled id, and the
   * two are the same directory afterwards. What this field decides is whether an
   * uninstall leaves a tombstone (`bundled` does, or the next launch lays the
   * package straight back out) and whether "restore bundled packages" would
   * bring it back.
   */
  source: 'bundled' | 'user'
  /**
   * The version this build ships, when it is newer than the one installed.
   *
   * Absent for a `user` package (peek ships nothing to compare against) and for a
   * bundled one that is already current. §2.5 rule 2 is why it is reported rather
   * than taken: the installed copy may be the user's own, and this build merely
   * happens to outrank it.
   */
  upgradeVersion?: string
  /** The databases this package provides, in manifest order. */
  driverIds: DriverId[]
  /** The view kinds it declares (data half — the functions live in its `contrib.mjs`). */
  viewKinds: string[]
  /** The MCP tool names it declares. */
  toolNames: string[]
}

export interface PackagesReadResult {
  /** Sorted by id, which is the order the loader scans in. */
  packages: PackageListing[]
}

export interface PackagesInstallResult {
  /** The id read out of the installed manifest — not derived from the source directory's name. */
  id: string
  version: string
  /** True when something was already installed under this id and has been replaced. */
  replaced: boolean
  /** The whole list afterwards, so a caller that just changed it need not re-read it. */
  packages: PackageListing[]
}

export interface PackagesUninstallResult {
  id: string
  /** Connections that were closed because their driver went away with the package. */
  closedConnIds: ConnId[]
  /** Views that closed with those connections. */
  closedViewIds: ViewId[]
  /** True when the id was one this build ships, so a tombstone was written (§2.5 rule 3). */
  tombstoned: boolean
  packages: PackageListing[]
}

export interface PackagesRestoreResult {
  /**
   * The ids that were copied back out of the app bundle, in the order the
   * lay-out reports them.
   *
   * Empty is the ordinary answer and not a failure: it means nothing this build
   * ships was missing. The caller distinguishes "restored PostgreSQL" from
   * "there was nothing to restore" by reading the length, which is why the ids
   * are here rather than a count — a settings panel that has just been clicked
   * owes the user the names.
   */
  restored: string[]
  /**
   * Bundled ids whose copy failed, with whatever the lay-out had to say.
   *
   * Reported rather than thrown, on the same grounds as the loader's per-package
   * refusals (§4.2 item 10): one unreadable directory in the app bundle must not
   * cost the four packages that copied fine.
   *
   * `detail` is nullable because the report it is copied from types it that way
   * — a status carries English "whenever a human should be told", and restore
   * has no better information than the step that did the work. A caller shows
   * the id alone rather than a sentence peek did not observe.
   */
  failed: { id: string; detail: string | null }[]
  packages: PackageListing[]
}

/**
 * Where the message actually went.
 *
 * Both members are reported rather than assumed, because both are decided after
 * the caller has spoken: `system` turns on whether the window was in the
 * background *at that moment* and whether the user allows system notifications,
 * `toast` on whether the caller asked to be silent while peek is in front.
 *
 * A caller that gets `{ system: false, toast: true }` has not failed — it has
 * been told the user is looking at peek right now. That distinction is why this
 * command reports instead of erroring when notifications are switched off: a
 * tool call that fails invites a model to retry, and retrying is the one thing
 * an unwanted notification must not do.
 */
export interface AppNotifyResult {
  /** A system notification was raised (the user was elsewhere, and allows them). */
  system: boolean
  /** An in-app toast was pushed. */
  toast: boolean
}

export interface CommandResultMap {
  'conn.open': ConnOpenResult
  'conn.close': ConnCloseResult
  'view.open': ViewOpenResult
  'view.update': ViewUpdateResult
  'view.close': ViewCloseResult
  'view.activate': ViewActivateResult
  'view.promote': ViewPromoteResult
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
  'chat.ask': ChatAskResult
  'chat.answer': ChatAnswerResult
  'state.read': StateReadResult
  'log.read': LogReadResult
  'log.readCommands': LogReadCommandsResult
  'conn.book.list': ConnBookListResult
  'conn.book.forget': ConnBookForgetResult
  'mcp.read': McpReadResult
  'mcp.configure': McpConfigureResult
  'settings.read': SettingsReadResult
  'settings.write': SettingsWriteResult
  'packages.read': PackagesReadResult
  'packages.install': PackagesInstallResult
  'packages.uninstall': PackagesUninstallResult
  'packages.restore': PackagesRestoreResult
  'app.notify': AppNotifyResult
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
  { ok: true; input: CommandInput<K> } | { ok: false; error: PeekError }

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
    error: peekErrorMsg(
      'BAD_REQUEST',
      'error.command.badInput',
      { name },
      {
        detail: zodIssueLines(result.error).join('\n'),
      },
    ),
  }
}

/**
 * Convert one command's input schema to JSON Schema, so an MCP tool can reuse it
 * directly as its `inputSchema`. That makes the first half of "a new MCP tool =
 * declare an inputSchema + map it onto some commands" cost essentially nothing.
 */
export const commandInputJsonSchema = (name: CommandName): unknown =>
  z.toJSONSchema(commandSchemas[name], { io: 'input', unrepresentable: 'any' })
