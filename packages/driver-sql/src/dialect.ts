import type {
  CollectionSchemaInfo,
  ColumnDef,
  DriverId,
  FilterSpec,
  LogicalType,
  NamespaceNodeKind,
  PeekErrorCode,
  RelationRef,
  SortSpec,
} from '@peek/core'

/**
 * The SQL dialect layer — the reason `@peek/driver-sql` is one package and not two.
 *
 * ## What belongs here, and what does not
 *
 * A `SqlDialect` is **pure**: strings in, strings out, plus a few lookup tables.
 * It never touches a socket or a file handle. Everything that performs I/O lives
 * behind `SqlBackend` (connection.ts) instead. The split is not cosmetic:
 *
 * - the dialect is the part that differs between MySQL and SQLite, and being pure
 *   it is exhaustively unit-testable **with no database running** — quoting,
 *   filter rendering, type mapping and the introspection statements are all
 *   assertable as text;
 * - the backend is the part that differs between "a network protocol with a
 *   connection pool" (mysql2) and "a synchronous handle to a local file"
 *   (node:sqlite), which is a lifecycle problem, not a syntax problem.
 *
 * `SqlSession`, `SqlCursor`, `SqlIntrospector` and `SqlValuePeeker` are written
 * once against these two interfaces and are shared verbatim by both databases.
 * Adding a third SQL database (DuckDB, MariaDB with its own quirks, ClickHouse)
 * is one more dialect plus one more backend — no change to the shared code, and
 * no change to core.
 *
 * ## The rule every dialect implementation must obey
 *
 * **Values are always bound as parameters; identifiers are always quoted through
 * `quoteIdent`.** Not one method below is allowed to interpolate a user-supplied
 * *value* into SQL text. Integers that peek itself computed (LIMIT / OFFSET /
 * timeouts) may be inlined after `Math.trunc`, and that is the only exception —
 * it exists because MySQL and SQLite both restrict where a placeholder may
 * appear.
 */

/* ================================================================== */
/* 1. Small shared shapes                                              */
/* ================================================================== */

/** Which SQL database a dialect speaks. Also the `DriverId` its sessions report. */
export type SqlFlavor = Extract<DriverId, 'mysql' | 'sqlite'>

/**
 * Column metadata as it arrives from the backend, normalized to the least common
 * denominator both drivers can actually produce.
 *
 * `typeName` is the dialect's own spelling ('VARCHAR(255)', 'INTEGER', 'JSON');
 * `typeCode` is the protocol-level code where one exists (mysql2 field packets
 * carry it, node:sqlite does not); `binary` marks a column the server flagged as
 * bytes rather than text (MySQL's charset 63). `logical()` turns all three into a
 * `LogicalType`.
 */
export interface SqlColumnMeta {
  name: string
  typeName: string | null
  typeCode?: number
  binary?: boolean
  nullable?: boolean
  primaryKey?: boolean
}

/** One row of a dialect's relation listing (a table, view, or whatever else it browses) */
export interface SqlRelationInfo {
  schema: string
  name: string
  /** `table` and `view` map onto NamespaceNodeKind directly */
  kind: Extract<NamespaceNodeKind, 'table' | 'view' | 'materializedView'>
  /**
   * Row-count **estimate**, never a `count(*)`.
   *
   * MySQL reads `information_schema.TABLES.TABLE_ROWS`, which for InnoDB is a
   * sampled approximation and may be off by a wide margin — that is fine, it is
   * labelled an estimate everywhere it surfaces. SQLite has no such statistic at
   * all and must report `null` rather than counting the table: peek opens trees
   * against files it did not write, and a full scan per node turns expanding a
   * database into minutes of disk I/O (PLAN section 8).
   */
  estimatedRows: number | null
  comment: string | null
}

/** A prepared statement fragment: text plus the values to bind, in order */
export interface SqlText {
  text: string
  params: unknown[]
}

/* Re-exported so dialect implementations do not each import core for these */
export type { ColumnDef, FilterSpec, LogicalType, NamespaceNodeKind, RelationRef, SortSpec }

/* ================================================================== */
/* 2. The dialect interface                                            */
/* ================================================================== */

export interface SqlDialect {
  readonly flavor: SqlFlavor
  readonly displayName: string

  /* ---------------- Identifiers and placeholders ---------------- */

