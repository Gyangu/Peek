import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { blankComments, scannedSources, stylesheets } from './sourceScan'

/* ==================================================================
 * Order, as an executable assertion.
 *
 * ## What this exists to stop happening again
 *
 * The eight stylesheets were merged back into one (migration record §13) and the
 * merge was proved lossless: a string-aware lexer counted 96 blocks, 5 top-level
 * statements and 323 declarations on both sides, the sorted selector paths and
 * declaration lists were byte-identical, and the shipped artifact carried the
 * same 138 top-level statements, "one not more one not less".
 *
 * All of that is a proof about a **set**. Almost everything in `styles.css` is
 * unlayered, and between two unlayered rules of equal specificity the cascade is
 * decided by **document order** — which a set proof says nothing about. §13.3
 * reasoned about order for exactly two pairs, the two failing overrides it chose
 * to preserve, and moved on.
 *
 * One pair had swapped and nobody looked. The reduced-motion block turning the
 * connection dot's pulse off ended up *before* the rule declaring the pulse, both
 * unlayered, both (0,2,0) — artifact offsets 32423 and 33223. Measured in
 * Electron with `prefers-reduced-motion: reduce` emulated over CDP, the dot read
 * `animation-name: pulse`, `1s`, `infinite` while `matchMedia(…).matches` was
 * `true`. It worked before the merge. The accessibility switch was off for
 * however long that took to find, and every gate in the repository was green.
 *
 * A sweep found the collision. A sweep is not a fence, so this is the fence.
 *
 * ## What it asserts, and what it does not
 *
 * Read this before trusting it, and before "fixing" a red by narrowing it.
 *
 * The rule worth having is: *for every pair of unlayered rules that target an
 * overlapping element set, share specificity and declare the same property, the
 * later one wins — and that must be the one that is supposed to win.* The last
 * clause needs intent, and intent is not in the stylesheet. So the rule is split
 * in two, and only one half is decided mechanically.
 *
 *   **1. Reduced-motion overrides win** (`describe('reduced motion')`). Intent is
 *   not in question here: a `prefers-reduced-motion: reduce` block exists to beat
 *   the rule it names, so one that loses is always a bug and never a decision.
 *   No ledger, no exemptions, and the only way to satisfy it is to fix the CSS.
 *   Stronger than that since the seventh round: an override may not merely *win*,
 *   it may not win **because of where it sits**. See "the order model" below.
 *
 *   **2. Every other equal-specificity collision is declared**
 *   (`describe('unlayered collisions')`). Here the winner *is* a judgement — §13.3
 *   deliberately kept two rules losing — so the assertion is that no collision is
 *   undeclared: each one is on `CASCADE_LEDGER` with the intended winner written
 *   down, and the measured winner must be that one. The ledger is empty today
 *   and that is a measurement, not a stub; both halves of the sweep are proved
 *   to fire against fixtures below, because an empty list is exactly the shape
 *   that rots into a vacuous pass.
 *
 * ## The second channel, and why three of the paragraphs below were rewritten
 *
 * Until the seventh round this comment claimed, of `!important` and inline
 * `style`, that "neither appears in this sheet". Half of that was false when it
 * was written — `styles.css` carries four `!important` declarations — and the
 * other half was a category error, because an inline `style` can never appear in
 * a stylesheet at all: it is compiled into the JS bundle and written onto the
 * element at runtime. A false precondition in a header is worse than a missing
 * one; it reads as verified. Both are now checked rather than claimed:
 *
 *   - **`!important` is modelled.** It is a stronger tie-break than specificity
 *     and than order, so `winner()` takes the property under argument and asks
 *     which side declared it important first. Without that, one `!important` on
 *     the connection dot's `animation` reproduces the original bug exactly, with
 *     every assertion in this file still green — which is how it was found.
 *   - **Every `!important` declaration is on `IMPORTANT_SITES`.** Not because
 *     four of them are a problem, but because `!important` inverts the model this
 *     file computes in a way the pairwise sweep cannot see: it lets a *lower*
 *     specificity rule win, and the collision sweep only pairs equal ones. Four
 *     entries with reasons is the proportionate answer; a fifth should be a
 *     decision somebody wrote down.
 *   - **Inline `style` is checked where it can reproduce this bug.** It beats
 *     every rule in every stylesheet, so no reduced-motion block anywhere can
 *     answer one. The renderer has twenty-four of them and none declares a
 *     motion property; `describe('the second channel')` is what keeps that true.
 *
 * What is still **out of reach of this file**, stated rather than implied:
 *
 *   - **Two rules that share no class name but land on one element.** Both halves
 *     of `overlaps()` are honest but partial. The subset half is exact and
 *     total-order-free: if one selector's simple selectors are a subset of the
 *     other's, every element the narrower matches the wider matches too. The
 *     co-occurrence half asks the source which class names are written together
 *     in one string, which is how `.modal` and `.ctx-consent` (§13.3) would be
 *     found — but a class list assembled from two strings, or from a variable, is
 *     invisible to it, and the heuristic that tells a class list from a sentence
 *     is spelled out on `coOccurrences()` along with which way it can be wrong.
 *   - **The `@layer` order itself.** Every comparison here is between two
 *     unlayered blocks, because that is where order alone decides. Unlayered
 *     beats layered at any specificity and any distance, so a layered rule never
 *     enters a pair; `@layer theme, base, components, utilities` settles the rest
 *     and nothing in this file re-checks it.
 *   - **Anything not in `styles.css`.** Utility-vs-utility order inside
 *     `@layer utilities` is Tailwind's, and the chat panel's two loops are
 *     stopped by a motion-reduce variant on the element rather than by any rule
 *     here. Those were measured in Electron and are recorded in the migration
 *     record; they are not asserted anywhere, and saying so is the point of this
 *     paragraph.
 *   - **A colour, a size or anything else an inline `style` sets.** The check
 *     below is about motion and only motion, because that is the argument this
 *     file adjudicates. The colour half of the same channel has its own reader in
 *     `theme-contrast.test.ts` (§22.5), and the values a browser computes with no
 *     literal behind them anywhere are downstream of every text channel there is.
 *   - **Media queries that overlap without being identical.** Two conditions are
 *     compared as text, so `(min-width: 700px)` and `(min-width: 500px)` read as
 *     unrelated even though both hold at 800px. Pairs that fall in that gap are
 *     not silently skipped — they are collected and the test requires the list to
 *     be empty, so the day one appears somebody has to decide rather than not
 *     notice.
 *
 * ## The order model
 *
 * "Later" means a larger source offset, nested blocks included, and this file
 * used to rest a guarantee on that being the *emitted* order too. It said so:
 * Lightning CSS emits a nested `@media` immediately after its parent rule's own
 * declarations, checked by hand against the artifact, with the byte offsets
 * written down. Two auditors checked it and reported two different pairs of
 * offsets. The ordering held both times; the numbers did not, because a number
 * taken out of a build artifact goes stale on the next build. (The attribution
 * was never checked at all: the renderer's `cssMinify` is esbuild, and Lightning
 * CSS reaches the sheet only through Tailwind's own optimizer, so which of the
 * two flattened that nesting was a guess dressed as a measurement.) That is §13's
 * set-versus-order lesson one level up — source versus emitted — and the fix is
 * the same shape as §13's: stop needing the fact.
 *
 * So the strict half no longer asks whether the override is *later*. It asks
 * whether the override could be made to lose by moving something, and requires
 * the answer to be no. Two shapes qualify:
 *
 *   - **nested inside the rule it overrides** — there is no pair of blocks to
 *     get out of order, so no emitter and no future merge can separate them
 *     without changing what the CSS means. This is what `.dot.connecting` does;
 *     `path` on `Block` is how it is recognised, and it is structural rather than
 *     positional on purpose.
 *   - **strictly higher specificity** — order is not consulted at all.
 *
 * An override that wins today only because it happens to sit later is a red with
 * its own message, even though it works. That is the whole of the lesson: the
 * eight-sheet merge did not break a rule, it moved one.
 *
 * What remains, stated plainly: a CSS emitter that hoisted a nested `@media`
 * above its parent's declarations would still break this, and no source-reading
 * test can see that. It is not a reordering an emitter is free to make — it
 * changes what the stylesheet means — but "not free to" is not "does not".
 * `describe('the shipped stylesheet')` re-runs the whole reduced-motion sweep
 * over `out/renderer/assets/*.css` whenever a build has left one on disk, and
 * falls back to the source-side guarantee when it has not, so no path through it
 * is a vacuous pass. Making that check unconditional means a build artifact, and
 * §16.3 spent two paragraphs on why `pnpm test` eats source and only source; the
 * unconditional home for an artifact-only claim is `audit-shipped-css.mjs`, which
 * already runs as the last step of `pnpm build`.
 * ================================================================== */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read through `stylesheets()` so a second sheet is covered the day it lands. */
