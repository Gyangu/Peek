import { refreshPatch, type RefreshableView, type ResultId } from '@peek/core'

/**
 * "Fetch this view again", as a Command — the one definition of it.
 *
 * Two callers ask the same question for different reasons: `auto-refresh.ts` on
 * a timer the user set, and `connection-wake.ts` when a connection comes up
 * under views that never got to fetch. They must agree, and the table branch is
 * why: on a cursor-paged collection a refresh has to say `offset: 0` or it
 * silently pages forward, and a second copy of this function would be one
 * `refreshPatch` away from doing that in one of the two paths only.
 *
 * The vector and package patches are empty on purpose: `applyViewPatch` changes
 * nothing and `refresh: true` is what asks for the fetch — the same shape the
 * table view's Next-page button has always used.
 */
export interface RefreshCommand {
  name: 'view.update' | 'query.run'
  input: unknown
}

export function refreshCommand(view: RefreshableView): RefreshCommand {
  switch (view.kind) {
    case 'table':
      return { name: 'view.update', input: { viewId: view.id, patch: refreshPatch(view.ref), refresh: true } }
    case 'query':
      return { name: 'query.run', input: { viewId: view.id, text: view.text } }
    case 'vector':
      return { name: 'view.update', input: { viewId: view.id, patch: { kind: 'vector' }, refresh: true } }
    case 'package':
      return { name: 'view.update', input: { viewId: view.id, patch: { kind: 'package' }, refresh: true } }
  }
}

/** The `resultId` a refresh command reports, when it started one. */
export function resultIdOf(data: unknown): ResultId | null {
  if (typeof data !== 'object' || data === null) return null
  const id = (data as { resultId?: unknown }).resultId
  return typeof id === 'string' ? (id as ResultId) : null
}
