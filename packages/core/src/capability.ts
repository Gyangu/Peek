import { z } from 'zod'
import type { ChunkFrame, ColumnDef, TruncatedValue } from './chunk'
import { peekError, type PeekError } from './errors'
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

/**
 * The class an id has to belong to before peek will serve it.
 *
 * One pattern for what turns out to be one thing seen from three sides: a
 * **package** id is a directory name under `~/.peek/packages/` and the host of a
 * `peek-package://` URL; a **driver** id is what a connection persists, what a
 * scan cursor is prefixed with, and what a `Record` in main is keyed by. All
 * three are written by whoever wrote the package, so all three are checked
 * rather than trusted.
 *
 * A dot is refused along with the separators. It costs dotted ids
 * (`com.example.thing`) and buys not having to reason about whether `..`
 * survives URL host parsing on every platform — worth it while the ids are
 * still ours to choose.
 *
 * `main/packages/assets.ts` applies it to a URL host and `cursor.ts` admits
 * exactly this class inside a cursor token; both say so where they do it, so a
 * widening here has two places to follow it to.
 */
export const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * The databases this build ships in-repo.
 *
 * **No longer the type of a driver id, and no longer the answer to "which
 * drivers exist".** It was a `z.enum`, which made a driver from outside the
 * repository unrepresentable — the exact property a package read off disk has
 * to be allowed to break (design 2026-08-07 §2.6). What can answer that question
 * is the registry the app assembles from the manifests it collected
 * (`manifestDriverIds()` in `apps/desktop/src/drivers/manifests.ts`); ask it, not
 * this list.
 *
 * What is left is a statement about *this* build: these six packages live in
 * `packages/` and are compiled in. It survives because the tests that pin the
 * migration need something outside the registry to compare it against — a
 * registry checked against itself proves nothing — and it goes away when the six
 * move to `~/.peek/packages/` and stop being a fact about the source tree.
 */
export const DRIVER_IDS = ['postgres', 'mysql', 'sqlite', 'redis', 'qdrant', 'neo4j'] as const

/**
 * Which driver a connection speaks to.
 *
 * A **string with a shape**, not an enum over the six above: `PACKAGE_ID_PATTERN`
 * is the whole of what core can say about an id, because whether a driver
 * actually exists is a question about a directory that core cannot see. The
 * caller answers it by asking the registry, and a miss there is an ordinary
 * value it turns into a structured error — see `lookupManifest`.
 *
 * The cost is stated once here rather than rediscovered: `Record<DriverId, …>`
 * used to be *total over six*, so a table missing a driver failed to compile.
 * It is `Record<string, …>` now and that check is gone. Its replacement is
 * `driver-registry.test.ts`, which reads the tables' keys back and compares them
 * against the manifests — the same trade the design records for every guarantee
 * that opening the union costs.
 */
export const DriverIdSchema = z
  .string()
  .regex(PACKAGE_ID_PATTERN, 'must be lowercase letters, digits and hyphens, starting with one of those')
export type DriverId = z.infer<typeof DriverIdSchema>

/**
 * There is deliberately **no `DRIVER_CAPABILITIES` table here.**
 *
 * There was one, and it pointed the wrong way. PLAN §4 says each driver declares
 * its own capability set — but the table lived in core and
 * all five packages imported it back as the source of truth for what *they* could
 * do (`new Set(DRIVER_CAPABILITIES.postgres)`). The loop was self-consistent and
 * its contract tests passed, because both halves read the same cell; it just had
 * core describing packages that core cannot see.
 *
 * The declaration now lives in each package's `manifest.ts`
 * (`DriverManifest.capabilities`, see `./manifest`), which is also what its
 * `Driver` and `DriverSession` read, so advertised and implemented cannot drift.
 * The pre-connection prediction the UI and the MCP tools need is assembled from
 * those manifests by the app — `apps/desktop/src/drivers/manifests.ts` — because
 * a driver package depends on core and core importing one back would be a cycle.
 *
 * Once connected, `DriverSession.capabilities` wins regardless: it may be
 * narrower, e.g. on an older PostgreSQL server.
 */

/* ================================================================== */
/* 2. ConnectionConfig: an open record, checked against the manifest   */
/* ================================================================== */

const baseConn = {
  /** User-visible connection name; when absent main derives one from host/database */
  label: z.string().optional(),
} as const

/**
 * What every connection config has, whatever database it names.
 *
 * **Open, and that is the point.** This was a `z.discriminatedUnion` over six
 * `driverId` literals; a config for a database peek did not compile in was
 * unrepresentable, which is precisely what a package installed at runtime has to
 * be able to be. What is left is the part the *kernel* owns — which driver, and
 * what the user called it. Everything below that belongs to the package.
 *
 * **Unknown keys survive.** They have to: a config is almost entirely its
 * driver's own fields (`host`, `file`, `apiKey`), and this schema has never
 * heard of any of them. Which is the same sentence read as a warning — parsing
 * through this alone says *this is shaped like a config*, not *this config is
 * one its driver could use*. The second half is `connectionConfigSchema` in
 * `./manifest`, built from the fields the package declared, and it runs wherever
 * a manifest is in reach: the connect dialog before a command is sent, and
 * `parseConnectionConfig` in the app's registry for everything main reads back
 * off disk or off the wire.
 *
 * The driver id is still checked, because `PACKAGE_ID_PATTERN` is checkable
 * without a registry — a `driverId` of `../../etc` is refused here rather than
 * at whichever path first turns one into a directory name.
 */
