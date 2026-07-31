import type { ReactElement } from 'react'
import type { ViewId } from '@peek/core'
import { useView } from '../state/workspaceStore'
import { InspectorView } from './views/InspectorView'
import { QueryView } from './views/QueryView'
import { TableView } from './views/TableView'
import { TreeView } from './views/TreeView'
import { VectorView } from './views/VectorView'

/** 按 ViewState.kind 分发到具体视图组件（PLAN 第 5 节五种 kind） */
export function ViewHost({ viewId }: { viewId: ViewId }): ReactElement {
  const view = useView(viewId)
  if (!view) {
    return <div className="panel-empty">视图 {viewId} 已不存在</div>
  }
  switch (view.kind) {
    case 'table':
      return <TableView view={view} />
    case 'query':
      return <QueryView view={view} />
    case 'tree':
      return <TreeView view={view} />
    case 'inspector':
      return <InspectorView view={view} />
    case 'vector':
      return <VectorView view={view} />
  }
}
