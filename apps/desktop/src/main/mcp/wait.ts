/**
 * 结果集等待与行渲染。
 *
 * query.run / view.open 只返回 resultId 就立刻回来（chunk 走 MessagePort 直达 renderer），
 * 但 AI 需要"跑完了没、多少行"。main 手里有 ResultMeta（控制面），轮询它即可，
 * 不需要额外的进程间协议。
 */

import { isTruncatedValue, type ResultId, type ResultMeta } from '@peek/core'
import type { ResultRowsSlice, ToolContext } from './types'

/** 轮询间隔：50ms，够跟手又不至于空转 */
const POLL_INTERVAL_MS = 50

export interface ResultWaitOutcome {
  meta: ResultMeta | null
  /** 等到了终态（done / error / cancelled） */
  settled: boolean
  waitedMs: number
}

/** 轮询 Workspace 里的 ResultMeta，直到进入终态或超时 */
export async function waitForResult(
  ctx: ToolContext,
  resultId: ResultId,
  timeoutMs: number,
): Promise<ResultWaitOutcome> {
  const startedAt = ctx.now()
  for (;;) {
    const meta = ctx.getSnapshot().results.find((r) => r.id === resultId) ?? null
    if (meta && meta.status !== 'running') {
      return { meta, settled: true, waitedMs: ctx.now() - startedAt }
    }
    if (ctx.now() - startedAt >= timeoutMs) {
      return { meta, settled: false, waitedMs: ctx.now() - startedAt }
    }
    await ctx.sleep(POLL_INTERVAL_MS)
  }
}

/* ================================================================== */
/* 行渲染                                                              */
/* ================================================================== */

/** 单元格文本上限，防止一个大 value 撑爆上下文（全量看界面 / 走 valuePeek） */
const CELL_MAX_CHARS = 160

export function renderCell(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (isTruncatedValue(value)) {
    const size = value.byteLength === undefined ? '' : ` /${value.byteLength}B`
    return `${clip(value.preview)}…(截断${size})`
  }
  if (typeof value === 'string') return clip(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`
  if (typeof value === 'object') return clip(safeJson(value))
  return clip(String(value))
}

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ')
  return oneLine.length > CELL_MAX_CHARS ? `${oneLine.slice(0, CELL_MAX_CHARS)}…` : oneLine
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 把行切片渲染成对齐的文本表格 */
export function renderRowsTable(slice: ResultRowsSlice): string {
  const header = slice.columns.map((c) => `${c.name}:${c.logical}`)
  if (slice.rows.length === 0) return `${header.join(' | ')}\n(0 行)`

  const body = slice.rows.map((row) => row.map(renderCell))
  const widths = header.map((h, i) =>
    Math.min(
      CELL_MAX_CHARS,
      Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)),
    ),
  )
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join(' | ')

  return [line(header), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line)].join('\n')
}
