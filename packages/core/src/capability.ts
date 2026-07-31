import { z } from 'zod'
import type { ChunkFrame, ColumnDef } from './chunk'
import { ResultIdSchema, type ResultId } from './ids'

/* ================================================================== */
/* 1. Capability                                                       */
/* ================================================================== */

export const CAPABILITIES = [
  /** 命名空间树：db→schema→table / db→key-pattern / collection */
  'introspect',
  /** 自由查询语句（SQL 等），返回表格流 */
  'tabularQuery',
  /** 顺序/分页浏览一个集合（表、keyspace、collection） */
  'collectionScan',
  /** 按 key 取值 + 类型化检查器（redis hash/list/zset…） */
  'keyValue',
  /** 向量相似检索（qdrant） */
  'vectorSearch',
  /** 大 value 按需取全量（长文本/blob/向量本体） */
  'valuePeek',
  /** 取消执行中的操作 */
  'cancel',
] as const

export const CapabilitySchema = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof CapabilitySchema>

export const DRIVER_IDS = ['postgres', 'mysql', 'sqlite', 'redis', 'qdrant'] as const
export const DriverIdSchema = z.enum(DRIVER_IDS)
export type DriverId = z.infer<typeof DriverIdSchema>

/**
 * 各驱动声明的能力集（PLAN 第 4 节的四库对照）。
 * UI 与 MCP 工具在**连上之前**就靠这张表做能力自适应；
 * 连上之后以 DriverSession.capabilities 为准（可能更窄，比如老版本 PG）。
 */
export const DRIVER_CAPABILITIES: Readonly<Record<DriverId, readonly Capability[]>> = {
  postgres: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  mysql: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  sqlite: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  redis: ['introspect', 'collectionScan', 'keyValue', 'valuePeek', 'cancel'],
  qdrant: ['introspect', 'collectionScan', 'vectorSearch', 'valuePeek'],
}

/* ================================================================== */
/* 2. ConnectionConfig（按 driverId 可辨识联合）                          */
/* ================================================================== */

const baseConn = {
  /** 用户可见的连接名；不填由 main 从 host/database 推一个 */
  label: z.string().optional(),
} as const

