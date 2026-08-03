import { useCallback, useEffect, useMemo } from 'react'
import type { ReactElement } from 'react'
import type {
  Capability,
  ConnId,
  NamespaceNode,
  NamespaceNodeKind,
  TreeViewState,
} from '@peek/core'
import { bridgeExtras } from '../../bridge'
import { useT } from '../../i18n'
import { connCapabilities } from '../../state/capabilities'
import { dispatch } from '../../state/dispatch'
import { invalidateConnection, loadChildren, useNodes } from '../../state/namespaceStore'
import { useConnection } from '../../state/workspaceStore'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'
import { ViewError } from '../ViewError'
import { openSpecForNode } from './openTarget'
import { treeMenuNodes } from './treeMenu'

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

  // The connection's capabilities decide what a double-click means: a key in a
  // keyValue store opens the inspector, everything else with a ref opens a scan.
  const capabilities = conn ? connCapabilities(conn) : []
  const capKey = capabilities.join(',')

  const onOpen = useCallback(
    (node: NamespaceNode) => {
      const spec = openSpecForNode(connId, node, capabilities)
      if (!spec) return
      void dispatch('view.open', { spec })
    },
    [connId, capKey],
  )

  // "More like this" needs a query point, so it cannot be what a double-click
  // does; it gets its own action on the node it applies to.
  const onVectorSearch = useCallback(
    (node: NamespaceNode) => {
      if (node.ref?.kind !== 'vectorCollection') return
      void dispatch('view.open', {
        spec: { kind: 'vector', connId, collection: node.ref.collection, title: node.name },
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
            capabilities={capabilities}
            expandedSet={expandedSet}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpen={onOpen}
            onVectorSearch={onVectorSearch}
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
  capabilities: readonly Capability[]
  expandedSet: ReadonlySet<string>
  selected: string | undefined
  onToggle: (node: NamespaceNode) => void
  onSelect: (node: NamespaceNode) => void
  onOpen: (node: NamespaceNode) => void
  onVectorSearch: (node: NamespaceNode) => void
}

function TreeLevel(props: TreeLevelProps): ReactElement | null {
  const { connId, parentId, depth, capabilities, expandedSet, selected } = props
  const { onToggle, onSelect, onOpen, onVectorSearch } = props
  const t = useT()
  const entry = useNodes(connId, parentId)
  const connStatus = useConnection(connId)?.status
  const menu = useContextMenu<NamespaceNode>()

  useEffect(() => {
    loadChildren(connId, parentId)
  }, [connId, parentId])

  if (!entry) return null
  if (entry.status === 'waiting') {
    // No request was ever sent, because the connection could not answer one.
    // Which wording that deserves depends on why: a handshake in flight resolves
    // itself (sync.ts starts this level the moment it reaches `ready`), while a
    // failed or closed connection needs the user — and the sidebar is where the
    // reason for the failure is reported.
    return (
      <div className="tree-node" style={{ paddingLeft: 8 + depth * 14, color: 'var(--fg-faint)' }}>
        {connStatus === 'connecting' ? t('tree.connecting') : t('tree.notReady')}
      </div>
    )
  }
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
              // Right-click selects first, the way every file manager does: the
              // menu is about *this* node, so the highlight has to agree with it
              // before the menu says a word.
              onContextMenu={(e) => {
                onSelect(node)
                menu.open(node)(e)
              }}
              title={`${node.detail ?? node.name}\n${t('menu.hint')}`}
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
                capabilities={capabilities}
                expandedSet={expandedSet}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
                onVectorSearch={onVectorSearch}
              />
            ) : null}
          </div>
        )
      })}
      {menu.state ? (
        <TreeNodeMenu
          connId={connId}
          node={menu.state.payload}
          at={menu.state.at}
          capabilities={capabilities}
          onOpen={onOpen}
          onVectorSearch={onVectorSearch}
          onClose={menu.close}
        />
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */

interface TreeNodeMenuProps {
  connId: ConnId
  node: NamespaceNode
  at: { x: number; y: number }
  capabilities: readonly Capability[]
  onOpen: (node: NamespaceNode) => void
  onVectorSearch: (node: NamespaceNode) => void
  onClose: () => void
}

/**
 * The node's right-click menu.
 *
 * Its own component only so that the node is a prop rather than something read
 * back out of the menu state inside four closures — which is where a stale
 * capture or a non-null assertion would go, and neither belongs in the handler
 * that decides what "Open" opens.
 */
function TreeNodeMenu(props: TreeNodeMenuProps): ReactElement {
  const { connId, node, at, capabilities, onOpen, onVectorSearch, onClose } = props
  const t = useT()
  return (
    <Menu
      label={t('menu.tree.label')}
      at={at}
      nodes={treeMenuNodes(connId, node, capabilities, t, {
        open: () => {
          onOpen(node)
        },
        vectorSearch: () => {
          onVectorSearch(node)
        },
        // Failure is silent on purpose: `navigator.clipboard` is unavailable in
        // a non-secure context, and a toast about a copy nobody watched fail is
        // noise. Same treatment the markdown link copy gets.
        copyName: () => {
          void navigator.clipboard?.writeText(node.name)
        },
        refresh: () => {
          loadChildren(connId, node.id, true)
        },
      })}
      onClose={onClose}
    />
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
