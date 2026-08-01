import type { ChatAttachment, ChatAttachmentKind, ChatAttachmentSpec, ViewState } from '@peek/core'
import { DEFAULT_PAGE_LIMIT, collectionRefLabel, newAttachmentId } from '@peek/core'

/**
 * The catalog keys for the six attachment kinds.
 *
 * Spelled out rather than widened to `ChatMessageKey`: `t()` derives its params
 * from the message a key maps to, so handing it the whole key union would make
 * every call demand the params of the most demanding message in the catalog.
 */
export type AttachmentKindKey =
  | 'chat.attach.kind.rows'
  | 'chat.attach.kind.result'
  | 'chat.attach.kind.cell'
  | 'chat.attach.kind.schema'
  | 'chat.attach.kind.query'
  | 'chat.attach.kind.workspace'

/**
 * Reading and offering context attachments.
 *
 * The format is **not invented here**: `ChatAttachmentSpec` in `commands.ts` is
 * the contract, and everything below produces or reads exactly that. In
 * particular an attachment is a *descriptor* — a view id and a result id, never
 * the rows themselves — because main resolves it at **send** time. That is what
 * makes "attach this query's result, edit the SQL, re-run, send" attach the new
 * rows, and what lets a descriptor whose data has been evicted from the
 * renderer's LRU report the failure instead of quietly shipping a stale
 * snapshot.
 *
 * This module holds no state and dispatches nothing. Staging goes through
 * `chat.attach`, and the staged set is read back from `ChatViewState.attachments`
 * in the Workspace mirror — the panel never keeps its own copy.
 */

export function attachmentKindKey(kind: ChatAttachmentKind): AttachmentKindKey {
  switch (kind) {
    case 'rows':
      return 'chat.attach.kind.rows'
    case 'result':
      return 'chat.attach.kind.result'
    case 'cell':
      return 'chat.attach.kind.cell'
    case 'schema':
      return 'chat.attach.kind.schema'
    case 'query':
      return 'chat.attach.kind.query'
    case 'workspace':
      return 'chat.attach.kind.workspace'
  }
}

/**
 * The chip's text.
 *
 * `ChatAttachment.label` is required by the contract and is what main derived
 * (or the caller overrode), so it wins. The fallback only covers a descriptor
 * that somehow arrived without one, and prefers identifiers over prose:
 * `public.orders` names the thing better than any sentence would.
 */
export function attachmentLabel(attachment: ChatAttachment): string {
  if (attachment.label) return attachment.label
  switch (attachment.kind) {
    case 'rows':
      return `${attachment.rowIndexes.length} rows`
    case 'result':
      return attachment.resultId
    case 'cell':
      return `${attachment.column}[${attachment.rowIndex}]`
    case 'schema':
      return collectionRefLabel(attachment.ref)
    case 'query':
      return attachment.viewId
    case 'workspace':
      return 'workspace'
  }
}

/**
 * A spec plus the two fields a `ChatAttachment` adds: an id and a label.
 *
 * Needed because the consent gate (`useContextActions`) takes the fuller object
 * — it is what carries the localized label a chip shows — while a menu naturally
 * produces the spec. Written as an exhaustive switch rather than a spread so the
 * compiler enumerates every kind, and so the one field a spec may leave out has
 * exactly one default in the renderer.
 *
 * The id minted here is provisional and is dropped again at the port boundary;
 * main mints the real one. Nothing may treat it as addressing anything.
 */
export function stageableAttachment(spec: ChatAttachmentSpec, label: string): ChatAttachment {
  const base = { id: newAttachmentId(), label: spec.label ?? label }
  switch (spec.kind) {
    case 'rows':
      return { ...base, kind: 'rows', viewId: spec.viewId, resultId: spec.resultId, rowIndexes: [...spec.rowIndexes] }
    case 'result':
      // One page of the table, matching what `context-actions/descriptors.ts`
      // asks for from the grid — "add this result" must mean the same amount
      // whichever of the two menus offered it.
      return {
        ...base,
        kind: 'result',
        viewId: spec.viewId,
        resultId: spec.resultId,
        maxRows: spec.maxRows ?? DEFAULT_PAGE_LIMIT,
      }
    case 'cell':
      return {
        ...base,
        kind: 'cell',
        viewId: spec.viewId,
        resultId: spec.resultId,
        rowIndex: spec.rowIndex,
        column: spec.column,
      }
    case 'schema':
      return { ...base, kind: 'schema', connId: spec.connId, ref: spec.ref }
    case 'query':
      return { ...base, kind: 'query', viewId: spec.viewId }
    case 'workspace':
      return { ...base, kind: 'workspace' }
  }
}

/** One entry in the "add context" menu. */
export interface AttachCandidate {
  /** Stable within a menu render; used as the React key and the click target. */
  key: string
  label: string
  hint?: string
  spec: ChatAttachmentSpec
}

/**
 * Everything the menu needs to say, resolved by the caller.
 *
 * Passed in rather than looked up here for one reason: naming a view already has
 * exactly one home (`viewTitleOf`, so that the tab title, the drag label and
 * every other mention agree), and a second implementation inside this module
 * would be the first place they drift apart.
 */
export interface AttachLabels {
  workspace: string
  workspaceHint: string
  resultOf(viewName: string): string
  queryOf(viewName: string): string
  viewName(view: ViewState): string
}

/**
 * What the user could attach right now, derived from the Workspace mirror.
 *
 * Only three sources are offered, and each one is something the user is
 * demonstrably looking at:
 *
 *  - the workspace itself ("here is what is on my screen"),
 *  - the result set of any view that has one,
 *  - the SQL of any query view that has text.
 *
 * Row-, cell- and schema-level attachments are deliberately **not** here: those
 * come from the grid, where `DataGrid` holds the row selection and knows which
 * cell the pointer is over, and are offered by `SelectionActionBar` and
 * `ContextMenu` (`components/context-actions/`). This menu covers the other
 * case — the user is looking at the chat panel rather than at the grid.
 *
 * The chat view itself is skipped — attaching a conversation to itself is a
 * loop, and `kind: 'workspace'` already reports that the chat is open.
 */
export function attachCandidates(
  views: readonly ViewState[],
  labels: AttachLabels,
): AttachCandidate[] {
  const out: AttachCandidate[] = [
    {
      key: 'workspace',
      label: labels.workspace,
      hint: labels.workspaceHint,
      spec: { kind: 'workspace' },
    },
  ]

  for (const view of views) {
    if (view.kind === 'chat') continue

    if ('resultId' in view && view.resultId) {
      out.push({
        key: `result:${view.id}`,
        label: labels.resultOf(labels.viewName(view)),
        hint: view.resultId,
        spec: { kind: 'result', viewId: view.id, resultId: view.resultId },
      })
    }

    if (view.kind === 'query' && view.text.trim() !== '') {
      out.push({
        key: `query:${view.id}`,
        label: labels.queryOf(labels.viewName(view)),
        // A one-line preview, so two query tabs are told apart by their content.
        hint: view.text.replace(/\s+/g, ' ').trim().slice(0, 80),
        spec: { kind: 'query', viewId: view.id },
      })
    }
  }

  return out
}