export const ConnectionConfigSchema = z.looseObject({
  driverId: DriverIdSchema,
  ...baseConn,
})

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>

/* ------------------------------------------------------------------ */
/* The six in-repo config shapes                                       */
/* ------------------------------------------------------------------ */

/**
 * **Transitional, and only a type.** These six were the branches of
 * `ConnectionConfigSchema`. Nothing parses through them any more — a config is
 * parsed by the open schema above and then measured against its package's
 * declared fields — and they survive for one reason: each in-repo package
 * declares its `DriverDisplay` over its own branch (`DriverDisplay<PostgresConnectionConfig>`),
 * which is what lets it read `config.host` without re-narrowing a union by hand.
 *
 * They leave with the packages. When the six move to `~/.peek/packages/` their
 * displays are compiled against a config they describe themselves, and a config
 * shape written in core for a database core cannot see is the thing this whole
 * change exists to delete.
 *
 * Do not add a seventh. A new database declares its fields in its manifest,
 * where they are the schema (`connectionFieldsOf`), not here.
 */
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

/**
 * Neo4j speaks Bolt, and the URL is where the *routing* decision lives:
 * `bolt://` pins one server, `neo4j://` asks the cluster's routing table where to
 * go. They are not interchangeable spellings of one address, so the URL is
 * offered verbatim rather than assembled from a host and a port with a scheme
 * picked for the user.
 */
export const Neo4jConnectionConfigSchema = z.object({
  driverId: z.literal('neo4j'),
  ...baseConn,
  /** bolt:// | neo4j:// (+s / +ssc for TLS). When given it wins over host/port. */
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().max(65535).optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  /**
   * Which database to open. Neo4j is multi-database from 4.0, and unlike
   * PostgreSQL the connection is *not* pinned to one — absent means the server's
   * configured home database (`neo4j` out of the box).
   */
  database: z.string().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
})

/**
 * Is this config the one `driverId`'s package declared?
 *
 * **The narrowing the config union used to hand out for free**, and the reason
 * it is a function now: `cfg.driverId !== 'postgres'` narrowed a discriminated
 * union down to one branch, and an open record has no branches to narrow to.
 * Every in-repo driver has one `requireXConfig` funnel that did exactly this,
 * so the six of them share this rather than each writing the predicate again.
 *
 * **It asserts more than it checks, exactly as the union did.** Answering true
 * says the whole shape is right, and all that was measured is the id. The claim
 * is backed one layer up rather than here: a config reaches a driver only after
 * `parseConnectionConfig` measured it against the fields that driver's manifest
 * declares (`conn.open`), which is the gate the `z.discriminatedUnion` used to
 * be. Calling this on a config that did not come through there is calling it on
 * a promise nobody made.
 *
 * Transitional, and it leaves with the six schemas above: a package that owns
 * its own config shape narrows with its own parse and needs nothing from core.
 */
export function isDriverConfig<C extends ConnectionConfig>(
  config: ConnectionConfig,
  driverId: DriverId,
): config is C {
  return config.driverId === driverId
}

export type PostgresConnectionConfig = z.infer<typeof PostgresConnectionConfigSchema>
export type MysqlConnectionConfig = z.infer<typeof MysqlConnectionConfigSchema>
export type SqliteConnectionConfig = z.infer<typeof SqliteConnectionConfigSchema>
export type RedisConnectionConfig = z.infer<typeof RedisConnectionConfigSchema>
export type QdrantConnectionConfig = z.infer<typeof QdrantConnectionConfigSchema>
export type Neo4jConnectionConfig = z.infer<typeof Neo4jConnectionConfigSchema>

/** Password placeholder. Any config that crosses the main-process boundary must be redacted first. */
export const REDACTED = '***'

/**
 * Redaction: every config shown to MCP or the renderer goes through here.
 * Passwords embedded in a connection URL are replaced as well.
 */
export function redactUrlCredentials(url: string): string {
  return url.replace(/(:\/\/[^:/@]*):[^@]*@/, `$1:${REDACTED}@`)
}

/**
 * What scrubbing one field means.
 *
 *   'value'         the whole value is replaced by `REDACTED` — a password, an
 *                   API key, anything that is a secret in its entirety;
 *   'url-password'  only the password inside the URL's userinfo goes, so the
 *                   scheme, the user and the address survive and the string is
 *                   still recognisable as the connection it came from.
 */
export const REDACT_RULES = ['value', 'url-password'] as const
export const RedactRuleSchema = z.enum(REDACT_RULES)
export type RedactRule = z.infer<typeof RedactRuleSchema>

/** Field name → how to scrub it. This is `DriverManifest.redact`, verbatim. */
export type RedactRules = Readonly<Record<string, RedactRule>>

