import { useCallback, useEffect, useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
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
import { elisionLabel } from './treeElision'
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
      <div className="flex h-bar flex-none items-center gap-tight overflow-hidden shadow-rule-b bg-bg-1 px-snug text-fg-dim">
        <span>{conn?.label ?? connId}</span>
        <span className="h-divider w-px flex-none bg-border-strong" />
        <button className="ghost" onClick={refresh} disabled={!hasChannel}>
          ⟳ {t('tree.refresh')}
        </button>
        <span className="flex-1" />
        <span className="text-fg-faint">{t('tree.openHint')}</span>
      </div>

      <ViewError error={view.error} />

      {hasChannel ? (
        <div className="flex-1 min-h-0 overflow-auto py-tight">
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
      <TreeNotice depth={depth}>
        {connStatus === 'connecting' ? t('tree.connecting') : t('tree.notReady')}
      </TreeNotice>
    )
  }
  if (entry.status === 'error') {
    // `.empty-hint` centres its text; the inline `textAlign` is what overrules
    // that for a message long enough to wrap, and it has to stay inline —
    // `.empty-hint` lives unlayered in components/app.css, so a `text-left`
    // utility in `@layer utilities` would lose to it and the override would
    // silently stop working. See views.css on the same wall.
    return (
      <div className="px-snug py-loose text-left leading-prose text-fg-faint" style={{ paddingLeft: 12 + depth * 14 }}>
        {/* `entry.error` is whatever the bridge threw — shown verbatim. */}
        {t('tree.loadFailed', { error: entry.error ?? '' })}
      </div>
    )
  }
  if (entry.status === 'loading' && entry.nodes.length === 0) {
    return <TreeNotice depth={depth}>{t('tree.loading')}</TreeNotice>
  }
  if (entry.nodes.length === 0) {
    return <TreeNotice depth={depth}>{t('tree.empty')}</TreeNotice>
  }

  return (
    <>
      {entry.nodes.map((node) => {
        const open = expandedSet.has(node.id)
        // An elision node stands for children the driver left out, not for
        // anything in the store, so its own `name` ('…') and English `detail`
        // are the driver's fallback for MCP and the row is worded here instead.
        const elided = node.elision === undefined ? null : elisionLabel(node.elision, t)
        return (
          <div key={node.id}>
            {/* `h-row` was 22px until it became --spacing-row: matching the grid
                beside it lines the two up, and leaves room for a 20px per-node
                action button.

                Selection and hover are alternatives, never layered. A class list
                has no cascade, and `.hover\:bg-bg-2:hover` outweighs a plain
                `.bg-bg-sel` on specificity, so writing both would repaint the
                selected node grey the moment the pointer crossed it — the
                opposite of what the stylesheet did, where `.tree-node.selected`
                came second and won. Naming one or the other says it outright.
                See §7.2 of the migration record. */}
            <div
              className={
                // Concatenated rather than interpolated into a template literal:
                // `classNames()` in __tests__/sourceScan.ts reads the string
                // literals of `cond ? 'a' : 'b'` but only the leading fragment of
                // a template, so the two backgrounds would be invisible to the
                // arbitrary-value ban and the type floor both. Its docstring says
                // as much. Same classes, written where the audit can reach them.
                'flex items-center gap-tight h-row pr-snug whitespace-nowrap ' +
                (selected === node.id ? 'bg-bg-sel' : 'hover:bg-bg-2')
              }
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
              title={`${elided ?? node.detail ?? node.name}\n${t('menu.hint')}`}
            >
              {/* A disclosure triangle is geometry, not a word. It used to say so
                  in the only way a stylesheet can — 10px, deliberately *below* the
                  text floor — and it cannot any more: `text-micro` is 12px and there
                  is no rung under it (§30.5). What survives is the part that does
                  not need a font size: a fixed 14px column, and the whole 24px row
                  rather than the glyph as the click target. */}
              <span className="w-glyph shrink-0 text-center text-fg-faint text-mark">
                {node.hasChildren ? (open ? '▾' : '▸') : ''}
              </span>
              {/* The node-kind glyph is now the same 12px as the caret above it,
                  and that is a real distinction being lost rather than a tidy-up.
                  The caret has two states and they differ by 90°; these are
                  ⛁ ❏ ▦ ◫ ◪ ⧉ ◇ — a set the reader is meant to tell apart, where
                  ◫ and ◪ differ only by which half is filled. It was sized *above*
                  the floor for that reason and the caret *below* it, one rung each
                  way. A two-rung default scale has neither rung, so the sizes met
                  in the middle. If these ever become hard to tell apart, this is
                  the note that says it was foreseen and what the fix is: a size,
                  not a different glyph. */}
              <span className="w-glyph shrink-0 text-center text-fg-dim text-body">
                {iconOf(node.kind)}
              </span>
              <span className="truncate">{node.name}</span>
              {elided ?? node.detail ? (
                <span className="ml-tight truncate text-fg-faint text-micro">
                  {elided ?? node.detail}
                </span>
              ) : null}
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

/**
 * A level that has no nodes to draw yet, or none at all.
 *
 * One component rather than three copies of the same `<div>` because the row's
 * shape is a class list now instead of a single `.tree-node`, and three
 * verbatim copies of seven utilities is three places for them to drift. The
 * three callers differ only in their wording — not connected, still loading,
 * nothing here — so what they share is exactly a component.
 *
 * It wears the node row's own geometry so a level that says "loading" occupies
 * the same 24px a node would, and the tree does not jump when the answer lands.
 * The indent is the node's `6 + depth * 14` plus two — carried over as it was
 * found, because two pixels on a placeholder is not a fact worth inventing a
 * reason for.
 */
function TreeNotice({ depth, children }: { depth: number; children: ReactNode }): ReactElement {
  return (
    <div
      className="flex items-center gap-tight h-row pr-snug whitespace-nowrap text-fg-faint"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {children}
    </div>
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
    <div className="px-snug py-loose text-center leading-prose text-fg-faint">
      <div>{t('tree.unavailable')}</div>
      <div style={{ marginTop: 6, textAlign: 'left', maxWidth: 320 }}>
        {t('tree.unavailableDetail')}
      </div>
      <button className="mt-snug" onClick={openQuery}>
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
