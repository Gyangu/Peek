import { useCallback } from 'react'
import type { ReactElement } from 'react'
import type { SortSpec, TableViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import { dispatch } from '../../state/dispatch'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'

const PAGE_SIZES = [100, 200, 500, 1000, 5000]

/**
 * 集合浏览视图（表 / keyspace / collection 统一走这个）。
 * 所有交互都翻译成 view.update 命令，界面等 patch 回来再变。
 */
export function TableView({ view }: { view: TableViewState }): ReactElement {
  const { id: viewId, connId, ref, sort, filter, page, resultId } = view
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
        <span className="mono" title={collectionRefLabel(ref)}>
          {collectionRefLabel(ref)}
        </span>
        <span className="sep" />
        <button className="ghost" onClick={refresh} title="重新取数">
          ⟳ 刷新
        </button>
        <span className="sep" />
        <button
          className="ghost"
          disabled={page.offset <= 0}
          onClick={() => {
            setOffset(page.offset - page.limit)
          }}
        >
          ← 上一页
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
          下一页 →
        </button>
        <span className="sep" />
        <select
          value={page.limit}
          onChange={(e) => {
            setLimit(Number(e.target.value))
          }}
          title="每页行数"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} 行/页
            </option>
          ))}
        </select>
        {filter && filter.length > 0 ? (
          <>
            <span className="sep" />
            <span title={JSON.stringify(filter)}>筛选 {filter.length} 条</span>
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
        emptyHint="等待 main 发起扫描…"
      />
    </>
  )
}
