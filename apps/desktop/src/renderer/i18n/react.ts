import { useSyncExternalStore } from 'react'
import type { PeekError } from '@peek/core'
import { localizeError } from './error'
import type { Locale } from './locales'
import { getLocale, subscribeLocale } from './store'
import { boundT, type TFunction } from './translate'

/**
 * React bindings.
 *
 * No provider and no context: `useSyncExternalStore` over the locale store gets
 * every subscribed component re-rendered on a switch, which is the entire job.
 * Skipping the provider means components can be mounted in tests, or rendered
 * from a portal, without extra scaffolding.
 */

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

/**
 * The translate function for the active locale. Use this in every component that
 * renders text — it is what makes the language switch take effect.
 *
 *   const t = useT()
 *   <span>{t('status.connected', { ready, total })}</span>
 */
export function useT(): TFunction {
  return boundT(useLocale())
}

/** Localized text for a structured error, re-rendered on a language switch. */
export function useErrorText(error: PeekError | undefined): string | undefined {
  const locale = useLocale()
  return error === undefined ? undefined : localizeError(locale, error)
}
