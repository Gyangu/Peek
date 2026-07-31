import {
  VALUE_PEEK_MAX_BYTES,
  peekError,
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
 * valuePeek：按 ValueRef 取回被截断的完整值。
 *
 * 关键点是**字节切片在服务端完成**——把目标标量统一转成 bytea 再 substring，
 * 这样即使单元格是 200MB 的 jsonb，也只有请求的那一段过网，不会把驱动进程撑爆。
 */

/** 一次查询/扫描的来源语句，供 resultCell 回源 */
export interface ResultSource {
  text: string
  params: unknown[]
  /** 首帧 schema；未知时 peek 会自己探一次 */
  columns: ColumnDef[] | null
}

export interface PeekDeps {
  pool: Pool
  catalog: PgTypeCatalog
  introspector: PgIntrospector
  sources: Map<ResultId, ResultSource>
}

interface ScalarTarget {
  /** 产出单个标量列 b 的 SQL（已含 FROM / WHERE / LIMIT 1） */
  inner: string
  params: ParamList
  /** 目标列的类型信息，决定编码方式 */
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
    if (!row) throw peekError('NOT_FOUND', '目标值不存在（行已被删除或结果集已变化）')

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

  /** 把 ValueRef 翻译成"产出单个 bytea 标量 b"的子查询 */
  private async resolve(ref: ValueRef): Promise<ScalarTarget> {
    switch (ref.kind) {
      case 'resultCell':
        return this.resolveResultCell(ref)
      case 'relationCell':
        return this.resolveRelationCell(ref)
      case 'redisValue':
      case 'qdrantPoint':
        throw peekError(
          'BAD_REQUEST',
          `PostgreSQL 驱动不支持 ${ref.kind} 形式的 ValueRef`,
        )
    }
  }

  private async resolveResultCell(
    ref: Extract<ValueRef, { kind: 'resultCell' }>,
  ): Promise<ScalarTarget> {
    const src = this.deps.sources.get(ref.resultId)
    if (!src) {
      throw peekError('NOT_FOUND', `结果集 ${ref.resultId} 已失效，无法回源取值`)
    }
    const columns = src.columns ?? (await this.probeColumns(src))
    const col = columns[ref.col]
    if (!col) {
      throw peekError('BAD_REQUEST', `列下标越界: ${ref.col}（共 ${columns.length} 列）`)
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

  /** 用 LIMIT 0 探一次 RowDescription，只拿列信息，不拉数据 */
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

  private async resolveRelationCell(
    ref: Extract<ValueRef, { kind: 'relationCell' }>,
  ): Promise<ScalarTarget> {
    const info = await this.deps.introspector.describeCollection(ref.collection)
    const col = info.columns.find((c) => c.name === ref.column)
    if (!col) {
      throw peekError('NOT_FOUND', `列不存在: ${ref.column}`)
    }
    const pkEntries = Object.entries(ref.pk)
    if (pkEntries.length === 0) {
      throw peekError('BAD_REQUEST', 'relationCell 必须给出主键值')
    }
    const known = new Set(info.columns.map((c) => c.name))
    const p = new ParamList()
    const conds = pkEntries.map(([k, v]) => {
      if (!known.has(k)) throw peekError('BAD_REQUEST', `主键列不存在: ${k}`)
      return `${quoteIdent(k)} = ${p.add(v)}`
    })
    const bexpr = toByteaExpr(quoteIdent(ref.column), col.nativeType === 'bytea')
    const inner =
      `SELECT ${bexpr} AS b FROM ${qualifiedName(ref.collection)}` +
      ` WHERE ${conds.join(' AND ')} LIMIT 1`
    return { inner, params: p, column: col }
  }
}
