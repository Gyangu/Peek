import type { ReactElement } from 'react'
import type { ResultId, ViewId } from '@peek/core'
import { useT } from '../../i18n'
import { ConsentDialog } from './ConsentDialog'
import { rowsAttachment } from './descriptors'
import { MAX_SELECTION_SPAN, selectedIndexes, selectionSpan, type RowSelection } from './selection'
import { useContextActions } from './useContextActions'
import { Button } from '../../ui/Button'
import './context-actions.css'

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
  viewId: ViewId
  resultId: ResultId | undefined
  selection: RowSelection
  onClear: () => void
  /** Where to attach; omit to let the port pick the visible chat. */
  chatViewId?: ViewId | null
}

export function SelectionActionBar(props: SelectionActionBarProps): ReactElement | null {
  const { viewId, resultId, selection, onClear, chatViewId = null } = props
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

  const label = t('context.float.add', { count })

  return (
    <div className="ctx-selection-bar" role="toolbar" aria-label={label}>
      {tooWide ? (
        <span className="ctx-selection-warning" role="status">
          {t('context.float.spanWarning', { span, count })}
        </span>
      ) : null}
      <Button
        variant="primary"
        disabled={tooWide}
        onClick={() => {
          void actions.add(rowsAttachment(viewId, resultId, indexes, label), chatViewId)
        }}
      >
        {label}
      </Button>
      <Button onClick={onClear}>{t('context.float.clear')}</Button>
    </div>
  )
}
