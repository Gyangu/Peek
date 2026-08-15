import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { blankComments, scannedSources } from './sourceScan'

/* ==================================================================
 * No pictorial glyph reaches the screen as text.
 *
 * This is the only part of the icon migration that prevents a repeat, and the
 * repeat is the default outcome without it. The failure it guards is not
 * carelessness — it is that **the cheapest path to "put a small picture here"
 * has always been to type a character**, and it stays the cheapest path forever
 * unless something refuses it.
 *
 * That path had already been walked twice. `⊞` was carrying "split left/right",
 * a meaning it does not have in any reading — its ordinary sense is add or
 * expand, and it was paired with `⊟` (collapse) to express two *orthogonal*
 * directions. And `TreeView` drew its eleven node kinds as ⛁ ❏ ▦ ◫ ◪ ⧉ ◇, a set
 * whose own comment recorded that `◫` and `◪` differ only by which half is
 * filled, predicted they would become hard to tell apart, and prescribed a size.
 *
 * Both were the same root cause and neither was a mistake in judgement: Unicode
 * does not contain "split left/right" or "materialized view", so the author's
 * only move was to pick the nearest available shape. The fix is a set that
 * contains the concepts — `ui/icons.ts` — and this test is what keeps the old
 * path closed.
 *
 * ## What is banned, and what is deliberately not
 *
 * Banned: a pictorial glyph in text a component **renders**.
 *
 * Not banned, and these are not loopholes:
 *
 * - **Comments.** A comment is not an element. The two paragraphs above name
 *   nine banned glyphs between them and are the reason this test blanks
 *   comments before reading a file rather than after.
 * - **Keyboard symbols** — ⌘ ⌥ ⇧ ⌫ ⌃ ⏎ ⎋. These are the *names of keys*, not
 *   pictures of anything. `⌘,` is what the key is called; an SVG of a command
 *   key would be strictly worse, and there is nowhere in a `title` string to put
 *   one anyway.
 * - **Box drawing and typographic marks** — the arrows and rules inside a
 *   comment diagram, `·` as a separator in a hint string. They are punctuation
 *   doing punctuation's job.
 *
 * ## The live exceptions, and what they have in common
 *
 * All three are one situation: **the label is typed `string`, so no element can
 * go in it.** `ChatView`'s permissive modes sit in an `<option>`, which may hold
 * text and nothing else — that one is HTML's constraint and not ours. The same
 * two modes appear again in Settings through `<Segmented>`, whose option label
 * is a string because nothing had ever needed otherwise.
 *
 * The `<Segmented>` half *could* be fixed by giving that primitive an icon slot.
 * It is not, because the `<option>` half cannot be, and one warning drawn as an
 * icon here and a character there is worse than one character drawn the same way
 * in both. The rule of the exception is therefore about position, not about `⚠`.
 *
 * That is also why exceptions are keyed by **file** rather than by glyph. Keying
 * them by `⚠` would have quietly permitted a warning triangle in any of the
 * other surfaces, every one of which holds an element perfectly well.
 * ================================================================== */

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER = dirname(HERE)

/**
 * Characters that are pictures of things. Geometric shapes, the miscellaneous
 * symbol and dingbat blocks, arrows, and emoji.
 *
 * Written as ranges rather than as a list of the glyphs this codebase happened
 * to use, for the reason every other ban in this directory was eventually
 * rewritten: a list of spellings is only ever as long as somebody remembered,
 * and the next author will reach for a glyph nobody has typed here yet.
 */
const PICTORIAL = /[←-⇿⌀-⏿■-➿⬀-⯿\u{1F300}-\u{1FAFF}]/u

/**
 * Characters that are not pictures but were being **used** as one.
 *
 * This list exists because the range above missed the most visible offenders in
 * the app. The chat rail's header drew "new conversation" as `＋` (U+FF0B, the
 * *fullwidth* plus, from the halfwidth-and-fullwidth block) and its collapse
 * control as `›` (U+203A, from general punctuation). Neither block is anywhere
 * near the symbol ranges, so both sailed through — and the miss was not
 * academic: sitting next to a real 14px icon in the same strip, they rendered
 * at whatever size the font gave them, and the row visibly failed to line up.
 * That is what a user reported, and it is the shape of the whole problem in
 * miniature — **a glyph's size belongs to the font, an icon's belongs to the
 * spec, and a strip mixing the two cannot be made consistent.**
 *
 * The lesson generalises past these four: a character is an icon when of it is
 * *used* as one, and the Unicode block it happens to live in has no opinion on
 * that. Ranges catch the ones that look like pictures; this catches the ones
 * that were drafted into being pictures. Add to it when the next one turns up.
 *
 * `+` and `-` (ASCII) are deliberately absent: they are arithmetic, they appear
 * in real prose, and banning them would fire on every string containing a sum.
 * The fullwidth twins have no such second job in this codebase.
 */
const DRAFTED = new Set([...'＋－›‹»«'])

/**
 * Keyboard symbols, carved out of the ranges above by codepoint.
 *
 * `⌘⌥⇧⌫⌃⏎⎋` sit inside the arrow and technical blocks, so they cannot be
 * excluded by narrowing a range — only by name.
 */
