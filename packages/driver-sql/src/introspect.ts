import {
  peekErrorMsg,
  type CollectionRef,
  type CollectionSchemaInfo,
  type ColumnDef,
  type NamespaceNode,
  type NamespaceNodeKind,
  type RelationRef,
} from '@peek/core'
import type { SqlBackendHandle, SqlRows } from './connection'
import type { SqlDialect, SqlRelationInfo, SqlText } from './dialect'
import { mapSqlError } from './errors'
import { cellNumber, cellText, columnIndex, isPeekableLogical } from './values'

/**
 * The namespace tree for both SQL dialects: **schema → table/view**.
 *
 * Two levels, not three. driver-postgres has database → schema → relation because
 * PostgreSQL genuinely has all three and a connection can only see one database.
 * Here the middle level is where the databases disagree, and flattening is the
 * honest reading of each:
 *
 * - MySQL has no schema separate from a database — `CREATE SCHEMA` is a synonym
 *   for `CREATE DATABASE` — and one connection can query across all of them. So
 *   the root level lists databases, and `RelationRef.schema` carries the database
 *   name.
 * - SQLite has one file, plus whatever `ATTACH` added. `PRAGMA database_list`
 *   returns `main` (always), `temp`, and the attached ones, which is exactly the
 *   same shape. `RelationRef.schema` carries that name, and is **never empty** —
 *   it is normalized to `'main'`, so a ref built by the tree and one typed by an
 *   MCP caller address the same table.
 *
 * Caching follows PLAN section 8: every level is cached until `invalidate()`,
 * which the manual refresh calls. Nothing here is refreshed on a timer — a schema
 * that changes under the user is rarer than a tree that flickers.
 */

/* ------------------------------------------------------------------ */
/* Node id encoding                                                    */
/* ------------------------------------------------------------------ */

/**
 * Node ids look like `schema:main` / `relation:main.users`.
 *
 * The escaping is character-for-character what driver-postgres uses ('%', ':'
 * and '.' percent-escaped), so the two SQL trees produce the same id for the same
 * relation and anything that parses an id — a saved view, an MCP argument — works
 * across all three drivers.
 */
function encodeSeg(raw: string): string {
  return raw.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\./g, '%2E')
}

function decodeSeg(raw: string): string {
  return raw.replace(/%2E/g, '.').replace(/%3A/g, ':').replace(/%25/g, '%')
}

export const sqlNodeId = {
  schema: (name: string): string => `schema:${encodeSeg(name)}`,
  relation: (schema: string, name: string): string =>
    `relation:${encodeSeg(schema)}.${encodeSeg(name)}`,
}

export type ParsedSqlNodeId =
  | { kind: 'schema'; name: string }
  | { kind: 'relation'; schema: string; name: string }
  | { kind: 'unknown' }

