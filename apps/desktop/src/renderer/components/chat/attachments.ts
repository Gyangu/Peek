import type { ChatAttachment, ChatAttachmentKind, ChatAttachmentSpec, ViewState } from '@peek/core'
import { DEFAULT_PAGE_LIMIT, collectionRefLabel, newAttachmentId } from '@peek/core'
import type { TFunction } from '../../i18n'
import type { GridSelectionSpec } from '../../state/gridSelectionStore'
import { selectionColumnCount, selectionRowCount } from '../../state/gridSelectionStore'
import { collectionRefOf, rowsChipLabel } from '../context-actions/descriptors'
import { viewTitleOf } from '../panelTitle'
import { mentionToken } from './mention'

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
  | 'chat.attach.kind.cells'
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
    case 'cells':
      return 'chat.attach.kind.cells'
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
    case 'cells':
      return `${attachment.columns.length} × ${attachment.r1 - attachment.r0 + 1} cells`
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
      return {
        ...base,
        kind: 'rows',
        viewId: spec.viewId,
        resultId: spec.resultId,
        rowIndexes: [...spec.rowIndexes],
      }
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
    case 'cells':
      return {
        ...base,
        kind: 'cells',
        viewId: spec.viewId,
        resultId: spec.resultId,
        r0: spec.r0,
        r1: spec.r1,
        columns: [...spec.columns],
      }
    case 'schema':
      return { ...base, kind: 'schema', connId: spec.connId, ref: spec.ref }
    case 'query':
      return { ...base, kind: 'query', viewId: spec.viewId }
    case 'workspace':
      return { ...base, kind: 'workspace' }
  }
}

/** One entry in the "add context" list, whether reached by `@` or by the button. */
export interface AttachCandidate {
  /** Stable within a render; used as the React key and the click target. */
  key: string
  /** The line in the list: "Result of orders". An imperative-free description. */
  label: string
  hint?: string
  /**
   * The word this goes by in the draft — `@public.orders`.
   *
   * Never translated and never contains whitespace (`mentionToken`), because it
   * is read inside a sentence the user is writing.
   *
   * Two candidates may share a token: the structure of `public.orders` and its
   * result set are both `@public.orders`, and so is the same table on a second
   * connection. That is deliberate — the token is what a person calls the thing,
   * and *which* data gets sent is decided by the chip, which carries the view
   * name. See design/2026-08-14-composer-inline-context.md §2.3.
   */
  token: string
  /** The chip's name once staged — a noun phrase, see `context.label.*`. */
  chipLabel: string
  /** `attachmentIdentity(spec)`, so the list can mark what is already staged. */
  identity: string
  spec: ChatAttachmentSpec
}

/**
 * What two attachments must agree on to be *the same* attachment.
 *
 * Not the `AttachmentId` — main mints that per staging, so attaching the same
 * result twice yields two ids and two identical chips. This is what lets the
 * candidate list say "Added" against something already staged, which is worth
 * having because the alternative (hiding it) reads as the list losing entries.
 *
 * Takes a spec or a full attachment: the two carry the same identifying fields,
 * and the id and label a `ChatAttachment` adds are exactly what must not count.
 */
export function attachmentIdentity(a: ChatAttachment | ChatAttachmentSpec): string {
  switch (a.kind) {
    case 'rows':
      return `rows:${a.viewId}:${a.resultId}:${[...a.rowIndexes].sort((x, y) => x - y).join(',')}`
    case 'result':
      return `result:${a.viewId}:${a.resultId}`
    case 'cell':
      return `cell:${a.viewId}:${a.resultId}:${a.rowIndex}:${a.column}`
    case 'cells':
      return `cells:${a.viewId}:${a.resultId}:${a.r0}-${a.r1}:${a.columns.join(',')}`
    case 'schema':
      return `schema:${a.connId}:${collectionRefLabel(a.ref)}`
    case 'query':
      return `query:${a.viewId}`
    case 'workspace':
      return 'workspace'
  }
}

