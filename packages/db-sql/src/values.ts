import {
  VALUE_PREVIEW_BYTES,
  canonicalCell,
  truncatedValue,
  type LogicalType,
  type ValueRef,
} from '@peek/core'

/**
 * Cell normalization: what a backend hands back → what may travel in a chunk.
 *
 * A `ChunkFrame` is structured-cloned across a MessagePort and then read by
 * React, so only a small set of shapes is allowed through: `null`, `string`,
 * `number`, `boolean`, `TruncatedValue`, and plain JSON. Everything the two SQL
 * backends can produce that is *not* on that list is converted here:
 *
 * | value from the backend | why it cannot travel as-is | what it becomes |
 * |---|---|---|
 * | `Buffer` / `Uint8Array` (BLOB, MySQL binary columns) | clones as bytes the grid cannot render, and may be gigabytes | base64 preview + `TruncatedValue` |
 * | `bigint` (MySQL BIGINT, SQLite INTEGER past 2^53) | survives the clone but `JSON.stringify` throws on it, and MCP receipts are JSON | number, or a decimal string past the safe range |
 * | `Date` (mysql2 DATE/DATETIME) | clones fine, but formats per-locale in the renderer | ISO 8601 string |
 * | mysql2 `RowDataPacket` for JSON columns | already parsed to an object | left as JSON |
 * | anything over `VALUE_PREVIEW_BYTES` | blows the chunk budget on one cell | preview + `TruncatedValue` with a ref |
 *
 * The bigint rule is worth stating twice, because it is a data-loss bug and not a
 * formatting one: `9007199254740993` becomes `9007199254740992` the moment
 * anything coerces it to a JS number, and the user has no way to notice. Both
 * backends must be configured to hand large integers over as `bigint` or as a
 * string — never as a lossy `number` — and this function is what makes that safe
 * to display.
 *
 * ## Why a bigint inside the safe range becomes a `number` and not a string
 *
 * The two backends disagree about when a 64-bit integer stops fitting: mysql2
 * (`supportBigNumbers` + `bigNumberStrings: false`) hands over a `number` while
 * the value fits and a decimal *string* once it does not, whereas node:sqlite's
 * `setReadBigInts(true)` hands over a `bigint` for **every** INTEGER, including
 * `1`. Passing every bigint through as a string would therefore render the same
 * table as `1` in MySQL and `"1"` in SQLite — a difference the user sees, caused
 * by nothing but which of the two clients read the row.
 *
 * So the rule is the one mysql2 already implements, applied to both: exact while
 * exact is possible, and a decimal string the moment it is not. Nothing is
 * rounded either way, which is the property that actually mattered.
 *
 * That rule now lives in `core/values.ts` as `canonicalCell`, because the same
 * argument applies one level up: it was true across the two SQL dialects and
 * false across the four drivers, where postgres handed the very same `BIGINT 1`
 * over as `"1"`. This module keeps the size and byte-shape work; the question of
 * *which JS type a LogicalType is* is core's to answer.
 */

/** Values of these logical types can be huge, so the UI wires up a valuePeek entry point ahead of time */
const PEEKABLE: ReadonlySet<LogicalType> = new Set<LogicalType>([
  'string', 'json', 'bytes', 'array', 'vector', 'geo', 'unknown',
])

/** Whether a column of this logical type may carry a truncated value (`ColumnDef.peekable`) */
export function isPeekableLogical(logical: LogicalType): boolean {
  return PEEKABLE.has(logical)
}

export interface NormalizeContext {
  logical: LogicalType
  /** Builds the `ValueRef` for a value that had to be truncated, so valuePeek can fetch the rest */
  makeRef(): ValueRef
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Cut utf8 text at a byte boundary. This can split a multi-byte character in
 * half; non-strict decoding turns the remainder into U+FFFD, which is the right
 * trade for a preview — the full value is one valuePeek away.
 */
function previewOfText(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= limit) return text
  return new TextDecoder('utf-8').decode(buf.subarray(0, limit))
}

/** One cell → a chunk-safe value */
export function normalizeCell(raw: unknown, ctx: NormalizeContext): unknown {
  const limit = VALUE_PREVIEW_BYTES
  // Canonical shape first (see core/values.ts); size and encoding after
  const value = canonicalCell(raw, ctx.logical)
  if (value === null || value === undefined) return null

  switch (typeof value) {
    case 'string': {
      const bytes = Buffer.byteLength(value, 'utf8')
      if (bytes <= limit) return value
      return truncatedValue(previewOfText(value, limit), 'utf8', {
        byteLength: bytes,
        ref: ctx.makeRef(),
      })
    }
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      // Only reachable when the column's logical type is not one canonicalCell
      // narrows (an untyped expression, say); the same exact-or-string rule applies
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString(10)
    case 'object':
      break
    default:
      return String(value)
  }

  // mysql2 only produces Date objects when `dateStrings` is off, which the backend
  // pins to on; this branch is the belt to that brace, and to any dialect added later
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  if (value instanceof Uint8Array) {
    const total = value.byteLength
    if (total <= limit) return Buffer.from(value).toString('base64')
    return truncatedValue(Buffer.from(value.subarray(0, limit)).toString('base64'), 'base64', {
      byteLength: total,
      ref: ctx.makeRef(),
    })
  }

  // JSON columns: mysql2 already parsed these into ordinary objects
  const text = safeJson(value)
  if (text === null) return String(value)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return value
  return truncatedValue(previewOfText(text, limit), 'utf8', {
    byteLength: bytes,
    ref: ctx.makeRef(),
  })
}

/**
 * Rough byte cost of a normalized cell, summed per frame to feed core's
 * `adaptiveChunkRows`. An estimate on purpose: measuring exactly would mean
 * serializing every frame twice.
 */
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
  // TruncatedValue: only the preview travels, so only the preview counts
  const rec = value as Record<string, unknown>
  const preview = rec['preview']
  if (rec['__peekTruncated'] === true && typeof preview === 'string') {
    return Buffer.byteLength(preview, 'utf8') + 64
  }
  const text = safeJson(value)
  return text === null ? 32 : Buffer.byteLength(text, 'utf8')
}

/* ------------------------------------------------------------------ */
/* Row-decoding helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Helpers for reading a **control-plane** row (`SqlRows`): the introspection
 * catalogs, `relationMetaSql`, the value peeker's probe.
 *
 * They live here rather than in each dialect because the coercions are identical
 * even where the queries are not, and because both backends smuggle the same two
 * surprises into an otherwise ordinary integer column: node:sqlite's
 * `setReadBigInts(true)` makes `pk` and `notnull` arrive as `bigint`, and MySQL
 * spells nullability `'YES'` / `'NO'`. A decoder that assumed `number` would read
 * every SQLite primary key as not-a-primary-key, silently.
 */

/** Column index by name (case-insensitive: MySQL's catalogs shout, SQLite's pragmas do not) */
export function columnIndex(columns: readonly { name: string }[], name: string): number {
  return columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
}

/** A cell as text, or null */
export function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString(10)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

/** A cell as a finite number, or null */
export function cellNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return value.trim().length > 0 && Number.isFinite(n) ? n : null
  }
  return null
}

/** A cell as a boolean: MySQL reports flags as `'YES'` / `'NO'`, SQLite as 0 / 1 */
export function cellBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    return t === 'yes' || t === 'true' || t === '1'
  }
  const n = cellNumber(value)
  return n !== null && n !== 0
}

/** Re-exported so the cursor does not import core for the two truncation primitives */
export { VALUE_PREVIEW_BYTES, truncatedValue }
