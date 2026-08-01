import { useCallback } from 'react'
import type { ReactElement } from 'react'
import type { SortSpec, TableViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { useConnection, useResultMeta } from '../../state/workspaceStore'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'
import { CacheGapNotice, CancelButton } from './ResultControls'
import { refreshPatch, tableControls } from './browseControls'

const PAGE_SIZES = [100, 200, 500, 1000, 5000]

/**
 * Collection browser (tables, keyspaces and vector collections all land here).
 * Every interaction becomes a `view.update` command; the UI only changes once the
 * patch comes back.
 *
 * ## Why the toolbar differs by collection kind
 *
 * A relation gives ordering and random access for free; a cursor store gives
 * neither, and says so with BAD_REQUEST. `collectionBrowseStyle` is core's answer
 * for which is which, and this view is where it is spent: **an affordance the
 * driver will refuse must not be drawn.** Clicking a column header on a Redis
 * keyspace used to reach `RedisSession.scan`, which rejects a sort by design, so
 * the user got an error panel from a control the UI itself had offered.
 */
export function TableView({ view }: { view: TableViewState }): ReactElement {
  const { id: viewId, connId, ref, sort, filter, page, resultId, cursorToken } = view
  const t = useT()
  const conn = useConnection(connId)
  const meta = useResultMeta(resultId)
  const sortKey = JSON.stringify(sort ?? [])
  const controls = tableControls(ref)

  // Same test the query and vector views use: the result set is still streaming,
  // or main has moved the view to loading and the first frame has not landed.
  const running = meta?.status === 'running' || view.status === 'loading'

  const onSortColumn = useCallback(
    (column: string) => {
      const current: SortSpec[] = JSON.parse(sortKey) as SortSpec[]
      const hit = current.find((s) => s.column === column)
      let next: SortSpec[]
      if (!hit) next = [{ column, dir: 'asc' }]
      else if (hit.dir === 'asc') next = [{ column, dir: 'desc' }]
      else next = []
      void dispatch('view.update', {
        viewId,
        patch: { kind: 'table', sort: next },
        refresh: true,
      })
    },
    [viewId, sortKey],
  )

  const setOffset = (offset: number): void => {
    void dispatch('view.update', {
      viewId,
      patch: { kind: 'table', offset: Math.max(0, offset) },
      refresh: true,
    })
  }

  const setLimit = (limit: number): void => {
    void dispatch('view.update', {
      viewId,
      patch: { kind: 'table', limit, offset: 0 },
      refresh: true,
    })
  }

  /** See `refreshPatch`: on a cursor-paged collection a refresh restarts at page one */
  const refresh = (): void => {
    void dispatch('view.update', { viewId, patch: refreshPatch(ref), refresh: true })
  }

  /**
   * Advance one page on a cursor store.
   *
   * No field of the patch changes: main already holds the `nextCursor` the last
   * page ended with (`TableViewState.cursorToken`), and re-running the scan with
   * it *is* the next page. There is no previous-page button because a SCAN cursor
   * and a scroll offset only address forward — the honest backward move is
   * Refresh, which starts over.
   */
  const nextCursorPage = (): void => {
    void dispatch('view.update', { viewId, patch: { kind: 'table' }, refresh: true })
  }

  return (
    <>
      <div className="toolbar">
        {/* A collection label such as `public.orders` is an identifier, never translated. */}
        <span className="mono" title={collectionRefLabel(ref)}>
          {collectionRefLabel(ref)}
        </span>
        <span className="sep" />
        <button
          className="ghost"
          onClick={refresh}
          title={controls.offsetPager ? t('table.refreshTitle') : t('table.refreshCursorTitle')}
        >
          ⟳ {t('table.refresh')}
        </button>
        {/* A collection scan is the longest-running thing peek does — a million-row
            table walks for minutes — and this view was the one with no way to stop
            it. It has one now, on the same control the other two result views use. */}
        <CancelButton viewId={viewId} conn={conn} running={running} />
        <span className="sep" />
        {controls.offsetPager ? (
          <>
            <button
              className="ghost"
              disabled={page.offset <= 0}
              onClick={() => {
                setOffset(page.offset - page.limit)
              }}
            >
              ← {t('table.prevPage')}
            </button>
            <span className="mono">
              {page.offset + 1} – {page.offset + page.limit}
            </span>
            <button
              className="ghost"
              onClick={() => {
                setOffset(page.offset + page.limit)
              }}
            >
              {t('table.nextPage')} →
            </button>
          </>
        ) : (
          <>
            {/* No row-range label: without random access there is no honest row
                number to show, and "1 – 50" on the fourth page is simply false. */}
            <span title={t('table.cursorPagedTitle')}>{t('table.cursorPaged')}</span>
            <button
              className="ghost"
              disabled={cursorToken === undefined}
              onClick={nextCursorPage}
              title={cursorToken === undefined ? t('table.noMorePages') : t('table.cursorPagedTitle')}
            >
              {t('table.nextPage')} →
            </button>
          </>
        )}
        <span className="sep" />
        <select
          value={page.limit}
          onChange={(e) => {
            setLimit(Number(e.target.value))
          }}
          title={t('table.pageSizeTitle')}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {t('table.pageSize', { n })}
            </option>
          ))}
        </select>
        {filter && filter.length > 0 ? (
          <>
            <span className="sep" />
            {/* The tooltip is the raw filter JSON — evidence, shown as it is. */}
            <span title={JSON.stringify(filter)}>{t('table.filters', { count: filter.length })}</span>
          </>
        ) : null}
        <span className="grow" />
      </div>

      <ViewError error={view.error} />
      {/* `refresh` re-runs this page of the scan; on a cursor-paged collection it
          restarts from the first page, which `refreshPatch` already documents. */}
      <CacheGapNotice
        resultId={resultId}
        disabled={running || conn?.status !== 'ready'}
        onRefetch={refresh}
      />

      {/* A grid with no `onSortColumn` has inert headers (DataGridProps), which is
          exactly what a collection the driver cannot order should offer. */}
      <DataGrid
        connId={connId}
        view={view}
        resultId={resultId}
        sort={sort}
        {...(controls.sortable ? { onSortColumn } : {})}
        emptyHint={t('table.waitingForScan')}
      />
    </>
  )
}
