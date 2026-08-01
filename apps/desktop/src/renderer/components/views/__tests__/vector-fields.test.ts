import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NamespaceNode } from '@peek/core'
import {
  findCollectionNodeId,
  namedVectorsOf,
  parsePointId,
  parsePositiveInt,
  parseScore,
} from '../vectorFields'

/* ==================================================================
 * The vector view's pure half.
 *
 * Everything here decides what leaves the window as part of a
 * `VectorSearchRequest`, which is why it is worth pinning down away from the
 * DOM: a point id that changes type on the way out is a search against a point
 * that does not exist, and the driver's error ("not found") gives no hint that
 * the renderer is what altered it.
 * ================================================================== */

describe('parsePointId', () => {
  it('reads a bare integer as a number', () => {
    assert.equal(parsePointId('42'), 42)
    assert.equal(parsePointId('0'), 0)
    // Surrounding whitespace is a paste artefact, not part of the id.
    assert.equal(parsePointId('  7  '), 7)
  })

  it('keeps a UUID as a string', () => {
    const uuid = '9c9d5a3e-1f3b-4a2e-9b1f-3c5d7e9f1a2b'
    assert.equal(parsePointId(uuid), uuid)
  })

  it('keeps ids that a JS number would corrupt', () => {
    // Leading zeros are significant to whoever assigned the id, and 007 !== 7.
    assert.equal(parsePointId('007'), '007')
    // Past MAX_SAFE_INTEGER the round trip through a double loses digits, so the
    // digits are forwarded verbatim rather than silently rounded.
    assert.equal(parsePointId('9007199254740993'), '9007199254740993')
  })

  it('treats a blank box as no query at all', () => {
    assert.equal(parsePointId(''), null)
    assert.equal(parsePointId('   '), null)
  })

  it('does not turn decimals or signs into numbers', () => {
    // Only unsigned integers are point ids; anything else stays as typed so the
    // store, not the renderer, decides that it is invalid.
    assert.equal(parsePointId('1.5'), '1.5')
    assert.equal(parsePointId('-3'), '-3')
    assert.equal(parsePointId('1e3'), '1e3')
  })
})

describe('parsePositiveInt', () => {
  it('accepts positive integers only', () => {
    assert.equal(parsePositiveInt('10'), 10)
    assert.equal(parsePositiveInt('1'), 1)
    assert.equal(parsePositiveInt('0'), null)
    assert.equal(parsePositiveInt('-5'), null)
    assert.equal(parsePositiveInt('2.5'), null)
    assert.equal(parsePositiveInt('abc'), null)
  })

  it('returns null for a blank box, meaning "leave topK alone"', () => {
    assert.equal(parsePositiveInt(''), null)
  })
})

describe('parseScore', () => {
  it('keeps zero and negatives, which a dot-product metric produces', () => {
    assert.equal(parseScore('0'), 0)
    assert.equal(parseScore('-0.25'), -0.25)
    assert.equal(parseScore('0.87'), 0.87)
  })

  it('reads only a blank box as "no threshold"', () => {
    assert.equal(parseScore(''), null)
    assert.equal(parseScore('  '), null)
    assert.equal(parseScore('nonsense'), null)
  })
})

/* ------------------------------------------------------------------ */

function node(partial: Partial<NamespaceNode> & { id: string }): NamespaceNode {
  return { name: partial.id, kind: 'collection', hasChildren: false, ...partial }
}

describe('findCollectionNodeId', () => {
  const nodes: NamespaceNode[] = [
    node({ id: 'collection:docs', ref: { kind: 'vectorCollection', collection: 'docs' } }),
    node({ id: 'collection:images', ref: { kind: 'vectorCollection', collection: 'images' } }),
    // A relational neighbour: same tree shape, different ref kind.
    node({ id: 'relation:public.docs', ref: { kind: 'relation', schema: 'public', name: 'docs' } }),
  ]

  it('finds the node by what it points at, not by its id spelling', () => {
    assert.equal(findCollectionNodeId(nodes, 'images'), 'collection:images')
  })

  it('never matches a collection of another kind with the same name', () => {
    // `relation:public.docs` is also called docs; matching it would send the
    // vector view looking for named vectors inside a SQL table.
    assert.equal(findCollectionNodeId([nodes[2]!], 'docs'), null)
  })

  it('returns null when the level has not been loaded', () => {
    assert.equal(findCollectionNodeId([], 'docs'), null)
  })
})

describe('namedVectorsOf', () => {
  it('collects the driver-declared vector names in order', () => {
    const children: NamespaceNode[] = [
      node({ id: 'vector:docs:body', kind: 'column', meta: { vectorName: 'body', size: 3 } }),
      node({ id: 'vector:docs:title', kind: 'column', meta: { vectorName: 'title', size: 4 } }),
      node({ id: 'payloadIndex:docs:lang', kind: 'index', meta: { payloadField: 'lang' } }),
    ]
    assert.deepEqual(namedVectorsOf(children), ['body', 'title'])
  })

  it('ignores meta that is not a usable name', () => {
    // `meta` is the driver's own dialect and core does not interpret it, so
    // anything unexpected is skipped rather than rendered as a suggestion.
    const children: NamespaceNode[] = [
      node({ id: 'a', meta: { vectorName: '' } }),
      node({ id: 'b', meta: { vectorName: 42 } }),
      node({ id: 'c', meta: {} }),
      node({ id: 'd' }),
      node({ id: 'e', meta: { vectorName: 'body' } }),
    ]
    assert.deepEqual(namedVectorsOf(children), ['body'])
  })

  it('does not repeat a name', () => {
    const children: NamespaceNode[] = [
      node({ id: 'a', meta: { vectorName: 'body' } }),
      node({ id: 'b', meta: { vectorName: 'body' } }),
    ]
    assert.deepEqual(namedVectorsOf(children), ['body'])
  })

  it('reads an unnamed-vector collection as "no suggestions"', () => {
    // Not an error: the box stays free text and the driver remains the authority.
    assert.deepEqual(namedVectorsOf([]), [])
  })
})
