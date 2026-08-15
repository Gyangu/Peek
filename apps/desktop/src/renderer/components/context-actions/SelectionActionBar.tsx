import type { ReactElement } from 'react'
import type { ResultId, ViewId, ViewState } from '@peek/core'
import { useT } from '../../i18n'
import { ConsentDialog } from './ConsentDialog'
import { rowsAttachment, rowsChipLabel } from './descriptors'
import { MAX_SELECTION_SPAN, selectedIndexes, selectionSpan, type RowSelection } from './selection'
import { useContextActions } from './useContextActions'
import { Button } from '../../ui/Button'

/**
 * The floating bar that appears once rows are selected.
 *
 * The right-click menu is discoverable only by people who try right-clicking.
 * This is the path that finds the user instead: select rows, and the action is
 * simply there. It is the same `rowsAttachment` descriptor the menu builds — one
 * behaviour, two ways in.
 *
 * ## The span warning is the interesting part
 *
 * `resolveAttachment` refuses a selection spanning more rows than it will read,
 * because it addresses rows by offset and limit and two rows 500,000 apart mean
 * hauling everything between them (see `MAX_ROW_SPAN` in `resolve.ts`). That
 * refusal is correct, but discovering it *after* sending a message is a bad way
 * to learn it. So the bar checks the same span here and says so up front, with
 * the two things the user can actually do about it.
 */
export interface SelectionActionBarProps {
  /**
   * The grid's view — the whole state, not just its id, because the chip this
   * bar stages is named after the view (`orders · 16 rows`) and `viewTitleOf`
   * needs the view to say what it is called.
   */
  view: ViewState
  resultId: ResultId | undefined
  selection: RowSelection
  onClear: () => void
  /** Where to attach; omit to let the port pick the visible chat. */
  chatViewId?: ViewId | null
}

export function SelectionActionBar(props: SelectionActionBarProps): ReactElement | null {
  const { view, resultId, selection, onClear, chatViewId = null } = props
  const t = useT()
  const actions = useContextActions()

  const indexes = selectedIndexes(selection)
  const count = indexes.length

  if (actions.consentPending) {
    return <ConsentDialog onAccept={actions.acceptConsent} onCancel={actions.cancelConsent} />
  }
  if (count === 0 || resultId === undefined) return null

  const span = selectionSpan(selection)
  const tooWide = span > MAX_SELECTION_SPAN

  // Two strings, on purpose: the button is a sentence you can act on, the chip
  // is the name of a thing. They were one string until §2.2 of
  // design/2026-08-14-composer-inline-context.md, which is how a chip came to
  // read "Rows · Add 16 rows to chat".
  const label = t('context.float.add', { count })
  const chipLabel = rowsChipLabel(t, view, count)

  return (
    /*
     * Anchored to the bottom of the panel it belongs to, so it never covers the
     * rows the user just selected. The panel needs `position: relative`; every
     * `.panel` already has it.
     *
     * `inset-x-3 mx-auto w-fit` rather than the `left-1/2` + `translateX(-50%)`
     * this used to be. Both centre the bar; the difference is the clearance,
     * which was `max-width: calc(100% - 24px)` and is the one thing in the old
     * rule with no utility spelling. With left and right both set and the width
     * shrink-to-fit, auto side margins centre the box and the inset box is
     * already the cap — same 12px either side, stated once instead of twice, and
     * no arbitrary value (migration record §3.4).
     *
     * The radius is 6px where it was 7. Nothing on the scale is 7, and a token
     * whose only justification is "the old number was that" is not a token —
     * the same call §7.3 made for the gallery card.
     */
    <div
      className="absolute inset-x-3 bottom-11 mx-auto w-fit z-40 flex items-center gap-snug py-tight px-snug bg-bg-3 border border-border-strong rounded-surface shadow-float font-ui text-body"
      role="toolbar"
      aria-label={label}
    >
      {tooWide ? (
        <span className="max-w-95 text-warn text-micro leading-ui" role="status">
          {t('context.float.spanWarning', { span, count })}
        </span>
      ) : null}
      <Button
        variant="primary"
        disabled={tooWide}
        onClick={() => {
          void actions.add(rowsAttachment(view.id, resultId, indexes, chipLabel), chatViewId)
        }}
      >
        {label}
      </Button>
      <Button onClick={onClear}>{t('context.float.clear')}</Button>
    </div>
  )
}
