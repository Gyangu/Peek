import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { ColumnDef, ConnId, PeekedValue, ResultId, ValueRef } from '@peek/core'
import { VALUE_PEEK_MAX_BYTES, isTruncatedValue } from '@peek/core'
import { bridgeExtras } from '../bridge'
import { useModalDialog } from '../hooks'
import { tStatic, useT, type TFunction } from '../i18n'
import { notify } from '../state/notifyStore'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { formatBytes, fullValueText } from '../util/format'
import { MODAL_BODY, MODAL_HEAD, MODAL_MASK, MODAL_SHELL, MODAL_SIZE, MODAL_TITLE } from './modalClasses'

export interface ValueModalProps {
  connId: ConnId
  resultId: ResultId | undefined
  row: number
  col: number
  column: ColumnDef
  value: unknown
  onClose: () => void
}

/**
 * The single-value expansion modal.
 *
 * A large value only travels in a chunk as a 4KB preview (TruncatedValue); the
 * rest has to come through valuePeek. The Command Bus has no valuePeek command
 * today (see the contract gap in the delivery notes), so this goes through the
 * bridge's optional extension — and when the extension is missing it shows the
 * preview and says so plainly rather than pretending.
 */
export function ValueModal(props: ValueModalProps): ReactElement {
  const { connId, resultId, row, col, column, value, onClose } = props
  const t = useT()
  const [peeked, setPeeked] = useState<PeekedValue | null>(null)
  const [loading, setLoading] = useState(false)

  const truncated = isTruncatedValue(value) ? value : null
  const canPeek = bridgeExtras.hasPeekValue()

  // Escape, focus containment and focus restoration, shared with every other
  // modal. It used to register its own `window` listener that closed on Escape
  // without stopping the event — so one press both closed this and cleared the
  // grid's row selection behind it. See hooks/modalStack.ts.
  const dialogRef = useModalDialog({ label: 'value', onClose })

  const ref: ValueRef | null =
    truncated?.ref
    ?? (resultId ? { kind: 'resultCell', resultId, row, col } : null)

  const doPeek = useCallback(() => {
    if (!ref) return
    setLoading(true)
    bridgeExtras
      .peekValue(connId, ref, { offset: 0, length: VALUE_PEEK_MAX_BYTES })
      .then((v) => {
        setPeeked(v)
      })
      .catch((e: unknown) => {
        // tStatic, not `t`: a toast is worded once, when it is raised — see the
        // note on notifyError in notifyStore.
        notify('error', tStatic('value.fetchFailed'), e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [connId, ref])

  const body = peeked ? peekedText(t, peeked) : fullValueText(value)
  const size = truncated?.byteLength ?? peeked?.totalBytes

  return (
    <div className={MODAL_MASK} onMouseDown={onClose}>
      <div
        className={MODAL_SHELL}
        style={MODAL_SIZE}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={column.name}
        onMouseDown={stop}
      >
        <div className={MODAL_HEAD}>
          <span className={`font-mono tabular-nums ${MODAL_TITLE}`}>{column.name}</span>
          <span className="text-fg-faint">
            {t('value.subtitle', { type: column.nativeType, row: row + 1 })}
            {size !== undefined ? ` · ${formatBytes(size)}` : ''}
          </span>
          <span className="flex-1" />
          {truncated && !peeked ? (
            <Button
              variant="primary"
              disabled={loading || !canPeek || !ref}
              onClick={doPeek}
              title={canPeek ? t('value.fetchFullTitle') : t('value.peekUnavailable')}
            >
              {loading ? t('value.fetching') : t('value.fetchFull')}
            </Button>
          ) : null}
          {/* The close box had neither a tooltip nor an accessible name: to a
              screen reader it was a button called "✕". `icon` makes the label
              mandatory, which is the whole reason that prop is a type union. */}
          <Button variant="ghost" icon label={t('app.errors.close')} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        <div className={MODAL_BODY}>
          {truncated && !peeked ? (
            <div className="mb-snug text-warn">
              {t('value.previewOnly')}
              {canPeek ? t('value.previewHint') : t('value.previewNoPeek')}
            </div>
          ) : null}
          <div className="max-h-full overflow-auto rounded-control border border-border bg-bg p-snug font-mono text-body whitespace-pre-wrap wrap-anywhere select-text">{body}</div>
        </div>
      </div>
    </div>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}

/** Body text of a fetched value. `t` is passed in so the caller stays the only
 *  place subscribed to the locale. */
function peekedText(t: TFunction, v: PeekedValue): string {
  if (v.encoding === 'base64') {
    const size = formatBytes(v.byteLength)
    const head = v.eof ? t('value.base64', { size }) : t('value.base64Partial', { size })
    return `${head}\n${v.data}`
  }
  return v.data
}