const KEYCAP = new Set([...'⌘⌥⇧⌫⌃⏎⎋⌤⇥⇪−'])

/**
 * The four plain arrows, allowed as **text**.
 *
 * Two jobs, both textual and neither pictorial: they are how `keys/chord.ts`
 * spells the arrow keys' names, and how a message catalogue writes a navigation
 * path — "Settings → Databases". A sentence containing an arrow is a sentence.
 *
 * **This is the ban's known hole, stated rather than hidden.** Somebody drawing
 * a next-page affordance as a bare `→` again would pass, which is exactly what
 * `TableView` used to do. Nothing distinguishes the two by codepoint; only the
 * position does, and this scanner reads text rather than a rendered tree. If a
 * cheap way to tell them apart turns up, close it. Until then, the hole is one
 * glyph wide and written down, which is the difference between a limitation and
 * a surprise.
 */
const PROSE_ARROW = new Set([...'←→↑↓'])

/**
 * Files allowed to render a pictorial glyph, each with the reason. A reason is
 * required and checked for length: "this one is fine" is a judgement, and a
 * judgement nobody wrote down cannot be told apart from an oversight.
 */
const RENDERS_A_GLYPH: Record<string, string> = {
  'i18n/messages/en/settings.ts':
    'The ⚠ on the two permissive agent modes is inside a <Segmented> option label, which is typed ' +
    'string. Making it an icon means teaching that primitive an icon slot — and the same warning ' +
    'appears on the same modes in ChatView, where an <option> can hold no element at all. One of ' +
    'the two can be an icon and the other cannot, and the same warning drawn two ways in two ' +
    'places is worse than one character drawn consistently. Revisit if <option> ever leaves.',
  'i18n/messages/zh-CN/settings.ts':
    'The zh-CN half of the pair above — same two modes, same <Segmented>, same reason. Split ' +
    'across two files because the catalogues are, not because the decision is.',
  'components/chat/ChatView.tsx':
    'The ⚠ on a permissive permission mode lives inside an <option>, which may contain text ' +
    'and no elements at all — so no icon can go there. It is load-bearing rather than ' +
    'decorative: those modes were marked by colour alone before it, which is invisible to a ' +
    'reader who cannot separate warn from foreground, and a closed <select> shows one option ' +
    'so there is nothing for the colour to contrast against either.',
}

describe('icons are icons, not characters', () => {
  test('no pictorial glyph is rendered as text', () => {
    const offenders: string[] = []

    for (const rel of scannedSources(RENDERER)) {
      // `.ts` as well as `.tsx`, and that is not thoroughness for its own
      // sake — it is where this ban was already failing. The first version read
      // only `.tsx`, and a `✓` prefixed onto a menu item's label in
      // `autoRefreshMenu.ts` sailed through it, as would any glyph in a message
      // catalogue. A rule of the form "nothing anywhere renders X" that reads
      // one file extension is a rule about that extension.
      if (!(rel.endsWith('.tsx') || rel.endsWith('.ts'))) continue
      if (rel in RENDERS_A_GLYPH) continue

      // Comments blanked *first*: this very directory explains the ban by
      // naming the glyphs it bans, and every such sentence would otherwise be
      // an offender. `blankComments` keeps string literals, which is the point —
      // a glyph inside a rendered template literal is exactly the shape being
      // caught, and `⌘/Ctrl + Enter` in a title is exactly the shape being
      // allowed.
      const code = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))

      code.split('\n').forEach((line, i) => {
        for (const ch of line) {
          if (KEYCAP.has(ch) || PROSE_ARROW.has(ch)) continue
          if (!PICTORIAL.test(ch) && !DRAFTED.has(ch)) continue
          offenders.push(`${rel}:${String(i + 1)} — ${ch}`)
        }
      })
    }

    assert.deepEqual(
      offenders,
      [],
      `A pictorial character is being rendered as text. Unicode is not an icon set: it does ` +
        `not contain most of the concepts a UI needs, so a glyph picked from it is the nearest ` +
        `available shape rather than the right one — which is how ⊞ ended up meaning "split ` +
        `left/right". Add a semantic name to ui/icons.ts and use <Icon name="…" />. If the ` +
        `character genuinely cannot be an element — an <option>, a title attribute — add the ` +
        `file to RENDERS_A_GLYPH with the reason.\n\n${offenders.join('\n')}`,
    )
  })

  test('every exception is still real', () => {
    for (const [rel, reason] of Object.entries(RENDERS_A_GLYPH)) {
      const code = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
      const hit = [...code].some(
        (ch) => !KEYCAP.has(ch) && !PROSE_ARROW.has(ch) && (PICTORIAL.test(ch) || DRAFTED.has(ch)),
      )

      assert.ok(
        hit,
        `${rel} is on RENDERS_A_GLYPH but no longer renders one. Delete the entry — an ` +
          `exemption nobody needs is an exemption the next glyph will hide behind.`,
      )
      assert.ok(
        reason.length > 80,
        `${rel}'s exemption needs a real reason, not a label. Why can this position hold no element?`,
      )
    }
  })
})

