import type { PanelNode, ViewId } from '@peek/core'
import type { TFunction } from '../i18n'
import type { MenuNode } from '../ui/menuModel'

/**
 * What right-clicking a tab offers.
 *
 * Two groups, and the separator between them is load-bearing: the first three
 * lines act on *this tab*, the last three on the *panel it sits in*. They read
 * as one list otherwise, and "Close" next to "Close panel" is the kind of
 * neighbourhood where a mis-click costs a layout.
 *
 * "Close other tabs" is absent when there are none — a menu line that is
 * guaranteed to do nothing is worse than a missing one, because the user has to
 * try it to find out.
 */
export interface TabMenuHandlers {
  close: () => void
  closeOthers: () => void
  splitRow: () => void
  splitCol: () => void
  closePanel: () => void
}

export function tabMenuNodes(
  panel: PanelNode,
  viewId: ViewId,
  t: TFunction,
  on: TabMenuHandlers,
): MenuNode[] {
  const others = panel.viewIds.filter((id) => id !== viewId).length

  const nodes: MenuNode[] = [
    { kind: 'item', id: 'tab.close', label: t('menu.tab.close'), onSelect: on.close },
  ]
  if (others > 0) {
    nodes.push({
      kind: 'item',
      id: 'tab.closeOthers',
      label: t('menu.tab.closeOthers'),
      onSelect: on.closeOthers,
    })
  }

  nodes.push(
    { kind: 'sep', id: 'tab.sep' },
    { kind: 'item', id: 'panel.splitRow', label: t('panel.splitRow'), onSelect: on.splitRow },
    { kind: 'item', id: 'panel.splitCol', label: t('panel.splitCol'), onSelect: on.splitCol },
    {
      kind: 'item',
      id: 'panel.close',
      label: t('panel.closePanel'),
      // Closing the panel takes every tab in it, including ones the user is not
      // pointing at. That is the definition this tone exists for.
      tone: 'danger',
      onSelect: on.closePanel,
    },
  )

  return nodes
}
