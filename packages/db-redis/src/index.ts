/**
 * @peek/db-redis — the Redis driver.
 *
 * Capabilities: introspect + collectionScan + keyValue + valuePeek + cancel
 * (declared by this package in `./manifest`, which is also what the connect
 * dialog and the MCP tools read before anything has connected).
 *
 * This is the package that proves the capability model: it advertises neither
 * `tabularQuery` nor a relation anywhere, and nothing in core had to learn the
 * word "redis" for it to work.
 *
 * Module map (mirrors db-postgres, so the two read the same way):
 *   driver.ts     the Driver factory
 *   session.ts    one live connection: the DriverSession implementation
 *   errors.ts     redis / socket errors → PeekError
 *   keyspace.ts   the namespace tree (db → key prefix → key) and its node ids
 *   scan.ts       SCAN as a core Cursor: keyspace pages → columnar chunks
 *   values.ts     one key → KeyValuePayload, and the valuePeek slicing
 *
 * No electron dependency, so it runs and is tested standalone on node.
 * The driver host entry (apps/desktop/src/main/driver-host/entry.ts) imports
 * `redisDriver` from here and hands it to core's `startDriverHostProcess`.
 */

export { RedisDriver, redisDriver, requireRedisConfig } from './driver'
export { RedisSession } from './session'
export { mapRedisError, type MapRedisErrorContext } from './errors'
export {
  RedisKeyspace,
  keyspaceNodeId,
  parseKeyspaceNodeId,
  splitKeyPrefix,
  type ParsedKeyspaceNodeId,
} from './keyspace'
export { RedisScanCursor, type RedisScanCursorOptions } from './scan'
export {
  REDIS_TYPE_TO_SHAPE,
  readKeyValue,
  redisTypeShape,
  type RedisType,
  type RedisValueDeps,
} from './values'
