import { z } from 'zod'
import type { ChunkFrame, ColumnDef } from './chunk'
import { ResultIdSchema, type ResultId } from './ids'

/* ================================================================== */
/* 1. Capability                                                       */
/* ================================================================== */

export const CAPABILITIES = [
  /** Namespace tree: db→schema→table / db→key-pattern / collection */
  'introspect',
  /** Free-form statements (SQL and friends) returning a tabular stream */
  'tabularQuery',
  /** Sequential/paged browsing of one collection (table, keyspace, collection) */
  'collectionScan',
  /** Fetch by key plus a typed inspector (redis hash/list/zset…) */
  'keyValue',
  /** Vector similarity search (qdrant) */
  'vectorSearch',
  /** Fetch a large value in full, on demand (long text / blob / the vector itself) */
  'valuePeek',
  /** Cancel an in-flight operation */
  'cancel',
] as const

export const CapabilitySchema = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof CapabilitySchema>

export const DRIVER_IDS = ['postgres', 'mysql', 'sqlite', 'redis', 'qdrant'] as const
export const DriverIdSchema = z.enum(DRIVER_IDS)
export type DriverId = z.infer<typeof DriverIdSchema>

/**
 * Capabilities each driver advertises (the four-database comparison in PLAN §4).
 * The UI and the MCP tools adapt to this table **before** a connection exists;
 * once connected, `DriverSession.capabilities` wins — it may be narrower, e.g. on
 * an older PostgreSQL server.
 */
export const DRIVER_CAPABILITIES: Readonly<Record<DriverId, readonly Capability[]>> = {
  postgres: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  mysql: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  sqlite: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  redis: ['introspect', 'collectionScan', 'keyValue', 'valuePeek', 'cancel'],
  qdrant: ['introspect', 'collectionScan', 'vectorSearch', 'valuePeek'],
}

/* ================================================================== */
/* 2. ConnectionConfig (discriminated union on driverId)               */
/* ================================================================== */

const baseConn = {
  /** User-visible connection name; when absent main derives one from host/database */
  label: z.string().optional(),
} as const

export const PostgresConnectionConfigSchema = z.object({
  driverId: z.literal('postgres'),
  ...baseConn,
  /** postgresql://user:pass@host:port/db — when `url` is given it wins, the other fields act as overrides */
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ssl: z.boolean().optional(),
  applicationName: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  /** Default search_path; decides which schema introspection starts from */
  searchPath: z.array(z.string()).optional(),
})

export const MysqlConnectionConfigSchema = z.object({
  driverId: z.literal('mysql'),
  ...baseConn,
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ssl: z.boolean().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
})

export const SqliteConnectionConfigSchema = z.object({
  driverId: z.literal('sqlite'),
  ...baseConn,
  /** Absolute path to the database file; ':memory:' means an in-memory database */
  file: z.string().min(1),
  readOnly: z.boolean().optional(),
})

export const RedisConnectionConfigSchema = z.object({
  driverId: z.literal('redis'),
  ...baseConn,
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().max(65535).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  db: z.number().int().nonnegative().optional(),
  tls: z.boolean().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
})

export const QdrantConnectionConfigSchema = z.object({
  driverId: z.literal('qdrant'),
  ...baseConn,
  url: z.string().min(1),
  apiKey: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
})

export const ConnectionConfigSchema = z.discriminatedUnion('driverId', [
  PostgresConnectionConfigSchema,
  MysqlConnectionConfigSchema,
  SqliteConnectionConfigSchema,
  RedisConnectionConfigSchema,
  QdrantConnectionConfigSchema,
])

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>
export type PostgresConnectionConfig = z.infer<typeof PostgresConnectionConfigSchema>
export type MysqlConnectionConfig = z.infer<typeof MysqlConnectionConfigSchema>
export type SqliteConnectionConfig = z.infer<typeof SqliteConnectionConfigSchema>
export type RedisConnectionConfig = z.infer<typeof RedisConnectionConfigSchema>
export type QdrantConnectionConfig = z.infer<typeof QdrantConnectionConfigSchema>

