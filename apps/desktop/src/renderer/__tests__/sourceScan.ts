import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/* ==================================================================
 * Reading source the way a compiler does, not the way grep does.
 *
 * Several tests in this repo enforce rules by scanning source text — which bare
 * elements exist, which properties are declared, which classes are passed. Every
 * one of them has the same failure available to it: **prose that mentions the
 * thing counts as the thing.**
 *
 * It has now happened twice in a day, in two unrelated tests:
 *
 *  - `control-spec.test.ts` matched `<button` on raw text, so a JSDoc explaining
 *    why a tab is *not* a `<button>` was counted as one — and, worse, the
 *    tripwire guarding the permission boundary could be satisfied by a comment
 *    naming `<Button>`;
 *  - `theme-contrast.test.ts` matched `opacity:` the same way, and the very
 *    comment written to explain a removed `opacity: 0.7` re-registered it.
 *
 * Two independent tests reaching for the same broken shortcut is the signature
 * of a missing shared piece, which is the same diagnosis this session applied to
 * three red buttons. So it lives here once.
 *
 * Not a parser. It blanks comments and string bodies while preserving length, so
 * offsets into the returned text still index the original — which is what lets a
 * caller search the blanked copy and slice from the real one.
 *
 * ==================================================================
 * The correction the Tailwind migration forced, and the principle behind it
 * ==================================================================
 *
 * Everything above is about reading *less* than grep does. Half of this file now
 * has to read *more*, and the reason is a single sentence worth keeping at the
 * top of anything that audits a Tailwind codebase:
 *
 *   **What ends up in the stylesheet is decided by Tailwind's scanner, not by
 *   ours. Any place the two disagree is a place a rule can be broken in
 *   production while CI stays green.**
 *
 * Our old class scanner found `className=` attributes and pulled quoted strings
 * out of them. Tailwind's does nothing of the kind: it extracts candidate tokens
 * from the raw bytes of every file under `@source`, with no idea what a JSX
 * attribute, a string literal, a Markdown fence or a comment is. Three holes
 * came out of that one gap, and all three were confirmed by building:
 *
 *  1. **Template literals were invisible.** ``className={`flex ${on ? 'A' : 'B'}`}``
 *     read as nothing, because the quotes around `'A'` pair with the enclosing
 *     backticks and fall outside the match. A hex-in-brackets background and a
 *     9px type rung both compiled into the shipped CSS with 1495 tests green.
 *  2. **Module-level class constants were invisible.** `const BADGE = 'px-1.25
 *     text-sm …'` is not an attribute, so 24 of the 74 type-rung sites in the
 *     renderer — a third of the vocabulary — sat outside the audit. All three of
 *     `ui/Menu.tsx`'s were among them: the whole popup's type, unaudited.
 *  3. **Tailwind harvests class names out of comments, and was doing it.** On a
 *     clean tree the shipped stylesheet contained two rules nobody had worn:
 *     one from a paragraph in `ui/spec.ts` explaining that a bracketed hex
 *     "compiles, paints, and is invisible to the audit", and one from a JSX
 *     comment in `InspectorView.tsx` naming the arbitrary value it had just
 *     replaced with a token. Both sentences made themselves true.
 *
 * Scanning comments is therefore **correct and fail-closed**, not overreach: if
 * Tailwind would emit it, the audit has to see it. The cost is real and is the
 * price — prose in `src/renderer/` may not name a live class, and the two
 * paragraphs above had to be rewritten to describe their hazard in words. That
 * is the rule working, and the note explaining why they read the way they do is
 * on each of them, because the next reader will want to "improve" them back.
 *
 * So there are two class scanners below, with deliberately different names:
 *
 *   `attributeClassNames`  — attribute-precise. Answers "which classes landed on
 *                            *this element*", which is the className fence's
 *                            question and one a whole-file scan cannot answer.
 *   `tailwindCandidates`   — Tailwind-equivalent. Answers "which classes could
 *                            reach the stylesheet from this file", which is the
 *                            question every *ban* and every *census* is asking.
 *
 * Reaching for the first one where the second is meant is how all three holes
 * above happened. The names are the guardrail.
 * ================================================================== */

/**
 * Replace the contents of comments and string literals with spaces, keeping
 * every newline and the overall length.
 *
 * String *delimiters* are kept, so an attribute written `name="value"` still
 * reads as `name="     "` rather than losing its shape entirely — a scanner
 * looking for the attribute still finds it and simply sees an empty value.
 * Callers that need the real value slice it out of the original text.
 */
export function blankNonCode(src: string): string {
  return blank(src, true)
}

