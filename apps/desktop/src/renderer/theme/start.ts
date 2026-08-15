import { tryBridge } from '../bridge'
import { adoptTheme, initTheme } from './store'

/**
 * Adopt the cached theme and start listening for main's answer.
 *
 * Called once at module scope from `main.tsx`, not from a hook: `StrictMode`
 * double-invokes effects, and the cached theme has to be on the root element
 * *before* React mounts anyway — a hook would paint one frame the wrong way
 * round on every launch, which is the whole thing the cache exists to avoid.
 *
 * A window with no bridge keeps the cached theme and never hears about a change.
 * That is the right degradation: preload can fail (it has its own fallback
 * path), and a window painted the way it was last time is one a person can still
 * read. Main has already put the reason on the error centre.
 */
export function startTheme(): void {
  initTheme()

  const bridge = tryBridge()
  // Feature-probed for the reason `useMenuActions` gives: `tryBridge` only
  // vouches for `invoke` and `getSnapshot`, so a preload older than this channel
  // would take the window down at startup rather than merely look wrong.
  if (!bridge || typeof bridge.onThemeChanged !== 'function') return
  bridge.onThemeChanged((msg) => {
    adoptTheme({ theme: msg.theme, resolved: msg.resolved })
  })
}
