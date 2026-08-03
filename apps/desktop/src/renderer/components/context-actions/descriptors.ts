/**
 * Building `ChatAttachment` descriptors out of what is on screen.
 *
 * Pure, and deliberately so: "what can be attached from here" is a question
 * about the current view, the current selection and the driver's capabilities,
 * and it has exactly one right answer that both the context menu and the
 * keyboard path must agree on. Deriving it twice — once for the menu, once for
 * the shortcut — is how the menu ends up offering something the shortcut cannot
 * do.
 *
 * ## Descriptors, not data
 *
 * Nothing here reads a single row. The descriptor names *what* to send and main
 * materialises it at send time (`chat.ts` sets out why: the attachment
 * stays live across a re-run, it survives being staged while the cache evicts
 * underneath it, and it keeps the transcript out of the Workspace). So these
 * builders only need ids and indexes, which is why they can be pure functions
 * over view state.
 *
 * ## The id these mint is provisional
 *
 * `chat.attach` takes a `ChatAttachmentSpec`, which has no id — main mints the
 * real one and returns it in `ChatAttachResult`. The id set here is dropped at
 * the port boundary (`port.ts` explains why the seam carries the fuller object
 * anyway: it keeps the localized `label` non-optional). Nothing in the renderer
 * may treat it as addressing anything.
 *
 * ## Labels
 *
 * `label` is what the chip shows, and it is built here in the user's language.
 * That is the one asymmetry worth noting against the rest of the pipeline:
 * everything main sends the *model* is English forever, but the label never
 * reaches the model — `resolve.ts` derives its own English title from the
 * descriptor's shape. The two are independent on purpose.
 */

import {
  DEFAULT_PAGE_LIMIT,
  collectionRefLabel,
  newAttachmentId,
  type ChatAttachment,
  type CollectionRef,
  type ConnId,
  type ResultId,
  type ViewId,
  type ViewState,
} from '@peek/core'
import type { TFunction } from '../../i18n'
import { lookupViewKind } from '../../plugins/viewKinds'

/**
 * Rows to request for a whole-result attachment.
 *
 * A page of the table, not the whole result set: `maxRows` is what the user is
 * asking for, and main's `ContextBudget` then trims further if even that does not
 * fit. Both ceilings report themselves, so a user who wanted more finds out.
 */
export const RESULT_ATTACHMENT_MAX_ROWS = DEFAULT_PAGE_LIMIT

/** What the surface offering the menu knows about itself. */
export interface ContextTarget {
  view: ViewState
  /** The result set on screen, when there is one. */
  resultId?: ResultId | undefined
  /** Rows currently selected in the grid, absolute indexes. */
  selectedRows?: readonly number[] | undefined
  /** The focused cell, when the pointer is over one. */
  cell?: { rowIndex: number; column: string } | undefined
  /** Rows the result is known to hold, for the menu's own wording. */
  rowCount?: number | undefined
}

/** One offer in the menu. `build` is only called if the user picks it. */
export interface ContextAction {
  /** Stable across renders and locales; used as a React key and in tests. */
  id: ContextActionId
  label: string
  /** Longer explanation for a tooltip. */
  title?: string
  build(): ChatAttachment
}

export type ContextActionId =
  | 'rows'
  | 'result'
  | 'cell'
  | 'schema'
  | 'query'
  | 'workspace'

/* ================================================================== */
/* Builders                                                            */
/* ================================================================== */

export function rowsAttachment(
  viewId: ViewId,
  resultId: ResultId,
  rowIndexes: readonly number[],
  label: string,
): ChatAttachment {
  return {
    id: newAttachmentId(),
    label,
    kind: 'rows',
    viewId,
    resultId,
    // Sorted and de-duplicated here as well as in main. Main cannot trust its
    // input, and the UI wants the same order it will display.
    rowIndexes: [...new Set(rowIndexes)].sort((a, b) => a - b),
  }
}

export function resultAttachment(
  viewId: ViewId,
  resultId: ResultId,
  label: string,
  maxRows = RESULT_ATTACHMENT_MAX_ROWS,
): ChatAttachment {
  return { id: newAttachmentId(), label, kind: 'result', viewId, resultId, maxRows }
}

