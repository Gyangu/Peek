import {
  VALUE_PEEK_MAX_BYTES,
  peekError,
  peekErrorMsg,
  type ByteRange,
  type ColumnDef,
  type LogicalType,
  type PeekedValue,
  type ValueRef,
} from '@peek/core'
import type { SqlBackendHandle, SqlRows } from './connection'
import type { SqlColumnMeta, SqlDialect } from './dialect'
import { mapSqlError } from './errors'
import { wrapResultRow } from './sql'

/**
 * `valuePeek` for both SQL dialects: fetch one large value in full, or a byte
 * window of it.
 *
 * Two ref kinds reach here, and they are served differently on purpose:
 *
 * - **`relationCell`** — table, primary key and column name are all known, so the
 *   slice happens **on the server** through `SqlDialect.byteSliceExpr`. This is
 *   the path a 200MB blob takes, and it is the only one that scales: the driver
 *   process never holds more than the requested window.
 * - **`resultCell`** — the cell came out of an arbitrary statement. There is no
 *   portable way to name the n-th output column of an arbitrary statement (see
 *   `wrapResultRow` in sql.ts), so the statement is re-run, offset to the row,
 *   and the one row comes back whole; the window is then taken in the driver
 *   process. Bounded by one row, and by `VALUE_PEEK_MAX_BYTES` on the way out.
 *
 * A `redisValue` or `qdrantPoint` ref is BAD_REQUEST here — those belong to other
 * drivers, and quietly returning empty would look like an empty column.
 */

/** The statement behind a result set, kept so a `resultCell` ref can be resolved after eviction */
export interface SqlResultSource {
  text: string
  params: unknown[]
  /** Filled in from the cursor's frame-0 schema once it is known */
  columns: ColumnDef[] | null
}

export interface SqlValuePeekerOptions {
  dialect: SqlDialect
  handle: SqlBackendHandle
  /** Statement per result set; the session owns and evicts this map */
  sources: Map<string, SqlResultSource>
}

/** `ByteRange` clamped to what one call is allowed to move */
function clampRange(range: ByteRange | undefined): { offset: number; length: number } {
  const offset = Math.max(0, Math.trunc(range?.offset ?? 0))
  const wanted = range?.length === undefined ? VALUE_PEEK_MAX_BYTES : Math.trunc(range.length)
  const length = Math.min(VALUE_PEEK_MAX_BYTES, Math.max(0, wanted))
  return { offset, length }
}

function contentTypeOf(logical: LogicalType): string {
  if (logical === 'json') return 'application/json'
  if (logical === 'bytes') return 'application/octet-stream'
  return 'text/plain'
}

function encodingOf(logical: LogicalType): PeekedValue['encoding'] {
  if (logical === 'bytes') return 'base64'
  if (logical === 'json') return 'json'
  return 'utf8'
}

/** Whatever a backend produced for one cell → the raw bytes it stands for */
function toBytes(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.alloc(0)
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (typeof value === 'bigint') return Buffer.from(value.toString(10), 'utf8')
  if (typeof value === 'number' || typeof value === 'boolean') return Buffer.from(String(value), 'utf8')
  if (value instanceof Date) return Buffer.from(value.toISOString(), 'utf8')
  try {
    return Buffer.from(JSON.stringify(value) ?? String(value), 'utf8')
  } catch {
    return Buffer.from(String(value), 'utf8')
  }
}

export class SqlValuePeeker {
  private readonly opts: SqlValuePeekerOptions

  constructor(opts: SqlValuePeekerOptions) {
    this.opts = opts
  }

  async peek(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    switch (ref.kind) {
      case 'relationCell':
        return this.peekRelationCell(ref, clampRange(range))
      case 'resultCell':
        return this.peekResultCell(ref, clampRange(range))
      case 'redisValue':
      case 'qdrantPoint':
        // No catalog key covers this: it can only be reached by pointing a SQL
        // connection at another driver's ValueRef, which is a wiring bug rather
        // than something a user can act on. Plain English literal.
        throw peekError(
          'BAD_REQUEST',
          `The ${this.opts.dialect.flavor} driver does not support ${ref.kind} value references`,
        )
    }
  }