/**
 * Redact a config against the rules its driver declared.
 *
 * This used to be a `switch` over `driverId` with one branch per built-in
 * database. The branches were all the same two moves — blank a secret field,
 * strip the password out of a URL — so the switch was really a table written as
 * control flow, and a database peek did not compile in could not appear in it at
 * all. The table is now the package's own `redact` block and this function is the
 * one place it is applied.
 *
 * **No rules means the config is returned untouched, plaintext password and
 * all.** That is a deliberate decision (plugin-architecture's decision 5,
 * restated in `docs/design/2026-08-07-database-packages-from-disk.md` §2.3d) and
 * not an oversight to tighten here: peek does not validate packages, so a
 * defensive default would be security theatre over a package that can read the
 * config anyway. The consequence is concrete and worth stating where someone
 * calling this will see it — a driver package that omits `redact` puts its
 * connection's password verbatim into MCP receipts, into the renderer's
 * snapshot, and into the agent transcript. The loader is what warns about it;
 * this function does not, because it cannot tell "declared nothing" from
 * "declared nothing that matched".
 */
export function redactConnectionConfig(cfg: ConnectionConfig, rules: RedactRules): ConnectionConfig {
  const fields: Readonly<Record<string, unknown>> = cfg
  const patch: Record<string, string> = {}
  for (const [name, rule] of Object.entries(rules)) {
    const value = fields[name]
    // An absent field is left absent rather than filled with `REDACTED`: the
    // presence of a key is itself information the reader uses (`url` set means
    // the URL wins over host/port), and inventing one would change the config's
    // meaning, not just hide it.
    if (typeof value !== 'string') continue
    patch[name] = rule === 'value' ? REDACTED : redactUrlCredentials(value)
  }
  return { ...cfg, ...patch }
}

/* ------------------------------------------------------------------ */
/* Address-formatting helpers, shared by whoever draws a connection    */
/* ------------------------------------------------------------------ */

/**
 * There is deliberately **no `defaultConnectionLabel` / `connectionDetail`
 * here.**
 *
 * Both were a `switch` over `driverId`, and both were the reason core had to
 * know how six particular databases spell an address. They are now
 * `DriverDisplay.label` / `DriverDisplay.detail` (see `./manifest`), written by
 * the package that owns the database, run in the package host, and computed once
 * when a connection opens — a config never changes after that, so the strings do
 * not either. Everything downstream reads a stored string.
 *
 * What stays here is the vocabulary those functions were built out of, exported
 * rather than private because the packages are now the callers: a package that
 * had to re-derive "host, plus a port when there is one" would derive it
 * slightly differently, and six slightly different addresses for one connection
 * is exactly what having one label was for.
 */

export function hostPort(host: string | undefined, port: number | undefined): string | undefined {
  if (host === undefined || host === '') return undefined
  return port === undefined ? host : `${host}:${port}`
}

/** The last path segment. Kept string-only so core stays free of `node:path`. */
export function baseName(file: string): string {
  const cut = file.replace(/[/\\]+$/, '')
  const at = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'))
  return at === -1 ? cut : (cut.slice(at + 1) || cut)
}

/**
 * Host, port and database pulled out of a connection string.
 *
 * `postgresql:` and `redis:` are not special schemes to the URL parser, but it
 * still parses their authority, which is all this needs. A string it refuses is
 * not an error worth reporting here — the caller falls back to another field,
 * and the driver is the one that gets to reject a bad URL.
 */
