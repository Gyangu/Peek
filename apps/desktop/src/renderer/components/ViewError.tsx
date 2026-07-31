import type { ReactElement } from 'react'
import type { PeekError } from '@peek/core'
import { useErrorText, useT } from '../i18n'

/**
 * In-view error bar. Every error is a structured PeekError, laid out for the user.
 *
 * Three fields, three deliberately different language rules:
 *   - `code` is an identifier and is shown as-is. `NOT_FOUND` is what a human
 *     greps for and what an AI matches on, exactly like an HTTP status name.
 *   - the message goes through `useErrorText`, which localizes it when peek wrote
 *     it and passes it through untouched when the driver did.
 *   - `driverCode`, `position` and `detail` are technical evidence, never translated.
 */
export function ViewError({ error }: { error: PeekError | undefined }): ReactElement | null {
  const t = useT()
  const text = useErrorText(error)
  if (!error) return null
  return (
    <div className="view-error">
      <div>
        <strong>[{error.code}]</strong> {text}
        {error.driverCode ? <span style={{ opacity: 0.7 }}> · {error.driverCode}</span> : null}
        {error.position !== undefined ? (
          <span style={{ opacity: 0.7 }}> · {t('app.error.position', { position: error.position })}</span>
        ) : null}
      </div>
      {error.detail ? <div className="detail">{error.detail}</div> : null}
    </div>
  )
}