export function parseSqlNodeId(id: string): ParsedSqlNodeId {
  const sep = id.indexOf(':')
  if (sep < 0) return { kind: 'unknown' }
  const prefix = id.slice(0, sep)
  const rest = id.slice(sep + 1)
  if (prefix === 'schema') return rest.length > 0 ? { kind: 'schema', name: decodeSeg(rest) } : { kind: 'unknown' }
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
/* The introspector                                                    */
/* ------------------------------------------------------------------ */

export interface SqlIntrospectorOptions {
  dialect: SqlDialect
  handle: SqlBackendHandle
}

/**
 * Row-count hint shown on a tree node.
 *
 * Deliberately an English literal, not a catalog message: it is written into
 * `NamespaceNode.detail`, which MCP reads as well as the sidebar, and the MCP
 * surface stays English forever.
 */
function formatRows(n: number): string {
  if (n < 1000) return `~${n} rows`
  if (n < 1_000_000) return `~${(n / 1000).toFixed(1)}k rows`
  return `~${(n / 1_000_000).toFixed(1)}M rows`
}

const RELATION_KIND_TO_NODE: Readonly<Record<SqlRelationInfo['kind'], NamespaceNodeKind>> = {
  table: 'table',
  view: 'view',
  materializedView: 'materializedView',
}

export class SqlIntrospector {
  private readonly opts: SqlIntrospectorOptions

  /** One entry per level, all dropped together by `invalidate()` */
  private schemaCache: string[] | null = null
  private readonly relationCache = new Map<string, SqlRelationInfo[]>()
  private readonly describeCache = new Map<string, CollectionSchemaInfo>()

  constructor(opts: SqlIntrospectorOptions) {
    this.opts = opts
  }

  /**
   * One level of the tree.
   *
   * - `null`         → the schemas (MySQL databases / SQLite attached databases),
   *                    with the connection's default schema sorted first so the
   *                    tree opens where the user already is;
   * - `schema:…`     → its tables and views, each carrying a `RelationRef` so a
   *                    click opens a table view;
   * - `relation:…`   → `[]`. Columns are **not** tree nodes: they belong to the
   *                    table view's header and to `describeCollection`, and
   *                    putting them in the tree doubles its size for information
   *                    the grid already shows.
   */
  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    if (parentId === null) return this.schemaNodes()
    const parsed = parseSqlNodeId(parentId)
    switch (parsed.kind) {
      case 'schema':
        return this.relationNodes(parsed.name)
      case 'relation':
        return []
      case 'unknown':
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
    }
  }

  private async schemaNodes(): Promise<NamespaceNode[]> {
    const names = await this.schemas()
    const { serverInfo } = this.opts.handle
    const def = this.opts.handle.defaultSchema
    return names.map((name) => {
      const node: NamespaceNode = {
        id: sqlNodeId.schema(name),
        name,
        kind: 'schema',
        // Unknown without another round trip per schema; the UI folds the node
        // back if expanding it yields nothing (NamespaceNode.hasChildren)
        hasChildren: true,
      }
      if (name === def) {
        node.detail = serverInfo.flavor
          ? `${serverInfo.flavor} ${serverInfo.version}`
          : serverInfo.version
      }
      return node
    })
  }

  private async schemas(): Promise<string[]> {
    if (this.schemaCache) return this.schemaCache
    const { dialect, handle } = this.opts
    const rows = await this.run(dialect.listSchemasSql())
    const names = dialect.decodeSchemas(rows.rows, rows.columns)
    // The connection's own schema first: the tree should open where the user is
    const def = handle.defaultSchema
    names.sort((a, b) => (a === def ? -1 : b === def ? 1 : 0))
    this.schemaCache = names
    return names
  }

  private async relationNodes(schema: string): Promise<NamespaceNode[]> {
    const relations = await this.relations(schema)
    return relations.map((rel) => {
      const ref: RelationRef = { kind: 'relation', schema: rel.schema, name: rel.name }
      const node: NamespaceNode = {
        id: sqlNodeId.relation(rel.schema, rel.name),
        name: rel.name,
        kind: RELATION_KIND_TO_NODE[rel.kind],
        hasChildren: false,
        ref,
      }
      const bits: string[] = []
      if (rel.estimatedRows !== null) bits.push(formatRows(rel.estimatedRows))
      if (rel.comment) bits.push(rel.comment)
      if (bits.length > 0) node.detail = bits.join(' · ')
      if (rel.estimatedRows !== null) node.meta = { rowCountEstimate: rel.estimatedRows }
      return node
    })
  }

  private async relations(schema: string): Promise<SqlRelationInfo[]> {
    const hit = this.relationCache.get(schema)
    if (hit) return hit
    const { dialect } = this.opts
    const rows = await this.run(dialect.listRelationsSql(schema))
    const list = dialect.decodeRelations(schema, rows.rows, rows.columns)
    this.relationCache.set(schema, list)
    return list
  }

  /**
   * Full structure of one relation: columns, primary key, indexes, row estimate.
   *
   * The row estimate is an estimate or nothing — see `SqlRelationInfo.estimatedRows`.
   * Never `SELECT count(*)`.
   */
  async describeCollection(ref: CollectionRef, refresh = false): Promise<CollectionSchemaInfo> {
    const { dialect, handle } = this.opts
    const rel = SqlIntrospector.requireRelation(dialect, handle.defaultSchema, ref)
    const key = `${rel.schema}.${rel.name}`
    if (!refresh) {
      const hit = this.describeCache.get(key)
      if (hit) return hit
    }

    const [colRows, indexRows, metaRows] = await Promise.all([
      this.run(dialect.listColumnsSql(rel)),
      this.run(dialect.listIndexesSql(rel)),
      this.run(dialect.relationMetaSql(rel)),
    ])

    const metas = dialect.decodeColumns(colRows.rows, colRows.columns)
    if (metas.length === 0) {
      throw peekErrorMsg('NOT_FOUND', 'error.collection.notFound', { name: key })
    }

    const columns: ColumnDef[] = metas.map((meta) => {
      const logical = dialect.logical(meta)
      const def: ColumnDef = {
        name: meta.name,
        logical,
        nativeType: dialect.nativeTypeName(meta),
      }
      if (isPeekableLogical(logical)) def.peekable = true
      if (meta.nullable !== undefined) def.nullable = meta.nullable
      if (meta.primaryKey === true) def.primaryKey = true
      return def
    })

    const primaryKey = metas.filter((m) => m.primaryKey === true).map((m) => m.name)
    const indexes = dialect.decodeIndexes(indexRows.rows, indexRows.columns)
    const meta = decodeRelationMeta(metaRows)

    const info: CollectionSchemaInfo = {
      ref: rel,
      columns,
      ...(primaryKey.length > 0 ? { primaryKey } : {}),
      ...(meta.estimatedRows === null ? {} : { rowCountEstimate: meta.estimatedRows }),
      ...(indexes && indexes.length > 0 ? { indexes } : {}),
      ...(meta.comment ? { comment: meta.comment } : {}),
    }
    this.describeCache.set(key, info)
    return info
  }

  /**
   * Nullability / primary-key hints per column name, handed to `SqlCursor` so a
   * scan's `ColumnDef`s carry what the grid needs to address a row.
   */
  async columnHints(
    ref: RelationRef,
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
      // Not worth failing the scan over: it works fine with two optional fields missing
    }
    return hints
  }

  /** Manual refresh: drop every cached level */
  invalidate(): void {
    this.schemaCache = null
    this.relationCache.clear()
    this.describeCache.clear()
  }

  /** Run one dialect-built statement, funnelling failures through `mapSqlError` */
  private async run(sql: SqlText): Promise<SqlRows> {
    try {
      return await this.opts.handle.exec(sql.text, sql.params)
    } catch (err) {
      throw mapSqlError(this.opts.dialect, err, { sql: sql.text, fallback: 'QUERY_FAILED' })
    }
  }

  /**
   * Narrow a `CollectionRef` to the relational branch, and normalize the schema.
   *
   * The normalization is the point: a `RelationRef` with an empty schema is legal
   * on the wire (core allows `''` for the schema-less databases), and this is the
   * single place it is resolved to a concrete name — MySQL's current database, or
   * SQLite's `'main'` — so nothing downstream has to wonder.
   */
  static requireRelation(dialect: SqlDialect, defaultSchema: string, ref: CollectionRef): RelationRef {
    if (ref.kind !== 'relation') {
      throw peekErrorMsg('BAD_REQUEST', 'error.collection.kindUnsupported', {
        driverId: dialect.flavor,
        kind: ref.kind,
      })
    }
    return ref.schema === '' ? { ...ref, schema: defaultSchema } : ref
  }
}

/**
 * Decode `relationMetaSql`'s single row.
 *
 * Shared rather than per-dialect because the *aliases* are part of the interface
 * contract (`est_rows` / `comment` / `kind`, see `SqlDialect.relationMetaSql`);
 * only the sources differ, and SQLite's `est_rows` is a literal NULL by design.
 */
function decodeRelationMeta(rows: SqlRows): { estimatedRows: number | null; comment: string | null } {
  const row = rows.rows[0]
  if (!row) return { estimatedRows: null, comment: null }
  const estIdx = columnIndex(rows.columns, 'est_rows')
  const commentIdx = columnIndex(rows.columns, 'comment')
  const est = estIdx < 0 ? null : cellNumber(row[estIdx])
  const comment = commentIdx < 0 ? null : cellText(row[commentIdx])
  return {
    estimatedRows: est !== null && est >= 0 ? Math.round(est) : null,
    comment: comment !== null && comment.length > 0 ? comment : null,
  }
}
