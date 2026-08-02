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
        {/*
         * `--fg-dim` rather than `opacity: 0.7`. Dimming the inherited `--err`
         * measured 3.52:1 against this box — below the floor the theme commits to,
         * and invisible to `theme-contrast.test.ts`, which compares token pairs and
         * never modelled alpha. `--fg-dim` is what "secondary" is called here, and
         * it reads 7.48:1 on `--err-bg`. See the legibility baseline §2.2.1.
         */}
        {error.driverCode ? <span className="view-error-aside"> · {error.driverCode}</span> : null}
        {error.position !== undefined ? (
          <span className="view-error-aside"> · {t('app.error.position', { position: error.position })}</span>
        ) : null}
      </div>
      {error.detail ? <div className="detail">{error.detail}</div> : null}
    </div>
  )
}
