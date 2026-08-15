import {
  VALUE_PEEK_MAX_BYTES,
  peekError,
  peekErrorMsg,
  type ByteRange,
  type ColumnDef,
  type PeekedValue,
  type ResultId,
  type ValueRef,
} from '@peek/core'
import type { Pool } from 'pg'
import { mapPgError } from './errors'
import type { PgIntrospector } from './introspect'
import { ParamList, qualifiedName, quoteIdent, toByteaExpr, wrapResultRow } from './sql'
import type { PgTypeCatalog } from './type-catalog'

/**
 * valuePeek: fetch the full value behind a truncated cell, addressed by ValueRef.
 *
 * The essential part is that **the byte slicing happens on the server** — the
 * target scalar is coerced to bytea and then `substring`ed, so even a 200MB jsonb
 * cell puts only the requested window on the wire instead of blowing up the
 * driver process.
 */

/** The statement behind a query or scan, kept so a resultCell can be resolved back to its source */
export interface ResultSource {
  text: string
  params: unknown[]
  /** First-frame schema; when unknown, peek probes for it once */
  columns: ColumnDef[] | null
}

export interface PeekDeps {
  pool: Pool
  catalog: PgTypeCatalog
  introspector: PgIntrospector
  sources: Map<ResultId, ResultSource>
}

interface ScalarTarget {
  /** SQL yielding the single scalar column `b` (FROM / WHERE / LIMIT 1 included) */
  inner: string
  params: ParamList
  /** Type information for the target column; decides the encoding */
  column: Pick<ColumnDef, 'logical' | 'nativeType'>
}

function clampRange(range: ByteRange | undefined): { offset: number; length: number } {
  const offset = Math.max(0, Math.trunc(range?.offset ?? 0))
  const wanted = range?.length === undefined ? VALUE_PEEK_MAX_BYTES : Math.trunc(range.length)
  const length = Math.min(VALUE_PEEK_MAX_BYTES, Math.max(0, wanted))
  return { offset, length }
}

function contentTypeOf(col: Pick<ColumnDef, 'logical' | 'nativeType'>): string {
  if (col.logical === 'json') return 'application/json'
  if (col.logical === 'bytes') return 'application/octet-stream'
  return 'text/plain'
}

export class PgValuePeeker {
  private readonly deps: PeekDeps

  constructor(deps: PeekDeps) {
    this.deps = deps
  }

  async peek(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    const target = await this.resolve(ref)
    const { offset, length } = clampRange(range)
    const binary = target.column.nativeType === 'bytea'

    const p = target.params
    const fromPh = p.add(offset + 1)
    const forPh = p.add(length)
    const sql =
      `SELECT octet_length(b) AS total,` +
      ` substring(b from ${fromPh}::int for ${forPh}::int) AS part` +
      ` FROM (${target.inner}) AS _peek_val`

    let rows: { total: number | string | null; part: Uint8Array | null }[]
    try {
      const res = await this.deps.pool.query<{
        total: number | string | null
        part: Uint8Array | null
      }>(sql, p.list)
      rows = res.rows
    } catch (err) {
      throw mapPgError(err, { sql })
    }

    const row = rows.length > 0 ? rows[0] : undefined
    if (!row) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')

    const total = row.total === null ? 0 : Number(row.total)
    const part = row.part ?? new Uint8Array(0)
    const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength)

    const encoding: PeekedValue['encoding'] = binary
      ? 'base64'
      : target.column.logical === 'json'
        ? 'json'
        : 'utf8'
    const data = binary ? buf.toString('base64') : new TextDecoder('utf-8').decode(buf)

    return {
      ref,
      encoding,
      data,
      byteLength: buf.byteLength,
      totalBytes: Number.isFinite(total) ? total : 0,
      contentType: contentTypeOf(target.column),
      eof: offset + buf.byteLength >= total,
    }
  }

  /** Translate a ValueRef into a subquery that yields the single bytea scalar `b` */
  private async resolve(ref: ValueRef): Promise<ScalarTarget> {
    switch (ref.kind) {
      case 'resultCell':
        return this.resolveResultCell(ref)
      case 'relationCell':
        return this.resolveRelationCell(ref)
      case 'redisValue':
      case 'qdrantPoint':
        // No catalog key covers this: it can only be reached by pointing a
        // PostgreSQL connection at another driver's ValueRef, which is a wiring
        // bug rather than something a user can act on. Plain English literal.
        throw peekError('BAD_REQUEST', `The PostgreSQL driver does not support ${ref.kind} value references`)
    }
  }

  private async resolveResultCell(ref: Extract<ValueRef, { kind: 'resultCell' }>): Promise<ScalarTarget> {
    const src = this.deps.sources.get(ref.resultId)
    if (!src) {
      throw peekErrorMsg('NOT_FOUND', 'error.result.stale', { resultId: ref.resultId })
    }
    const columns = src.columns ?? (await this.probeColumns(src))
    const col = columns[ref.col]
    if (!col) {
      throw peekErrorMsg('BAD_REQUEST', 'error.value.columnOutOfRange', {
        col: ref.col,
        total: columns.length,
      })
    }

    const p = new ParamList()
    p.seed(src.params)
    const offsetPh = p.add(ref.row)
    const rowSql = wrapResultRow(src.text, columns.length, offsetPh)
    const bexpr = toByteaExpr(`c${ref.col}`, col.nativeType === 'bytea')
    return {
      inner: `SELECT ${bexpr} AS b FROM (${rowSql}) AS _peek_row`,
      params: p,
      column: col,
    }
  }

  /** Probe the RowDescription with LIMIT 0: column information only, no rows */
  private async probeColumns(src: ResultSource): Promise<ColumnDef[]> {
    const sql = `SELECT * FROM (${src.text}) AS _peek_probe LIMIT 0`
    try {
      const res = await this.deps.pool.query<unknown[], unknown[]>({
        text: sql,
        values: [...src.params],
        rowMode: 'array',
      })
      const columns: ColumnDef[] = res.fields.map((f) => ({
        name: f.name,
        logical: this.deps.catalog.logical(f.dataTypeID),
        nativeType: this.deps.catalog.nativeType(f.dataTypeID),
      }))
      src.columns = columns
      return columns
    } catch (err) {
      throw mapPgError(err, { sql, fallback: 'NOT_FOUND' })
    }
  }

  private async resolveRelationCell(ref: Extract<ValueRef, { kind: 'relationCell' }>): Promise<ScalarTarget> {
    const info = await this.deps.introspector.describeCollection(ref.collection)
    const col = info.columns.find((c) => c.name === ref.column)
    if (!col) {
      throw peekErrorMsg('NOT_FOUND', 'error.value.columnNotFound', { column: ref.column })
    }
    const pkEntries = Object.entries(ref.pk)
    if (pkEntries.length === 0) {
      throw peekErrorMsg('BAD_REQUEST', 'error.value.primaryKeyRequired')
    }
    const known = new Set(info.columns.map((c) => c.name))
    const p = new ParamList()
    const conds = pkEntries.map(([k, v]) => {
      if (!known.has(k)) throw peekErrorMsg('BAD_REQUEST', 'error.value.primaryKeyNotFound', { column: k })
      return `${quoteIdent(k)} = ${p.add(v)}`
    })
    const bexpr = toByteaExpr(quoteIdent(ref.column), col.nativeType === 'bytea')
    const inner =
      `SELECT ${bexpr} AS b FROM ${qualifiedName(ref.collection)}` + ` WHERE ${conds.join(' AND ')} LIMIT 1`
    return { inner, params: p, column: col }
  }
}
