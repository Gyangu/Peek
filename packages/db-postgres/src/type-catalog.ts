import type { LogicalType } from '@peek/core'

/**
 * pg type catalog: OID → type name / logical type.
 *
 * A RowDescription only carries dataTypeID (an OID), so reaching nativeType
 * ('jsonb', 'timestamptz', …) means consulting pg_type. The whole table is
 * pulled once when the connection is established (~600 rows, a few
 * milliseconds); every lookup after that is pure memory. Types created after
 * connect (CREATE TYPE, installing an extension) are filled in incrementally.
 */

export interface PgTypeInfo {
  oid: number
  /** pg_type.typname, i.e. ColumnDef.nativeType */
  name: string
  /** pg_type.typcategory, a single letter */
  category: string
  /** Element OID for array types; 0 means this is not an array */
  elem: number
}

/** Raw shape of one pg_type row */
export interface PgTypeRow {
  oid: number
  typname: string
  typcategory: string
  typelem: number
}

/** Logical types pinned by typname (more precise than typcategory) */
const LOGICAL_BY_NAME: Readonly<Record<string, LogicalType>> = {
  bool: 'boolean',
  bytea: 'bytes',
  json: 'json',
  jsonb: 'json',
  jsonpath: 'string',
  uuid: 'uuid',
  int8: 'bigint',
  date: 'date',
  time: 'time',
  timetz: 'time',
  timestamp: 'timestamp',
  timestamptz: 'timestamp',
  interval: 'interval',
  money: 'number',
  xml: 'string',
  // pgvector
  vector: 'vector',
  halfvec: 'vector',
  sparsevec: 'vector',
  // postgis
  geometry: 'geo',
  geography: 'geo',
}

/** typcategory fallback mapping */
function logicalFromCategory(category: string): LogicalType {
  switch (category) {
    case 'A':
      return 'array'
    case 'B':
      return 'boolean'
    case 'N':
      return 'number'
    case 'S':
      return 'string'
    case 'E':
      return 'string'
    case 'G':
      return 'geo'
    case 'I':
      return 'string'
    case 'V':
      return 'string'
    case 'T':
      return 'interval'
    case 'D':
      return 'timestamp'
    case 'R':
      return 'string'
    case 'C':
      return 'json'
    default:
      return 'unknown'
  }
}

/** Values of these logical types can be huge, so the UI needs a valuePeek entry point ready up front */
const PEEKABLE: ReadonlySet<LogicalType> = new Set<LogicalType>([
  'string',
  'json',
  'bytes',
  'array',
  'vector',
  'geo',
  'unknown',
])

export function isPeekableLogical(logical: LogicalType): boolean {
  return PEEKABLE.has(logical)
}

export class PgTypeCatalog {
  private readonly byOid = new Map<number, PgTypeInfo>()

  /** Populate from a pg_type query result (safe to call repeatedly for incremental top-ups) */
  load(rows: readonly PgTypeRow[]): void {
    for (const r of rows) {
      this.byOid.set(r.oid, {
        oid: r.oid,
        name: r.typname,
        category: r.typcategory,
        elem: r.typelem,
      })
    }
  }

  has(oid: number): boolean {
    return this.byOid.has(oid)
  }

  info(oid: number): PgTypeInfo | undefined {
    return this.byOid.get(oid)
  }

  /** ColumnDef.nativeType; an unknown OID degrades to 'oid:1234' so the field is never empty */
  nativeType(oid: number): string {
    return this.byOid.get(oid)?.name ?? `oid:${oid}`
  }

  logical(oid: number): LogicalType {
    const info = this.byOid.get(oid)
    if (!info) return 'unknown'
    const byName = LOGICAL_BY_NAME[info.name]
    if (byName) return byName
    // Arrays such as '_int4' all map to array (including arrays of vectors)
    if (info.category === 'A' || (info.elem !== 0 && info.name.startsWith('_'))) return 'array'
    return logicalFromCategory(info.category)
  }

  /** Whether this is bytea (valuePeek has to slice its bytes as binary) */
  isBinary(oid: number): boolean {
    return this.byOid.get(oid)?.name === 'bytea'
  }

  get size(): number {
    return this.byOid.size
  }
}

/** SQL that reads pg_type. */
export const PG_TYPE_QUERY = `SELECT oid::int4 AS oid, typname, typcategory, typelem::int4 AS typelem FROM pg_catalog.pg_type`
