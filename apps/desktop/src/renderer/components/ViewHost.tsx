import type { ReactElement } from 'react'
import type { ViewId } from '@peek/core'
import { useT } from '../i18n'
import { lookupViewKind } from '../plugins/viewKinds'
import { useView } from '../state/workspaceStore'
import { ChatView } from './chat'
import { InspectorView } from './views/InspectorView'
import { QueryView } from './views/QueryView'
import { TableView } from './views/TableView'
import { TreeView } from './views/TreeView'
import { VectorView } from './views/VectorView'

/**
 * Dispatches on `ViewState.kind` to the concrete view.
 *
 * Seven kinds: PLAN section 5's five data views, plus `chat` — the one view that
 * is a peer of the connections rather than a window onto one, and the only one
 * that can drive the others — plus `plugin`, which is one `case` however many
 * plugins are loaded (`core/view-kinds.ts` explains why the discriminant stayed
 * a literal).
 *
 * The switch is still exhaustive with no `default`, which is what makes the
 * return type do the checking: a seventh *built-in* kind remains a compile error
 * here.
 */
export function ViewHost({ viewId }: { viewId: ViewId }): ReactElement {
  const t = useT()
  const view = useView(viewId)
  if (!view) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-tight text-fg-faint">
        {t('view.gone', { viewId })}
      </div>
    )
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
    case 'chat':
      return <ChatView view={view} />
    case 'plugin': {
      const entry = lookupViewKind(view.pluginKind)
      // A view whose plugin is gone is an ordinary state, not a crash: the
      // workspace can be restored after the plugin was uninstalled. Naming the
      // kind is what lets someone work out which plugin to put back — a blank
      // pane would not.
      if (!entry) {
        return (
          <div className="flex flex-1 flex-col items-center justify-center gap-tight text-fg-faint">
            {t('view.pluginMissing', { kind: view.pluginKind })}
          </div>
        )
      }
      return entry.render(view)
    }
  }
}
