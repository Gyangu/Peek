import type { CollectionSchemaInfo, LogicalType, PeekErrorCode, RelationRef, SortSpec } from '@peek/core'
import type {
  FilterSpec,
  SqlColumnMeta,
  SqlDialect,
  SqlRelationInfo,
  SqlText,
} from '../dialect'
import { assertIdentifier, requireFilterArray, requireFilterValue } from '../sql'
import { cellBool, cellNumber, cellText, columnIndex } from '../values'

/**
 * The MySQL dialect.
 *
 * Everything here is pure, so all of it is assertable in a unit test with no
 * server running — which is the point of the dialect/backend split (see
 * dialect.ts).
 */

/** Server-owned schemas: never shown at the root of the tree */
export const MYSQL_SYSTEM_SCHEMAS: readonly string[] = [
  'information_schema',
  'performance_schema',
  'mysql',
  'sys',
]

/**
 * MySQL's "no limit" sentinel.
 *
 * `OFFSET` without `LIMIT` is a syntax error in MySQL, and the documented
 * workaround is a limit of 2^64-1. SQLite spells the same idea `LIMIT -1`, which
 * is precisely why `renderLimitOffset` is a dialect method and not shared code.
 */
const MYSQL_MAX_LIMIT = '18446744073709551615'

/**
 * Statement ceiling, mirroring the PostgreSQL driver's `statement_timeout`
 * backstop: without one, a runaway `SELECT` holds its connection until the
 * server's own wait timeout, which is typically eight hours.
 */
const MAX_EXECUTION_TIME_MS = 300_000

/**
 * The statements that make a borrowed connection safe for one statement.
 *
 * Both of them have to be re-issued **per checkout**, not once per physical
 * connect, and that is the whole reason this is a function taking a budget:
 *
 * - `SET SESSION TRANSACTION READ ONLY` is session state a user statement can
 *   undo (`SET SESSION TRANSACTION READ WRITE` typed into the query editor), and
 *   the connection then goes back to the pool writable. Re-asserting on every
 *   borrow is what makes the read-only guarantee survive a pooled connection.
 * - `max_execution_time` is how a per-statement `timeoutMs` reaches MySQL at all.
 *   It is a session variable, so it also persists on a pooled connection — which
 *   is fine precisely because the next borrower overwrites it with its own
 *   budget, or with the ceiling when it has none.
 *
 * `timeoutMs` is clamped into `(0, MAX_EXECUTION_TIME_MS]`: 0 means "no timeout"
 * to MySQL, which is the one value a caller asking for a timeout cannot have
 * meant. Note that the server applies `max_execution_time` to read-only `SELECT`
 * statements only — for `SHOW` / `EXPLAIN` the budget is advisory, and the
 * driver-side deadline is what stops them.
 */
export function mysqlStatementSetupSql(timeoutMs?: number): readonly string[] {
  const budget =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(MAX_EXECUTION_TIME_MS, Math.max(1, Math.trunc(timeoutMs)))
      : MAX_EXECUTION_TIME_MS
  return [
    'SET SESSION TRANSACTION READ ONLY',
    `SET SESSION max_execution_time = ${budget}`,
  ]
}

/** `information_schema.DATA_TYPE` / mysql2 type name → LogicalType */
const MYSQL_LOGICAL: Readonly<Record<string, LogicalType>> = {
  tinyint: 'number', smallint: 'number', mediumint: 'number', int: 'number', integer: 'number',
  float: 'number', double: 'number', decimal: 'number', numeric: 'number', year: 'number',
  bigint: 'bigint',
  bit: 'bytes', binary: 'bytes', varbinary: 'bytes',
  tinyblob: 'bytes', blob: 'bytes', mediumblob: 'bytes', longblob: 'bytes',
  char: 'string', varchar: 'string', tinytext: 'string', text: 'string',
  mediumtext: 'string', longtext: 'string', enum: 'string', set: 'string',
  json: 'json',
  date: 'date',
  time: 'time',
  datetime: 'timestamp', timestamp: 'timestamp',
  geometry: 'geo', point: 'geo', linestring: 'geo', polygon: 'geo',
  multipoint: 'geo', multilinestring: 'geo', multipolygon: 'geo', geometrycollection: 'geo',
}

