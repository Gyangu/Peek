import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { startChat } from './components/chat'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initLocale } from './i18n'
import { startPlugins } from './plugins/register'
import { startRenderer } from './state/sync'
import './styles.css'

/**
 * Renderer entry point.
 *
 * The wiring (patch subscription, MessagePort intake) happens outside React so
 * that StrictMode's double-invoked effects cannot produce duplicate subscriptions.
 *
 * `ErrorBoundary` sits outside `App` rather than around a subtree: this window is
 * a mirror of state owned by main, so a value the renderer cannot draw can turn
 * up anywhere in it, and React's answer to an uncaught render error is to unmount
 * everything. Catching it here is the difference between a message with a Reload
 * button and a blank window that keeps quietly applying patches nobody renders.
 */

// Before the first render, so the window never paints English and then swaps.
initLocale()

startRenderer()

// Before the first render, and at module scope for the same reason as the two
// calls around it. A restored workspace can contain a plugin view, and a view
// whose kind is not registered yet renders as `view.pluginMissing` — a wrong
// answer that would correct itself a frame later, which is worse than either
// being right or staying blank.
startPlugins()

// Two subscriptions in one call, and at module scope for the same reason
// `startRenderer` is: StrictMode double-invokes effects, and this must not
// subscribe twice. It attaches the transcript delta channel and registers the
// `ContextActionPort` the data grids' "attach this selection" menus dispatch
// through — without it those menus are visible but inert.
startChat()

const root = document.getElementById('root')
// Not localized on purpose: this fires before React (and the catalog) matter, and
// nobody but a developer is ever meant to see it.
if (!root) throw new Error('Mount point #root not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
