import { formatMessage, type MessageArgs, type MessageParamMap } from '@peek/core'
import { CATALOGS, type MessageKey, type Messages } from './catalog'
import { DEFAULT_LOCALE, type Locale } from './locales'
import { getLocale } from './store'

/**
 * A bound translate function.
 *
 * The params argument is required exactly when the message has placeholders and
 * forbidden when it does not, and its keys are derived from the English string
 * itself — `t('status.connected', { ready, total })` compiles, dropping `total`
 * does not.
 */
export type TFunction = <K extends MessageKey>(key: K, ...args: MessageArgs<Messages[K]>) => string

/**
 * Look a key up without the compile-time key type.
 *
 * Only for keys that arrive at runtime — today that means `PeekError.i18n.key`,
 * which crosses IPC as a plain string. Returns `undefined` for keys this build
 * does not know, so the caller can fall back to the English `message` instead of
 * printing a raw key at the user.
 */
export function translateDynamic(
  locale: Locale,
  key: string,
  params?: MessageParamMap,
): string | undefined {
  const message = CATALOGS[locale][key] ?? CATALOGS[DEFAULT_LOCALE][key]
  return message === undefined ? undefined : formatMessage(message, locale, params)
}

/** Translate for an explicit locale. */
export function translate<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...args: MessageArgs<Messages[K]>
): string {
  // A key missing from every catalog is a bug, not a user-facing condition:
  // render the key so it shows up in a screenshot and greps straight to source.
  return translateDynamic(locale, key, args[0] as MessageParamMap | undefined) ?? key
}

/**
 * Translate using whatever locale is active right now.
 *
 * **Do not call this from a component.** It reads the locale once and does not
 * subscribe, so a language switch will leave the rendered text stale until
 * something else happens to re-render. Components use `useT()`. This exists for
 * the code that has no render pass to hook into — stores, event handlers,
 * imperative helpers.
 */
export function tStatic<K extends MessageKey>(key: K, ...args: MessageArgs<Messages[K]>): string {
  return translate(getLocale(), key, ...args)
}

const bound = new Map<Locale, TFunction>()

/** A `t` bound to one locale, cached so React sees a stable identity per locale. */
export function boundT(locale: Locale): TFunction {
  const hit = bound.get(locale)
  if (hit) return hit
  const fn: TFunction = (key, ...args) => translate(locale, key, ...args)
  bound.set(locale, fn)
  return fn
}
