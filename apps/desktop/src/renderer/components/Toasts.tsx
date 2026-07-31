import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { useNotifyStore } from '../state/notifyStore'

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
        <div key={toast.id} className={`toast ${toast.level}`}>
          <div className="msg">
            <span className="grow">{toast.message}</span>
            <button
              className="ghost"
              title={t('app.toast.dismiss')}
              onClick={() => {
                dismiss(toast.id)
              }}
            >
              ✕
            </button>
          </div>
          {toast.detail ? <div className="detail">{toast.detail}</div> : null}
        </div>
      ))}
    </div>
  )
}
