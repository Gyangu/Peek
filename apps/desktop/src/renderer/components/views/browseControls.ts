import { collectionBrowseStyle, type CollectionRef, type ViewPatch } from '@peek/core'

/**
 * Which controls the collection browser is allowed to draw, per collection kind.
 *
 * The rule this module exists to keep: **an affordance the driver will answer
 * BAD_REQUEST to must not be drawn.** A relation gives ordering and random access
 * for free; a cursor store gives neither and says so — `RedisSession.scan` rejects
 * a sort outright, and qdrant's scroll cannot combine `order_by` with an offset.
 * Before this was consulted, clicking a column header on a Redis keyspace produced
 * an error panel from a control the UI itself had offered.
 *
 * It is a separate module from `TableView.tsx` so it can be asserted: the test
 * runner strips TypeScript types but does not compile JSX, so nothing in a `.tsx`
 * file is reachable from a unit test.
 */

export interface TableControls {
  /** Column headers may dispatch a sort */
  sortable: boolean
  /** The prev/next-by-offset pager, with its `1 – 50` row-range label */
  offsetPager: boolean
  /** The forward-only pager driven by `ChunkDone.nextCursor` */
  cursorPager: boolean
}

export function tableControls(ref: CollectionRef): TableControls {
  const style = collectionBrowseStyle(ref)
  return {
    sortable: style.sortable,
    offsetPager: style.offsetPaging,
    // Exactly one pager is drawn: the offset one where rows have addresses, the
    // cursor one where the only way forward is the continuation token
    cursorPager: !style.offsetPaging && style.cursorPaging,
  }
}

/**
 * The patch a Refresh sends.
 *
 * On a cursor-paged collection it carries `offset: 0`, and that is load-bearing
 * rather than cosmetic: `offset` is what makes main drop the stored continuation
 * token (`handlers/view.ts`, `invalidatesCursor`), so sending it is precisely
 * "forget where we were". A patch that changed nothing would re-run the scan with
 * the token the last page handed back — that is, refresh would silently page
 * forward.
 */
export function refreshPatch(ref: CollectionRef): ViewPatch {
  return collectionBrowseStyle(ref).offsetPaging
    ? { kind: 'table' }
    : { kind: 'table', offset: 0 }
}
