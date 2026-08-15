import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type { VectorViewState, ViewPatch } from '@peek/core'
import { useT } from '../../i18n'
import { connCanUse, connHas } from '../../state/capabilities'
import { dispatch } from '../../state/dispatch'
import { loadChildren, useNodes } from '../../state/namespaceStore'
import { useConnection, useResultMeta } from '../../state/workspaceStore'
import { formatCount, formatMs } from '../../util/format'
import { DataGrid } from '../DataGrid'
import { ViewError } from '../ViewError'
import { AutoRefreshControl, CacheGapNotice, CancelButton } from './ResultControls'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import {
  findCollectionNodeId,
  namedVectorsOf,
  parsePointId,
  parsePositiveInt,
  parseScore,
} from './vectorFields'

type VectorPatch = Extract<ViewPatch, { kind: 'vector' }>

/**
 * Vector search.
 *
 * The search itself is `queryVec` or `queryPointId`, and only the second one is
 * something a human can operate: peek never turns text into a vector (drivers are
 * forbidden from embedding, see `VectorSearchRequest`) and nobody types 1024
 * floats. So the box on screen is "more like this point", and a `queryVec` that
 * arrived from MCP is shown as a read-only badge that the next search replaces.
 *
 * Like every other view, this one owns no result state: the inputs are a local
 * draft, pressing Search sends one `view.update`, and what comes back from main
 * is what gets drawn.
 */
