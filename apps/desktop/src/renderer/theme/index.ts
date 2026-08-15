/**
 * peek's theme — the public surface. Import from `../theme`, never from the
 * files inside it.
 *
 * Components that only need to *paint* need nothing from here: every utility
 * class reads its colour through `var(--color-*)` and the root element's
 * `data-theme` does the rest. This exists for the few places that have to know
 * the answer as a value — the settings picker, and the package frames, which
 * carry it across a `postMessage` into an iframe that has its own stylesheet.
 *
 * See `design/2026-08-15-light-and-dark-theme.md`.
 */

export {
  adoptTheme,
  getTheme,
  getThemePreference,
  initTheme,
  subscribeTheme,
} from './store'
export { useTheme, useThemePreference } from './react'
export { startTheme } from './start'
