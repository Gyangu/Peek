/**
 * @peek/db-sql — MySQL and SQLite, one package.
 *
 * Capabilities (identical for both, declared by this package in `./manifest`):
 * introspect + tabularQuery + collectionScan + valuePeek + cancel.
 *
 * ## What this package is for
 *
 * db-postgres proved a driver can be written against core's capability model.
 * This one tests something else: that the model does not need a package per
 * database. MySQL and SQLite share every line of the session, the cursor, the
 * introspector and the value peeker; what differs is a `SqlDialect` (pure strings
 * and lookup tables) and a `SqlBackend` (connection lifecycle). Adding a third
 * SQL database is those two objects and nothing else.
 *
 * Module map (mirrors db-postgres, so the packages read the same way):
 *   dialect.ts       the SqlDialect interface — the whole point of the package
 *   connection.ts    SqlBackend / SqlBackendHandle / SqlRowStream — the I/O half
 *   sql.ts           statement construction shared by both dialects
 *   cursor.ts        SqlRowStream → columnar ChunkFrames (the core Cursor)
 *   introspect.ts    the namespace tree (schema → table/view) and its node ids
 *   values.ts        one cell → a chunk-safe value
 *   peek.ts          valuePeek for both dialects
 *   errors.ts        driver errors → PeekError
 *   session.ts       SqlSession: one DriverSession implementation for both
 *   driver.ts        the two Driver factories
 *   mysql/           the MySQL dialect + the mysql2 backend
 *   sqlite/          the SQLite dialect + the node:sqlite backend
 *
 * No electron dependency, so it runs and is tested standalone on node.
 * The driver host entry (apps/desktop/src/main/driver-host/entry.ts) imports the
 * driver instances from here and hands them to core's `startDriverHostProcess`.
 */

export {
  MysqlDriver,
  SqliteDriver,
  mysqlDriver,
  sqliteDriver,
  sqlDrivers,
  requireMysqlConfig,
  requireSqliteConfig,
} from './driver'

export { SqlSession, capabilitiesFor, type SqlSessionOptions } from './session'
export { SqlCursor, type SqlCursorOptions } from './cursor'
export {
  SqlIntrospector,
  parseSqlNodeId,
  sqlNodeId,
  type ParsedSqlNodeId,
  type SqlIntrospectorOptions,
} from './introspect'
export { SqlValuePeeker, type SqlResultSource, type SqlValuePeekerOptions } from './peek'
export { mapSqlError, type MapSqlErrorContext } from './errors'
export { normalizeCell, estimateCellBytes, type NormalizeContext } from './values'

export type {
  SqlColumnMeta,
  SqlDialect,
  SqlFlavor,
  SqlRelationInfo,
  SqlText,
} from './dialect'
export type {
  SqlBackend,
  SqlBackendHandle,
  SqlExecOptions,
  SqlRowStream,
  SqlRows,
} from './connection'

export {
  ParamList,
  assertIdentifier,
  buildScanSql,
  renderWhere,
  requireFilterArray,
  requireFilterValue,
  wrapResultRow,
  type ScanSql,
  type ScanSqlInput,
} from './sql'

export { MYSQL_DIALECT, MYSQL_SYSTEM_SCHEMAS } from './mysql/dialect'
export { mysqlBackend } from './mysql/backend'
export { SQLITE_DIALECT, SQLITE_DEFAULT_SCHEMA, sqliteAffinity } from './sqlite/dialect'
export { sqliteBackend } from './sqlite/backend'
