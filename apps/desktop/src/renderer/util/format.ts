import type { LogicalType } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { isPendingCell } from '../state/resultCache'

/* ==================================================================
 * 单元格渲染工具。
 * 全部是纯函数、无组件、无闭包分配 —— 表格热路径每帧要跑几百次。
 * ================================================================== */

export const NULL_TEXT = 'NULL'
export const PENDING_TEXT = '···'

/** 单元格文本。只做展示，绝不修改原值。 */
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

/** 单元格 CSS class（决定对齐与配色），返回常量字符串，无分配 */
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

/** 值可以点开细看（截断值、JSON、长文本） */
export function isExpandable(v: unknown): boolean {
  if (isPendingCell(v) || v === null || v === undefined) return false
  if (isTruncatedValue(v)) return true
  if (typeof v === 'string') return v.length > 80 || v.includes('\n')
  if (typeof v === 'object') return true
  return false
}

/** 弹层里的全量文本（JSON 会 pretty 化） */
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
/* 状态栏用的小工具                                                      */
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

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
