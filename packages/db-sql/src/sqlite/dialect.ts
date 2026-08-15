import type { CollectionSchemaInfo, LogicalType, PeekErrorCode, RelationRef, SortSpec } from '@peek/core'
import type { FilterSpec, SqlColumnMeta, SqlDialect, SqlRelationInfo, SqlText } from '../dialect'
import { assertIdentifier, requireFilterArray, requireFilterValue } from '../sql'
import { cellBool, cellNumber, cellText, columnIndex } from '../values'

/**
 * The SQLite dialect.
 *
 * SQLite differs from MySQL in more than syntax, and two of those differences are
 * contract decisions rather than implementation details:
 *
 * 1. **There is no row-count statistic.** `information_schema.TABLES.TABLE_ROWS`
 *    has no counterpart; the only way to know is `count(*)`, i.e. a full scan.
 *    So `relationMetaSql` reports NULL and the tree shows no row estimate. That
 *    is the honest answer, and it keeps expanding a database off the critical
 *    path of a multi-gigabyte file (PLAN section 8).
 * 2. **Columns have no runtime type.** A column has a *declared* type with
 *    affinity rules, and an expression has no declared type at all, so `logical()`
 *    maps by affinity and the backend refines from the JS type of the first
 *    non-null value it sees.
 */

/** SQLite's default schema. `RelationRef.schema` is normalized to this, never left empty. */
export const SQLITE_DEFAULT_SCHEMA = 'main'

/**
 * SQLite type affinity (the rules in the "Determination of Column Affinity"
 * section of the SQLite docs, in the same order — the order is what makes
 * `VARCHAR(20)` TEXT and `FLOATING POINT` REAL rather than INTEGER).
 */
export function sqliteAffinity(declared: string | null): 'integer' | 'text' | 'blob' | 'real' | 'numeric' {
  const t = (declared ?? '').toUpperCase()
  if (t.length === 0) return 'blob'
  if (t.includes('INT')) return 'integer'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text'
  if (t.includes('BLOB')) return 'blob'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real'
  return 'numeric'
}

/**
 * Declared types peek recognizes beyond the affinity rules.
 *
 * Affinity alone would render a `DATETIME` column as a number and a `JSON` column
 * as text. Neither is wrong at the storage level — SQLite really does store them
 * that way — but the grid can do better with a hint, and these spellings are the
 * conventions every SQLite tool already writes.
 */
const SQLITE_DECLARED_LOGICAL: Readonly<Record<string, LogicalType>> = {
  date: 'date',
  time: 'time',
  datetime: 'timestamp',
  timestamp: 'timestamp',
  json: 'json',
  jsonb: 'json',
  uuid: 'uuid',
  boolean: 'boolean',
  bool: 'boolean',
}

/**
 * SQLite's primary result codes, as `node:sqlite` reports them on `err.errcode`.
 * `err.code` is always `'ERR_SQLITE_ERROR'`, which says nothing, so the numeric
 * code is the one that has to be switched on here.
 */
const SQLITE_ERRCODES: Readonly<Record<number, PeekErrorCode>> = {
  1: 'QUERY_FAILED', // SQLITE_ERROR — generic; a missing table arrives as this too
  3: 'UNSUPPORTED_CAPABILITY', // SQLITE_PERM
  5: 'CONFLICT', // SQLITE_BUSY
  6: 'CONFLICT', // SQLITE_LOCKED
  8: 'CONFLICT', // SQLITE_READONLY — expected: peek opens read-only on purpose
  9: 'CANCELLED', // SQLITE_INTERRUPT
  10: 'CONNECTION_LOST', // SQLITE_IOERR
  11: 'QUERY_FAILED', // SQLITE_CORRUPT
  14: 'CONNECTION_FAILED', // SQLITE_CANTOPEN
  23: 'UNSUPPORTED_CAPABILITY', // SQLITE_AUTH
  26: 'CONNECTION_FAILED', // SQLITE_NOTADB
}

