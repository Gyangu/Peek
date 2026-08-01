/**
 * The short phrase on an attachment receipt — the user-facing half of the
 * never-truncate-silently rule.
 *
 * Rendered by `chat/MessageItem.tsx`, on the turn that carried the attachment.
 * That is the only place it *can* be shown: an attachment is a descriptor until
 * the message is sent, so before then there is nothing true to say about how much
 * of it went — see the note on the return value below.
 *
 * A separate module from the component for the reason `connectForm.ts` and
 * `browseControls.ts` are: it is a pure mapping from a resolution result to a
 * sentence, it is the part most worth pinning down in a test, and a `.tsx` module
 * cannot be imported by the node:test runner.
 *
 * The model is told what was left out in the document body (`describeTruncation`
 * in `main/acp/context/budget.ts`); this is where the human is told the same
 * thing. Neither audience is left to infer it.
 */

import type { TFunction } from '../../i18n'

/**
 * What main reports back about a staged attachment once it has been resolved.
 *
 * `notice` mirrors `TruncationNotice` from `main/acp/context/budget.ts`
 * structurally rather than importing it: the renderer must not reach into main's
 * modules, and this is the one shape that crosses. It arrives over IPC as plain
 * data, so a structural declaration is what it actually is.
 */
export interface AttachmentStatus {
  notice?: {
    unit: 'rows' | 'characters' | 'elements'
    included: number
    total: number | null
    reason: 'rowCap' | 'tokenBudget' | 'valueCap' | 'sourceTruncated' | 'promptBudget'
  } | null
  /** Set when the descriptor could not be resolved at send time. */
  failed?: boolean
}

/**
 * Returns null while an attachment is only staged.
 *
 * There is nothing true to say about how much of it will be sent until it has
 * been resolved — an attachment is a descriptor, and the data it names is read at
 * send time. Guessing a row count here would be the silent-truncation failure in
 * reverse: a confident number that nothing produced.
 */
export function detailFor(status: AttachmentStatus | undefined, t: TFunction): string | null {
  if (!status) return null
  if (status.failed === true) return t('context.chips.failed')
  const n = status.notice
  if (!n) return null
  switch (n.reason) {
    case 'promptBudget':
      return t('context.chips.omitted')
    case 'sourceTruncated':
      return t('context.chips.sourceIncomplete')
    case 'valueCap':
      return t('context.chips.truncatedChars', {
        included: n.included,
        total: n.total ?? n.included,
      })
    case 'rowCap':
    case 'tokenBudget':
      return n.total === null
        ? t('context.chips.truncatedRowsUnknown', { included: n.included })
        : t('context.chips.truncatedRows', { included: n.included, total: n.total })
  }
}