/** Password placeholder. Any config that crosses the main-process boundary must be redacted first. */
export const REDACTED = '***'

/**
 * Redaction: every config shown to MCP or the renderer goes through here.
 * Passwords embedded in a connection URL are replaced as well.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/(:\/\/[^:/@]*):[^@]*@/, `$1:${REDACTED}@`)
}

export function redactConnectionConfig(cfg: ConnectionConfig): ConnectionConfig {
  const redactUrl = (url: string | undefined): string | undefined => {
    if (!url) return url
    return redactUrlCredentials(url)
  }
  switch (cfg.driverId) {
    case 'postgres':
    case 'mysql':
      return {
        ...cfg,
        ...(cfg.password === undefined ? {} : { password: REDACTED }),
        ...(cfg.url === undefined ? {} : { url: redactUrl(cfg.url) }),
      }
    case 'redis':
      return {
        ...cfg,
        ...(cfg.password === undefined ? {} : { password: REDACTED }),
        ...(cfg.url === undefined ? {} : { url: redactUrl(cfg.url) }),
      }
    case 'qdrant':
      return { ...cfg, ...(cfg.apiKey === undefined ? {} : { apiKey: REDACTED }) }
    case 'sqlite':
      return { ...cfg }
  }
}

/**
 * Derive a default display name from a config (used when `label` is empty).
 *
 * The label is broadcast to the renderer and to MCP, and postgres/mysql/redis fall
 * back to the connection URL when neither database nor host was given — and that
 * URL carries a plaintext password. So this function **always scrubs the URL
 * itself**; callers do not need to remember (and should not have to remember) to
 * call `redactConnectionConfig` first.
 */
export function defaultConnectionLabel(cfg: ConnectionConfig): string {
  if (cfg.label) return cfg.label
  switch (cfg.driverId) {
    case 'postgres':
    case 'mysql':
      return cfg.database ?? cfg.host ?? safeUrlLabel(cfg.url) ?? cfg.driverId
    case 'sqlite':
      return cfg.file
    case 'redis':
      return safeUrlLabel(cfg.url) ?? `${cfg.host ?? 'localhost'}:${cfg.port ?? 6379}/${cfg.db ?? 0}`
    case 'qdrant':
      return safeUrlLabel(cfg.url) ?? cfg.driverId
  }
}

function safeUrlLabel(url: string | undefined): string | undefined {
  return url === undefined ? undefined : redactUrlCredentials(url)
}

/* ================================================================== */
/* 3. Refs: addressing a collection, and addressing a single value     */
/* ================================================================== */

/** A table or view in a relational database */
export const RelationRefSchema = z.object({
  kind: z.literal('relation'),
  /** Where sqlite/mysql have no schema layer, use '' or 'main' / the database name */
  schema: z.string(),
  name: z.string().min(1),
})

/** A redis key pattern (SCAN MATCH); never degrade this into KEYS */
export const KeyPatternRefSchema = z.object({
  kind: z.literal('keyPattern'),
  /** Glob pattern such as 'user:*'; '*' means the whole database */
  pattern: z.string(),
  db: z.number().int().nonnegative().optional(),
  /** Scan only one type (TYPE filter) */
  typeFilter: z.string().optional(),
})

/** A qdrant collection */
export const VectorCollectionRefSchema = z.object({
  kind: z.literal('vectorCollection'),
  collection: z.string().min(1),
})

export const CollectionRefSchema = z.discriminatedUnion('kind', [
  RelationRefSchema,
  KeyPatternRefSchema,
  VectorCollectionRefSchema,
])

export type RelationRef = z.infer<typeof RelationRefSchema>
export type KeyPatternRef = z.infer<typeof KeyPatternRefSchema>
export type VectorCollectionRef = z.infer<typeof VectorCollectionRefSchema>
export type CollectionRef = z.infer<typeof CollectionRefSchema>