function quoteIdent(name: string): string {
  assertIdentifier(name)
  return `"${name.replace(/"/g, '""')}"`
}

export const SQLITE_DIALECT: SqlDialect = {
  flavor: 'sqlite',
  displayName: 'SQLite',

  quoteIdent,

  /** An empty schema means `main`; SQLite refs are never schema-less on the wire */
  qualify(ref: RelationRef): string {
    const schema = ref.schema === '' ? SQLITE_DEFAULT_SCHEMA : ref.schema
    return `${quoteIdent(schema)}.${quoteIdent(ref.name)}`
  },

  placeholder(): string {
    return '?'
  },

  /** SQLite spells "no limit" as -1, where MySQL needs 2^64-1 */
  renderLimitOffset(limit: number | undefined, offset: number): string {
    const off = Math.max(0, Math.trunc(offset))
    if (limit === undefined) {
      return off > 0 ? ` LIMIT -1 OFFSET ${off}` : ''
    }
    const lim = Math.max(0, Math.trunc(limit))
    return off > 0 ? ` LIMIT ${lim} OFFSET ${off}` : ` LIMIT ${lim}`
  },

  renderFilter(f: FilterSpec, params: unknown[]): string {
    const col = quoteIdent(f.column)
    const bind = (value: unknown): string => {
      params.push(value)
      return '?'
    }
    switch (f.op) {
      case 'isNull':
        return `${col} IS NULL`
      case 'isNotNull':
        return `${col} IS NOT NULL`
      case 'eq':
        return `${col} = ${bind(requireFilterValue(f))}`
      // `IS NOT` is SQLite's NULL-safe inequality; `<>` yields NULL against NULL
      case 'neq':
        return `${col} IS NOT ${bind(requireFilterValue(f))}`
      case 'lt':
        return `${col} < ${bind(requireFilterValue(f))}`
      case 'lte':
        return `${col} <= ${bind(requireFilterValue(f))}`
      case 'gt':
        return `${col} > ${bind(requireFilterValue(f))}`
      case 'gte':
        return `${col} >= ${bind(requireFilterValue(f))}`
      case 'like':
        return `${col} LIKE ${bind(String(requireFilterValue(f)))}`
      // SQLite's LIKE folds case for ASCII already; there is no ILIKE to reach for
      case 'ilike':
        return `${col} LIKE ${bind(String(requireFilterValue(f)))}`
      case 'contains':
        return `INSTR(${col}, ${bind(String(requireFilterValue(f)))}) > 0`
      case 'in': {
        const values = requireFilterArray(f)
        if (values.length === 0) return '0 = 1'
        return `${col} IN (${values.map((v) => bind(v)).join(', ')})`
      }
    }
  },

  renderOrderBy(sorts: readonly SortSpec[] | undefined): string {
    if (!sorts || sorts.length === 0) return ''
    const parts = sorts.map((s) => {
      const col = quoteIdent(s.column)
      const dir = s.dir === 'desc' ? 'DESC' : 'ASC'
      // SQLite gained NULLS FIRST/LAST in 3.30; the `IS NULL` form works on every
      // version and on files written by older tools
      const nulls =
        s.nulls === 'first' ? `${col} IS NULL DESC, ` : s.nulls === 'last' ? `${col} IS NULL ASC, ` : ''
      return `${nulls}${col} ${dir}`
    })
    return ` ORDER BY ${parts.join(', ')}`
  },

  logical(meta: SqlColumnMeta): LogicalType {
    const declared = (meta.typeName ?? '').toLowerCase().replace(/\(.*$/, '').trim()
    const known = SQLITE_DECLARED_LOGICAL[declared]
    if (known !== undefined) return known
    switch (sqliteAffinity(meta.typeName)) {
      case 'integer':
        // INTEGER holds up to 64 bits, which is past Number.MAX_SAFE_INTEGER;
        // the backend hands those over as bigint and values.ts renders them
        // losslessly, so the column is labelled bigint rather than number
        return 'bigint'
      case 'real':
        return 'number'
      case 'text':
        return 'string'
      case 'blob':
        return meta.typeName === null ? 'unknown' : 'bytes'
      case 'numeric':
        return 'number'
    }
  },

  /** An expression column has no declared type; `any` is SQLite's own word for that */
  nativeTypeName(meta: SqlColumnMeta): string {
    return meta.typeName === null || meta.typeName === '' ? 'any' : meta.typeName
  },

  /** `main`, `temp`, and anything ATTACHed — the same shape as MySQL's database list */
  listSchemasSql(): SqlText {
    return { text: 'SELECT name FROM pragma_database_list ORDER BY seq', params: [] }
  },

  /**
   * The schema qualifier cannot be bound (`?.sqlite_master` is not a thing), so it
   * goes in as a quoted identifier — the rule is "values are bound, identifiers
   * are quoted", and a schema name is an identifier.
   */
  listRelationsSql(schema: string): SqlText {
    const src = `${quoteIdent(schema === '' ? SQLITE_DEFAULT_SCHEMA : schema)}.sqlite_master`
    return {
      text:
        `SELECT name, type AS kind FROM ${src}` +
        " WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
        ' ORDER BY name',
      params: [],
    }
  },

  /**
   * `pragma_table_info(table, schema)` — the table-valued form of the pragma.
   * A bare `PRAGMA table_info(x)` accepts no bound parameter and would force the
   * table name into the statement text.
   */
  listColumnsSql(ref: RelationRef): SqlText {
    return {
      text:
        'SELECT name, type AS data_type, "notnull" AS not_null, pk' +
        ' FROM pragma_table_info(?, ?) ORDER BY cid',
      params: [ref.name, ref.schema === '' ? SQLITE_DEFAULT_SCHEMA : ref.schema],
    }
  },

  listIndexesSql(ref: RelationRef): SqlText {
    const schema = ref.schema === '' ? SQLITE_DEFAULT_SCHEMA : ref.schema
    return {
      text:
        'SELECT il.name AS name, il."unique" AS is_unique, ii.seqno AS seq,' +
        ' ii.name AS column_name' +
        ' FROM pragma_index_list(?, ?) AS il' +
        ' JOIN pragma_index_info(il.name, ?) AS ii' +
        ' ORDER BY il.seq, ii.seqno',
      params: [ref.name, schema, schema],
    }
  },

  /**
   * No row estimate exists — see the class comment. The statement still runs, so
   * that a relation which does not exist yields zero rows and becomes NOT_FOUND
   * rather than a table view full of nothing.
   */
  relationMetaSql(ref: RelationRef): SqlText {
    const src = `${quoteIdent(ref.schema === '' ? SQLITE_DEFAULT_SCHEMA : ref.schema)}.sqlite_master`
    return {
      text:
        `SELECT NULL AS est_rows, NULL AS comment, type AS kind FROM ${src}` +
        " WHERE name = ? AND type IN ('table', 'view')",
      params: [ref.name],
    }
  },

  decodeSchemas(rows: readonly unknown[][], columns: readonly SqlColumnMeta[]): string[] {
    const idx = columnIndex(columns, 'name')
    if (idx < 0) return []
    const out: string[] = []
    for (const row of rows) {
      const name = cellText(row[idx])
      if (name !== null && name.length > 0) out.push(name)
    }
    return out
  },

  decodeRelations(
    schema: string,
    rows: readonly unknown[][],
    columns: readonly SqlColumnMeta[],
  ): SqlRelationInfo[] {
    const nameIdx = columnIndex(columns, 'name')
    const kindIdx = columnIndex(columns, 'kind')
    if (nameIdx < 0) return []
    const normalized = schema === '' ? SQLITE_DEFAULT_SCHEMA : schema
    const out: SqlRelationInfo[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null || name.length === 0) continue
      out.push({
        schema: normalized,
        name,
        kind: (kindIdx >= 0 ? cellText(row[kindIdx]) : null) === 'view' ? 'view' : 'table',
        // No such statistic exists in SQLite — see the module comment; counting
        // would mean a full scan per node
        estimatedRows: null,
        comment: null,
      })
    }
    return out
  },

  decodeColumns(rows: readonly unknown[][], columns: readonly SqlColumnMeta[]): SqlColumnMeta[] {
    const nameIdx = columnIndex(columns, 'name')
    const typeIdx = columnIndex(columns, 'data_type')
    const notNullIdx = columnIndex(columns, 'not_null')
    const pkIdx = columnIndex(columns, 'pk')
    if (nameIdx < 0) return []
    const out: SqlColumnMeta[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null) continue
      const declared = typeIdx < 0 ? null : cellText(row[typeIdx])
      const meta: SqlColumnMeta = {
        name,
        // A column declared without a type reports '' here; it is the same thing
        // as an expression's absent type, and both must read as `any` / unknown
        // rather than as BLOB affinity's `bytes`
        typeName: declared === null || declared.length === 0 ? null : declared,
      }
      if (notNullIdx >= 0) meta.nullable = !cellBool(row[notNullIdx])
      // `pk` is the 1-based position within the primary key, 0 when not part of it
      if (pkIdx >= 0 && (cellNumber(row[pkIdx]) ?? 0) > 0) meta.primaryKey = true
      out.push(meta)
    }
    return out
  },

  decodeIndexes(
    rows: readonly unknown[][],
    columns: readonly SqlColumnMeta[],
  ): CollectionSchemaInfo['indexes'] {
    const nameIdx = columnIndex(columns, 'name')
    const uniqueIdx = columnIndex(columns, 'is_unique')
    const columnIdx = columnIndex(columns, 'column_name')
    if (nameIdx < 0) return []
    // One row per (index, column), ordered by index then seqno, so appending in
    // arrival order reproduces each index's column order
    const byName = new Map<string, { name: string; columns: string[]; unique: boolean }>()
    const order: string[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null) continue
      let entry = byName.get(name)
      if (!entry) {
        entry = { name, columns: [], unique: uniqueIdx >= 0 && cellBool(row[uniqueIdx]) }
        byName.set(name, entry)
        order.push(name)
      }
      const col = columnIdx < 0 ? null : cellText(row[columnIdx])
      // pragma_index_info reports NULL for an expression or the rowid; there is no
      // name to show, so the slot is skipped rather than filled with a guess
      if (col !== null) entry.columns.push(col)
    }
    return order.map((name) => byName.get(name)).filter((e) => e !== undefined)
  },

  /** `substr` counts bytes only on a BLOB; the cast is what makes the offset mean bytes */
  byteSliceExpr(expr: string, offset: number, length: number, params: unknown[]): string {
    params.push(Math.max(0, Math.trunc(offset)) + 1, Math.max(0, Math.trunc(length)))
    return `substr(CAST(${expr} AS BLOB), ?, ?)`
  },

  byteLengthExpr(expr: string): string {
    return `length(CAST(${expr} AS BLOB))`
  },

  classifyError(_code: string | undefined, errno: number | undefined): PeekErrorCode | null {
    if (errno === undefined) return null
    // Extended result codes are `primary | (sub << 8)`; the low byte is the one
    // with a stable meaning
    return SQLITE_ERRCODES[errno & 0xff] ?? null
  },

  /**
   * `query_only` is belt to the open flag's braces: a handle opened read-write
   * (because the caller did not set `readOnly`, or because the file is a
   * pre-existing WAL database that refuses read-only opens) still cannot write
   * once this is set.
   */
  sessionSetupSql(): readonly string[] {
    return ['PRAGMA query_only = 1']
  },

  serverInfoSql(): SqlText {
    return { text: 'SELECT sqlite_version() AS version', params: [] }
  },
}