/**
 * MySQL error codes worth distinguishing. `mysql2` puts the `ER_*` name on
 * `err.code`; the numeric `errno` is kept as evidence but not switched on, since
 * the names are stable across versions and the numbers are what changes.
 */
const MYSQL_ERROR_CODES: Readonly<Record<string, PeekErrorCode>> = {
  ER_PARSE_ERROR: 'SYNTAX_ERROR',
  ER_EMPTY_QUERY: 'SYNTAX_ERROR',
  ER_NO_SUCH_TABLE: 'NOT_FOUND',
  ER_BAD_DB_ERROR: 'NOT_FOUND',
  ER_BAD_FIELD_ERROR: 'NOT_FOUND',
  ER_TABLEACCESS_DENIED_ERROR: 'UNSUPPORTED_CAPABILITY',
  ER_DBACCESS_DENIED_ERROR: 'UNSUPPORTED_CAPABILITY',
  ER_SPECIFIC_ACCESS_DENIED_ERROR: 'UNSUPPORTED_CAPABILITY',
  ER_ACCESS_DENIED_ERROR: 'CONNECTION_FAILED',
  ER_CON_COUNT_ERROR: 'CONNECTION_FAILED',
  ER_QUERY_INTERRUPTED: 'CANCELLED',
  ER_QUERY_TIMEOUT: 'TIMEOUT',
  ER_STATEMENT_TIMEOUT: 'TIMEOUT',
  ER_LOCK_WAIT_TIMEOUT: 'TIMEOUT',
  ER_SERVER_SHUTDOWN: 'CONNECTION_LOST',
  PROTOCOL_CONNECTION_LOST: 'CONNECTION_LOST',
  ECONNRESET: 'CONNECTION_LOST',
  ER_OPTION_PREVENTS_STATEMENT: 'CONFLICT',
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: 'CONFLICT',
}

function quoteIdent(name: string): string {
  assertIdentifier(name)
  return `\`${name.replace(/`/g, '``')}\``
}

/**
 * `information_schema.TABLES.TABLE_TYPE` → the tree's node kind.
 *
 * MySQL has no materialized views, so only two of the three ever appear; the
 * `SYSTEM VIEW` rows only occur inside the system schemas the schema listing
 * already filters out, and are treated as ordinary views if one slips through an
 * MCP-supplied schema name.
 */
function mysqlTableKind(tableType: string | null): SqlRelationInfo['kind'] {
  return tableType !== null && tableType.toUpperCase().includes('VIEW') ? 'view' : 'table'
}

/**
 * Declared type names that hold bytes rather than text.
 *
 * The wire protocol answers this with charset 63, but `information_schema` has no
 * charset column for the *column type* — so the catalog path decides from the
 * name, and both paths land on the same `binary: true`.
 */
const MYSQL_BINARY_TYPE_NAMES: ReadonlySet<string> = new Set([
  'binary', 'varbinary', 'bit',
  'tinyblob', 'blob', 'mediumblob', 'longblob',
])