/**
 * Blank comments only, leaving string literals intact.
 *
 * The variant you want when the thing being asserted *is* a string — an
 * attribute value, a role, a class name. `blankNonCode` would hide it along with
 * the prose. Strings are still tracked while scanning (a `//` inside a literal is
 * not a comment); they are simply not erased.
 */
export function blankComments(src: string): string {
  return blank(src, false)
}

function blank(src: string, eraseStrings: boolean): string {
  const out = [...src]
  const erase = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      erase(i, stop)
      i = stop
      continue
    }

    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      erase(i, stop)
      i = stop
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1
        j += 1
      }
      if (eraseStrings) erase(i + 1, j)
      i = j + 1
      continue
    }

    i += 1
  }

  return out.join('')
}

/**
 * The attribute text of every `<Tag …>` opening tag in `source`.
 *
 * A JSX opening tag is not a regex-shaped thing — `onClick={() => a > b}` puts a
 * `>` inside it — so the closing bracket is found at brace depth zero rather
 * than by pattern. The search runs over the blanked copy; the slices come from
 * the original, so attribute values are real.
 */
export function openingTags(source: string, tag: string): string[] {
  const src = blankNonCode(source)
  const out: string[] = []
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'g')

  for (const m of src.matchAll(open)) {
    const start = m.index + m[0].length
    let depth = 0
    for (let i = start; i < src.length; i += 1) {
      const c = src[i]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      else if (c === '>' && depth === 0) {
        out.push(source.slice(start, i))
        break
      }
    }
  }
  return out
}

/**
 * A line-number lookup for one source text, precomputed.
 *
 * Every scanner below reports positions, and the obvious `src.slice(0, i)
 * .split('\n').length` is quadratic — which is invisible on one fixture and not
 * on 195 files scanned three times over.
 */
function lineIndex(source: string): (index: number) => number {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1)
  return (index) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * The contents of every string literal in `source`, with its offset.
 *
 * Written because the naive `/['"`]([^'"`]*)['"`]/g` gets template literals
 * exactly backwards, and gets them backwards in the one shape that matters:
 *
 *     `flex ${cond ? 'a' : 'b'}`
 *
 * The quotes around `'a'` and `'b'` pair with each other only if you already
 * know where the interpolation is; read left to right by a regex, the opening
 * backtick pairs with `'`, and the two class names that *vary* — the entire
 * point of writing an expression — fall outside every match. The migration
 * record documents this as "class strings must be written out in full", which
 * is a workaround for a scanner bug being paid for in duplicated source.
 *
 * So: a small state machine. Quoted runs yield their body; a template yields
 * each static chunk and recurses into every `${…}`, so nested literals of any
 * depth come back too.
 */
function stringLiterals(source: string, from = 0, to = source.length): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = []
  let i = from
  while (i < to) {
    const c = source[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < to && source[j] !== c) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      out.push({ index: i + 1, text: source.slice(i + 1, j) })
      i = j + 1
      continue
    }
    if (c === '`') {
      let j = i + 1
      let chunk = j
      while (j < to && source[j] !== '`') {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          out.push({ index: chunk, text: source.slice(chunk, j) })
          // Balanced, because an interpolation legitimately nests braces —
          // `${cond ? f({ a }) : ''}` — and stopping at the first `}` would
          // resume tokenising in the middle of an expression.
          let depth = 0
          let k = j + 1
          for (; k < to; k += 1) {
            if (source[k] === '{') depth += 1
            else if (source[k] === '}') {
              depth -= 1
              if (depth === 0) break
            }
          }
          out.push(...stringLiterals(source, j + 2, k))
          j = k + 1
          chunk = j
          continue
        }
        j += 1
      }
      out.push({ index: chunk, text: source.slice(chunk, Math.min(j, to)) })
      i = j + 1
      continue
    }
    i += 1
  }
  return out
}

/**
 * Every class name written into a `className` attribute on this element, with
 * the line it is on.
 *
 * **Use this only when the question is "which classes landed on *this*
 * element".** That is the className fence in `control-spec.test.ts` and nothing
 * else: a `<Button>` may be placed by its caller but never repainted, and no
 * whole-file scan can say which of a file's classes reached a Button. For a
 * *ban* or a *census* — "does this file contain X anywhere" — this function is
 * the wrong tool and its narrowness is a hole; use `tailwindCandidates`.
 *
 * The forms it reads:
 *
 *   className="a b"                       → a, b
 *   className={cond ? 'a' : 'b'}          → a, b
 *   className={`x ${cond ? 'a' : 'b'}`}   → x, a, b
 *   className={SOME_CONST}                → nothing, and nothing can be done
 *                                           about it here: the value is not in
 *                                           this expression. `tailwindCandidates`
 *                                           sees the constant's own text, which
 *                                           is why the bans read that instead.
 *
 * Comments are blanked first — prose naming a class is not a class *on an
 * element*, which is the mistake the top of this module exists to stop making.
 * (Note that the opposite is true for `tailwindCandidates`, and for a reason
 * spelled out there: prose naming a class **is** a class in the stylesheet.)
 */
