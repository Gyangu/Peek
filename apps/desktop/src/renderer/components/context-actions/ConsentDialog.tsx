import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useT } from '../../i18n'
import { grantContextConsent } from './consent'
import './context-actions.css'

/**
 * The one-time disclosure, shown before the first attachment is ever staged.
 *
 * The wording is in `context.consent.*` and the reasoning for showing it exactly
 * once is in `consent.ts`. What this component adds is that the disclosure is
 * **modal and blocking**: the attachment the user asked for does not happen until
 * they have answered. A non-blocking banner would be read after the data had
 * already gone, which is not a disclosure.
 *
 * `Cancel` is a real cancel — it abandons the attachment and does not record
 * consent, so the dialog appears again next time. An "OK"-only dialog is a
 * notification wearing a dialog's clothes.
 */
export interface ConsentDialogProps {
  /** Called after consent is recorded; the caller resumes the attachment here. */
  onAccept: () => void
  onCancel: () => void
}

export function ConsentDialog(props: ConsentDialogProps): ReactElement {
  const { onAccept, onCancel } = props
  const t = useT()
  const acceptRef = useRef<HTMLButtonElement | null>(null)

  // Focus the primary action, and let Escape cancel. Both are what a keyboard
  // user expects from a modal, and neither is free in a plain div.
  useEffect(() => {
    acceptRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onCancel])

  const accept = (): void => {
    grantContextConsent()
    onAccept()
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div
        className="modal ctx-consent"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ctx-consent-title"
        onClick={stop}
      >
        <h2 id="ctx-consent-title" className="ctx-consent-title">
          {t('context.consent.title')}
        </h2>
        <p>{t('context.consent.body')}</p>
        <p>{t('context.consent.scope')}</p>
        <p>{t('context.consent.production')}</p>
        <p className="ctx-consent-once">{t('context.consent.once')}</p>
        <div className="ctx-consent-actions">
          <button type="button" onClick={onCancel}>
            {t('context.consent.cancel')}
          </button>
          <button type="button" ref={acceptRef} className="primary" onClick={accept}>
            {t('context.consent.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}

function stop(e: React.MouseEvent): void {
  e.stopPropagation()
}