export const PostgresConnectionConfigSchema = z.object({
  driverId: z.literal('postgres'),
  ...baseConn,
  /** postgresql://user:pass@host:port/db —— 给了 url 就以 url 为准，其余字段作为覆盖 */
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ssl: z.boolean().optional(),
  applicationName: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  /** 默认 search_path，影响 introspect 的默认 schema */
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
  /** 数据库文件绝对路径；':memory:' 表示内存库 */
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

/** 密码占位符。任何要离开 main 进程边界的 config 都必须先脱敏。 */
export const REDACTED = '***'

/**
 * 脱敏：给 MCP / renderer 看的 config 一律走这里。
 * 连接串里的密码也会被替换掉。
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
 * 从 config 推一个默认展示名（label 为空时用）。
 *
 * label 是要广播给 renderer 和 MCP 的，而 postgres/mysql/redis 在没填 database/host 时
 * 会退化到连接串，连接串里带着明文口令 —— 所以这里**内部一律先把 url 里的口令抹掉**，
 * 调用方不需要（也不该需要）记得先 redactConnectionConfig。
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
/* 3. Ref：集合定位与单值定位                                            */
/* ================================================================== */

/** 关系库的表/视图 */
export const RelationRefSchema = z.object({
  kind: z.literal('relation'),
  /** sqlite/mysql 没有 schema 层时填 '' 或 'main' / 库名 */
  schema: z.string(),
  name: z.string().min(1),
})

/** redis 的 key 模式（SCAN MATCH），永远不要退化成 KEYS */
export const KeyPatternRefSchema = z.object({
  kind: z.literal('keyPattern'),
  /** glob 模式，如 'user:*'；'*' 表示整库 */
  pattern: z.string(),
  db: z.number().int().nonnegative().optional(),
  /** 只扫某种类型（TYPE 过滤） */
  typeFilter: z.string().optional(),
})

/** qdrant 的 collection */
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

/** 集合的可读展示名，UI 与 MCP 摘要统一用这个 */
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
 * 单个大 value 的定位符，供 valuePeek / inspector 视图使用。
 * 四种来源：结果集单元格、关系表单元格（按主键）、redis key（可带路径）、qdrant point 字段。
 */
export const ValueRefSchema = z.discriminatedUnion('kind', [
  /** 结果集内的某个单元格：最常用，chunk 里的截断值就带这个 */
  z.object({
    kind: z.literal('resultCell'),
    resultId: ResultIdSchema,
    /** 结果集内的全局行下标（不是 chunk 内下标） */
    row: z.number().int().nonnegative(),
    /** 列下标 */
    col: z.number().int().nonnegative(),
  }),
  /** 关系表的某个单元格，按主键定位（结果集被淘汰后仍可回源） */
  z.object({
    kind: z.literal('relationCell'),
    collection: RelationRefSchema,
    /** 主键列 → 值 */
    pk: z.record(z.string(), z.unknown()),
    column: z.string().min(1),
  }),
  /** redis：key 本体，或 hash field / list index / zset member */
  z.object({
    kind: z.literal('redisValue'),
    key: z.string().min(1),
    db: z.number().int().nonnegative().optional(),
    /** hash 的 field、list 的下标、zset 的 member；不填表示整个 key */
    path: z.string().optional(),
  }),
  /** qdrant：某个 point 的 payload 字段或向量本体（field === 'vector'） */
  z.object({
    kind: z.literal('qdrantPoint'),
    collection: z.string().min(1),
    pointId: z.union([z.string(), z.number()]),
    field: z.string().min(1),
  }),
])

export type ValueRef = z.infer<typeof ValueRefSchema>

/* ================================================================== */
/* 4. 过滤与排序                                                        */
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
  /** isNull / isNotNull 不需要 value；in 需要数组 */
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
/* 5. 命名空间树                                                        */
/* ================================================================== */

export const NAMESPACE_NODE_KINDS = [
  'database', 'schema', 'table', 'view', 'materializedView',
  'keyspace', 'keyPrefix', 'key', 'collection', 'index', 'column', 'folder',
] as const
export type NamespaceNodeKind = (typeof NAMESPACE_NODE_KINDS)[number]

/**
 * 命名空间树节点。**懒加载**：一次 listChildren 只返回一层，
 * `hasChildren` 决定 UI 画不画展开箭头（未知时给 true，展开后拿到空数组再收起）。
 */
export interface NamespaceNode {
  /**
   * 连接内唯一的节点 id，同时是 listChildren 的 parentId。
   * 约定为路径式且稳定可重建，如 'schema:public'、'relation:public.harness'。
   */
  id: string
  /** 显示名 */
  name: string
  kind: NamespaceNodeKind
  /** 是否还有下一层（懒加载标记） */
  hasChildren: boolean
  /** 可以直接 view.open 成 table 视图的节点带上它 */
  ref?: CollectionRef
  /** 右侧灰字：行数估算、列类型、TTL 等 */
  detail?: string
  /** 驱动自定义元信息，UI 不解释 */
  meta?: Readonly<Record<string, unknown>>
}

/** 集合结构描述（describeCollection 返回） */
export interface CollectionSchemaInfo {
  ref: CollectionRef
  columns: ColumnDef[]
  primaryKey?: string[]
  /** 估算行数（PG 走 reltuples，别 count(*) 全表） */
  rowCountEstimate?: number
  indexes?: { name: string; columns: string[]; unique: boolean }[]
  comment?: string
}

/* ================================================================== */
/* 6. 请求与返回                                                        */
/* ================================================================== */

export interface ServerInfo {
  /** 版本号字符串，如 '16.4' */
  version: string
  /** 具体实现风味，如 'PostgreSQL' / 'CockroachDB' / 'Valkey' */
  flavor?: string
  extra?: Readonly<Record<string, string>>
}

export interface TabularQueryRequest {
  resultId: ResultId
  /** 语句文本（SQL 或其他方言） */
  text: string
  params?: readonly unknown[]
  /** 最多取多少行，超出则 done.truncated = true */
  maxRows?: number
  /** 建议的单 chunk 行数；不给则驱动按 adaptiveChunkRows 自适应 */
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CollectionScanRequest {
  resultId: ResultId
  ref: CollectionRef
  filter?: readonly FilterSpec[]
  sort?: readonly SortSpec[]
  /** 只取这些列（qdrant 默认只取 payload，向量本体走 valuePeek） */
  columns?: readonly string[]
  offset?: number
  limit?: number
  /** 续拉游标：redis SCAN cursor / qdrant next_page_offset。给了就忽略 offset。 */
  cursorToken?: string
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface VectorSearchRequest {
  resultId: ResultId
  collection: string
  /** 查询向量本体 */
  queryVec?: readonly number[]
  /** 命名向量字段（qdrant 多向量场景） */
  vectorName?: string
  topK: number
  filter?: readonly FilterSpec[]
  /** 是否把向量本体一起带回（默认 false，只带 payload + score） */
  withVector?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface KeyValueResult {
  ref: ValueRef
  /** 驱动侧类型名，redis 为 string|hash|list|set|zset|stream */
  type: string
  /** 毫秒剩余 TTL，-1 表示永不过期 */
  ttlMs?: number
  /**
   * 类型化的值。检查器按 type 分发解释：
   * string → string；hash → Record<string,unknown>；list/set → unknown[]；
   * zset → { member: string; score: number }[]
   */
  value: unknown
  /** 值过大已被截断，全量走 peekValue */
  truncated?: boolean
  /** 元素总数（hash field 数 / list 长度等） */
  size?: number
}

export interface PeekedValue {
  ref: ValueRef
  encoding: 'utf8' | 'base64' | 'json'
  data: string
  /** 本次返回的字节数 */
  byteLength: number
  /** 全量字节数（可知时） */
  totalBytes?: number
  /** MIME，供前端选渲染器：'application/json' / 'text/plain' / 'application/octet-stream' */
  contentType?: string
  /** 已到末尾 */
  eof: boolean
}

export interface ByteRange {
  offset: number
  /** 不超过 VALUE_PEEK_MAX_BYTES */
  length: number
}

/* ================================================================== */
/* 7. 游标：流式结果的唯一出口                                            */
/* ================================================================== */

/**
 * 游标句柄。**tabularQuery / collectionScan / vectorSearch 一律返回它，
 * 绝不允许返回整个数组**——百万行结果集必须能流式吐。
 *
 * 拉取语义：
 * - `next()` 每次返回一帧；末帧带 `done`。
 * - 末帧之后再调 `next()` 返回 null。
 * - 出错时 `next()` reject（reject 的一律是 PeekError 形状，用 toPeekError 收敛）。
 * - `close()` 幂等，必须释放底层游标/连接。
 */
export interface Cursor {
  readonly resultId: ResultId
  /** 首帧到达前可能为 null */
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
 * 驱动工厂。跑在 driver host（utilityProcess）里，每个连接一个进程。
 * 泛型 C 让具体驱动收窄自己的 config 类型，不必在实现里做 driverId 判别。
 */
export interface Driver<C extends ConnectionConfig = ConnectionConfig> {
  readonly meta: DriverMeta
  readonly capabilities: ReadonlySet<Capability>
  connect(cfg: C, signal?: AbortSignal): Promise<DriverSession>
}

/**
 * 一个活连接。**方法按 capability 可选**：声明了某能力就必须实现对应方法，
 * 没声明就不要实现（调用方用下面的类型守卫收窄，不要硬 `!`）。
 *
 * | capability      | 必须实现                          |
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

  /** 幂等关闭 */
  close(): Promise<void>
  /** 健康检查，可选 */
  ping?(): Promise<void>

  /* --- introspect --- */
  /** parentId 为 null 表示取根层 */
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
  /** 取消指定结果集；未在执行中也不能抛错，返回 false 即可 */
  cancel?(resultId: ResultId): Promise<boolean>
}

/* ------------------------------------------------------------------ */
/* 类型守卫：按能力收窄 session，替代不安全的 `session.query!(...)`        */
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
