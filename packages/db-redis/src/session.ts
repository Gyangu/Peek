import {
  DEFAULT_PAGE_LIMIT,
  KEYSPACE_SCAN_COLUMNS,
  KEYSPACE_SCAN_SCHEMA,
  MAX_KEY_VALUE_ELEMENTS,
  MAX_PAGE_LIMIT,
  VALUE_PREVIEW_BYTES,
  assertBrowseSupported,
  collectionBrowseStyle,
  peekError,
  peekErrorMsg,
  truncatedValue,
  type ByteRange,
  type Capability,
  type CollectionBrowseStyle,
  type CollectionRef,
  type CollectionScanRequest,
  type CollectionSchemaInfo,
  type ColumnDef,
  type Cursor,
  type DriverId,
  type DriverSession,
  type FilterSpec,
  type KeyPatternRef,
  type KeyValueField,
  type KeyValuePayload,
  type KeyValueReadOptions,
  type KeyValueResult,
  type KeyValueStreamEntry,
  type NamespaceNode,
  type PeekedValue,
  type RedisConnectionConfig,
  type ResultId,
  type ServerInfo,
  type ValueRef,
} from '@peek/core'
import { RESP_TYPES, createClient, type RedisClientType } from 'redis'
import { isRedisCommandRefusal, mapRedisError } from './errors'
import { RedisKeyspace, type KeyspaceDeps } from './keyspace'
import { redisManifest } from './manifest'
import {
  RedisScanCursor,
  isRedisResumeToken,
  type RedisKeyRow,
  type RedisScanPage,
} from './scan'
import {
  clampElements,
  clampOffset,
  isRedisType,
  keyValueElement,
  peekRedisValue,
  readKeyValue,
  redisElementRef,
  requireRedisValueRef,
  type RedisPeekDeps,
  type RedisType,
  type RedisValueDeps,
} from './values'

/**
 * One live Redis connection.
 *
 * ## The three rules this class exists to enforce
 *
 * 1. **Never KEYS, ever** (PLAN section 4). Every listing is SCAN with a cursor,
 *    COUNT-hinted by `SCAN_COUNT_HINT`. KEYS on a production keyspace blocks the
 *    single server thread for as long as it takes to walk every key, and peek is
 *    a tool people point at production.
 * 2. **A listing never reads values.** A keyspace scan yields the columns in
 *    `KEYSPACE_SCAN_SCHEMA` — key, type, ttl, size, bytes, encoding — and stops
 *    there. Values arrive through `getValue`, one selected key at a time.
 * 3. **Per-key metadata is pipelined.** One page of 500 keys needs TYPE + PTTL +
 *    MEMORY USAGE + OBJECT ENCODING per key; issued one at a time that is 2000
 *    sequential round trips per chunk. They go in a single pipeline, and a
 *    failing element of that pipeline (the key expired mid-scan, MEMORY USAGE is
 *    disabled on a managed instance) degrades that one cell to null rather than
 *    failing the scan.
 *
 * ## Connection handling
 *
 * A single client is enough — unlike PostgreSQL there is no server-side cursor
 * holding a connection hostage, since a SCAN cursor is a number the client
 * carries between calls. The client must be configured to **fail fast**: a driver
 * host that silently reconnects forever leaves the connection state machine
 * stuck in `ready` while nothing works. Disable the offline queue and cap the
 * reconnect strategy, and let `CONNECTION_LOST` surface.
 *
 * One client per logical database, opened lazily by `duplicate`. The alternative
 * — one client issuing SELECT before each command — makes the database a piece of
 * mutable connection state shared by every concurrent scan, peek and tree
 * expansion, and two of those interleaving reads the wrong database. A handful of
 * sockets is the cheaper mistake.
 *
 * `cancel` cannot interrupt a redis command in flight (there is no
 * pg_cancel_backend equivalent that is safe here — CLIENT UNPAUSE / CLIENT KILL
 * are far too blunt). It marks the scan cursor cancelled so the next iteration
 * stops, which is enough: an individual SCAN round trip is bounded by COUNT.
 */

/**
 * A node-redis client.
 *
 * `RedisClientType` with every generic left at its default is exactly what
 * `createClient(options)` infers here — the package's own alias, not a hand-rolled
 * one. (`ReturnType<typeof createClient>` is **not** the same type: `ReturnType`
 * instantiates a generic signature at its *constraints*, so every reply widens to
 * `string | Buffer` and nothing type-checks.)
 */
type RedisClient = RedisClientType

function openClient(options: ClientOptions): RedisClient {
  return createClient(options)
}

/** The same socket, with blob replies delivered as Buffers instead of strings */
function toBinary(client: RedisClient) {
  return client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
}

type BinaryClient = ReturnType<typeof toBinary>

/** Reconnect attempts before the socket gives up and CONNECTION_LOST surfaces */
const MAX_RECONNECT_ATTEMPTS = 3

/** Logical databases a redis server exposes when CONFIG GET is unavailable */
const DEFAULT_DATABASE_COUNT = 16

