import {
  peekErrorMsg,
  type CollectionRef,
  type CollectionSchemaInfo,
  type ColumnDef,
  type NamespaceNode,
  type NamespaceNodeKind,
  type RelationRef,
} from '@peek/core'
import type { Pool } from 'pg'
import { mapPgError } from './errors'
import { relationLiteral } from './sql'
import { isPeekableLogical, type PgTypeCatalog } from './type-catalog'

/**
 * Namespace tree: database → schema → table/view. Each level is a separate query,
 * expanded on demand (lazy loading).
 *
 * Everything reads pg_catalog directly. information_schema is a stack of views
 * and is an order of magnitude slower on a large database.
 */

/* ------------------------------------------------------------------ */
/* Node id encoding                                                    */
/* ------------------------------------------------------------------ */

/**
 * Node ids look like 'db:postgres' / 'schema:public' / 'relation:public.harness'.
 * Names can contain '.', ':' and '%', so the encoding escapes exactly those three
 * — enough to stay reversible while keeping the common case readable.
 */
function encodeSeg(raw: string): string {
  return raw.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\./g, '%2E')
}

function decodeSeg(raw: string): string {
  return raw.replace(/%2E/g, '.').replace(/%3A/g, ':').replace(/%25/g, '%')
}

export const nodeId = {
  database: (name: string): string => `db:${encodeSeg(name)}`,
  schema: (name: string): string => `schema:${encodeSeg(name)}`,
  relation: (schema: string, name: string): string => `relation:${encodeSeg(schema)}.${encodeSeg(name)}`,
}

export type ParsedNodeId =
  | { kind: 'database'; name: string }
  | { kind: 'schema'; name: string }
  | { kind: 'relation'; schema: string; name: string }
  | { kind: 'unknown' }

export function parseNodeId(id: string): ParsedNodeId {
  const sep = id.indexOf(':')
  if (sep < 0) return { kind: 'unknown' }
  const prefix = id.slice(0, sep)
  const rest = id.slice(sep + 1)
  if (prefix === 'db') return { kind: 'database', name: decodeSeg(rest) }
  if (prefix === 'schema') return { kind: 'schema', name: decodeSeg(rest) }
  if (prefix === 'relation') {
    const dot = rest.indexOf('.')
    if (dot < 0) return { kind: 'unknown' }
    return {
      kind: 'relation',
      schema: decodeSeg(rest.slice(0, dot)),
      name: decodeSeg(rest.slice(dot + 1)),
    }
  }
  return { kind: 'unknown' }
}

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

/** User schemas: pg_* and information_schema excluded, public sorted first */
const SCHEMA_SQL = `
SELECT n.nspname AS name,
       (SELECT count(*)
          FROM pg_catalog.pg_class c
         WHERE c.relnamespace = n.oid
           AND c.relkind = ANY (ARRAY['r','v','m','p','f']::"char"[])) AS rel_count
  FROM pg_catalog.pg_namespace n
 WHERE n.nspname <> 'information_schema'
   AND left(n.nspname, 3) <> 'pg_'
 ORDER BY (n.nspname = 'public') DESC, n.nspname`

/** Tables / views / materialized views / partitioned tables / foreign tables in one schema */
const RELATION_SQL = `
SELECT c.relname AS name,
       c.relkind::text AS relkind,
       c.reltuples::float8 AS est_rows,
       obj_description(c.oid, 'pg_class') AS comment
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1
   AND c.relkind = ANY (ARRAY['r','v','m','p','f']::"char"[])
 ORDER BY c.relname`

const COLUMN_SQL = `
SELECT a.attname AS name,
       a.atttypid::int4 AS type_oid,
       a.attnotnull AS not_null,
       format_type(a.atttypid, a.atttypmod) AS fmt,
       col_description(a.attrelid, a.attnum) AS comment
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = $1::regclass
   AND a.attnum > 0
   AND NOT a.attisdropped
 ORDER BY a.attnum`

