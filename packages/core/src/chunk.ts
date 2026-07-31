import type { ResultId } from './ids'
import type { PeekError } from './errors'
// Note: this is a *type-only* cycle (chunk ↔ capability). It is erased at compile
// time, so there is no runtime circular import.
import type { ValueRef } from './capability'

export type { ResultId } from './ids'

/* ------------------------------------------------------------------ */
/* Column definitions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Logical type: a thin, driver-independent bucketing whose only job is to decide
 * how a value renders (right-align? monospace? collapse the JSON? offer
 * valuePeek?). It carries no semantic precision — read `nativeType` when you need
 * the exact type.
 */
export type LogicalType =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'json'
  | 'bytes'
  | 'uuid'
  | 'array'
  | 'vector'
  | 'geo'
  | 'unknown'

export interface ColumnDef {
  /** Column name, unique within the result set; a driver hitting duplicates must disambiguate itself (name, name__2) */
  name: string
  /** Logical type, used for rendering */
  logical: LogicalType
  /** The driver's own type name, e.g. pg's 'int8' / 'jsonb' / 'timestamptz' */
  nativeType: string
  nullable?: boolean
  /** This column may contain truncated large values (so the frontend can wire up a valuePeek entry point ahead of time) */
  peekable?: boolean
  /** Part of the primary key; drivers may report it during collectionScan and the frontend uses it to address rows */
  primaryKey?: boolean
}

/* ------------------------------------------------------------------ */
/* Chunk frames (columnar)                                             */
/* ------------------------------------------------------------------ */

export interface ChunkDone {
  /** Total rows in this result set */
  rows: number
  /** Milliseconds from start to finish, measured by the driver host */
  elapsedMs: number
  /** Cut short by the maxRows ceiling (more data is still available) */
  truncated?: boolean
  /** Continuation cursor (redis SCAN cursor / qdrant next_page_offset); present means more can be fetched */
  nextCursor?: string
}

/**
 * One frame of a result stream. Stored **column-wise**, which leaves room to move
 * to Arrow / ArrayBuffer later.
 *
 * Contract (implementers must honour all of it):
 * - `schema` appears only on the first frame, the one with seq === 0; later frames
 *   never repeat it.
 * - `cols.length === schema.length`, and every `cols[i].length === rowCount`.
 * - The last frame carries `done`. **That is the one and only signal that a result
 *   set ended normally** — even an empty result set must emit a frame (one empty
 *   array per column, rowCount 0, with `done`).
 * - Abnormal termination goes through the error branch of `ResultStreamMessage`;
 *   no frame with `done` follows it.
 * - `seq` starts at 0 and increments by one, so the receiver can detect a dropped
 *   frame.
 */
export interface ChunkFrame {
  resultId: ResultId
  seq: number
  /** First frame only */
  schema?: ColumnDef[]
  /** Column-major: cols[columnIndex][rowIndex] */
  cols: unknown[][]
  /** Rows in this frame (`cols` may itself be empty, so the count has to be explicit) */
  rowCount: number
  /** Last frame only */
  done?: ChunkDone
}

/* ------------------------------------------------------------------ */
/* Truncation of large values                                          */
/* ------------------------------------------------------------------ */

/** Name of the discriminant field; its value must be the literal `true` */
export const TRUNCATED_MARKER = '__peekTruncated' as const

/**
 * How a value too large for a cell (long text / bytea / a vector) appears inside a
 * chunk. The driver sends a preview only; the full value is pulled on demand
 * through valuePeek.
 */
export interface TruncatedValue {
  readonly __peekTruncated: true
  /** The preview, already cut to VALUE_PREVIEW_BYTES */
  preview: string
  /** How `preview` is encoded; byte-ish types use base64 */
  encoding: 'utf8' | 'base64'
  /** Full byte length of the original value, when it can be determined */
  byteLength?: number
  /** Address to fetch the value in full */
  ref?: ValueRef
}

export function isTruncatedValue(value: unknown): value is TruncatedValue {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>)[TRUNCATED_MARKER] === true
}

export function truncatedValue(
  preview: string,
  encoding: TruncatedValue['encoding'],
  extra?: Pick<TruncatedValue, 'byteLength' | 'ref'>,
): TruncatedValue {
  return { __peekTruncated: true, preview, encoding, ...extra }
}

/* ------------------------------------------------------------------ */
/* Result-stream messages (driver host ──MessagePort──► renderer)       */
/* ------------------------------------------------------------------ */