export function VectorView({ view }: { view: VectorViewState }): ReactElement {
  const { id: viewId, connId, collection, resultId } = view
  const t = useT()
  const conn = useConnection(connId)
  const meta = useResultMeta(resultId)

  const canSearchEver = conn !== null && connHas(conn, 'vectorSearch')
  const ready = conn !== null && connCanUse(conn, 'vectorSearch')
  const running = meta?.status === 'running' || view.status === 'loading'

  // The draft resets whenever main reports different values — an MCP call can
  // retarget this view while the user is looking at it, and the boxes have to
  // show what is actually going to be searched.
  const syncKey = JSON.stringify([
    view.queryPointId ?? null,
    view.vectorName ?? null,
    view.topK,
    view.scoreThreshold ?? null,
  ])
  const [draft, setDraft] = useState(() => draftOf(view))
  useEffect(() => {
    setDraft(draftOf(view))
    // syncKey is the value-level identity of the fields draftOf reads.
  }, [syncKey])

  const suggestions = useNamedVectors(connId, collection, canSearchEver)

  const pointId = parsePointId(draft.pointId)
  // Either query entry point will do: with a vector already on the view, Search
  // re-runs it under the new topK / threshold rather than demanding a point id.
  const hasQuery = pointId !== null || view.queryVec !== undefined || view.queryPointId !== undefined

  const search = (): void => {
    if (!ready || running || !hasQuery) return
    const name = draft.vectorName.trim()
    const topK = parsePositiveInt(draft.topK)
    const patch: VectorPatch = {
      kind: 'vector',
      ...(pointId === null ? {} : { queryPointId: pointId }),
      ...(topK === null ? {} : { topK }),
      // null is "clear it", which is a different request from leaving the field
      // alone — and an emptied box is exactly that request.
      vectorName: name === '' ? null : name,
      scoreThreshold: parseScore(draft.score),
    }
    void dispatch('view.update', { viewId, patch, refresh: true })
  }

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Enter') search()
  }

  return (
    <>
      {/* The shared strip, written out — see the same note in `QueryView.tsx`. */}
      <div className="flex h-bar flex-none items-center gap-tight overflow-hidden shadow-rule-b bg-bg-1 px-snug text-fg-dim">
        <Button variant="primary" disabled={!ready || running || !hasQuery} onClick={search}>
          <Icon name="run" />
          {t('vector.run')}
        </Button>
        {/* Always drawn now, including on drivers without the `cancel` capability —
            where it is disabled and carries the reason. Hiding it left a user
            watching a qdrant scroll with no way to learn why nothing could stop it;
            see CancelButton. */}
        <CancelButton viewId={viewId} conn={conn} running={running} />
        <AutoRefreshControl
          viewId={viewId}
          kind="vector"
          {...(view.autoRefreshMs !== undefined ? { autoRefreshMs: view.autoRefreshMs } : {})}
          {...(view.autoRefreshStoppedBy !== undefined ? { stoppedBy: view.autoRefreshStoppedBy } : {})}
        />
        <span className="h-divider w-px flex-none bg-border-strong" />
        {/* The collection name is an identifier: never translated. */}
        <span className="font-mono tabular-nums" title={collection}>
          {collection}
        </span>
        {view.queryVec ? (
          <>
            <span className="h-divider w-px flex-none bg-border-strong" />
            <span>{t('vector.queryVector', { dim: view.queryVec.length })}</span>
          </>
        ) : null}
        {view.queryText ? (
          <>
            <span className="h-divider w-px flex-none bg-border-strong" />
            <span title={view.queryText}>{t('vector.textQuery')}</span>
          </>
        ) : null}
        {meta ? (
          <>
            <span className="h-divider w-px flex-none bg-border-strong" />
            <span className="font-mono tabular-nums">
              {t('grid.rows', { count: meta.rows, rows: formatCount(meta.rows) })}
              {` · ${formatMs(meta.elapsedMs)}`}
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        {canSearchEver ? null : (
          // Not a disabled button: this connection will never search vectors, and
          // saying "unavailable" would suggest waiting fixes it.
          <span className="text-warn">{t('vector.unavailable')}</span>
        )}
      </div>

      {canSearchEver ? (
        // A second toolbar row under the view's own. The fields are short by
        // nature — a point id, a vector name, two numbers — so each states its
        // own width instead of stretching: a row of half-empty full-width boxes
        // reads as a form, and this is a query bar. The labels hold their width
        // for the same reason.
        //
        // The shape shared by all four (`flex-none h-control-sm px-control-x py-0 text-micro`)
        // is written out on each rather than hoisted into a constant. That is
        // deliberate: a constant here would be one more name to look up, and the
        // widths — the only part that differs — would end up beside a name
        // instead of beside the field. These four rules lived in views.css until
        // the `input` floor moved into `@layer base`; before that they had to be
        // CSS, because an unlayered element rule outranks every utility however
        // specific the utility is.
        <div className="flex h-bar flex-none items-center gap-tight overflow-hidden shadow-rule-b bg-bg-1 px-snug text-fg-dim">
          <label className="shrink-0 whitespace-nowrap" htmlFor={`vq-id-${viewId}`}>
            {t('vector.pointId')}
          </label>
          <input
            id={`vq-id-${viewId}`}
            className="font-mono tabular-nums flex-none h-control-sm px-control-x py-0 text-micro w-47.5"
            value={draft.pointId}
            spellCheck={false}
            title={t('vector.pointIdTitle')}
            onChange={(e) => {
              setDraft((d) => ({ ...d, pointId: e.target.value }))
            }}
            onKeyDown={onKeyDown}
          />
          <span className="h-divider w-px flex-none bg-border-strong" />
          <label className="shrink-0 whitespace-nowrap" htmlFor={`vq-name-${viewId}`}>
            {t('vector.vectorName')}
          </label>
          {/* A datalist, not a select: the names are only known once the tree has
              been read, and a picker with no options would be a dead end. */}
          <input
            id={`vq-name-${viewId}`}
            className="font-mono tabular-nums flex-none h-control-sm px-control-x py-0 text-micro w-27.5"
            list={suggestions.length > 0 ? `vq-names-${viewId}` : undefined}
            value={draft.vectorName}
            spellCheck={false}
            placeholder={t('vector.vectorNameDefault')}
            title={t('vector.vectorNameTitle')}
            onChange={(e) => {
              setDraft((d) => ({ ...d, vectorName: e.target.value }))
            }}
            onKeyDown={onKeyDown}
          />
          {suggestions.length > 0 ? (
            <datalist id={`vq-names-${viewId}`}>
              {suggestions.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          ) : null}
          <span className="h-divider w-px flex-none bg-border-strong" />
          {/* `topK` is the API's own name for it, left as it is in every language. */}
          <label className="shrink-0 whitespace-nowrap" htmlFor={`vq-topk-${viewId}`}>
            topK
          </label>
          <input
            id={`vq-topk-${viewId}`}
            className="flex-none h-control-sm px-control-x py-0 text-micro w-17.5"
            type="number"
            min={1}
            value={draft.topK}
            title={t('vector.topKTitle')}
            onChange={(e) => {
              setDraft((d) => ({ ...d, topK: e.target.value }))
            }}
            onKeyDown={onKeyDown}
          />
          <span className="h-divider w-px flex-none bg-border-strong" />
          <label className="shrink-0 whitespace-nowrap" htmlFor={`vq-score-${viewId}`}>
            {t('vector.minScore')}
          </label>
          <input
            id={`vq-score-${viewId}`}
            className="flex-none h-control-sm px-control-x py-0 text-micro w-17.5"
            type="number"
            step="any"
            value={draft.score}
            title={t('vector.minScoreTitle')}
            onChange={(e) => {
              setDraft((d) => ({ ...d, score: e.target.value }))
            }}
            onKeyDown={onKeyDown}
          />
          {view.filter && view.filter.length > 0 ? (
            <>
              <span className="h-divider w-px flex-none bg-border-strong" />
              {/* The tooltip is the raw filter JSON — evidence, shown as it is. */}
              <span title={JSON.stringify(view.filter)}>
                {t('vector.filters', { count: view.filter.length })}
              </span>
            </>
          ) : null}
          <span className="flex-1" />
        </div>
      ) : null}

      <ViewError error={view.error} />
      <CacheGapNotice resultId={resultId} disabled={!ready || running || !hasQuery} onRefetch={search} />

      <DataGrid
        connId={connId}
        view={view}
        resultId={resultId}
        emptyHint={hasQuery ? t('vector.empty') : t('vector.needQuery')}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */

interface VectorDraft {
  pointId: string
  vectorName: string
  topK: string
  score: string
}

function draftOf(view: VectorViewState): VectorDraft {
  return {
    pointId: view.queryPointId === undefined ? '' : String(view.queryPointId),
    vectorName: view.vectorName ?? '',
    topK: String(view.topK),
    score: view.scoreThreshold === undefined ? '' : String(view.scoreThreshold),
  }
}

/**
 * Named vectors of this collection, for the suggestion list.
 *
 * They come from the namespace tree, which is where the driver already publishes
 * them, so nothing here knows what a qdrant collection looks like. The lookup is
 * best-effort by design: a collection with a single unnamed vector has no
 * children to report, the top level may not be loaded yet, and in both cases an
 * empty list simply means "no suggestions" — the box stays free text and the
 * driver remains the authority on what it accepts.
 */
function useNamedVectors(connId: VectorViewState['connId'], collection: string, enabled: boolean): string[] {
  const roots = useNodes(connId, null)
  const nodeId = useMemo(
    () => (roots ? findCollectionNodeId(roots.nodes, collection) : null),
    [roots?.nodes, collection],
  )
  const children = useNodes(connId, nodeId)

  useEffect(() => {
    if (!enabled) return
    // Same lazy load and the same cache as the tree view: opening a search on a
    // collection the tree already listed costs nothing.
    loadChildren(connId, null)
    if (nodeId !== null) loadChildren(connId, nodeId)
  }, [connId, nodeId, enabled])

  // `nodeId === null` addresses the *root* level, whose nodes are the collections
  // themselves — reading vector names out of those would be a different question.
  return useMemo(
    () => (nodeId !== null && children ? namedVectorsOf(children.nodes) : []),
    [nodeId, children?.nodes],
  )
}
