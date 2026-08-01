import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  assertBrowseSupported,
  collectionBrowseStyle,
  resolveCollectionBrowseStyle,
  type CollectionBrowseStyle,
  type PeekError,
  type VectorCollectionRef,
} from '@peek/core'

/**
 * One value, one verdict: the browse style a driver *declares* and the browse
 * style peek *resolves* have to refuse the same requests.
 *
 * They did not. `resolveCollectionBrowseStyle` folded an empty `sortableColumns`
 * into `sortable: false`, but every driver calls `assertBrowseSupported` with the
 * declaration it built itself — `driver-qdrant/src/session.ts` passes
 * `browseStyleOf(...)` straight in — and that function read `sortable` on its
 * own. So a qdrant collection with no payload index (the list is built from the
 * indexes, so it comes out empty) went past the "cannot order this collection"
 * branch and was refused by the *next* one, with:
 *
 *     Cannot order by id: this collection can only be ordered by
 *
 * — a sentence that ends where the list should have been, and that tells the
 * caller to pick from an empty set. The refinement is now normalized inside
 * `assertBrowseSupported`, so which of the two values a driver hands over no
 * longer changes the answer.
 */

const REF: VectorCollectionRef = { kind: 'vectorCollection', collection: 'peek_test_docs' }

/** What `browseStyleOf` in the qdrant driver produces for a collection with no payload index. */
const DECLARED_NO_INDEXES: CollectionBrowseStyle = {
  ...collectionBrowseStyle(REF),
  sortableColumns: [],
  filterableColumns: ['id'],
}

function refusal(style: CollectionBrowseStyle): PeekError {
  try {
    assertBrowseSupported(style, { sort: [{ column: 'id', dir: 'asc' }] }, { driverId: 'qdrant' })
  } catch (err) {
    return err as PeekError
  }
  throw new Error('expected assertBrowseSupported to refuse')
}

describe('browse style: the declaration and the resolution refuse alike', () => {
  test('an empty sortableColumns is refused as "cannot order", not as "order by nothing"', () => {
    const err = refusal(DECLARED_NO_INDEXES)
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /cannot order this collection/)
    // The old message ended on the word "by" with an empty list behind it
    assert.doesNotMatch(err.message, /can only be ordered by\s*$/)
  })

  test('the raw declaration and the resolved style produce the identical refusal', () => {
    const resolved = resolveCollectionBrowseStyle(REF, DECLARED_NO_INDEXES)
    assert.equal(resolved.sortable, false, 'resolution already folded the empty list in')
    assert.equal(refusal(DECLARED_NO_INDEXES).message, refusal(resolved).message)
  })

  test('a non-empty list still names the columns that would have worked', () => {
    const declared: CollectionBrowseStyle = {
      ...collectionBrowseStyle(REF),
      sortableColumns: ['lang', 'n'],
    }
    const err = refusal(declared)
    assert.match(err.message, /Cannot order by id/)
    assert.match(err.message, /can only be ordered by lang, n/)
    // and the columns that are on the list are accepted
    assert.doesNotThrow(() =>
      assertBrowseSupported(declared, { sort: [{ column: 'lang', dir: 'asc' }] }, { driverId: 'qdrant' }),
    )
  })

  test('the kind-level answers are untouched', () => {
    // relation: everything is allowed
    assert.doesNotThrow(() =>
      assertBrowseSupported(
        collectionBrowseStyle({ kind: 'relation', schema: 'public', name: 'harness' }),
        { sort: [{ column: 'id', dir: 'asc' }] },
        { driverId: 'postgres' },
      ),
    )
    // keyPattern: a SCAN cannot be ordered at all
    const redis = refusal(collectionBrowseStyle({ kind: 'keyPattern', pattern: 'peek:test:*' }))
    assert.match(redis.message, /cannot order this collection/)
    // an unsorted request is never refused, whatever the style says
    assert.doesNotThrow(() =>
      assertBrowseSupported(DECLARED_NO_INDEXES, { offset: 10 }, { driverId: 'qdrant' }),
    )
  })
})
