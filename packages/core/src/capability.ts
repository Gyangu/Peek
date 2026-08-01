import { z } from 'zod'
import type { ChunkFrame, ColumnDef, TruncatedValue } from './chunk'
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
    /**
     * One element inside the key; absent means the whole key.
     *
     * The string is interpreted by the key's redis type, and there is exactly one
     * reading per type — a driver must not invent a second:
     *   string → must be absent (the key has no elements)
     *   hash   → the field name
     *   list   → the index, base-10, may be negative the way LINDEX allows ('-1')
     *   set    → the member
     *   zset   → the member (its score travels in KeyValueResult, not here)
     *   stream → the entry id ('1712345678901-0'), optionally 'id/field'
     */
    path: z.string().optional(),
  }),
  /**
   * qdrant: one field of one point.
   *
   * `field` names a top-level payload key, **or** addresses the vector itself
   * through the reserved prefix below. Payload keys colliding with it are
   * addressed as `payload:<key>`, which is always unambiguous.
   */
  z.object({
    kind: z.literal('qdrantPoint'),
    collection: z.string().min(1),
    pointId: z.union([z.string(), z.number()]),
    field: z.string().min(1),
  }),
])

export type ValueRef = z.infer<typeof ValueRefSchema>

/**
 * `ValueRef.field` naming for a qdrant point, frozen here so the driver, the
 * inspector and the MCP tools cannot disagree:
 *
 *   'vector'          the default (unnamed) vector
 *   'vector:<name>'   a named vector in a multi-vector collection
 *   'payload:<key>'   a payload key, when it would otherwise collide with the above
 *   anything else     a top-level payload key, verbatim
 */
export const QDRANT_VECTOR_FIELD = 'vector' as const
export const QDRANT_VECTOR_FIELD_PREFIX = 'vector:' as const
export const QDRANT_PAYLOAD_FIELD_PREFIX = 'payload:' as const

export type QdrantFieldTarget =
  | { target: 'vector'; name?: string }
  | { target: 'payload'; key: string }

/** Decode a `qdrantPoint` ref's `field` per the convention above. */
export function parseQdrantField(field: string): QdrantFieldTarget {
  if (field === QDRANT_VECTOR_FIELD) return { target: 'vector' }
  if (field.startsWith(QDRANT_VECTOR_FIELD_PREFIX)) {
    return { target: 'vector', name: field.slice(QDRANT_VECTOR_FIELD_PREFIX.length) }
  }
  if (field.startsWith(QDRANT_PAYLOAD_FIELD_PREFIX)) {
    return { target: 'payload', key: field.slice(QDRANT_PAYLOAD_FIELD_PREFIX.length) }
  }
  return { target: 'payload', key: field }
}

/** Encode a payload key into a `field`, escaping it when it would read as a vector address. */
export function qdrantPayloadField(key: string): string {
  return key === QDRANT_VECTOR_FIELD
    || key.startsWith(QDRANT_VECTOR_FIELD_PREFIX)
    || key.startsWith(QDRANT_PAYLOAD_FIELD_PREFIX)
    ? `${QDRANT_PAYLOAD_FIELD_PREFIX}${key}`
    : key
}

/* ------------------------------------------------------------------ */
/* How a collection can be browsed                                     */
/* ------------------------------------------------------------------ */

/**
 * What paging and ordering mean for one kind of collection.
 *
 * `CollectionScanRequest` offers `sort` and `offset` unconditionally, because
 * both are obvious for a relation — and neither exists for a cursor store. Redis
 * addresses only page boundaries, so "sort this page" is a lie about the whole
 * scan and `offset` is an O(n) rescan; qdrant's scroll cannot combine `order_by`
 * with an offset at all. The drivers are right to answer BAD_REQUEST, but a UI
 * that only finds out by being told off has already drawn a sortable column
 * header — so this table is what the renderer consults *before* drawing one
 * (`views/TableView.tsx`), and it is the single place that knowledge lives.
 *
 * **Why it is keyed on `CollectionRef['kind']` rather than declared by the
 * driver.** The kind *is* the shape: a relation, a key pattern, a vector
 * collection. Two drivers browsing the same kind browse it the same way — that
 * is what makes the kind worth having — so a per-driver answer would be the same
 * answer written five times. A sixth database that genuinely browses differently
 * has to add a `CollectionRef` kind, and `Record<CollectionRef['kind'], …>` then
 * fails to compile until this table is filled in: the exhaustiveness is the
 * point, not an edit someone can forget.
 *
 * A per-*collection* answer (this table is sortable, that one is not, in the same
 * driver) would belong on `CollectionSchemaInfo` and would refine this rather
 * than replace it. Nothing needs it yet.
 */
