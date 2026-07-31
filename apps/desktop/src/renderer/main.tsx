import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { initLocale } from './i18n'
import { startRenderer } from './state/sync'
import './styles.css'

/**
 * Renderer entry point.
 *
 * The wiring (patch subscription, MessagePort intake) happens outside React so
 * that StrictMode's double-invoked effects cannot produce duplicate subscriptions.
 */

// Before the first render, so the window never paints English and then swaps.
initLocale()

startRenderer()

const root = document.getElementById('root')
// Not localized on purpose: this fires before React (and the catalog) matter, and
// nobody but a developer is ever meant to see it.
if (!root) throw new Error('Mount point #root not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