const SHEETS = stylesheets(RENDERER)

/* ------------------------------------------------------------------ *
 * Reading the stylesheet
 * ------------------------------------------------------------------ */

/**
 * Blank comments and string bodies, preserving length and newlines.
 *
 * `sourceScan`'s `decomment()` cannot be used here and the reason is written in
 * the migration record §13.2: it is a lazy comment regex with no idea what a
 * string is, and this sheet's `@source not` line contains a glob whose middle is
 * the four characters that open and immediately close a CSS comment. That regex
 * reads them as a whole comment and then swallows forward to the next real
 * comment terminator, taking the line that opens `@theme` with it. Every scan in
 * this repo that decomments a stylesheet is one brace short from there on. It is
 * harmless for what those scans ask, which is why §13.2 recorded it instead of
 * fixing it — but this file walks brace depth, so a lost brace is not harmless
 * here at all. Tracking strings is the fix, and it costs four lines.
 */
function blankCss(src: string): string {
  const out = src.split('')
  const erase = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      erase(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1
        j += 1
      }
      erase(i + 1, j)
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/** One declaration: a lowercased property name, and whether it carries `!important`. */
interface Decl {
  name: string
  important: boolean
}

/** One run of declarations that all share a selector, a layer and a condition set. */
interface Block {
  /** Where the run starts. Document order, and the tie-break of last resort. */
  offset: number
  /** Resolved selector list, `&` substituted, whitespace collapsed. */
  selector: string
  /** The enclosing `@layer` chain, `''` when unlayered. */
  layer: string
  /** Enclosing `@media` / `@supports` conditions, normalised, outermost first. */
  conditions: string[]
  /**
   * The offset of the opening `{` of every enclosing block, outermost first.
   *
   * This is what tells a nested override from a flat one, and it is the reason
   * the strict half of this file no longer has to reason about emitted byte
   * order. `A.path` being a proper prefix of `B.path` means B's declarations are
   * written *inside* A's rule, which is a fact about the source tree rather than
   * about two positions in it.
   */
  path: number[]
  /** Declarations, in source order. */
  decls: Decl[]
  /** True inside `@keyframes`, where a "selector" is a percentage. */
  keyframe: boolean
}

/** Substitute `&` in a nested selector; a nested selector with no `&` is a descendant. */
function resolve(child: string, parent: string): string {
  if (parent === '') return child
  const parts = parent.split(',').map((p) => p.trim())
  return child
    .split(',')
    .map((c) => c.trim())
    .flatMap((c) => parts.map((p) => (c.includes('&') ? c.replaceAll('&', p) : `${p} ${c}`)))
    .join(', ')
}

/** `!important`, as the parser sees it: at the end of a value, in a blanked copy. */
const IMPORTANT = /!\s*important\s*$/i

/**
 * Every declaration block in a stylesheet, flat, in document order.
 *
 * Not a CSS parser — a brace walk over the blanked copy that keeps enough
 * context to answer four questions: which elements does this run of declarations
 * reach, what has to be true for it to apply, what is it written inside, and what
 * came before it. Offsets index the original text.
 *
 * **A declaration ends at a `;` or at the end of the block that holds it.** The
 * second half of that sentence was missing until the seventh round, and the hole
 * it left was total rather than partial: `.dot.connecting { animation: none }`,
 * with the last semicolon omitted — legal CSS, and what a hand-minifier or a
 * careless edit produces — parsed to a block with no declarations at all, which
 * then failed the "declares a shared property" filter and dropped out of *both*
 * sweeps. Not a rule that was compared and passed: a rule that was never there.
 * A genuinely broken reduced-motion pair written that way was planted and every
 * assertion in this file stayed green.
 */
function parseBlocks(source: string): Block[] {
  const src = blankCss(source)
  const blocks: Block[] = []

  const walk = (
    from: number,
    to: number,
    ctx: { selector: string; layer: string; conditions: string[]; path: number[]; keyframe: boolean },
  ): void => {
    let i = from
    let start = i
    let block: Block | undefined

    /** Record whatever declaration sits in `[start, end)`, if one does. */
    const flush = (end: number): void => {
      if (ctx.selector === '') return
      const text = src.slice(start, end).trim()
      if (text === '' || text.startsWith('@')) return
      const k = text.indexOf(':')
      if (k <= 0) return
      if (!block) {
        block = {
          offset: start,
          selector: ctx.selector,
          layer: ctx.layer,
          conditions: ctx.conditions,
          path: ctx.path,
          decls: [],
          keyframe: ctx.keyframe,
        }
        blocks.push(block)
      }
      block.decls.push({
        name: text.slice(0, k).trim().toLowerCase(),
        important: IMPORTANT.test(text.slice(k + 1)),
      })
    }

    while (i < to) {
      const c = src[i]

      if (c === '{') {
        let depth = 1
        let j = i + 1
        for (; j < to; j += 1) {
          if (src[j] === '{') depth += 1
          else if (src[j] === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        const prelude = src.slice(start, i).trim().replace(/\s+/g, ' ')
        if (prelude.startsWith('@')) {
          const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)
          const name = m ? m[1].toLowerCase() : ''
          const params = m ? m[2].trim() : ''
          walk(i + 1, j, {
            selector: ctx.selector,
            layer: name === 'layer' ? [ctx.layer, params].filter(Boolean).join('>') : ctx.layer,
            conditions:
              name === 'media' || name === 'supports'
                ? [...ctx.conditions, `@${name} ${params.replace(/\s+/g, ' ')}`]
                : ctx.conditions,
            path: [...ctx.path, i],
            keyframe: ctx.keyframe || name === 'keyframes',
            // `@theme`, `@utility`, `@property` and the rest carry no selector of
            // their own; declarations inside them belong to no element, and the
            // `flush` guard above drops them.
          })
        } else {
          walk(i + 1, j, {
            ...ctx,
            selector: resolve(prelude, ctx.selector),
            path: [...ctx.path, i],
            keyframe: ctx.keyframe,
          })
        }
        i = j + 1
        start = i
        block = undefined
        continue
      }

      if (c === '}' || c === ';') {
        flush(i)
        i += 1
        start = i
        continue
      }

      i += 1
    }

    // The last declaration of a block whose author left the semicolon off. The
    // inner walk stops at `to`, which is the index of the closing brace, so this
    // is the only place that text is ever looked at.
    flush(to)
  }

  walk(0, src.length, { selector: '', layer: '', conditions: [], path: [], keyframe: false })
  return blocks.sort((a, b) => a.offset - b.offset)
}

/* ------------------------------------------------------------------ *
 * Specificity, properties, overlap
 * ------------------------------------------------------------------ */

type Spec = [number, number, number]

/** (id, class-ish, type-ish), the three CSS counts. */
function specificity(selector: string): Spec {
  let s = selector.replace(/\\./g, 'X')
  let a = 0
  let b = 0
  let c = 0
  s = s.replace(/#[\w-]+/g, () => ((a += 1), ' '))
  s = s.replace(/::[\w-]+/g, () => ((c += 1), ' '))
  s = s.replace(/:(?:is|where|not|has)\([^)]*\)/g, (m) => (m.startsWith(':where') ? ' ' : ((b += 1), ' ')))
  s = s.replace(/:[\w-]+(?:\([^)]*\))?/g, () => ((b += 1), ' '))
  s = s.replace(/\.[\w-]+/g, () => ((b += 1), ' '))
  s = s.replace(/\[[^\]]*\]/g, () => ((b += 1), ' '))
  s = s.replace(/[a-zA-Z][\w-]*/g, () => ((c += 1), ' '))
  return [a, b, c]
}

const cmpSpec = (x: Spec, y: Spec): number => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]

