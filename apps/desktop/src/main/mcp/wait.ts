/**
 * Waiting on a result set, and rendering its rows.
 *
 * query.run / view.open return a resultId and come back immediately (chunks go over a
 * MessagePort straight to the renderer), but the AI needs to know "did it finish, how many
 * rows". main already holds ResultMeta on the control plane, so polling that is enough —
 * no extra cross-process protocol is required.
 */

import { isTruncatedValue, type ResultId, type ResultMeta } from '@peek/core'
import type { ResultRowsSlice, ToolContext } from './types'

/** Poll interval: 50ms — responsive enough without spinning. */
const POLL_INTERVAL_MS = 50

export interface ResultWaitOutcome {
  meta: ResultMeta | null
  /** A settled status was reached (done / error / cancelled). */
  settled: boolean
  waitedMs: number
}

/** Poll the ResultMeta in the Workspace until it settles or the timeout elapses. */
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
/* Row rendering                                                        */
/* ================================================================== */

/**
 * Per-cell character cap, so one huge value cannot blow up the context window
 * (the full value is available in the UI, or through valuePeek).
 */
const CELL_MAX_CHARS = 160

export function renderCell(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (isTruncatedValue(value)) {
    const size = value.byteLength === undefined ? '' : ` /${value.byteLength}B`
    return `${clip(value.preview)}…(truncated${size})`
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

/** Render a row slice as an aligned text table. */
export function renderRowsTable(slice: ResultRowsSlice): string {
  const header = slice.columns.map((c) => `${c.name}:${c.logical}`)
  if (slice.rows.length === 0) return `${header.join(' | ')}\n(0 rows)`

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
