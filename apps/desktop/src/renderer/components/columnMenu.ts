import type { SortSpec } from '@peek/core'
import type { TFunction } from '../i18n'
import type { MenuNode } from '../ui/menuModel'

/**
 * What right-clicking a column header offers.
 *
 * The reason this exists at all is a gap rather than a convenience: a header
 * click *cycles* asc → desc → unsorted, which is a fine gesture for reaching
 * "descending" and a terrible one for reaching "unsorted" — you have to know the
 * cycle, and you have to pass through a sort you did not want on the way. Two
 * network round-trips for an act that should be one. Naming each state outright
 * fixes that, and it is only possible in a menu.
 *
 * The current direction is marked by *omission*: a column already ascending does
 * not offer "sort ascending". A checkmark would say the same thing with more
 * pixels, and this menu has no room for a mark column that nine lines out of ten
 * would leave blank.
 */
export interface ColumnMenuHandlers {
  setSort: (dir: 'asc' | 'desc' | null) => void
  copyName: () => void
}

export function columnMenuNodes(
  column: string,
  sort: readonly SortSpec[] | undefined,
  t: TFunction,
  on: ColumnMenuHandlers,
  options: { sortable: boolean },
): MenuNode[] {
  const nodes: MenuNode[] = []
  const current = sort?.find((s) => s.column === column)?.dir

  if (options.sortable) {
    if (current !== 'asc') {
      nodes.push({
        kind: 'item',
        id: 'column.sortAsc',
        label: t('menu.column.sortAsc'),
        onSelect: () => {
          on.setSort('asc')
        },
      })
    }
    if (current !== 'desc') {
      nodes.push({
        kind: 'item',
        id: 'column.sortDesc',
        label: t('menu.column.sortDesc'),
        onSelect: () => {
          on.setSort('desc')
        },
      })
    }
    // The line the cycling click could never offer directly.
    if (current !== undefined) {
      nodes.push({
        kind: 'item',
        id: 'column.sortClear',
        label: t('menu.column.sortClear'),
        onSelect: () => {
          on.setSort(null)
        },
      })
    }
    nodes.push({ kind: 'sep', id: 'column.sep' })
  }

  nodes.push({
    kind: 'item',
    id: 'column.copyName',
    label: t('menu.column.copyName'),
    onSelect: on.copyName,
  })

  return nodes
}