/**
 * The longhands a property name covers.
 *
 * Two rules argue over a *property*, not over a spelling of one: `animation:
 * none` and `animation-name: pulse` are the same argument. Only the two motion
 * shorthands are expanded, because only motion can appear in the block this file
 * is strictest about — and `MOTION_PROPERTIES` below makes that a closed set
 * rather than an assumption, so a third property showing up in a reduced-motion
 * block fails loudly instead of being compared by name alone.
 *
 * Everything else is matched on its exact name. A base setting `background` and
 * an override setting `background-color` would therefore not be paired. That is
 * a real gap and it is under-reporting, not over-reporting.
 */
const SHORTHANDS: Record<string, string[]> = {
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ],
}

const longhands = (prop: string): string[] => SHORTHANDS[prop] ?? [prop]

/** Every property a block declares, as longhands. */
const declared = (b: Block): Set<string> => new Set(b.decls.flatMap((d) => longhands(d.name)))

/** Every property a block declares **with `!important`**, as longhands. */
const declaredImportant = (b: Block): Set<string> =>
  new Set(b.decls.filter((d) => d.important).flatMap((d) => longhands(d.name)))

/** The property names a block declares, as written. */
const propNames = (b: Block): string[] => b.decls.map((d) => d.name)

/** The simple selectors of one complex selector — classes, ids, types, attributes, pseudos. */
function simples(selector: string): Set<string> {
  const out = new Set<string>()
  for (const m of selector.matchAll(/[.#][\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?|\b[a-zA-Z][\w-]*\b/g)) {
    out.add(m[0])
  }
  return out
}

const classesIn = (selector: string): string[] =>
  [...simples(selector)].filter((s) => s.startsWith('.')).map((s) => s.slice(1))

/**
 * Class names written together in one string, anywhere the renderer is scanned.
 *
 * The subset half of `overlaps()` cannot see two rules that share no name and
 * meet on an element wearing both — `.modal` against `.ctx-consent`, the
 * argument §13.3 had to measure in a browser. This is the half that can, and it
 * asks the only source of truth available statically: which names does somebody
 * write next to each other.
 *
 * Comments are blanked (a sentence is not an element) and `.md` is skipped
 * entirely, for the reason `audit-shipped-css.mjs` skips it: a guide can mint a
 * rule but no element in the product ever wears a class from one.
 *
 * Telling a class list from an English sentence is a heuristic and it is stated
 * here rather than left to be discovered. A string qualifies when every token
 * could be a class and at least one token carries a `-`, a `:` or a `.` — the
 * marks a Tailwind class list is full of and a sentence is not. Requiring *every*
 * token to be a plain word instead, which is where this started, threw away the
 * connection dot's own class list (`size-1.75` has a dot in it) and with it the
 * only group that names the selector this whole file was written for.
 *
 * The direction of error changes with that heuristic and it is worth saying: a
 * hyphenated word in a sentence can mint a group, so this half can now
 * over-report. It takes two real rules with those exact class names, equal
 * specificity and a shared property for that to become a red, and a red here
 * asks for a judgement rather than asserting a bug.
 */
function coOccurrences(): Set<string>[] {
  const groups: Set<string>[] = []
  for (const rel of scannedSources(RENDERER)) {
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue
    const text = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
    for (const m of text.matchAll(/['"`]([^'"`\n]*)['"`]/g)) {
      const tokens = m[1].trim().split(/\s+/)
      if (tokens.length < 2) continue
      if (!tokens.every((t) => /^[a-z0-9][\w./:[\]-]*$/i.test(t))) continue
      if (!tokens.some((t) => /[-:.]/.test(t))) continue
      const names = tokens.filter((t) => /^[a-zA-Z][\w-]*$/.test(t))
      if (names.length > 1) groups.push(new Set(names))
    }
  }
  return groups
}

/**
 * Can one element be matched by both selectors?
 *
 * Two halves: the simple-selector subset, which is exact, and a class list
 * somebody wrote, which is partial in both directions. See the header and
 * `coOccurrences()`.
 */
function overlaps(a: string, b: string, groups: Set<string>[]): boolean {
  const sa = simples(a)
  const sb = simples(b)
  if ([...sb].every((x) => sa.has(x)) || [...sa].every((x) => sb.has(x))) return true

  const ca = classesIn(a)
  const cb = classesIn(b)
  if (ca.length === 0 || cb.length === 0) return false
  return groups.some((g) => ca.every((x) => g.has(x)) && cb.every((x) => g.has(x)))
}

/** `a ⊆ b`, on condition text. */
const within = (a: string[], b: string[]): boolean => a.every((c) => b.includes(c))

/**
 * Is `inner` written inside `outer`'s rule?
 *
 * A proper prefix of the brace path, which is the structural question rather
 * than the positional one. Two blocks that merely sit one after the other in the
 * file share a path; a nested `@media` extends its parent's.
 */
const nestedIn = (inner: Block, outer: Block): boolean =>
  outer.path.length < inner.path.length && outer.path.every((x, k) => inner.path[k] === x)

/**
 * Which of two blocks the cascade picks, assuming both are unlayered and both apply.
 *
 * `prop` is the property under argument, and it is not optional decoration:
 * `!important` is decided per declaration, and it outranks both specificity and
 * order. Called without it — the fixtures below do, where nothing is important —
 * the answer is the specificity-then-order one this file computed before the
 * seventh round.
 */
function winner(a: Block, b: Block, prop?: string): Block {
  if (prop !== undefined) {
    const ia = declaredImportant(a).has(prop)
    const ib = declaredImportant(b).has(prop)
    if (ia !== ib) return ia ? a : b
  }
  const d = cmpSpec(specificity(a.selector), specificity(b.selector))
  if (d !== 0) return d > 0 ? a : b
  return a.offset > b.offset ? a : b
}

const describeBlock = (sheet: string, b: Block): string =>
  `${sheet}${b.conditions.length > 0 ? ` ${b.conditions.join(' ')} ` : ' '}{ ${b.selector} } ` +
  `@${String(b.offset)} spec ${specificity(b.selector).join(',')}`

/* ------------------------------------------------------------------ *
 * The sheets, parsed once
 * ------------------------------------------------------------------ */

interface Sheet {
  name: string
  blocks: Block[]
}

const parseSheet = (name: string, css: string): Sheet => ({
  name,
  blocks: parseBlocks(css).filter((b) => !b.keyframe),
})

const SHEET_DATA: Sheet[] = SHEETS.map((name) => parseSheet(name, readFileSync(join(RENDERER, name), 'utf8')))

const REDUCED = /prefers-reduced-motion\s*:\s*reduce/

const isReducedMotion = (b: Block): boolean => b.conditions.some((c) => REDUCED.test(c))

/**
 * Everything a reduced-motion block is allowed to turn off.
 *
 * Closed on purpose. The comparison below expands these two shorthands and
 * matches everything else by name, so a reduced-motion block declaring a third
 * property would be compared with a weaker rule than the one this file claims to
 * enforce. Rather than let that happen quietly, adding one costs an entry here
 * and a look at `SHORTHANDS`.
 */
const MOTION_PROPERTIES = new Set([
  'animation',
  ...SHORTHANDS.animation,
  'transition',
  ...SHORTHANDS.transition,
  'scroll-behavior',
  'view-transition-name',
])

/**
 * One reduced-motion override, and a rule in the same sheet it argues with.
 *
 * `props` is what they argue *about*, which `!important` makes load-bearing: two
 * blocks can disagree over three properties and have a different winner on each.
 */
interface Pair {
  sheet: string
  override: Block
  base: Block
  props: string[]
}

/** Every such pair, in every sheet. Collected once, read by four assertions. */
function reducedMotionPairs(
  sheets: Sheet[],
  groups: Set<string>[],
): { pairs: Pair[]; uncomparable: string[] } {
  const pairs: Pair[] = []
  const uncomparable: string[] = []

  for (const sheet of sheets) {
    for (const override of sheet.blocks.filter(isReducedMotion)) {
      const props = declared(override)
      for (const base of sheet.blocks) {
        if (base === override || isReducedMotion(base)) continue
        const shared = [...declared(base)].filter((p) => props.has(p))
        if (shared.length === 0) continue
        if (!overlaps(override.selector, base.selector, groups)) continue
        if (base.layer !== '') continue // layered: it loses to an unlayered override by construction
        if (!within(base.conditions, override.conditions)) {
          uncomparable.push(`${describeBlock(sheet.name, override)}  vs  ${describeBlock(sheet.name, base)}`)
          continue
        }
        pairs.push({ sheet: sheet.name, override, base, props: shared })
      }
    }
  }
  return { pairs, uncomparable }
}

/**
 * Every way an override can lose, with the reason named.
 *
 * The reason matters because the two have different fixes and the wrong one is
 * tempting: an override losing on order is fixed by nesting it, an override
 * losing to `!important` is not fixed by moving it anywhere at all.
 */
function losses(pairs: Pair[]): string[] {
  const out: string[] = []
  for (const { sheet, override, base, props } of pairs) {
    for (const p of props) {
      if (winner(override, base, p) === override) continue
      const beatenByImportance = declaredImportant(base).has(p) && !declaredImportant(override).has(p)
      out.push(
        `${describeBlock(sheet, override)}  loses to  ${describeBlock(sheet, base)}  over ${p} ` +
          `(${beatenByImportance ? '!important on the rule being overridden' : 'specificity, then document order'})`,
      )
    }
  }
  return out
}

/**
 * Overrides that win only because of where they sit.
 *
 * Nesting or a strictly higher specificity; nothing else counts, and `!important`
 * on an override deliberately does not, because `IMPORTANT_SITES` is where that
 * conversation belongs.
 */
function orderDependent(pairs: Pair[]): string[] {
  return pairs
    .filter(({ override, base }) => {
      if (nestedIn(override, base)) return false
      return cmpSpec(specificity(override.selector), specificity(base.selector)) <= 0
    })
    .map(
      ({ sheet, override, base }) =>
        `${describeBlock(sheet, override)}  beats  ${describeBlock(sheet, base)}  by document order alone`,
    )
}

/** One argument between two unlayered rules that specificity does not settle. */
interface Collision {
  sheet: string
  a: Block
  b: Block
  props: string[]
}

/**
 * Every equal-specificity collision between two unlayered blocks.
 *
 * A function rather than a loop inside the `describe`, so the fixture at the
 * bottom can run the whole sweep over eight lines of planted CSS. That is not
 * tidying: the skip below is the one predicate in this file that has already
 * been wrong once, and a fixture that exercises its *helpers* rather than the
 * sweep itself passes just as happily with the wrong predicate restored — which
 * was measured, not assumed.
 */
function collisions(sheets: Sheet[], groups: Set<string>[]): Collision[] {
  const found: Collision[] = []
  for (const sheet of sheets) {
    const plain = sheet.blocks.filter((b) => b.layer === '')
    for (let i = 0; i < plain.length; i += 1) {
      for (let j = i + 1; j < plain.length; j += 1) {
        const a = plain[i]
        const b = plain[j]
        if (isReducedMotion(a) || isReducedMotion(b)) continue // covered by the rule above
        if (!within(a.conditions, b.conditions) && !within(b.conditions, a.conditions)) continue
        // A conditional block written *inside* the rule it narrows is not two
        // rules arguing: same selector, one extra condition, and the narrower one
        // is later by construction because nesting put it there. That is the
        // shape the fix for the connection dot uses, and it needs no ledger entry.
        //
        // The predicate used to be "same selector, different condition counts",
        // which is not that shape and cannot tell it from its opposite. A *flat*
        // `@media` block followed by an unconditional rule with the same selector
        // has the same selector and different condition counts too — and it is
        // dead code, because the later unconditional rule wins whenever the query
        // matches. Planted, it was skipped in silence. `nestedIn` asks the
        // structural question instead, so only the shape the comment describes is
        // let through.
        //
        // Two blocks with the *same* selector and the *same* conditions are a
        // third thing — a duplicate that silently shadows an earlier rule — and
        // those are still left in.
        if (a.selector === b.selector && (nestedIn(a, b) || nestedIn(b, a))) continue
        if (cmpSpec(specificity(a.selector), specificity(b.selector)) !== 0) continue
        const shared = [...declared(a)].filter((p) => declared(b).has(p))
        if (shared.length === 0) continue
        if (!overlaps(a.selector, b.selector, groups)) continue
        found.push({ sheet: sheet.name, a, b, props: shared })
      }
    }
  }
  return found
}

describe('cascade order · the parser', () => {
  test('finds the sheet and a plausible number of blocks', () => {
    assert.ok(SHEET_DATA.length > 0, 'no stylesheets — every assertion below is vacuous')
    const total = SHEET_DATA.reduce((n, s) => n + s.blocks.length, 0)

    /*
     * This used to read `total > 40`, and the number was the problem.
     *
     * It was a canary for "the walk has lost its footing", calibrated against how
     * big the stylesheet happened to be the day it was written. The Tailwind
     * migration is a project whose *whole purpose* is to make this file smaller,
     * so the canary was on a countdown from the start: it went off at 37 blocks
     * (§29.11.8) with nothing wrong, and the only two ways to answer a failure
     * like that are to lower the number — which restarts the countdown — or to
     * stop asking the question by size.
     *
     * So it asks by agreement instead. Every `{` that opens a rule rather than an
     * at-rule is counted independently, by a scan that shares no code with
     * `parseBlocks`, and the two have to land in the same place. A walker that
     * loses its footing stops agreeing with a walker that has not; a stylesheet
     * that simply got smaller keeps agreeing. The absolute floor stays, low, for
     * the one case agreement cannot catch: both readers finding nothing.
     */
    assert.ok(
      total > 5,
      `only ${String(total)} declaration blocks parsed out of ${String(SHEET_DATA.length)} sheet(s). ` +
        `Both this walk and the independent count below are near zero, which means the file was not ` +
        `found rather than that it is small.`,
    )

    for (const sheet of SHEET_DATA) {
      // Rule openings, counted flatly: a `{` whose selector does not start with
      // `@`, minus the ones inside `@keyframes` (whose percentage selectors
      // parseBlocks records too, so they are left in on both sides).
      const src = blankCss(readFileSync(join(RENDERER, sheet.name), 'utf8'))
      const opens = [...src.matchAll(/([^{};]*)\{/g)].filter((m) => {
        const sel = m[1].trim()
        return sel !== '' && !sel.startsWith('@')
      }).length
      const parsed = sheet.blocks.length
      assert.ok(
        // parseBlocks drops a block that declares nothing (a rule holding only
        // nested rules), so it may legitimately find fewer — never more, and
        // never a fraction of them.
        parsed <= opens && parsed >= opens - Math.ceil(opens / 4),
        `${sheet.name}: parseBlocks found ${String(parsed)} declaration block(s) where an independent ` +
          `count of rule openings finds ${String(opens)}. Two readers of the same file disagreeing by ` +
          `that much means one of them has lost its footing — and if it is parseBlocks, every ` +
          `collision assertion below is quietly true of almost nothing.`,
      )
    }
  })

  test('string bodies are not read as comments', () => {
    // The `@source not './**\/__tests__/**'` shape, which `decomment()` swallows.
    const css = String.raw`@source not './**/__tests__/**';
      .a { color: red; }
      .b { color: blue; }`
    const blocks = parseBlocks(css)
    assert.deepEqual(
      blocks.map((b) => b.selector),
      ['.a', '.b'],
      'a `/**\\/` inside a string was read as a comment; brace depth is now wrong for the whole file',
    )
  })

  test('reads nesting, layers and conditions', () => {
    const css = `
      @layer base { button { color: red; } }
      .x { color: blue; @media (prefers-reduced-motion: reduce) { color: green; } }
      .y { &:hover { color: teal; } }
      @keyframes k { 50% { opacity: 0.5; } }
    `
    const blocks = parseBlocks(css)
    assert.deepEqual(
      blocks.map((b) => [b.selector, b.layer, b.conditions.join(''), b.keyframe]),
      [
        ['button', 'base', '', false],
        ['.x', '', '', false],
        ['.x', '', '@media (prefers-reduced-motion: reduce)', false],
        ['.y:hover', '', '', false],
        ['50%', '', '', true],
      ],
    )
    assert.ok(blocks[1].offset < blocks[2].offset, 'a nested override must read as later than its parent')
    assert.ok(
      nestedIn(blocks[2], blocks[1]),
      'the nested override must read as *inside* its parent, not merely after',
    )
    assert.ok(!nestedIn(blocks[1], blocks[2]), 'nesting is a direction, not a relation')
  })

  test('a declaration with no trailing semicolon is still a declaration', () => {
    // Legal CSS, confirmed in Chromium, and invisible to this file until the
    // seventh round: the walk recorded a declaration when it reached a `;` and
    // nowhere else, so the last one in a block simply did not exist. A block
    // with no declarations then failed every "shares a property" filter and
    // dropped out of both sweeps — a rule that was never compared rather than
    // one that was compared and passed.
    const blocks = parseBlocks(`
      .a { color: red; background: blue }
      .b { animation: none }
      .c { color: green;
        @media (prefers-reduced-motion: reduce) { animation: none }
      }
    `)
    assert.deepEqual(
      blocks.map((b) => [b.selector, propNames(b).join('+')]),
      [
        ['.a', 'color+background'],
        ['.b', 'animation'],
        ['.c', 'color'],
        ['.c', 'animation'],
      ],
      'a block whose final declaration omits the semicolon must still report that declaration',
    )
  })

  test('reads `!important`, and only where it is written', () => {
    const blocks = parseBlocks(`
      .a { color: red !important; background: blue }
      .b { animation: none ! important }
      .c { content: "!important"; color: teal }
    `)
    assert.deepEqual(
      blocks.map((b) => b.decls.map((d) => `${d.name}${d.important ? '!' : ''}`).join('+')),
      ['color!+background', 'animation!', 'content+color'],
      'either the flag is not read, or a string body containing the word was read as the keyword',
    )
  })

  test('counts specificity', () => {
    assert.deepEqual(specificity('.dot.connecting'), [0, 2, 0])
    assert.deepEqual(specificity('.layout-root .panel.focused'), [0, 3, 0])
    assert.deepEqual(specificity('button'), [0, 0, 1])
    assert.deepEqual(specificity('.form-row input[type=checkbox]'), [0, 2, 1])
  })
})

describe('cascade order · reduced motion', () => {
  const groups = coOccurrences()
  const { pairs, uncomparable } = reducedMotionPairs(SHEET_DATA, groups)

  test('every reduced-motion block is unlayered', () => {
    for (const sheet of SHEET_DATA) {
      for (const b of sheet.blocks.filter(isReducedMotion)) {
        assert.equal(
          b.layer,
          '',
          `${describeBlock(sheet.name, b)} sits inside @layer ${b.layer}. A layered rule loses to every ` +
            `unlayered one whatever the specificity, and every Tailwind utility this override might have ` +
            `to beat is itself in a layer — being unlayered is the only reason an override that names no ` +
            `class the base names still wins. Take it out of the layer.`,
        )
      }
    }
  })

  test('every property a reduced-motion block declares is one this file can compare', () => {
    for (const sheet of SHEET_DATA) {
      for (const b of sheet.blocks.filter(isReducedMotion)) {
        for (const p of propNames(b)) {
          assert.ok(
            MOTION_PROPERTIES.has(p),
            `${describeBlock(sheet.name, b)} declares \`${p}\`, which is not in MOTION_PROPERTIES. This ` +
              `test would still compare it, but only against a rule spelling the property exactly the ` +
              `same way — so an override of a shorthand would silently stop being checked. Add \`${p}\` ` +
              `there, and its longhands to SHORTHANDS if it is a shorthand.`,
          )
        }
      }
    }
  })

  test('a reduced-motion override is never left in a position it loses from', () => {
    assert.deepEqual(
      losses(pairs),
      [],
      `a \`prefers-reduced-motion: reduce\` block is being beaten by the rule it exists to override. ` +
        `Both are unlayered, so this is decided by \`!important\` first, then specificity, then document ` +
        `order — and the parenthesis on each line says which. If it is order: do not fix it by moving one ` +
        `of the two blocks, because that is how it broke — the eight-sheet merge reordered them and the ` +
        `connection dot kept pulsing under \`reduce\` for as long as it took somebody to measure it. Nest ` +
        `the override inside the rule it overrides, the way \`.dot.connecting\` does, so the two cannot be ` +
        `separated again. If it is \`!important\`: moving blocks cannot fix it at all. Take the marker off ` +
        `the rule being overridden — and read IMPORTANT_SITES before putting one anywhere else.`,
    )
  })

  test('a reduced-motion override never wins by document order alone', () => {
    assert.deepEqual(
      orderDependent(pairs),
      [],
      `this override wins today, and it wins only because of where it sits in the file. That is exactly ` +
        `the state the sheet was in before the eight-sheet merge: correct, and one section move away from ` +
        `silently turning an accessibility switch off. Nothing in this repository asserts that the ` +
        `emitted stylesheet keeps two independent top-level blocks in source order, and a byte offset ` +
        `taken from a build artifact goes stale on the next build — two auditors checked the same claim ` +
        `and reported two different pairs of numbers. So the requirement is not "later", it is "cannot ` +
        `be moved": nest the override inside the rule it overrides, which is what \`.dot.connecting\` ` +
        `does, or give it a genuinely higher specificity. Do not reach for \`!important\`.`,
    )
  })

  test('the sweep finds the overrides it is supposed to be guarding', () => {
    assert.ok(
      pairs.length > 0,
      `the reduced-motion sweep matched no rule against any override. Either the last override in ` +
        `\`styles.css\` was deleted, or a rename broke \`overlaps()\` — and this test has just become a ` +
        `vacuous pass over an empty list. Today it should find \`.dot.connecting\` against itself.`,
    )
    assert.deepEqual(
      uncomparable,
      [],
      `a reduced-motion override argues with a rule under a *different* media condition. Conditions ` +
        `are compared as text here, so this pair cannot be ranked without knowing whether the two ` +
        `queries can hold at once — which is a judgement. Decide it, and either co-locate the override ` +
        `or write the pair down.`,
    )
  })

  test('the sweeps see a broken pair, in both shapes it can be written in', () => {
    // The regression itself, reduced to eight lines: the override first, the
    // rule it overrides second, both unlayered, both (0,2,0). This is what
    // `styles.css` looked like in the shipped artifact at offsets 32423/33223.
    const broken = parseSheet(
      'fixture',
      `
      @media (prefers-reduced-motion: reduce) { .dot.connecting { animation: none; } }
      .dot.connecting { animation: pulse 1s ease-in-out infinite; }
    `,
    )
    // One pair, eight lines: `animation` expands to eight longhands and the
    // winner is decided per property, which is what `!important` forces.
    assert.ok(
      losses(reducedMotionPairs([broken], []).pairs).length > 0,
      'the original bug must read as a loss',
    )

    // The same rules with the semicolons left off. Legal CSS; before the seventh
    // round this parsed to two blocks with no declarations and matched nothing.
    const noSemis = parseSheet(
      'fixture',
      `
      @media (prefers-reduced-motion: reduce) { .dot.connecting { animation: none } }
      .dot.connecting { animation: pulse 1s ease-in-out infinite }
    `,
    )
    const noSemiPairs = reducedMotionPairs([noSemis], []).pairs
    assert.deepEqual(
      noSemiPairs.map((p) => p.props.sort().join('+')),
      reducedMotionPairs([broken], []).pairs.map((p) => p.props.sort().join('+')),
      'a broken pair written without trailing semicolons must argue about exactly what one with them does',
    )
    assert.equal(
      losses(noSemiPairs).length,
      losses(reducedMotionPairs([broken], []).pairs).length,
      'and must lose in exactly the same places',
    )

    // Nesting fixes the order, and `!important` on the base breaks it again —
    // with the override sitting later, inside, and at equal specificity. Every
    // positional fence in this file is satisfied by this CSS and the dot still
    // pulses under `reduce`.
    const important = parseSheet(
      'fixture',
      `.dot.connecting { animation: pulse 1s ease-in-out infinite !important;
        @media (prefers-reduced-motion: reduce) { animation: none; } }`,
    )
    const importantPairs = reducedMotionPairs([important], []).pairs
    assert.equal(importantPairs.length, 1, 'the nested pair must still be found when the base is important')
    assert.equal(orderDependent(importantPairs).length, 0, 'nesting is what this fixture is not failing on')
    assert.ok(
      losses(importantPairs).every((l) => l.includes('!important on the rule being overridden')),
      '`!important` on the rule being overridden must read as a loss, and must say so rather than blaming ' +
        'document order — without it, one marker reproduces the original bug with every other assertion ' +
        'in this file green',
    )
    assert.ok(losses(importantPairs).length > 0)

    // And the fix as it is actually written today.
    const fixed = parseSheet(
      'fixture',
      `.dot.connecting { animation: pulse 1s ease-in-out infinite;
        @media (prefers-reduced-motion: reduce) { animation: none; } }`,
    )
    const fixedPairs = reducedMotionPairs([fixed], []).pairs
    assert.equal(fixedPairs.length, 1)
    assert.deepEqual(losses(fixedPairs), [])
    assert.deepEqual(orderDependent(fixedPairs), [])

    // A flat override that happens to sit later: wins today, and is a red.
    const positional = parseSheet(
      'fixture',
      `.dot.connecting { animation: pulse 1s ease-in-out infinite; }
       @media (prefers-reduced-motion: reduce) { .dot.connecting { animation: none; } }`,
    )
    const positionalPairs = reducedMotionPairs([positional], []).pairs
    assert.deepEqual(losses(positionalPairs), [], 'it does win — that is the point')
    assert.equal(
      orderDependent(positionalPairs).length,
      1,
      'and it wins only by sitting later, which is the red',
    )
  })
})

/**
 * Every `!important` declaration in every stylesheet, with the reason it is one.
 *
 * **Why a list rather than a rule.** `!important` is the one thing that inverts
 * the model the rest of this file computes: it lets a rule win against higher
 * specificity and against a later position both, so the pairwise sweep below —
 * which only ever compares blocks of *equal* specificity — is structurally
 * unable to notice most of what it does. Four declarations is a small enough set
 * to name, and naming them is what turns "there is no `!important` in this
 * sheet", which this file's header asserted for a round and a half while four of
 * them sat in it, into something that cannot be wrong.
 *
 * Keyed on selector and property rather than on position, so moving a rule does
 * not disturb it and renaming one does.
 */
const IMPORTANT_SITES: { selector: string; property: string; why: string }[] = [
  {
    selector: 'body.view-dragging, body.view-dragging *',
    property: 'cursor',
    why:
      'A drag is a modal gesture and every element under the pointer has to agree on one cursor; dividers ' +
      'and the grid both carry more specific ones. Scoped to a body class that exists only for the length ' +
      'of the drag, and `<body>` has no JSX element to hang a utility on. Recorded in the sheet as Reason 3.',
  },
  {
    selector: 'body.view-dragging, body.view-dragging *',
    property: 'user-select',
    why:
      'Same rule, same gesture: a drag that selects text as it crosses a label leaves the selection behind ' +
      'when it ends. Beaten otherwise by the grid and the editor, which both set `user-select` themselves.',
  },
  {
    selector: 'body.view-dragging.view-drag-nodrop, body.view-dragging.view-drag-nodrop *',
    property: 'cursor',
    why:
      'The no-drop variant of the same modal gesture, and it has to beat the `grabbing` rule above as well ' +
      'as everything that rule beats. Higher specificity alone would not do it: the rules it is out-ranking ' +
      'are the same ones, and they are only out-ranked because both carry the marker.',
  },
]

/**
 * The same list, for markers that are no longer in a stylesheet at all.
 *
 * This exists because deleting an entry from IMPORTANT_SITES is the wrong repair
 * for a rule that *moved*. The CodeMirror selection marker was the first entry
 * above until the theme moved into `EditorView.theme` in `SqlEditor.tsx`;
 * `!important` went with it, still reaching real CSS through style-mod, and the
 * sweep above stopped being able to see it because it reads stylesheets. An
 * entry that no longer matches is caught — the staleness test below is what
 * caught this one — but the marker it was describing would then have been
 * unlisted and unwatched, which is the failure the list exists to prevent.
 *
 * Keyed on file and on the object key the declaration sits under, since there is
 * no selector to key on: what style-mod generates is a scoped class chosen at
 * runtime, so the source text is the only stable name it has.
 */
const RUNTIME_IMPORTANT_SITES: { file: string; at: string; why: string }[] = [
  {
    file: 'components/SqlEditor.tsx',
    at: '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection',
    why:
      'CodeMirror writes its own selection layer inline on elements it creates, and an inline style beats ' +
      'every rule at any specificity. Carried over verbatim when the theme moved out of the stylesheet: ' +
      "CodeMirror's own selection rules now arrive through the same injector, so which one wins is a " +
      'question of injection order rather than specificity, and the marker is what keeps it deterministic.',
  },
]

describe('cascade order · !important beyond the stylesheets', () => {
  /**
   * `!important` inside a `.tsx` is a literal substring of a source string — no
   * parsing needed, and nothing else spells it.
   *
   * Comments are blanked first, and that is a real distinction rather than
   * convenience. The trap recorded in `sourceScan.ts` is that Tailwind's scanner
   * reads comments, so a *class name* written in prose compiles into a real
   * rule; `!important` written in prose compiles into nothing. `util/format.ts`
   * carries a paragraph about a marker that no longer exists, which is history
   * worth keeping and not a declaration worth listing.
   */
  const found: { file: string; line: number }[] = []
  for (const file of scannedSources(RENDERER)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
    blankComments(readFileSync(join(RENDERER, file), 'utf8'))
      .split('\n')
      .forEach((text, i) => {
        if (text.includes('!important')) found.push({ file, line: i + 1 })
      })
  }

  test('every `!important` outside the stylesheets is on RUNTIME_IMPORTANT_SITES', () => {
    const files = new Set(RUNTIME_IMPORTANT_SITES.map((e) => e.file))
    assert.deepEqual(
      found.filter((f) => !files.has(f.file)).map((f) => `${f.file}:${String(f.line)}`),
      [],
      `an \`!important\` reaching real CSS from JavaScript, which no stylesheet audit can see. ` +
        `\`EditorView.theme\` and friends compile to unlayered rules at runtime, so a marker here ` +
        `outranks the whole sheet from a file the sheet's readers never open. Put it on ` +
        `RUNTIME_IMPORTANT_SITES with the reason.`,
    )
  })

  test('every RUNTIME_IMPORTANT_SITES entry still names a live marker, with a reason', () => {
    for (const e of RUNTIME_IMPORTANT_SITES) {
      const raw = existsSync(join(RENDERER, e.file)) ? readFileSync(join(RENDERER, e.file), 'utf8') : ''
      const src = blankComments(raw)
      assert.ok(
        src.includes('!important'),
        `RUNTIME_IMPORTANT_SITES carries ${e.file} and that file has no \`!important\` in it any more. ` +
          `Either the marker came off — delete the entry — or the code moved and the entry now excuses ` +
          `nothing while reading as though it excuses something.`,
      )
      assert.ok(
        src.includes(e.at),
        `RUNTIME_IMPORTANT_SITES points at \`${e.at}\` in ${e.file} and no such key is there. The entry ` +
          `names the wrong place, so the reason attached to it is being read about something else.`,
      )
      assert.ok(e.why.length > 60, `the reason for ${e.file} / ${e.at} is too short to be a reason`)
    }
  })
})

describe('cascade order · !important', () => {
  const found: { sheet: string; block: Block; property: string }[] = []
  for (const sheet of SHEET_DATA) {
    for (const block of sheet.blocks) {
      for (const d of block.decls) {
        if (d.important) found.push({ sheet: sheet.name, block, property: d.name })
      }
    }
  }

  const key = (selector: string, property: string): string => `${selector}  ::  ${property}`

  test('every `!important` declaration is on IMPORTANT_SITES', () => {
    const listed = new Set(IMPORTANT_SITES.map((e) => key(e.selector, e.property)))
    assert.deepEqual(
      found
        .filter(({ block, property }) => !listed.has(key(block.selector, property)))
        .map(({ sheet, block, property }) => `${describeBlock(sheet, block)}  ${property}: … !important`),
      [],
      `an \`!important\` declaration nobody wrote down. It outranks specificity and document order both, ` +
        `so every winner this file computes for that property is now decided somewhere other than where ` +
        `this file is looking — one marker on the connection dot's \`animation\` reproduces the original ` +
        `regression with every other assertion here green. If it is genuinely the smallest thing that ` +
        `works, put it on IMPORTANT_SITES with the reason; that is a decision somebody makes on purpose, ` +
        `which is the whole point of the list.`,
    )
  })

  test('every IMPORTANT_SITES entry still names a live declaration, with a reason', () => {
    const live = new Set(found.map(({ block, property }) => key(block.selector, property)))
    for (const e of IMPORTANT_SITES) {
      assert.ok(
        live.has(key(e.selector, e.property)),
        `IMPORTANT_SITES carries \`${e.selector}\` / \`${e.property}\` and no such declaration is in the ` +
          `sheet any more. Either the marker came off — delete the entry — or a selector was renamed and ` +
          `the entry now exempts nothing while reading as though it exempts something.`,
      )
      assert.ok(e.why.length > 60, `the reason for ${e.selector} / ${e.property} is too short to be a reason`)
    }
  })

  test('none of them is a motion property', () => {
    // Not a coincidence worth relying on, which is why it is written down: an
    // `!important` on a motion property is the one shape that beats a
    // reduced-motion override no matter where anybody puts it.
    for (const { sheet, block, property } of found) {
      assert.ok(
        !MOTION_PROPERTIES.has(property),
        `${describeBlock(sheet, block)} declares \`${property}\` with \`!important\`. No ` +
          `\`prefers-reduced-motion: reduce\` block can beat that from anywhere in any stylesheet, so ` +
          `the accessibility switch for this element is off and no amount of nesting turns it back on.`,
      )
    }
  })
})

/**
 * Equal-specificity collisions that are settled by order, with the winner written down.
 *
 * **Empty, and that is a measurement.** The full sweep over every unlayered
 * block in `styles.css` finds exactly one equal-specificity collision today and
 * it is the reduced-motion pair, which the assertions above cover by a rule
 * rather than by a declaration — an override is *supposed* to win, so there is
 * nothing for a human to decide and nothing to write here.
 *
 * The two collisions §13.3 recorded — the disclosure dialog's width against the
 * generic dialog's, and the chat toolbar's gap against the shared toolbar's —
 * were both real entries for this list and both ended in round 5, when the
 * families migrated to utilities. Their disappearance is why the list is empty
 * rather than why it is untrustworthy.
 *
 * `where` is a selector pair, `winner` is which of the two is meant to win, and
 * `why` is a sentence somebody has to write. Both directions are asserted: an
 * undeclared collision fails, and a declared one that no longer exists fails
 * too, so an entry cannot outlive its rule.
 *
 * `emitted` is the fourth field and the newest. An entry on this list is, by
 * construction, a case where **document order is the whole of the cascade** —
 * and this file reads source order, which is not the order the browser sees. The
 * strict half above no longer needs that distinction to disappear (it requires
 * order-independence outright), but a ledger entry cannot: it is the shape that
 * survives only because two blocks are in a particular sequence in a particular
 * build. So the entry has to say how that was confirmed *in the shipped
 * stylesheet* — `pnpm build`, then read `out/renderer/assets/*.css`. Relative
 * order, not byte offsets: the offsets change with every build, which is how two
 * auditors managed to confirm one true claim with two different numbers.
 */
const CASCADE_LEDGER: { where: [string, string]; winner: string; why: string; emitted: string }[] = []

describe('cascade order · unlayered collisions', () => {
  const groups = coOccurrences()

  const found = collisions(SHEET_DATA, groups)

  const key = (a: Block, b: Block): string => [a.selector, b.selector].join('  ||  ')

  test('no equal-specificity collision is undeclared', () => {
    const declaredKeys = new Set(CASCADE_LEDGER.map((e) => e.where.join('  ||  ')))
    const undeclared = found
      .filter(({ a, b }) => !declaredKeys.has(key(a, b)) && !declaredKeys.has(key(b, a)))
      .map(
        ({ sheet, a, b, props }) =>
          `${describeBlock(sheet, a)}  ||  ${describeBlock(sheet, b)}  over ${props.slice(0, 4).join(', ')}`,
      )
    assert.deepEqual(
      undeclared,
      [],
      `two unlayered rules of equal specificity declare the same property and can land on the same ` +
        `element, so document order alone decides between them — and nobody has written down which one ` +
        `is supposed to win. This is the shape the eight-sheet merge shipped a broken accessibility ` +
        `switch in: the set of rules was proved identical and the order was not. Put the pair on ` +
        `CASCADE_LEDGER with the intended winner, or remove the argument. If one of the two is a ` +
        `\`@media\` block that a later unconditional rule with the same selector shadows, it is not a ` +
        `pair to declare — it is dead code, and the fix is to delete it or to nest it.`,
    )
  })

  test('every ledger entry still names a live collision, and still wins', () => {
    for (const entry of CASCADE_LEDGER) {
      const hit = found.find(
        ({ a, b }) => key(a, b) === entry.where.join('  ||  ') || key(b, a) === entry.where.join('  ||  '),
      )
      assert.ok(
        hit,
        `CASCADE_LEDGER carries ${entry.where.join(' || ')}, and the sweep no longer finds that ` +
          `collision. Either it was fixed — delete the entry — or a selector was renamed and the entry ` +
          `is now exempting nothing while reading as though it exempts something.`,
      )
      assert.ok(
        entry.why.length > 40,
        `the reason for ${entry.where.join(' || ')} is too short to be a reason`,
      )
      assert.ok(
        entry.emitted.length > 40,
        `${entry.where.join(' || ')} has no record of how its winner was confirmed in the shipped ` +
          `stylesheet. This entry exists precisely because document order decides it, and the order this ` +
          `file reads is the source's. Run \`pnpm build\`, read the relative order of the two rules in ` +
          `\`out/renderer/assets/*.css\`, and write down what you saw — the relative order, not the byte ` +
          `offsets, which change with every build.`,
      )
      for (const p of hit.props) {
        assert.equal(
          winner(hit.a, hit.b, p).selector,
          entry.winner,
          `${entry.where.join(' || ')} is declared to be won by \`${entry.winner}\`, and over \`${p}\` the ` +
            `cascade picks \`${winner(hit.a, hit.b, p).selector}\`. Somebody moved a rule, or marked a ` +
            `declaration important.`,
        )
      }
    }
  })

  test('the sweep can see a collision when there is one', () => {
    // The machinery above reports nothing today. These fixtures are what says
    // that is because the sheet is clean, not because the sweep is broken. Both
    // halves of `overlaps()` are exercised, because they fail independently.
    const subsetCss = `.a { color: red; } .a.b { color: blue; } .b { color: green; }`
    const blocks = parseBlocks(subsetCss)
    assert.ok(
      overlaps(blocks[0].selector, blocks[1].selector, []),
      'the subset half of overlaps() no longer fires: `.a` and `.a.b` must read as overlapping',
    )
    assert.ok(
      !overlaps(blocks[0].selector, blocks[2].selector, []),
      '`.a` and `.b` share no name, so only a written class list may pair them',
    )
    assert.ok(
      overlaps(blocks[0].selector, blocks[2].selector, [new Set(['a', 'b'])]),
      'the co-occurrence half of overlaps() no longer fires: a written `"a b"` must pair `.a` with `.b`',
    )
    assert.ok(
      coOccurrences().length > 100,
      'the renderer yielded almost no class lists — the co-occurrence half is reading nothing',
    )
  })

  test('a flat @media block shadowed by a later unconditional rule is not skipped', () => {
    // Same selector, different condition counts — which is what the old skip
    // tested for, and it is satisfied by both a nested override (correct, skip)
    // and by this (dead code, do not skip). The `@media` rule paints nothing at
    // any viewport width, because the unconditional rule below it wins wherever
    // the query holds.
    //
    // Run through `collisions()` rather than through its helpers, because that
    // is the thing that was wrong: restoring the old predicate and re-running a
    // helper-level fixture leaves it green, and this one red. Both measured.
    const shadowed = parseSheet(
      'fixture',
      `@media (min-width: 700px) { .x { color: red; } }
       .x { color: blue; }`,
    )
    const dead = collisions([shadowed], [])
    assert.equal(
      dead.length,
      1,
      'a flat @media shadowed by a later unconditional rule is a collision, not a nesting',
    )
    assert.deepEqual(dead[0].props, ['color'])
    assert.equal(
      winner(dead[0].a, dead[0].b, 'color').offset,
      shadowed.blocks[1].offset,
      'the unconditional rule paints',
    )

    // And the shape the skip is actually for: identical in every respect the old
    // predicate could see, and correct.
    const nested = parseSheet('fixture', `.x { color: blue; @media (min-width: 700px) { color: red; } }`)
    assert.ok(nestedIn(nested.blocks[1], nested.blocks[0]), 'a nested narrowing override must read as nested')
    assert.deepEqual(collisions([nested], []), [], 'and it must not be reported as an argument')

    // A third shape the skip must keep letting through to the ledger: same
    // selector, same conditions, one silently shadowing the other.
    const duplicate = parseSheet('fixture', `.x { color: blue; } .x { color: red; }`)
    assert.equal(collisions([duplicate], []).length, 1, 'a duplicate rule is still a collision')
  })
})

/* ------------------------------------------------------------------ *
 * The second channel
 * ------------------------------------------------------------------ */

/**
 * Motion properties as they are spelled in a JS style object, plus the two other
 * ways the renderer writes CSS from JavaScript.
 *
 * Three named shapes rather than one wide scan, and that is the opposite of the
 * call §22.5 made for colours — deliberately. There the subject was a *value*, so
 * a reader keyed on syntax was the bug (a hex handed to a canvas is the same
 * failure with no `style={{` near it). Here the subject is a **declaration that
 * outranks a stylesheet**, which is a thing only these three shapes can be: a
 * React `style` object, a direct `element.style.x =`, and `setProperty`. A
 * motion property named anywhere else in a `.ts` file is a spec entry, a type, or
 * a comparison, and blanket-matching it would make this a fence about the word.
 */
const INLINE_MOTION =
  /\b(?:animation|transition|scrollBehavior|scroll-behavior|viewTransitionName|view-transition-name)(?:[A-Z][A-Za-z]*|-[a-z-]+)?\s*:/

describe('cascade order · the second channel', () => {
  const files = scannedSources(RENDERER).filter((rel) => rel.endsWith('.ts') || rel.endsWith('.tsx'))

  /** `style={{ … }}` bodies, with the file and line they sit on. */
  const inlineStyleObjects: { rel: string; line: number; body: string }[] = []
  /** `el.style.animation = …` and `el.style.setProperty('transition', …)`. */
  const scriptedDeclarations: string[] = []

  for (const rel of files) {
    const text = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
    const lineOf = (index: number): number => text.slice(0, index).split('\n').length

    for (const m of text.matchAll(/\bstyle\s*=\s*\{\{/g)) {
      let depth = 0
      let j = m.index + m[0].length - 2
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1
        else if (text[j] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      inlineStyleObjects.push({ rel, line: lineOf(m.index), body: text.slice(m.index, j + 1) })
    }

    for (const m of text.matchAll(
      /\.style\s*\.\s*(animation|transition|scrollBehavior|viewTransitionName)[A-Za-z]*\s*=|\.setProperty\s*\(\s*['"](animation|transition|scroll-behavior|view-transition-name)[a-z-]*['"]/g,
    )) {
      scriptedDeclarations.push(`${rel}:${String(lineOf(m.index))} → ${m[0]}`)
    }
  }

  test('no inline style declares a motion property', () => {
    assert.deepEqual(
      inlineStyleObjects
        .filter(({ body }) => INLINE_MOTION.test(body))
        .map(({ rel, line, body }) => `${rel}:${String(line)} → ${body.replace(/\s+/g, ' ').slice(0, 90)}`)
        .concat(scriptedDeclarations),
      [],
      `a motion declaration written from JavaScript. An inline \`style\` is not in any stylesheet and not ` +
        `in the shipped CSS — it rides in the JS bundle and is written onto the element at runtime, where ` +
        `it beats every rule in every sheet at every specificity. So no ` +
        `\`prefers-reduced-motion: reduce\` block anywhere can answer it, and none of the assertions above ` +
        `this line can see it: the whole of this file reads \`styles.css\`. Move the animation into the ` +
        `stylesheet, or state the reduced-motion case on the element with a motion variant beside the ` +
        `class that starts it — which is what the chat panel's two loops do.`,
    )
  })

  test('the reader can see the channel it is reading', () => {
    // An empty result is the expected one, which makes this the exact shape that
    // rots into a vacuous pass: a renamed prop, a changed JSX convention, a
    // regex that stops matching, and the test above goes green over nothing.
    assert.ok(
      files.length > 100,
      `found only ${String(files.length)} .ts/.tsx files under the renderer — the file set is wrong, and ` +
        `the assertion above is now true of almost nothing.`,
    )
    assert.ok(
      inlineStyleObjects.length > 15,
      `only ${String(inlineStyleObjects.length)} inline style objects were found in ${String(files.length)} ` +
        `files, and twenty-four were there when this was written. The scan is not reading the channel.`,
    )
    // And the shapes it must recognise, so a rewrite cannot quietly narrow it.
    const sample = (src: string): boolean => {
      const objects = [...src.matchAll(/\bstyle\s*=\s*\{\{/g)]
      return objects.length > 0 && INLINE_MOTION.test(src)
    }
    assert.ok(sample("<div style={{ animation: 'pulse 1s infinite' }} />"), 'a shorthand must be recognised')
    assert.ok(sample("<div style={{ animationName: 'pulse' }} />"), 'a camelCase longhand must be recognised')
    assert.ok(
      sample('<div style={{ transitionDuration: `${d}ms` }} />'),
      'a template value must not hide the key',
    )
    assert.ok(
      !INLINE_MOTION.test('const t = { transitionable: true }'),
      'a word that merely starts the same is not one',
    )
  })
})

/* ------------------------------------------------------------------ *
 * The shipped stylesheet
 * ------------------------------------------------------------------ */

/** `out/renderer/assets/*.css`, if a build has left one there. */
function shippedStylesheets(): { name: string; css: string }[] {
  const dir = join(RENDERER, '..', '..', 'out', 'renderer', 'assets')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => ({ name: `out/renderer/assets/${f}`, css: readFileSync(join(dir, f), 'utf8') }))
}

describe('cascade order · the shipped stylesheet', () => {
  const groups = coOccurrences()
  const shipped = shippedStylesheets()

  test('the emitted CSS agrees with the source about who wins', () => {
    if (shipped.length === 0) {
      // Not a skip. §16.3 settled that `pnpm test` reads source and only source,
      // and that a check which stands down when the artifact is missing is the
      // fail-open shape this repository has been bitten by four times. The way
      // out is not to demand a build here — it is that the guarantee does not
      // depend on this check: `a reduced-motion override never wins by document
      // order alone` above makes every override structurally inseparable from
      // what it overrides, so emitted order cannot decide any of them. That is
      // what is re-asserted here, on the same list, so that no run of this test
      // asserts nothing.
      const { pairs } = reducedMotionPairs(SHEET_DATA, groups)
      assert.ok(pairs.length > 0, 'no artifact on disk and no source-side pairs either — nothing was checked')
      assert.deepEqual(
        orderDependent(pairs),
        [],
        'no artifact on disk; the source-side guarantee is what stands',
      )
      assert.deepEqual(losses(pairs), [], 'no artifact on disk; the source-side guarantee is what stands')
      return
    }

    const sheets = shipped.map(({ name, css }) => parseSheet(name, css))
    const total = sheets.reduce((n, s) => n + s.blocks.length, 0)
    assert.ok(
      total > 200,
      `only ${String(total)} declaration blocks parsed out of the shipped stylesheet(s). The artifact is ` +
        `minified and this walk has lost its footing in it, so the assertion below is true of almost ` +
        `nothing. Fix the walk rather than the threshold.`,
    )

    const { pairs, uncomparable } = reducedMotionPairs(sheets, groups)
    assert.ok(
      pairs.length > 0,
      `the shipped stylesheet contains no reduced-motion override arguing with any rule, and \`styles.css\` ` +
        `contains one. Either the emitter dropped it or the selector it names was renamed on the way out.`,
    )
    assert.deepEqual(
      uncomparable,
      [],
      'a shipped reduced-motion override argues with a rule under another condition',
    )
    assert.deepEqual(
      losses(pairs),
      [],
      `the shipped stylesheet disagrees with the source about a reduced-motion override. This is the one ` +
        `claim no source-reading test can make: the sheet is written so that the override cannot be ` +
        `separated from the rule it overrides, and something between here and the artifact separated them ` +
        `anyway — a minifier that hoisted a flattened \`@media\`, a merge of two conditions, a reordering. ` +
        `Read \`out/renderer/assets/*.css\` and compare against \`styles.css\`.`,
    )
  })
})
