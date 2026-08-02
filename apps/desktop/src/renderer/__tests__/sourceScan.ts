import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
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
