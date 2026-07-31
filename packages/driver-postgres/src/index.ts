/**
 * @peek/driver-postgres —— PostgreSQL 驱动。
 *
 * 能力集：introspect + tabularQuery + collectionScan + valuePeek + cancel
 * （与 core 的 DRIVER_CAPABILITIES.postgres 同源）。
 *
 * 不依赖 electron，可独立 node 运行与测试；
 * 作为 utilityProcess 入口时用 src/host.ts。
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
 * utilityProcess 入口。import 本模块时若检测到 process.parentPort 会自动启动，
 * 显式调用 startDriverHost() 也可以（幂等）。main 进程没有 parentPort，import 无副作用。
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