  /**
   * Quote one identifier. MySQL wraps in backticks and doubles embedded ones;
   * SQLite wraps in double quotes and doubles embedded ones. Both must reject a
   * NUL byte outright (`error.sql.identifierInvalid`) — it is the one character
   * no escaping makes safe.
   */
  quoteIdent(name: string): string

  /**
   * `schema`.`name`, with the dialect's own idea of what a schema is:
   *
   * - MySQL: a schema **is** a database, and `RelationRef.schema` therefore always
   *   carries the database name. An empty schema means "the connection's default
   *   database" and is rendered as a bare table name.
   * - SQLite: the schema is the attached-database name, `'main'` by default (also
   *   `'temp'`, and anything from `ATTACH`). An empty schema is normalized to
   *   `'main'` — never left blank, so a `RelationRef` minted by the tree and one
   *   typed by an MCP caller address the same table.
   */
  qualify(ref: RelationRef): string

  /** The placeholder for the n-th bound parameter (1-based). Both current dialects return '?'. */
  placeholder(index: number): string

  /**
   * Render `LIMIT` / `OFFSET`.
   *
   * Kept in the dialect because the two databases disagree about where a
   * placeholder is allowed: MySQL accepts `LIMIT ?` only in the binary protocol,
   * SQLite accepts it anywhere, and neither accepts an expression. The values are
   * peek-computed integers, so a dialect may safely inline them after truncation.
   */
  renderLimitOffset(limit: number | undefined, offset: number, params: unknown[]): string

  /* ---------------- Predicates ---------------- */

  /**
   * One `FilterSpec` → one boolean SQL fragment, pushing every value through
   * `params`.
   *
   * Dialect-specific because the operators genuinely differ:
   * - `neq` must be NULL-safe. PostgreSQL has `IS DISTINCT FROM`; MySQL spells it
   *   `NOT (a <=> b)`; SQLite spells it `IS NOT`.
   * - `ilike` has no MySQL/SQLite equivalent. MySQL's `LIKE` is already
   *   case-insensitive under the usual `_ci` collations, and SQLite's is
   *   case-insensitive for ASCII — so both render `ilike` as a plain `LIKE`, and
   *   **must not** silently drop the request: the fragment still filters, it is
   *   only the case-sensitivity guarantee that is the collation's to make.
   * - `contains` is a literal substring match, wildcards included: `INSTR(x, ?) > 0`
   *   in both dialects, so a user typing `%` gets a percent sign rather than a
   *   wildcard.
   */
  renderFilter(filter: FilterSpec, params: unknown[]): string

  /**
   * Render `ORDER BY`.
   *
   * `SortSpec.nulls` is the interesting part: neither dialect supports
   * `NULLS FIRST` / `NULLS LAST` the way PostgreSQL does (MySQL before 8.0.x and
   * SQLite before 3.30 have no such clause at all), so it is emulated with a
   * leading `col IS NULL` term. A dialect that cannot honour the request must
   * emulate it, never ignore it: a sort that quietly puts nulls at the wrong end
   * is a wrong answer, not a cosmetic difference.
   */
  renderOrderBy(sorts: readonly SortSpec[] | undefined): string

  /* ---------------- Types ---------------- */

  /**
   * Native type → `LogicalType`, which is what the grid renders from.
   *
   * MySQL decides from the field packet's type code plus the binary flag (charset
   * 63 means bytes, so `VARBINARY` is `bytes` while `VARCHAR` is `string`).
   * SQLite has no column types at runtime — only a *declared* type with affinity
   * rules, and expressions have no declared type at all — so its dialect maps by
   * affinity and falls back to the JS type of the first non-null value.
   */
  logical(meta: SqlColumnMeta): LogicalType

  /**
   * A displayable native type name for `ColumnDef.nativeType`. Never null: when
   * the dialect cannot determine one it returns a documented placeholder
   * (SQLite's untyped expression columns report `'any'`), because `nativeType` is
   * what a user reads in the column header when `logical` is too coarse.
   */
  nativeTypeName(meta: SqlColumnMeta): string

  /* ---------------- Introspection ---------------- */

  /**
   * The schema-level listing (MySQL: databases; SQLite: attached databases).
   *
   * Returns statement text plus params rather than executing anything — the
   * backend runs it. That is what keeps the dialect testable without a server,
   * and it is why these are `SqlText` and not `Promise<…>`.
   *
   * MySQL reads `information_schema.SCHEMATA` and **must** filter out the four
   * server-owned schemas (`information_schema`, `performance_schema`, `mysql`,
   * `sys`) — showing them at the root buries the user's own database in noise.
   * SQLite uses `PRAGMA database_list`, which returns `main` plus anything
   * attached.
   */
  listSchemasSql(): SqlText