export function attributeClassNames(source: string): { line: number; name: string }[] {
  const src = blankComments(source)
  const out: { line: number; name: string }[] = []
  const lineOf = lineIndex(src)

  for (const m of src.matchAll(/\bclassName\s*=\s*/g)) {
    let i = m.index + m[0].length
    let end: number
    if (src[i] === '{') {
      // Balanced, because a className expression legitimately contains braces:
      // `{cond ? styles({ a }) : ''}`. Stopping at the first `}` truncates it.
      let depth = 0
      let j = i
      for (; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1
        else if (src[j] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      end = j
      i += 1
    } else if (src[i] === '"' || src[i] === "'") {
      end = src.indexOf(src[i], i + 1)
      if (end === -1) continue
      end += 1
    } else {
      continue
    }

    for (const lit of stringLiterals(src, i, end)) {
      for (const name of lit.text.split(/\s+/)) {
        if (name === '') continue
        out.push({ line: lineOf(lit.index), name })
      }
    }
  }
  return out
}

/**
 * Candidate class names anywhere in `source`, the way Tailwind finds them.
 *
 * This is the scanner whose aperture has to match the one that actually decides
 * what ships. Tailwind v4's extractor reads raw bytes: no syntax, no comments,
 * no strings, no Markdown — a run of candidate characters bounded by something
 * that cannot be part of one. Everything valid it finds is compiled.
 *
 * The shape below was **checked against a build**, not inferred, by planting
 * twenty uniquely-coloured tokens in different syntactic positions and grepping
 * `out/renderer/assets/*.css`. What compiled:
 *
 *   a line comment · a block comment · a JSDoc backtick span · a Markdown file ·
 *   a module-level `const` · both branches inside a template interpolation ·
 *   an array literal · a variant prefix (`hover:…`) · a slash modifier (`…/50`) ·
 *   a `class="…"` attribute in a comment · a token after a `.` property access
 *
 * A second round of twenty, planted the same way, added the bracket and
 * parenthesis forms described further down — including under a variant, under a
 * selector variant, and carrying Tailwind's important marker on either side. The
 * marker itself is deliberately *not* part of a candidate: the match simply
 * starts after a leading `!` and stops before a trailing one, so the bracket
 * group still comes back and every ban downstream still sees it, without an `!`
 * appearing on the front of tokens that three other tests classify by prefix.
 *
 * What did not: a name glued to an identifier (`xxbg-…`), and a value split
 * across a concatenation (`'bg-' + '[#…]'`) — Tailwind cannot see through `+`
 * either, so neither does this. A `.css` file is not scanned for candidates at
 * all, which is why `scannedSources` excludes them; a comment in `theme.css`
 * naming a banned form is genuinely harmless, and a comment in `spec.ts` is not.
 *
 * Where this errs it errs **wider** than Tailwind — a token wrapped in
 * parentheses or trailing a URL is returned here and discarded there. That is
 * the direction to be wrong in: a rule can only be broken in production through
 * an opening Tailwind has and we do not. The widened aperture leans further that
 * way still: every bracketed run in the renderer that is not welded to a word
 * now comes back as a candidate, regex character classes and destructuring
 * included. Two hundred and eighty-three of them, and the bans below are written
 * to be quiet about all of them; see the shape-by-shape note on the ban itself.
 *
 * What comes back is the raw candidate, variants and all (`hover:bg-bg-2`), so
 * callers strip prefixes with whatever rule they already use.
 *
 * ## The three families that begin somewhere other than a letter
 *
 * The shape above read `family` then optional `-` then optional brackets, so
 * **every candidate it could ever return started with a letter or a `-`**. Three
 * of Tailwind v4's syntaxes do not, and all three were planted on a real element
 * and built before this paragraph was written:
 *
 *  1. a square-bracketed `property:value` pair used as the whole utility, which
 *     compiles to a rule setting that property to that literal;
 *  2. the same shape naming a CSS shorthand, which reaches properties no audit
 *     that reads a longhand declaration will ever see;
 *  3. the same shape *defining* a custom property, paired with the parenthesised
 *     shorthand that reads one back — two rules, one minting a palette entry and
 *     one painting with it.
 *
 * None of them contains the dash-then-bracket the arbitrary-value ban was
 * looking for, and — the reason widening that ban alone would have fixed
 * nothing — the old pattern could not *start* a match at `[`, so the tokens
 * never reached the ban at all. `[background` was returned as the candidate
 * `background`: a plausible-looking family name, which is the worst possible
 * failure mode, because it is indistinguishable from a real hit on a real word.
 *
 * The two sub-patterns below are named because the ban downstream names them
 * too. Neither admits whitespace or a quote: Tailwind spells a space `_` inside
 * these, and a quote is where one source token stops. Both nest one level, which
 * is what a selector variant and a `url(…)` value need and no more.
 */

/** `[…]` — an arbitrary value when it hangs off a family, an arbitrary property
 *  when it is the whole utility, an arbitrary variant when a `:` follows it. */
const BRACKET = String.raw`\[(?:[^\[\]\s'"\`]|\[[^\[\]\s'"\`]*\])*\]`

/** `(…)` — the parenthesised shorthand that reads a custom property back. */
const PAREN = String.raw`\((?:[^()\s'"\`]|\([^()\s'"\`]*\))*\)`

const CANDIDATE = new RegExp(
  // Not glued to the tail of an identifier or a custom property: `--text-sm`
  // defines the rung, `xxtext-sm` is somebody's variable. It guards the bracket
  // forms too, and that is most of what keeps them quiet: `rows[i]` and
  // `string[]` are brackets welded to a word, so no match starts there.
  String.raw`(?<![\w-])` +
    // Variant prefixes: `hover:`, `not-disabled:`, `data-[open]:`, and the bare
    // bracketed selector variant, which is the first of the three forms that
    // opens with `[` rather than with a letter.
    String.raw`(?:(?:[a-z0-9][\w.-]*(?:${BRACKET}|${PAREN})?|${BRACKET}|${PAREN}):)*` +
    String.raw`(?:` +
      // The arbitrary property, standing where a family would.
      BRACKET +
      String.raw`|` +
      // The family, optionally negated: `bg`, `px`, `-mt`.
      String.raw`-?[a-z][a-z0-9]*` +
      // Dash-joined parts: a word, an arbitrary value, or a variable shorthand.
      String.raw`(?:-(?:${BRACKET}|${PAREN}|[a-z0-9]+(?:\.[0-9]+)?))*` +
      // The `/…` modifier: `from-accent/10`, `bg-black/[.06]`, `bg-accent/(--a)`.
      String.raw`(?:\/(?:${BRACKET}|${PAREN}|[a-z0-9.]+))?` +
    String.raw`)`,
  'g',
)

export function tailwindCandidates(source: string): { line: number; name: string }[] {
  const lineOf = lineIndex(source)
  return [...source.matchAll(CANDIDATE)].map((m) => ({ line: lineOf(m.index), name: m[0] }))
}

/**
 * Every file Tailwind reads candidates out of, discovered rather than listed.
 *
 * `theme.css` points it at this whole directory (`@source './'`) and excludes
 * only `__tests__/`, so that is what this returns — `.ts`, `.tsx` and the
 * Markdown guide alike, because a fenced example in `ui/CLAUDE.md` compiles
 * exactly like a class in a component. `.css` is left out because Tailwind does
 * not scan stylesheets for candidates; verified the same way as everything else
 * in `tailwindCandidates`, by planting a token in one and building.
 *
 * The same reasoning as `stylesheets()` one function down: three rules of the
 * form "nothing anywhere may do X", and a file set any of them remembers on its
 * own is a file set that goes stale the day somebody adds a directory.
 */
export function scannedSources(rendererDir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(rendererDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = relative(rendererDir, join(entry.parentPath, entry.name))
    if (rel.split(/[\\/]/).includes('__tests__')) continue
    if (rel.endsWith('.css')) continue
    out.push(rel)
  }
  out.sort()

  assert.ok(
    out.includes(join('ui', 'spec.ts')),
    `the source scan did not find ui/spec.ts under ${rendererDir}. It found ${String(out.length)} ` +
      `files. Something moved, and every ban that reads this list has just gone vacuous — spec.ts ` +
      `is the single highest-value place to hide a class, because one string there repaints ` +
      `eighty-seven call sites.`,
  )
  return out
}

/**
 * Every stylesheet under `renderer/`, discovered rather than listed.
 *
 * Three tests had their own hardcoded copy of this list — the type floor, the
 * literal-border ban, and the control layer's className fence. All three are
 * rules of the form "nothing anywhere may do X", and all three were one new file
 * away from being quietly true only of the files somebody remembered.
 *
 * That is already the same failure twice over: `#7a3f3f` evaded the contrast
 * audit by not being a token, and `opacity` evaded it by not being a colour
 * declaration. A stylesheet evading it by not being on a list would be the third
 * spelling of one mistake — and `segmented.css` was about to be the fourth file
 * that had to be remembered in three places.
 *
 * The non-empty assertion is not padding: a directory move that made this return
 * `[]` would turn every rule that reads it into a vacuous pass, which is exactly
 * the fail-open shape being removed.
 *
 * **It returns exactly one path today** (§11.1 merged the eight sheets back into
 * `styles.css`), and that is not a reason to delete this or to inline the name.
 * Discovery is what makes "nothing anywhere may do X" true of a file somebody
 * adds tomorrow, and a one-element list is the state a second stylesheet is one
 * commit away from. Callers that want a *part* of the sheet — `grid-layout.
 * test.ts` needs the grid's own rules and nothing else — slice it by the
 * `SHEET:` banners the merged file carries, rather than narrowing this.
 */
export function stylesheets(rendererDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) out.push(relative(rendererDir, full))
    }
  }
  walk(rendererDir)
  out.sort()

  assert.ok(out.length > 0, `no stylesheets found under ${rendererDir} — the scan is broken, not the CSS`)
  assert.ok(
    out.includes('styles.css'),
    `the stylesheet scan did not find styles.css; it found ${out.join(", ")}. Something moved, and every ` +
      `rule that reads this list has just gone vacuous.`,
  )
  return out
}

