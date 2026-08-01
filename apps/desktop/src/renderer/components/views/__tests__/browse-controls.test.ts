import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CollectionRef } from '@peek/core'
import { refreshPatch, tableControls } from '../browseControls'

/* ==================================================================
 * The collection browser must not draw a control the driver refuses.
 *
 * `collectionBrowseStyle` sat in core with zero consumers while the grid wired
 * `onSortColumn` for every collection kind, so clicking a column header on a
 * Redis keyspace dispatched a scan the driver rejects — the view emptied and the
 * user got an error panel from an affordance the UI itself had offered. These
 * tests are the consumer side of that; the driver side is asserted in
 * `driver-redis` ("refuses a native filter and a sort instead of quietly ignoring
 * them") and `driver-qdrant` ("orders a scroll by one payload key, and refuses
 * what the server cannot do").
 * ================================================================== */

const relation: CollectionRef = { kind: 'relation', schema: 'public', name: 'orders' }
const keyPattern: CollectionRef = { kind: 'keyPattern', pattern: 'user:*' }
const vectorCollection: CollectionRef = { kind: 'vectorCollection', collection: 'docs' }

describe('which browsing controls a collection kind gets', () => {
  test('a relation gets everything: SQL has ORDER BY and OFFSET', () => {
    assert.deepEqual(tableControls(relation), {
      sortable: true,
      offsetPager: true,
      cursorPager: false,
    })
  })

  test('a keyspace gets neither sorting nor an offset pager', () => {
    // SCAN order is an implementation detail of the hash table and changes as it
    // rehashes, so sorting one page describes nothing; an offset is a client-side
    // rescan of everything before it. RedisSession.scan answers BAD_REQUEST to a
    // sort, which is exactly why the header must be inert.
    assert.deepEqual(tableControls(keyPattern), {
      sortable: false,
      offsetPager: false,
      cursorPager: true,
    })
  })

  test('a vector collection may be ordered, but never by offset', () => {
    // qdrant's scroll accepts `order_by`; it just cannot combine it with an
    // offset, and emulating one costs a scroll per skipped point
    assert.deepEqual(tableControls(vectorCollection), {
      sortable: true,
      offsetPager: false,
      cursorPager: true,
    })
  })

  test('exactly one pager is offered for every kind', () => {
    for (const ref of [relation, keyPattern, vectorCollection]) {
      const c = tableControls(ref)
      assert.notEqual(c.offsetPager, c.cursorPager, `${ref.kind} must offer one pager, not two or none`)
    }
  })
})

describe('what a refresh sends', () => {
  test('a relation refreshes in place', () => {
    assert.deepEqual(refreshPatch(relation), { kind: 'table' })
  })

  test('a cursor-paged collection refreshes back to the first page', () => {
    // `offset` is what makes main drop the stored continuation token. Without it
    // the refetch would carry the token the last page handed back, so pressing
    // Refresh would page forward instead of re-reading the current page.
    assert.deepEqual(refreshPatch(keyPattern), { kind: 'table', offset: 0 })
    assert.deepEqual(refreshPatch(vectorCollection), { kind: 'table', offset: 0 })
  })
})
