import type { LogicalType } from '@peek/core'

/**
 * pg 类型目录：OID → 类型名 / 逻辑类型。
 *
 * RowDescription 只给 dataTypeID（OID），要拿到 nativeType（'jsonb'/'timestamptz'…）
 * 必须查 pg_type。连接建立时一次性拉全表（约 600 行，几毫秒），之后纯内存查表；
 * 遇到连接后新建的类型（CREATE TYPE / 装扩展）走 refreshMissing 增量补。
 */

export interface PgTypeInfo {
  oid: number
  /** pg_type.typname，即 ColumnDef.nativeType */
  name: string
  /** pg_type.typcategory，单字母 */
  category: string
  /** 数组类型的元素 OID，0 表示不是数组 */
  elem: number
}

/** pg_type 一行的原始形状 */
export interface PgTypeRow {
  oid: number
  typname: string
  typcategory: string
  typelem: number
}

/** 按 typname 精确指定逻辑类型（比 typcategory 更准） */
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

/** typcategory 兜底映射 */
function logicalFromCategory(category: string): LogicalType {
  switch (category) {
    case 'A': return 'array'
    case 'B': return 'boolean'
    case 'N': return 'number'
    case 'S': return 'string'
    case 'E': return 'string'
    case 'G': return 'geo'
    case 'I': return 'string'
    case 'V': return 'string'
    case 'T': return 'interval'
    case 'D': return 'timestamp'
    case 'R': return 'string'
    case 'C': return 'json'
    default: return 'unknown'
  }
}

/** 这些逻辑类型的值可能很大，前端需要提前准备 valuePeek 入口 */
const PEEKABLE: ReadonlySet<LogicalType> = new Set<LogicalType>([
  'string', 'json', 'bytes', 'array', 'vector', 'geo', 'unknown',
])

export function isPeekableLogical(logical: LogicalType): boolean {
  return PEEKABLE.has(logical)
}

export class PgTypeCatalog {
  private readonly byOid = new Map<number, PgTypeInfo>()

  /** 用 pg_type 查询结果填充（可多次调用，做增量补充） */
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

  /** ColumnDef.nativeType；查不到时退化成 'oid:1234'，保证永远有值 */
  nativeType(oid: number): string {
    return this.byOid.get(oid)?.name ?? `oid:${oid}`
  }

  logical(oid: number): LogicalType {
    const info = this.byOid.get(oid)
    if (!info) return 'unknown'
    const byName = LOGICAL_BY_NAME[info.name]
    if (byName) return byName
    // 数组：'_int4' 这类，统一归 array（vector 的数组也算 array）
    if (info.category === 'A' || (info.elem !== 0 && info.name.startsWith('_'))) return 'array'
    return logicalFromCategory(info.category)
  }

  /** 是否是 bytea（valuePeek 的字节切片要按二进制处理） */
  isBinary(oid: number): boolean {
    return this.byOid.get(oid)?.name === 'bytea'
  }

  get size(): number {
    return this.byOid.size
  }
}

/** 拉取 pg_type 的 SQL。missingOids 非空时只拉这些，用于增量补齐。 */
export const PG_TYPE_QUERY =
  `SELECT oid::int4 AS oid, typname, typcategory, typelem::int4 AS typelem FROM pg_catalog.pg_type`

export const PG_TYPE_QUERY_BY_OID =
  `${PG_TYPE_QUERY} WHERE oid = ANY($1::oid[])`