export function urlParts(url: string | undefined): { host?: string; port?: number; database?: string } | undefined {
  if (url === undefined || url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const database = parsed.pathname.replace(/^\//, '')
  const port = parsed.port === '' ? undefined : Number(parsed.port)
  return {
    ...(parsed.hostname === '' ? {} : { host: parsed.hostname }),
    ...(port === undefined ? {} : { port }),
    ...(database === '' ? {} : { database }),
  }
}

/* ================================================================== */
/* 2b. Connection identity                                             */
/* ================================================================== */

/**
 * Drop the password from a URL, keeping the user.
 *
 * Deliberately not `redactUrlCredentials`, which substitutes `***`: this result
 * is a config that will be *used*, and `***` is a password a driver would
 * send. The pattern is the same one redaction uses, so the two agree on what
 * counts as credentials in a URL.
 */
export function stripUrlPassword(url: string): string {
  return url.replace(/(:\/\/[^:/@]*):[^@]*@/, '$1@')
}

/**
 * The fields that name a server and an account.
 *
 * Two connections with the same identity are the same connection: it is what the
 * connection book keys an entry by, and what the sidebar uses to decide that a
 * saved entry and a live connection are one row rather than two.
 *
 * A URL is reduced to its password-free form for three reasons: the password
 * inside a URL never reaches the hash input; the config that comes *back* out of
 * the book — which has no password by construction — still hashes to the entry it
 * came from; and a **redacted** config (`://user:***@host`) reduces to the same
 * string as a **stripped** one (`://user@host`), which is what lets the renderer
 * compute an identity that agrees with main's. Normalizing every side through the
 * same function is what makes those three agree.
 *
 * ## Why the *joining* stayed in core when the display strings left
 *
 * `fields` is the package's `DriverManifest.identity` — a list of names, and
 * nothing more. The package cannot supply the answer itself, and this is a
 * security requirement rather than a matter of taste: identity is what a stored
 * credential is released against (`config/connection-book.ts`), so a package
 * that computed it could make its own connection collide with another one and
 * read that connection's password back out of the keychain. Declaring *which*
 * fields matter is harmless; deciding *whether two connections are the same* is
 * not, and stays here.
 *
 * The two rules the kernel keeps for itself, and a package cannot switch off:
 * `driverId` leads, and a `url` field is stripped of its password first.
 */
export function connectionIdentity(config: ConnectionConfig, fields: readonly string[]): string {
  const values: Readonly<Record<string, unknown>> = config
  const parts: string[] = [config.driverId]
  for (const name of fields) {
    const value = values[name]
    // Absent reads as empty rather than being skipped: dropping it would shift
    // every later field one slot left, and `host=a, port=undefined` would then
    // produce the identity of `host=undefined, port=a`.
    if (value === undefined) {
      parts.push('')
      continue
    }
    const text = typeof value === 'string' ? value : String(value)
    parts.push(name === 'url' ? stripUrlPassword(text) : text)
  }
  return parts.join(SEP)
}

/**
 * Field separator inside an identity. A NUL rather than a space, because a
 * separator that can appear *inside* a field is a separator a field can forge:
 * a host literally named `a b` would otherwise produce the same identity as a
 * host `a` on a database `b`, and identity is what a stored credential is
 * released against. No field here can contain a NUL.
 *
 * Written as an escape and not as the byte itself so it is visible in a diff.
 */
const SEP = '\0'

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
 * **And a per-*collection* answer, which the kind cannot give.** "Sortable" is
 * not a property of being a vector collection: qdrant's `order_by` only works on
 * a payload key that has an index, so within the one kind, one collection is
 * orderable by `created_at` and the next by nothing at all. The kind table is the
 * default; `CollectionSchemaInfo.browse` is where a driver says otherwise for a
 * particular collection, and `resolveCollectionBrowseStyle` is how the two are
 * combined. A driver that has nothing to add simply omits it.
 *
 * **How far the refinement currently reaches — read this before trusting it.**
 * The refinement is *enforced*: `assertBrowseSupported` and
 * `assertFilterSupported` normalize whatever style they are handed
 * (`effectivelySortable` below), so an unorderable collection is refused
 * identically whether the caller resolved the declaration first or passed it raw.
 * It is **not yet advertised**: obtaining it costs a `describeCollection` round
 * trip, so `ViewSummary.browse` (and through it the renderer's column headers and
 * MCP's `browseAffordances`) still carries the kind-level answer alone. The
 * consequence is real and worth stating rather than discovering: on a qdrant
 * collection with no payload index the UI still draws a sortable header, and the
 * click is refused. Closing that means routing `describeCollection`'s `browse`
 * through main's cache into `ViewSummary` — see the issue notes; it is not
 * something this file can do on its own.
 */
export interface CollectionBrowseStyle {
  /** Column headers may offer ordering (the driver honours SortSpec) */
  sortable: boolean
  /** `offset` addresses a page cheaply; when false, paging must go through cursorToken */
  offsetPaging: boolean
  /** `ChunkDone.nextCursor` is how the next page is reached */
  cursorPaging: boolean
  /**
   * The columns that may be ordered, when only some may be.
   *
   * `undefined` means "any column, as long as `sortable`" — the relational
   * answer. An explicit list means exactly those and no others: qdrant fills it
   * with the indexed payload keys, because ordering by an unindexed key is a
   * server-side 400 and there is no reason to let the user discover that by
   * clicking. An **empty** list therefore reads the same as `sortable: false`,
   * and both `resolveCollectionBrowseStyle` and `assertBrowseSupported` normalize
   * it to exactly that — see `effectivelySortable`, which is the one place that
   * equivalence is written down.
   */
  sortableColumns?: readonly string[]
  /**
   * Ordering and continuing are mutually exclusive: an ordered browse is one
   * page, with no `nextCursor` to follow.
   *
   * True for qdrant, where `order_by` and a start offset cannot be combined.
   * The UI needs this *before* it draws a next-page button next to an active
   * sort, and the driver needs it to refuse the combination consistently.
   */
  sortEndsPaging?: boolean
  /**
   * The result columns a filter may be attached to, when only some may be.
   *
   * `undefined` means "any column that exists" — the relational answer, where a
   * predicate on a column is always expressible. An explicit list is what a
   * schemaless store has to give: qdrant's default projection is `id` plus one
   * opaque json `payload` column, and there is no predicate over the blob as a
   * whole, so **no result column is filterable** until the caller projects a
   * payload key into a column of its own. An empty list says exactly that, and it
   * is the reason a column header on a vector view must not offer a filter.
   *
   * A filter that names a *stored field* rather than a result column is out of
   * scope for this list — see `FilterTarget`.
   */
  filterableColumns?: readonly string[]
}

const BROWSE_STYLE: Readonly<Record<CollectionRef['kind'], CollectionBrowseStyle>> = {
  // A relation is the one collection where SQL gives both for free.
  relation: { sortable: true, offsetPaging: true, cursorPaging: true },
  // SCAN yields whole pages in cursor order. Sorting one page describes nothing,
  // and an offset is re-scanning everything before it.
  keyPattern: { sortable: false, offsetPaging: false, cursorPaging: true },
  // scroll pages by point id; `order_by` and an offset are mutually exclusive
  // server-side, so ordering here means "one page, no continuation".
  vectorCollection: {
    sortable: true,
    offsetPaging: false,
    cursorPaging: true,
    sortEndsPaging: true,
  },
}

/**
 * The kind-level default. Unchanged signature on purpose: every caller that only
 * has a `CollectionRef` — which is most of them, since a ref is what a view state
 * carries — keeps working, and gets the answer that is right for the kind.
 */
export function collectionBrowseStyle(ref: CollectionRef): CollectionBrowseStyle {
  return BROWSE_STYLE[ref.kind]
}

/**
 * "Sortable" as the two fields *together* mean it.
 *
 * `sortable: true` alongside an **empty** `sortableColumns` says "ordering is
 * something this kind does, and this collection can be ordered by nothing at
 * all" — which is `sortable: false` with extra steps. It is the shape qdrant
 * naturally produces (`browseStyleOf` fills the list from the payload indexes,
 * and a collection may have none), so it is not a hypothetical.
 *
 * This lives in its own function because two places have to agree about it, and
 * for a while they did not: `resolveCollectionBrowseStyle` folded the empty list
 * into `sortable: false`, while `assertBrowseSupported` — which is what a driver
 * actually calls, usually with the raw declaration rather than the resolved one —
 * read `sortable` on its own, sailed past the first check, and refused on the
 * second with `this collection can only be ordered by ` and nothing after the
 * "by". Same input, two answers, and the useless message was the visible half.
 * Now both read this.
 */
function effectivelySortable(style: CollectionBrowseStyle): boolean {
  const columns = style.sortableColumns
  return style.sortable && (columns === undefined || columns.length > 0)
}

/**
 * The kind default, refined by whatever the driver declared for this particular
 * collection (`CollectionSchemaInfo.browse`).
 *
 * A declaration may only *narrow*: a driver cannot promise ordering for a kind
 * that has none, because the rest of the system — the pager, the cursor
 * bookkeeping in `handlers/view.ts` — is written against the kind. What it can do
 * is say "not this one", which is the case the kind table structurally cannot
 * express.
 *
 * **Who calls this.** Anyone holding both halves — a `CollectionSchemaInfo` and
 * its ref — and wanting the single value they add up to: today that is
 * `describeCollection`'s callers and the driver tests. A driver enforcing a scan
 * does *not* have to call it first; `assertBrowseSupported` normalizes on its own
 * (see `effectivelySortable`), so passing the raw declaration cannot produce a
 * different verdict from passing the resolved one.
 */
export function resolveCollectionBrowseStyle(
  ref: CollectionRef,
  declared?: CollectionBrowseStyle,
): CollectionBrowseStyle {
  const base = collectionBrowseStyle(ref)
  if (declared === undefined) return base
  const columns = declared.sortableColumns
  const sortable = base.sortable && effectivelySortable(declared)
  const filterable = declared.filterableColumns ?? base.filterableColumns
  return {
    sortable,
    offsetPaging: base.offsetPaging && declared.offsetPaging,
    cursorPaging: base.cursorPaging && declared.cursorPaging,
    ...(columns === undefined || !sortable ? {} : { sortableColumns: columns }),
    ...(base.sortEndsPaging === true || declared.sortEndsPaging === true
      ? { sortEndsPaging: true }
      : {}),
    ...(filterable === undefined ? {} : { filterableColumns: filterable }),
  }
}

/** The part of a scan request that the browse style has an opinion about */
export interface BrowseRequestShape {
  sort?: readonly SortSpec[]
  offset?: number
  cursorToken?: string
}

/**
 * Refuse a scan the browse style says cannot be honoured — **once, for every
 * driver**.
 *
 * Before this, each driver hand-wrote its own rejection at its own point in its
 * own `scan()`: redis raised one sentence about SCAN ordering, qdrant another
 * about `order_by`, and postgres raised nothing because it has nothing to refuse.
 * Three prose strings for one rule, and no way for the UI to predict any of them
 * — the only way to learn that a keyspace could not be sorted was to sort it.
 *
 * Now every driver refuses from one table, in one wording, and the UI consults
 * that same table (`collectionBrowseStyle`) before drawing a sortable header.
 * **What the two share is the kind-level answer, and only that**: the
 * per-collection refinement a driver declares in `CollectionSchemaInfo.browse`
 * costs a `describeCollection` round trip and does not reach `ViewSummary`.
 * Where that grain matters the UI resolves it by withdrawing the control rather
 * than by guessing — `browseControls.ts` answers `sortable: false` for a vector
 * collection, because the columns a qdrant table view draws (`id`, `payload`)
 * are refused here on every collection, indexed or not. So no header reaches
 * this function to be refused today; MCP callers still can, and are the reason
 * the wording is English.
 *
 * What this function *does* guarantee is that the refinement is read the same way
 * everywhere it is read at all: it normalizes through `effectivelySortable`, so a
 * driver handing over the raw declaration (which qdrant's `scan` does) gets the
 * identical verdict, and the identical sentence, as one that resolved it first.
 *
 * The text is English on purpose: `BAD_REQUEST` here means the *caller* built an
 * impossible request, and the caller is either peek's own UI (a bug, for a
 * developer to read) or an MCP client (whose surface is English forever).
 */
export function assertBrowseSupported(
  style: CollectionBrowseStyle,
  req: BrowseRequestShape,
  ctx: { driverId: DriverId },
): void {
  const sort = req.sort ?? []
  if (sort.length === 0) return

  // Not `style.sortable`: an empty sortableColumns is "orderable by nothing",
  // which belongs in this branch and not in the one that lists the alternatives.
  if (!effectivelySortable(style)) {
    throw peekError(
      'BAD_REQUEST',
      `The ${ctx.driverId} driver cannot order this collection; drop the sort,`
      + ' or order the loaded page in the client',
    )
  }
  const allowed = style.sortableColumns
  if (allowed !== undefined) {
    const rejected = sort.map((s) => s.column).filter((c) => !allowed.includes(c))
    if (rejected.length > 0) {
      throw peekError(
        'BAD_REQUEST',
        `Cannot order by ${rejected.join(', ')}: this collection can only be ordered by`
        + ` ${allowed.join(', ')}`,
      )
    }
  }
  if (style.sortEndsPaging === true && (req.cursorToken !== undefined || (req.offset ?? 0) > 0)) {
    throw peekError(
      'BAD_REQUEST',
      `An ordered ${ctx.driverId} browse is a single page and cannot be combined with paging;`
      + ' drop the sort, or drop the offset and cursorToken',
    )
  }
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

/**
 * What a `FilterSpec.column` names.
 *
 * The distinction only exists because a schemaless store forces it. In a
 * relation the two readings coincide: `WHERE name = 'x'` works whether or not
 * `name` was selected, and the column header the user clicked is the column the
 * predicate lands on. In qdrant they come apart completely — `FilterSpec.column`
 * has always meant a **payload key**, and the default result schema is `id` plus
 * one opaque json `payload` column, so the key being filtered on is not among the
 * result columns at all. "Click a column header to filter" therefore had nothing
 * to attach to, and the type could not say why.
 *
 *   'column'  a column of the result set, exactly as frame 0 declares it. This is
 *             what a header click produces, and it is checkable: a name that is
 *             not in the schema is a BAD_REQUEST rather than a silent miss.
 *   'field'   a stored field underneath, whether or not the projection surfaced
 *             it. This is what an MCP caller who knows the database writes.
 *
 * Omitted means "resolve it": the name is a column when the result schema has
 * one by that name, and a field otherwise. That keeps every existing caller
 * working and still lets a caller who cares be explicit.
 */
export const FILTER_TARGETS = ['column', 'field'] as const
export const FilterTargetSchema = z.enum(FILTER_TARGETS)
export type FilterTarget = z.infer<typeof FilterTargetSchema>

export const FilterSpecSchema = z.object({
  column: z.string().min(1),
  op: FilterOpSchema,
  /** isNull / isNotNull take no value; `in` takes an array */
  value: z.unknown().optional(),
  /** Whether `column` names a result column or a stored field; see FilterTarget */
  target: FilterTargetSchema.optional(),
})
export type FilterSpec = z.infer<typeof FilterSpecSchema>

/**
 * Resolve what one filter names, given the result columns it will run against.
 *
 * `resultColumns` is the frame-0 schema (or the projection about to become it),
 * which is the only thing that can answer the question.
 */
export function filterTarget(
  spec: FilterSpec,
  resultColumns: readonly string[],
): FilterTarget {
  if (spec.target !== undefined) return spec.target
  return resultColumns.includes(spec.column) ? 'column' : 'field'
}

/**
 * Refuse a filter the result schema cannot support — the counterpart to
 * `assertBrowseSupported`, for the other half of the toolbar.
 *
 * Two checks:
 * 1. a filter that declares `target: 'column'` must name a column that exists.
 *    A header click cannot name anything else, so a miss here is a bug in peek,
 *    not a typo by the user;
 * 2. that column must be one the style says is filterable. qdrant's json
 *    `payload` column is the case this exists for: it is a column, it is on
 *    screen, and a predicate on the blob as a whole is not a thing qdrant can
 *    express — so the UI must not offer a filter control on that header, and the
 *    driver must not pretend to honour one.
 *
 * A `field` filter is not checked here: by definition it names something the
 * result schema does not show, and only the driver knows whether it exists.
 */
export function assertFilterSupported(
  style: CollectionBrowseStyle,
  filters: readonly FilterSpec[] | undefined,
  resultColumns: readonly string[],
  ctx: { driverId: DriverId },
): void {
  for (const spec of filters ?? []) {
    if (filterTarget(spec, resultColumns) !== 'column') continue
    if (!resultColumns.includes(spec.column)) {
      throw peekError(
        'BAD_REQUEST',
        `No column named ${spec.column} in this result; the columns are`
        + ` ${resultColumns.join(', ')}`,
      )
    }
    const filterable = style.filterableColumns
    if (filterable !== undefined && !filterable.includes(spec.column)) {
      throw peekError(
        'BAD_REQUEST',
        `The ${ctx.driverId} driver cannot filter on the ${spec.column} column;`
        + (filterable.length > 0
          ? ` filterable columns are ${filterable.join(', ')}`
          : ' project the underlying field into a column of its own first,'
            + ' or send the predicate with target: "field"'),
      )
    }
  }
}

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
 * What a node stands for when it stands for children the level left out.
 *
 * `listChildren` returns a bare array, so "is this the whole level?" has nowhere
 * to live in the return type. A driver that had to stop early — a bounded SCAN,
 * a paged catalog — says so by ending the level with a node carrying this, and
 * the UI words it. Silence still means "complete", which is the honest default
 * only for drivers that really do return the whole level.
 *
 * `remaining` is optional rather than a `counted | unknown` discriminator so
 * that having no honest number is an *absence* the caller cannot route around:
 * a level cut short mid-listing knows how much of its own sample it folded, but
 * not how much of the level, and a precise count over an imprecise sample is the
 * worst of both.
 */
export interface NamespaceElision {
  /** How many children were folded away, when the driver counted them all */
  remaining?: number
}

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
  /**
   * Set on a node that stands for children this level left out rather than for
   * anything in the store. Such a node carries no `ref` — there is no pattern
   * that means "what I did not list" — so nothing can be opened on it, and the
   * UI supplies its own localized wording; `name` and `detail` stay the driver's
   * English fallback, which MCP reads.
   */
  elision?: NamespaceElision
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
  /**
   * How **this** collection browses, when that differs from what its kind
   * implies. Omitted means the kind's answer stands.
   *
   * Read it through `resolveCollectionBrowseStyle(info.ref, info.browse)`, never
   * on its own: a declaration narrows the kind default and is not a replacement
   * for it.
   */
  browse?: CollectionBrowseStyle
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
 * Narrow an untrusted value to a shape.
 *
 * The process boundary needs this: `keyValueReadOptions` switches on `shape`, and
 * an unrecognised string would fall through to the "shape unknown" branch — which
 * is the guessing path, not a rejection. A parser that accepted any string would
 * therefore turn a typo into a silently different read.
 */
export function isKeyValueShape(value: unknown): value is KeyValueShape {
  return typeof value === 'string' && (KEY_VALUE_SHAPES as readonly string[]).includes(value)
}

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

/* ------------------------------------------------------------------ */
/* How a value's window is addressed                                   */
/* ------------------------------------------------------------------ */

/**
 * Which field addresses the *next* window of a shape.
 *
 *   'none'    the shape is not paged by elements at all (a scalar is paged by
 *             bytes, through valuePeek; `missing` has nothing to page)
 *   'offset'  an absolute element index — LRANGE / ZRANGE
 *   'cursor'  an opaque continuation — HSCAN / SSCAN's cursor, XRANGE's entry id
 *
 * This is the single answer to "what do I put in the next request", and it is
 * here rather than in the renderer because `KeyValueResult.nextCursor` is one
 * string standing for three unrelated things: handing an HSCAN cursor back as an
 * offset silently skips or repeats fields, and the mistake is invisible.
 */
export type KeyValueAddressing = 'none' | 'offset' | 'cursor'

export function keyValueAddressing(shape: KeyValueShape): KeyValueAddressing {
  switch (shape) {
    case 'map':
    case 'set':
    case 'stream':
      return 'cursor'
    case 'list':
    case 'sortedSet':
      return 'offset'
    case 'scalar':
    case 'missing':
      return 'none'
  }
}

/** Fields that mean the same thing whatever the shape is */
export interface KeyValueReadCommon {
  /** Elements in this window; defaults to DEFAULT_KEY_VALUE_ELEMENTS, capped at MAX_KEY_VALUE_ELEMENTS */
  limit?: number
  signal?: AbortSignal
}

/**
 * How much of a large value to read, and where from.
 *
 * **A union discriminated by the shape being read, not a flat bag.** It used to
 * be a flat bag — `limit` / `offset` / `cursorToken` / `match`, all optional, all
 * fillable — and that was a lie about the data: a hash is walked by an HSCAN
 * cursor and a list by an index, the two are never interchangeable, and `{ shape:
 * 'map', offset: 200 }` means nothing that a driver could honour. The flat type
 * let a caller write it anyway, and the failure mode was not an error but *wrong
 * rows*: an offset silently ignored, or a cursor read as the number `NaN`.
 *
 * So each shape declares only the fields it can honour, and the ones it cannot
 * are typed `never`:
 *
 * | shape           | command             | window addressed by     | match |
 * |-----------------|---------------------|-------------------------|-------|
 * | scalar          | GET / GETRANGE      | bytes, via valuePeek    | —     |
 * | missing         | —                   | —                       | —     |
 * | map             | HSCAN               | an opaque cursor        | yes   |
 * | set             | SSCAN               | an opaque cursor        | yes   |
 * | list            | LRANGE start stop   | an absolute index       | —     |
 * | sortedSet       | ZRANGE … WITHSCORES | an absolute index       | —     |
 * | stream          | XRANGE (id …)       | an entry id, and/or an index | — |
 *
 * `stream` is the one shape that takes both, and it is not a hedge: XRANGE
 * addresses by entry id, so the continuation is a cursor, while `offset` is
 * honoured by over-reading and slicing locally. Both are real, so both are
 * declared.
 *
 * The member with `shape?: undefined` is the **first** read, before anything is
 * known about the key — it can carry a `limit` and nothing else, which is exactly
 * right: you cannot ask for the second page of something you have not looked at.
 */
export type KeyValueReadOptions =
  /** First window: the shape is not known yet, so nothing may address one */
  | (KeyValueReadCommon & { shape?: undefined; offset?: never; cursorToken?: never; match?: never })
  /** Not paged by elements at all */
  | (KeyValueReadCommon & { shape: 'scalar' | 'missing'; offset?: never; cursorToken?: never; match?: never })
  /** HSCAN / SSCAN: an opaque cursor, and a glob over field names / members */
  | (KeyValueReadCommon & { shape: 'map' | 'set'; offset?: never; cursorToken?: string; match?: string })
  /** LRANGE / ZRANGE: an absolute element index */
  | (KeyValueReadCommon & { shape: 'list' | 'sortedSet'; offset?: number; cursorToken?: never; match?: never })
  /** XRANGE: an entry id, optionally with a local skip inside the returned range */
  | (KeyValueReadCommon & { shape: 'stream'; offset?: number; cursorToken?: string; match?: never })

/**
 * The **wire** form of a read window: flat, and deliberately so.
 *
 * `KeyValueReadOptions` is exclusive by construction because every in-process
 * caller writes it as a literal and the compiler can check it. This one arrives
 * as JSON from another process, where the compiler checks nothing — so it is a
 * plain bag of optional fields that `keyValueReadOptions` below validates into
 * the union exactly once, at the boundary. Two types, because there really are
 * two problems: one is "make the mistake unwritable", the other is "catch it when
 * someone writes it anyway".
 *
 * `shape` is optional here for the same reason it is optional in the union: the
 * first read of a key does not know it yet. Every later read does — the
 * inspector is holding the previous `KeyValueResult` — and sends it
 * (`renderer/components/views/keyWindow.ts`), so its window is validated against
 * the shape rather than guessed.
 */
export interface KeyValueWindow {
  shape?: KeyValueShape
  limit?: number
  offset?: number
  cursorToken?: string
  match?: string
}

/**
 * Validate a wire window into `KeyValueReadOptions`, or throw BAD_REQUEST.
 *
 * Two checks, both of which the flat type cannot make:
 * 1. the window must not address the same read two ways at once (an offset *and*
 *    a cursor) unless the shape is one that genuinely takes both;
 * 2. when `shape` is declared, the addressing has to be the one that shape uses —
 *    an offset into a hash is not a small mistake to forgive, it is a request for
 *    rows the server will never return.
 *
 * With no `shape` the window is accepted on its addressing alone; the driver
 * still re-dispatches on the key's real TYPE, which is the only authority on it.
 */
export function keyValueReadOptions(
  window: KeyValueWindow | undefined,
  signal?: AbortSignal,
): KeyValueReadOptions {
  const common: KeyValueReadCommon = {
    ...(window?.limit === undefined ? {} : { limit: window.limit }),
    ...(signal === undefined ? {} : { signal }),
  }
  if (window === undefined) return common

  const { shape, offset, cursorToken, match } = window
  const hasOffset = offset !== undefined
  const hasCursor = cursorToken !== undefined

  switch (shape) {
    case undefined:
      // Unknown shape: infer the member from what was actually addressed. Both at
      // once is only meaningful for a stream, so that is what it must be.
      if (hasOffset && hasCursor) return { ...common, shape: 'stream', offset, cursorToken }
      if (hasCursor) return { ...common, shape: 'map', cursorToken, ...(match === undefined ? {} : { match }) }
      if (hasOffset) return { ...common, shape: 'list', offset }
      return common
    case 'scalar':
    case 'missing':
      if (hasOffset || hasCursor) throw badWindow(shape, 'is not paged by elements')
      return { ...common, shape }
    case 'map':
    case 'set':
      if (hasOffset) throw badWindow(shape, 'is walked by a cursor, not an offset')
      return {
        ...common,
        shape,
        ...(cursorToken === undefined ? {} : { cursorToken }),
        ...(match === undefined ? {} : { match }),
      }
    case 'list':
    case 'sortedSet':
      if (hasCursor) throw badWindow(shape, 'is addressed by an element index, not a cursor')
      return { ...common, shape, ...(offset === undefined ? {} : { offset }) }
    case 'stream':
      return {
        ...common,
        shape,
        ...(offset === undefined ? {} : { offset }),
        ...(cursorToken === undefined ? {} : { cursorToken }),
      }
  }
}

/**
 * English on purpose: this is a programming error on the wire, not something a
 * user typed, so it goes to the developer and to the MCP transcript verbatim.
 */
function badWindow(shape: KeyValueShape, why: string): PeekError {
  return peekError('BAD_REQUEST', `A ${shape} value ${why}`)
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
  /**
   * `refresh` asks the driver to discard whatever it cached for this level
   * before answering.
   *
   * It is part of the signature rather than a caller-side concern because a
   * driver's introspection cache lives inside the driver process — `manager.ts`
   * cannot reach it, and neither can the renderer. Before 2026-08-03 the flag
   * travelled the whole way here (`DriverRpcRequest` → `driver-rpc.ts` →
   * `manager.ts` → the RPC params) and was then **dropped on the floor** by the
   * host runtime, because this signature had nowhere to put it: the caches only
   * ever cleared when the session closed, so a schema change was invisible until
   * the user reconnected. A driver that caches nothing may ignore it.
   */
  listChildren?(parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>
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
