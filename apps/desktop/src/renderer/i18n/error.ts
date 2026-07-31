import type { PeekError } from '@peek/core'
import type { Locale } from './locales'
import { getLocale } from './store'
import { translateDynamic } from './translate'

/**
 * Turning a cross-process `PeekError` into words on screen.
 *
 * The contract, in one line: **`i18n` present means peek wrote the sentence and
 * the window may say it in any language; `i18n` absent means the text came from
 * somewhere else and is shown exactly as received.**
 *
 * That second case is not a gap, it is the point. A PostgreSQL error like
 * `relation "usres" does not exist` is not prose, it is evidence — the same
 * string the user will paste into a search box, the same string that appears in
 * the server log, and often the only place the misspelling is visible. Machine
 * translating it would make it harder to act on, not easier. `detail`,
 * `driverCode` and `position` are technical for the same reason and are never
 * translated either.
 *
 * `code` is also never translated. `NOT_FOUND` is an identifier that humans grep
 * and AI matches on, exactly like an HTTP status name.
 */
export function localizeError(locale: Locale, error: PeekError): string {
  const descriptor = error.i18n
  if (descriptor === undefined) return error.message
  // An unknown key means a version skew between the driver host bundle and this
  // window. The English `message` travelled with the error precisely so that
  // case degrades to readable text instead of a bare key.
  return translateDynamic(locale, descriptor.key, descriptor.params) ?? error.message
}

/** Non-reactive variant, for stores and event handlers. See `tStatic`. */
export function localizeErrorNow(error: PeekError): string {
  return localizeError(getLocale(), error)
}
