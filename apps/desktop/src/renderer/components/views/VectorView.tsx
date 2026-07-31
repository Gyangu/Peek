import type { ReactElement } from 'react'
import type { VectorViewState } from '@peek/core'
import { useT } from '../../i18n'
import { useConnection } from '../../state/workspaceStore'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'

/**
 * Vector search view.
 *
 * A placeholder in M1: once a result set exists it is displayed through the same
 * columnar cache and virtualized grid as everything else (score and payload are
 * ordinary columns). The search entry point and vector editing arrive with M4
 * (Qdrant).
 */
export function VectorView({ view }: { view: VectorViewState }): ReactElement {
  const t = useT()
  const conn = useConnection(view.connId)
  const dim = view.queryVec?.length

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? view.connId}</span>
        <span className="sep" />
        {/* Collection name and `topK` are API-level identifiers, left untranslated. */}
        <span className="mono">{view.collection}</span>
        <span className="sep" />
        <span>topK {view.topK}</span>
        {dim ? (
          <>
            <span className="sep" />
            <span>{t('vector.queryVector', { dim })}</span>
          </>
        ) : null}
        {view.queryText ? (
          <>
            <span className="sep" />
            <span title={view.queryText}>{t('vector.textQuery')}</span>
          </>
        ) : null}
        <span className="grow" />
        <span style={{ color: 'var(--fg-faint)' }}>{t('vector.plannedM4')}</span>
      </div>

      <ViewError error={view.error} />

      <DataGrid
        connId={view.connId}
        resultId={view.resultId}
        emptyHint={t('vector.notImplemented')}
      />
    </>
  )
}