const PK_SQL = `
SELECT a.attname AS name
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
 WHERE i.indrelid = $1::regclass
   AND i.indisprimary
 ORDER BY array_position(i.indkey::int2[], a.attnum)`

const INDEX_SQL = `
SELECT ci.relname AS name,
       i.indisunique AS is_unique,
       ARRAY(
         SELECT pg_get_indexdef(i.indexrelid, k + 1, true)
           FROM generate_subscripts(i.indkey, 1) AS k
       ) AS cols
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid
 WHERE i.indrelid = $1::regclass
 ORDER BY i.indisprimary DESC, ci.relname`

const RELATION_META_SQL = `
SELECT c.reltuples::float8 AS est_rows,
       obj_description(c.oid, 'pg_class') AS comment
  FROM pg_catalog.pg_class c
 WHERE c.oid = $1::regclass`

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

const RELKIND_TO_NODE: Readonly<Record<string, NamespaceNodeKind>> = {
  r: 'table',
  p: 'table',
  f: 'table',
  v: 'view',
  m: 'materializedView',
}

/** reltuples of -1 means the relation was never ANALYZEd, so report no estimate */
function estimateOf(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n)
}

/**
 * Row-count hint shown on a tree node.
 *
 * Deliberately an English literal, not a catalog message: this string is written
 * into NamespaceNode.detail, which MCP reads as well as the sidebar, and the MCP
 * surface stays English forever.
 */
function formatRows(n: number): string {
  if (n < 1000) return `~${n} rows`
  if (n < 1_000_000) return `~${(n / 1000).toFixed(1)}k rows`
  return `~${(n / 1_000_000).toFixed(1)}M rows`
}

export interface IntrospectDeps {
  pool: Pool
  catalog: PgTypeCatalog
  /** Database this connection is attached to */
  database: string
  /** Server version, surfaced on the database node's detail line */
  serverVersion?: string
}

export class PgIntrospector {
  private readonly deps: IntrospectDeps
  /** describeCollection cache, keyed by schema + '.' + name */
  private readonly describeCache = new Map<string, CollectionSchemaInfo>()

  constructor(deps: IntrospectDeps) {
    this.deps = deps
  }

