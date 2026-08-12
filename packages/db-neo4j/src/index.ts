/**
 * @peek/db-neo4j — the Neo4j driver, and peek's first Tier C package.
 *
 * Capabilities: introspect + tabularQuery(Cypher) + collectionScan + valuePeek +
 * cancel (declared by this package in `./manifest`, which is also what the
 * connect dialog and the MCP tools read before anything has connected).
 *
 * Two things here that no other driver package has:
 *
 * - **`cancel` that is not a client-side hangup.** Bolt's RESET terminates the
 *   running query server-side, so closing a cursor stops the work rather than
 *   stopping the reading of it (see `session.ts`).
 * - **A view kind of its own.** `./view` registers the `graph` view and `./graph`
 *   composes its Cypher; both are free of `neo4j-driver` and are reached through
 *   subpaths, because they run in the main process and in the renderer's planning
 *   path, where a Bolt client has no business being.
 *
 * Module map (mirrors db-postgres, so the packages read the same way):
 *   driver.ts    the Driver factory
 *   session.ts   one live connection: the DriverSession implementation, and its Cursor
 *   errors.ts    Neo4j status codes → PeekError
 *   values.ts    Bolt values → cells a chunk can carry
 *   graph.ts     the `graph` view's state and the Cypher it composes (pure)
 *   view.ts      the ViewKindRegistration for that view (pure)
 *   manifest.ts  what Neo4j *is*, for the parts of peek that run before a connection
 *
 * No electron dependency, so it runs and is tested standalone on node.
 * The driver host entry (apps/desktop/src/main/driver-host/entry.ts) imports
 * `neo4jDriver` from here and hands it to core's `startDriverHostProcess`.
 */

export { Neo4jDriver, neo4jDriver, requireNeo4jConfig } from './driver'
export {
  NODE_NAMESPACE,
  Neo4jCursor,
  Neo4jSession,
  REL_NAMESPACE,
  boltParams,
  nodeId,
  parseNodeId,
  requireNeo4jCollection,
  type Neo4jCollection,
  type Neo4jColumnHint,
  type Neo4jCursorOptions,
  type ParsedNodeId,
} from './session'
export { codeFromNeo4jStatus, mapNeo4jError, type MapNeo4jErrorContext } from './errors'
export {
  PEEK_TAG,
  fromNeo4jInteger,
  logicalTypeOf,
  toCell,
  toChunkCell,
  type GraphCell,
  type GraphNodeCell,
  type GraphPathCell,
  type GraphRelCell,
} from './values'
export { MAX_DEPTH } from './limits'
export {
  DEFAULT_DEPTH,
  DEFAULT_NODES,
  MAX_NODES,
  composeGraphQuery,
  graphTitle,
  quoteLabel,
  readGraphState,
  type ComposedQuery,
  type GraphViewState,
} from './graph'
export { GRAPH_VIEW_KIND, graphViewKind } from './view'
