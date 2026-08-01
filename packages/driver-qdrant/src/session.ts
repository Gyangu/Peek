import {
  DEFAULT_PAGE_LIMIT,
  DRIVER_CAPABILITIES,
  MAX_PAGE_LIMIT,
  QDRANT_VECTOR_FIELD,
  VALUE_PEEK_MAX_BYTES,
  VECTOR_RESULT_COLUMNS,
  assertBrowseSupported,
  assertFilterSupported,
  collectionBrowseStyle,
  parseQdrantField,
  peekError,
  peekErrorMsg,
  type ByteRange,
  type Capability,
  type CollectionBrowseStyle,
  type CollectionRef,
  type CollectionScanRequest,
  type CollectionSchemaInfo,
  type Cursor,
  type DriverId,
  type DriverSession,
  type NamespaceNode,
  type PeekedValue,
  type QdrantConnectionConfig,
  type ResultId,
  type VectorCollectionRef,
  type ServerInfo,
  type ValueRef,
  type VectorSearchRequest,
} from '@peek/core'
import { QdrantClient, type Schemas } from '@qdrant/js-client-rest'
import { QdrantCollections, formatVectors, type QdrantCollectionInfo } from './collections'
import { mapQdrantError } from './errors'
import {
  buildRowShape,
  resolvePayloadColumns,
  type QdrantPoint,
  type QdrantRowShape,
} from './points'
import {
  QdrantPointCursor,
  buildOrderBy,
  buildQdrantFilter,
  decodeScrollOffset,
  type QdrantPointPage,
} from './scroll'

/**
 * One live Qdrant connection.
 *
 * ## The three rules this class exists to enforce
 *
 * 1. **Scroll, never "get everything"** (PLAN section 4). A collection listing
 *    goes through `/points/scroll` with a limit and a `next_page_offset`, and
 *    that offset is what `ChunkDone.nextCursor` carries.
 * 2. **The vector body never rides along.** `with_vector` is false unless the
 *    caller explicitly asked; the vector is fetched per point through valuePeek
 *    on a `qdrantPoint` ref. A 1536-dimension vector is ~20KB of JSON per row.
 * 3. **The payload column set is fixed before the first row.** See `points.ts`:
 *    the chunk protocol pins `schema` to frame 0, so a schemaless payload is one
 *    json column unless the caller named the keys to flatten.
 *
 * ## Why there is no `cancel`
 *
 * Qdrant has no server-side statement cancellation. What the driver can do is
 * abort the in-flight HTTP request, which is what closing a cursor does through
 * its AbortController — so the capability set deliberately omits `cancel` rather
 * than advertising a weaker meaning of it. The host still stops the result pump,
 * which is what a user pressing "stop" actually observes.
 */

/** Connect probe budget when the config does not give one */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/**
 * Ceiling on any single HTTP request, armed on the client itself.
 *
 * `@qdrant/js-client-rest` takes this in **milliseconds** at construction time
 * (its per-call `timeout` argument, confusingly, is the server-side one in
 * seconds). It has to be generous, because it also covers a scroll page on a
 * cold collection; the caller's own `timeoutMs` is enforced by the cursor.
 */
const CLIENT_TIMEOUT_MS = 300_000

/**
 * The default payload projection: **none**.
 *
 * `resolvePayloadColumns` will happily fall back to the collection's indexed
 * payload keys, and this is the call site that declines to. Two reasons, both
 * about the frame-0 schema being a promise:
 *
 * 1. index state is server-side and mutable, so the same scan would produce
 *    different columns before and after somebody adds an index;
 * 2. flattening drops every key that is not in the list, which for a schemaless
 *    payload silently hides data the user can see in qdrant's own dashboard.
 *
 * Flattening stays opt-in through `columns`, and `describeCollection` reports the
 * indexed keys under `indexes` so a caller can discover what is worth naming.
 */
const NO_IMPLICIT_FLATTENING: readonly string[] = []

