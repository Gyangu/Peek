import type { ReactElement } from 'react'
import { useNotifyStore } from '../state/notifyStore'

/** 右下角通知：命令错误、driver 崩溃提示、main 主动 NOTIFY */
export function Toasts(): ReactElement | null {
  const toasts = useNotifyStore((s) => s.toasts)
  const dismiss = useNotifyStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <div className="msg">
            <span className="grow">{t.message}</span>
            <button
              className="ghost"
              onClick={() => {
                dismiss(t.id)
              }}
            >
              ✕
            </button>
          </div>
          {t.detail ? <div className="detail">{t.detail}</div> : null}
        </div>
      ))}
    </div>
  )
}
