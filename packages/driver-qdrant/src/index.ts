/**
 * @peek/driver-qdrant — the Qdrant driver.
 *
 * Capabilities: introspect + collectionScan + vectorSearch + valuePeek
 * (declared by this package in `./manifest`, which is also what the connect
 * dialog and the MCP tools read before anything has connected).
 *
 * Note the absence of `cancel`: Qdrant is an HTTP API and an in-flight request is
 * aborted with an AbortController rather than interrupted server-side, so the
 * driver does not claim a capability it cannot honour. The host still stops the
 * result pump on cancel — that path does not depend on the session.
 *
 * Module map (mirrors driver-postgres):
 *   driver.ts      the Driver factory
 *   session.ts     one live connection: the DriverSession implementation
 *   errors.ts      HTTP / API errors → PeekError
 *   collections.ts the namespace tree (collection → named vector / payload index)
 *   scroll.ts      scroll and search as core Cursors
 *   points.ts      a point → a row, and the payload-flattening rule
 *
 * No electron dependency, so it runs and is tested standalone on node.
 */

export { QdrantDriver, qdrantDriver, requireQdrantConfig } from './driver'
export { QdrantSession } from './session'
export { mapQdrantError, type MapQdrantErrorContext } from './errors'
export {
  QdrantCollections,
  collectionNodeId,
  parseCollectionNodeId,
  type ParsedCollectionNodeId,
} from './collections'
export {
  QdrantPointCursor,
  type QdrantPointCursorOptions,
  type QdrantPointPage,
} from './scroll'
export {
  buildRowShape,
  pointFieldRef,
  pointIdToCell,
  pointToRow,
  resolvePayloadColumns,
  type QdrantPoint,
  type QdrantRowShape,
} from './points'
export { decodeScrollOffset, encodeScrollOffset } from './scroll'