/**
 * How far a numeric `offset` may be emulated by scrolling past points.
 *
 * Qdrant's scroll has no numeric offset — its `offset` is a start id — so an
 * offset of N costs N ids on the wire. That is fine for a page or two and absurd
 * for a million, and paging is supposed to go through `cursorToken` anyway.
 */
const MAX_EMULATED_OFFSET = MAX_PAGE_LIMIT

/**
 * Build the REST client **without** its bundled undici dispatcher.
 *
 * `@qdrant/js-client-rest@1.18` attaches an `Agent` from its own `undici@6` to
 * every request as `init.dispatcher`, but only when it believes it is on node:
 *
 *     dispatcher: process.versions?.node ? createDispatcher(connections) : undefined
 *
 * Node 24+ (and Electron 43, which is Node 24.18) embeds undici 7, whose fetch
 * hands the dispatcher a v7-shaped handler. The v6 `Agent.dispatch` validates
 * that handler and rejects it — every single request fails with
 * `TypeError: fetch failed` / `UND_ERR_INVALID_ARG: invalid onError method`,
 * before a byte reaches qdrant. The dispatcher is a connection-pooling
 * optimization; node's own global dispatcher pools perfectly well without it.
 *
 * Hiding `process.versions.node` for the duration of the constructor is the only
 * lever the client exposes — there is no option to opt out. The window is a
 * single synchronous call with no `await` inside it, so nothing else can observe
 * the patched value, and it is restored in a `finally`.
 *
 * Delete this the day the client ships an undici-7-compatible Agent (or any way
 * to pass a dispatcher of one's own); the failure mode if the client changes
 * that check is loud, not silent.
 */
function createRestClient(params: ConstructorParameters<typeof QdrantClient>[0]): QdrantClient {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
  if (descriptor === undefined || descriptor.configurable !== true) {
    return new QdrantClient(params)
  }
  Object.defineProperty(process.versions, 'node', { value: undefined, configurable: true })
  try {
    return new QdrantClient(params)
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor)
  }
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A qdrant point id is a uint or a uuid; anything else in a response is not addressable */
function asPointId(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

/**
 * Race a client call against a wall-clock budget and the caller's abort signal.
 *
 * The REST client exposes no per-request AbortSignal, so a timed-out request is
 * abandoned rather than cancelled. That is acceptable for the connect probe —
 * the alternative is a connection attempt that hangs for the client's own
 * five-minute ceiling.
 */
function withDeadline<T>(
  work: Promise<T>,
  budgetMs: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      finish(() => reject(peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')))
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          peekErrorMsg('TIMEOUT', 'error.query.timedOut', { operation, ms: budgetMs }, {
            retryable: true,
          }),
        ),
      )
    }, Math.max(1, Math.trunc(budgetMs)))
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    )
  })
}

/** Normalize whatever the REST client returns into the narrow point shape peek reads */
function toPoint(raw: Schemas['Record'] | Schemas['ScoredPoint']): QdrantPoint {
  const id = asPointId(raw.id)
  const point: QdrantPoint = { id: id ?? String(raw.id) }
  if (isPlainObject(raw.payload)) point.payload = raw.payload
  const vector: unknown = raw.vector
  if (Array.isArray(vector) || isPlainObject(vector)) {
    point.vector = vector as QdrantPoint['vector']
  }
  const score: unknown = (raw as Schemas['ScoredPoint']).score
  if (typeof score === 'number') point.score = score
  return point
}

