import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { dispatch } from '../state/dispatch'
import { readWorkspace, useWorkspaceStore } from '../state/workspaceStore'
import { LayoutTree } from './LayoutTree'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'

export function App(): ReactElement {
  const t = useT()
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
            {t('app.bridgeNotReady')}
          </span>
        ) : !ready ? (
          <span className="no-drag" style={{ color: 'var(--fg-faint)' }}>
            {t('app.syncing')}
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
 * Global shortcuts. Like everything else in the renderer, they only send
 * commands — they never touch state directly.
 *
 * ⌘⏎ is deliberately left alone: the query view's CodeMirror keymap owns it, and
 * intercepting it here would fire while the editor still holds focus.
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
      // ⌘\ splits left/right, ⌘⇧\ splits top/bottom, ⌘W closes the focused panel
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
