import type { ResolvedTheme, UiTheme } from '@peek/core'
import { UI_THEME_DEFAULT } from '@peek/core'

/**
 * Which way round the window is painted.
 *
 * **Main owns this, unlike the locale next door.** `i18n/store.ts` keeps the
 * language entirely in the renderer because nothing outside the window cares
 * what language it is in; the theme is the opposite — the window's
 * `backgroundColor`, the traffic lights and `nativeTheme.themeSource` are all
 * main-side, and `system` can only be resolved where `nativeTheme` is. So the
 * preference lives in `settings.json` and the resolution arrives on
 * `IPC.THEME_CHANGED`. See `design/2026-08-15-light-and-dark-theme.md` §2.1.
 *
 * What *is* borrowed from the locale store is the shape: a plain external store
 * rather than React context, so that non-component code can read the theme
 * without a provider hanging over the tree — the package frames need it, and
 * they are not always mounted under one.
 *
 * ## Why there is a cached copy at all
 *
 * The resolution arrives asynchronously, and the first paint does not wait for
 * it. Without a cache the window would paint dark (the `@theme` default) and
 * flip to light a moment later, on every launch, for every light-mode user.
 * `localStorage` holds the **last resolved** theme purely so the first frame can
 * be optimistic; main's answer overrides it as soon as it lands, and a stale
 * cache costs one repaint rather than a wrong window. The pre-paint ground
 * behind that frame is already correct either way — main sets the window's
 * `backgroundColor` before the renderer runs a line.
 *
 * A synchronous read at preload time (the trick `IPC.PACKAGES_READ` uses) would
 * remove even that repaint, and is deliberately not taken: that channel's own
 * note says it is not a general-purpose one and must not grow into one, and a
 * cosmetic first frame is a weaker case than the one it was opened for.
 */

const STORAGE_KEY = 'peek.theme.resolved'

/** The preference, as far as the window knows. Only the settings dialog reads it. */
let preference: UiTheme = UI_THEME_DEFAULT
/** What is actually painted. Everything else reads this. */
let resolved: ResolvedTheme = 'dark'

const listeners = new Set<() => void>()

/**
 * Storage access is wrapped for the reason `i18n/store.ts` gives: production
 * loads the renderer from `file://`, and a file-origin document can be denied
 * storage outright. Losing the cache costs one repaint; throwing during module
 * init would cost the window.
 */
function readCached(): ResolvedTheme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === 'dark' || raw === 'light' ? raw : null
  } catch {
    return null
  }
}

function writeCached(theme: ResolvedTheme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Best-effort; the session is still painted correctly.
  }
}

/**
 * Adopt the cached theme. Call once at renderer startup, before React mounts, so
 * the first paint is already the right way round.
 */
export function initTheme(): ResolvedTheme {
  const cached = readCached()
  if (cached !== null) resolved = cached
  applyDocumentTheme(resolved)
  return resolved
}

export function getTheme(): ResolvedTheme {
  return resolved
}

export function getThemePreference(): UiTheme {
  return preference
}

/**
 * Main's answer. The only writer — the settings dialog picks a theme by sending
 * `settings.write`, and the change comes back through here.
 *
 * Compares before touching the DOM because `nativeTheme`'s `updated` event fires
 * for every `themeSource` write as well as for a real OS flip, so this is called
 * more often than the theme actually changes.
 */
export function adoptTheme(next: { theme: UiTheme; resolved: ResolvedTheme }): void {
  const changed = next.theme !== preference || next.resolved !== resolved
  if (!changed) return
  preference = next.theme
  resolved = next.resolved
  writeCached(next.resolved)
  applyDocumentTheme(next.resolved)
  for (const listener of listeners) listener()
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The one line that repaints the window.
 *
 * `data-theme` on the root element, which is what `:root[data-theme='light']` in
 * `styles.css` selects. Every utility class already reads its colour through
 * `var(--color-*)`, so nothing else has to know a theme changed.
 */
function applyDocumentTheme(theme: ResolvedTheme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset['theme'] = theme
}
