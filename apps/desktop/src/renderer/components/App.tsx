import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { dispatch } from '../state/dispatch'
import { readWorkspace, useWorkspaceStore } from '../state/workspaceStore'
import { LayoutTree } from './LayoutTree'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'

export function App(): ReactElement {
  useGlobalKeys()
  const ready = useWorkspaceStore((s) => s.ready)
  const bridgeMissing = useWorkspaceStore((s) => s.bridgeMissing)

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">peek</span>
        <span className="spacer" />
        {bridgeMissing ? (
          <span className="no-drag" style={{ color: 'var(--err)' }}>
            preload 桥未就绪
          </span>
        ) : !ready ? (
          <span className="no-drag" style={{ color: 'var(--fg-faint)' }}>
            同步状态中…
          </span>
        ) : null}
      </div>

      <div className="body">
        <Sidebar />
        <div className="workarea">
          <LayoutTree />
        </div>
      </div>

      <StatusBar />
      <Toasts />
    </div>
  )
}

/**
 * 全局快捷键。注意：这里同样只发命令，不动状态。
 * ⌘⏎ 由查询视图的 CodeMirror keymap 自己处理，不在这里抢。
 */
function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const ws = readWorkspace()
      if (!ws) return
      const panelId = ws.focusedPanel
      if (!panelId) return
      // ⌘\ 左右分屏，⌘⇧\ 上下分屏，⌘W 关闭当前面板
      if (e.key === '\\') {
        e.preventDefault()
        void dispatch('layout.split', { panelId, dir: e.shiftKey ? 'col' : 'row' })
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault()
        void dispatch('layout.close', { panelId })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