  /** Invalidate on manual refresh (PLAN section 8: lazy tree + cache + manual invalidation) */
  invalidate(): void {
    this.describeCache.clear()
  }

  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    if (parentId === null) return this.rootNodes()
    const parsed = parseNodeId(parentId)
    switch (parsed.kind) {
      case 'database':
        return this.schemaNodes()
      case 'schema':
        return this.relationNodes(parsed.name)
      case 'relation':
        // A relation node is a leaf: its columns come from describeCollection,
        // they are not part of the tree
        return []
      case 'unknown':
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
    }
  }

  private rootNodes(): NamespaceNode[] {
    const { database, serverVersion } = this.deps
    const node: NamespaceNode = {
      id: nodeId.database(database),
      name: database,
      kind: 'database',
      hasChildren: true,
    }
    if (serverVersion) node.detail = `PostgreSQL ${serverVersion}`
    return [node]
  }

  private async schemaNodes(): Promise<NamespaceNode[]> {
    const res = await this.query<{ name: string; rel_count: string | number }>(SCHEMA_SQL)
    return res.map((r) => {
      const count = Number(r.rel_count)
      return {
        id: nodeId.schema(r.name),
        name: r.name,
        kind: 'schema' as const,
        hasChildren: count > 0,
        detail: count === 1 ? '1 object' : `${count} objects`,
      }
    })
  }

  private async relationNodes(schema: string): Promise<NamespaceNode[]> {
    const res = await this.query<{
      name: string
      relkind: string
      est_rows: number | string | null
      comment: string | null
    }>(RELATION_SQL, [schema])
    return res.map((r) => {
      const ref: RelationRef = { kind: 'relation', schema, name: r.name }
      const est = estimateOf(r.est_rows)
      const node: NamespaceNode = {
        id: nodeId.relation(schema, r.name),
        name: r.name,
        kind: RELKIND_TO_NODE[r.relkind] ?? 'table',
        hasChildren: false,
        ref,
      }
      const bits: string[] = []
      if (est !== undefined) bits.push(formatRows(est))
      if (r.comment) bits.push(r.comment)
      if (bits.length > 0) node.detail = bits.join(' · ')
      if (est !== undefined) node.meta = { rowCountEstimate: est }
      return node
    })
  }

  /** The ref has to be a relation; the others (keyPattern / vectorCollection) belong to other drivers */
  static requireRelation(ref: CollectionRef): RelationRef {
    if (ref.kind !== 'relation') {
      throw peekErrorMsg('BAD_REQUEST', 'error.introspect.collectionKindUnsupported', { kind: ref.kind })
    }
    return ref
  }

  async describeCollection(ref: CollectionRef, refresh = false): Promise<CollectionSchemaInfo> {
    const rel = PgIntrospector.requireRelation(ref)
    const key = `${rel.schema}.${rel.name}`
    if (!refresh) {
      const hit = this.describeCache.get(key)
      if (hit) return hit
    }
    const literal = relationLiteral(rel)

    const [cols, pks, indexes, meta] = await Promise.all([
      this.query<{
        name: string
        type_oid: number
        not_null: boolean
        fmt: string
        comment: string | null
      }>(COLUMN_SQL, [literal]),
      this.query<{ name: string }>(PK_SQL, [literal]),
      this.query<{ name: string; is_unique: boolean; cols: string[] }>(INDEX_SQL, [literal]),
      this.query<{ est_rows: number | string | null; comment: string | null }>(RELATION_META_SQL, [literal]),
    ])

    if (cols.length === 0) {
      throw peekErrorMsg('NOT_FOUND', 'error.introspect.relationNotFound', { name: key })
    }

    const pkSet = new Set(pks.map((p) => p.name))
    const columns: ColumnDef[] = cols.map((c) => {
      const logical = this.deps.catalog.logical(c.type_oid)
      const def: ColumnDef = {
        name: c.name,
        logical,
        nativeType: this.deps.catalog.nativeType(c.type_oid),
        nullable: !c.not_null,
      }
      if (isPeekableLogical(logical)) def.peekable = true
      if (pkSet.has(c.name)) def.primaryKey = true
      return def
    })

    const metaRow = meta.length > 0 ? meta[0] : undefined
    const est = estimateOf(metaRow?.est_rows)
    const info: CollectionSchemaInfo = {
      ref: rel,
      columns,
      ...(pks.length > 0 ? { primaryKey: pks.map((p) => p.name) } : {}),
      ...(est === undefined ? {} : { rowCountEstimate: est }),
      ...(indexes.length > 0
        ? {
            indexes: indexes.map((i) => ({
              name: i.name,
              columns: i.cols,
              unique: i.is_unique,
            })),
          }
        : {}),
      ...(metaRow?.comment ? { comment: metaRow.comment } : {}),
    }
    this.describeCache.set(key, info)
    return info
  }

  /** Column hints that fill in primaryKey / nullable on collectionScan's first-frame schema */
  async columnHints(
    ref: CollectionRef,
  ): Promise<ReadonlyMap<string, { nullable?: boolean; primaryKey?: boolean }>> {
    const hints = new Map<string, { nullable?: boolean; primaryKey?: boolean }>()
    try {
      const info = await this.describeCollection(ref)
      for (const c of info.columns) {
        const hint: { nullable?: boolean; primaryKey?: boolean } = {}
        if (c.nullable !== undefined) hint.nullable = c.nullable
        if (c.primaryKey) hint.primaryKey = true
        hints.set(c.name, hint)
      }
    } catch {
      // Not worth failing over: the scan works fine with two optional fields missing
    }
    return hints
  }

  private async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    try {
      const res = await this.deps.pool.query<R>(sql, params)
      return res.rows
    } catch (err) {
      throw mapPgError(err, { sql, fallback: 'QUERY_FAILED' })
    }
  }
}
