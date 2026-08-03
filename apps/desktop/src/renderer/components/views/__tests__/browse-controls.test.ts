import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  VECTOR_RESULT_COLUMNS,
  assertBrowseSupported,
  isPeekError,
  refreshPatch,
  resolveCollectionBrowseStyle,
  type CollectionBrowseStyle,
  type CollectionRef,
} from '@peek/core'
import { tableControls } from '../browseControls'

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

  test('a vector collection gets neither a sortable header nor an offset pager', () => {
    // `sortable: true` here until 2026-08: that assertion encoded the bug rather
    // than the rule. qdrant's scroll does accept `order_by`, but only for payload
    // keys carrying an index, while the headers this view draws are the fixed
    // default projection `id` and `payload` — neither can ever be a payload index
    // key, so every header click came back BAD_REQUEST from `assertBrowseSupported`
    // on every collection, indexed or not. The kind-level control is therefore
    // withdrawn until a per-column `sortableColumns` allowlist reaches the
    // renderer; MCP `view.update` naming an indexed key is unaffected.
    //
    // No offset pager either: qdrant cannot combine `order_by` with an offset,
    // and emulating one costs a scroll per skipped point.
    assert.deepEqual(tableControls(vectorCollection), {
      sortable: false,
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

describe('the offered sort is one the driver would accept', () => {
  /**
   * The columns a table view of a vector collection actually draws. Fixed, not a
   * choice: `TableViewState` has no `columns` field, so `startScan` never sends
   * one, so qdrant answers with its default projection every time.
   */
  const DRAWN_HEADERS = [VECTOR_RESULT_COLUMNS.id, VECTOR_RESULT_COLUMNS.payload]

  /** What a sort dispatched from one of those headers would come back as */
  function refusal(style: CollectionBrowseStyle, column: string): string | null {
    try {
      assertBrowseSupported(style, { sort: [{ column, dir: 'asc' }] }, { driverId: 'qdrant' })
      return null
    } catch (e) {
      assert.ok(isPeekError(e), 'a refused browse must be a PeekError')
      assert.equal(e.code, 'BAD_REQUEST')
      return e.message
    }
  }

  test('every header a vector collection draws would be refused, so none is offered', () => {
    // The most favourable collection there is: one that *does* carry a payload
    // index. Even here `id` and `payload` are not orderable, because an index on
    // `created_at` is an index on `created_at`.
    const style = resolveCollectionBrowseStyle(vectorCollection, {
      sortable: true,
      offsetPaging: false,
      cursorPaging: true,
      sortableColumns: ['created_at'],
    })

    for (const column of DRAWN_HEADERS) {
      assert.ok(
        refusal(style, column) !== null,
        `${column} must be refused: it is drawn, and it is not a payload index key`,
      )
    }
    // …and one that would be accepted, so the assertion above is about these
    // particular column names and not about the style refusing everything
    assert.equal(refusal(style, 'created_at'), null, 'an indexed payload key stays orderable')

    // Therefore the header must be inert. This is the link that made the control
    // honest: if `tableControls` ever answers true again while the drawn headers
    // are still refused, this fails.
    assert.equal(
      tableControls(vectorCollection).sortable,
      false,
      'a sortable header may not be drawn when every column it could sort by is refused',
    )
  })

  test('a relation offers the sort because nothing narrows it', () => {
    // The counterweight: the rule is "do not offer what would be refused", not
    // "never offer". A relation declares no sortableColumns, so any column goes.
    const style = resolveCollectionBrowseStyle(relation, undefined)
    assert.equal(refusal(style, 'anything_at_all'), null)
    assert.equal(tableControls(relation).sortable, true)
  })

  test('a keyspace refuses every sort, and offers none', () => {
    const style = resolveCollectionBrowseStyle(keyPattern, undefined)
    assert.ok(refusal(style, 'key') !== null)
    assert.equal(tableControls(keyPattern).sortable, false)
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
