import type { ViewState } from '@peek/core'

/**
 * "Is the next result set an answer to the same question?"
 *
 * `DataGrid` used to key everything off `resultId` alone: a new one meant drop
 * the dragged column widths, drop the selection, scroll back to the top. That is
 * right for *a different question* — a new sort, a new page, a new statement —
 * and wrong for *the same question asked again*, which is what Refresh has always
 * been and what auto-refresh is every few seconds. A grid that jumps to row zero
 * and forgets its column widths on every tick cannot be watched.
 *
 * So the reset condition moves from "the result changed" to "the shape changed",
 * and this is where the shape is defined. It is a plain string so the comparison
 * is a `!==` in a `useEffect` dependency, and it lives in a `.ts` file because
 * the test runner strips types but does not compile JSX — nothing inside a
 * `.tsx` is reachable from a unit test.
 *
 * ## What is in a shape, and what is not
 *
 * In: everything that changes *which rows come back* — including `offset`, since
 * paging really is a different question and really should land at the top of the
 * new page.
 *
 * Out: `resultId` itself, `status`, `error`, the title, the tab's provisional
 * flag, and `autoRefreshMs`. Turning the timer on must not itself count as a
 * change of question, or switching it on would scroll the reader to the top.
 *
 * A view kind with no fetch of its own answers with its own id, which no other
 * view can equal and which never changes — either branch of the comparison is
 * then meaningless, and "always reset" is the safe reading.
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md §2.6
 */
export function fetchShapeKey(view: ViewState): string {
  switch (view.kind) {
    case 'table':
      return JSON.stringify([
        'table',
        view.ref,
        view.sort ?? null,
        view.filter ?? null,
        view.page.offset,
        view.page.limit,
      ])
    case 'query':
      return JSON.stringify(['query', view.text])
    case 'vector':
      return JSON.stringify([
        'vector',
        view.collection,
        view.queryVec ?? null,
        view.queryPointId ?? null,
        view.vectorName ?? null,
        view.topK,
        view.scoreThreshold ?? null,
        view.filter ?? null,
      ])
    case 'plugin':
      return JSON.stringify(['plugin', view.pluginKind, view.state])
    default:
      return JSON.stringify(['view', view.id])
  }
}