/** MEMORY USAGE sample depth; 0 means exact and is far too slow for a listing */
const MEMORY_USAGE_SAMPLES = 5

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** The db a connection lands on: the explicit field wins, then the URL path, then 0 */
export function effectiveDb(cfg: RedisConnectionConfig): number {
  if (cfg.db !== undefined) return cfg.db
  if (cfg.url === undefined) return 0
  try {
    const path = new URL(cfg.url).pathname.replace(/^\//, '')
    const n = Number(path)
    return path.length > 0 && Number.isInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

interface ClientOptions {
  url?: string
  socket: {
    host?: string
    port?: number
    tls?: true
    connectTimeout: number
    reconnectStrategy: (retries: number) => number | false
  }
  username?: string
  password?: string
  database?: number
  disableOfflineQueue: true
}

function buildClientOptions(cfg: RedisConnectionConfig): ClientOptions {
  const out: ClientOptions = {
    socket: {
      connectTimeout: clampInt(cfg.connectTimeoutMs, 100, 120_000) ?? 15_000,
      // Fail fast: a socket that reconnects forever keeps the session looking
      // healthy while every command times out
      reconnectStrategy: (retries: number): number | false =>
        retries >= MAX_RECONNECT_ATTEMPTS ? false : Math.min(200 * (retries + 1), 1_000),
    },
    // Queuing commands while offline turns "the server is gone" into "everything
    // hangs"; the driver host would rather surface CONNECTION_LOST
    disableOfflineQueue: true,
  }
  if (cfg.url !== undefined) out.url = cfg.url
  if (cfg.host !== undefined) out.socket.host = cfg.host
  if (cfg.port !== undefined) out.socket.port = cfg.port
  if (cfg.tls === true) out.socket.tls = true
  if (cfg.username !== undefined) out.username = cfg.username
  if (cfg.password !== undefined) out.password = cfg.password
  out.database = effectiveDb(cfg)
  return out
}

/** Parse an INFO section into its `field:value` pairs */
function parseInfo(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    out.set(line.slice(0, at), line.slice(at + 1))
  }
  return out
}

/** `db0:keys=6,expires=1,avg_ttl=0` → 0 → 6 */
function parseKeyspaceInfo(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const [name, body] of parseInfo(text)) {
    const m = /^db(\d+)$/.exec(name)
    if (!m?.[1]) continue
    const keys = /(?:^|,)keys=(\d+)/.exec(body)?.[1]
    if (keys === undefined) continue
    out.set(Number(m[1]), Number(keys))
  }
  return out
}

/** Race a promise against an AbortSignal, so a slow handshake stays cancellable */
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
  let onAbort: (() => void) | null = null
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(peekErrorMsg('CANCELLED', 'error.conn.connectCancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  // Nothing else awaits this promise once the race settles
  aborted.catch(() => {})
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Close a client without caring whether it was already gone */
function destroyQuietly(client: RedisClient): void {
  try {
    client.destroy()
  } catch {
    // already closed
  }
}

/** What a degradable metadata batch produced */
interface PipelineResult<T> {
  values: (T | null)[]
  /**
   * True when the batch was non-empty and **every** element was refused by the
   * server. That is the signature of a command the whole session cannot use
   * (a denied `MEMORY USAGE`, a renamed `OBJECT`), rather than of a handful of
   * keys expiring mid-scan — so the caller can stop issuing it.
   */
  allRefused: boolean
}

/**
 * Run a batch of commands issued in the same tick (node-redis pipelines those
 * automatically) and degrade a *refused* command to null.
 *
 * The distinction that matters, and the one an earlier "did every element fail?"
 * count got wrong: a rejection is either the server declining one command or the
 * connection failing, and only the reason says which. Counting rejections makes a
 * uniformly-denied `MEMORY USAGE` — the default state of every managed redis with
 * a restricted ACL — indistinguishable from a dropped socket, and kills the scan
 * on a server where the contract (see the class comment) says the cell degrades
 * to null. Conversely a socket error must **not** be smoothed into null metadata,
 * even when only one element saw it, because a page of nulls reads as data.
 */
async function pipeline<T>(promises: readonly Promise<T>[]): Promise<PipelineResult<T>> {
  if (promises.length === 0) return { values: [], allRefused: false }
  const settled = await Promise.allSettled(promises)
  let refused = 0
  for (const r of settled) {
    if (r.status === 'fulfilled') continue
    if (!isRedisCommandRefusal(r.reason)) throw r.reason
    refused += 1
  }
  return {
    values: settled.map((r) => (r.status === 'fulfilled' ? r.value : null)),
    allRefused: refused === settled.length,
  }
}

/** Which per-key metadata a scan actually has to fetch, derived from the projection and the filters */
interface ScanNeeds {
  type: boolean
  ttl: boolean
  size: boolean
  bytes: boolean
  encoding: boolean
}

/** The metadata commands that can be denied wholesale, and are then dropped for the session */
type ScanMetaCommand = 'type' | 'ttl' | 'size' | 'bytes' | 'encoding'

function scanNeedsOf(columns: readonly ColumnDef[], filter: readonly FilterSpec[]): ScanNeeds {
  const wanted = new Set<string>([
    ...columns.map((c) => c.name),
    ...filter.map((f) => f.column),
  ])
  const size = wanted.has(KEYSPACE_SCAN_COLUMNS.size)
  return {
    // The size command is chosen by type, so asking for `size` implies TYPE
    type: wanted.has(KEYSPACE_SCAN_COLUMNS.type) || size,
    ttl: wanted.has(KEYSPACE_SCAN_COLUMNS.ttlMs),
    size,
    bytes: wanted.has(KEYSPACE_SCAN_COLUMNS.bytes),
    encoding: wanted.has(KEYSPACE_SCAN_COLUMNS.encoding),
  }
}

export class RedisSession implements DriverSession {
  readonly driverId: DriverId = 'redis'
  readonly capabilities: ReadonlySet<Capability> = new Set(redisManifest.capabilities)
  readonly serverInfo: ServerInfo

  /** The db this connection was opened on; a ref with no explicit db means this one */
  private readonly defaultDb: number
  private readonly base: RedisClient
  /** One client per logical database, opened on demand; the promise is cached so two callers cannot open two sockets */
  private readonly clients = new Map<number, Promise<RedisClient>>()
  private readonly binaries = new Map<number, BinaryClient>()
  private readonly keyspace: RedisKeyspace
  private readonly valueDeps: RedisValueDeps
  private readonly peekDeps: RedisPeekDeps

  /** Scan cursors currently running; cancel / close work through this */
  private readonly active = new Map<ResultId, RedisScanCursor>()
  /**
   * Metadata commands this server refuses outright (a denied `MEMORY USAGE`, an
   * `OBJECT` that was renamed away). Latched the first time a whole batch comes
   * back refused, so the remaining pages of the scan stop paying one doomed
   * command per key; the column degrades to null, which is what it already did.
   */
  private readonly deniedMeta = new Set<ScanMetaCommand>()
  private closed = false

  private constructor(base: RedisClient, defaultDb: number, serverInfo: ServerInfo) {
    this.base = base
    this.defaultDb = defaultDb
    this.serverInfo = serverInfo
    this.clients.set(defaultDb, Promise.resolve(base))

    const deps: KeyspaceDeps = {
      scanPage: (db, cursor, match, count) => this.scanPage(db, cursor, match, count),
      keyCounts: () => this.keyCounts(),
      databaseCount: () => this.databaseCount(),
      keyTypes: (db, keys) => this.keyTypes(db, keys),
      defaultDb,
    }
    this.keyspace = new RedisKeyspace(deps)

    this.valueDeps = {
      defaultDb,
      describeKey: (db, key) => this.describeKey(db, key),
      readWindow: (db, key, type, opts) => this.readWindow(db, key, type, opts),
      readElement: (db, key, type, path) => this.readElement(db, key, type, path),
    }
    this.peekDeps = {
      defaultDb,
      describeKey: (db, key) => this.describeKey(db, key),
      readStringRange: (db, key, offset, length) => this.readStringRange(db, key, offset, length),
      readElementBytes: (db, key, type, path) => this.readElementBytes(db, key, type, path),
    }
  }

  /**
   * Open the connection and probe the server.
   *
   * `serverInfo` carries the INFO server section: `version` = redis_version,
   * `flavor` = 'Redis' / 'Valkey' / 'KeyDB' (read off INFO rather than assumed),
   * and `extra` holds the keyspace summary the tree shows on its root nodes.
   */
  static async connect(
    cfg: RedisConnectionConfig,
    signal?: AbortSignal,
  ): Promise<RedisSession> {
    if (signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
    const client = openClient(buildClientOptions(cfg))
    // An unhandled 'error' event takes the whole driver host down; every failure
    // that matters surfaces on the awaited command instead
    client.on('error', () => {})
    try {
      await withSignal(client.connect(), signal)
      const serverInfo = await withSignal(RedisSession.probe(client), signal)
      return new RedisSession(client, effectiveDb(cfg), serverInfo)
    } catch (err) {
      destroyQuietly(client)
      throw mapRedisError(err, { fallback: 'CONNECTION_FAILED', command: 'CONNECT' })
    }
  }

  private static async probe(client: RedisClient): Promise<ServerInfo> {
    const [server, keyspace] = await Promise.all([
      client.info('server'),
      client.info('keyspace'),
    ])
    const info = parseInfo(server)
    const version =
      info.get('valkey_version') ?? info.get('keydb_version') ?? info.get('redis_version') ?? '0'
    // server_name is how Valkey identifies itself; KeyDB only advertises its own
    // version field. Everything else is Redis until it says otherwise.
    const named = info.get('server_name')
    const flavor = named !== undefined
      ? named.charAt(0).toUpperCase() + named.slice(1)
      : info.has('keydb_version')
        ? 'KeyDB'
        : 'Redis'
    const counts = parseKeyspaceInfo(keyspace)
    let total = 0
    for (const n of counts.values()) total += n
    const extra: Record<string, string> = { keys: String(total) }
    const mode = info.get('redis_mode')
    if (mode !== undefined) extra['mode'] = mode
    return { version, flavor, extra }
  }

  /* ---------------------------------------------------------------- */
  /* Clients                                                           */
  /* ---------------------------------------------------------------- */

  private clientFor(db: number): Promise<RedisClient> {
    const existing = this.clients.get(db)
    if (existing) return existing
    const opening = (async (): Promise<RedisClient> => {
      const dup = this.base.duplicate({ database: db })
      dup.on('error', () => {})
      await dup.connect()
      return dup
    })()
    this.clients.set(db, opening)
    // A failed open must not be cached, or the database is permanently unusable
    opening.catch(() => this.clients.delete(db))
    return opening
  }

  private async binaryFor(db: number): Promise<BinaryClient> {
    const cached = this.binaries.get(db)
    if (cached) return cached
    const made = toBinary(await this.clientFor(db))
    this.binaries.set(db, made)
    return made
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const cursor of [...this.active.values()]) {
      cursor.markCancelled()
      await cursor.close().catch(() => {})
    }
    this.active.clear()
    this.binaries.clear()
    const opening = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(opening.map(async (p) => {
      const client = await p.catch(() => null)
      if (client) destroyQuietly(client)
    }))
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await this.base.ping()
    } catch (err) {
      throw mapRedisError(err, { fallback: 'CONNECTION_LOST', command: 'PING' })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }

  /* ---------------------------------------------------------------- */
  /* introspect — db → key prefix → key                                */
  /* ---------------------------------------------------------------- */

  /**
   * One level of the keyspace tree. See `keyspace.ts` for the node-id codec and
   * for why prefix nodes are a **sampled** approximation rather than a truth.
   */
  /**
   * `refresh` is accepted and ignored, and that is the correct answer here:
   * the keyspace tree is built from a live SCAN on every call (there is no
   * `invalidateIntrospectCache` on this session because there is no cache to
   * invalidate), so every listing is already as fresh as redis can make it.
   */
  async listChildren(parentId: string | null, _refresh?: boolean): Promise<NamespaceNode[]> {
    this.assertOpen()
    try {
      return await this.keyspace.listChildren(parentId)
    } catch (err) {
      throw mapRedisError(err, { command: 'SCAN' })
    }
  }

  /**
   * "Describe" a key pattern: there is no schema to report, so this returns
   * `KEYSPACE_SCAN_SCHEMA` with a DBSIZE-derived `rowCountEstimate`. Returning
   * the canonical schema rather than an empty one is what lets the generic table
   * view render a keyspace with no redis-specific branch in it.
   */
  async describeCollection(ref: CollectionRef): Promise<CollectionSchemaInfo> {
    this.assertOpen()
    const pattern = RedisKeyspace.requireKeyPattern(ref)
    const info: CollectionSchemaInfo = {
      ref,
      // Copied, not aliased: the caller receives a schema it may keep and the
      // shared constant must stay untouched
      columns: KEYSPACE_SCAN_SCHEMA.map((c) => ({ ...c })),
      primaryKey: [KEYSPACE_SCAN_COLUMNS.key],
      // Declared rather than left to the kind default, because this is the
      // answer the UI needs before it draws a column header, and `scan` refuses
      // against this same value
      browse: this.browseStyle(pattern),
    }
    // DBSIZE counts the whole database. It is an estimate only for the pattern
    // that means the whole database; for any narrower pattern it would be an
    // upper bound dressed up as an estimate, so it is left out.
    if (pattern.pattern === '*' && pattern.typeFilter === undefined) {
      try {
        const client = await this.clientFor(pattern.db ?? this.defaultDb)
        info.rowCountEstimate = await client.dbSize()
      } catch {
        // A refused DBSIZE costs the row-count hint, nothing else
      }
    }
    return info
  }

  /**
   * How a keyspace browses. Every key pattern in redis browses the same way, so
   * this is the kind default verbatim — the method exists so `describeCollection`
   * and `scan` quote one expression instead of two, and so a future refinement
   * (a RediSearch index over the keyspace, say) has an obvious home.
   */
  private browseStyle(ref: KeyPatternRef): CollectionBrowseStyle {
    return collectionBrowseStyle(ref)
  }

  /* ---------------------------------------------------------------- */
  /* collectionScan — SCAN over the keyspace                           */
  /* ---------------------------------------------------------------- */

  /**
   * Browse a `keyPattern` collection. `req.ref` must be a KeyPatternRef; anything
   * else is BAD_REQUEST via `error.collection.kindUnsupported`.
   *
   * Mapping onto the chunk protocol:
   * - `req.cursorToken` is the SCAN cursor to resume from; absent means '0';
   * - `req.filter` applies to the scan columns, not to values. `type` maps to
   *   SCAN's TYPE (so it is pushed to the server); everything else is filtered
   *   client-side over the page — and a filter that cannot be pushed down must
   *   still be honoured, never silently dropped;
   * - `done.nextCursor` is set **only** when the returned cursor is not '0'; a
   *   cursor back at '0' means the iteration completed, and handing it back would
   *   restart the scan from the beginning forever.
   */
  async scan(req: CollectionScanRequest): Promise<Cursor> {
    this.assertOpen()
    const ref = RedisKeyspace.requireKeyPattern(req.ref)
    const db = ref.db ?? this.defaultDb

    if (req.nativeFilter !== undefined) {
      // Redis has no filter language for a keyspace walk. Ignoring the clause
      // would hand back more keys than were asked for, with nothing to say so.
      throw peekError(
        'BAD_REQUEST',
        'The Redis driver has no native filter language; use `filter` over the'
        + ' keyspace scan columns (key, type, ttlMs, size, bytes, encoding) instead',
      )
    }
    // SCAN's order is an implementation detail of the hash table and changes as it
    // rehashes, so sorting one page would be a lie about the whole scan. That is
    // declared once, in core's browse style, and refused from the same table the
    // UI consults before it draws a sortable column header — the driver no longer
    // owns a private opinion the renderer cannot see.
    assertBrowseSupported(this.browseStyle(ref), req, { driverId: 'redis' })
    // `<boundary>` or `<boundary>:<rows already delivered from it>`; the second
    // form is how a page that ended inside a SCAN page addresses its resume point
    if (req.cursorToken !== undefined && !isRedisResumeToken(req.cursorToken)) {
      throw peekErrorMsg('BAD_REQUEST', 'error.sql.invalidCursorToken', { token: req.cursorToken })
    }
    if (this.active.has(req.resultId)) {
      throw peekErrorMsg('CONFLICT', 'error.query.alreadyRunning', { resultId: req.resultId })
    }

    const columns = projectScanColumns(req.columns)
    const filters = req.filter ?? []
    const { typeFilter, clientSide } = splitFilters(filters, ref.typeFilter)
    const needs = scanNeedsOf(columns, clientSide)
    const limit = clampInt(req.limit ?? DEFAULT_PAGE_LIMIT, 0, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT

    const cursor = new RedisScanCursor({
      resultId: req.resultId,
      ref,
      columns,
      maxRows: limit,
      ...(req.cursorToken === undefined ? {} : { cursorToken: req.cursorToken }),
      ...(clientSide.length === 0 ? {} : { filter: clientSide }),
      // SCAN has no OFFSET, so `offset` is a client-side skip. It only applies to
      // a fresh scan: a continuation token already carries its own intra-page skip
      // (see RedisScanCursor), and adding an offset on top would drop rows twice.
      ...(req.cursorToken === undefined && req.offset ? { skip: req.offset } : {}),
      ...(clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) === undefined
        ? {}
        : { chunkRows: clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) }),
      ...(clampInt(req.timeoutMs, 1, 3_600_000) === undefined
        ? {}
        : { timeoutMs: clampInt(req.timeoutMs, 1, 3_600_000) }),
      ...(req.signal ? { signal: req.signal } : {}),
      fetchPage: (token, count): Promise<RedisScanPage> =>
        this.fetchScanPage(db, ref.pattern, typeFilter, needs, token, count),
      onClosed: (): void => {
        this.active.delete(req.resultId)
      },
    })
    this.active.set(req.resultId, cursor)
    return cursor
  }

  /** One SCAN round trip plus the pipelined per-key metadata */
  private async fetchScanPage(
    db: number,
    pattern: string,
    typeFilter: string | undefined,
    needs: ScanNeeds,
    token: string,
    count: number,
  ): Promise<RedisScanPage> {
    const client = await this.clientFor(db)
    let page: { cursor: string; keys: string[] }
    try {
      page = await client.scan(token, {
        MATCH: pattern,
        COUNT: count,
        ...(typeFilter === undefined ? {} : { TYPE: typeFilter }),
      })
    } catch (err) {
      throw mapRedisError(err, { command: `SCAN ${token} MATCH ${pattern} COUNT ${count}` })
    }
    const rows = await this.describeKeys(db, page.keys, needs, typeFilter)
    return { cursor: page.cursor, rows }
  }

  /**
   * TYPE / PTTL / MEMORY USAGE / OBJECT ENCODING for a page of keys, then the
   * per-type size command — two pipelines, not 5N round trips.
   *
   * A command the server refuses for every key of a batch is latched off for the
   * rest of the session (`deniedMeta`): its column stays null, which is the
   * documented degradation, and the next page does not re-issue N commands that
   * are already known to fail.
   */
  private async describeKeys(
    db: number,
    keys: readonly string[],
    needs: ScanNeeds,
    knownType: string | undefined,
  ): Promise<RedisKeyRow[]> {
    if (keys.length === 0) return []
    const client = await this.clientFor(db)
    /** Run one metadata batch, or skip it when the projection or the server rules it out */
    const meta = async <T>(
      command: ScanMetaCommand,
      wanted: boolean,
      make: () => readonly Promise<T>[],
    ): Promise<(T | null)[]> => {
      if (!wanted || this.deniedMeta.has(command)) return []
      const res = await pipeline(make())
      if (res.allRefused) this.deniedMeta.add(command)
      return res.values
    }
    try {
      const types = knownType !== undefined
        ? keys.map(() => knownType)
        : needs.type
          ? (await meta('type', true, () => keys.map((k) => client.type(k)))).map((t) => t ?? 'none')
          : keys.map(() => '')
      const [ttls, bytes, encodings] = await Promise.all([
        meta('ttl', needs.ttl, () => keys.map((k) => client.pTTL(k))),
        meta('bytes', needs.bytes, () =>
          keys.map((k) => client.memoryUsage(k, { SAMPLES: MEMORY_USAGE_SAMPLES }))),
        meta('encoding', needs.encoding, () => keys.map((k) => client.objectEncoding(k))),
      ])
      const sizes = await meta('size', needs.size, () =>
        keys.map((k, i) => this.sizeOf(client, k, types[i] ?? 'none')))

      return keys.map((key, i) => ({
        key,
        type: types[i] ?? '',
        ttlMs: numberOrNull(ttls[i]),
        size: numberOrNull(sizes[i]),
        bytes: numberOrNull(bytes[i]),
        encoding: typeof encodings[i] === 'string' ? (encodings[i] as string) : null,
      }))
    } catch (err) {
      throw mapRedisError(err, { command: `TYPE/PTTL/MEMORY USAGE (${keys.length} keys)` })
    }
  }

  /** The element count of a key, by type. A string reports its byte length, which is the only size it has. */
  private sizeOf(client: RedisClient, key: string, type: string): Promise<number> {
    switch (type) {
      case 'string':
        return client.strLen(key)
      case 'hash':
        return client.hLen(key)
      case 'list':
        return client.lLen(key)
      case 'set':
        return client.sCard(key)
      case 'zset':
        return client.zCard(key)
      case 'stream':
        return client.xLen(key)
      default:
        return Promise.resolve(0)
    }
  }

  /* ---------------------------------------------------------------- */
  /* keyspace tree deps                                                */
  /* ---------------------------------------------------------------- */

  private async scanPage(
    db: number,
    cursor: string,
    match: string,
    count: number,
  ): Promise<{ cursor: string; keys: string[] }> {
    const client = await this.clientFor(db)
    try {
      return await client.scan(cursor, { MATCH: match, COUNT: count })
    } catch (err) {
      throw mapRedisError(err, { command: `SCAN ${cursor} MATCH ${match} COUNT ${count}` })
    }
  }

  private async keyCounts(): Promise<ReadonlyMap<number, number>> {
    try {
      return parseKeyspaceInfo(await this.base.info('keyspace'))
    } catch (err) {
      throw mapRedisError(err, { command: 'INFO keyspace' })
    }
  }

  private async databaseCount(): Promise<number> {
    try {
      const cfg = await this.base.configGet('databases')
      const raw = cfg['databases']
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_DATABASE_COUNT
    } catch {
      // CONFIG GET is commonly disabled on managed instances; the standard 16 is
      // a better answer than failing the whole tree root
      return DEFAULT_DATABASE_COUNT
    }
  }

  private async keyTypes(
    db: number,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const client = await this.clientFor(db)
    const types = (await pipeline(keys.map((k) => client.type(k)))).values
    const out = new Map<string, string>()
    keys.forEach((key, i) => {
      const type = types[i]
      if (typeof type === 'string' && type !== 'none') out.set(key, type)
    })
    return out
  }

  /* ---------------------------------------------------------------- */
  /* keyValue                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Read one key as a `KeyValuePayload`, dispatched on TYPE:
   *   string → GET (sliced with GETRANGE when it is large)
   *   hash   → HSCAN (cursor window)      list → LRANGE (index window)
   *   set    → SSCAN (cursor window)      zset → ZRANGE … WITHSCORES (index window)
   *   stream → XRANGE (id window)
   * A missing key is `{ shape: 'missing' }` with type 'none' — **not** an error:
   * a key expiring between a scan and a click is ordinary, and NOT_FOUND would
   * surface it as a failure.
   */
  async getValue(ref: ValueRef, opts?: KeyValueReadOptions): Promise<KeyValueResult> {
    this.assertOpen()
    requireRedisValueRef(ref)
    try {
      return await readKeyValue(this.valueDeps, ref, opts ?? {})
    } catch (err) {
      throw mapRedisError(err, { command: 'GET/HSCAN/LRANGE/SSCAN/ZRANGE/XRANGE' })
    }
  }

  private async describeKey(db: number, key: string): Promise<{
    type: RedisType
    ttlMs: number | null
    encoding: string | null
    bytes: number | null
    size: number | null
  }> {
    const client = await this.clientFor(db)
    const [rawType, ttl, encoding, bytes] = await Promise.all([
      client.type(key),
      client.pTTL(key).catch(() => null),
      client.objectEncoding(key).catch(() => null),
      client.memoryUsage(key, { SAMPLES: MEMORY_USAGE_SAMPLES }).catch(() => null),
    ])
    if (!isRedisType(rawType)) {
      // A module type (ReJSON-RL, TSDB-TYPE …). Saying so beats rendering it as
      // an empty string in an inspector that cannot read it.
      throw peekErrorMsg('BAD_REQUEST', 'error.key.typeUnsupported', { type: rawType })
    }
    const size = rawType === 'none' ? null : await this.sizeOf(client, key, rawType).catch(() => null)
    return {
      type: rawType,
      ttlMs: numberOrNull(ttl),
      encoding: typeof encoding === 'string' ? encoding : null,
      bytes: numberOrNull(bytes),
      size: numberOrNull(size),
    }
  }

  private async readWindow(
    db: number,
    key: string,
    type: RedisType,
    opts: KeyValueReadOptions,
  ): Promise<{ payload: KeyValuePayload; nextCursor?: string; truncated?: boolean }> {
    const client = await this.clientFor(db)
    const limit = clampElements(opts.limit)
    const offset = clampOffset(opts.offset)
    const match = opts.match

    switch (type) {
      case 'none':
        return { payload: { shape: 'missing' } }

      case 'string': {
        // STRLEN first, so the preview can be cut **on the server**: a 200MB
        // string must not cross the socket just to be thrown away here. The
        // TruncatedValue is built by hand rather than through keyValueElement
        // because only STRLEN knows the true byteLength — the preview alone
        // cannot say how much was left behind.
        const total = await client.strLen(key)
        if (total <= VALUE_PREVIEW_BYTES) {
          // GETRANGE on a key that vanished between the TYPE and here answers
          // with an empty range, not an error
          const whole = (await client.getRange(key, 0, -1)) ?? ''
          return { payload: { shape: 'scalar', value: whole } }
        }
        const head = (await client.getRange(key, 0, VALUE_PREVIEW_BYTES - 1)) ?? ''
        const value = truncatedValue(head, 'utf8', {
          byteLength: total,
          ref: { kind: 'redisValue', key, db },
        })
        return { payload: { shape: 'scalar', value }, truncated: true }
      }

      case 'hash': {
        const res = await client.hScan(key, opts.cursorToken ?? '0', {
          COUNT: limit,
          ...(match === undefined ? {} : { MATCH: match }),
        })
        const fields: KeyValueField[] = res.entries.map((e) => ({
          field: e.field,
          value: keyValueElement(e.value, () => redisElementRef(key, db, e.field)),
        }))
        return {
          payload: { shape: 'map', fields },
          ...(res.cursor === '0' ? {} : { nextCursor: res.cursor, truncated: true }),
        }
      }

      case 'set': {
        const res = await client.sScan(key, opts.cursorToken ?? '0', {
          COUNT: limit,
          ...(match === undefined ? {} : { MATCH: match }),
        })
        const members = res.members.map((m) => keyValueElement(m, () => redisElementRef(key, db, m)))
        return {
          payload: { shape: 'set', members },
          ...(res.cursor === '0' ? {} : { nextCursor: res.cursor, truncated: true }),
        }
      }

      case 'list': {
        // Issued in the same tick so node-redis pipelines them: the window and
        // its "is there more" probe cost one round trip, not two
        const [items, total] = await Promise.all([
          client.lRange(key, offset, offset + limit - 1),
          client.lLen(key),
        ])
        return {
          payload: {
            shape: 'list',
            start: offset,
            items: items.map((v, i) =>
              keyValueElement(v, () => redisElementRef(key, db, String(offset + i)))),
          },
          ...(offset + items.length < total
            ? { nextCursor: String(offset + items.length), truncated: true }
            : {}),
        }
      }

      case 'zset': {
        const [entries, total] = await Promise.all([
          client.zRangeWithScores(key, offset, offset + limit - 1),
          client.zCard(key),
        ])
        return {
          payload: {
            shape: 'sortedSet',
            entries: entries.map((e) => ({
              member: keyValueElement(e.value, () => redisElementRef(key, db, e.value)),
              score: e.score,
            })),
          },
          ...(offset + entries.length < total
            ? { nextCursor: String(offset + entries.length), truncated: true }
            : {}),
        }
      }

      case 'stream': {
        // XRANGE addresses by entry id, so `cursorToken` is an id. `offset` has no
        // server-side equivalent, and is honoured by over-reading and slicing —
        // bounded, because the read is capped at MAX_KEY_VALUE_ELEMENTS anyway.
        const start = opts.cursorToken ?? '-'
        const over = Math.min(MAX_KEY_VALUE_ELEMENTS, offset + limit)
        const raw = await client.xRange(key, start, '+', { COUNT: over })
        const window = raw.slice(offset, offset + limit)
        const entries: KeyValueStreamEntry[] = window.map((e) => ({
          id: e.id,
          fields: Object.entries(e.message).map(([field, value]) => ({
            field,
            value: keyValueElement(String(value), () => redisElementRef(key, db, `${e.id}/${field}`)),
          })),
        }))
        const last = window.at(-1)
        return {
          payload: { shape: 'stream', entries },
          ...(raw.length >= over && last !== undefined
            // '(' makes the next XRANGE exclusive of the last id we already sent
            ? { nextCursor: `(${last.id}`, truncated: true }
            : {}),
        }
      }
    }
  }

  /** One addressed element, keeping the key's own shape (see RedisValueDeps.readElement) */
  private async readElement(
    db: number,
    key: string,
    type: RedisType,
    path: string,
  ): Promise<KeyValuePayload | null> {
    const client = await this.clientFor(db)
    switch (type) {
      case 'none':
        return { shape: 'missing' }
      case 'string':
        // A string has no elements; the whole key is the value
        return null
      case 'hash': {
        const value = await client.hGet(key, path)
        if (value === null || value === undefined) return null
        return {
          shape: 'map',
          fields: [{ field: path, value: keyValueElement(value, () => redisElementRef(key, db, path)) }],
        }
      }
      case 'list': {
        if (!/^-?\d+$/.test(path)) return null
        const index = Number(path)
        const value = await client.lIndex(key, index)
        if (value === null || value === undefined) return null
        return {
          shape: 'list',
          start: index >= 0 ? index : Math.max(0, (await client.lLen(key)) + index),
          items: [keyValueElement(value, () => redisElementRef(key, db, path))],
        }
      }
      case 'set': {
        const present = await client.sIsMember(key, path)
        if (!present) return null
        return { shape: 'set', members: [keyValueElement(path)] }
      }
      case 'zset': {
        const score = await client.zScore(key, path)
        if (score === null || score === undefined) return null
        return { shape: 'sortedSet', entries: [{ member: keyValueElement(path), score }] }
      }
      case 'stream': {
        const [id, field] = splitStreamPath(path)
        const found = await client.xRange(key, id, id, { COUNT: 1 })
        const entry = found[0]
        if (!entry) return null
        const fields: KeyValueField[] = Object.entries(entry.message)
          .filter(([name]) => field === undefined || name === field)
          .map(([name, value]) => ({
            field: name,
            value: keyValueElement(String(value), () => redisElementRef(key, db, `${entry.id}/${name}`)),
          }))
        if (fields.length === 0) return null
        return { shape: 'stream', entries: [{ id: entry.id, fields }] }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* valuePeek                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Fetch a large value in full, or a byte window of it.
   *
   * The window is sliced **on the server** wherever redis offers it — GETRANGE
   * for a string is the whole point of this method; pulling a 200MB value into
   * the driver process to slice it locally defeats it. Element types that offer
   * no byte-level slicing (a single hash field) read the element and slice
   * locally, which is acceptable because one element is bounded.
   */
  async peekValue(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    this.assertOpen()
    requireRedisValueRef(ref)
    try {
      return await peekRedisValue(this.peekDeps, ref, range)
    } catch (err) {
      throw mapRedisError(err, { command: 'GETRANGE/HGET/LINDEX/XRANGE' })
    }
  }

  private async readStringRange(
    db: number,
    key: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; total: number } | null> {
    const client = await this.clientFor(db)
    const binary = await this.binaryFor(db)
    const total = await client.strLen(key)
    if (total === 0) {
      // Either an empty string or a key that vanished; TYPE already ruled the
      // second out, so this is genuinely empty
      return { bytes: Buffer.alloc(0), total: 0 }
    }
    if (offset >= total || length === 0) return { bytes: Buffer.alloc(0), total }
    // GETRANGE's end index is inclusive
    const bytes = await binary.getRange(key, offset, offset + length - 1)
    return { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'), total }
  }

  private async readElementBytes(
    db: number,
    key: string,
    type: RedisType,
    path: string,
  ): Promise<Buffer | null> {
    const client = await this.clientFor(db)
    const binary = await this.binaryFor(db)
    switch (type) {
      case 'none':
      case 'string':
        return null
      case 'hash': {
        const value = await binary.hGet(key, path)
        return toBuffer(value)
      }
      case 'list': {
        if (!/^-?\d+$/.test(path)) return null
        const value = await binary.lIndex(key, Number(path))
        return toBuffer(value)
      }
      case 'set':
        // In a set the member *is* the value; there is nothing else to fetch
        return (await client.sIsMember(key, path)) ? Buffer.from(path, 'utf8') : null
      case 'zset': {
        const score = await client.zScore(key, path)
        return score === null || score === undefined ? null : Buffer.from(path, 'utf8')
      }
      case 'stream': {
        // Read through the text client: a stream entry is a field map, and the
        // binary type mapping would turn its field *names* into Buffers too.
        const [id, field] = splitStreamPath(path)
        const found = await client.xRange(key, id, id, { COUNT: 1 })
        const entry = found[0]
        if (!entry) return null
        if (field === undefined) return Buffer.from(JSON.stringify(entry.message), 'utf8')
        const value = entry.message[field]
        return value === undefined ? null : Buffer.from(String(value), 'utf8')
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* cancel                                                            */
  /* ---------------------------------------------------------------- */

  /** Stop an in-flight scan at its next iteration. False (never a throw) when nothing is running. */
  async cancel(resultId: ResultId): Promise<boolean> {
    const cursor = this.active.get(resultId)
    if (!cursor || cursor.isClosed) return false
    // There is no server-side cancel worth having here: a single SCAN round trip
    // is bounded by COUNT, so refusing to issue the next one *is* the cancel.
    cursor.markCancelled()
    await cursor.close().catch(() => {})
    return true
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}

/** `'1712345678901-0/payload'` → `['1712345678901-0', 'payload']` */
function splitStreamPath(path: string): [string, string | undefined] {
  const at = path.indexOf('/')
  return at < 0 ? [path, undefined] : [path.slice(0, at), path.slice(at + 1)]
}

/**
 * Narrow the keyspace scan schema to the caller's projection.
 *
 * Unknown names are rejected rather than dropped: a caller who asked for a column
 * that does not exist got their assumption wrong, and silently returning five
 * columns where six were requested hides that from them.
 */
export function projectScanColumns(columns: readonly string[] | undefined): readonly ColumnDef[] {
  if (columns === undefined || columns.length === 0) return KEYSPACE_SCAN_SCHEMA
  return columns.map((name) => {
    const found = KEYSPACE_SCAN_SCHEMA.find((c) => c.name === name)
    if (!found) throw peekErrorMsg('BAD_REQUEST', 'error.value.columnNotFound', { column: name })
    return found
  })
}

/**
 * Split the filter list into the one predicate SCAN can enforce itself and the
 * rest.
 *
 * Only `type eq <name>` is pushed down: SCAN's TYPE takes exactly one type, and
 * MATCH is a glob, so a `key like 'user_%'` pushed into it would quietly match
 * different keys than SQL's LIKE means. Everything not pushed down is still
 * applied — client-side, over the page — never dropped.
 */
export function splitFilters(
  filters: readonly FilterSpec[],
  refTypeFilter: string | undefined,
): { typeFilter: string | undefined; clientSide: FilterSpec[] } {
  let typeFilter = refTypeFilter
  const clientSide: FilterSpec[] = []
  for (const spec of filters) {
    const pushable =
      spec.column === KEYSPACE_SCAN_COLUMNS.type
      && spec.op === 'eq'
      && typeof spec.value === 'string'
      && typeFilter === undefined
    if (pushable && typeof spec.value === 'string') {
      typeFilter = spec.value
      continue
    }
    clientSide.push(spec)
  }
  return { typeFilter, clientSide }
}