/** Strip CSS comments. The same rule, for the stylesheets. */
export function decomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/* ==================================================================
 * The shipped artifact.
 *
 * Everything above reads source. This reads what the build emitted, and it
 * exists for one kind of assertion: **a class name on an element is not, by
 * itself, evidence that a property is set.** A fence that used to read
 * `styles.css` for `position: relative` and now reads `Panel.tsx` for the token
 * `relative` has swapped a real declaration for a spelling, and a spelling that
 * compiles to nothing looks exactly like one that compiles.
 *
 * So the two halves are asserted together: the element wears the class, and the
 * class carries the declaration. The second half needs a build, which a unit
 * test cannot demand — `readShippedCss` returns `null` when there is none, and
 * every caller must say what it does then. Skipping silently is the failure mode
 * this whole file exists to prevent; skipping *loudly* is the honest option, and
 * `pnpm build` runs `audit-shipped-css.mjs` unconditionally anyway.
 * ================================================================== */

/**
 * The built stylesheet, or `null` when nothing has been built.
 *
 * `rendererDir` is `src/renderer`; the artifact is four levels up in `out/`.
 */
export function readShippedCss(rendererDir: string): { name: string; css: string } | null {
  const dir = join(rendererDir, '..', '..', 'out', 'renderer', 'assets')
  if (!existsSync(dir)) return null
  const name = readdirSync(dir).find((f) => f.endsWith('.css'))
  if (name === undefined) return null
  return { name, css: readFileSync(join(dir, name), 'utf8') }
}

