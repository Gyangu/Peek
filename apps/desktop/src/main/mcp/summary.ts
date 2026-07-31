/**
 * Workspace summary rendering.
 *
 * read_workspace exists so the AI can "see" the current UI: where each panel sits, its view
 * kind, which database it is connected to, which table or query it shows, how many rows it has
 * and whether it is still loading. The summary must stay compact — **never inline result set
 * data**, only its metadata (ResultMeta).
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
  result?: ResultBrief
  error?: string
}

export interface PanelBrief {
  panelId: string
  /** Position within the layout tree, e.g. 'root' or 'root.0.1'. */
  path: string
  focused: boolean
  view: ViewBrief | null
}

export interface WorkspaceBrief {
  rev: number
  focusedPanel: string | null
  panels: PanelBrief[]
  connections: ConnBrief[]
  /** Metadata for active/recent result sets (never the data itself). */
  results: ResultBrief[]
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
    ? collectPanels(snap.layout).map((p) => {
        const view = p.viewId === null ? undefined : viewById.get(String(p.viewId))
        return {
          panelId: String(p.id),
          path: paths.get(p.id) ?? 'root',
          focused: snap.focusedPanel === p.id,
          view: view === undefined ? null : briefView(view, connById, resultById),
        }
      })
    : []

  return {
    rev: snap.rev,
    focusedPanel: snap.focusedPanel === null ? null : String(snap.focusedPanel),
    panels,
    connections: want('connections') ? snap.connections.map(briefConnection) : [],
    results: want('results') ? snap.results.map(briefResult) : [],
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

function viewLine(view: ViewBrief | null): string {
  if (view === null) return '(empty panel)'
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

/** An ASCII layout tree — the most direct way to tell the AI what the UI looks like. */
export function renderLayoutOutline(snap: WorkspaceSnapshot): string {
  const views = new Map(briefViews(snap).map((v) => [v.viewId, v]))
  const lines: string[] = []

  const walk = (node: LayoutNode, prefix: string, isLast: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`
    if (node.type === 'panel') {
      const view = node.viewId === null ? null : (views.get(String(node.viewId)) ?? null)
      const focus = snap.focusedPanel === node.id ? ' [focused]' : ''
      lines.push(`${branch}panel ${String(node.id)}${focus} · ${viewLine(view)}`)
      return
    }
    const ratio = node.ratio.map((r) => r.toFixed(2)).join('/')
    lines.push(`${branch}split ${String(node.id)} dir=${node.dir} ratio=${ratio}`)
    const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`
    node.children.forEach((child, i) => {
      walk(child, childPrefix, i === node.children.length - 1, depth + 1)
    })
  }

  walk(snap.layout, '', true, 0)
  return lines.join('\n')
}

/** The minimal one-line-per-panel variant, appended to the receipts of write tools. */
export function renderPanelBrief(snap: WorkspaceSnapshot): string {
  const views = new Map(briefViews(snap).map((v) => [v.viewId, v]))
  return collectPanels(snap.layout)
    .map((p) => {
      const view = p.viewId === null ? null : (views.get(String(p.viewId)) ?? null)
      const focus = snap.focusedPanel === p.id ? ' [focused]' : ''
      return `- ${String(p.id)}${focus}: ${viewLine(view)}`
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