export function cellAttachment(
  viewId: ViewId,
  resultId: ResultId,
  rowIndex: number,
  column: string,
  label: string,
): ChatAttachment {
  return { id: newAttachmentId(), label, kind: 'cell', viewId, resultId, rowIndex, column }
}

export function schemaAttachment(connId: ConnId, ref: CollectionRef, label: string): ChatAttachment {
  return { id: newAttachmentId(), label, kind: 'schema', connId, ref }
}

export function queryAttachment(viewId: ViewId, label: string): ChatAttachment {
  return { id: newAttachmentId(), label, kind: 'query', viewId }
}

export function workspaceAttachment(label: string): ChatAttachment {
  return { id: newAttachmentId(), label, kind: 'workspace' }
}

/* ================================================================== */
/* What this target can offer                                          */
/* ================================================================== */

/**
 * Every attachment available from a given place in the UI, in menu order.
 *
 * Order is by specificity: the thing the user pointed at first, the container
 * around it after. Someone who right-clicks a cell wants that cell, and having to
 * read past "the whole workspace" to reach it is the menu getting in the way.
 *
 * A capability the target does not have is **absent**, not disabled. A greyed-out
 * "attach the query text" on a Redis keyspace tells the user nothing they can act
 * on, and `ViewState` already makes the distinction structurally — a `query` view
 * has `text`, the others do not.
 */
export function contextActionsFor(target: ContextTarget, t: TFunction): ContextAction[] {
  const out: ContextAction[] = []
  const { view, resultId } = target
  const selected = target.selectedRows ?? []

  if (target.cell && resultId) {
    const { rowIndex, column } = target.cell
    const label = t('context.attach.cell', { column, row: rowIndex + 1 })
    out.push({
      id: 'cell',
      label,
      title: t('context.attach.cellTitle'),
      build: () => cellAttachment(view.id, resultId, rowIndex, column, label),
    })
  }

  if (selected.length > 0 && resultId) {
    const label = t('context.attach.rows', { count: selected.length })
    out.push({
      id: 'rows',
      label,
      title: t('context.attach.rowsTitle'),
      build: () => rowsAttachment(view.id, resultId, selected, label),
    })
  }

  if (resultId) {
    const label = t('context.attach.result', { count: RESULT_ATTACHMENT_MAX_ROWS })
    out.push({
      id: 'result',
      label,
      title: t('context.attach.resultTitle'),
      build: () => resultAttachment(view.id, resultId, label),
    })
  }

  // Structure comes from the collection a view is browsing. A query view is not
  // browsing one — it produced an ad-hoc projection — so it has no schema to
  // attach, and offering one would have to guess which table the SQL meant.
  const ref = collectionRefOf(view)
  // `connId` is optional on a chat view, so membership alone does not narrow it.
  const connId = 'connId' in view ? view.connId : undefined
  if (ref && connId !== undefined) {
    const label = t('context.attach.schema', { name: collectionRefLabel(ref) })
    out.push({
      id: 'schema',
      label,
      title: t('context.attach.schemaTitle'),
      build: () => schemaAttachment(connId, ref, label),
    })
  }

  if (view.kind === 'query') {
    const label = t('context.attach.query')
    out.push({
      id: 'query',
      label,
      title: t('context.attach.queryTitle'),
      build: () => queryAttachment(view.id, label),
    })
  }

  const wsLabel = t('context.attach.workspace')
  out.push({
    id: 'workspace',
    label: wsLabel,
    title: t('context.attach.workspaceTitle'),
    build: () => workspaceAttachment(wsLabel),
  })

  return out
}

/** The collection a view browses, or null for the views that browse none. */
export function collectionRefOf(view: ViewState): CollectionRef | null {
  switch (view.kind) {
    case 'table':
      return view.ref
    case 'vector':
      return { kind: 'vectorCollection', collection: view.collection }
    case 'query':
    case 'inspector':
    case 'tree':
    case 'chat':
      return null
    // A plugin view may or may not browse something core models. Asking its
    // registration is the only way to know — and `null` from an unregistered
    // kind is the right answer, not a guess: without the plugin there is
    // nothing that can say what its state addresses.
    case 'plugin':
      return lookupViewKind(view.pluginKind)?.contract.collectionRef(view) ?? null
  }
}
