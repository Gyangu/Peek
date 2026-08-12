import type { Message, MessageArgs } from '@peek/core'
import { en, type Messages } from './messages/en'
import { zhCN } from './messages/zh-CN'
import type { Locale } from './locales'

/**
 * Every catalog, keyed by locale.
 *
 * All locales are bundled eagerly rather than code-split. The whole catalog is
 * a few kilobytes of strings, while a lazy load would mean the first paint after
 * a language switch renders the wrong language — a visible flash in exchange for
 * nothing measurable. Revisit if peek ever ships a dozen languages.
 */
export const CATALOGS: Readonly<Record<Locale, Readonly<Record<string, Message>>>> = {
  en,
  'zh-CN': zhCN,
}

export type { Messages }

/** Every valid translation key. Misspell one and the build fails. */
export type MessageKey = keyof Messages & string

/**
 * The keys whose message takes no interpolation params.
 *
 * `t` requires a params argument exactly when the message has placeholders, so a
 * key that arrives as **data** — a connect field's label, a package view kind's
 * title — can only be called with one argument if it is known to be
 * parameterless. This is that narrowing.
 *
 * It lived in `components/connectForm.ts` while the connect dialog was its only
 * consumer. The package view-kind registry is the second, and a type two
 * unrelated surfaces depend on does not belong inside one of them.
 */
export type PlainMessageKey = {
  [K in MessageKey]: MessageArgs<Messages[K]> extends [] ? K : never
}[MessageKey]
