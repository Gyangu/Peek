import { useRef } from 'react'
import type { ReactElement } from 'react'
import { useModalDialog } from '../../hooks'
import { useT } from '../../i18n'
import { grantContextConsent } from './consent'
import { Button } from '../../ui/Button'
import { MODAL_MASK, MODAL_SHELL, MODAL_SIZE } from '../modalClasses'

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

  // Escape cancels, Tab stays inside, and focus goes back where it came from —
  // all three from the shared hook now. `initialFocus` is the accept button
  // rather than the first control in DOM order: this dialog is read and then
  // answered, and the answer it is waiting for is the one further along.
  const dialogRef = useModalDialog({ label: 'consent', onClose: onCancel, initialFocus: acceptRef })

  const accept = (): void => {
    grantContextConsent()
    onAccept()
  }

  return (
    <div className={MODAL_MASK} onClick={onCancel}>
      {/*
       * Narrower than the generic dialog: this is prose to be read, and a 760px
       * measure is past the point where people stop reading lines.
       *
       * **It did not do that, and had not for as long as there were two
       * stylesheets.** The narrow width was a rule of its own, one class
       * specific — exactly as specific as the shared dialog's — and the shared
       * one came later in the sheet, so the shared one won and this dialog drew
       * 760. Measured in Electron against a built stylesheet in three separate
       * rounds. The width is an inline style now, which no rule and no utility
       * can outrank, so the dialog is 520 for the first time. That is a real,
       * intended change in what ships, not a no-op migration: migration record
       * §17.4.
       *
       * Two sizes changed when this dialog was first migrated, and both were off
       * the scale rather than on it. The body was 12.5px and is the 12px rung;
       * the title was 14px and is the 13px rung. There are five rungs and
       * neither number was one of them — that is what a literal in a stylesheet
       * buys you. Rounding both the same direction would have flattened the two
       * into one size, so each went to its nearest rung and the heading still
       * reads as a heading.
       *
       * Preflight is not loaded (the token block says why), so `<h2>` and `<p>`
       * still arrive with the browser's own margins and the `<h2>` with 1.5em
       * bold. That is what the zero top margin and the explicit type on the
       * heading are undoing.
       */}
      <div
        className={`${MODAL_SHELL} font-ui text-body leading-prose`}
        style={{ ...MODAL_SIZE, width: 'min(520px, 86vw)' }}
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ctx-consent-title"
        onClick={stop}
      >
        {/*
         * The prose scrolls; the answer does not.
         *
         * The shell clips and the shared size caps it at 80% of the viewport
         * height. Until this split, the five paragraphs and the two buttons sat
         * directly in that clipped box — the only dialog in the window whose
         * middle was not a scrolling region — so a viewport short enough to make
         * the content overflow simply cut the buttons off, with no way to scroll
         * to them. Escape still cancelled. A dialog that can only be refused is
         * not a disclosure, it is a refusal.
         *
         * The product's floor is a 400px CSS viewport (the window's 600px
         * minimum height at the 1.5 zoom ceiling), which caps this dialog at
         * 320px, and the English copy measures 296px there. Both numbers were
         * measured in Electron against the built stylesheet — the margin was 24px
         * and one more paragraph would have spent it.
         *
         * It does **not** reuse the generic dialog's body: that one carries the
         * shared padding, and this dialog's frame is deliberately unlike the
         * others — no title bar, no button bar, a warn-coloured heading, prose
         * measure rather than form measure. That difference is the signal that
         * this is the one dialog gating what leaves the machine. The vertical
         * padding is split across the two regions so the geometry is unchanged
         * whenever the content fits: verified identical to the pixel.
         *
         * `tabIndex` is what makes the scrolling reachable from the keyboard. A
         * scroll container with no focusable child cannot be scrolled by
         * keyboard at all — the arrow keys act on the focused element's own
         * scrolling ancestor, and the focused element here is a button in the
         * row *below* this box. The inset ring is the same one the panel, the
         * grid and the popup menu draw for the same reason.
         */}
        <div
          className={
            'min-h-0 flex-1 overflow-auto px-loose pt-loose ' +
            'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2'
          }
          tabIndex={0}
        >
          <h2 id="ctx-consent-title" className="mt-0 mb-snug text-warn text-title font-semibold">
            {t('context.consent.title')}
          </h2>
          <p className="mt-0 mb-snug text-fg">{t('context.consent.body')}</p>
          <p className="mt-0 mb-snug text-fg">{t('context.consent.scope')}</p>
          <p className="mt-0 mb-snug text-fg">{t('context.consent.production')}</p>
          <p className="mt-0 mb-snug text-fg-faint text-micro">{t('context.consent.once')}</p>
        </div>
        <div className="flex flex-none justify-end gap-snug px-loose pt-tight pb-loose">
          <Button type="button" onClick={onCancel}>
            {t('context.consent.cancel')}
          </Button>
          <Button type="button" ref={acceptRef} variant="primary" onClick={accept}>
            {t('context.consent.accept')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function stop(e: React.MouseEvent): void {
  e.stopPropagation()
}
