import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VALUE_PREVIEW_BYTES, isTruncatedValue } from '@peek/core'
import { ParamList, buildScanSql, quoteIdent, renderFilter, renderOrderBy } from '../sql'
import { PgTypeCatalog } from '../type-catalog'
import { estimateCellBytes, normalizeCell } from '../values'
import { nodeId, parseNodeId } from '../introspect'

describe('identifier quoting', () => {
  it('doubles embedded quotes so an injection string cannot escape', () => {
    assert.equal(quoteIdent('harness'), '"harness"')
    assert.equal(quoteIdent('a"b'), '"a""b"')
    // The classic injection attempt: the whole thing becomes one identifier,
    // which semantically just means "no such table"
    assert.equal(quoteIdent('t"; DROP TABLE x; --'), '"t""; DROP TABLE x; --"')
  })

  it('allows spaces and non-ASCII names, rejects the empty string', () => {
    assert.equal(quoteIdent('my table'), '"my table"')
    // Deliberate fixture: a non-ASCII identifier. Do not "translate" it — the
    // point of this case is that a name outside ASCII survives quoting intact.
    assert.equal(quoteIdent('用户表'), '"用户表"')
    assert.throws(() => quoteIdent(''))
  })
})

describe('filter parameterization', () => {
  it('values always become $n, never SQL text', () => {
    const p = new ParamList()
    const frag = renderFilter({ column: 'name', op: 'eq', value: "x'; DROP TABLE y; --" }, p)
    assert.equal(frag, '"name" = $1')
    assert.deepEqual(p.list, ["x'; DROP TABLE y; --"])
  })

  it('in expands to one placeholder per element; an empty array degrades to false', () => {
    const p = new ParamList()
    assert.equal(renderFilter({ column: 'id', op: 'in', value: [1, 2, 3] }, p), '"id" IN ($1, $2, $3)')
    assert.deepEqual(p.list, [1, 2, 3])
    assert.equal(renderFilter({ column: 'id', op: 'in', value: [] }, new ParamList()), 'false')
  })

  it('contains uses strpos, so user input is not read as a wildcard', () => {
    const p = new ParamList()
    const frag = renderFilter({ column: 'body', op: 'contains', value: '100%' }, p)
    assert.equal(frag, 'strpos("body"::text, $1) > 0')
    assert.deepEqual(p.list, ['100%'])
  })

  it('isNull takes no parameter, and a comparison missing its value is rejected', () => {
    const p = new ParamList()
    assert.equal(renderFilter({ column: 'c', op: 'isNull' }, p), '"c" IS NULL')
    assert.equal(p.count, 0)
    assert.throws(() => renderFilter({ column: 'c', op: 'eq' }, p))
  })
})

describe('ordering and scan statements', () => {
  it('ORDER BY renders direction and NULLS placement', () => {
    assert.equal(
      renderOrderBy([{ column: 'a', dir: 'desc', nulls: 'last' }, { column: 'b', dir: 'asc' }]),
      ' ORDER BY "a" DESC NULLS LAST, "b" ASC',
    )
  })

  it('collectionScan passes limit/offset as parameters too', () => {
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

describe('node id encoding', () => {
  it('stays reversible for names containing dots, colons and percent signs', () => {
    const id = nodeId.relation('we.ird:%', 'tab.le')
    const parsed = parseNodeId(id)
    assert.deepEqual(parsed, { kind: 'relation', schema: 'we.ird:%', name: 'tab.le' })
    assert.deepEqual(parseNodeId(nodeId.schema('h-1')), { kind: 'schema', name: 'h-1' })
    assert.deepEqual(parseNodeId('garbage'), { kind: 'unknown' })
  })
})

describe('type catalog', () => {
  const catalog = new PgTypeCatalog()
  catalog.load([
    { oid: 20, typname: 'int8', typcategory: 'N', typelem: 0 },
    { oid: 23, typname: 'int4', typcategory: 'N', typelem: 0 },
    { oid: 17, typname: 'bytea', typcategory: 'U', typelem: 0 },
    { oid: 3802, typname: 'jsonb', typcategory: 'U', typelem: 0 },
    { oid: 1184, typname: 'timestamptz', typcategory: 'D', typelem: 0 },
    { oid: 1009, typname: '_text', typcategory: 'A', typelem: 25 },
  ])

  it('maps OIDs to logical types and native type names', () => {
    assert.equal(catalog.logical(20), 'bigint')
    assert.equal(catalog.logical(23), 'number')
    assert.equal(catalog.logical(17), 'bytes')
    assert.equal(catalog.logical(3802), 'json')
    assert.equal(catalog.logical(1184), 'timestamp')
    assert.equal(catalog.logical(1009), 'array')
    assert.equal(catalog.nativeType(1184), 'timestamptz')
    // An unknown OID must not blow up; it degrades to a readable placeholder
    assert.equal(catalog.logical(999999), 'unknown')
    assert.equal(catalog.nativeType(999999), 'oid:999999')
  })
})

describe('large value truncation', () => {
  it('text over 4KB travels as a preview carrying a re-fetch ref', () => {
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

  it('anything within 4KB is returned as is, with no ref object built', () => {
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

  it('bytea becomes base64, truncated when over the limit', () => {
    const small = normalizeCell(Buffer.from([1, 2, 3]), { logical: 'bytes' })
    assert.equal(small, Buffer.from([1, 2, 3]).toString('base64'))
    const huge = normalizeCell(Buffer.alloc(VALUE_PREVIEW_BYTES + 10, 7), { logical: 'bytes' })
    assert.ok(isTruncatedValue(huge))
    assert.equal(huge.encoding, 'base64')
    assert.equal(huge.byteLength, VALUE_PREVIEW_BYTES + 10)
  })

  it('row width estimation counts only the preview of a truncated value', () => {
    const huge = normalizeCell('y'.repeat(100_000), { logical: 'string' })
    assert.ok(estimateCellBytes(huge) < VALUE_PREVIEW_BYTES + 200)
    assert.equal(estimateCellBytes(null), 1)
    assert.equal(estimateCellBytes(1.5), 8)
  })
})
