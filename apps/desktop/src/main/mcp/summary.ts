/**
 * Workspace 摘要渲染。
 *
 * read_workspace 要让 AI "看见"当前界面：每个 panel 的位置、视图类型、所连库、
 * 所看的表/查询、当前行数/是否加载中。摘要必须精炼——**绝不把结果集塞进来**，
 * 只给元信息（ResultMeta）。
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
/* 1. 摘要数据结构                                                       */
/* ================================================================== */

export interface ConnBrief {
  connId: string
  label: string
  driverId: string
  status: string
  capabilities: string[]
  /** 已脱敏的连接目标（host/db 或文件路径） */
  target: string
  serverVersion?: string
  error?: string
}

export interface ResultBrief {
  resultId: string
  status: ResultMeta['status']
  rows: number
  /**
   * 已加载的这 `rows` 行能不能信。**只有 error 为 false**——
   * paused / cancelled 都是"没取完但取到的都是真数据"。
   * 光给 status 不够：AI 见到一个没见过的状态值时最省事的猜法就是当失败处理，
   * 所以这个结论必须显式写出来，不让读方自己推。
   */
  rowsUsable: boolean
  elapsedMs?: number
  truncated?: boolean
  /** 重新执行即可继续取数（status === 'paused' 时恒为 true） */
  resumable?: boolean
  /** status === 'paused' 时的人可读原因 */
  pausedReason?: string
  columns?: string[]
  summary?: string
  error?: string
}

export interface ViewBrief {
  viewId: string
  kind: ViewSummary['kind']
  title: string
  /** 一句话：当前视图在看什么 */
  describe: string
  status: ViewSummary['status']
  connId: string
  connLabel: string
  result?: ResultBrief
  error?: string
}

export interface PanelBrief {
  panelId: string
  /** 在布局树里的位置，形如 'root' / 'root.0.1' */
  path: string
  focused: boolean
  view: ViewBrief | null
}

export interface WorkspaceBrief {
  rev: number
  focusedPanel: string | null
  panels: PanelBrief[]
  connections: ConnBrief[]
  /** 活跃/最近的结果集元信息（不含数据本体） */
  results: ResultBrief[]
  /** 原始布局树（含 split 的 dir/ratio/id，layout.setRatio 要用） */
  layout: LayoutNode
}

export type BriefSection = 'layout' | 'views' | 'connections' | 'results'

/* ================================================================== */
/* 2. 构建                                                             */
/* ================================================================== */

/** 连接目标的可读描述（config 已经过 redactConnectionConfig，这里只做拼装） */
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

/** 深度优先给每个 panel 算出树内路径，'root' 表示根就是面板 */
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
    connLabel: conn?.label ?? '(未知连接)',
    ...(result === undefined ? {} : { result: briefResult(result) }),
    ...(v.error === undefined ? {} : { error: `${v.error.code}: ${v.error.message}` }),
  }
}

/** 摊平的视图摘要（不依赖布局，view.* 类工具回执用） */
export function briefViews(snap: WorkspaceSnapshot): ViewBrief[] {
  const connById = new Map(snap.connections.map((c) => [String(c.id), c]))
  const resultById = new Map(snap.results.map((r) => [String(r.id), r]))
  return snap.views.map((v) => briefView(v, connById, resultById))
}

/* ================================================================== */
/* 3. 文本渲染                                                          */
/* ================================================================== */

function viewLine(view: ViewBrief | null): string {
  if (view === null) return '(空面板)'
  const bits = [view.kind, view.describe, `conn=${view.connLabel}`, `status=${view.status}`]
  if (view.result) {
    bits.push(`rows=${view.result.rows}`)
    if (view.result.status === 'paused') {
      // 文本视图是 AI 最先读到的东西，"paused" 三个字太容易被当成失败，这里把结论写死
      bits.push('result=paused（不是失败：这些行有效，重跑可继续取数）')
    } else if (view.result.status !== 'done') {
      bits.push(`result=${view.result.status}`)
    }
  }
  if (view.error) bits.push(`error=${view.error}`)
  return bits.join(' · ')
}

/** ASCII 布局树，最直观地告诉 AI "界面长什么样" */
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

/** 一行一个面板的极简版，挂在写操作工具的回执尾巴上 */
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

/** 稳定的 JSON 序列化（工具正文里附结构化数据用） */
export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2) ?? 'null'
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`
  return value
}
