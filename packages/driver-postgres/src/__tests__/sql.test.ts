import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VALUE_PREVIEW_BYTES, isTruncatedValue } from '@peek/core'
import { ParamList, buildScanSql, quoteIdent, renderFilter, renderOrderBy } from '../sql'
import { PgTypeCatalog } from '../type-catalog'
import { estimateCellBytes, normalizeCell } from '../values'
import { nodeId, parseNodeId } from '../introspect'

describe('标识符转义', () => {
  it('双引号翻倍，注入串无法逃逸', () => {
    assert.equal(quoteIdent('harness'), '"harness"')
    assert.equal(quoteIdent('a"b'), '"a""b"')
    // 经典注入尝试：整段被当成一个标识符，语义上就是"找不到这张表"
    assert.equal(quoteIdent('t"; DROP TABLE x; --'), '"t""; DROP TABLE x; --"')
  })

  it('允许空格与中文，拒绝空串', () => {
    assert.equal(quoteIdent('my table'), '"my table"')
    assert.equal(quoteIdent('用户表'), '"用户表"')
    assert.throws(() => quoteIdent(''))
  })
})

describe('筛选参数化', () => {
  it('值一律进 $n，不进 SQL 文本', () => {
    const p = new ParamList()
    const frag = renderFilter({ column: 'name', op: 'eq', value: "x'; DROP TABLE y; --" }, p)
    assert.equal(frag, '"name" = $1')
    assert.deepEqual(p.list, ["x'; DROP TABLE y; --"])
  })

  it('in 展开成逐个占位符，空数组退化成 false', () => {
    const p = new ParamList()
    assert.equal(renderFilter({ column: 'id', op: 'in', value: [1, 2, 3] }, p), '"id" IN ($1, $2, $3)')
    assert.deepEqual(p.list, [1, 2, 3])
    assert.equal(renderFilter({ column: 'id', op: 'in', value: [] }, new ParamList()), 'false')
  })

  it('contains 用 strpos，不把用户输入当通配符', () => {
    const p = new ParamList()
    const frag = renderFilter({ column: 'body', op: 'contains', value: '100%' }, p)
    assert.equal(frag, 'strpos("body"::text, $1) > 0')
    assert.deepEqual(p.list, ['100%'])
  })

  it('isNull 不吃参数，缺 value 的比较会被拒', () => {
    const p = new ParamList()
    assert.equal(renderFilter({ column: 'c', op: 'isNull' }, p), '"c" IS NULL')
    assert.equal(p.count, 0)
    assert.throws(() => renderFilter({ column: 'c', op: 'eq' }, p))
  })
})

describe('排序与扫描语句', () => {
  it('ORDER BY 拼接方向与 NULLS 位置', () => {
    assert.equal(
      renderOrderBy([{ column: 'a', dir: 'desc', nulls: 'last' }, { column: 'b', dir: 'asc' }]),
      ' ORDER BY "a" DESC NULLS LAST, "b" ASC',
    )
  })

  it('collectionScan 的 limit/offset 也是参数', () => {
    const sql = buildScanSql({
      ref: { kind: 'relation', schema: 'public', name: 'harness' },
      filter: [{ column: 'name', op: 'like', value: 'a%' }],
      sort: [{ column: 'created_at', dir: 'desc' }],
      offset: 10,
      limit: 20,
    })
    assert.equal(
      sql.text,
      'SELECT * FROM "public"."harness" WHERE "name"::text LIKE $1'
        + ' ORDER BY "created_at" DESC LIMIT $2 OFFSET $3',
    )
    assert.deepEqual(sql.params, ['a%', 20, 10])
  })
})

describe('节点 id 编解码', () => {
  it('名字里带点/冒号/百分号也能可逆', () => {
    const id = nodeId.relation('we.ird:%', 'tab.le')
    const parsed = parseNodeId(id)
    assert.deepEqual(parsed, { kind: 'relation', schema: 'we.ird:%', name: 'tab.le' })
    assert.deepEqual(parseNodeId(nodeId.schema('h-1')), { kind: 'schema', name: 'h-1' })
    assert.deepEqual(parseNodeId('garbage'), { kind: 'unknown' })
  })
})

describe('类型目录', () => {
  const catalog = new PgTypeCatalog()
  catalog.load([
    { oid: 20, typname: 'int8', typcategory: 'N', typelem: 0 },
    { oid: 23, typname: 'int4', typcategory: 'N', typelem: 0 },
    { oid: 17, typname: 'bytea', typcategory: 'U', typelem: 0 },
    { oid: 3802, typname: 'jsonb', typcategory: 'U', typelem: 0 },
    { oid: 1184, typname: 'timestamptz', typcategory: 'D', typelem: 0 },
    { oid: 1009, typname: '_text', typcategory: 'A', typelem: 25 },
  ])

  it('OID 映射到逻辑类型与原始类型名', () => {
    assert.equal(catalog.logical(20), 'bigint')
    assert.equal(catalog.logical(23), 'number')
    assert.equal(catalog.logical(17), 'bytes')
    assert.equal(catalog.logical(3802), 'json')
    assert.equal(catalog.logical(1184), 'timestamp')
    assert.equal(catalog.logical(1009), 'array')
    assert.equal(catalog.nativeType(1184), 'timestamptz')
    // 未知 OID 不能崩，退化成可读占位
    assert.equal(catalog.logical(999999), 'unknown')
    assert.equal(catalog.nativeType(999999), 'oid:999999')
  })
})

describe('大值截断', () => {
  it('超过 4KB 的文本只发预览并带回源 ref', () => {
    const big = 'x'.repeat(VALUE_PREVIEW_BYTES + 100)
    const out = normalizeCell(big, {
      logical: 'string',
      makeRef: () => ({ kind: 'resultCell', resultId: 'res_1' as never, row: 3, col: 1 }),
    })
    assert.ok(isTruncatedValue(out))
    assert.equal(out.encoding, 'utf8')
    assert.equal(out.preview.length, VALUE_PREVIEW_BYTES)
    assert.equal(out.byteLength, VALUE_PREVIEW_BYTES + 100)
    assert.deepEqual(out.ref, { kind: 'resultCell', resultId: 'res_1', row: 3, col: 1 })
  })

  it('4KB 以内原样返回，不造 ref 对象', () => {
    let refCalls = 0
    const out = normalizeCell('short', {
      logical: 'string',
      makeRef: () => {
        refCalls += 1
        return undefined
      },
    })
    assert.equal(out, 'short')
    assert.equal(refCalls, 0)
  })

  it('bytea 转 base64，超限时截断', () => {
    const small = normalizeCell(Buffer.from([1, 2, 3]), { logical: 'bytes' })
    assert.equal(small, Buffer.from([1, 2, 3]).toString('base64'))
    const huge = normalizeCell(Buffer.alloc(VALUE_PREVIEW_BYTES + 10, 7), { logical: 'bytes' })
    assert.ok(isTruncatedValue(huge))
    assert.equal(huge.encoding, 'base64')
    assert.equal(huge.byteLength, VALUE_PREVIEW_BYTES + 10)
  })

  it('行宽估算把截断值只按预览算', () => {
    const huge = normalizeCell('y'.repeat(100_000), { logical: 'string' })
    assert.ok(estimateCellBytes(huge) < VALUE_PREVIEW_BYTES + 200)
    assert.equal(estimateCellBytes(null), 1)
    assert.equal(estimateCellBytes(1.5), 8)
  })
})