/** Human-readable name of a collection; the UI and MCP summaries both use this */
export function collectionRefLabel(ref: CollectionRef): string {
  switch (ref.kind) {
    case 'relation':
      return ref.schema ? `${ref.schema}.${ref.name}` : ref.name
    case 'keyPattern':
      return ref.db === undefined ? ref.pattern : `db${ref.db}:${ref.pattern}`
    case 'vectorCollection':
      return ref.collection
  }
}

/**
 * Address of one large value, used by valuePeek and the inspector view.
 * Four origins: a result-set cell, a relational cell (by primary key), a redis key
 * (optionally with a path into it), and a qdrant point field.
 */
export const ValueRefSchema = z.discriminatedUnion('kind', [
  /** A cell inside a result set: the common case — truncated values in a chunk carry this */
  z.object({
    kind: z.literal('resultCell'),
    resultId: ResultIdSchema,
    /** Row index within the whole result set (not within the chunk) */
    row: z.number().int().nonnegative(),
    /** Column index */
    col: z.number().int().nonnegative(),
  }),
  /** A relational cell addressed by primary key (still resolvable after the result set is evicted) */
  z.object({
    kind: z.literal('relationCell'),
    collection: RelationRefSchema,
    /** Primary-key column → value */
    pk: z.record(z.string(), z.unknown()),
    column: z.string().min(1),
  }),
  /** redis: the key itself, or a hash field / list index / zset member */
  z.object({
    kind: z.literal('redisValue'),
    key: z.string().min(1),
    db: z.number().int().nonnegative().optional(),
    /** Hash field, list index or zset member; absent means the whole key */
    path: z.string().optional(),
  }),
  /** qdrant: a point's payload field, or the vector itself (field === 'vector') */
  z.object({
    kind: z.literal('qdrantPoint'),
    collection: z.string().min(1),
    pointId: z.union([z.string(), z.number()]),
    field: z.string().min(1),
  }),
])

export type ValueRef = z.infer<typeof ValueRefSchema>

/* ================================================================== */
/* 4. Filtering and sorting                                            */
/* ================================================================== */

export const FILTER_OPS = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte',
  'like', 'ilike', 'in', 'contains', 'isNull', 'isNotNull',
] as const
export const FilterOpSchema = z.enum(FILTER_OPS)
export type FilterOp = z.infer<typeof FilterOpSchema>

export const FilterSpecSchema = z.object({
  column: z.string().min(1),
  op: FilterOpSchema,
  /** isNull / isNotNull take no value; `in` takes an array */
  value: z.unknown().optional(),
})
export type FilterSpec = z.infer<typeof FilterSpecSchema>

export const SortSpecSchema = z.object({
  column: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
  nulls: z.enum(['first', 'last']).optional(),
})
export type SortSpec = z.infer<typeof SortSpecSchema>

/* ================================================================== */
/* 5. Namespace tree                                                   */
/* ================================================================== */

export const NAMESPACE_NODE_KINDS = [
  'database', 'schema', 'table', 'view', 'materializedView',
  'keyspace', 'keyPrefix', 'key', 'collection', 'index', 'column', 'folder',
] as const
export type NamespaceNodeKind = (typeof NAMESPACE_NODE_KINDS)[number]

/**
 * A node in the namespace tree. **Lazily loaded**: one `listChildren` call returns
 * exactly one level, and `hasChildren` decides whether the UI draws an expand
 * arrow (pass true when unknown; if expanding yields an empty array the UI folds
 * the node back).
 */
export interface NamespaceNode {
  /**
   * Node id, unique within the connection, and also the `parentId` of listChildren.
   * By convention it is path-shaped and stably reconstructible, e.g. 'schema:public',
   * 'relation:public.harness'.
   */
  id: string
  /** Display name */
  name: string
  kind: NamespaceNodeKind
  /** Whether another level exists below (the lazy-loading marker) */
  hasChildren: boolean
  /** Set on nodes that can be opened directly as a table view via view.open */
  ref?: CollectionRef
  /** Dimmed text on the right: row-count estimate, column type, TTL, … */
  detail?: string
  /** Driver-specific metadata; the UI does not interpret it */
  meta?: Readonly<Record<string, unknown>>
}

