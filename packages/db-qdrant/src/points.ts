import {
  QDRANT_PAYLOAD_FIELD_PREFIX,
  QDRANT_VECTOR_FIELD,
  QDRANT_VECTOR_FIELD_PREFIX,
  VALUE_PREVIEW_BYTES,
  VECTOR_RESULT_COLUMNS,
  buildVectorResultSchema,
  qdrantPayloadField,
  truncatedValue,
  type ColumnDef,
  type ValueRef,
} from '@peek/core'

/**
 * A qdrant point → one row of a chunk.
 *
 * ## The decision this file encodes: payload is one column, not many
 *
 * A payload is arbitrary JSON with no declared schema, and the chunk protocol
 * puts `schema` on frame 0 and never repeats it. So the column set has to be
 * fixed **before the first point is read** — which rules out the obvious idea of
 * unioning the payload keys seen so far. Row 900,001 with a new key would need a
 * column frame 0 already promised did not exist, and the receiver has no way to
 * widen a result set mid-stream.
 *
 * Hence the default: `id`, `[score]`, and the whole payload in a single `json`
 * column. It is honest about a schemaless payload, it is stable, and the grid
 * already knows how to render and peek a json cell.
 *
 * Flattening is opt-in through `CollectionScanRequest.columns` /
 * `VectorSearchRequest.columns`, and then those names *are* the schema: a point
 * missing one of them gets null, a point carrying extra keys has them dropped.
 * Two sources are good enough to fill that list without the user typing it:
 *
 * 1. `GET /collections/{name}` reports `payload_schema` for indexed fields — the
 *    keys someone already cared enough about to index, which is the best
 *    available guess at "the interesting ones";
 * 2. an explicit list from an MCP caller who knows the collection.
 *
 * `resolvePayloadColumns` implements both readings; which one a call site uses is
 * a policy decision, and the policy this driver ships with is (2) only — see the
 * comment on `NO_IMPLICIT_FLATTENING` in session.ts. Deriving the schema from the
 * server's index state would make two scans of the same collection disagree the
 * moment somebody adds an index, and would make `describeCollection` disagree
 * with the frame-0 schema of the scan it describes.
 */

/** A point as the REST client returns it (the fields peek actually reads) */
export interface QdrantPoint {
  id: string | number
  payload?: Record<string, unknown> | null
  /**
   * Unnamed vector, a multivector, or a map of named vectors; absent unless
   * withVector was requested.
   */
  vector?: number[] | number[][] | Record<string, unknown> | null
  /** Present on search results only */
  score?: number
}

/** What a row looks like, decided once per result set and then fixed */
export interface QdrantRowShape {
  columns: ColumnDef[]
  /** Payload keys flattened into their own columns; empty means the single json column */
  payloadColumns: readonly string[]
  withScore: boolean
  withVector: boolean
  /**
   * Collection the points come from. Only needed to mint the `qdrantPoint`
   * ValueRefs that back a truncated cell; optional so a caller that only wants
   * the column layout (the contract tests, `describeCollection`) does not have to
   * invent one.
   */
  collection?: string
  /**
   * Named vector this result set carries, when the collection has several. Used
   * for the `vector:<name>` half of core's `QDRANT_VECTOR_FIELD` convention.
   */
  vectorName?: string
}

/**
 * `ValueRef.field` addressing a point's **whole** payload.
 *
 * core's convention spells a payload key as `payload:<key>`; the empty key is the
 * one spelling that cannot collide with a real key, so it is reserved for "the
 * payload object itself". The single `payload` json column needs this: it is not
 * one key, so no per-key ref describes it, and without a ref a truncated payload
 * would have no way back through valuePeek.
 */
export const QDRANT_WHOLE_PAYLOAD_FIELD: string = QDRANT_PAYLOAD_FIELD_PREFIX

