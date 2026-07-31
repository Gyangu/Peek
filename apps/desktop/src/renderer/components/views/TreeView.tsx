import { useCallback, useEffect, useMemo } from 'react'
import type { ReactElement } from 'react'
import type { ConnId, NamespaceNode, NamespaceNodeKind, TreeViewState } from '@peek/core'
import { bridgeExtras } from '../../bridge'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { invalidateConnection, loadChildren, useNodes } from '../../state/namespaceStore'
import { useConnection } from '../../state/workspaceStore'
import { ViewError } from '../ViewError'

/**
 * The namespace tree. **Lazily loaded**: a level is only fetched when it is
 * expanded (PLAN §8).
 *
 * Expansion and selection are UI state and go to main as `view.update`; the node
 * contents are read-only remote data and are cached in namespaceStore.
 */
export function TreeView({ view }: { view: TreeViewState }): ReactElement {
  const { id: viewId, connId, expanded, selected } = view
  const t = useT()
  const conn = useConnection(connId)
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const hasChannel = bridgeExtras.hasIntrospect()

  const onToggle = useCallback(
    (node: NamespaceNode) => {
      if (!node.hasChildren) return
      const has = expandedSet.has(node.id)
      const next = has ? expanded.filter((x) => x !== node.id) : [...expanded, node.id]
      if (!has) loadChildren(connId, node.id)
      void dispatch('view.update', { viewId, patch: { kind: 'tree', expanded: next } })
    },
    [viewId, connId, expanded, expandedSet],
  )

  const onSelect = useCallback(
    (node: NamespaceNode) => {
      void dispatch('view.update', { viewId, patch: { kind: 'tree', selected: node.id } })
    },
    [viewId],
  )

  const onOpen = useCallback(
    (node: NamespaceNode) => {
      if (!node.ref) return
      void dispatch('view.open', {
        spec: { kind: 'table', connId, ref: node.ref, title: node.name },
      })
    },
    [connId],
  )

  const refresh = (): void => {
    invalidateConnection(connId)
    loadChildren(connId, null, true)
    for (const id of expanded) loadChildren(connId, id, true)
  }

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? connId}</span>
        <span className="sep" />
        <button className="ghost" onClick={refresh} disabled={!hasChannel}>
          ⟳ {t('tree.refresh')}
        </button>
        <span className="grow" />
        <span style={{ color: 'var(--fg-faint)' }}>{t('tree.openHint')}</span>
      </div>

      <ViewError error={view.error} />

      {hasChannel ? (
        <div className="tree">
          <TreeLevel
            connId={connId}
            parentId={null}
            depth={0}
            expandedSet={expandedSet}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        </div>
      ) : (
        <NoIntrospectChannel connId={connId} />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */

interface TreeLevelProps {
  connId: ConnId
  parentId: string | null
  depth: number
  expandedSet: ReadonlySet<string>
  selected: string | undefined
  onToggle: (node: NamespaceNode) => void
  onSelect: (node: NamespaceNode) => void
  onOpen: (node: NamespaceNode) => void
}

function TreeLevel(props: TreeLevelProps): ReactElement | null {
  const { connId, parentId, depth, expandedSet, selected, onToggle, onSelect, onOpen } = props
  const t = useT()
  const entry = useNodes(connId, parentId)

  useEffect(() => {
    loadChildren(connId, parentId)
  }, [connId, parentId])

  if (!entry) return null
  if (entry.status === 'error') {
    return (
      <div className="empty-hint" style={{ paddingLeft: 12 + depth * 14, textAlign: 'left' }}>
        {/* `entry.error` is whatever the bridge threw — shown verbatim. */}
        {t('tree.loadFailed', { error: entry.error ?? '' })}
      </div>
    )
  }
  if (entry.status === 'loading' && entry.nodes.length === 0) {
    return (
      <div className="tree-node" style={{ paddingLeft: 8 + depth * 14, color: 'var(--fg-faint)' }}>
        {t('tree.loading')}
      </div>
    )
  }
  if (entry.nodes.length === 0) {
    return (
      <div className="tree-node" style={{ paddingLeft: 8 + depth * 14, color: 'var(--fg-faint)' }}>
        {t('tree.empty')}
      </div>
    )
  }

  return (
    <>
      {entry.nodes.map((node) => {
        const open = expandedSet.has(node.id)
        return (
          <div key={node.id}>
            <div
              className={selected === node.id ? 'tree-node selected' : 'tree-node'}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => {
                onSelect(node)
                onToggle(node)
              }}
              onDoubleClick={() => {
                onOpen(node)
              }}
              title={node.detail ?? node.name}
            >
              <span className="tree-caret">{node.hasChildren ? (open ? '▾' : '▸') : ''}</span>
              <span className="tree-icon">{iconOf(node.kind)}</span>
              <span className="tree-name">{node.name}</span>
              {node.detail ? <span className="tree-detail">{node.detail}</span> : null}
            </div>
            {open ? (
              <TreeLevel
                connId={connId}
                parentId={node.id}
                depth={depth + 1}
                expandedSet={expandedSet}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------ */

/** Fallback when the bridge has no introspect channel: offer a way to browse with SQL. */
function NoIntrospectChannel({ connId }: { connId: ConnId }): ReactElement {
  const t = useT()
  const openQuery = (): void => {
    void dispatch('view.open', {
      spec: {
        kind: 'query',
        connId,
        // The title is stored in the Workspace and read back by MCP, so it is a
        // canonical English literal rather than a translated string.
        title: 'Browse objects',
        text: LIST_TABLES_SQL,
        run: true,
      },
    })
  }
  return (
    <div className="empty-hint">
      <div>{t('tree.unavailable')}</div>
      <div style={{ marginTop: 6, textAlign: 'left', maxWidth: 320 }}>
        {t('tree.unavailableDetail')}
      </div>
      <button style={{ marginTop: 10 }} onClick={openQuery}>
        {t('tree.browseWithSql')}
      </button>
    </div>
  )
}

const LIST_TABLES_SQL = `select table_schema, table_name, table_type
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name`

function iconOf(kind: NamespaceNodeKind): string {
  switch (kind) {
    case 'database':
      return '⛁'
    case 'schema':
    case 'folder':
    case 'keyPrefix':
      return '❏'
    case 'table':
      return '▦'
    case 'view':
      return '◫'
    case 'materializedView':
      return '◪'
    case 'keyspace':
      return '⧉'
    case 'key':
      return '·'
    case 'collection':
      return '◇'
    case 'index':
      return '⌗'
    case 'column':
      return '│'
    default:
      return '·'
  }
}
