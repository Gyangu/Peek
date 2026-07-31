import type { Message, PluralForms } from '@peek/core'

/**
 * The type a non-English domain file must satisfy: same keys as its English
 * counterpart, same string-vs-plural shape, arbitrary wording.
 *
 * Typing each translation file against its own English file (rather than
 * checking the whole catalog once at the end) is what makes the compiler point
 * at the file you are editing and name the keys you forgot.
 */
export type CatalogFor<T extends Readonly<Record<string, Message>>> = {
  readonly [K in keyof T]: T[K] extends PluralForms ? PluralForms : string
}