/**
 * The declaration block a single utility class compiles to, or `null`.
 *
 * Matches the class as the *whole* selector, so `.relative{…}` is found and
 * `.panel .relative{…}` is not — the question being asked is what this one class
 * does on its own, which is the only thing that survives being written into an
 * unordered class list.
 *
 * Escaped names are handled because Tailwind writes them: `min-h-0` is plain,
 * but `px-2.25` ships as `.px-2\.25` and `overflow-x-auto` is plain again. The
 * escape is applied to the characters Tailwind escapes rather than to everything
 * a regex would, so `\.` in the artifact matches `.` in the argument.
 *
 * The character before the `.` may be `{` as well as `}` or `,`, and that is not
 * defensive breadth — the first rule inside `@layer utilities{` has a `{` in
 * front of it, and in a minified artifact that is exactly where
 * `.pointer-events-none` lands. Leaving `{` out reported a live utility as
 * generating no CSS, which is the failure this function exists to detect and the
 * worst possible thing for it to report falsely.
 */
export function utilityBody(css: string, utility: string): string | null {
  const escaped = utility.replace(/[.:/[\]()%!]/g, (c) => `\\\\?\\${c}`)
  const re = new RegExp(`(?:^|[,}{])\\s*\\.${escaped}\\s*\\{([^}]*)\\}`)
  const m = re.exec(css)
  return m === null ? null : m[1]
}
