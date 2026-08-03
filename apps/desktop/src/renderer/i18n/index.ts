/**
 * peek i18n — the public surface. Import from `../i18n`, never from the files
 * inside it.
 *
 * Components:
 *
 *   import { useT } from '../i18n'
 *   const t = useT()
 *   t('panel.empty')                                  // no params
 *   t('status.connected', { ready, total })           // params are type-checked
 *   t('status.rows', { count: n, rows: formatCount(n) })  // plural + formatted number
 *
 * Everything else (stores, handlers, plain functions):
 *
 *   import { tStatic } from '../i18n'
 *
 * Errors:
 *
 *   const text = useErrorText(view.error)   // in a component
 *   const text = localizeErrorNow(err)      // anywhere else
 *
 * Adding a string: put the English in `messages/en/<domain>.ts`, the translation
 * in `messages/zh-CN/<domain>.ts`. The compiler will not let you do only one.
 *
 * Adding a language: see the note at the top of `locales.ts`.
 */

export { LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from './locales'
export { getLocale, setLocale, subscribeLocale, initLocale } from './store'
export { translate, translateDynamic, tStatic, boundT, type TFunction } from './translate'
export { localizeError, localizeErrorNow } from './error'
export { useLocale, useT, useErrorText } from './react'
export type { MessageKey, Messages, PlainMessageKey } from './catalog'