/**
 * `<Button>`s whose only content is an icon but which are deliberately not
 * declared `icon`. Same contract as `RENDERS_A_GLYPH`: a written reason, and a
 * test below that deletes the entry if it stops being needed.
 */
const ICON_BUTTON_BY_HAND: Record<string, string> = {
  'components/PanelTabs.tsx':
    'The tab close is `aria-hidden` — the keyboard closes a tab with Delete/Backspace and exposing ' +
    "it would double the strip's tab stops — so `icon`'s mandatory label would be a name nothing " +
    'can read. It carries `title` alone, and its square shape comes from the `sm` rung plus its own ' +
    'layout classes rather than from the modifier.',
}

describe('an icon button is shaped like one', () => {
  /*
   * The defect this exists for was visible before it was understood: three
   * controls in the chat rail's header, one of them declared `icon` and two of
   * them not. `icon` swaps the rung's whole shape for a square with no padding,
   * so the other two kept a text button's side padding around a 14px picture —
   * same icons, two widths, uneven gaps. A user saw it in a screenshot.
   *
   * Worth noticing about the sequence: those buttons were *already* wrong before
   * this migration, and nobody had seen it. A `＋` in a text-shaped button looks
   * like a small character in a button; a real icon in one looks like a mistake.
   * Making the icons consistent is what made the shape inconsistency legible —
   * which is the ordinary way a half-fixed thing surfaces the other half.
   */
  test('a button holding only an icon declares `icon`', () => {
    const offenders: string[] = []

    for (const rel of scannedSources(RENDERER)) {
      if (!rel.endsWith('.tsx') || rel in ICON_BUTTON_BY_HAND) continue
      const code = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))

      for (const m of code.matchAll(/<Button\b((?:[^>]|\n)*?)>\s*<Icon\b[^/]*\/>\s*<\/Button>/g)) {
        const attrs = m[1] ?? ''
        if (/(^|\s)icon(\s|$|=)/.test(attrs)) continue
        offenders.push(`${rel}:${String(code.slice(0, m.index).split('\n').length)}`)
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `A <Button> whose whole content is an <Icon> is not declared \`icon\`, so it keeps the text ` +
        `rung's side padding and comes out wider than the square ones beside it. Add \`icon\` (and ` +
        `\`label\`, which the type union then requires). If it genuinely must not carry an ` +
        `accessible name, add it to ICON_BUTTON_BY_HAND with the reason.\n\n${offenders.join('\n')}`,
    )
  })

  test('every by-hand exception is still one', () => {
    for (const [rel, reason] of Object.entries(ICON_BUTTON_BY_HAND)) {
      const code = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
      const hit = [...code.matchAll(/<Button\b((?:[^>]|\n)*?)>\s*<Icon\b[^/]*\/>\s*<\/Button>/g)].some(
        (m) => !/(^|\s)icon(\s|$|=)/.test(m[1] ?? ''),
      )
      assert.ok(hit, `${rel} is on ICON_BUTTON_BY_HAND but has no hand-shaped icon button left. Delete it.`)
      assert.ok(reason.length > 80, `${rel} needs a real reason, not a label.`)
    }
  })
})

describe('the icon table', () => {
  const icons = readFileSync(join(RENDERER, 'ui', 'icons.ts'), 'utf8')

  test('every name is worn', () => {
    const declared = [...blankComments(icons).matchAll(/^\s*'?([\w.]+)'?:\s*\w+,$/gm)].map((m) => m[1] ?? '')

    /*
     * A name counts as worn if any other module writes it as a string literal.
     *
     * Deliberately looser than matching `<Icon name="…" />`: the tree's eleven
     * kinds are chosen by a `switch` that *returns* names, and a status mark
     * picks one inside a nested conditional. A pattern tight enough to demand
     * the JSX attribute would have called all eighteen of those unworn — and
     * the honest response to a test that cannot see a real use is to widen what
     * counts as use, not to exempt the file. What this still catches is the
     * thing worth catching: a name typed here and nowhere else.
     */
    const used = new Set<string>()
    for (const rel of scannedSources(RENDERER)) {
      if (!(rel.endsWith('.tsx') || rel.endsWith('.ts'))) continue
      if (rel === join('ui', 'icons.ts')) continue
      const code = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
      for (const m of code.matchAll(/['"]([\w.]+)['"]/g)) used.add(m[1] ?? '')
    }

    const unworn = declared.filter((name) => !used.has(name))

    /*
     * The table is static, so listing an icon ships it. That is a small cost per
     * entry and a real one in aggregate — and the bigger cost is that a shelf
     * stocked "for later" stops being a description of what this app contains,
     * which is the one thing this file is good for.
     *
     * The same argument `audit-shipped-css.mjs` makes about a rule nobody wears,
     * one layer up.
     */
    assert.deepEqual(
      unworn,
      [],
      `ui/icons.ts lists icons nothing uses. The table is static, so each one ships; list what ` +
        `is worn rather than stocking the shelf.`,
    )
  })
})
