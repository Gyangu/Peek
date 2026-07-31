/**
 * Supported locales.
 *
 * Adding a third one is a four-step change, all of it compiler-guided:
 *   1. add the tag to `LOCALES` below;
 *   2. create `messages/<tag>/` mirroring `messages/en/` — every domain file is
 *      typed against its English counterpart, so tsc lists the missing keys;
 *   3. register the catalog in `catalog.ts`;
 *   4. run the tests — `__tests__/i18n.test.ts` proves the key sets and the
 *      interpolation placeholders line up across all locales.
 * Nothing else in the app needs touching.
 */

export const LOCALES = [
  /** Endonyms, not translations: a language picker written in a language you do
   *  not read is useless, so "中文" stays "中文" in the English UI too. */
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '中文' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/**
 * The locale everything falls back to.
 *
 * peek ships English by default and does **not** sniff `navigator.language`.
 * Two reasons, in order of weight:
 *
 *   1. The window is a shared surface. MCP drives the same UI a human is looking
 *      at, and command logs, bug reports and screenshots are meant to be
 *      comparable across machines. A locale that silently varies with the host OS
 *      makes "what does the panel say" an unanswerable question.
 *   2. English is the product default by decision, and auto-detection would make
 *      that claim false for exactly the users who would notice.
 *
 * Users who want another language pick one; the choice is persisted. If system
 * detection is ever wanted, it belongs in `loadPersistedLocale()` as the fallback
 * branch — a three-line change, deliberately not taken today.
 */
export const DEFAULT_LOCALE: Locale = 'en'

const LOCALE_IDS: readonly string[] = LOCALES.map((l) => l.id)

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALE_IDS.includes(value)
}
