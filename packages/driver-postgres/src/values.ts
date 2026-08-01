import {
  VALUE_PREVIEW_BYTES,
  canonicalCell,
  truncatedValue,
  type LogicalType,
  type ValueRef,
} from '@peek/core'

/**
 * Cell value normalization.
 *
 * Two jobs:
 * 1. Guarantee that everything placed in a ChunkFrame is **structured-clone
 *    safe**, since frames go straight to the renderer over a MessagePort.
 *    Buffers become base64 strings so no end has to agree on how to handle a
 *    Uint8Array.
 * 2. Anything over VALUE_PREVIEW_BYTES (4KB) travels as a preview only, flagged
 *    as a TruncatedValue; the full value is fetched on demand through valuePeek
 *    (a hard rule from PLAN section 8).
 * 3. Put the value in the shape core says that LogicalType has, before anything
 *    else — `canonicalCell`. pg's parsers are the outlier of the four drivers:
 *    `int8` arrives as a string, `timestamptz` and `date` as `Date` objects,
 *    `interval` as a `PostgresInterval`. Left alone, `BIGINT 1` rendered as `"1"`
 *    here and as `1` in MySQL, and a plain `DATE` shifted a day in any timezone
 *    west of UTC. See core/values.ts for the table and the argument.
 */

/** Estimate a value's wire size in bytes; feeds adaptiveChunkRows */
export function estimateCellBytes(value: unknown): number {
  if (value === null || value === undefined) return 1
  switch (typeof value) {
    case 'boolean':
      return 1
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'string':
      return Buffer.byteLength(value, 'utf8')
    case 'object':
      break
    default:
      return 8
  }
  if (value instanceof Date) return 24
  if (value instanceof Uint8Array) return value.byteLength
  // TruncatedValue: only the preview counts
  const rec = value as Record<string, unknown>
  const preview = rec['preview']
  if (rec['__peekTruncated'] === true && typeof preview === 'string') {
    return Buffer.byteLength(preview, 'utf8') + 64
  }
  return jsonSize(value)
}

function jsonSize(value: unknown): number {
  const text = safeJson(value)
  return text === null ? 32 : Buffer.byteLength(text, 'utf8')
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** Truncate utf8 text at a byte boundary (this can split a multi-byte character, which non-strict decoding absorbs) */
function previewOfText(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= limit) return text
  return new TextDecoder('utf-8').decode(buf.subarray(0, limit))
}

export interface NormalizeContext {
  logical: LogicalType
  /**
   * Called only when the value is truncated; returns the locator used to fetch it
   * again. It is lazy because at a million rows × dozens of columns, eagerly
   * building one ValueRef object per cell would burn the entire first-frame
   * budget on garbage collection alone.
   */
  makeRef?: () => ValueRef | undefined
  /** Preview ceiling; defaults to VALUE_PREVIEW_BYTES */
  limit?: number
}

function refOf(ctx: NormalizeContext): { ref?: ValueRef } {
  const ref = ctx.makeRef?.()
  return ref === undefined ? {} : { ref }
}

/**
 * Convert a value parsed by pg into something the renderer can receive directly.
 * A TruncatedValue return means the cell was cut short; the UI pulls the whole
 * thing through valuePeek when it needs it.
 */
export function normalizeCell(raw: unknown, ctx: NormalizeContext): unknown {
  const limit = ctx.limit ?? VALUE_PREVIEW_BYTES
  // Canonical shape first: everything below then only has to worry about size
  const value = canonicalCell(raw, ctx.logical)
  if (value === null || value === undefined) return null

  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= limit) return value
    return truncatedValue(previewOfText(value, limit), 'utf8', {
      byteLength: bytes,
      ...refOf(ctx),
    })
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }

  if (value instanceof Uint8Array) {
    const total = value.byteLength
    if (total <= limit) return Buffer.from(value).toString('base64')
    return truncatedValue(Buffer.from(value.subarray(0, limit)).toString('base64'), 'base64', {
      byteLength: total,
      ...refOf(ctx),
    })
  }

  // json / jsonb / arrays / composite types: pg already parsed these into JS objects
  if (typeof value === 'object') {
    const text = safeJson(value)
    if (text === null) return String(value)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= limit) return value
    return truncatedValue(previewOfText(text, limit), 'utf8', {
      byteLength: bytes,
      ...refOf(ctx),
    })
  }

  return String(value)
}
