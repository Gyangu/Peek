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
 *
 * ## Why a vector collection draws inert headers
 *
 * `vectorCollection` answers `sortable: false` here even though the *kind* can be
 * ordered — a qdrant scroll does accept `order_by`. The kind is simply not the
 * grain the question is asked at. Qdrant orders by payload keys that carry an
 * index and nothing else, which the driver reports per collection as
 * `CollectionBrowseStyle.sortableColumns`; the headers a table view of a vector
 * collection actually draws are exactly `id` and `payload` — the fixed default
 * projection, because `TableViewState` has no `columns` field and `startScan`
 * therefore never sends one. Neither name can ever be a payload index key, so
 * while the kind-level `true` was passed through, **every** header click on a
 * qdrant collection reached `assertBrowseSupported` and came back BAD_REQUEST.
 * Measured against the real style, on the most favourable collection there is
 * (one that does have an index):
 *
 *   sortableColumns: ['created_at']
 *   sort by id        -> BAD_REQUEST  Cannot order by id: …only…created_at
 *   sort by payload   -> BAD_REQUEST  Cannot order by payload: …only…created_at
 *
 * That was the Redis failure mode one driver over, so the header is withdrawn.
 * No capability is lost: an MCP `view.update` naming an indexed payload key is
 * accepted by the driver today and still is. What is given up is only a control
 * that could not succeed under any configuration.
 *
 * The honest control is a per-column one — a `sortableColumns` allowlist that
 * `DataGrid` uses to make just the unorderable headers inert — and it needs the
 * list to travel from `describeCollection` through the view state to the
 * renderer, which no code path does yet (`workspace.ts` fills `ViewSummary.browse`
 * from the kind table alone). Until it does, kind-level `false` is the answer
 * that matches what the user can actually click.
 */

export interface TableControls {
  /**
   * Column headers may dispatch a sort.
   *
   * All-or-nothing per view, which is why a vector collection gets `false`: the
   * grain that would let it be `true` is a per-column allowlist, and that does
   * not reach the renderer yet. See the note above.
   */
  sortable: boolean
  /** The prev/next-by-offset pager, with its `1 – 50` row-range label */
  offsetPager: boolean
  /** The forward-only pager driven by `ChunkDone.nextCursor` */
  cursorPager: boolean
}

export function tableControls(ref: CollectionRef): TableControls {
  const style = collectionBrowseStyle(ref)
  return {
    // Not `style.sortable` alone. The kind-level style says a qdrant scroll can
    // be ordered, which is true of the *store* and false of every header this
    // view draws (`id` and `payload`, neither of them a payload index key). A
    // header that BAD_REQUESTs under every configuration is not an affordance.
    sortable: style.sortable && ref.kind !== 'vectorCollection',
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