/**
 * Description of a result stream that **paused by design**.
 *
 * The line between this and an error is a hard semantic boundary:
 * - error  = the execution failed; what arrived is incomplete and possibly untrustworthy.
 * - paused = nothing went wrong; backpressure simply stopped the stream (the
 *   viewport stopped moving, or the cache filled up) and the server-side cursor and
 *   connection were released on purpose. **Every row already loaded is valid**, and
 *   re-running the query resumes fetching.
 *
 * The reason this is its own message instead of a reuse of `error`: when the AI
 * reads the receipt over MCP it has to be able to tell "the query died" apart from
 * "it just stopped, and the 900,000 rows already loaded are good".
 */
export interface ResultPause {
  /** Rows emitted before the pause */
  rows: number
  /** Milliseconds from start to pause */
  elapsedMs: number
  /** Why it paused; currently only "idle ack timeout" */
  reason: 'idleAck'
  /** Human-readable explanation */
  message: string
  /** Always true: re-running fetches the data again from the start (PG's cursor is closed, so there is no true resume-from-offset) */
  resumable: true
}

/** host → renderer: the data plane. The control plane (state-machine changes) goes through main instead. */
export type ResultStreamMessage =
  | { t: 'chunk'; frame: ChunkFrame }
  | { t: 'error'; resultId: ResultId; error: PeekError }
  /** Backpressure stopped the stream: not an error, and the rows already received are entirely valid */
  | { t: 'paused'; resultId: ResultId; paused: ResultPause }

/** renderer → host: backpressure and cancellation. */
export type ResultStreamAck =
  /** Confirms consumption through `seq` (inclusive); the host advances its ack window on this */
  | { t: 'ack'; resultId: ResultId; seq: number }
  /** Explicit cancellation; the host closes the cursor */
  | { t: 'cancel'; resultId: ResultId }

/* ------------------------------------------------------------------ */
/* Performance-budget constants (PLAN §8 — these are hard limits)      */
/* ------------------------------------------------------------------ */

/** Backpressure ack window: once this many chunks are unacknowledged, stop pulling */
export const ACK_WINDOW = 4

/** Lower bound on a chunk's target byte size: 256KB */
export const CHUNK_TARGET_BYTES_MIN = 256 * 1024
/** Upper bound on a chunk's target byte size: 1MB */
export const CHUNK_TARGET_BYTES_MAX = 1024 * 1024
/** Lower bound on a chunk's target row count */
export const CHUNK_TARGET_ROWS_MIN = 500
/** Upper bound on a chunk's target row count */
export const CHUNK_TARGET_ROWS_MAX = 2000
/** Opening row count, used before any row width has been measured */
export const CHUNK_DEFAULT_ROWS = 1000

/** Preview cutoff for a single large value: 4KB */
export const VALUE_PREVIEW_BYTES = 4 * 1024

/** Renderer result-cache ceiling, ~200MB; past it, distant chunks are evicted LRU */
export const RESULT_CACHE_MAX_BYTES = 200 * 1024 * 1024

/** Maximum bytes one valuePeek call may fetch, so a single value cannot blow up memory */
export const VALUE_PEEK_MAX_BYTES = 8 * 1024 * 1024

/**
 * Server-side default ceiling applied when an MCP `run_query` caller omits maxRows.
 *
 * Without this gate, one `select *` from the AI against a ten-million-row table
 * lands in the backpressure-pause path every time: the viewport covers a few dozen
 * rows, so hundreds of thousands of rows sit permanently unconsumed ahead of it.
 * An explicit default plus `truncated: true` turns "you didn't say how many rows"
 * into "here are the first 200,000, and there are more". Running a statement by
 * hand in the window is not subject to this — that path has a real viewport driving
 * consumption forward.
 */
export const MCP_DEFAULT_MAX_ROWS = 200_000

/** Default page size for collectionScan and the table view */
export const DEFAULT_PAGE_LIMIT = 200
/** Largest limit a single request may ask for */
export const MAX_PAGE_LIMIT = 100_000

/**
 * Given the average row size observed so far, decide how many rows the next batch
 * should hold. Every driver calls this one function, which is what keeps chunk
 * sizing consistent across all four databases.
 */
export function adaptiveChunkRows(avgRowBytes: number): number {
  if (!Number.isFinite(avgRowBytes) || avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
  const target = Math.floor(CHUNK_TARGET_BYTES_MAX / avgRowBytes)
  return Math.min(CHUNK_TARGET_ROWS_MAX, Math.max(CHUNK_TARGET_ROWS_MIN, target))
}
