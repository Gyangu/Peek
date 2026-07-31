import type { LogicalType } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { isPendingCell } from '../state/resultCache'

/* ==================================================================
 * Cell rendering helpers.
 *
 * Pure functions throughout — no components, no closure allocation — because the
 * grid's hot path calls them hundreds of times per frame.
 *
 * None of the output here is localized, and that is the point: NULL, the pending
 * marker, hex dumps and JSON are how the *data* is spelled, not prose about it. A
 * user comparing a cell against psql output or a JSON payload needs both sides to
 * read the same.
 * ================================================================== */

export const NULL_TEXT = 'NULL'
export const PENDING_TEXT = '···'

/** Text for one cell. Presentation only; the value itself is never modified. */
export function cellText(v: unknown): string {
  if (isPendingCell(v)) return PENDING_TEXT
  if (v === null || v === undefined) return NULL_TEXT
  switch (typeof v) {
    case 'string':
      return v.length > 512 ? `${oneLine(v.slice(0, 512))}…` : oneLine(v)
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(v)
    case 'object': {
      if (isTruncatedValue(v)) {
        const head = oneLine(v.preview.slice(0, 256))
        return `${head}…`
      }
      if (v instanceof Date) return isoLocal(v)
      if (ArrayBuffer.isView(v)) return hexPreview(v)
      return oneLine(safeJson(v, 512))
    }
    default:
      return String(v)
  }
}

/** CSS class for one cell (alignment and colour). Returns constants, allocates nothing. */
export function cellClass(v: unknown, logical: LogicalType | undefined): string {
  if (isPendingCell(v)) return 'grid-cell pending'
  if (v === null || v === undefined) return 'grid-cell null'
  if (isTruncatedValue(v)) return 'grid-cell trunc'
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return 'grid-cell num'
    case 'boolean':
      return 'grid-cell bool'
    case 'object':
      return v instanceof Date ? 'grid-cell' : 'grid-cell json'
    default:
      return logical === 'number' || logical === 'bigint' ? 'grid-cell num' : 'grid-cell'
  }
}

/** Whether the value is worth opening up: truncated values, JSON, long text. */
export function isExpandable(v: unknown): boolean {
  if (isPendingCell(v) || v === null || v === undefined) return false
  if (isTruncatedValue(v)) return true
  if (typeof v === 'string') return v.length > 80 || v.includes('\n')
  if (typeof v === 'object') return true
  return false
}

/** Full text for the modal; JSON is pretty-printed. */
export function fullValueText(v: unknown): string {
  if (isPendingCell(v)) return PENDING_TEXT
  if (v === null || v === undefined) return NULL_TEXT
  if (isTruncatedValue(v)) return v.preview
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString()
    if (ArrayBuffer.isView(v)) return hexDump(v)
    return safeJson(v, Number.MAX_SAFE_INTEGER, 2)
  }
  return String(v)
}

/* ------------------------------------------------------------------ */

function oneLine(s: string): string {
  return s.includes('\n') || s.includes('\r') || s.includes('\t')
    ? s.replace(/[\r\n\t]+/g, ' ')
    : s
}

function isoLocal(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid Date'
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + (d.getMilliseconds() ? `.${p(d.getMilliseconds(), 3)}` : '')
  )
}

function hexPreview(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, 16))
  let out = '\\x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return v.byteLength > 16 ? `${out}… (${v.byteLength}B)` : out
}

function hexDump(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16)
    let hex = ''
    let ascii = ''
    for (const b of slice) {
      hex += `${b.toString(16).padStart(2, '0')} `
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'
    }
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48, ' ')} ${ascii}`)
  }
  return lines.join('\n')
}

function safeJson(v: unknown, maxLen: number, indent?: number): string {
  try {
    const s = JSON.stringify(v, jsonReplacer, indent)
    if (s === undefined) return String(v)
    return s.length > maxLen ? s.slice(0, maxLen) : s
  } catch {
    return String(v)
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value
}

/* ------------------------------------------------------------------ */
/* Small helpers for the status bar                                       */
/* ------------------------------------------------------------------ */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * Thousands grouping for row counts.
 *
 * Pinned to en-US rather than the active locale, and `t()` never groups numbers
 * on its own (see `formatTemplate` in core): a row count is an address into the
 * grid, and it has to line up with the row-number gutter, the scrollbar bubble
 * and whatever the user reads back to a colleague. Grouping is presentation, but
 * a number that changes shape with the UI language is a number two people cannot
 * compare.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