/** Structure of a collection (returned by describeCollection) */
export interface CollectionSchemaInfo {
  ref: CollectionRef
  columns: ColumnDef[]
  primaryKey?: string[]
  /** Estimated row count (PG reads reltuples — never count(*) a whole table) */
  rowCountEstimate?: number
  indexes?: { name: string; columns: string[]; unique: boolean }[]
  comment?: string
}

/* ================================================================== */
/* 6. Requests and responses                                           */
/* ================================================================== */

export interface ServerInfo {
  /** Version string, e.g. '16.4' */
  version: string
  /** Which implementation, e.g. 'PostgreSQL' / 'CockroachDB' / 'Valkey' */
  flavor?: string
  extra?: Readonly<Record<string, string>>
}

export interface TabularQueryRequest {
  resultId: ResultId
  /** Statement text (SQL or another dialect) */
  text: string
  params?: readonly unknown[]
  /** Row ceiling; going past it sets done.truncated = true */
  maxRows?: number
  /** Suggested rows per chunk; when absent the driver adapts via adaptiveChunkRows */
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CollectionScanRequest {
  resultId: ResultId
  ref: CollectionRef
  filter?: readonly FilterSpec[]
  sort?: readonly SortSpec[]
  /** Fetch only these columns (qdrant returns payload only by default; the vector itself goes through valuePeek) */
  columns?: readonly string[]
  offset?: number
  limit?: number
  /** Continuation cursor: redis SCAN cursor / qdrant next_page_offset. When given, `offset` is ignored. */
  cursorToken?: string
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface VectorSearchRequest {
  resultId: ResultId
  collection: string
  /** The query vector itself */
  queryVec?: readonly number[]
  /** Named vector field (qdrant multi-vector setups) */
  vectorName?: string
  topK: number
  filter?: readonly FilterSpec[]
  /** Whether to return the vectors as well (default false: payload + score only) */
  withVector?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface KeyValueResult {
  ref: ValueRef
  /** Driver-side type name; for redis one of string|hash|list|set|zset|stream */
  type: string
  /** Remaining TTL in milliseconds; -1 means it never expires */
  ttlMs?: number
  /**
   * The typed value. The inspector interprets it by `type`:
   * string → string; hash → Record<string,unknown>; list/set → unknown[];
   * zset → { member: string; score: number }[]
   */
  value: unknown
  /** The value was too large and got truncated; fetch it in full via peekValue */
  truncated?: boolean
  /** Total element count (number of hash fields, list length, …) */
  size?: number
}

export interface PeekedValue {
  ref: ValueRef
  encoding: 'utf8' | 'base64' | 'json'
  data: string
  /** Bytes returned by this call */
  byteLength: number
  /** Total byte length, when it can be determined */
  totalBytes?: number
  /** MIME type, so the frontend can pick a renderer: 'application/json' / 'text/plain' / 'application/octet-stream' */
  contentType?: string
  /** The end has been reached */
  eof: boolean
}

export interface ByteRange {
  offset: number
  /** Must not exceed VALUE_PEEK_MAX_BYTES */
  length: number
}

/* ================================================================== */
/* 7. Cursor: the only way streamed results leave a driver             */
/* ================================================================== */

/**
 * A cursor handle. **tabularQuery / collectionScan / vectorSearch all return one;
 * returning a whole array is never allowed** — a million-row result set has to be
 * streamable.
 *
 * Pull semantics:
 * - `next()` returns one frame per call; the final frame carries `done`.
 * - Calling `next()` after the final frame returns null.
 * - On failure `next()` rejects, always with a PeekError-shaped value (funnel
 *   through `toPeekError`).
 * - `close()` is idempotent and must release the underlying cursor/connection.
 */
export interface Cursor {
  readonly resultId: ResultId
  /** May be null until the first frame arrives */
  readonly schema: readonly ColumnDef[] | null
  next(): Promise<ChunkFrame | null>
  close(): Promise<void>
}

/* ================================================================== */
/* 8. Driver / DriverSession                                           */
/* ================================================================== */

export interface DriverMeta {
  id: DriverId
  displayName: string
}

/**
 * Driver factory. Runs inside the driver host (a utilityProcess), one process per
 * connection. The generic `C` lets a concrete driver narrow its own config type so
 * the implementation never has to re-discriminate on `driverId`.
 */
export interface Driver<C extends ConnectionConfig = ConnectionConfig> {
  readonly meta: DriverMeta
  readonly capabilities: ReadonlySet<Capability>
  connect(cfg: C, signal?: AbortSignal): Promise<DriverSession>
}

/**
 * A live connection. **Methods are optional, keyed by capability**: advertise a
 * capability and you must implement its method; do not implement methods for
 * capabilities you did not advertise. Callers narrow with the type guards below
 * rather than reaching for `!`.
 *
 * | capability      | must implement                   |
 * |-----------------|----------------------------------|
 * | introspect      | listChildren, describeCollection |
 * | tabularQuery    | query                            |
 * | collectionScan  | scan                             |
 * | keyValue        | getValue                         |
 * | vectorSearch    | vectorSearch                     |
 * | valuePeek       | peekValue                        |
 * | cancel          | cancel                           |
 */
export interface DriverSession {
  readonly driverId: DriverId
  readonly capabilities: ReadonlySet<Capability>
  readonly serverInfo?: ServerInfo

  /** Idempotent close */
  close(): Promise<void>
  /** Optional health check */
  ping?(): Promise<void>

  /* --- introspect --- */
  /** A null parentId asks for the root level */
  listChildren?(parentId: string | null): Promise<NamespaceNode[]>
  describeCollection?(ref: CollectionRef): Promise<CollectionSchemaInfo>

  /* --- tabularQuery --- */
  query?(req: TabularQueryRequest): Promise<Cursor>

  /* --- collectionScan --- */
  scan?(req: CollectionScanRequest): Promise<Cursor>

  /* --- keyValue --- */
  getValue?(ref: ValueRef): Promise<KeyValueResult>

  /* --- vectorSearch --- */
  vectorSearch?(req: VectorSearchRequest): Promise<Cursor>

  /* --- valuePeek --- */
  peekValue?(ref: ValueRef, range?: ByteRange): Promise<PeekedValue>

  /* --- cancel --- */
  /** Cancel a result set. If it is not running, do not throw — just return false. */
  cancel?(resultId: ResultId): Promise<boolean>
}

/* ------------------------------------------------------------------ */
/* Type guards: narrow a session by capability, so nobody has to write */
/* the unsafe `session.query!(...)`                                    */
/* ------------------------------------------------------------------ */

type WithMethod<M extends keyof DriverSession> = DriverSession & Required<Pick<DriverSession, M>>

export function hasCapability(session: DriverSession, cap: Capability): boolean {
  return session.capabilities.has(cap)
}

export function supportsIntrospect(s: DriverSession): s is WithMethod<'listChildren' | 'describeCollection'> {
  return s.capabilities.has('introspect') && typeof s.listChildren === 'function'
}

export function supportsTabularQuery(s: DriverSession): s is WithMethod<'query'> {
  return s.capabilities.has('tabularQuery') && typeof s.query === 'function'
}

export function supportsCollectionScan(s: DriverSession): s is WithMethod<'scan'> {
  return s.capabilities.has('collectionScan') && typeof s.scan === 'function'
}

export function supportsKeyValue(s: DriverSession): s is WithMethod<'getValue'> {
  return s.capabilities.has('keyValue') && typeof s.getValue === 'function'
}

export function supportsVectorSearch(s: DriverSession): s is WithMethod<'vectorSearch'> {
  return s.capabilities.has('vectorSearch') && typeof s.vectorSearch === 'function'
}

export function supportsValuePeek(s: DriverSession): s is WithMethod<'peekValue'> {
  return s.capabilities.has('valuePeek') && typeof s.peekValue === 'function'
}

export function supportsCancel(s: DriverSession): s is WithMethod<'cancel'> {
  return s.capabilities.has('cancel') && typeof s.cancel === 'function'
}
