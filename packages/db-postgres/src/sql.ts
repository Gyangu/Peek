import { peekErrorMsg, type FilterSpec, type RelationRef, type SortSpec } from '@peek/core'

/**
 * SQL fragment construction.
 *
 * The one rule: **values always travel as $n parameters, never as concatenated
 * text**; identifiers go through quoteIdent's double-quote escaping. Not a single
 * line in this file interpolates a user-supplied value into SQL text.
 */

/** Parameter collector: add(v) returns the matching '$n' placeholder */
export class ParamList {
  private readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }

  /** Preload parameters that already exist (e.g. the params tabularQuery passes through) */
  seed(values: readonly unknown[]): void {
    for (const v of values) this.values.push(v)
  }

  get list(): unknown[] {
    return this.values
  }

  get count(): number {
    return this.values.length
  }
}

/** No literal NUL byte in the source; this is what the containment check compares against */
const NUL_CHAR = String.fromCharCode(0)

/**
 * Quote an identifier: wrap in double quotes and double any embedded ones, which
 * makes spaces, dots and non-ASCII names safe. A NUL byte is the one thing that
 * cannot be escaped safely, so it is rejected outright.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.sql.identifierEmpty')
  if (name.includes(NUL_CHAR)) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.identifierInvalid', { name: JSON.stringify(name) })
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** Fully qualified schema.table; an empty schema yields the bare table name (resolved through search_path) */
export function qualifiedName(ref: RelationRef): string {
  return ref.schema ? `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}` : quoteIdent(ref.name)
}

/** Literal text for a regclass parameter (bound as $1, never interpolated into SQL) */
export function relationLiteral(ref: RelationRef): string {
  return qualifiedName(ref)
}

function requireValue(f: FilterSpec): unknown {
  if (f.value === undefined) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterMissingValue', { column: f.column, op: f.op })
  }
  return f.value
}

/** One filter → one SQL fragment */
export function renderFilter(f: FilterSpec, p: ParamList): string {
  const col = quoteIdent(f.column)
  switch (f.op) {
    case 'isNull':
      return `${col} IS NULL`
    case 'isNotNull':
      return `${col} IS NOT NULL`
    case 'eq':
      return `${col} = ${p.add(requireValue(f))}`
    case 'neq':
      return `${col} IS DISTINCT FROM ${p.add(requireValue(f))}`
    case 'lt':
      return `${col} < ${p.add(requireValue(f))}`
    case 'lte':
      return `${col} <= ${p.add(requireValue(f))}`
    case 'gt':
      return `${col} > ${p.add(requireValue(f))}`
    case 'gte':
      return `${col} >= ${p.add(requireValue(f))}`
    case 'like':
      return `${col}::text LIKE ${p.add(String(requireValue(f)))}`
    case 'ilike':
      return `${col}::text ILIKE ${p.add(String(requireValue(f)))}`
    case 'contains':
      // Wildcards carry no meaning here: strpos does a plain substring match, so
      // % and _ typed by the user stay literal
      return `strpos(${col}::text, ${p.add(String(requireValue(f)))}) > 0`
    case 'in': {
      const raw = requireValue(f)
      if (!Array.isArray(raw)) {
        throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterValueNotArray', { column: f.column })
      }
      if (raw.length === 0) return 'false'
      // Expand to IN ($1,$2,…): parameterizing each element separately lets PG
      // infer the parameter types from the column
      const holes = raw.map((v) => p.add(v)).join(', ')
      return `${col} IN (${holes})`
    }
  }
}

export function renderWhere(filters: readonly FilterSpec[] | undefined, p: ParamList): string {
  if (!filters || filters.length === 0) return ''
  return ` WHERE ${filters.map((f) => renderFilter(f, p)).join(' AND ')}`
}

export function renderOrderBy(sorts: readonly SortSpec[] | undefined): string {
  if (!sorts || sorts.length === 0) return ''
  const parts = sorts.map((s) => {
    const dir = s.dir === 'desc' ? 'DESC' : 'ASC'
    const nulls = s.nulls === 'first' ? ' NULLS FIRST' : s.nulls === 'last' ? ' NULLS LAST' : ''
    return `${quoteIdent(s.column)} ${dir}${nulls}`
  })
  return ` ORDER BY ${parts.join(', ')}`
}

export interface ScanSqlInput {
  ref: RelationRef
  filter?: readonly FilterSpec[]
  sort?: readonly SortSpec[]
  columns?: readonly string[]
  offset?: number
  limit?: number
}

export interface ScanSql {
  text: string
  params: unknown[]
  /** The offset / limit actually applied, used to compute nextCursor */
  offset: number
  limit?: number
}

/** collectionScan → SELECT statement. Every value parameterized, every identifier quoted. */
export function buildScanSql(input: ScanSqlInput): ScanSql {
  const p = new ParamList()
  const cols = input.columns && input.columns.length > 0 ? input.columns.map(quoteIdent).join(', ') : '*'
  const where = renderWhere(input.filter, p)
  const order = renderOrderBy(input.sort)

  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit))

  let tail = ''
  if (limit !== undefined) tail += ` LIMIT ${p.add(limit)}`
  if (offset > 0) tail += ` OFFSET ${p.add(offset)}`

  return {
    text: `SELECT ${cols} FROM ${qualifiedName(input.ref)}${where}${order}${tail}`,
    params: p.list,
    offset,
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * Subquery that isolates one row of a result set: wrap the original statement and
 * rename its columns positionally, so that c0/c1/… addresses column `col`
 * unambiguously even when the original statement has duplicate column names.
 */
export function wrapResultRow(text: string, columnCount: number, offsetPlaceholder: string): string {
  const aliases = Array.from({ length: columnCount }, (_, i) => `c${i}`).join(', ')
  return `SELECT * FROM (${text}) AS _peek_src(${aliases}) OFFSET ${offsetPlaceholder} LIMIT 1`
}

/** Coerce a scalar expression to bytea so substring can slice it by byte */
export function toByteaExpr(expr: string, binary: boolean): string {
  return binary ? `(${expr})::bytea` : `convert_to((${expr})::text, 'UTF8')`
}
