import {
  CHUNK_DEFAULT_ROWS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  VALUE_PEEK_MAX_BYTES,
  adaptiveChunkRows,
  assertBrowseSupported,
  assertFilterSupported,
  collectionBrowseStyle,
  decodeRowOffsetCursor,
  peekError,
  peekErrorMsg,
  rowOffsetCursor,
  type ByteRange,
  type Capability,
  type ChunkDone,
  type ChunkFrame,
  type CollectionBrowseStyle,
  type CollectionRef,
  type CollectionScanRequest,
  type CollectionSchemaInfo,
  type ColumnDef,
  type Cursor,
  type DriverId,
  type DriverSession,
  type FilterSpec,
  type LogicalType,
  type NamespaceNode,
  type Neo4jConnectionConfig,
  type PeekedValue,
  type RelationRef,
  type ResultId,
  type ServerInfo,
  type SortSpec,
  type TabularQueryRequest,
  type ValueRef,
} from '@peek/core'
import neo4j from 'neo4j-driver'
import type {
  Driver as BoltDriver,
  Record as BoltRecord,
  Result as BoltResult,
  Session as BoltSession,
} from 'neo4j-driver'
import { mapNeo4jError } from './errors'
import { quoteLabel } from './graph'
import { neo4jManifest } from './manifest'
import { PEEK_TAG, logicalTypeOf, toCell, toChunkCell } from './values'

/**
 * One live Neo4j connection.
 *
 * ## The four rules this file exists to enforce
 *
 * 1. **Read-only is the server's answer, not this driver's.** Every Bolt session
 *    below is opened with `defaultAccessMode: READ`, so a write statement comes
 *    back as `Neo.ClientError.Statement.AccessMode` from the server instead of
 *    being executed. Nothing here inspects the statement text — a driver that
 *    decides for itself what "looks like a write" is one `CALL apoc.*` away from
 *    being wrong, and it is wrong silently. `errors.ts` maps the refusal.
 * 2. **One Bolt session per result stream.** A Bolt session runs one statement at
 *    a time, so a cursor owns its own; the control plane (introspect / peek /
 *    ping) opens a short-lived one per call and hands it straight back. This is
 *    the same shape as the postgres driver's pool, for the same reason: a running
 *    scan must not be able to block a metadata query, and cancelling one result
 *    must not touch another.
 * 3. **Nothing Bolt-shaped leaves this file.** Every value goes through
 *    `values.ts`, which explains what happens to a `Node` posted into a
 *    `structuredClone` boundary (its methods vanish and its `Integer`s become
 *    `{low, high}` — visible data loss, no error).
 * 4. **Records are pulled, never collected.** The data plane iterates
 *    `Result[Symbol.asyncIterator]`, which is the one client API with flow
 *    control: it pauses the server-side stream at a watermark. `result.subscribe`
 *    and `await result` both read the whole result set into memory as fast as the
 *    socket allows, which is exactly what the chunk protocol exists to avoid.
 *
 * ## Why `cancel` is real here and is not on qdrant
 *
 * Bolt has RESET, an out-of-band message the server acts on immediately: it
 * terminates the running query and clears the connection. `Session.close()` sends
 * it whenever the connection still has an observable request in flight, so
 * closing a cursor's Bolt session **is** the cancellation, not a client-side
 * hangup that leaves the server working.
 */

/* ------------------------------------------------------------------ */
/* Budgets and defaults                                                */
/* ------------------------------------------------------------------ */

/** Connect probe budget when the config does not give one */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Ceiling on a caller-supplied connect budget, so a typo cannot hang a connect forever */
const MAX_CONNECT_TIMEOUT_MS = 300_000

/**
 * Connection-pool capacity. Cursors are exclusive (one connection per result
 * stream) and the control plane borrows from the same pool, so there is headroom:
 * with four large result views open, introspection can still get a connection.
 *
 * The client's own default is 100, which is not a budget so much as the absence
 * of one — peek would happily open a hundred connections to a server sized for a
 * handful.
 */
const POOL_MAX = 8

/**
 * Server-side backstop when the caller gives no timeoutMs: one statement gets at
 * most five minutes, armed as the transaction timeout so the **server** enforces
 * it. Neo4j ships with `db.transaction.timeout` disabled, so without this a
 * runaway match holds its connection until the process dies.
 *
 * It covers the whole stream, not one PULL, which is the same property postgres's
 * `statement_timeout` + `idle_in_transaction_session_timeout` pair has: a result
 * held open by backpressure for longer than the budget is terminated. Both
 * drivers accept that, because the alternative is a transaction that a stalled
 * consumer can keep open indefinitely.
 */
const DEFAULT_TX_TIMEOUT_MS = 300_000

/**
 * Ceiling on the RESET round trip a cancel waits for.
 *
 * ConnectionManager allows cancelMs (2s) before it escalates to killing the whole
 * driver process, so this has to give up first and leave the teardown to `close`.
 */
const CANCEL_BUDGET_MS = 1_500

/** Same idea for the sweep `close()` runs over still-running cursors */
const CLOSE_CANCEL_BUDGET_MS = 2_000

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 7687

/** Shows up in `dbms.listConnections`, which is where a DBA looks when a query is stuck */
const USER_AGENT = 'peek'

/* ------------------------------------------------------------------ */
/* Collections: what a neo4j "collection" is                           */
/* ------------------------------------------------------------------ */

/**
 * Neo4j has no tables, so something else has to be the browsable collection, and
 * `CollectionRef` offers three shapes: a relation, a redis key pattern, a vector
 * collection. A node label is a named set of entities with a projection and a
 * count — a relation in every way that `RelationRef` uses the word — so that is
 * the shape used, and `schema` carries which of Neo4j's two namespaces the name
 * lives in.
 *
 * **Relationship types are collections too, and that is why `schema` is not
 * empty.** A label `Person` and a relationship type `Person` are both legal and
 * are different objects; with `schema: ''` the two would produce the identical
 * ref and a scan could not tell which one it was asked for. `schema` is the only
 * field that can separate them, and separating namespaces is what the field is
 * for — sqlite and mysql leave it empty precisely because they have one.
 *
 * The visible consequence is that `collectionRefLabel` renders `node.Person` and
 * `rel.KNOWS`, which reads as what it is.
 */
export const NODE_NAMESPACE = 'node'
export const REL_NAMESPACE = 'rel'

/**
 * The column carrying `elementId()`.
 *
 * The scan projects it as a column of its own rather than leaving it inside the
 * entity blob, and it earns the width three times over: it is the row's primary
 * key, so `ValueRef.relationCell` can address a cell after the result set is
 * gone; it is the one thing in the row that is stable enough to filter and order
 * by; and it is what `composeGraphQuery` matches on, so a row in the table view
 * can be pasted into the graph view's `focus` and expanded.
 */
const ELEMENT_ID_COLUMN = 'elementId'

/** The Cypher variable each namespace binds, and therefore the entity column's name */
const NODE_COLUMN = 'n'
const REL_COLUMN = 'r'

/**
 * The result columns a filter may be attached to.
 *
 * Only the id. A predicate on the entity column means a predicate over a whole
 * node — Cypher has nothing to express that with, and a column header that
 * offered one would be promising something no database can do. Filters that name
 * a **property** are not on this list and are not meant to be: they resolve to
 * `target: 'field'` (see core's `filterTarget`), which is the reading
 * `FilterSpec.column` has always had on a schemaless store, and they are
 * translated below.
 */
