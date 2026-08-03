import type { Capability, ConnId, NamespaceNode } from '@peek/core'
import type { TFunction } from '../../i18n'
import type { MenuNode } from '../../ui/menuModel'
import { canVectorSearchNode, openSpecForNode } from './openTarget'

/**
 * What right-clicking a namespace node offers.
 *
 * A pure function of the node and the connection's capabilities, in the same
 * shape `contextActionsFor` already uses for the grid: the component decides
 * *what happens*, this decides *what is offered*, and only the second half needs
 * a test — which then needs no DOM.
 *
 * The capability check is the reason it is worth separating. `openSpecForNode`
 * returns null for a node nothing can be opened on (a column, a schema in a
 * store with no query language), and a menu that offers "Open" on those is a
 * menu that lies about what a double-click would do. Asking the same function
 * the double-click asks is what keeps the two answers identical.
 */
export interface TreeMenuHandlers {
  open: () => void
  vectorSearch: () => void
  copyName: () => void
  refresh: () => void
}

export function treeMenuNodes(
  connId: ConnId,
  node: NamespaceNode,
  capabilities: readonly Capability[],
  t: TFunction,
  on: TreeMenuHandlers,
): MenuNode[] {
  const nodes: MenuNode[] = []

  if (openSpecForNode(connId, node, capabilities) !== null) {
    nodes.push({ kind: 'item', id: 'tree.open', label: t('menu.tree.open'), onSelect: on.open })
  }
  if (canVectorSearchNode(node, capabilities)) {
    nodes.push({
      kind: 'item',
      id: 'tree.vectorSearch',
      label: t('tree.vectorSearch'),
      title: t('tree.vectorSearchTitle'),
      onSelect: on.vectorSearch,
    })
  }
  if (nodes.length > 0) nodes.push({ kind: 'sep', id: 'tree.sep' })

  nodes.push({
    kind: 'item',
    id: 'tree.copyName',
    label: t('menu.tree.copyName'),
    onSelect: on.copyName,
  })
  // Only where there is a level to reload. On a leaf it would be a no-op with a
  // label, which is worse than an absence: the user waits for something.
  if (node.hasChildren) {
    nodes.push({
      kind: 'item',
      id: 'tree.refresh',
      label: t('menu.tree.refreshNode'),
      onSelect: on.refresh,
    })
  }

  return nodes
}
