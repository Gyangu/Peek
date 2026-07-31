import { peekError, type FilterSpec, type RelationRef, type SortSpec } from '@peek/core'

/**
 * SQL 片段构造。
 *
 * 铁律：**值一律走 $n 参数，绝不字符串拼接**；标识符走 quoteIdent 双引号转义。
 * 这里没有任何一处把用户提供的值拼进 SQL 文本。
 */

/** 参数收集器：add(v) 返回 '$n' 占位符 */
export class ParamList {
  private readonly values: unknown[] = []

  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }

  /** 已经存在的参数（比如 tabularQuery 透传的 params）预置进来 */
  seed(values: readonly unknown[]): void {
    for (const v of values) this.values.push(v)
  }

  get list(): unknown[] {
    return this.values
  }

  get count(): number {
    return this.values.length
  }
}

/** 源码里不放裸 NUL 字节，用它做包含性检查 */
const NUL_CHAR = String.fromCharCode(0)

/**
 * 标识符引号：双引号包裹 + 内部双引号翻倍，空格/点/中文都安全。
 * 唯一无法安全转义的是 NUL 字节，直接拒绝。
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw peekError('BAD_REQUEST', '标识符不能为空')
  if (name.includes(NUL_CHAR)) throw peekError('BAD_REQUEST', `标识符含非法字符: ${JSON.stringify(name)}`)
  return `"${name.replace(/"/g, '""')}"`
}

/** schema.table 全限定名；schema 为空串时只用表名（走 search_path） */
export function qualifiedName(ref: RelationRef): string {
  return ref.schema ? `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}` : quoteIdent(ref.name)
}

/** regclass 参数用的字面文本（作为 $1 传入，不拼进 SQL） */
export function relationLiteral(ref: RelationRef): string {
  return qualifiedName(ref)
}

function requireValue(f: FilterSpec): unknown {
  if (f.value === undefined) {
    throw peekError('BAD_REQUEST', `筛选条件 ${f.column} ${f.op} 缺少 value`)
  }
  return f.value
}

/** 单条筛选 → SQL 片段 */
export function renderFilter(f: FilterSpec, p: ParamList): string {
  const col = quoteIdent(f.column)
  switch (f.op) {
    case 'isNull':
      return `${col} IS NULL`
    case 'isNotNull':
      return `${col} IS NOT NULL`
    case 'eq':
      return `${col} = ${p.add(requireValue(f))}`
    case 'neq':
      return `${col} IS DISTINCT FROM ${p.add(requireValue(f))}`
    case 'lt':
      return `${col} < ${p.add(requireValue(f))}`
    case 'lte':
      return `${col} <= ${p.add(requireValue(f))}`
    case 'gt':
      return `${col} > ${p.add(requireValue(f))}`
    case 'gte':
      return `${col} >= ${p.add(requireValue(f))}`
    case 'like':
      return `${col}::text LIKE ${p.add(String(requireValue(f)))}`
    case 'ilike':
      return `${col}::text ILIKE ${p.add(String(requireValue(f)))}`
    case 'contains':
      // 通配符不参与语义：用 strpos 做纯子串匹配，用户输入里的 % / _ 不被解释
      return `strpos(${col}::text, ${p.add(String(requireValue(f)))}) > 0`
    case 'in': {
      const raw = requireValue(f)
      if (!Array.isArray(raw)) {
        throw peekError('BAD_REQUEST', `筛选条件 ${f.column} in 的 value 必须是数组`)
      }
      if (raw.length === 0) return 'false'
      // 展开成 IN ($1,$2,...)：每个元素独立参数化，PG 可从列类型推断参数类型
      const holes = raw.map((v) => p.add(v)).join(', ')
      return `${col} IN (${holes})`
    }
  }
}

export function renderWhere(filters: readonly FilterSpec[] | undefined, p: ParamList): string {
  if (!filters || filters.length === 0) return ''
  return ` WHERE ${filters.map((f) => renderFilter(f, p)).join(' AND ')}`
}

export function renderOrderBy(sorts: readonly SortSpec[] | undefined): string {
  if (!sorts || sorts.length === 0) return ''
  const parts = sorts.map((s) => {
    const dir = s.dir === 'desc' ? 'DESC' : 'ASC'
    const nulls = s.nulls === 'first' ? ' NULLS FIRST' : s.nulls === 'last' ? ' NULLS LAST' : ''
    return `${quoteIdent(s.column)} ${dir}${nulls}`
  })
  return ` ORDER BY ${parts.join(', ')}`
}

export interface ScanSqlInput {
  ref: RelationRef
  filter?: readonly FilterSpec[]
  sort?: readonly SortSpec[]
  columns?: readonly string[]
  offset?: number
  limit?: number
}

export interface ScanSql {
  text: string
  params: unknown[]
  /** 实际生效的 offset / limit，用于回算 nextCursor */
  offset: number
  limit?: number
}

/** collectionScan → SELECT 语句。所有值参数化，标识符转义。 */
export function buildScanSql(input: ScanSqlInput): ScanSql {
  const p = new ParamList()
  const cols = input.columns && input.columns.length > 0
    ? input.columns.map(quoteIdent).join(', ')
    : '*'
  const where = renderWhere(input.filter, p)
  const order = renderOrderBy(input.sort)

  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit))

  let tail = ''
  if (limit !== undefined) tail += ` LIMIT ${p.add(limit)}`
  if (offset > 0) tail += ` OFFSET ${p.add(offset)}`

  return {
    text: `SELECT ${cols} FROM ${qualifiedName(input.ref)}${where}${order}${tail}`,
    params: p.list,
    offset,
    ...(limit === undefined ? {} : { limit }),
  }
}

/**
 * 结果集内某一行的取值子查询：把原语句包一层并按序号重命名各列，
 * 这样即使原语句有重名列也能用 c0/c1/... 精确定位第 col 列。
 */
export function wrapResultRow(text: string, columnCount: number, offsetPlaceholder: string): string {
  const aliases = Array.from({ length: columnCount }, (_, i) => `c${i}`).join(', ')
  return `SELECT * FROM (${text}) AS _peek_src(${aliases}) OFFSET ${offsetPlaceholder} LIMIT 1`
}

/** 把标量表达式统一转成 bytea，供 substring 做字节级切片 */
export function toByteaExpr(expr: string, binary: boolean): string {
  return binary ? `(${expr})::bytea` : `convert_to((${expr})::text, 'UTF8')`
}
