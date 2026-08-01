import type { ReactElement } from 'react'
import { useAnnouncement, useGlobalKeys, useLayoutAnnouncer } from '../hooks'
import { useT } from '../i18n'
import { useWorkspaceStore } from '../state/workspaceStore'
import { ChatSessionsRail } from './chat'
import { LayoutTree } from './LayoutTree'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'
import '../keyboard-nav.css'

export function App(): ReactElement {
  const t = useT()
  useGlobalKeys()
  useLayoutAnnouncer()
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
        {/* Squeezes the work area rather than floating over it: the panel tab
            strip lives in the top-right corner, and an overlay would sit on the
            split and close buttons. See
            `design/2026-08-02-chat-sessions-side-rail.md` §2.1. */}
        <ChatSessionsRail />
      </div>

      <StatusBar />
      <Toasts />
      <LiveRegion />
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The window's one live region.
 *
 * One, deliberately, and mounted here rather than inside a panel: a region per
 * panel would say four things at once the moment a split re-arranges the
 * layout, and a screen reader queues them all. Being a sibling of everything
 * else also means it survives any subtree unmounting, so an announcement about
 * a panel that has just gone away still gets read.
 *
 * `polite`, never `assertive`: nothing announced here is urgent enough to cut
 * across a sentence the user is already listening to. `atomic` because the
 * messages are whole sentences — re-reading only the changed words would
 * produce "3 of 4" with no subject.
 *
 * It is empty on first render and stays empty until something actually changes;
 * see `useLayoutAnnouncer`, which owns the decision of what is worth saying.
 * What it must never carry is streaming query progress — a region that speaks on
 * every row batch is a region users switch off.
 */
function LiveRegion(): ReactElement {
  const t = useT()
  const text = useAnnouncement()
  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t('a11y.region.label')}
    >
      {text}
    </div>
  )
}