/** Read the vector configuration, flattening the unnamed single-vector case to name '' */
function readVectors(info: Schemas['CollectionInfo']): QdrantCollectionInfo['vectors'] {
  const raw: unknown = info.config?.params?.vectors
  const out: QdrantCollectionInfo['vectors'] = []
  if (!isPlainObject(raw)) return out
  if (typeof raw['size'] === 'number') {
    out.push({ name: '', size: raw['size'], distance: String(raw['distance'] ?? 'Unknown') })
    return out
  }
  for (const [name, params] of Object.entries(raw)) {
    if (!isPlainObject(params) || typeof params['size'] !== 'number') continue
    out.push({ name, size: params['size'], distance: String(params['distance'] ?? 'Unknown') })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function readPayloadIndexes(info: Schemas['CollectionInfo']): QdrantCollectionInfo['payloadIndexes'] {
  const raw: unknown = info.payload_schema
  if (!isPlainObject(raw)) return []
  return Object.entries(raw)
    .map(([field, schema]) => ({
      field,
      type: isPlainObject(schema) ? String(schema['data_type'] ?? 'unknown') : 'unknown',
    }))
    .sort((a, b) => a.field.localeCompare(b.field))
}

export class QdrantSession implements DriverSession {
  readonly driverId: DriverId = 'qdrant'
  readonly capabilities: ReadonlySet<Capability> = new Set(DRIVER_CAPABILITIES.qdrant)
  readonly serverInfo: ServerInfo

  private readonly client: QdrantClient
  private readonly collections: QdrantCollections
  /** Cursors currently streaming; close() has to stop them */
  private readonly active = new Map<ResultId, QdrantPointCursor>()

  private closed = false

  private constructor(client: QdrantClient, serverInfo: ServerInfo) {
    this.client = client
    this.serverInfo = serverInfo
    this.collections = new QdrantCollections({
      listCollections: () => this.fetchCollectionNames(),
      describe: (name) => this.fetchCollectionInfo(name),
    })
  }

  /**
   * Open the connection and probe the server.
   *
   * `GET /` returns `{ title, version }`; use it both as the connectivity check
   * and as `ServerInfo` (`version` = the reported version, `flavor` = 'Qdrant').
   * An api key that is wrong surfaces here as 401/403 → CONNECTION_FAILED, which
   * is what the connection state machine needs to show `error` rather than a
   * `ready` connection that fails on first use.
   */
  static async connect(
    cfg: QdrantConnectionConfig,
    signal?: AbortSignal,
  ): Promise<QdrantSession> {
    if (signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
    const budget = clampInt(cfg.connectTimeoutMs, 100, CLIENT_TIMEOUT_MS) ?? DEFAULT_CONNECT_TIMEOUT_MS

    let client: QdrantClient
    try {
      client = createRestClient({
        url: cfg.url,
        ...(cfg.apiKey === undefined ? {} : { apiKey: cfg.apiKey }),
        // Left on, every `new QdrantClient` fires a version-probe request of its
        // own; peek already reads the version below.
        checkCompatibility: false,
        timeout: CLIENT_TIMEOUT_MS,
      })
    } catch (err) {
      throw mapQdrantError(err, { fallback: 'CONNECTION_FAILED' })
    }

    try {
      const version = await withDeadline(client.versionInfo(), budget, signal, 'Connect')
      // `GET /` is unauthenticated, so a wrong api key would otherwise only
      // surface on the first real click. One authenticated call settles it here.
      await withDeadline(client.getCollections(), budget, signal, 'Connect')
      const extra: Record<string, string> = {}
      if (version.title) extra['title'] = version.title
      if (version.commit) extra['commit'] = version.commit
      const serverInfo: ServerInfo = {
        version: version.version,
        flavor: 'Qdrant',
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      }
      return new QdrantSession(client, serverInfo)
    } catch (err) {
      throw mapQdrantError(err, { request: 'GET /', fallback: 'CONNECTION_FAILED' })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cursors = [...this.active.values()]
    this.active.clear()
    await Promise.all(cursors.map((c) => c.close().catch(() => {})))
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await this.client.versionInfo()
    } catch (err) {
      throw mapQdrantError(err, { request: 'GET /', fallback: 'CONNECTION_LOST' })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }

  /* ---------------------------------------------------------------- */
  /* introspect — collection → named vector / payload index            */
  /* ---------------------------------------------------------------- */

  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    this.assertOpen()
    return this.collections.listChildren(parentId)
  }

  /**
   * Describe a collection: the columns a scroll will produce (see `points.ts`
   * for the flattening rule), `rowCountEstimate` from the collection's
   * `points_count`, and the vector configuration in `comment` so the UI can show
   * "768d · Cosine" without a second call.
   */
  async describeCollection(ref: CollectionRef): Promise<CollectionSchemaInfo> {
    this.assertOpen()
    const target = QdrantCollections.requireCollection(ref)
    const info = await this.collections.describeInfo(target.collection)
    const shape = buildRowShape({
      collection: target.collection,
      payloadColumns: resolvePayloadColumns(undefined, NO_IMPLICIT_FLATTENING),
      withScore: false,
      withVector: false,
    })
    const comment = formatVectors(info)
    return {
      ref: target,
      columns: shape.columns,
      primaryKey: [VECTOR_RESULT_COLUMNS.id],
      // The default projection is `id` + one json `payload`, so nothing in this
      // result is filterable; `columns` on the scan is what changes that
      browse: browseStyleOf(target, info, shape.payloadColumns),
      ...(info.pointsCount === null ? {} : { rowCountEstimate: info.pointsCount }),
      // Payload indexes are qdrant's only index-like objects. They are reported
      // here rather than folded into the columns so a caller can see which keys
      // are worth passing as `columns` without changing the scan's schema.
      ...(info.payloadIndexes.length > 0
        ? {
            indexes: info.payloadIndexes.map((p) => ({
              name: `${p.field} (${p.type})`,
              columns: [p.field],
              unique: false,
            })),
          }
        : {}),
      ...(comment.length > 0 ? { comment } : {}),
    }
  }

  /** Manual refresh: drop the cached collection descriptions (PLAN section 8) */
  invalidateIntrospectCache(): void {
    this.collections.invalidate()
  }

  private async fetchCollectionNames(): Promise<string[]> {
    try {
      const res = await this.client.getCollections()
      return res.collections.map((c) => c.name)
    } catch (err) {
      throw mapQdrantError(err, { request: 'GET /collections' })
    }
  }

  private async fetchCollectionInfo(name: string): Promise<QdrantCollectionInfo> {
    let info: Schemas['CollectionInfo']
    try {
      info = await this.client.getCollection(name)
    } catch (err) {
      const mapped = mapQdrantError(err, { request: `GET /collections/${name}` })
      // A 404 here means the collection is gone, which is a peek-level condition
      // with a catalog key; the server's own "Not found" wording is not useful.
      if (mapped.code === 'NOT_FOUND') {
        throw peekErrorMsg('NOT_FOUND', 'error.collection.notFound', { name })
      }
      throw mapped
    }
    return {
      name,
      pointsCount: typeof info.points_count === 'number' ? info.points_count : null,
      vectors: readVectors(info),
      payloadIndexes: readPayloadIndexes(info),
    }
  }

  /* ---------------------------------------------------------------- */
  /* collectionScan — scroll                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Browse a `vectorCollection`. `req.cursorToken` is the encoded
   * `next_page_offset` of the previous page (see `encodeScrollOffset` — a naive
   * `String(id)` loses the number/uuid distinction and silently restarts the
   * scroll).
   *
   * `req.filter` becomes a qdrant filter with all conditions in `must`;
   * `req.nativeFilter`, when present, is ANDed in verbatim and **must be rejected
   * with BAD_REQUEST if it is not a filter object** — silently ignoring it would
   * return more points than the caller asked for, with no way to notice.
   */
  async scan(req: CollectionScanRequest): Promise<Cursor> {
    this.assertOpen()
    const target = QdrantCollections.requireCollection(req.ref)
    const collection = target.collection

    const filter = buildQdrantFilter({
      ...(req.filter === undefined ? {} : { filter: req.filter }),
      ...(req.nativeFilter === undefined ? {} : { nativeFilter: req.nativeFilter }),
    })
    const orderBy = buildOrderBy(req.sort)

    const payloadColumns = resolvePayloadColumns(req.columns, NO_IMPLICIT_FLATTENING)
    const shape = buildRowShape({
      collection,
      payloadColumns,
      withScore: false,
      // PLAN section 4, non-negotiable: a listing never carries vector bodies
      withVector: false,
    })
    // A filter that names a *result column* has to name one that exists and that
    // qdrant can express a predicate on. A filter that names a stored payload
    // field goes straight through, which is what every MCP caller writes and what
    // `FilterSpec.column` has always meant here.
    assertFilterSupported(
      { ...collectionBrowseStyle(target), filterableColumns: filterableColumnsOf(payloadColumns) },
      req.filter,
      shape.columns.map((c) => c.name),
      { driverId: 'qdrant' },
    )

    const limit = clampInt(req.limit ?? DEFAULT_PAGE_LIMIT, 0, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT
    const resume = req.cursorToken === undefined ? undefined : decodeScrollOffset(req.cursorToken)
    // Contract: a cursorToken wins over offset
    const skip = resume === undefined ? (clampInt(req.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0) : 0
    if (skip > MAX_EMULATED_OFFSET) {
      throw peekError(
        'BAD_REQUEST',
        `A qdrant scroll cannot skip ${skip} points; page with cursorToken instead`
          + ` (the ceiling is ${MAX_EMULATED_OFFSET})`,
      )
    }
    if (orderBy !== undefined) {
      // Qdrant refuses `order_by` together with a start offset, and refuses it
      // outright on a payload key with no index. Both facts are declared on the
      // browse style this collection reports through `describeCollection`, so the
      // refusal here and the column header the UI draws come from one value.
      // `describeInfo` is cached per session, so this costs nothing once the tree
      // (or any earlier describe) has touched the collection.
      const info = await this.collections.describeInfo(collection)
      assertBrowseSupported(browseStyleOf(target, info), req, { driverId: 'qdrant' })
    }

    const withPayload: Schemas['WithPayloadInterface'] =
      payloadColumns.length > 0 ? [...payloadColumns] : true
    const timeoutSec = toServerTimeout(req.timeoutMs)

    let start: string | number | undefined = resume
    let prepared = false
    let ranPastEnd = false

    const fetchPage = async (
      offset: string | number | undefined,
      pageLimit: number,
    ): Promise<QdrantPointPage> => {
      if (!prepared) {
        prepared = true
        if (skip > 0) {
          const skipped = await this.skipForward(collection, filter, skip, timeoutSec)
          if (skipped === null) ranPastEnd = true
          else start = skipped
        }
      }
      if (ranPastEnd) return { points: [], nextOffset: null }
      const from = offset ?? start
      try {
        const res = await this.client.scroll(collection, {
          limit: pageLimit,
          ...(from === undefined ? {} : { offset: from }),
          with_payload: withPayload,
          with_vector: false,
          ...(filter === undefined ? {} : { filter }),
          ...(orderBy === undefined ? {} : { order_by: orderBy }),
          ...(timeoutSec === undefined ? {} : { timeout: timeoutSec }),
        })
        return {
          points: res.points.map(toPoint),
          nextOffset: asPointId(res.next_page_offset),
        }
      } catch (err) {
        throw mapQdrantError(err, { request: `POST /collections/${collection}/points/scroll` })
      }
    }

    return this.startCursor(req.resultId, {
      shape,
      fetchPage,
      // `limit` is the page size: hitting it means "here is the next cursor",
      // not "the result was cut short"
      maxRows: limit,
      reportTruncation: false,
      continuable: orderBy === undefined,
      ...(req.chunkRows === undefined ? {} : { chunkRows: req.chunkRows }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    })
  }

  /**
   * Emulate a numeric offset by scrolling ids only (no payload, no vectors) until
   * `count` points have gone past. Returns the id to start the real scroll from,
   * or null when the collection ran out first.
   */
  private async skipForward(
    collection: string,
    filter: Schemas['Filter'] | undefined,
    count: number,
    timeoutSec: number | undefined,
  ): Promise<string | number | null> {
    let remaining = count
    let offset: string | number | undefined
    while (remaining > 0) {
      const pageLimit = Math.min(remaining, MAX_PAGE_LIMIT)
      let res: Schemas['ScrollResult']
      try {
        res = await this.client.scroll(collection, {
          limit: pageLimit,
          ...(offset === undefined ? {} : { offset }),
          with_payload: false,
          with_vector: false,
          ...(filter === undefined ? {} : { filter }),
          ...(timeoutSec === undefined ? {} : { timeout: timeoutSec }),
        })
      } catch (err) {
        throw mapQdrantError(err, { request: `POST /collections/${collection}/points/scroll` })
      }
      const next = asPointId(res.next_page_offset)
      if (next === null) return null
      remaining -= res.points.length
      if (res.points.length === 0) return null
      offset = next
    }
    return offset ?? null
  }

  /* ---------------------------------------------------------------- */
  /* vectorSearch                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Similarity search over one collection.
   *
   * Exactly one of `queryVec` / `queryPointId` must be set — neither, or both, is
   * `error.vector.queryRequired`. **The driver never embeds text**: turning
   * `VectorViewState.queryText` into a vector belongs to a layer above, and this
   * method failing loudly is what keeps that boundary honest.
   *
   * A dimension mismatch is worth catching before the request goes out
   * (`error.vector.dimensionMismatch`); so is a multi-vector collection with no
   * `vectorName` (`error.vector.nameRequired`), because qdrant's own message for
   * it does not tell the user what the valid names are.
   */
  async vectorSearch(req: VectorSearchRequest): Promise<Cursor> {
    this.assertOpen()
    const collection = req.collection
    const hasVec = req.queryVec !== undefined
    const hasPoint = req.queryPointId !== undefined
    if (hasVec === hasPoint) {
      throw peekErrorMsg('BAD_REQUEST', 'error.vector.queryRequired')
    }

    const info = await this.collections.describeInfo(collection)
    const chosen = this.resolveVector(info, req.vectorName)
    if (req.queryVec !== undefined && req.queryVec.length !== chosen.size) {
      throw peekErrorMsg('BAD_REQUEST', 'error.vector.dimensionMismatch', {
        actual: req.queryVec.length,
        collection,
        expected: chosen.size,
      })
    }
    const using = chosen.name === '' ? undefined : chosen.name

    const filter = buildQdrantFilter({
      ...(req.filter === undefined ? {} : { filter: req.filter }),
      ...(req.nativeFilter === undefined ? {} : { nativeFilter: req.nativeFilter }),
    })
    const payloadColumns = resolvePayloadColumns(req.columns, NO_IMPLICIT_FLATTENING)
    const withVector = req.withVector === true
    const shape: QdrantRowShape = buildRowShape({
      collection,
      payloadColumns,
      withScore: true,
      withVector,
      ...(using === undefined ? {} : { vectorName: using }),
    })

    const topK = clampInt(req.topK, 1, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT
    const offset = clampInt(req.offset, 0, MAX_PAGE_LIMIT)
    const timeoutSec = toServerTimeout(req.timeoutMs)
    const withPayload: Schemas['WithPayloadInterface'] =
      req.withPayload === false ? false : payloadColumns.length > 0 ? [...payloadColumns] : true
    const nearest: Schemas['VectorInput'] =
      req.queryVec !== undefined ? [...req.queryVec] : (req.queryPointId as string | number)

    // One request, then paged out of memory: topK bounds the whole result, so
    // there is no continuation to hand back (see the cursor's `continuable`).
    let fetched: QdrantPoint[] | null = null
    const runSearch = async (): Promise<QdrantPoint[]> => {
      try {
        const res = await this.client.query(collection, {
          query: { nearest },
          ...(using === undefined ? {} : { using }),
          limit: topK,
          ...(offset === undefined || offset === 0 ? {} : { offset }),
          ...(filter === undefined ? {} : { filter }),
          ...(req.scoreThreshold === undefined ? {} : { score_threshold: req.scoreThreshold }),
          with_payload: withPayload,
          with_vector: withVector ? (using === undefined ? true : [using]) : false,
          ...(timeoutSec === undefined ? {} : { timeout: timeoutSec }),
        })
        return res.points.map(toPoint)
      } catch (err) {
        const mapped = mapQdrantError(err, {
          request: `POST /collections/${collection}/points/query`,
        })
        // "more like this" against an id that is not there: name the point, not
        // the endpoint
        if (mapped.code === 'NOT_FOUND' && req.queryPointId !== undefined) {
          throw peekErrorMsg('NOT_FOUND', 'error.vector.pointNotFound', {
            pointId: req.queryPointId,
            collection,
          })
        }
        throw mapped
      }
    }

    const fetchPage = async (
      pageOffset: string | number | undefined,
      pageLimit: number,
    ): Promise<QdrantPointPage> => {
      if (fetched === null) fetched = await runSearch()
      const start = typeof pageOffset === 'number' ? pageOffset : 0
      const slice = fetched.slice(start, start + pageLimit)
      const end = start + slice.length
      return { points: slice, nextOffset: end >= fetched.length ? null : end }
    }

    return this.startCursor(req.resultId, {
      shape,
      fetchPage,
      continuable: false,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    })
  }

  /**
   * Pick the vector a search runs against.
   *
   * A collection with several named vectors has no default, and qdrant's own
   * error for the omission does not list the names — so the names travel in the
   * message here.
   */
  private resolveVector(
    info: QdrantCollectionInfo,
    requested: string | undefined,
  ): { name: string; size: number; distance: string } {
    const vectors = info.vectors
    if (vectors.length === 0) {
      throw peekError(
        'BAD_REQUEST',
        `Collection ${info.name} has no dense vector configured; there is nothing to search`,
      )
    }
    if (requested !== undefined && requested !== '') {
      const hit = vectors.find((v) => v.name === requested)
      if (!hit) {
        throw peekErrorMsg('BAD_REQUEST', 'error.vector.nameUnknown', {
          collection: info.name,
          name: requested,
        })
      }
      return hit
    }
    const only = vectors[0]
    if (vectors.length === 1 && only !== undefined) return only
    throw peekErrorMsg('BAD_REQUEST', 'error.vector.nameRequired', {
      collection: info.name,
      names: vectors.map((v) => (v.name === '' ? QDRANT_VECTOR_FIELD : v.name)).join(', '),
    })
  }

  private startCursor(
    resultId: ResultId,
    opts: Omit<ConstructorParameters<typeof QdrantPointCursor>[0], 'resultId' | 'onClosed'>,
  ): Cursor {
    if (this.active.has(resultId)) {
      throw peekErrorMsg('CONFLICT', 'error.query.alreadyRunning', { resultId })
    }
    const cursor = new QdrantPointCursor({
      ...opts,
      resultId,
      onClosed: (): void => {
        this.active.delete(resultId)
      },
    })
    this.active.set(resultId, cursor)
    return cursor
  }

  /* ---------------------------------------------------------------- */
  /* valuePeek                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Fetch one field of one point in full: a large payload value, or the vector
   * body itself.
   *
   * `ref.field` follows core's `parseQdrantField` convention — 'vector',
   * 'vector:<name>', 'payload:<key>', or a bare payload key. The vector comes
   * back as a JSON array (`encoding: 'json'`), which is what the inspector needs
   * to render it and what a copy-paste into a notebook needs to be useful.
   *
   * The byte window is applied **after** the value arrives, unlike postgres where
   * the server slices: qdrant returns a whole point or nothing. The ceiling that
   * matters is therefore VALUE_PEEK_MAX_BYTES on the way out.
   */
  async peekValue(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    this.assertOpen()
    if (ref.kind !== 'qdrantPoint') {
      // Only reachable by pointing a qdrant connection at another driver's
      // ValueRef, which is a wiring bug rather than something a user can act on.
      throw peekError('BAD_REQUEST', `The Qdrant driver does not support ${ref.kind} value references`)
    }
    const target = parseQdrantField(ref.field)
    const wantPayload: Schemas['WithPayloadInterface'] =
      target.target === 'payload' ? (target.key === '' ? true : [target.key]) : false
    const wantVector: Schemas['WithVector'] =
      target.target === 'vector' ? (target.name === undefined ? true : [target.name]) : false

    let records: Schemas['Record'][]
    try {
      records = await this.client.retrieve(ref.collection, {
        ids: [ref.pointId],
        with_payload: wantPayload,
        with_vector: wantVector,
      })
    } catch (err) {
      const mapped = mapQdrantError(err, {
        request: `POST /collections/${ref.collection}/points`,
      })
      if (mapped.code === 'NOT_FOUND') {
        throw peekErrorMsg('NOT_FOUND', 'error.vector.pointNotFound', {
          pointId: ref.pointId,
          collection: ref.collection,
        })
      }
      throw mapped
    }
    const record = records[0]
    if (record === undefined) {
      throw peekErrorMsg('NOT_FOUND', 'error.vector.pointNotFound', {
        pointId: ref.pointId,
        collection: ref.collection,
      })
    }

    const value = extractPeekValue(record, target)
    if (value === undefined) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')

    const isText = typeof value === 'string'
    const text = isText ? value : (safeJson(value) ?? String(value))
    const full = Buffer.from(text, 'utf8')
    const offset = Math.max(0, Math.trunc(range?.offset ?? 0))
    const wanted = range?.length === undefined ? VALUE_PEEK_MAX_BYTES : Math.trunc(range.length)
    const length = Math.min(VALUE_PEEK_MAX_BYTES, Math.max(0, wanted))
    const slice = full.subarray(Math.min(offset, full.byteLength), Math.min(offset + length, full.byteLength))

    return {
      ref,
      encoding: isText ? 'utf8' : 'json',
      data: new TextDecoder('utf-8').decode(slice),
      byteLength: slice.byteLength,
      totalBytes: full.byteLength,
      contentType: isText ? 'text/plain' : 'application/json',
      eof: offset + slice.byteLength >= full.byteLength,
    }
  }
}

/** Pull the addressed field out of a retrieved point; undefined means "not there" */
function extractPeekValue(
  record: Schemas['Record'],
  target: ReturnType<typeof parseQdrantField>,
): unknown {
  if (target.target === 'vector') {
    const vector: unknown = record.vector
    if (vector === undefined || vector === null) return undefined
    if (target.name === undefined) return vector
    if (!isPlainObject(vector)) return vector
    return vector[target.name]
  }
  const payload: unknown = record.payload
  if (target.key === '') return payload ?? undefined
  if (!isPlainObject(payload)) return undefined
  return payload[target.key]
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * peek speaks milliseconds; qdrant's per-request `timeout` is whole **seconds**,
 * and a value of 0 means "no timeout" rather than "fail immediately".
 */
function toServerTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
  return Math.max(1, Math.ceil(timeoutMs / 1000))
}

/**
 * How one qdrant collection browses.
 *
 * The kind default already says "no offset paging, and an ordered scroll is a
 * single page". What the kind cannot say is **which** keys are orderable, and
 * that varies collection by collection: `order_by` requires a payload index on
 * the key, and asking for one without it is a server-side 400. A collection with
 * no payload indexes at all is therefore not sortable, full stop —
 * `resolveCollectionBrowseStyle` reads the empty list as exactly that.
 *
 * This is the case the kind-keyed table structurally could not express, and the
 * reason `CollectionSchemaInfo.browse` exists.
 */
function browseStyleOf(
  ref: VectorCollectionRef,
  info: QdrantCollectionInfo,
  payloadColumns: readonly string[] = [],
): CollectionBrowseStyle {
  return {
    ...collectionBrowseStyle(ref),
    sortableColumns: info.payloadIndexes.map((p) => p.field),
    filterableColumns: filterableColumnsOf(payloadColumns),
  }
}

/**
 * The result columns a filter may be attached to.
 *
 * `id` is one: it is addressed with `has_id`, which is a real qdrant predicate.
 * The payload keys the caller chose to flatten are the others, because a
 * predicate on a named key is exactly what qdrant's filter language expresses.
 *
 * What is deliberately **not** on the list is the catch-all json `payload`
 * column, which is the whole of the default projection — there is no predicate
 * over a payload blob as a whole, so a column header on a default vector browse
 * has no filter to offer and must not pretend otherwise. `score` and `vector` are
 * absent for the same reason: neither is filterable server-side.
 */
function filterableColumnsOf(payloadColumns: readonly string[]): string[] {
  return [VECTOR_RESULT_COLUMNS.id, ...payloadColumns]
}
