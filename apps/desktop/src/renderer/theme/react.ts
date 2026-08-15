import { useSyncExternalStore } from 'react'
import type { ResolvedTheme, UiTheme } from '@peek/core'
import { getTheme, getThemePreference, subscribeTheme } from './store'

/**
 * React bindings, on the same no-provider footing as `i18n/react.ts`:
 * `useSyncExternalStore` over the theme store re-renders every subscriber when
 * the window flips, and a component can still be mounted in a test or from a
 * portal without scaffolding.
 */

/** What is painted right now. For code that needs the answer as a value. */
export function useTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme)
}

/**
 * What the user picked, which may be `system`.
 *
 * Only the settings picker wants this: everything else wants to know what is on
 * screen, and `system` is not an answer to that.
 */
export function useThemePreference(): UiTheme {
  return useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference)
}
