import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DRIVER_CAPABILITIES,
  QDRANT_VECTOR_FIELD,
  buildVectorResultSchema,
  encodeScanCursor,
  isPeekError,
  parseQdrantField,
  qdrantPayloadField,
  tryDecodeScanCursor,
} from '@peek/core'
import { collectionNodeId, parseCollectionNodeId } from '../collections'
import { qdrantDriver, requireQdrantConfig } from '../driver'
import { buildRowShape, pointFieldRef, pointIdToCell } from '../points'
import { decodeScrollOffset, encodeScrollOffset } from '../scroll'

/**
 * Contract tests: no qdrant server involved. They pin what the rest of the system
 * depends on — the advertised capability set, the column layout of a scroll and a
 * search, the scroll-offset encoding, and the vector/payload field convention —
 * so the M4 implementation cannot drift away from them.
 */

describe('driver-qdrant contract', () => {
  it('advertises exactly the capability set core declares for qdrant', () => {
    assert.deepEqual([...qdrantDriver.capabilities].sort(), [...DRIVER_CAPABILITIES.qdrant].sort())
    assert.equal(qdrantDriver.meta.id, 'qdrant')
    // No `cancel`: an HTTP request is aborted client-side, not interrupted
    // server-side, and a driver must not advertise what it cannot honour
    assert.equal(qdrantDriver.capabilities.has('cancel'), false)
  })

  it('rejects a config routed to the wrong driver', () => {
    assert.equal(
      requireQdrantConfig({ driverId: 'qdrant', url: 'http://localhost:6333' }).driverId,
      'qdrant',
    )
    try {
      requireQdrantConfig({ driverId: 'redis', url: 'redis://localhost:6379' })
      assert.fail('a redis config must not be accepted')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })

  it('keeps the payload in one json column by default, and flattens only on request', () => {
    const scroll = buildRowShape({ payloadColumns: [], withScore: false, withVector: false })
    assert.deepEqual(scroll.columns.map((c) => c.name), ['id', 'payload'])
    assert.equal(scroll.columns[1]?.logical, 'json')

    const search = buildRowShape({ payloadColumns: [], withScore: true, withVector: false })
    assert.deepEqual(search.columns.map((c) => c.name), ['id', 'score', 'payload'])

    const flat = buildRowShape({ payloadColumns: ['lang', 'title'], withScore: true, withVector: true })
    assert.deepEqual(flat.columns.map((c) => c.name), ['id', 'score', 'lang', 'title', 'vector'])
    // The vector column is peekable: its body travels through valuePeek, never in a chunk
    assert.equal(flat.columns.at(-1)?.peekable, true)
  })

  it('agrees with core about the result schema — there is one implementation of the rule', () => {
    assert.deepEqual(
      buildRowShape({ payloadColumns: ['a'], withScore: true, withVector: false }).columns,
      buildVectorResultSchema({ payloadColumns: ['a'], withScore: true }),
    )
  })

  it('round-trips a scroll offset without confusing point 42 with point "42"', () => {
    assert.equal(decodeScrollOffset(encodeScrollOffset(42)), 42)
    assert.equal(decodeScrollOffset(encodeScrollOffset('42')), '42')
    const uuid = '9d3f2b1a-0000-4000-8000-000000000001'
    assert.equal(decodeScrollOffset(encodeScrollOffset(uuid)), uuid)
    // The boundary rides inside core's envelope, so the driver that minted it is
    // part of the token
    assert.deepEqual(tryDecodeScanCursor(encodeScrollOffset(42)), {
      driverId: 'qdrant',
      boundary: '42',
      skip: 0,
    })
  })

  /**
   * The bug the shared envelope closes.
   *
   * `decodeScrollOffset` used to read *anything* that was not JSON as a literal
   * string point id. So a redis continuation — or a stale postgres row offset, or
   * a hand-typed string — became a point that does not exist, the scroll started
   * from nowhere, and the caller got an empty page with no error. A wrong answer
   * is worse than a refusal, so now it is a refusal.
   */
  it('refuses a continuation another driver minted instead of scrolling from nowhere', () => {
    for (const foreign of [
      encodeScanCursor({ driverId: 'redis', boundary: '238', skip: 17 }),
      encodeScanCursor({ driverId: 'postgres', boundary: '400', skip: 0 }),
      '9d3f2b1a-0000-4000-8000-000000000001',
      'not a token at all',
      '',
    ]) {
      try {
        decodeScrollOffset(foreign)
        assert.fail(`${foreign} must not be accepted as a qdrant scroll offset`)
      } catch (err) {
        assert.ok(isPeekError(err), 'the refusal has to be a structured error')
        assert.equal(err.code, 'BAD_REQUEST')
      }
    }
  })

  it('keeps a numeric point id numeric', () => {
    assert.equal(pointIdToCell(42), 42)
    assert.equal(pointIdToCell('42'), '42')
  })

  it('addresses vectors and payload keys unambiguously', () => {
    assert.deepEqual(parseQdrantField(QDRANT_VECTOR_FIELD), { target: 'vector' })
    assert.deepEqual(parseQdrantField('vector:title'), { target: 'vector', name: 'title' })
    assert.deepEqual(parseQdrantField('lang'), { target: 'payload', key: 'lang' })
    // A payload key that collides with the vector convention is escaped
    assert.equal(qdrantPayloadField('vector'), 'payload:vector')
    assert.deepEqual(parseQdrantField(qdrantPayloadField('vector')), { target: 'payload', key: 'vector' })
    assert.equal(qdrantPayloadField('lang'), 'lang')

    assert.deepEqual(pointFieldRef('docs', 7, 'vector'), {
      kind: 'qdrantPoint',
      collection: 'docs',
      pointId: 7,
      field: 'vector',
    })
  })

  it('round-trips node ids, including payload fields containing the separator', () => {
    assert.deepEqual(parseCollectionNodeId(collectionNodeId.collection('docs')), {
      kind: 'collection',
      name: 'docs',
    })
    assert.deepEqual(parseCollectionNodeId(collectionNodeId.vector('docs', 'title')), {
      kind: 'vector',
      collection: 'docs',
      name: 'title',
    })
    assert.deepEqual(parseCollectionNodeId(collectionNodeId.payloadIndex('docs', 'meta:lang')), {
      kind: 'payloadIndex',
      collection: 'docs',
      field: 'meta:lang',
    })
    assert.equal(parseCollectionNodeId('nonsense').kind, 'unknown')
  })
})
