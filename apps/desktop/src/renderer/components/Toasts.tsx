import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { useNotifyStore } from '../state/notifyStore'
import { Button } from '../ui/Button'

/**
 * Bottom-right notifications: command failures, driver crashes, and NOTIFY
 * messages pushed by main.
 *
 * The text itself is already resolved — `notifyStore` localizes at push time so
 * that a toast keeps the language it was raised in (see the note there). Only the
 * chrome around it goes through `t()`.
 */
export function Toasts(): ReactElement | null {
  const t = useT()
  const toasts = useNotifyStore((s) => s.toasts)
  const dismiss = useNotifyStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        // A screen reader heard none of these before: the window's one live
        // region (`App`'s `LiveRegion`) is driven by `useLayoutAnnouncer` and
        // carries layout changes only, so every failure notice in peek — a
        // driver crash, a refused command — arrived silently. `alert` is the
        // assertive role and is right for a warning or an error; an info toast
        // is `status`, which is polite and waits its turn.
        <div
          key={toast.id}
          className={`toast ${toast.level}`}
          role={toast.level === 'info' ? 'status' : 'alert'}
        >
          <div className="msg">
            <span className="grow">{toast.message}</span>
            <Button
              variant="ghost"
              size="sm"
              icon
              label={t('app.toast.dismiss')}
              onClick={() => {
                dismiss(toast.id)
              }}
            >
              ✕
            </Button>
          </div>
          {toast.detail ? <div className="detail">{toast.detail}</div> : null}
        </div>
      ))}
    </div>
  )
}