const FILTERABLE_COLUMNS: readonly string[] = [ELEMENT_ID_COLUMN]

export interface Neo4jCollection {
  ref: RelationRef
  namespace: typeof NODE_NAMESPACE | typeof REL_NAMESPACE
  /** The label, or the relationship type */
  name: string
  /** The Cypher variable the projection binds: 'n' for a label, 'r' for a type */
  variable: string
}

/**
 * Narrow a `CollectionRef` to something this driver can browse.
 *
 * An unknown namespace is refused by name rather than guessed at: picking one of
 * the two would answer a question about labels with a page of relationships, and
 * a wrong answer is worse than a refusal. Plain English, because a hand-written
 * ref only ever comes from an MCP caller.
 */
export function requireNeo4jCollection(ref: CollectionRef): Neo4jCollection {
  if (ref.kind !== 'relation') {
    throw peekErrorMsg('BAD_REQUEST', 'error.collection.kindUnsupported', {
      driverId: 'neo4j',
      kind: ref.kind,
    })
  }
  if (ref.schema === NODE_NAMESPACE) {
    return { ref, namespace: NODE_NAMESPACE, name: ref.name, variable: NODE_COLUMN }
  }
  if (ref.schema === REL_NAMESPACE) {
    return { ref, namespace: REL_NAMESPACE, name: ref.name, variable: REL_COLUMN }
  }
  throw peekError(
    'BAD_REQUEST',
    `A neo4j collection is addressed as schema "${NODE_NAMESPACE}" (a node label)`
      + ` or schema "${REL_NAMESPACE}" (a relationship type); got "${ref.schema}"`,
  )
}

/** The pattern a scan of this collection matches */
function matchClause(target: Neo4jCollection): string {
  const token = quoteLabel(target.name)
  return target.namespace === NODE_NAMESPACE
    ? `MATCH (${NODE_COLUMN}:${token})`
    : `MATCH ()-[${REL_COLUMN}:${token}]->()`
}

/**
 * The columns a scan produces — one place, because `describeCollection` promises
 * them and frame 0 has to deliver exactly that.
 *
 * The entity travels as **one json cell**, not as flattened property columns.
 * Flattening would need the property set of a label, and Neo4j will only give
 * that by sampling the store (`db.schema.nodeTypeProperties`, which walks nodes);
 * worse, the chunk protocol pins `schema` to frame 0, so any property missing
 * from the sample would silently disappear from a result that claims to be the
 * whole node.
 */
function scanColumns(target: Neo4jCollection): ColumnDef[] {
  return [
    {
      name: ELEMENT_ID_COLUMN,
      logical: 'string',
      nativeType: 'elementId',
      primaryKey: true,
    },
    {
      name: target.variable,
      logical: 'json',
      nativeType: target.namespace === NODE_NAMESPACE ? 'node' : 'relationship',
      // Peekable because a `relationCell` ref built from this row's elementId
      // resolves — see `peekValue`. Nothing else in this driver is peekable, and
      // claiming otherwise would wire up an inspector entry point that 404s.
      peekable: true,
    },
  ]
}

/* ------------------------------------------------------------------ */
/* Namespace tree node ids                                             */
/* ------------------------------------------------------------------ */

/**
 * Node ids: 'db:neo4j' / 'group:node' / 'label:Person' / 'reltype:KNOWS'.
 *
 * The last segment is taken verbatim, as in the redis and qdrant codecs: a label
 * can contain a colon (`CREATE (:`a:b`)` is legal) and the tag is enough to know
 * where the name starts.
 */
export const nodeId = {
  database: (name: string): string => `db:${name}`,
  group: (namespace: string): string => `group:${namespace}`,
  label: (name: string): string => `label:${name}`,
  relType: (name: string): string => `reltype:${name}`,
}

export type ParsedNodeId =
  | { kind: 'database'; name: string }
  | { kind: 'group'; namespace: string }
  | { kind: 'label'; name: string }
  | { kind: 'relType'; name: string }
  | { kind: 'unknown' }

export function parseNodeId(id: string): ParsedNodeId {
  const sep = id.indexOf(':')
  if (sep < 0) return { kind: 'unknown' }
  const tag = id.slice(0, sep)
  const rest = id.slice(sep + 1)
  if (rest.length === 0) return { kind: 'unknown' }
  if (tag === 'db') return { kind: 'database', name: rest }
  if (tag === 'group') return { kind: 'group', namespace: rest }
  if (tag === 'label') return { kind: 'label', name: rest }
  if (tag === 'reltype') return { kind: 'relType', name: rest }
  return { kind: 'unknown' }
}

/* ------------------------------------------------------------------ */
/* Cypher fragments                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parameter collector: `bind(v)` returns the `$pN` placeholder that will carry it.
 *
 * `$pN` and not `$name`, because `graph.ts` already composes statements that way
 * and `TabularQueryRequest.params` is positional — one numbering convention for
 * both paths means one mapping function (`boltParams`) and no way for the two to
 * disagree about which value `$p2` is.
 */
class CypherParams {
  private readonly values: unknown[] = []

  bind(value: unknown): string {
    this.values.push(value)
    return `$p${String(this.values.length)}`
  }

  get list(): readonly unknown[] {
    return this.values
  }
}

/**
 * Positional params → the map Bolt wants, with integers made explicit.
 *
 * **The `neo4j.int` conversion is not a nicety, it is what makes `LIMIT $p2`
 * run at all.** The client packs every JS `number` as a Bolt Float, because a
 * `number` carries no evidence of intent, and Cypher refuses a Float where it
 * wants an integer: `SKIP`/`LIMIT` answer `Invalid input. '200.0' is not a valid
 * value. Must be a non-negative integer` — which is a failure of the *statement*,
 * so it takes the whole graph view down and not just the paging. Every composed
 * statement in this package binds its limits positionally, so the conversion has
 * to live here, at the one place both paths pass through.
 *
 * Comparisons are unaffected: Cypher compares Integer and Float numerically, so
 * `n.score = 30` still matches a stored `30.0`.
 */
export function boltParams(values: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  values.forEach((value, i) => {
    out[`p${String(i + 1)}`] = boltValue(value)
  })
  return out
}

function boltValue(value: unknown): unknown {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return neo4j.int(value)
  if (typeof value === 'bigint') return neo4j.int(value)
  if (Array.isArray(value)) return value.map(boltValue)
  return value
}

function requireValue(spec: FilterSpec): unknown {
  if (spec.value === undefined) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterMissingValue', {
      column: spec.column,
      op: spec.op,
    })
  }
  return spec.value
}

/**
 * SQL wildcards → a Cypher regex.
 *
 * Cypher has no LIKE. It has `=~`, which is a full-match Java regex, so the
 * pattern is escaped **first** (a filter value is user text, and a stray `(` in
 * it would otherwise be a syntax error inside the regex rather than a character
 * to match) and only then are `%` and `_` given back their LIKE meanings.
 * `ilike` becomes the inline `(?i)` flag, which is the only case-insensitive
 * form the server-side regex accepts.
 */
