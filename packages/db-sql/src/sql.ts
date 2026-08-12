import { peekErrorMsg, type FilterSpec, type RelationRef, type SortSpec } from '@peek/core'
import type { SqlDialect } from './dialect'

/**
 * Statement construction, shared by both dialects.
 *
 * The same rule as db-postgres's sql.ts, restated because it is the one thing
 * that must not slip: **values always travel as bound parameters, never as
 * concatenated text**, and identifiers always go through the dialect's
 * `quoteIdent`. The only integers ever inlined are LIMIT / OFFSET, which peek
 * computed itself and truncated (see `SqlDialect.renderLimitOffset` for why the
 * dialect gets to decide even that).
 */

/**
 * Parameter collector. Unlike the PostgreSQL version it holds no placeholder
 * knowledge of its own — `add` asks the dialect, so `?` and `$n` are the same
 * code path.
 */
export class ParamList {
  private readonly dialect: SqlDialect
  private readonly values: unknown[] = []

  constructor(dialect: SqlDialect) {
    this.dialect = dialect
  }

  add(value: unknown): string {
    this.values.push(value)
    return this.dialect.placeholder(this.values.length)
  }

  /** Preload parameters that already exist (the params `tabularQuery` passes through) */
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

/** No literal NUL byte in the source; this is what the identifier check compares against */
export const NUL_CHAR = String.fromCharCode(0)

/**
 * Shared identifier guard, called by every dialect's `quoteIdent` before it
 * applies its own quoting style. An empty name and an embedded NUL are rejected
 * here so the two dialects cannot disagree about which names are addressable.
 */
export function assertIdentifier(name: string): void {
  if (name.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.sql.identifierEmpty')
  if (name.includes(NUL_CHAR)) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.identifierInvalid', { name: JSON.stringify(name) })
  }
}

/** A filter's value, or BAD_REQUEST when the operator needs one and it is missing */
export function requireFilterValue(f: FilterSpec): unknown {
  if (f.value === undefined) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterMissingValue', { column: f.column, op: f.op })
  }
  return f.value
}

/** The array an `in` filter requires, or BAD_REQUEST */
export function requireFilterArray(f: FilterSpec): readonly unknown[] {
  const raw = requireFilterValue(f)
  if (!Array.isArray(raw)) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterValueNotArray', { column: f.column })
  }
  return raw as readonly unknown[]
}

export function renderWhere(
  dialect: SqlDialect,
  filters: readonly FilterSpec[] | undefined,
  params: unknown[],
): string {
  if (!filters || filters.length === 0) return ''
  return ` WHERE ${filters.map((f) => dialect.renderFilter(f, params)).join(' AND ')}`
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
  /** The offset / limit actually applied; `nextCursor` is computed from them */
  offset: number
  limit?: number
}

/**
 * `collectionScan` → one SELECT statement.
 *
 * Paging is `LIMIT`/`OFFSET`, and `ChunkDone.nextCursor` is the absolute offset
 * of the next page as a decimal string — exactly what db-postgres does, so
 * the three SQL drivers hand back interchangeable cursor tokens and the table
 * view needs no per-driver branch.
 *
 * (Keyset pagination would be faster on a deep offset, but it requires a unique
 * sort key the caller may not have chosen, and silently changing the row order to
 * get one would be a wrong answer rather than a slow one.)
 */
export function buildScanSql(dialect: SqlDialect, input: ScanSqlInput): ScanSql {
  const p = new ParamList(dialect)
  const cols = input.columns && input.columns.length > 0
    ? input.columns.map((c) => dialect.quoteIdent(c)).join(', ')
    : '*'
  const where = renderWhere(dialect, input.filter, p.list)
  const order = dialect.renderOrderBy(input.sort)

  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit))
  const tail = dialect.renderLimitOffset(limit, offset, p.list)

  return {
    text: `SELECT ${cols} FROM ${dialect.qualify(input.ref)}${where}${order}${tail}`,
    params: p.list,
    offset,
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * Wrap an arbitrary statement so one row of its result can be re-fetched by
 * absolute position.
 *
 * This is how `valuePeek` resolves a `resultCell` ref once the chunk that carried
 * it has been evicted: re-run the statement, skip to the row, take one.
 *
 * ## Why the column is *not* selected in SQL
 *
 * db-postgres aliases the derived table's columns positionally
 * (`AS t(c0, c1, …)`) and then slices the wanted one server-side. That column
 * alias list is a PostgreSQL extension — MySQL rejects it — and without it there
 * is no portable way to name the n-th output column of an arbitrary statement,
 * since a statement may perfectly well produce two columns called `id`.
 *
 * So the SQL layer returns the **whole row** and the peeker picks column `n` out
 * of the row array (rows are row-major arrays precisely so that works), slicing
 * the bytes in the driver process. The cost is bounded: one row, and
 * `VALUE_PEEK_MAX_BYTES` caps what leaves the process.
 *
 * A `relationCell` ref does not go through here at all — there the table and the
 * column name are both known, so the slice happens server-side through
 * `SqlDialect.byteSliceExpr`, which is what a genuinely large blob needs.
 */
export function wrapResultRow(
  dialect: SqlDialect,
  text: string,
  offset: number,
  params: unknown[],
): string {
  const tail = dialect.renderLimitOffset(1, Math.max(0, Math.trunc(offset)), params)
  return `SELECT * FROM (${text}) AS _peek_src${tail}`
}
