/**
 * The `@` in the composer: finding one, and replacing it with a name.
 *
 * Pure string work, kept out of `Composer` so the rules are testable without a
 * DOM and stated exactly once. The component owns the caret and the popover;
 * everything about *what counts as a mention* is here.
 *
 * ## A mention and its chip are one thing in two places
 *
 * The text it leaves behind is plain text — `@public.orders` is characters in a
 * textarea, not a widget — but it is **bound** to the attachment it staged.
 * Delete the word and the attachment goes; remove the chip and the word goes.
 * `atomicBackspace` is what makes that bearable: a mention deletes whole, so
 * `@public.order` is a state that never exists and nobody has to decide what a
 * half-deleted reference means.
 *
 * That is what everyone else does. The rich-text lot (Cursor, ChatGPT, Notion,
 * Linear — ProseMirror, Lexical or Tiptap underneath) make a mention an atomic
 * node: one backspace, gone, reference gone. The plain-text lot
 * (Claude Code's CLI, GitHub's comment box) keep no separate attachment state at
 * all, so deleting the text is deleting the reference by construction. Nobody
 * ships an input where the word and the thing live separate lives — an earlier
 * draft of this file proposed exactly that, and
 * design/2026-08-14-composer-inline-context.md §3.1 records why it was wrong.
 *
 * The binding is **one-way into the draft**: typing `@orders` by hand attaches
 * nothing. Only a candidate picked from the list is tracked, which is what keeps
 * peek from ever guessing which data a typed word meant.
 */

/** A mention being typed: the `@`, the caret, and the word between them. */
export interface Mention {
  /** Index of the `@`. */
  start: number
  /** Index just past the filter — the caret position that found it. */
  end: number
  /** What has been typed after the `@`; empty right after `@` itself. */
  filter: string
}

/**
 * How far back to look for the `@`.
 *
 * A ceiling rather than a scan to the start of the line: the draft can be a
 * pasted essay, this runs on every keystroke, and no name worth mentioning is
 * 64 characters long.
 */
const MAX_FILTER = 64

const isSpace = (ch: string): boolean => /\s/u.test(ch)

/**
 * The mention the caret is inside, or null.
 *
 * The `@` has to sit at the start of the text or after whitespace, which is the
 * whole reason `user@example.com` and `a@b` do not open a popover — the rule
 * that catches them is the same one that lets `(@orders` work, so it is stated
 * as "what precedes the @" and not as a list of exceptions.
 *
 * A filter never contains whitespace: the first space after `@` ends the
 * mention, because at that point the user is writing a sentence rather than
 * naming a thing.
 */
export function findMention(text: string, caret: number): Mention | null {
  const from = Math.max(0, caret - MAX_FILTER - 1)
  for (let i = caret - 1; i >= from; i--) {
    const ch = text[i]
    if (ch === undefined || isSpace(ch)) return null
    if (ch !== '@') continue
    const before = i === 0 ? '' : (text[i - 1] ?? '')
    if (before !== '' && !isSpace(before)) return null
    return { start: i, end: caret, filter: text.slice(i + 1, caret) }
  }
  return null
}

/**
 * Replace a mention with `@name`, and say where the caret lands.
 *
 * The trailing space is what makes the next word a word rather than part of the
 * name — except when the text already continues with whitespace, where adding
 * another would leave a gap the user has to delete. Mentioning in the middle of
 * a sentence is the case that pins this down: the tail after the caret is kept
 * verbatim.
 */
export function applyMention(text: string, mention: Mention, token: string): { text: string; caret: number } {
  const tail = text.slice(mention.end)
  const gap = tail !== '' && isSpace(tail[0] ?? '') ? '' : ' '
  const head = `${text.slice(0, mention.start)}@${token}${gap}`
  return { text: head + tail, caret: head.length }
}

/**
 * The word a candidate goes by in the draft.
 *
 * Whitespace is stripped rather than replaced: a name with a space in it breaks
 * in half when read inside a sentence, and the reader cannot tell where the name
 * ended. "查询 1" becomes `@查询1`, which is still the title of that tab.
 *
 * Two tables of the same name on two connections produce the same token, and
 * that is left alone. The token is how a human refers to the thing; *which*
 * result gets sent is decided by the chip, and the chip carries the view name.
 */
export function mentionToken(name: string): string {
  return name.replace(/\s+/gu, '')
}

/* ================================================================== */
/* Binding: the word in the draft and the chip are the same thing      */
/* ================================================================== */

/**
 * Where `@token` sits in the text, as whole words.
 *
 * Word boundaries are the point. `@order` must not count as `@orders` still
 * being there — otherwise renaming a mention by editing it would silently keep
 * the old attachment. Trailing punctuation does count (`@public.orders,` and
 * `@public.orders?` are the mention plus a comma), because that is a sentence,
 * not a different name.
 *
 * The character after the token has to be one that cannot be part of a name.
 * `.` and `_` can, so `@public.orders` does not match inside `@public.orders_v2`.
 */
function mentionRanges(text: string, token: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const needle = `@${token}`
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : (text[i - 1] ?? '')
    if (before !== '' && !isSpace(before)) continue
    const after = text[i + needle.length] ?? ''
    if (after !== '' && /[\p{L}\p{N}._-]/u.test(after)) continue
    out.push({ start: i, end: i + needle.length })
  }
  return out
}

/** Whether the draft still refers to this mention anywhere. */
export function hasMention(text: string, token: string): boolean {
  return mentionRanges(text, token).length > 0
}

/**
 * Remove the first occurrence of `@token`, and the space it was holding open.
 *
 * Used when a chip's ✕ is clicked: the word goes too, and the sentence around it
 * must not be left with a double space or a space before its full stop.
 */
export function dropMention(text: string, token: string): string {
  const [range] = mentionRanges(text, token)
  if (!range) return text
  let { start, end } = range
  if (isSpace(text[end] ?? '')) end += 1
  else if (start > 0 && isSpace(text[start - 1] ?? '')) start -= 1
  return text.slice(0, start) + text.slice(end)
}

/**
 * Backspace over a mention: take the whole word, or hand the key back.
 *
 * Returns null when the caret is not at the end of one, which is the signal to
 * let the textarea do what it always does. Deliberately only fires at the *end*
 * (or just past the trailing space) — deleting forwards into a mention from
 * before it is rare enough that intercepting it would cost more surprise than it
 * saves, and the reconcile pass catches whatever the user does manage to break.
 */
export function atomicBackspace(
  text: string,
  caret: number,
  tokens: readonly string[],
): { text: string; caret: number } | null {
  for (const token of tokens) {
    for (const range of mentionRanges(text, token)) {
      const past = isSpace(text[range.end] ?? '') ? range.end + 1 : range.end
      if (caret !== range.end && caret !== past) continue
      return { text: text.slice(0, range.start) + text.slice(caret), caret: range.start }
    }
  }
  return null
}

/**
 * Candidates whose name or hint contains the filter, case-insensitively.
 *
 * Substring, not fuzzy. These are identifiers, and a fuzzy matcher earns its
 * keep only when the user is guessing at the spelling — here it would mostly
 * reorder `orders` behind `order_items` in a way that needs explaining.
 */
export function filterByMention<T extends { token: string; label: string; hint?: string }>(
  items: readonly T[],
  filter: string,
): T[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...items]
  return items.filter((it) =>
    `${it.token} ${it.label} ${it.hint ?? ''}`.toLowerCase().includes(needle),
  )
}
