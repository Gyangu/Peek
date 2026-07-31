import { DEFAULT_LOCALE, isLocale, type Locale } from './locales'

/**
 * The active locale.
 *
 * Deliberately *not* part of the Workspace store. Workspace is main's source of
 * truth and is what MCP reads; putting the UI language in there would mean main
 * knows how the window is rendered, and would let a language switch show up as a
 * workspace revision that the AI has to reason about. The language a human reads
 * is renderer-local preference, nothing more.
 *
 * Implemented as a plain external store rather than React context so that
 * non-component code (the notify store, the result cache) can read the current
 * locale without a provider hanging over the whole tree.
 */

const STORAGE_KEY = 'peek.locale'

let current: Locale = DEFAULT_LOCALE
const listeners = new Set<() => void>()

/**
 * Storage access is wrapped because production loads the renderer from `file://`
 * (`win.loadFile`), and a file-origin document can be denied storage outright
 * depending on how Chromium partitions it. Losing the preference is acceptable;
 * throwing during module init and taking the window down with it is not.
 */
function readStored(): Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return isLocale(raw) ? raw : null
  } catch {
    return null
  }
}

function writeStored(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Preference is best-effort; the session still honours the switch.
  }
}

/**
 * Adopt the persisted locale. Call once at renderer startup, before React
 * mounts, so the first paint is already in the right language.
 */
export function initLocale(): Locale {
  const stored = readStored()
  if (stored !== null) current = stored
  applyDocumentLang(current)
  return current
}

export function getLocale(): Locale {
  return current
}

export function setLocale(next: Locale): void {
  if (next === current) return
  current = next
  writeStored(next)
  applyDocumentLang(next)
  for (const listener of listeners) listener()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Keeps `<html lang>` honest, which is what hyphenation and screen readers read. */
function applyDocumentLang(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}
