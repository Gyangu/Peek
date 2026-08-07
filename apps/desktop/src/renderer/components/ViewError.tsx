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
    <div className="m-tight flex-none rounded-control border border-err-border bg-err-bg px-snug py-tight text-err select-text">
      <div>
        <strong>[{error.code}]</strong> {text}
        {/*
         * `--color-fg-dim` rather than `opacity: 0.7`. Dimming the inherited `--color-err`
         * measured 3.52:1 against this box — below the floor the theme commits to,
         * and invisible to `theme-contrast.test.ts`, which compares token pairs and
         * never modelled alpha. `--color-fg-dim` is what "secondary" is called here, and
         * it reads 7.48:1 on `--color-err-bg`. See the legibility baseline §2.2.1.
         */}
        {error.driverCode ? <span className="text-fg-dim"> · {error.driverCode}</span> : null}
        {error.position !== undefined ? (
          <span className="text-fg-dim"> · {t('app.error.position', { position: error.position })}</span>
        ) : null}
      </div>
      {/* Capped, so a driver that answers with a page of context cannot push the
          view out of the window; scrollable, so none of it is lost. */}
      {error.detail ? (
        <div className="mt-tight max-h-30 overflow-auto font-mono text-micro whitespace-pre-wrap text-fg-dim">
          {error.detail}
        </div>
      ) : null}
    </div>
  )
}
