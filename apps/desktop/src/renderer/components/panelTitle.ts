import type { ViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import type { TFunction } from '../i18n'

/**
 * Title of a view, for the window only.
 *
 * Deliberately not `viewTitle()` from core: that one feeds MCP and the workspace
 * snapshot and is therefore fixed to English, whereas this line is read by a
 * human. An explicit `title` (set by whoever opened the view) always wins, and a
 * collection label such as `public.orders` is an identifier that stays as it is.
 *
 * It lives in its own module because the panel head, the drag label under the
 * cursor and the "swap with …" preview must all name a view the same way; a view
 * that reads `public.orders` in the title bar and something else mid-drag would
 * make the preview useless.
 */
export function viewTitleOf(t: TFunction, view: ViewState): string {
  if (view.title) return view.title
  switch (view.kind) {
    case 'table':
      return collectionRefLabel(view.ref)
    case 'vector':
      return `${t('view.kind.vector')} · ${view.collection}`
    default:
      return t(`view.kind.${view.kind}`)
  }
}