export interface CollectionBrowseStyle {
  /** Column headers may offer ordering (the driver honours SortSpec) */
  sortable: boolean
  /** `offset` addresses a page cheaply; when false, paging must go through cursorToken */
  offsetPaging: boolean
  /** `ChunkDone.nextCursor` is how the next page is reached */
  cursorPaging: boolean
}

const BROWSE_STYLE: Readonly<Record<CollectionRef['kind'], CollectionBrowseStyle>> = {
  // A relation is the one collection where SQL gives both for free.
  relation: { sortable: true, offsetPaging: true, cursorPaging: true },
  // SCAN yields whole pages in cursor order. Sorting one page describes nothing,
  // and an offset is re-scanning everything before it.
  keyPattern: { sortable: false, offsetPaging: false, cursorPaging: true },
  // scroll pages by point id; `order_by` and an offset are mutually exclusive
  // server-side, so ordering here means "one page, no continuation".
  vectorCollection: { sortable: true, offsetPaging: false, cursorPaging: true },
}

export function collectionBrowseStyle(ref: CollectionRef): CollectionBrowseStyle {
  return BROWSE_STYLE[ref.kind]
}

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
  /**
   * Driver-native filter, passed through verbatim, ANDed with `filter`.
   *
   * The escape hatch for the handful of predicates `FilterSpec` genuinely cannot
   * express (qdrant's nested / geo / has_id clauses, say). **The UI never
   * generates one** — it comes from an MCP caller who knows the target database.
   * A driver that does not understand the shape it receives must reject it with
   * BAD_REQUEST rather than silently ignore it, or the caller gets more rows than
   * they asked for and no way to tell.
   */
  nativeFilter?: unknown
  sort?: readonly SortSpec[]
  /**
   * Restrict the projection.
   *
   * Relational drivers read this as a column list. Document/vector drivers read
   * it as the payload keys to **flatten into their own columns** — see
   * `buildVectorResultSchema`, which is the one place that rule is implemented.
   * Omitted means the driver's default projection.
   */
  columns?: readonly string[]
  offset?: number
  limit?: number
  /**
   * Continuation cursor, opaque to everyone but the driver that minted it as
   * `ChunkDone.nextCursor`. When given, `offset` is ignored.
   *
   * What each driver puts in it:
   *   postgres/mysql/sqlite  the absolute row offset of the next page
   *   redis                  the SCAN cursor ('0' is never handed out — a cursor
   *                          back at 0 means the keyspace is exhausted, so the
   *                          driver omits nextCursor instead)
   *   qdrant                 scroll's next_page_offset, JSON-encoded when the
   *                          collection uses non-string point ids
   */
  cursorToken?: string
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface VectorSearchRequest {
  resultId: ResultId
  collection: string
  /**
   * The query vector itself. Exactly one of `queryVec` / `queryPointId` must be
   * present — a driver receiving both, or neither, rejects with BAD_REQUEST.
   * **Drivers never embed text**: turning `VectorViewState.queryText` into a
   * vector belongs to a layer above, and a driver asked to search without a
   * vector must say so rather than guess.
   */
  queryVec?: readonly number[]
  /** Search by an existing point ("more like this"), instead of a literal vector */
  queryPointId?: string | number
  /** Named vector field (qdrant multi-vector setups); omitted means the default vector */
  vectorName?: string
  topK: number
  filter?: readonly FilterSpec[]
  /** See CollectionScanRequest.nativeFilter — identical contract */
  nativeFilter?: unknown
  /** Drop results scoring below this; the metric decides whether that means far or near */
  scoreThreshold?: number
  /** Skip this many of the best matches (paging through a search) */
  offset?: number
  /** Payload keys to flatten into columns; omitted means one json `payload` column */
  columns?: readonly string[]
  /** Whether to return the vectors as well (default false: the vector body goes through valuePeek) */
  withVector?: boolean
  /** Whether to return payload at all (default true) */
  withPayload?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/* ------------------------------------------------------------------ */
/* keyValue: one key, one typed value                                  */
/* ------------------------------------------------------------------ */

/**
 * How a value is **shaped**, which is all the inspector needs to pick a renderer.
 *
 * Deliberately not redis's own type names: `type` carries those verbatim. The
 * shape is the driver-independent bucketing (a Memcached or etcd driver would be
 * all `scalar`; a document store's top-level object is a `map`), and it is what
 * a `switch` in the UI is allowed to be exhaustive over.
 */
export const KEY_VALUE_SHAPES = [
  'scalar', 'map', 'list', 'set', 'sortedSet', 'stream', 'missing',
] as const
export type KeyValueShape = (typeof KEY_VALUE_SHAPES)[number]

/**
 * One element of a value. A `TruncatedValue` means the element itself blew past
 * VALUE_PREVIEW_BYTES and only a preview travelled; its `ref` addresses the whole
 * thing through valuePeek.
 */
export type KeyValueElement = string | TruncatedValue

export interface KeyValueField {
  field: string
  value: KeyValueElement
}

export interface KeyValueScored {
  member: KeyValueElement
  score: number
}

export interface KeyValueStreamEntry {
  /** Entry id, e.g. '1712345678901-0' */
  id: string
  fields: KeyValueField[]
}

/**
 * The typed value, as a discriminated union.
 *
 * This exists because "redis value" is six unrelated data structures wearing one
 * name, and `value: unknown` pushed the job of telling them apart onto every
 * reader — the inspector, the MCP summary, the value formatter — each of which
 * would have re-derived it from the `type` string, differently.
 *
 * Every list-ish member holds **one window**, not the whole structure: a hash with
 * a million fields must not be materialized to render a panel. `KeyValueResult`
 * carries the window's position (`size`, `nextCursor`, `truncated`).
 */
export type KeyValuePayload =
  | { shape: 'scalar'; value: KeyValueElement }
  | { shape: 'map'; fields: KeyValueField[] }
  /** `start` is the absolute index of `items[0]`, so the UI can label rows */
  | { shape: 'list'; items: KeyValueElement[]; start: number }
  | { shape: 'set'; members: KeyValueElement[] }
  | { shape: 'sortedSet'; entries: KeyValueScored[] }
  | { shape: 'stream'; entries: KeyValueStreamEntry[] }
  /** The key does not exist (or expired between the SCAN and the read) */
  | { shape: 'missing' }

/** How much of a large value to read, and where from. All fields optional: the defaults are a sane first window. */
export interface KeyValueReadOptions {
  /** Elements in this window; defaults to DEFAULT_KEY_VALUE_ELEMENTS, capped at MAX_KEY_VALUE_ELEMENTS */
  limit?: number
  /** Absolute element offset, for the index-addressable shapes (list, sortedSet, stream) */
  offset?: number
  /** Continuation cursor for the cursor-addressable shapes (map, set — HSCAN / SSCAN) */
  cursorToken?: string
  /** Glob filter over field names / members (HSCAN MATCH); ignored by shapes that cannot honour it */
  match?: string
  signal?: AbortSignal
}

export interface KeyValueResult {
  ref: ValueRef
  /** Driver-native type name, verbatim: for redis one of string|hash|list|set|zset|stream|none */
  type: string
  /** Remaining TTL in milliseconds; -1 means it never expires, undefined means unknown */
  ttlMs?: number
  /** The typed value — one window of it (see KeyValuePayload) */
  value: KeyValuePayload
  /** Elements beyond this window exist (or the scalar was cut at VALUE_PREVIEW_BYTES) */
  truncated?: boolean
  /** Cursor for the next window; present means more can be fetched */
  nextCursor?: string
  /** Total element count (hash fields, list length, …), when the server can report it cheaply */
  size?: number
  /** Memory footprint in bytes (redis MEMORY USAGE), when available */
  byteSize?: number
  /** Driver-native storage encoding (redis OBJECT ENCODING: listpack / hashtable / skiplist …) */
  encoding?: string
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
/* 6b. Canonical result schemas for the non-relational drivers         */
/* ================================================================== */

/**
 * A relational scan gets its columns from the table. A keyspace scan and a vector
 * scroll do not have a table, so the columns are a **contract decision** — and it
 * has to be made once, here, rather than three times in three drivers.
 *
 * The chunk protocol makes this non-negotiable: `schema` rides on frame 0 and is
 * never repeated, so the column set has to be knowable **before the first row is
 * read**. Deriving columns from the data (union of the payload keys seen so far)
 * is therefore not merely inelegant, it is unimplementable — row 900,001 would
 * need a column that frame 0 already promised did not exist.
 */

/** Column names of a redis keyspace scan. Referenced by the UI (row click → inspector) and by MCP summaries. */
export const KEYSPACE_SCAN_COLUMNS = {
  key: 'key',
  type: 'type',
  ttlMs: 'ttlMs',
  size: 'size',
  bytes: 'bytes',
  encoding: 'encoding',
} as const

/**
 * Schema of a keyspace scan: one row per key, the value itself deliberately absent.
 *
 * Reading every value during a SCAN would turn browsing a keyspace into
 * downloading the whole database — the per-key metadata below is what a listing
 * needs, and the value arrives through keyValue when a row is selected. `size`
 * and `bytes` are best-effort: MEMORY USAGE is O(1)-ish but not free, so a driver
 * may leave them null on very wide pages.
 */
export const KEYSPACE_SCAN_SCHEMA: readonly ColumnDef[] = [
  { name: KEYSPACE_SCAN_COLUMNS.key, logical: 'string', nativeType: 'key', primaryKey: true, peekable: true },
  { name: KEYSPACE_SCAN_COLUMNS.type, logical: 'string', nativeType: 'type' },
  { name: KEYSPACE_SCAN_COLUMNS.ttlMs, logical: 'number', nativeType: 'ttl', nullable: true },
  { name: KEYSPACE_SCAN_COLUMNS.size, logical: 'number', nativeType: 'elements', nullable: true },
  { name: KEYSPACE_SCAN_COLUMNS.bytes, logical: 'number', nativeType: 'bytes', nullable: true },
  { name: KEYSPACE_SCAN_COLUMNS.encoding, logical: 'string', nativeType: 'encoding', nullable: true },
]

/** Column names of a vector scroll / search result. */
export const VECTOR_RESULT_COLUMNS = {
  id: 'id',
  score: 'score',
  payload: 'payload',
  vector: 'vector',
} as const

export interface VectorResultSchemaOptions {
  /** Add the `score` column: true for vectorSearch, false for a plain scroll */
  withScore?: boolean
  /**
   * Payload keys to flatten into one column each. Empty or omitted keeps the whole
   * payload in a single json column, which is the default and the only shape that
   * is honest about a schemaless payload.
   */
  payloadColumns?: readonly string[]
  /** Add the `vector` column (peekable, usually truncated). Off by default: the body goes through valuePeek. */
  withVector?: boolean
}

/**
 * Build the schema of a vector result. The single implementation of the
 * "flatten or not" rule, so a scroll and a search can never disagree about
 * column order.
 *
 * Column order is fixed: id, [score], (payload | flattened payload keys), [vector].
 */
export function buildVectorResultSchema(opts: VectorResultSchemaOptions = {}): ColumnDef[] {
  const cols: ColumnDef[] = [
    { name: VECTOR_RESULT_COLUMNS.id, logical: 'string', nativeType: 'point_id', primaryKey: true },
  ]
  if (opts.withScore) {
    cols.push({ name: VECTOR_RESULT_COLUMNS.score, logical: 'number', nativeType: 'score' })
  }
  const flat = opts.payloadColumns ?? []
  if (flat.length > 0) {
    for (const key of flat) {
      cols.push({ name: key, logical: 'json', nativeType: 'payload', nullable: true, peekable: true })
    }
  } else {
    cols.push({
      name: VECTOR_RESULT_COLUMNS.payload,
      logical: 'json',
      nativeType: 'payload',
      nullable: true,
      peekable: true,
    })
  }
  if (opts.withVector) {
    cols.push({
      name: VECTOR_RESULT_COLUMNS.vector,
      logical: 'vector',
      nativeType: 'vector',
      nullable: true,
      peekable: true,
    })
  }
  return cols
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
  /**
   * Read one key. `opts` selects a window of a large structure; a driver that
   * ignores it must still fill in `size` / `truncated` truthfully, so the caller
   * can tell it did not get everything.
   */
  getValue?(ref: ValueRef, opts?: KeyValueReadOptions): Promise<KeyValueResult>

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