function isMysqlBinaryTypeName(typeName: string | null): boolean {
  if (typeName === null) return false
  return MYSQL_BINARY_TYPE_NAMES.has(typeName.toLowerCase().replace(/\(.*$/, '').trim())
}

export const MYSQL_DIALECT: SqlDialect = {
  flavor: 'mysql',
  displayName: 'MySQL',

  quoteIdent,

  qualify(ref: RelationRef): string {
    return ref.schema ? `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}` : quoteIdent(ref.name)
  },

  /** MySQL's client protocol is positional; mysql2 rewrites `?` itself */
  placeholder(): string {
    return '?'
  },

  renderLimitOffset(limit: number | undefined, offset: number): string {
    const off = Math.max(0, Math.trunc(offset))
    if (limit === undefined) {
      return off > 0 ? ` LIMIT ${MYSQL_MAX_LIMIT} OFFSET ${off}` : ''
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
      // NULL-safe inequality: `<>` yields NULL when either side is NULL, which
      // silently drops the very rows the user asked to see
      case 'neq':
        return `NOT (${col} <=> ${bind(requireFilterValue(f))})`
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
      // MySQL has no ILIKE; under the default `_ci` collations LIKE is already
      // case-insensitive, and forcing a collation here would override a
      // deliberately case-sensitive column
      case 'ilike':
        return `${col} LIKE ${bind(String(requireFilterValue(f)))}`
      // Literal substring match: `%` and `_` typed by the user stay literal
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
      // MySQL has no NULLS FIRST/LAST; `col IS NULL` is 1 for nulls, so sorting
      // that expression puts them where the caller asked
      const nulls = s.nulls === 'first'
        ? `${col} IS NULL DESC, `
        : s.nulls === 'last'
          ? `${col} IS NULL ASC, `
          : ''
      return `${nulls}${col} ${dir}`
    })
    return ` ORDER BY ${parts.join(', ')}`
  },

  logical(meta: SqlColumnMeta): LogicalType {
    if (meta.binary === true) return 'bytes'
    const name = (meta.typeName ?? '').toLowerCase().replace(/\(.*$/, '').trim()
    if (name.length === 0) return 'unknown'
    if (name.endsWith(' unsigned')) return MYSQL_LOGICAL[name.slice(0, -9)] ?? 'unknown'
    return MYSQL_LOGICAL[name] ?? 'unknown'
  },

  nativeTypeName(meta: SqlColumnMeta): string {
    return meta.typeName ?? 'unknown'
  },

  listSchemasSql(): SqlText {
    return {
      text:
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA'
        + ` WHERE SCHEMA_NAME NOT IN (${MYSQL_SYSTEM_SCHEMAS.map(() => '?').join(', ')})`
        + ' ORDER BY SCHEMA_NAME',
      params: [...MYSQL_SYSTEM_SCHEMAS],
    }
  },

  listRelationsSql(schema: string): SqlText {
    return {
      text:
        'SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS est_rows,'
        + ' TABLE_COMMENT AS comment'
        + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      params: [schema],
    }
  },

  listColumnsSql(ref: RelationRef): SqlText {
    return {
      text:
        'SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,'
        + ' IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key, COLUMN_COMMENT AS comment'
        + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?'
        + ' ORDER BY ORDINAL_POSITION',
      params: [ref.schema, ref.name],
    }
  },

  listIndexesSql(ref: RelationRef): SqlText {
    return {
      text:
        'SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq,'
        + ' COLUMN_NAME AS column_name'
        + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?'
        + ' ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      params: [ref.schema, ref.name],
    }
  },

  relationMetaSql(ref: RelationRef): SqlText {
    return {
      text:
        'SELECT TABLE_ROWS AS est_rows, TABLE_COMMENT AS comment, TABLE_TYPE AS kind'
        + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      params: [ref.schema, ref.name],
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
    const rowsIdx = columnIndex(columns, 'est_rows')
    const commentIdx = columnIndex(columns, 'comment')
    if (nameIdx < 0) return []
    const out: SqlRelationInfo[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null || name.length === 0) continue
      const comment = commentIdx < 0 ? null : cellText(row[commentIdx])
      const est = rowsIdx < 0 ? null : cellNumber(row[rowsIdx])
      out.push({
        schema,
        name,
        kind: mysqlTableKind(kindIdx < 0 ? null : cellText(row[kindIdx])),
        // TABLE_ROWS is NULL for views and for tables the server has no statistics
        // for; a negative value would be nonsense, so both become "no estimate"
        estimatedRows: est !== null && est >= 0 ? Math.round(est) : null,
        comment: comment !== null && comment.length > 0 ? comment : null,
      })
    }
    return out
  },

  decodeColumns(rows: readonly unknown[][], columns: readonly SqlColumnMeta[]): SqlColumnMeta[] {
    const nameIdx = columnIndex(columns, 'name')
    const dataTypeIdx = columnIndex(columns, 'data_type')
    const columnTypeIdx = columnIndex(columns, 'column_type')
    const nullableIdx = columnIndex(columns, 'is_nullable')
    const keyIdx = columnIndex(columns, 'column_key')
    if (nameIdx < 0) return []
    const out: SqlColumnMeta[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null) continue
      // DATA_TYPE is the bare type ('varbinary'); COLUMN_TYPE carries the length and
      // the `unsigned` flag ('varbinary(16)', 'bigint unsigned'). The display name
      // wants the latter, and `logical()` copes with both spellings
      const dataType = dataTypeIdx < 0 ? null : cellText(row[dataTypeIdx])
      const columnType = columnTypeIdx < 0 ? null : cellText(row[columnTypeIdx])
      const meta: SqlColumnMeta = {
        name,
        typeName: columnType ?? dataType,
      }
      // The catalog reports the *declared* type, so a binary column is recognized
      // by its type name here, not by the charset flag the wire protocol uses
      if (isMysqlBinaryTypeName(dataType ?? columnType)) meta.binary = true
      if (nullableIdx >= 0) meta.nullable = cellBool(row[nullableIdx])
      if (keyIdx >= 0 && cellText(row[keyIdx]) === 'PRI') meta.primaryKey = true
      out.push(meta)
    }
    return out
  },

  decodeIndexes(
    rows: readonly unknown[][],
    columns: readonly SqlColumnMeta[],
  ): CollectionSchemaInfo['indexes'] {
    const nameIdx = columnIndex(columns, 'name')
    const nonUniqueIdx = columnIndex(columns, 'non_unique')
    const columnIdx = columnIndex(columns, 'column_name')
    if (nameIdx < 0) return []
    // One row per (index, column); the statement is ordered by SEQ_IN_INDEX, so
    // appending in arrival order reproduces the index's column order
    const byName = new Map<string, { name: string; columns: string[]; unique: boolean }>()
    const order: string[] = []
    for (const row of rows) {
      const name = cellText(row[nameIdx])
      if (name === null) continue
      let entry = byName.get(name)
      if (!entry) {
        entry = { name, columns: [], unique: nonUniqueIdx >= 0 && !cellBool(row[nonUniqueIdx]) }
        byName.set(name, entry)
        order.push(name)
      }
      const col = columnIdx < 0 ? null : cellText(row[columnIdx])
      // A functional index reports COLUMN_NAME as NULL; the expression is not in
      // this catalog, so the slot is skipped rather than filled with a guess
      if (col !== null) entry.columns.push(col)
    }
    return order.map((name) => byName.get(name)).filter((e) => e !== undefined)
  },

  /**
   * `SUBSTRING` counts **characters** on a text column, so a byte offset lands in
   * the wrong place on any non-ASCII value; the cast to BINARY makes it count
   * bytes. Offsets are 1-based here and 0-based in `ByteRange`.
   */
  byteSliceExpr(expr: string, offset: number, length: number, params: unknown[]): string {
    params.push(Math.max(0, Math.trunc(offset)) + 1, Math.max(0, Math.trunc(length)))
    return `SUBSTRING(CAST(${expr} AS BINARY), ?, ?)`
  },

  byteLengthExpr(expr: string): string {
    return `OCTET_LENGTH(${expr})`
  },

  classifyError(code: string | undefined, _errno: number | undefined): PeekErrorCode | null {
    if (code === undefined) return null
    return MYSQL_ERROR_CODES[code] ?? null
  },

  /**
   * Read-only is a server-side property of the session, not a promise the client
   * makes to itself: `SET SESSION TRANSACTION READ ONLY` makes every statement in
   * this connection fail if it tries to write, no matter what SQL the user typed.
   *
   * It is session state, though, and session state is exactly what a user
   * statement can change — so this list is the *initial* setup only. The backend
   * re-issues it (via `mysqlStatementSetupSql`) on every checkout, which is what
   * actually holds the guarantee up on a pooled connection.
   */
  sessionSetupSql(): readonly string[] {
    return mysqlStatementSetupSql()
  },

  serverInfoSql(): SqlText {
    return {
      text: 'SELECT VERSION() AS version, DATABASE() AS db',
      params: [],
    }
  },
}
