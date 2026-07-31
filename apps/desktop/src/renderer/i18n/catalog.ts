import type { Message } from '@peek/core'
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
