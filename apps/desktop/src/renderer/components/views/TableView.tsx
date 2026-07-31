import { useCallback } from 'react'
import type { ReactElement } from 'react'
import type { SortSpec, TableViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'

const PAGE_SIZES = [100, 200, 500, 1000, 5000]

/**
 * Collection browser (tables, keyspaces and vector collections all land here).
 * Every interaction becomes a `view.update` command; the UI only changes once the
 * patch comes back.
 */
export function TableView({ view }: { view: TableViewState }): ReactElement {
  const { id: viewId, connId, ref, sort, filter, page, resultId } = view
  const t = useT()
  const sortKey = JSON.stringify(sort ?? [])

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

  const refresh = (): void => {
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
        <button className="ghost" onClick={refresh} title={t('table.refreshTitle')}>
          ⟳ {t('table.refresh')}
        </button>
        <span className="sep" />
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

      <DataGrid
        connId={connId}
        resultId={resultId}
        sort={sort}
        onSortColumn={onSortColumn}
        emptyHint={t('table.waitingForScan')}
      />
    </>
  )
}
