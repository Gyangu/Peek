import type { ReactElement } from 'react'
import type { ViewId } from '@peek/core'
import { useT } from '../i18n'
import { useView } from '../state/workspaceStore'
import { InspectorView } from './views/InspectorView'
import { QueryView } from './views/QueryView'
import { TableView } from './views/TableView'
import { TreeView } from './views/TreeView'
import { VectorView } from './views/VectorView'

/** Dispatches on `ViewState.kind` to the concrete view (PLAN §5, five kinds). */
export function ViewHost({ viewId }: { viewId: ViewId }): ReactElement {
  const t = useT()
  const view = useView(viewId)
  if (!view) {
    return <div className="panel-empty">{t('view.gone', { viewId })}</div>
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