function likeRegex(pattern: string, caseInsensitive: boolean): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/%/g, '.*').replace(/_/g, '.')
  return caseInsensitive ? `(?i)${body}` : body
}

/**
 * One `FilterSpec` → one Cypher predicate.
 *
 * `spec.column` names the id column, or a **property** — the same reading qdrant
 * gives it, and the only one available on a store with no result-column to attach
 * a predicate to (see FILTERABLE_COLUMNS).
 */
function renderFilter(spec: FilterSpec, target: Neo4jCollection, params: CypherParams): string {
  const v = target.variable
  const prop = spec.column === ELEMENT_ID_COLUMN
    ? `elementId(${v})`
    : `${v}.${quoteLabel(spec.column)}`

  switch (spec.op) {
    case 'isNull':
      return `${prop} IS NULL`
    case 'isNotNull':
      return `${prop} IS NOT NULL`
    case 'eq':
      return `${prop} = ${params.bind(requireValue(spec))}`
    case 'neq':
      // Not `<>`: in Cypher a comparison with a missing property is null, and a
      // null predicate filters the row out — so `<>` would quietly drop every
      // entity that does not have the property at all, which is the opposite of
      // what "not equal to x" means to the person who typed it.
      return `NOT (${prop} = ${params.bind(requireValue(spec))})`
    case 'lt':
      return `${prop} < ${params.bind(requireValue(spec))}`
    case 'lte':
      return `${prop} <= ${params.bind(requireValue(spec))}`
    case 'gt':
      return `${prop} > ${params.bind(requireValue(spec))}`
    case 'gte':
      return `${prop} >= ${params.bind(requireValue(spec))}`
    case 'like':
    case 'ilike':
      return `${prop} =~ ${params.bind(likeRegex(String(requireValue(spec)), spec.op === 'ilike'))}`
    case 'contains': {
      const value = requireValue(spec)
      // Two different questions wearing one name, and Cypher spells them
      // differently: substring for text, membership for a list-valued property.
      // The value's own type is the only evidence available for which was meant.
      return typeof value === 'string'
        ? `${prop} CONTAINS ${params.bind(value)}`
        : `${params.bind(value)} IN ${prop}`
    }
    case 'in': {
      const value = requireValue(spec)
      if (!Array.isArray(value)) {
        throw peekErrorMsg('BAD_REQUEST', 'error.sql.filterValueNotArray', { column: spec.column })
      }
      return `${prop} IN ${params.bind(value)}`
    }
  }
}

function renderWhere(
  filters: readonly FilterSpec[] | undefined,
  target: Neo4jCollection,
  params: CypherParams,
): string | undefined {
  if (!filters || filters.length === 0) return undefined
  return filters.map((spec) => renderFilter(spec, target, params)).join(' AND ')
}

/**
 * `SortSpec` → an ORDER BY.
 *
 * Neo4j's null ordering is fixed and undeclarable: nulls sort last ascending and
 * first descending, and Cypher has no `NULLS FIRST` to say otherwise. A request
 * for the other two combinations is refused rather than honoured-approximately,
 * because "sorted, with the nulls somewhere else than you asked" is a result the
 * caller cannot tell apart from the one they wanted.
 */
function renderOrderBy(
  sorts: readonly SortSpec[] | undefined,
  target: Neo4jCollection,
): string | undefined {
  if (!sorts || sorts.length === 0) return undefined
  const parts = sorts.map((spec) => {
    const natural = spec.dir === 'desc' ? 'first' : 'last'
    if (spec.nulls !== undefined && spec.nulls !== natural) {
      throw peekError(
        'BAD_REQUEST',
        `Cypher always orders nulls ${natural} on a ${spec.dir} sort and cannot be asked`
          + ` for nulls ${spec.nulls}`,
      )
    }
    const expr = spec.column === ELEMENT_ID_COLUMN
      ? `elementId(${target.variable})`
      : `${target.variable}.${quoteLabel(spec.column)}`
    return `${expr} ${spec.dir === 'desc' ? 'DESC' : 'ASC'}`
  })
  return parts.join(', ')
}

/* ------------------------------------------------------------------ */
/* Cells                                                               */
/* ------------------------------------------------------------------ */

/**
 * The driver's own type name for a column, read off the **converted** cell.
 *
 * Cypher has no result metadata — there is nothing to ask what type a column is —
 * so this is the first row's answer, held for the whole result exactly as
 * `logicalTypeOf` is. Reading the converted cell rather than the Bolt value keeps
 * the type dispatch in `values.ts` alone; the price is that a temporal, which
 * arrives here as its ISO string, reports `string` rather than `datetime`. That
 * is the honest description of what the cell now holds, and re-deriving the Bolt
 * class here would be a second dispatch to keep in step with the first.
 */
function nativeTypeOf(cell: unknown): string {
  if (cell === null || cell === undefined) return 'null'
  if (typeof cell === 'string') return 'string'
  if (typeof cell === 'number') return 'number'
  if (typeof cell === 'boolean') return 'boolean'
  if (Array.isArray(cell)) return 'list'
  if (typeof cell === 'object') {
    const tag = (cell as Record<string, unknown>)[PEEK_TAG]
    if (tag === 'node') return 'node'
    if (tag === 'rel') return 'relationship'
    if (tag === 'path') return 'path'
    return 'map'
  }
  return 'value'
}

/** Estimate a cell's wire size in bytes; feeds core's adaptiveChunkRows */
function estimateCellBytes(value: unknown): number {
  if (value === null || value === undefined) return 1
  switch (typeof value) {
    case 'boolean':
      return 1
    case 'number':
      return 8
    case 'string':
      return Buffer.byteLength(value, 'utf8')
    case 'object':
      break
    default:
      return 8
  }
  const rec = value as Record<string, unknown>
  const preview = rec['preview']
  // TruncatedValue: only the preview travels
  if (rec['__peekTruncated'] === true && typeof preview === 'string') {
    return Buffer.byteLength(preview, 'utf8') + 64
  }
  const text = safeJson(value)
  return text === null ? 32 : Buffer.byteLength(text, 'utf8')
}

