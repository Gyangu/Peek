import { create } from 'zustand'
import type { NotifyLevel, PeekError } from '@peek/core'

/**
 * 通知/错误提示。这是**纯 renderer 的瞬时 UI 状态**，
 * 不属于 Workspace 真源，因此可以本地持有（不违反"renderer 不改状态"）。
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

/** 同时最多堆这么多条，多了丢最旧的 */
const MAX_TOASTS = 5
/** info 级自动消失时长 */
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

/** 把 PeekError 转成一条 error toast */
export function notifyError(err: PeekError, prefix?: string): void {
  const head = prefix ? `${prefix}：${err.message}` : err.message
  notify('error', `[${err.code}] ${head}`, err.detail)
}
