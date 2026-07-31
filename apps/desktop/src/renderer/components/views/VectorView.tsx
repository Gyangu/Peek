import type { ReactElement } from 'react'
import type { VectorViewState } from '@peek/core'
import { useConnection } from '../../state/workspaceStore'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'

/**
 * 向量检索视图。
 *
 * M1 只做占位：结果一旦有 resultId 就照常走列式缓存 + 虚拟化表格展示
 * （score / payload 就是普通列），真正的检索入口与向量编辑留到 M4（Qdrant）。
 */
export function VectorView({ view }: { view: VectorViewState }): ReactElement {
  const conn = useConnection(view.connId)
  const dim = view.queryVec?.length

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? view.connId}</span>
        <span className="sep" />
        <span className="mono">{view.collection}</span>
        <span className="sep" />
        <span>topK {view.topK}</span>
        {dim ? (
          <>
            <span className="sep" />
            <span>查询向量 {dim} 维</span>
          </>
        ) : null}
        {view.queryText ? (
          <>
            <span className="sep" />
            <span title={view.queryText}>文本入口</span>
          </>
        ) : null}
        <span className="grow" />
        <span style={{ color: 'var(--fg-faint)' }}>M4 完善</span>
      </div>

      <ViewError error={view.error} />

      <DataGrid
        connId={view.connId}
        resultId={view.resultId}
        emptyHint="向量检索视图（M4 实现检索入口）"
      />
    </>
  )
}