  /**
   * Server-side slice: the only path that survives a genuinely large value.
   *
   * Parameter order is load-bearing. Both dialects use positional `?`, so the
   * values have to be pushed in the order their placeholders appear in the text —
   * the two slice bounds first (they are inside the SELECT list), the primary-key
   * values afterwards.
   */
  private async peekRelationCell(
    ref: Extract<ValueRef, { kind: 'relationCell' }>,
    window: { offset: number; length: number },
  ): Promise<PeekedValue> {
    const { dialect, handle } = this.opts
    const rel =
      ref.collection.schema === '' ? { ...ref.collection, schema: handle.defaultSchema } : ref.collection

    const metas = await this.relationColumns(rel)
    const target = metas.find((m) => m.name === ref.column)
    if (!target) throw peekErrorMsg('NOT_FOUND', 'error.value.columnNotFound', { column: ref.column })

    const pkEntries = Object.entries(ref.pk)
    if (pkEntries.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.value.primaryKeyRequired')
    const known = new Set(metas.map((m) => m.name))

    const params: unknown[] = []
    const expr = dialect.quoteIdent(ref.column)
    const slice = dialect.byteSliceExpr(expr, window.offset, window.length, params)
    const total = dialect.byteLengthExpr(expr)
    const conds = pkEntries.map(([column, value]) => {
      if (!known.has(column)) {
        throw peekErrorMsg('BAD_REQUEST', 'error.value.primaryKeyNotFound', { column })
      }
      params.push(value)
      return `${dialect.quoteIdent(column)} = ${dialect.placeholder(params.length)}`
    })
    const text =
      `SELECT ${total} AS total, ${slice} AS part FROM ${dialect.qualify(rel)}` +
      ` WHERE ${conds.join(' AND ')}${dialect.renderLimitOffset(1, 0, params)}`

    const rows = await this.exec(text, params)
    const row = rows.rows[0]
    if (!row) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')

    const logical = dialect.logical(target)
    const part = toBytes(row[1])
    const totalBytes = numberOrNull(row[0]) ?? part.byteLength + window.offset
    return this.finish(ref, logical, part, window.offset, totalBytes)
  }

  /**
   * Re-run the source statement, skip to the row, take the cell.
   *
   * The window is applied in this process rather than in SQL, because there is no
   * portable way to name the n-th output column of an arbitrary statement (see
   * `wrapResultRow`). The cost is one row.
   */
  private async peekResultCell(
    ref: Extract<ValueRef, { kind: 'resultCell' }>,
    window: { offset: number; length: number },
  ): Promise<PeekedValue> {
    const src = this.opts.sources.get(ref.resultId)
    if (!src) throw peekErrorMsg('NOT_FOUND', 'error.result.stale', { resultId: ref.resultId })

    const params = [...src.params]
    const text = wrapResultRow(this.opts.dialect, src.text, ref.row, params)
    const rows = await this.exec(text, params)
    const row = rows.rows[0]
    if (!row) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')
    if (ref.col < 0 || ref.col >= rows.columns.length) {
      throw peekErrorMsg('BAD_REQUEST', 'error.value.columnOutOfRange', {
        col: ref.col,
        total: rows.columns.length,
      })
    }

    // The cursor's frame-0 schema is the authority on the column's logical type
    // when it is known; the re-run's own metadata is the fallback, and for SQLite
    // it is genuinely all there is (an expression column has no declared type)
    const meta = rows.columns[ref.col]
    const logical = src.columns?.[ref.col]?.logical ?? (meta ? this.opts.dialect.logical(meta) : 'unknown')

    const whole = toBytes(row[ref.col])
    const part = whole.subarray(window.offset, window.offset + window.length)
    return this.finish(ref, logical, Buffer.from(part), window.offset, whole.byteLength)
  }

  /** Column metadata of one relation, read through the dialect's own catalog statement */
  private async relationColumns(
    rel: Extract<ValueRef, { kind: 'relationCell' }>['collection'],
  ): Promise<SqlColumnMeta[]> {
    const { dialect } = this.opts
    const stmt = dialect.listColumnsSql(rel)
    const rows = await this.exec(stmt.text, stmt.params)
    const metas = dialect.decodeColumns(rows.rows, rows.columns)
    if (metas.length === 0) {
      throw peekErrorMsg('NOT_FOUND', 'error.collection.notFound', {
        name: `${rel.schema}.${rel.name}`,
      })
    }
    return metas
  }

  private async exec(text: string, params: readonly unknown[]): Promise<SqlRows> {
    try {
      return await this.opts.handle.exec(text, params)
    } catch (err) {
      throw mapSqlError(this.opts.dialect, err, { sql: text, fallback: 'NOT_FOUND' })
    }
  }

  private finish(
    ref: ValueRef,
    logical: LogicalType,
    part: Buffer,
    offset: number,
    totalBytes: number,
  ): PeekedValue {
    const encoding = encodingOf(logical)
    return {
      ref,
      encoding,
      data: encoding === 'base64' ? part.toString('base64') : new TextDecoder('utf-8').decode(part),
      byteLength: part.byteLength,
      totalBytes,
      contentType: contentTypeOf(logical),
      eof: offset + part.byteLength >= totalBytes,
    }
  }
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}