/** Trim, drop empties, de-duplicate — column names must be unique within a result set */
function normalizeKeys(keys: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of keys) {
    const key = raw.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * Decide the payload columns for a result set.
 *
 * `requested` wins when non-empty. Otherwise the indexed payload keys are used,
 * and when there are none the result is empty — meaning the single `payload`
 * column. Order is stabilized (the caller's order, or the indexed keys sorted),
 * because column order is part of the schema and must not vary between two runs
 * of the same scan.
 */
export function resolvePayloadColumns(
  requested: readonly string[] | undefined,
  indexed: readonly string[],
): string[] {
  const fromCaller = normalizeKeys(requested ?? [])
  if (fromCaller.length > 0) return fromCaller
  return normalizeKeys([...indexed].sort())
}

/**
 * Column names must be unique within a result set, and a payload key is
 * arbitrary — a payload with its own `id` (extremely common: people mirror their
 * primary key into the payload) would otherwise produce two columns called `id`
 * and a grid that cannot tell them apart.
 *
 * The duplicate is suffixed the same way the PostgreSQL cursor does. Only the
 * *column name* moves; `QdrantRowShape.payloadColumns` keeps the raw keys,
 * because that is what `pointToRow` looks up in the payload, and the two are
 * matched by position.
 */
function disambiguate(columns: ColumnDef[]): ColumnDef[] {
  const used = new Map<string, number>()
  return columns.map((col) => {
    const seen = used.get(col.name) ?? 0
    used.set(col.name, seen + 1)
    return seen === 0 ? col : { ...col, name: `${col.name}__${seen + 1}` }
  })
}

/** Build the row shape for a scroll or a search. Delegates the column list to core, so both agree. */
export function buildRowShape(opts: {
  payloadColumns: readonly string[]
  withScore: boolean
  withVector: boolean
  collection?: string
  vectorName?: string
}): QdrantRowShape {
  return {
    columns: disambiguate(
      buildVectorResultSchema({
        withScore: opts.withScore,
        payloadColumns: opts.payloadColumns,
        withVector: opts.withVector,
      }),
    ),
    payloadColumns: opts.payloadColumns,
    withScore: opts.withScore,
    withVector: opts.withVector,
    ...(opts.collection === undefined ? {} : { collection: opts.collection }),
    ...(opts.vectorName === undefined || opts.vectorName === '' ? {} : { vectorName: opts.vectorName }),
  }
}

/**
 * A point id in a cell.
 *
 * Qdrant ids are a uuid **or** an unsigned integer, and the two must stay
 * distinguishable: a numeric id rendered as a string cannot be fed back into
 * `retrieve` without guessing. Numbers stay numbers, uuids stay strings, and the
 * `id` column's logical type is 'string' only because a column has one type and
 * the grid right-aligns numbers it is given.
 */
export function pointIdToCell(id: string | number): string | number {
  return id
}

/** Truncate utf8 text at a byte boundary (this can split a multi-byte character, which non-strict decoding absorbs) */
function previewOfText(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= limit) return text
  return new TextDecoder('utf-8').decode(buf.subarray(0, limit))
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
 * Turn one payload value (or the whole payload object) into a cell.
 *
 * Anything past VALUE_PREVIEW_BYTES travels as a preview plus a `qdrantPoint`
 * ref; a 40KB markdown chunk sitting in a payload is exactly as unwelcome in a
 * listing as a vector is.
 */
function payloadCell(value: unknown, shape: QdrantRowShape, id: string | number, field: string): unknown {
  if (value === undefined || value === null) return null
  const limit = VALUE_PREVIEW_BYTES
  const ref = (): { ref?: ValueRef } =>
    shape.collection === undefined ? {} : { ref: pointFieldRef(shape.collection, id, field) }

  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= limit) return value
    return truncatedValue(previewOfText(value, limit), 'utf8', { byteLength: bytes, ...ref() })
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value

  const text = safeJson(value)
  if (text === null) return String(value)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return value
  return truncatedValue(previewOfText(text, limit), 'utf8', { byteLength: bytes, ...ref() })
}

/**
 * The vector cell. The body is JSON-sized like any other value, so a 1536-float
 * vector (~20KB) always comes out as a `TruncatedValue` whose ref points at the
 * vector itself — which is the whole reason `with_vector` defaults to false.
 */
function vectorCell(point: QdrantPoint, shape: QdrantRowShape): unknown {
  const raw = point.vector
  if (raw === undefined || raw === null) return null

  let value: unknown = raw
  let field: string = QDRANT_VECTOR_FIELD
  const name = shape.vectorName
  if (Array.isArray(raw)) {
    if (name !== undefined) field = `${QDRANT_VECTOR_FIELD_PREFIX}${name}`
  } else if (name !== undefined && Object.prototype.hasOwnProperty.call(raw, name)) {
    value = raw[name]
    field = `${QDRANT_VECTOR_FIELD_PREFIX}${name}`
  }
  if (value === undefined || value === null) return null

  const text = safeJson(value)
  if (text === null) return null
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= VALUE_PREVIEW_BYTES) return value
  const extra =
    shape.collection === undefined ? {} : { ref: pointFieldRef(shape.collection, point.id, field) }
  return truncatedValue(previewOfText(text, VALUE_PREVIEW_BYTES), 'utf8', {
    byteLength: bytes,
    ...extra,
  })
}

/**
 * Turn a point into a row, in the column order of `shape`.
 *
 * The vector column, when present, is emitted as a `TruncatedValue` with a
 * `qdrantPoint` ref (field `vector` or `vector:<name>`, see core's
 * `QDRANT_VECTOR_FIELD` convention) — a 1536-float array is ~20KB of JSON and has
 * no business travelling in a scan. `withVector: false`, the default, does not
 * request it at all.
 */
export function pointToRow(point: QdrantPoint, shape: QdrantRowShape): unknown[] {
  const row: unknown[] = [pointIdToCell(point.id)]
  if (shape.withScore) row.push(typeof point.score === 'number' ? point.score : null)

  const payload = point.payload ?? null
  if (shape.payloadColumns.length > 0) {
    for (const key of shape.payloadColumns) {
      const value = payload === null ? undefined : payload[key]
      row.push(payloadCell(value, shape, point.id, qdrantPayloadField(key)))
    }
  } else {
    row.push(payloadCell(payload, shape, point.id, QDRANT_WHOLE_PAYLOAD_FIELD))
  }

  if (shape.withVector) row.push(vectorCell(point, shape))
  return row
}

/** Estimate a cell's wire size in bytes; feeds core's adaptiveChunkRows */
export function estimateCellBytes(value: unknown): number {
  if (value === null || value === undefined) return 1
  switch (typeof value) {
    case 'boolean':
      return 1
    case 'number':
      return 8
    case 'string':
      return Buffer.byteLength(value, 'utf8')
    case 'object':
      break
    default:
      return 8
  }
  const rec = value as Record<string, unknown>
  const preview = rec['preview']
  // TruncatedValue: only the preview travels
  if (rec['__peekTruncated'] === true && typeof preview === 'string') {
    return Buffer.byteLength(preview, 'utf8') + 64
  }
  const text = safeJson(value)
  return text === null ? 32 : Buffer.byteLength(text, 'utf8')
}

/** Estimate a whole row's wire size */
export function estimateRowBytes(row: readonly unknown[]): number {
  let total = 0
  for (const cell of row) total += estimateCellBytes(cell)
  return total
}

/** The ValueRef addressing one field of one point; the entry point for valuePeek from a cell. */
export function pointFieldRef(collection: string, id: string | number, field: string): ValueRef {
  return { kind: 'qdrantPoint', collection, pointId: id, field }
}

export { VECTOR_RESULT_COLUMNS }
