/**
 * Message formatting primitives.
 *
 * These live in core rather than in the renderer because two independent
 * consumers need byte-identical interpolation semantics:
 *
 *   - main / driver host, which render the canonical **English** text of a
 *     PeekError into `PeekError.message` (that text is what MCP and the logs see);
 *   - renderer, which renders the **localized** text of the very same error, plus
 *     every UI string.
 *
 * One implementation means the two can never drift apart, and it means a
 * placeholder that works in English works in every other locale too.
 *
 * Deliberately tiny — no ICU parser, no runtime dependency, ~1KB in the renderer
 * bundle. The syntax is `{name}` placeholders plus CLDR plural categories, which
 * is everything peek actually needs.
 */

/**
 * A message with CLDR plural forms.
 *
 * `other` is required and acts as the fallback for every category a given locale
 * does not spell out. That is what makes adding a third language cheap: Russian
 * fills in `few` / `many`, Chinese fills in nothing but `other`, and neither one
 * forces a change to the other catalogs.
 */
export interface PluralForms {
  readonly zero?: string
  readonly one?: string
  readonly two?: string
  readonly few?: string
  readonly many?: string
  readonly other: string
}

/** Either a plain template or a set of plural forms. */
export type Message = string | PluralForms

export type MessageParamValue = string | number

/** Runtime shape of an interpolation bag. Must survive structured clone (IPC). */
export type MessageParamMap = Readonly<Record<string, MessageParamValue>>

/* ==================================================================== */
/* Compile-time placeholder extraction                                   */
/* ==================================================================== */

/**
 * Names of the `{placeholder}`s in a template literal type.
 *
 * `'Loaded {n} of {total}'` → `'n' | 'total'`. Yields `never` when the template
 * has no placeholders, which is how the API decides whether the params argument
 * is required or forbidden.
 */
export type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never

/** Placeholders across every form of a plural message. */
type PluralPlaceholderNames<M extends PluralForms> = PlaceholderNames<Extract<M[keyof M], string>>

type ParamsFromNames<Names extends string> = [Names] extends [never]
  ? never
  : { readonly [K in Names]: MessageParamValue }

/**
 * The non-`count` placeholders of a plural message, or `unknown` when there are
 * none. `unknown` and not `never`: `{ count: number } & never` collapses to
 * `never`, which would make every simple plural message uncallable.
 */
type PluralExtraParams<M extends PluralForms> = [Exclude<PluralPlaceholderNames<M>, 'count'>] extends [
  never,
]
  ? unknown
  : { readonly [K in Exclude<PluralPlaceholderNames<M>, 'count'>]: MessageParamValue }

/** Collapses an intersection into a single object literal so editor hints stay readable. */
type Flatten<T> = T extends infer R ? { readonly [K in keyof R]: R[K] } : never

type PluralParams<M extends PluralForms> = Flatten<
  {
    /** Drives plural-category selection. Also substitutable as `{count}`. */
    readonly count: number
  } & PluralExtraParams<M>
>

/**
 * The exact params object a message requires, or `never` when it takes none.
 *
 * Drives the call signature of `t()` / `peekErrorMsg()`: misspelling a param name
 * or forgetting one is a compile error, not a `{n}` leaking into the UI.
 */
export type MessageParams<M extends Message> = M extends PluralForms
  ? PluralParams<M>
  : M extends string
    ? ParamsFromNames<PlaceholderNames<M>>
    : never

/**
 * Argument tuple for a translate call: `[]` when the message takes no params,
 * `[params]` when it does. Spread as `...args` so the params argument is
 * *required* exactly when the message has placeholders.
 */
export type MessageArgs<M extends Message> = [MessageParams<M>] extends [never]
  ? []
  : [params: MessageParams<M>]

/* ==================================================================== */
/* Runtime                                                              */
/* ==================================================================== */

/**
 * Substitute `{name}` placeholders.
 *
 * A placeholder with no matching param is left **verbatim** rather than replaced
 * with an empty string: a visible `{count}` in the UI is a bug report, a silent
 * blank is a bug that ships.
 *
 * No implicit number formatting — `123456` renders as `123456`, not `123,456`.
 * Grouping is a caller decision (see `util/format.ts#formatCount`), so pass the
 * pre-formatted string in when you want it.
 */
export function formatTemplate(template: string, params?: MessageParamMap): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** Cached per locale — constructing Intl.PluralRules is not free. */
const pluralRulesCache = new Map<string, Intl.PluralRules>()

function pluralRulesFor(locale: string): Intl.PluralRules {
  const hit = pluralRulesCache.get(locale)
  if (hit) return hit
  const rules = new Intl.PluralRules(locale)
  pluralRulesCache.set(locale, rules)
  return rules
}

/**
 * Render a message for a locale.
 *
 * Plural selection uses `Intl.PluralRules`, so it is the platform's CLDR data
 * doing the work, not a hand-rolled `n === 1` test that breaks the moment a
 * language with a `few` category shows up.
 */
export function formatMessage(message: Message, locale: string, params?: MessageParamMap): string {
  if (typeof message === 'string') return formatTemplate(message, params)
  const raw = params?.['count']
  const count = typeof raw === 'number' ? raw : Number(raw ?? 0)
  const category = pluralRulesFor(locale).select(count)
  const form = message[category] ?? message.other
  return formatTemplate(form, params)
}

/**
 * Placeholder names in a template, at runtime.
 * Used by the catalog parity test to prove every locale interpolates the same
 * set of params — the one class of bug the type system cannot catch, because
 * translations are plain strings by design.
 */
export function placeholdersOf(message: Message): ReadonlySet<string> {
  const names = new Set<string>()
  const forms = typeof message === 'string' ? [message] : Object.values(message)
  for (const form of forms) {
    if (typeof form !== 'string') continue
    for (const match of form.matchAll(/\{(\w+)\}/g)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return names
}
