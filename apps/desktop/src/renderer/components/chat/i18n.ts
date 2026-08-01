import { useMemo } from 'react'
import { formatMessage, type MessageArgs, type MessageParamMap } from '@peek/core'
import { DEFAULT_LOCALE, useLocale, type Locale } from '../../i18n'
import { chatEn, type ChatMessageKey, type ChatMessages } from './messages.en'
import { chatZhCN } from './messages.zh-CN'

/**
 * Translation for the chat panel.
 *
 * ## Why the chat slice has its own catalog
 *
 * `i18n/messages/en/index.ts` is a shared file, and the whole point of the
 * domain-file split next to it ("add your keys to the file that matches your
 * surface, never to this one") is that parallel work does not collide in it.
 * The chat panel is being built alongside the ACP backend and the view
 * integration, so its strings ship *inside the panel's own directory* and are
 * folded into the app catalog when the panel is wired in.
 *
 * Nothing here forks the i18n system. The same `formatMessage` engine does the
 * interpolation and the same locale store drives re-rendering, so plurals,
 * placeholder typing and language switching behave identically. What differs is
 * only which object the key is looked up in.
 *
 * ## Folding it in (a three-line change, when the shared file is free)
 *
 *   1. move `messages.en.ts` → `i18n/messages/en/chat.ts`, `messages.zh-CN.ts`
 *      → `i18n/messages/zh-CN/chat.ts`;
 *   2. spread `...chat` in both `index.ts` files;
 *   3. replace `useChatT` with `useT` here and delete this module.
 *
 * Step 3 is a rename: `ChatTFunction` is `TFunction` narrowed to the chat keys,
 * so every call site already compiles against the app-wide one.
 */

const CHAT_CATALOGS: Readonly<Record<Locale, Readonly<Record<string, unknown>>>> = {
  en: chatEn,
  'zh-CN': chatZhCN,
}

/**
 * Same signature as the app-wide `TFunction`, restricted to the chat keys: the
 * params argument is required exactly when the English string has placeholders,
 * and its keys are checked against that string.
 */
export type ChatTFunction = <K extends ChatMessageKey>(
  key: K,
  ...args: MessageArgs<ChatMessages[K]>
) => string

function lookup(locale: Locale, key: string): unknown {
  return CHAT_CATALOGS[locale][key] ?? CHAT_CATALOGS[DEFAULT_LOCALE][key]
}

function translateChat(locale: Locale, key: string, params?: MessageParamMap): string {
  const message = lookup(locale, key)
  if (typeof message !== 'string' && typeof message !== 'object') return key
  return formatMessage(message as Parameters<typeof formatMessage>[0], locale, params)
}

const bound = new Map<Locale, ChatTFunction>()

function boundChatT(locale: Locale): ChatTFunction {
  const hit = bound.get(locale)
  if (hit) return hit
  const fn: ChatTFunction = (key, ...args) =>
    translateChat(locale, key, args[0] as MessageParamMap | undefined)
  bound.set(locale, fn)
  return fn
}

/**
 * The chat panel's translate function, re-rendering on a language switch exactly
 * like `useT`.
 */
export function useChatT(): ChatTFunction {
  const locale = useLocale()
  return useMemo(() => boundChatT(locale), [locale])
}

/** For the handful of non-component call sites (event handlers, toasts). */
export function chatTStatic(locale: Locale, key: ChatMessageKey, params?: MessageParamMap): string {
  return translateChat(locale, key, params)
}

export { chatEn, chatZhCN }
export type { ChatMessageKey, ChatMessages }
