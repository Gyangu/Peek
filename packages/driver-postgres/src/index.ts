/**
 * @peek/driver-postgres — the PostgreSQL driver.
 *
 * Capabilities: introspect + tabularQuery + collectionScan + valuePeek + cancel
 * (declared by this package in `./manifest`, which is also what the connect
 * dialog and the MCP tools read before anything has connected).
 *
 * No electron dependency, so it runs and is tested standalone on node.
 * src/host.ts is the entry point when it runs as a utilityProcess.
 */

export { PostgresDriver, postgresDriver, requirePostgresConfig } from './driver'
export { PostgresSession } from './session'
export { PgCursor, type PgCursorOptions } from './cursor'
export { PgIntrospector, nodeId, parseNodeId, type ParsedNodeId } from './introspect'
export { PgValuePeeker, type ResultSource } from './peek'
export { PgTypeCatalog, isPeekableLogical, type PgTypeInfo, type PgTypeRow } from './type-catalog'
export { mapPgError } from './errors'
export {
  ParamList,
  buildScanSql,
  qualifiedName,
  quoteIdent,
  renderFilter,
  renderOrderBy,
  renderWhere,
  type ScanSql,
  type ScanSqlInput,
} from './sql'
export { estimateCellBytes, normalizeCell, type NormalizeContext } from './values'
/**
 * utilityProcess entry. Importing this module self-starts the host when
 * process.parentPort is present; calling startDriverHost() explicitly works too
 * (it is idempotent). The main process has no parentPort, so importing it there
 * has no side effects.
 */
export { startDriverHost } from './host'
export {
  DriverHost,
  createDriverHost,
  type DriverHostOptions,
  type HostChannelEvent,
  type HostChannelLike,
  type HostPortLike,
} from './host-runtime'