/**
 * What the user could attach right now, derived from the Workspace mirror.
 *
 * Four sources, each one something the user is demonstrably looking at:
 *
 *  - the workspace itself ("here is what is on my screen"),
 *  - the result set of any view that has one,
 *  - the SQL of any query view that has text,
 *  - the structure of whatever collection a view is browsing.
 *
 * Plus one that is not derived from the mirror at all: whatever is selected in a
 * grid right now, published through `gridSelectionStore` because it is `useState`
 * inside `DataGrid` and the mirror never sees it. It leads the list — a selection
 * is the most specific thing on screen, and it is also the most perishable.
 *
 * The *pointed-at* cell is still not here. That one belongs to the grid's own
 * menus (`SelectionActionBar`, `ContextMenu`): it exists only while a pointer is
 * over it, which is not a thing a user can refer to from the composer.
 *
 * The chat view itself is skipped — attaching a conversation to itself is a
 * loop, and `kind: 'workspace'` already reports that the chat is open.
 *
 * `t` is taken directly rather than a bag of pre-resolved strings. The bag was
 * there to keep view naming in one place (`viewTitleOf`), which this now gets by
 * calling it — and once chips, tokens and menu lines each need their own wording
 * off the same view, passing five closures to avoid one import stops being the
 * cheaper side of the trade.
 */
export function attachCandidates(
  views: readonly ViewState[],
  t: TFunction,
  selection?: GridSelectionSpec | null,
): AttachCandidate[] {
  const workspace = t('chat.attach.option.workspace')
  const out: AttachCandidate[] = []

  if (selection) {
    const view = views.find((v) => v.id === selection.viewId)
    // A selection whose view has closed is stale, not offerable: the result it
    // addresses went with the tab. Absent rather than broken — the same call the
    // rest of this list makes about a capability a target does not have.
    if (view) {
      const rows = selectionRowCount(selection)
      const columns = selectionColumnCount(selection)
      const source = viewTitleOf(t, view)
      out.push({
        key: 'selection',
        label: t('chat.attach.option.selection'),
        // The hint carries what the selection *is*; the label cannot, because it
        // has to stay the same phrase the shortcut and the menu both refer to.
        hint:
          columns === null
            ? t('chat.attach.option.selectionRowsHint', { source, count: rows })
            : t('chat.attach.option.selectionCellsHint', { source, rows, columns }),
        token: t('chat.attach.token.selection'),
        chipLabel:
          columns === null
            ? rowsChipLabel(t, view, rows)
            : t('context.label.cells', { source, rows, columns }),
        identity: attachmentIdentity(selection),
        spec: selection,
      })
    }
  }

  out.push({
    key: 'workspace',
    label: workspace,
    hint: t('chat.attach.option.workspaceHint'),
    token: 'workspace',
    chipLabel: workspace,
    identity: attachmentIdentity({ kind: 'workspace' }),
    spec: { kind: 'workspace' },
  })

  for (const view of views) {
    if (view.kind === 'chat') continue
    const name = viewTitleOf(t, view)

    if ('resultId' in view && view.resultId) {
      out.push({
        key: `result:${view.id}`,
        label: t('chat.attach.option.result', { view: name }),
        hint: view.resultId,
        token: mentionToken(name),
        chipLabel: t('context.label.result', { source: name, count: DEFAULT_PAGE_LIMIT }),
        identity: attachmentIdentity({ kind: 'result', viewId: view.id, resultId: view.resultId }),
        spec: { kind: 'result', viewId: view.id, resultId: view.resultId },
      })
    }

    if (view.kind === 'query' && view.text.trim() !== '') {
      out.push({
        key: `query:${view.id}`,
        label: t('chat.attach.option.query', { view: name }),
        // A one-line preview, so two query tabs are told apart by their content.
        hint: view.text.replace(/\s+/g, ' ').trim().slice(0, 80),
        token: mentionToken(name),
        chipLabel: t('context.label.query', { source: name }),
        identity: attachmentIdentity({ kind: 'query', viewId: view.id }),
        spec: { kind: 'query', viewId: view.id },
      })
    }

    // Structure, asked of the one function that knows which collection a view of
    // any kind — including a package's — is browsing. A query view browses none.
    const ref = collectionRefOf(view)
    const connId = 'connId' in view ? view.connId : undefined
    if (ref && connId !== undefined) {
      // An identifier both times: it is what the chip should say and what the
      // draft should read, and translating `public.orders` would break both.
      const label = collectionRefLabel(ref)
      out.push({
        key: `schema:${view.id}`,
        label: t('context.attach.schema', { name: label }),
        hint: t('context.attach.schemaTitle'),
        token: mentionToken(label),
        chipLabel: label,
        identity: attachmentIdentity({ kind: 'schema', connId, ref }),
        spec: { kind: 'schema', connId, ref },
      })
    }
  }

  return out
}