  /** Tables and views in one schema. MySQL: `information_schema.TABLES`. SQLite: `sqlite_schema` (with `sqlite_%` internal objects filtered out). */
  listRelationsSql(schema: string): SqlText

  /**
   * Columns of one relation, in ordinal order.
   *
   * MySQL: `information_schema.COLUMNS`, which carries nullability, the primary
   * key flag (`COLUMN_KEY = 'PRI'`) and the comment in one query.
   * SQLite: `SELECT … FROM pragma_table_info(?)` — the table-valued form of the
   * pragma, because a bare `PRAGMA table_info(x)` takes no bound parameter and
   * would force the table name into the statement text.
   */
  listColumnsSql(ref: RelationRef): SqlText

  /** Indexes of one relation. MySQL: `information_schema.STATISTICS`. SQLite: `pragma_index_list` joined to `pragma_index_info`. */
  listIndexesSql(ref: RelationRef): SqlText

  /** Row-count estimate and comment for one relation; SQLite returns a statement whose estimate column is NULL (see `SqlRelationInfo.estimatedRows`). */
  relationMetaSql(ref: RelationRef): SqlText

  /**
   * Decode the rows of each statement above into the normalized shapes.
   *
   * The queries differ so much in shape (`information_schema` rows versus pragma
   * rows) that a shared decoder would be a pile of conditionals; each dialect
   * decodes its own, and the shared introspector only ever sees the normalized
   * result.
   */
  decodeSchemas(rows: readonly unknown[][], columns: readonly SqlColumnMeta[]): string[]
  decodeRelations(
    schema: string,
    rows: readonly unknown[][],
    columns: readonly SqlColumnMeta[],
  ): SqlRelationInfo[]
  decodeColumns(rows: readonly unknown[][], columns: readonly SqlColumnMeta[]): SqlColumnMeta[]
  decodeIndexes(
    rows: readonly unknown[][],
    columns: readonly SqlColumnMeta[],
  ): CollectionSchemaInfo['indexes']

  /* ---------------- Value peeking ---------------- */

  /**
   * An expression yielding `length` **bytes** of `expr` starting at `offset`
   * (0-based, as `ByteRange` defines it).
   *
   * The byte/character distinction is the whole point. MySQL's `SUBSTRING` counts
   * *characters* on a TEXT column, so a peek offset lands in the wrong place the
   * moment the text is not ASCII; the fix is `SUBSTRING(CAST(x AS BINARY) …)`.
   * SQLite's `substr` counts bytes only when the argument is a BLOB, so the same
   * cast is required, and both dialects are 1-based where `ByteRange` is 0-based.
   */
  byteSliceExpr(expr: string, offset: number, length: number, params: unknown[]): string

  /** An expression yielding the total byte length of `expr` (MySQL `OCTET_LENGTH`, SQLite `length(CAST(… AS BLOB))`). */
  byteLengthExpr(expr: string): string

  /* ---------------- Errors ---------------- */

  /**
   * Classify a driver-native error code into a `PeekErrorCode`, or return null to
   * let `mapSqlError` fall back to its generic rules.
   *
   * `code` is MySQL's `ER_*` string (mysql2 puts it on `err.code`) or SQLite's
   * `ERR_SQLITE_ERROR` plus the `errcode` numeric. The **message text is never
   * touched**: server text is evidence the user greps for, so it travels verbatim
   * in `PeekError.message` with no `i18n` descriptor (see core's errors.ts).
   */
  classifyError(code: string | undefined, errno: number | undefined): PeekErrorCode | null

  /* ---------------- Session bootstrap ---------------- */

  /**
   * Statements run once on every new connection, before anything else.
   *
   * This is where read-only enforcement lives, and it has to be a dialect
   * decision because the two databases enforce it in completely different places:
   * MySQL sets `SESSION TRANSACTION READ ONLY` (plus a sane `sql_mode` and a
   * UTC-free time zone so timestamps are not silently shifted), while SQLite
   * takes `readOnly` as an *open flag* and has nothing to run afterwards — for it
   * this list is empty and `SqliteBackend` passes the flag to `DatabaseSync`.
   */
  sessionSetupSql(): readonly string[]

  /** `SELECT`-shaped statement returning one row of server version info (MySQL: `VERSION()`; SQLite: `sqlite_version()`). */
  serverInfoSql(): SqlText
}
