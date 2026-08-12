import type { ViewState } from '@peek/core'
import { collectionRefLabel } from '@peek/core'
import type { TFunction } from '../i18n'
import { lookupViewKind } from '../packages/viewKinds'

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
    // Named, not derived. This branch used to fall into the template-literal
    // key below, which for a kind the catalog had never heard of painted the
    // key itself — `view.kind.documents` — into the tab strip. A registration
    // declares its `titleKey`, and one that is missing from the catalog is a
    // load-time refusal rather than a tab nobody can read.
    case 'package': {
      const entry = lookupViewKind(view.packageKind)
      return entry ? t(entry.titleKey) : view.packageKind
    }
    default:
      return t(`view.kind.${view.kind}`)
  }
}
