import { create } from 'zustand'
import type { NotifyLevel, PeekError } from '@peek/core'
import { localizeErrorNow, tStatic } from '../i18n'

/**
 * Notifications and error toasts. This is **purely transient renderer UI state**,
 * not part of the Workspace source of truth, so holding it locally does not
 * violate "the renderer never mutates state".
 */
export interface Toast {
  id: number
  level: NotifyLevel
  message: string
  detail?: string
  ts: number
}

interface NotifyState {
  toasts: Toast[]
  push: (level: NotifyLevel, message: string, detail?: string) => void
  dismiss: (id: number) => void
  clear: () => void
}

let seq = 0

/** How many can stack at once; the oldest is dropped beyond this. */
const MAX_TOASTS = 5
/** How long an info-level toast stays up. */
const AUTO_DISMISS_MS = 4500

export const useNotifyStore = create<NotifyState>((set) => ({
  toasts: [],
  push: (level, message, detail) => {
    seq += 1
    const id = seq
    set((s) => {
      const next = [...s.toasts, { id, level, message, ...(detail ? { detail } : {}), ts: Date.now() }]
      return { toasts: next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next }
    })
    if (level === 'info') {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, AUTO_DISMISS_MS)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

export function notify(level: NotifyLevel, message: string, detail?: string): void {
  useNotifyStore.getState().push(level, message, detail)
}

/**
 * Turn a PeekError into an error toast.
 *
 * The text is localized at push time rather than at render time, so a toast
 * already on screen keeps the language it was raised in. That is a deliberate
 * trade: keeping toasts translatable would mean storing the PeekError in the
 * store and resolving it in the component, and a toast lives for seconds while a
 * language switch is a once-a-session act. Anything long-lived — view errors,
 * status bar, panel chrome — resolves at render time instead, via `useErrorText`.
 */
export function notifyError(err: PeekError, context?: string): void {
  const text = localizeErrorNow(err)
  const head = context ? tStatic('app.error.prefixed', { context, message: text }) : text
  notify('error', `[${err.code}] ${head}`, err.detail)
}
