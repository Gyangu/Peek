/**
 * Workspace summary rendering.
 *
 * read_workspace exists so the AI can "see" the current UI: where each panel sits, which views
 * are stacked in it as tabs and which one of them is on screen, which database each is connected
 * to, which table or query it shows, how many rows it has and whether it is still loading. The
 * summary must stay compact — **never inline result set data**, only its metadata (ResultMeta).
 *
 * Since a panel became a stack of tabs, every rendering here distinguishes *mounted* from
 * *visible*. Reporting only the active tab would be compact and wrong: the background tabs are
 * open, hold connections and result sets, and are addressable by id, so a caller told nothing
 * about them concludes they were closed.
 */

import {
  collectPanels,
  hasUsableRows,
  type ConnectionSummary,
  type LayoutNode,
  type PanelId,
  type ResultMeta,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'

/* ================================================================== */
/* 1. Summary data structures                                           */
/* ================================================================== */

export interface ConnBrief {
  connId: string
  label: string
  driverId: string
  status: string
  capabilities: string[]
  /** Redacted connection target (host/db, or a file path). */
  target: string
  serverVersion?: string
  error?: string
}

export interface ResultBrief {
  resultId: string
  status: ResultMeta['status']
  rows: number
  /**
   * Whether the `rows` loaded so far can be trusted. **Only `error` makes this false** —
   * paused and cancelled both mean "we did not fetch everything, but everything fetched is
   * real data". Reporting the status alone is not enough: when an AI meets a status value it
   * has never seen, the cheapest guess is to treat it as a failure, so this conclusion is
   * stated outright rather than left for the reader to infer.
   */
  rowsUsable: boolean
  elapsedMs?: number
  truncated?: boolean
  /** Re-running the query resumes fetching (always true when status === 'paused'). */
  resumable?: boolean
  /** Human-readable reason, present when status === 'paused'. */
  pausedReason?: string
  columns?: string[]
  summary?: string
  error?: string
}

export interface ViewBrief {
  viewId: string
  kind: ViewSummary['kind']
  title: string
  /** One line: what this view is currently looking at. */
  describe: string
  status: ViewSummary['status']
  connId: string
  connLabel: string
  /** The panel holding this view; null means it is open but mounted nowhere. */
  panelId: string | null
  /**
   * Whether a human can actually see this view right now — i.e. it is its panel's
   * active tab.
   *
   * Reported explicitly because with tabs "mounted in a panel" stopped meaning "on
   * screen". A reader that keeps equating the two will confidently describe a table
   * that is sitting behind five other tabs, and the AI is the reader most likely to
   * do it, because that equivalence held for every earlier version of this brief.
   */
  visible: boolean
  result?: ResultBrief
  error?: string
}

export interface PanelBrief {
  panelId: string
  /** Position within the layout tree, e.g. 'root' or 'root.0.1'. */
  path: string
  focused: boolean
  /**
   * The panel's tabs, left to right. **The order is the tab-bar order** (P6) and is
   * reported exactly as stored — never sorted. Empty for an empty panel.
   */
  views: ViewBrief[]
  /** The one tab on screen; null exactly when `views` is empty (P1). */
  activeViewId: string | null
}

export interface WorkspaceBrief {
  rev: number
  focusedPanel: string | null
  panels: PanelBrief[]
  connections: ConnBrief[]
  /** Metadata for active/recent result sets (never the data itself). */
  results: ResultBrief[]
  /**
   * Views that exist but sit in no panel.
   *
   * `unplaced: 'keep'` on layout.setLayout produces them, and nothing else in this
   * brief mentions them: they are in no panel, so `panels` cannot show them, and a
   * reader would conclude they had been closed. They are still open, still holding
   * a connection and a result set, and `move_view` / `set_layout` can bring them
   * back — all of which is unusable information if it is invisible.
   */
  unplacedViews: ViewBrief[]
  /** The raw layout tree (with each split's dir/ratio/id, which layout.setRatio needs). */
  layout: LayoutNode
}

export type BriefSection = 'layout' | 'views' | 'connections' | 'results'

/* ================================================================== */
/* 2. Building                                                          */
/* ================================================================== */

/**
 * Readable description of a connection target. The config has already been through
 * redactConnectionConfig, so this only assembles the pieces.
 */
export function connTarget(cfg: ConnectionSummary['config']): string {
  switch (cfg.driverId) {
    case 'postgres':
    case 'mysql':
      if (cfg.url) return cfg.url
      return `${cfg.host ?? 'localhost'}:${cfg.port ?? (cfg.driverId === 'postgres' ? 5432 : 3306)}/${cfg.database ?? ''}`
    case 'sqlite':
      return cfg.file
    case 'redis':
      return cfg.url ?? `${cfg.host ?? 'localhost'}:${cfg.port ?? 6379}/${cfg.db ?? 0}`
    case 'qdrant':
      return cfg.url
  }
}

export function briefConnection(c: ConnectionSummary): ConnBrief {
  return {
    connId: c.id,
    label: c.label,
    driverId: c.driverId,
    status: c.status,
    capabilities: [...c.capabilities],
    target: connTarget(c.config),
    ...(c.serverInfo === undefined
      ? {}
      : { serverVersion: [c.serverInfo.flavor, c.serverInfo.version].filter(Boolean).join(' ') }),
    ...(c.error === undefined ? {} : { error: `${c.error.code}: ${c.error.message}` }),
  }
}

export function briefResult(r: ResultMeta): ResultBrief {
  return {
    resultId: r.id,
    status: r.status,
    rows: r.rows,
    rowsUsable: hasUsableRows(r.status),
    ...(r.elapsedMs === undefined ? {} : { elapsedMs: r.elapsedMs }),
    ...(r.truncated === undefined ? {} : { truncated: r.truncated }),
    ...(r.resumable === undefined ? {} : { resumable: r.resumable }),
    ...(r.pausedReason === undefined ? {} : { pausedReason: r.pausedReason }),
    ...(r.schema === undefined ? {} : { columns: r.schema.map((c) => c.name) }),
    ...(r.summary === undefined ? {} : { summary: r.summary }),
    ...(r.error === undefined ? {} : { error: `${r.error.code}: ${r.error.message}` }),
  }
}

/** Depth-first walk assigning each panel its path in the tree; 'root' means the root itself is a panel. */
function panelPaths(node: LayoutNode, path: string, out: Map<PanelId, string>): void {
  if (node.type === 'panel') {
    out.set(node.id, path)
    return
  }
  node.children.forEach((child, i) => {
    panelPaths(child, path === 'root' ? `root.${i}` : `${path}.${i}`, out)
  })
}

export function buildWorkspaceBrief(
  snap: WorkspaceSnapshot,
  include?: readonly BriefSection[],
): WorkspaceBrief {
  const want = (s: BriefSection): boolean => include === undefined || include.includes(s)

  const connById = new Map(snap.connections.map((c) => [String(c.id), c]))
  const resultById = new Map(snap.results.map((r) => [String(r.id), r]))
  const viewById = new Map(snap.views.map((v) => [String(v.id), v]))

  const paths = new Map<PanelId, string>()
  panelPaths(snap.layout, 'root', paths)

  const panels: PanelBrief[] = want('layout')
    ? collectPanels(snap.layout).map((p) => ({
        panelId: String(p.id),
        path: paths.get(p.id) ?? 'root',
        focused: snap.focusedPanel === p.id,
        // Mapped over `viewIds` rather than filtered out of `snap.views`, because the
        // tab order is the panel's order and rebuilding it from the view table would
        // silently substitute insertion order for it.
        views: p.viewIds.flatMap((viewId) => {
          const view = viewById.get(String(viewId))
          return view === undefined ? [] : [briefView(view, connById, resultById)]
        }),
        activeViewId: p.activeViewId === null ? null : String(p.activeViewId),
      }))
    : []

  const unplacedViews: ViewBrief[] =
    want('layout') || want('views')
      ? snap.views.filter((v) => v.panelId === null).map((v) => briefView(v, connById, resultById))
      : []

  return {
    rev: snap.rev,
    focusedPanel: snap.focusedPanel === null ? null : String(snap.focusedPanel),
    panels,
    connections: want('connections') ? snap.connections.map(briefConnection) : [],
    results: want('results') ? snap.results.map(briefResult) : [],
    unplacedViews,
    layout: snap.layout,
  }
}

function briefView(
  v: ViewSummary,
  connById: Map<string, ConnectionSummary>,
  resultById: Map<string, ResultMeta>,
): ViewBrief {
  const conn = connById.get(String(v.connId))
  const result = v.resultId === undefined ? undefined : resultById.get(String(v.resultId))
  return {
    viewId: String(v.id),
    kind: v.kind,
    title: v.title,
    describe: v.describe,
    status: v.status,
    connId: String(v.connId),
    connLabel: conn?.label ?? '(unknown connection)',
    panelId: v.panelId === null ? null : String(v.panelId),
    visible: v.visible,
    ...(result === undefined ? {} : { result: briefResult(result) }),
    ...(v.error === undefined ? {} : { error: `${v.error.code}: ${v.error.message}` }),
  }
}

/** Flat view summaries (layout-independent; used by the receipts of view.* tools). */
export function briefViews(snap: WorkspaceSnapshot): ViewBrief[] {
  const connById = new Map(snap.connections.map((c) => [String(c.id), c]))
  const resultById = new Map(snap.results.map((r) => [String(r.id), r]))
  return snap.views.map((v) => briefView(v, connById, resultById))
}

/* ================================================================== */
/* 3. Text rendering                                                    */
/* ================================================================== */

function viewLine(view: ViewBrief): string {
  const bits = [view.kind, view.describe, `conn=${view.connLabel}`, `status=${view.status}`]
  if (view.result) {
    bits.push(`rows=${view.result.rows}`)
    if (view.result.status === 'paused') {
      // This text outline is the first thing the AI reads, and the bare word "paused" is far
      // too easy to read as a failure — so spell the conclusion out inline.
      bits.push('result=paused (not a failure: these rows are valid, re-run to keep fetching)')
    } else if (view.result.status !== 'done') {
      bits.push(`result=${view.result.status}`)
    }
  }
  if (view.error) bits.push(`error=${view.error}`)
  return bits.join(' · ')
}

/**
 * One line per tab.
 *
 * Every tab is listed, including the single-tab case which could have been folded
 * back onto the panel line. Two shapes for one thing would be the whole cost of
 * the compaction: a reader has to learn both, and the one it is most likely to
 * misread is the one where the marker is absent because there was nothing to
 * distinguish. `[active]` appears in exactly the same place either way.
 */
function tabLines(views: readonly ViewBrief[], activeViewId: string | null, indent: string): string[] {
  return views.map((view, i) => {
    const active = view.viewId === activeViewId ? ' [active]' : ''
    return `${indent}#${String(i + 1)} ${view.viewId}${active} · ${viewLine(view)}`
  })
}

/** `panel_a · 2 tabs` / `panel_b · empty (0 tabs)` — the panel's own line, tabs excluded. */
function panelHead(panelId: string, focused: boolean, tabCount: number): string {
  const focus = focused ? ' [focused]' : ''
  const tabs = tabCount === 0 ? 'empty (0 tabs)' : `${String(tabCount)} tab${tabCount === 1 ? '' : 's'}`
  return `panel ${panelId}${focus} · ${tabs}`
}

/** An ASCII layout tree — the most direct way to tell the AI what the UI looks like. */
export function renderLayoutOutline(snap: WorkspaceSnapshot): string {
  const brief = buildWorkspaceBrief(snap, ['layout'])
  const panelById = new Map(brief.panels.map((p) => [p.panelId, p]))
  const lines: string[] = []

  const walk = (node: LayoutNode, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`
    const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`
    if (node.type === 'panel') {
      const panel = panelById.get(String(node.id))
      lines.push(
        `${branch}${panelHead(String(node.id), snap.focusedPanel === node.id, panel?.views.length ?? 0)}`,
      )
      lines.push(...tabLines(panel?.views ?? [], panel?.activeViewId ?? null, `${childPrefix}   `))
      return
    }
    const ratio = node.ratio.map((r) => r.toFixed(2)).join('/')
    lines.push(`${branch}split ${String(node.id)} dir=${node.dir} ratio=${ratio}`)
    node.children.forEach((child, i) => {
      walk(child, childPrefix, i === node.children.length - 1, depth + 1)
    })
  }

  walk(snap.layout, '', true, 0)

  // Views with no panel are part of the answer to "what is open", and the tree
  // above structurally cannot show them. Printing the line even when the count is
  // zero keeps its absence from being ambiguous.
  const unplaced = snap.views.filter((v) => v.panelId === null)
  lines.push(
    unplaced.length === 0
      ? 'unplaced: 0 view(s)'
      : `unplaced: ${String(unplaced.length)} view(s) — ${unplaced.map((v) => String(v.id)).join(', ')}`,
  )

  return lines.join('\n')
}

/**
 * The minimal one-line-per-panel variant, appended to the receipts of write tools.
 *
 * Every tab id is named — a receipt whose only claim about a panel is what its
 * active tab shows would hide the tab that was just pushed into the background,
 * which after a stacking drop is precisely the view the caller was working with.
 * The detail line still describes the active tab alone; the ids are what a follow-up
 * call needs.
 */
export function renderPanelBrief(snap: WorkspaceSnapshot): string {
  const brief = buildWorkspaceBrief(snap, ['layout'])
  return brief.panels
    .map((p) => {
      const focus = p.focused ? ' [focused]' : ''
      if (p.views.length === 0) return `- ${p.panelId}${focus}: empty panel (0 tabs)`
      const tabs = p.views
        .map((v) => `${v.viewId}${v.viewId === p.activeViewId ? ' (active)' : ''}`)
        .join(', ')
      const active = p.views.find((v) => v.viewId === p.activeViewId)
      const showing = active === undefined ? '' : ` · showing ${viewLine(active)}`
      return `- ${p.panelId}${focus}: ${String(p.views.length)} tab(s) [${tabs}]${showing}`
    })
    .join('\n')
}

/** Stable JSON serialization (for embedding structured data in a tool body). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2) ?? 'null'
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`
  return value
}