function safeJson(value: unknown, indent?: number): string | null {
  try {
    const text = JSON.stringify(value, null, indent)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** A record field, as the plain string the introspection queries all return */
function stringField(record: BoltRecord, key: string): string {
  const raw: unknown = record.get(key)
  return typeof raw === 'string' ? raw : String(raw)
}

/**
 * Race work against a wall-clock budget and the caller's abort signal.
 *
 * Used by connect only. The Bolt client has its own `connectionTimeout`, but it
 * covers the socket handshake and not the round trips after it, so a server that
 * accepts a connection and then stops answering would otherwise hold a connect
 * attempt open past any budget the caller set.
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
      finish(() => {
        reject(peekErrorMsg('CANCELLED', 'error.conn.connectCancelled'))
      })
    }
    const timer = setTimeout(() => {
      finish(() => {
        reject(
          peekErrorMsg('TIMEOUT', 'error.query.timedOut', { operation, ms: budgetMs }, {
            retryable: true,
          }),
        )
      })
    }, Math.max(1, Math.trunc(budgetMs)))
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        finish(() => {
          resolve(value)
        })
      },
      (err: unknown) => {
        finish(() => {
          reject(err)
        })
      },
    )
  })
}

/**
 * Wait for `work`, but never longer than `ms`, and never reject.
 *
 * Both properties are the point at teardown: a step that throws must not abandon
 * the steps after it, and a RESET that will never be acknowledged — the server is
 * gone — must not hold the disconnect open. Work outliving the budget is left
 * running; waiting for it is what the budget exists to avoid.
 */
function withBudget(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
}

/* ================================================================== */
/* Cursor                                                              */
/* ================================================================== */

/** Column metadata the caller already knows; a scan supplies it, a free statement cannot */
export interface Neo4jColumnHint {
  logical?: LogicalType
  nativeType?: string
  primaryKey?: boolean
  peekable?: boolean
}

export interface Neo4jCursorOptions {
  resultId: ResultId
  /** Opens the Bolt session this cursor owns; always READ mode, see `Neo4jSession.openBolt` */
  openSession: () => BoltSession
  text: string
  params: readonly unknown[]
  /** Row ceiling; going past it sets done.truncated = true */
  maxRows?: number
  /** Fixed rows per frame; when absent, adaptiveChunkRows decides from the observed row width */
  chunkRows?: number
  timeoutMs?: number
  signal?: AbortSignal
  columnHints?: ReadonlyMap<string, Neo4jColumnHint>
  /** Extra fields for the final frame's `done` (collectionScan's nextCursor) */
  finish?: (rows: number, exhausted: boolean) => Pick<ChunkDone, 'truncated' | 'nextCursor'>
  onClosed?: () => void
}

/**
 * A Cypher result as a core `Cursor`.
 *
 * Termination follows core/chunk.ts to the letter:
 * - normal end   = the last frame carries `done` (an empty result still emits one
 *                  frame, rowCount 0)
 * - abnormal end = next() rejects with a PeekError, and no `done` frame follows
 * - seq increments from 0 with no gaps
 */
export class Neo4jCursor implements Cursor {
  readonly resultId: ResultId

  private readonly opts: Neo4jCursorOptions
  private readonly startedAt = Date.now()

  private bolt: BoltSession | null = null
  private result: BoltResult | null = null
  private iter: ReturnType<BoltResult[typeof Symbol.asyncIterator]> | null = null

  /** Column names, known from the RUN reply before the first record arrives */
  private keys: readonly string[] = []
  private _schema: ColumnDef[] | null = null

  /** Records pulled from the server but not yet packed into a frame */
  private buffer: BoltRecord[] = []
  private exhausted = false

  private seq = 0
  private rowsEmitted = 0
  private doneSent = false
  private closed = false
  private cancelled = false
  private avgRowBytes = 0

  constructor(opts: Neo4jCursorOptions) {
    this.opts = opts
    this.resultId = opts.resultId
  }

  get schema(): readonly ColumnDef[] | null {
    return this._schema
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Start the statement and settle its column names.
   *
   * Awaiting `keys()` is what makes a bad statement fail at `query()` rather than
   * at the first frame: Bolt reports RUN failures — syntax, semantics, and the
   * access-mode refusal that read-only rests on — before any record, so this is
   * where a write attempt surfaces. It is also the only source of the column list
   * that is right for an **empty** result, where there is no first row to read it
   * off.
   *
   * Subscribing for keys before the iterator does is bounded, not eager: the
   * stream observer stops auto-pulling once its queue passes the client's high
   * watermark, so at most one fetch batch can arrive before the iterator takes
   * over the flow control.
   */
  async open(): Promise<void> {
    this.throwIfAborted()
    const bolt = this.opts.openSession()
    this.bolt = bolt
    try {
      const budget = this.opts.timeoutMs !== undefined && this.opts.timeoutMs > 0
        ? Math.trunc(this.opts.timeoutMs)
        : DEFAULT_TX_TIMEOUT_MS
      const result = bolt.run(this.opts.text, boltParams(this.opts.params), {
        timeout: neo4j.int(budget),
      })
      this.result = result
      this.iter = result[Symbol.asyncIterator]()
      this.keys = await result.keys()
    } catch (err) {
      await this.close().catch(() => {})
      throw mapNeo4jError(err, { statement: this.opts.text })
    }
  }

  /** Called once cancel() has sent RESET, so any further next() fails immediately */
  markCancelled(): void {
    this.cancelled = true
  }

  async next(): Promise<ChunkFrame | null> {
    try {
      return await this.fetchFrame()
    } catch (err) {
      await this.close().catch(() => {})
      throw err
    }
  }

  private async fetchFrame(): Promise<ChunkFrame | null> {
    if (this.doneSent || this.closed) return null
    this.throwIfAborted()

    const { maxRows } = this.opts
    let want = this.nextBatchSize()
    let hitMaxRows = false
    if (maxRows !== undefined && maxRows >= 0) {
      const remain = maxRows - this.rowsEmitted
      if (remain <= 0) {
        hitMaxRows = true
        want = 0
      } else if (remain < want) {
        want = remain
        hitMaxRows = true
      }
    }

    // One record beyond what is needed acts as a probe: it separates "this batch
    // landed exactly on the end" from "there is more", which avoids an empty
    // trailing frame. want === 0 only happens on the degenerate maxRows === 0 call.
    if (want > 0) await this.fill(want + 1)

    const take = Math.min(want, this.buffer.length)
    const records = take > 0 ? this.buffer.splice(0, take) : []

    // Converted first, because the schema is guessed from the first row's cells
    // and `logicalTypeOf` is written against converted values — a raw Bolt
    // Integer would classify as json.
    const rows = records.map((record) => this.keys.map((_, i) => toChunkCell(record.get(i))))
    const schema = this.ensureSchema(rows[0])

    const cols: unknown[][] = Array.from({ length: schema.length }, () => [])
    let frameBytes = 0
    for (const row of rows) {
      for (let c = 0; c < schema.length; c += 1) {
        const cell = row[c] ?? null
        const bucket = cols[c]
        if (bucket) bucket.push(cell)
        frameBytes += estimateCellBytes(cell)
      }
    }

    this.rowsEmitted += rows.length
    if (rows.length > 0) {
      const observed = frameBytes / rows.length
      // Rolling average, so one unusually wide row cannot collapse the chunk size
      this.avgRowBytes = this.avgRowBytes === 0 ? observed : this.avgRowBytes * 0.5 + observed * 0.5
    }

    const truncatedByMax = hitMaxRows && (this.buffer.length > 0 || !this.exhausted)
    const finished = truncatedByMax || (this.exhausted && this.buffer.length === 0)

    const frame: ChunkFrame = {
      resultId: this.resultId,
      seq: this.seq,
      cols,
      rowCount: rows.length,
    }
    if (this.seq === 0) frame.schema = schema
    this.seq += 1

    if (finished) {
      const extra = this.opts.finish?.(this.rowsEmitted, this.exhausted && !truncatedByMax) ?? {}
      frame.done = {
        rows: this.rowsEmitted,
        elapsedMs: Date.now() - this.startedAt,
        ...(truncatedByMax ? { truncated: true } : {}),
        ...extra,
      }
      this.doneSent = true
      await this.close()
    }
    return frame
  }

  /** Pull records one at a time until the buffer holds `target` of them, or the result ends */
  private async fill(target: number): Promise<void> {
    const iter = this.iter
    if (iter === null) throw peekErrorMsg('INTERNAL', 'error.driver.cursorReleased')
    while (!this.exhausted && this.buffer.length < target) {
      this.throwIfAborted()
      let next: IteratorResult<BoltRecord, unknown>
      try {
        next = await iter.next()
      } catch (err) {
        // A RESET sent by cancel() surfaces here as a terminated transaction (or
        // as a dead connection, depending on how far the statement had got).
        // Either way the caller asked for it, so it is not a query failure.
        if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
        throw mapNeo4jError(err, { statement: this.opts.text })
      }
      if (next.done === true) {
        this.exhausted = true
        return
      }
      this.buffer.push(next.value)
    }
  }

  /**
   * Column definitions, from the RUN reply's keys plus the first row's shapes.
   *
   * No de-duplication of names: Neo4j refuses `RETURN 1 AS a, 2 AS a` server-side
   * ("Multiple result columns with the same name are not supported"), so unlike
   * the postgres driver there is nothing here to disambiguate.
   */
  private ensureSchema(sample: readonly unknown[] | undefined): ColumnDef[] {
    if (this._schema !== null) return this._schema
    const hints = this.opts.columnHints
    const defs: ColumnDef[] = this.keys.map((key, i) => {
      const cell = sample?.[i]
      const hint = hints?.get(key)
      const def: ColumnDef = {
        name: key,
        logical: hint?.logical ?? logicalTypeOf(cell),
        nativeType: hint?.nativeType ?? nativeTypeOf(cell),
      }
      if (hint?.primaryKey === true) def.primaryKey = true
      if (hint?.peekable === true) def.peekable = true
      return def
    })
    this._schema = defs
    return defs
  }

  /** Rows for the next batch: the caller's fixed value if any, otherwise adapted to the observed row width */
  private nextBatchSize(): number {
    const fixed = this.opts.chunkRows
    if (fixed !== undefined && fixed > 0) return Math.trunc(fixed)
    if (this.avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
    return adaptiveChunkRows(this.avgRowBytes)
  }

  private throwIfAborted(): void {
    if (this.cancelled) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    if (this.opts.signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.driver.queryCancelled')
    const budget = this.opts.timeoutMs
    if (budget !== undefined && budget > 0 && Date.now() - this.startedAt > budget) {
      throw peekErrorMsg('TIMEOUT', 'error.query.timedOut', { operation: 'Query', ms: budget })
    }
  }

  /**
   * Idempotent, and the place the server-side stop actually happens.
   *
   * `Session.close()` cancels the result (so the remaining records are DISCARDed
   * rather than pulled) and then, because the connection still has an observable
   * request in flight, sends **RESET** and waits for its acknowledgement. RESET is
   * the Bolt message the server acts on out of band: it terminates the running
   * query. That is why this driver can advertise `cancel` where the qdrant one
   * cannot — closing here is not a client-side hangup that leaves a query running.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const bolt = this.bolt
    this.bolt = null
    this.result = null
    this.iter = null
    this.buffer = []
    if (bolt !== null) {
      // A close that itself fails leaves nothing to salvage — the connection is
      // being discarded either way — and must not stop the session from
      // forgetting this cursor.
      await bolt.close().catch(() => {})
    }
    this.opts.onClosed?.()
  }
}

/* ================================================================== */
/* Session                                                             */
/* ================================================================== */

/** What the connect probe learned, beyond `ServerInfo` */
interface ServerProbe {
  serverInfo: ServerInfo
  /** The database the server resolved the connection to; see `Neo4jSession.database` */
  database: string | undefined
}

export class Neo4jSession implements DriverSession {
  readonly driverId: DriverId = 'neo4j'
  readonly capabilities: ReadonlySet<Capability> = new Set(neo4jManifest.capabilities)
  readonly serverInfo: ServerInfo

  private readonly driver: BoltDriver
  /**
   * The database every Bolt session below is pinned to.
   *
   * Resolved at connect even when the config named none, so that the tree — which
   * is labelled with this name — cannot come to describe a different database
   * than the one being browsed, should the server's home database change under a
   * live connection.
   */
  private readonly database: string | undefined

  /** Cursors currently streaming; cancel() and close() work through this */
  private readonly active = new Map<ResultId, Neo4jCursor>()

  /** Token stores, cached until a manual refresh (PLAN section 8) */
  private labels: string[] | null = null
  private relTypes: string[] | null = null
  private propertyKeys: string[] | null = null

  private closed = false

  private constructor(driver: BoltDriver, probe: ServerProbe) {
    this.driver = driver
    this.serverInfo = probe.serverInfo
    this.database = probe.database
  }

  /* ---------------------------------------------------------------- */
  /* Connecting                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Open the connection and probe it twice, because the two probes answer
   * different questions.
   *
   * `getServerInfo` acquires a connection, so it settles reachability, TLS and
   * credentials — a wrong password has to surface here, or the connection state
   * machine reports `ready` and the first click fails instead. `RETURN 1` then
   * settles the **database**: on a direct `bolt://` URL nothing before it has
   * named one, so a typo in the database field would otherwise be discovered by
   * the first expansion of the tree. Its summary is also where the resolved
   * database name comes from.
   */
  static async connect(cfg: Neo4jConnectionConfig, signal?: AbortSignal): Promise<Neo4jSession> {
    if (signal?.aborted) throw peekErrorMsg('CANCELLED', 'error.conn.connectCancelled')
    const budget = clampInt(cfg.connectTimeoutMs, 100, MAX_CONNECT_TIMEOUT_MS)
      ?? DEFAULT_CONNECT_TIMEOUT_MS

    let driver: BoltDriver
    try {
      driver = neo4j.driver(boltUrl(cfg), authOf(cfg), {
        userAgent: USER_AGENT,
        maxConnectionPoolSize: POOL_MAX,
        connectionTimeout: budget,
        // Stated rather than left to the default, because the default is the only
        // thing keeping `values.ts` correct: with lossless integers off, a 64-bit
        // id past 2^53 arrives already rounded, `fromNeo4jInteger` has nothing
        // left to detect, and the wrong number is displayed as if it were right.
        disableLosslessIntegers: false,
      })
    } catch (err) {
      // A malformed URL or an unsupported scheme throws here, synchronously.
      throw mapNeo4jError(err, { fallback: 'CONNECTION_FAILED' })
    }

    try {
      const info = await withDeadline(
        driver.getServerInfo(cfg.database === undefined ? {} : { database: cfg.database }),
        budget,
        signal,
        'Connect',
      )
      const database = await withDeadline(
        probeDatabase(driver, cfg.database),
        budget,
        signal,
        'Connect',
      )
      // The agent is 'Neo4j/5.26.0'; the part after the slash is the version, and
      // an agent in any other shape is reported verbatim rather than sliced into
      // something that only looks like a version.
      const agent = info.agent ?? ''
      const slash = agent.indexOf('/')
      const extra: Record<string, string> = {}
      if (agent !== '') extra['agent'] = agent
      if (info.address !== undefined) extra['address'] = info.address
      if (info.protocolVersion !== undefined) extra['bolt'] = String(info.protocolVersion)
      return new Neo4jSession(driver, {
        serverInfo: {
          version: slash > 0 ? agent.slice(slash + 1) : agent,
          flavor: 'Neo4j',
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        },
        database,
      })
    } catch (err) {
      await driver.close().catch(() => {})
      throw mapNeo4jError(err, { fallback: 'CONNECTION_FAILED' })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Close the session — and stop the server working on results nobody will
   * collect.
   *
   * The cursors are closed **before** the driver, and closing a cursor is what
   * sends RESET (see `Neo4jCursor.close`), so the sweep and the teardown are the
   * same act here rather than two as they are on postgres. The budget is for the
   * case where the acknowledgement never comes — the server is gone — where
   * waiting would make disconnect slower than it was before the sweep existed.
   */
  async close(): Promise<void> {
    if (this.closed) return
    // Set before the first await: `assertOpen` is what stops a new cursor being
    // started underneath the sweep and surviving it.
    this.closed = true
    const cursors = [...this.active.values()]
    this.active.clear()
    await withBudget(
      Promise.all(cursors.map((c) => c.close().catch(() => {}))),
      CLOSE_CANCEL_BUDGET_MS,
    )
    await this.driver.close().catch(() => {})
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await this.driver.getServerInfo(this.database === undefined ? {} : { database: this.database })
    } catch (err) {
      throw mapNeo4jError(err, { fallback: 'CONNECTION_LOST' })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw peekErrorMsg('CONNECTION_LOST', 'error.conn.closed')
  }

  /**
   * Every Bolt session in this driver is opened here, and every one of them is a
   * READ session.
   *
   * This single line is peek's read-only guarantee for Neo4j. The server refuses
   * a write inside a read transaction with `Neo.ClientError.Statement.AccessMode`
   * — the same shape of promise the postgres driver gets from `BEGIN READ ONLY`,
   * and for the same reason: a driver that decides for itself which statements
   * are writes has to parse Cypher, and it only has to be wrong once.
   */
  private openBolt(): BoltSession {
    return this.driver.session({
      defaultAccessMode: neo4j.session.READ,
      ...(this.database === undefined ? {} : { database: this.database }),
    })
  }

  /**
   * Run a control-plane statement and collect it.
   *
   * Collecting is right *here* and wrong on the data plane: these results are a
   * token list or a single count, and their session has to be handed back
   * immediately rather than held open by a caller who may never come back for the
   * second page.
   */
  private async runEager(
    text: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<BoltRecord[]> {
    this.assertOpen()
    const bolt = this.openBolt()
    try {
      const res = await bolt.run(text, params)
      return res.records
    } catch (err) {
      throw mapNeo4jError(err, { statement: text })
    } finally {
      await bolt.close().catch(() => {})
    }
  }

  /* ---------------------------------------------------------------- */
  /* introspect — database → labels / relationship types                */
  /* ---------------------------------------------------------------- */

  /**
   * The tree is database → two groups → the tokens in each.
   *
   * The group level exists because the two token kinds are genuinely disjoint
   * namespaces (see `NODE_NAMESPACE`), and a flat list of both would leave the
   * user guessing whether `Person` is a label or a relationship type — a
   * distinction that decides what a click opens.
   */
  async listChildren(parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]> {
    this.assertOpen()
    // The whole cache, not just this level: the token lists are three independent
    // reads, and clearing one would leave a stale answer to be served the moment
    // the user expands the neighbouring group. Refresh is a deliberate gesture,
    // and re-reading the token stores is cheap.
    if (refresh === true) this.invalidateIntrospectCache()
    if (parentId === null) return this.rootNodes()

    const parsed = parseNodeId(parentId)
    switch (parsed.kind) {
      case 'database':
        return this.groupNodes()
      case 'group':
        if (parsed.namespace === NODE_NAMESPACE) {
          return (await this.labelNames()).map((name) => ({
            id: nodeId.label(name),
            name,
            kind: 'collection' as const,
            hasChildren: false,
            ref: { kind: 'relation' as const, schema: NODE_NAMESPACE, name },
            detail: 'node label',
          }))
        }
        if (parsed.namespace === REL_NAMESPACE) {
          return (await this.relTypeNames()).map((name) => ({
            id: nodeId.relType(name),
            name,
            kind: 'collection' as const,
            hasChildren: false,
            ref: { kind: 'relation' as const, schema: REL_NAMESPACE, name },
            detail: 'relationship type',
          }))
        }
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
      case 'label':
      case 'relType':
        // Leaves: the columns and the count come from describeCollection, they
        // are not part of the tree
        return []
      case 'unknown':
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
    }
  }

  private rootNodes(): NamespaceNode[] {
    const name = this.database ?? 'neo4j'
    const node: NamespaceNode = {
      id: nodeId.database(name),
      name,
      kind: 'database',
      hasChildren: true,
    }
    if (this.serverInfo.version !== '') node.detail = `Neo4j ${this.serverInfo.version}`
    return [node]
  }

  /**
   * Both groups claim children without asking whether they have any.
   *
   * `NamespaceNode.hasChildren` is documented as "pass true when unknown; if
   * expanding yields an empty array the UI folds the node back", and the
   * alternative is reading both token stores to draw a row the user has not
   * clicked yet. The names are English literals for the same reason
   * `NamespaceNode.detail` is everywhere else: MCP reads this tree, and that
   * surface stays English.
   */
  private groupNodes(): NamespaceNode[] {
    return [
      {
        id: nodeId.group(NODE_NAMESPACE),
        name: 'Node labels',
        kind: 'folder',
        hasChildren: true,
      },
      {
        id: nodeId.group(REL_NAMESPACE),
        name: 'Relationship types',
        kind: 'folder',
        hasChildren: true,
      },
    ]
  }

  /**
   * Describe one label or relationship type.
   *
   * `rowCountEstimate` is exact and free: `count()` over a whole label or type is
   * answered from Neo4j's count store rather than by touching the entities, which
   * is why it is affordable here and why the tree does **not** do it — the tree
   * would pay one round trip per token before the user has expressed interest in
   * any of them.
   */
  async describeCollection(ref: CollectionRef): Promise<CollectionSchemaInfo> {
    this.assertOpen()
    const target = requireNeo4jCollection(ref)
    const known = target.namespace === NODE_NAMESPACE
      ? await this.labelNames()
      : await this.relTypeNames()
    if (!known.includes(target.name)) {
      throw peekErrorMsg('NOT_FOUND', 'error.collection.notFound', { name: target.name })
    }
    const count = await this.countOf(target)
    return {
      ref: target.ref,
      columns: scanColumns(target),
      primaryKey: [ELEMENT_ID_COLUMN],
      browse: await this.browseStyleOf(target),
      ...(count === undefined ? {} : { rowCountEstimate: count }),
    }
  }

  /** Manual refresh: drop the cached token stores (PLAN section 8) */
  invalidateIntrospectCache(): void {
    this.labels = null
    this.relTypes = null
    this.propertyKeys = null
  }

  private async labelNames(): Promise<string[]> {
    if (this.labels === null) {
      const rows = await this.runEager('CALL db.labels() YIELD label RETURN label ORDER BY label')
      this.labels = rows.map((r) => stringField(r, 'label'))
    }
    return this.labels
  }

  private async relTypeNames(): Promise<string[]> {
    if (this.relTypes === null) {
      const rows = await this.runEager(
        'CALL db.relationshipTypes() YIELD relationshipType'
          + ' RETURN relationshipType ORDER BY relationshipType',
      )
      this.relTypes = rows.map((r) => stringField(r, 'relationshipType'))
    }
    return this.relTypes
  }

  /**
   * Every property key in the database, which is what an ORDER BY may name.
   *
   * Per-label property sets are not available cheaply — the procedure that
   * reports them samples the store — and the token store is a strict superset, so
   * this over-permits (a key that exists on some other label is accepted, and
   * ordering by it puts every row in the null group) and never under-permits. The
   * alternative, refusing every sort, would take the affordance away from the
   * labels where it works.
   */
  private async propertyKeyNames(): Promise<string[]> {
    if (this.propertyKeys === null) {
      const rows = await this.runEager(
        'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey',
      )
      this.propertyKeys = rows.map((r) => stringField(r, 'propertyKey'))
    }
    return this.propertyKeys
  }

  /** count() straight out of the count store; undefined when it does not fit a JS number */
  private async countOf(target: Neo4jCollection): Promise<number | undefined> {
    const token = quoteLabel(target.name)
    const text = target.namespace === NODE_NAMESPACE
      ? `MATCH (${NODE_COLUMN}:${token}) RETURN count(${NODE_COLUMN}) AS c`
      : `MATCH ()-[${REL_COLUMN}:${token}]->() RETURN count(${REL_COLUMN}) AS c`
    const rows = await this.runEager(text)
    const first = rows[0]
    if (first === undefined) return undefined
    const value = toCell(first.get('c'))
    return typeof value === 'number' ? value : undefined
  }

  /**
   * How one collection browses.
   *
   * The kind default already says a relation sorts and pages both ways, which
   * holds: `SKIP`/`LIMIT` address rows exactly as SQL's OFFSET/LIMIT do. What the
   * kind cannot say is **which columns** those affordances apply to, and here the
   * answer is neither "all" nor "none": ordering names a property (or the id),
   * filtering on a *result column* only ever means the id, because the other
   * column is a whole node.
   */
  private async browseStyleOf(target: Neo4jCollection): Promise<CollectionBrowseStyle> {
    return {
      ...collectionBrowseStyle(target.ref),
      sortableColumns: [ELEMENT_ID_COLUMN, ...(await this.propertyKeyNames())],
      filterableColumns: FILTERABLE_COLUMNS,
    }
  }

  /* ---------------------------------------------------------------- */
  /* tabularQuery — Cypher                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Run a Cypher statement.
   *
   * `req.params` is positional and becomes `$p1, $p2, …` — the convention
   * `graph.ts` composes against, so the plugin view's `autoFetch` lands here
   * unchanged.
   */
  async query(req: TabularQueryRequest): Promise<Cursor> {
    this.assertOpen()
    const text = req.text.trim()
    if (text.length === 0) throw peekErrorMsg('BAD_REQUEST', 'error.query.emptyText')
    return this.startCursor(req.resultId, text, req.params ?? [], {
      ...(clampInt(req.maxRows, 0, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { maxRows: clampInt(req.maxRows, 0, Number.MAX_SAFE_INTEGER) }),
      ...(clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) === undefined
        ? {}
        : { chunkRows: clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) }),
      ...(clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { timeoutMs: clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER) }),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  /* ---------------------------------------------------------------- */
  /* collectionScan — one label, or one relationship type              */
  /* ---------------------------------------------------------------- */

  /**
   * Browse a collection: `MATCH (n:Label) RETURN elementId(n), n SKIP … LIMIT …`,
   * and the relationship equivalent.
   *
   * Paging is by row offset, encoded in core's cursor envelope exactly as the
   * relational drivers do it — `SKIP` addresses rows, so there is no page
   * boundary to remember and no intra-page skip.
   *
   * `nativeFilter` is **refused**, not ignored. `CollectionScanRequest` requires
   * that of a driver which cannot honour one, and the reason applies with full
   * force here: a filter dropped on the floor returns more rows than the caller
   * asked for, and nothing in the result says so. Cypher's own escape hatch is
   * the whole statement, which `tabularQuery` already offers.
   */
  async scan(req: CollectionScanRequest): Promise<Cursor> {
    this.assertOpen()
    const target = requireNeo4jCollection(req.ref)
    if (req.nativeFilter !== undefined) {
      throw peekError(
        'BAD_REQUEST',
        'The neo4j driver has no native filter form; express the predicate as Cypher'
          + ' through a query instead',
      )
    }

    const columns = scanColumns(target)
    const style: CollectionBrowseStyle = {
      ...collectionBrowseStyle(target.ref),
      filterableColumns: FILTERABLE_COLUMNS,
    }
    assertFilterSupported(style, req.filter, columns.map((c) => c.name), { driverId: 'neo4j' })
    if (req.sort !== undefined && req.sort.length > 0) {
      // Only when there is a sort to check: the property-key list costs a round
      // trip the first time, and an unsorted browse has no use for it.
      assertBrowseSupported(await this.browseStyleOf(target), req, { driverId: 'neo4j' })
    }

    // cursorToken is core's ScanCursor: an absolute row offset as the boundary,
    // no intra-page skip. Decoding it in core is what makes a token minted by
    // another driver a BAD_REQUEST instead of a page of plausible-looking wrong
    // rows.
    const tokenOffset = req.cursorToken === undefined
      ? undefined
      : decodeRowOffsetCursor(req.cursorToken, 'neo4j')
    const offset = clampInt(tokenOffset ?? req.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0
    const limit = clampInt(req.limit ?? DEFAULT_PAGE_LIMIT, 0, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT

    const params = new CypherParams()
    const where = renderWhere(req.filter, target, params)
    const orderBy = renderOrderBy(req.sort, target)
    const v = target.variable
    const text = [
      matchClause(target),
      ...(where === undefined ? [] : [`WHERE ${where}`]),
      `RETURN elementId(${v}) AS ${quoteLabel(ELEMENT_ID_COLUMN)}, ${v}`,
      ...(orderBy === undefined ? [] : [`ORDER BY ${orderBy}`]),
      `SKIP ${params.bind(offset)} LIMIT ${params.bind(limit)}`,
    ].join('\n')

    // A full page usually means there is more, so hand back a cursor for the next
    const finish = (rows: number): Pick<ChunkDone, 'truncated' | 'nextCursor'> =>
      rows >= limit && limit > 0 ? { nextCursor: rowOffsetCursor('neo4j', offset + rows) } : {}

    return this.startCursor(req.resultId, text, params.list, {
      finish,
      columnHints: hintsFrom(columns),
      ...(clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) === undefined
        ? {}
        : { chunkRows: clampInt(req.chunkRows, 1, MAX_PAGE_LIMIT) }),
      ...(clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { timeoutMs: clampInt(req.timeoutMs, 1, Number.MAX_SAFE_INTEGER) }),
      ...(req.signal ? { signal: req.signal } : {}),
    })
  }

  private async startCursor(
    resultId: ResultId,
    text: string,
    params: readonly unknown[],
    opts: Omit<Neo4jCursorOptions, 'resultId' | 'openSession' | 'text' | 'params' | 'onClosed'>,
  ): Promise<Cursor> {
    if (this.active.has(resultId)) {
      throw peekErrorMsg('CONFLICT', 'error.query.alreadyRunning', { resultId })
    }
    const cursor = new Neo4jCursor({
      ...opts,
      resultId,
      text,
      params,
      openSession: () => this.openBolt(),
      onClosed: (): void => {
        this.active.delete(resultId)
      },
    })
    this.active.set(resultId, cursor)
    try {
      await cursor.open()
    } catch (err) {
      this.active.delete(resultId)
      throw err
    }
    return cursor
  }

  /* ---------------------------------------------------------------- */
  /* valuePeek                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Fetch one cell of one row in full, addressed by `elementId` rather than by
   * position.
   *
   * **`resultCell` is refused, and that is the whole reason this driver uses
   * `relationCell`.** A `resultCell` ref says "row 4,197 of that result set",
   * which the postgres driver can honour by re-running its statement with an
   * OFFSET. There is no such wrapper for an arbitrary Cypher statement — `SKIP`
   * cannot be bolted onto a `CALL … YIELD` or a multi-part query — so re-running
   * would mean re-reading the whole result to reach one row. An `elementId` is
   * stable, addresses the entity directly through an index seek, and keeps
   * working after the result set has been evicted, which is what
   * `ValueRef.relationCell` promises.
   *
   * `column` is read the way the scan's projection defines it: the entity column
   * ('n' / 'r') is the whole node or relationship, `elementId` is the id itself,
   * and anything else is a property of it.
   */
  async peekValue(ref: ValueRef, range?: ByteRange): Promise<PeekedValue> {
    this.assertOpen()
    if (ref.kind !== 'relationCell') {
      throw peekError(
        'BAD_REQUEST',
        `The Neo4j driver addresses a value by elementId, not by ${ref.kind};`
          + ' use a relationCell ref whose pk carries elementId',
      )
    }
    const target = requireNeo4jCollection(ref.collection)
    const elementId = ref.pk[ELEMENT_ID_COLUMN]
    if (typeof elementId !== 'string' || elementId === '') {
      throw peekErrorMsg('BAD_REQUEST', 'error.value.primaryKeyRequired')
    }

    const v = target.variable
    const text = target.namespace === NODE_NAMESPACE
      ? `MATCH (${v}) WHERE elementId(${v}) = $p1 RETURN ${v}`
      : `MATCH ()-[${v}]->() WHERE elementId(${v}) = $p1 RETURN ${v}`
    const rows = await this.runEager(text, boltParams([elementId]))
    const first = rows[0]
    if (first === undefined) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')

    const entity = toCell(first.get(v))
    const value = extractPeekValue(entity, ref.column, target)
    if (value === undefined) throw peekErrorMsg('NOT_FOUND', 'error.value.gone')

    const isText = typeof value === 'string'
    const text2 = isText ? value : (safeJson(value, 2) ?? String(value))
    const full = Buffer.from(text2, 'utf8')
    const offset = Math.max(0, Math.trunc(range?.offset ?? 0))
    const wanted = range?.length === undefined ? VALUE_PEEK_MAX_BYTES : Math.trunc(range.length)
    const length = Math.min(VALUE_PEEK_MAX_BYTES, Math.max(0, wanted))
    const slice = full.subarray(
      Math.min(offset, full.byteLength),
      Math.min(offset + length, full.byteLength),
    )

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

  /* ---------------------------------------------------------------- */
  /* cancel                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Real cancellation: closing the cursor's Bolt session sends RESET, and the
   * server terminates the query it is running rather than finishing it into a
   * socket nobody is reading.
   *
   * No side-channel connection is needed, unlike postgres — RESET travels on the
   * *same* connection as the running statement, because Bolt handles it out of
   * band. The pool being exhausted by other cursors therefore cannot stop a
   * cancel, which is the failure mode the postgres driver spends an extra
   * handshake to avoid.
   *
   * Bounded, because an acknowledgement that never arrives must not eat the whole
   * cancelMs budget the layer above allows before it kills the driver process.
   * Returns false, without throwing, when nothing is running — the contract
   * requires that.
   */
  async cancel(resultId: ResultId): Promise<boolean> {
    const cursor = this.active.get(resultId)
    if (!cursor || cursor.isClosed) return false
    // Before the await: the in-flight next() has to fail as CANCELLED rather than
    // as whatever the terminated transaction happens to report.
    cursor.markCancelled()
    await withBudget(cursor.close(), CANCEL_BUDGET_MS)
    return true
  }
}

/* ------------------------------------------------------------------ */
/* Connect helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * `url` wins; host/port are the single-instance fallback.
 *
 * The fallback spells `bolt://` and not `neo4j://` on purpose: the two are
 * different routing decisions rather than two spellings of one address (see
 * `Neo4jConnectionConfigSchema`), and a host and a port carry no evidence about
 * which was meant. `bolt://` is the one that talks to exactly the server that was
 * named.
 */
function boltUrl(cfg: Neo4jConnectionConfig): string {
  if (cfg.url !== undefined && cfg.url !== '') return cfg.url
  return `bolt://${cfg.host ?? DEFAULT_HOST}:${String(cfg.port ?? DEFAULT_PORT)}`
}

/**
 * No user means no auth token, which is not the same as an empty one: a server
 * with authentication disabled rejects `basic('', '')` and accepts the absence.
 */
function authOf(cfg: Neo4jConnectionConfig): ReturnType<typeof neo4j.auth.basic> | undefined {
  if (cfg.user === undefined || cfg.user === '') return undefined
  return neo4j.auth.basic(cfg.user, cfg.password ?? '')
}

/**
 * `RETURN 1` against the configured database, for its summary rather than its row.
 *
 * `summary.database.name` is the server's own answer to "which database did that
 * run in", which is the only way to learn the home database's name when the
 * config named none.
 */
async function probeDatabase(
  driver: BoltDriver,
  database: string | undefined,
): Promise<string | undefined> {
  const bolt = driver.session({
    defaultAccessMode: neo4j.session.READ,
    ...(database === undefined ? {} : { database }),
  })
  try {
    const res = await bolt.run('RETURN 1 AS ok')
    return res.summary.database.name ?? database
  } finally {
    await bolt.close().catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

/** The declared columns, as the hints the cursor applies over its guess */
function hintsFrom(columns: readonly ColumnDef[]): ReadonlyMap<string, Neo4jColumnHint> {
  const hints = new Map<string, Neo4jColumnHint>()
  for (const def of columns) {
    hints.set(def.name, {
      logical: def.logical,
      nativeType: def.nativeType,
      ...(def.primaryKey === true ? { primaryKey: true } : {}),
      ...(def.peekable === true ? { peekable: true } : {}),
    })
  }
  return hints
}

/** Pull the addressed cell out of a converted entity; undefined means "not there" */
function extractPeekValue(entity: unknown, column: string, target: Neo4jCollection): unknown {
  if (typeof entity !== 'object' || entity === null) return undefined
  const bag = entity as Record<string, unknown>
  if (column === target.variable) return entity
  if (column === ELEMENT_ID_COLUMN) return bag['id']
  const properties = bag['properties']
  if (typeof properties !== 'object' || properties === null) return undefined
  return (properties as Record<string, unknown>)[column]
}
