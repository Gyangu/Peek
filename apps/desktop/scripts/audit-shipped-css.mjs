#!/usr/bin/env node
/*
 * ==================================================================
 * The artifact is the truth. Nothing else in this repo reads it.
 * ==================================================================
 *
 * Every other guard on the styling of this renderer reads *source*: the token
 * census in `theme-contrast.test.ts`, the type ladder in `type-scale.test.ts`,
 * the className fence in `control-spec.test.ts`, the arbitrary-value bans. All
 * of them answer questions about what somebody wrote. None of them has ever
 * opened the stylesheet the application actually loads.
 *
 * That gap has a shape, and the shape has now been found six times in this one
 * repository under six different disguises: **Tailwind harvests class names out
 * of prose.** Its extractor reads the raw bytes of every file under `@source` —
 * it does not know what a comment is, what a string is, what a Markdown fence
 * is. A sentence explaining why a class was *avoided* mints that class. A
 * sentence using the English word "shadow" mints `.shadow`.
 *
 * Six spellings of one bug, from `sourceScan.ts`'s header and §8/§9 of the
 * migration record: a JSDoc naming a bracketed hex, a JSX comment naming the
 * arbitrary value it had just replaced, a fenced example in a guide, a template
 * literal the old scanner could not see through, a module-level constant it
 * could not see at all, and a paragraph in `ChatSessionsRail` whose causality
 * ran backwards. Every fix so far has been a *wider source scan*.
 *
 * A wider source scan cannot close this. It answers "could this file mint a
 * class", which is a proxy. The rule that actually matters is:
 *
 *   **No rule ships that no element wears.**
 *
 * and the only place that can be checked is the built stylesheet. So this script
 * reads `out/renderer/assets/*.css`, takes every class selector in it, and
 * requires each one to be worn by a class name written in code — comments
 * blanked, because a comment is not an element.
 *
 * On a clean tree before this script existed, that turned up seven rules worn by
 * nobody, ~1.1 KB, one of them (`.shadow`) carrying `rgba(0,0,0,.1)` — a
 * hard-coded colour in the shipped stylesheet that the source-level colour sweep
 * is structurally unable to see, because the source says the word "shadow", not
 * a colour.
 *
 * ==================================================================
 * The second rule: no colour ships that `@theme` does not account for
 * ==================================================================
 *
 * That parenthesis above turned out to be the smaller half of the story. The
 * source-level colour sweep in `theme-contrast.test.ts` is not merely blind to
 * colours that arrive through a class name — it is blind to colours the source
 * spells in a way its pattern does not list. It matched `#hex`, `rgb(` and
 * `hsl(`. Every other spelling CSS has was open:
 *
 *   `color: rebeccapurple`          ships as `.empty-hint{color:#639}`
 *   `background: oklch(.6 .2 20)`   ships as `#de394b`
 *
 * Both on a rule with four live wearers, both with `pnpm build` exiting 0 and
 * the whole renderer suite green. **Lightning CSS down-converts on the way out**,
 * so what ships is exactly the shape the sweep was written to catch, and the
 * sweep never sees it, because it reads the source spelling. Named colours,
 * `oklch`, `lab`, `oklab`, `color()`, `hwb` and `light-dark()` were all open.
 *
 * §10.2 of the migration record had already learned the general form of this:
 * the old ban matched `border*` and `outline*`, and the fix was that **the
 * subject of the rule is the value, not the property**. This is the same lesson
 * one level down. The subject was already the value; the *reader* was still a
 * list of spellings, and a list of spellings can only ever be as long as
 * somebody remembered.
 *
 * The convergent answer is the one this file already embodies. Down-conversion
 * is not the problem, it is the lever: whatever a source wrote, the artifact
 * holds a small, normalised set of shapes — hex, `rgb()`, `color-mix()` over
 * `var()`s, and the two keywords that are not literals at all. So the rule is
 *
 *   **Every colour in the artifact is a palette colour, or it is nothing.**
 *
 * "a palette colour" = the same RGB triple as something the `@theme` block
 * declares, at any alpha (that is what `bg-accent/18` and a mix against
 * `transparent` produce). "nothing" = alpha zero, or `currentcolor`, which
 * borrows from a property audited elsewhere. Anything else is a colour no token
 * names, whatever the source called it.
 *
 * Both readers are kept, and they are not redundant. See the note above
 * `PALETTE` for the split.
 *
 * ==================================================================
 * Why this is a build step and not a test
 * ==================================================================
 *
 * It needs a build. `pnpm test` runs on sources alone and must keep doing so, so
 * a case in the unit suite would either have to skip when `out/` is missing —
 * the fail-open shape this repo has been bitten by four times, and the reason
 * `stylesheets()` carries an explicit non-empty assertion — or make the whole
 * suite depend on a bundler.
 *
 * A standalone script has the opposite failure: nobody runs it. So it is not
 * standalone. `package.json` runs it as the last step of `build`, which means a
 * dead rule fails `pnpm build` in the same breath that produced it, and the
 * repository's third gate covers it for free. Running it by hand is still
 * supported and still fails hard when `out/` is absent — see `readArtifact`.
 *
 * That last sentence used to be the whole story about running it by hand, and it
 * covered the wrong half. The **absent** artifact was designed for and verified;
 * the **stale** one was not, and a stale artifact is the likelier of the two,
 * because `pnpm audit:css` is advertised right there in `package.json` and
 * running it costs a second where a build costs a minute. Measured: four
 * unaudited colours planted in `styles.css` — a named colour, an `oklch()`, a
 * hex and an `hsl()`, on four rules with live wearers — then `pnpm audit:css`
 * with no rebuild in between. Exit **0**, and the last line said
 * `76 colour values, all from the 38-colour palette`. It was telling the truth
 * about a stylesheet nobody was shipping.
 *
 * This is the same fail-open shape as the absent artifact wearing a disguise: an
 * audit that knows nothing has to say so. So `readArtifact` compares the
 * artifact's own mtime against the newest of the files that produce it, and
 * refuses when a source is newer. Inside `pnpm build` the artifact was written
 * seconds ago and the check costs nothing; by hand it is the difference between
 * an answer and a stale answer that reads exactly like one.
 *
 * ==================================================================
 * What "worn" means, exactly
 * ==================================================================
 *
 * A class is worn if it appears in a scanned source file, **with comments
 * blanked**, as a whole token — that is, delimited the way a class in a class
 * list is delimited. Three consequences worth stating because each one is a
 * decision:
 *
 *  - `.md` files are prose end to end. `ui/CLAUDE.md` is inside `src/renderer/`
 *    and Tailwind compiles its fenced examples exactly like a component's
 *    className, but no element in the product wears a class from a guide. So a
 *    guide can never make a rule live; it can only mint a dead one.
 *  - The comparison is on whole tokens, not on `tailwindCandidates()` output.
 *    The candidate scanner answers "what could this file mint", which is
 *    deliberately *wider* than Tailwind; here the exact string is already known
 *    from the artifact, and the question is the narrower "did anybody write
 *    this". Narrower is the safe direction for this check: it can raise a false
 *    alarm, never wave a dead rule through. There are zero false alarms today.
 *  - `header.resize` does not wear `resize`, and `t('sidebar.collapse')` does not
 *    wear `collapse`. The token boundary keeps the dot, so those read as
 *    `header.resize` and `sidebar.collapse` and neither one matches.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { blankComments, scannedSources, stylesheets } from '../src/renderer/__tests__/sourceScan.ts'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(desktopDir, 'src', 'renderer')
const artifactDir = join(desktopDir, 'out', 'renderer', 'assets')

/**
 * Class selectors that ship deliberately unworn, with the reason each one is
 * allowed to be. The repository idiom — ALPHA_SITES, NOT_CONTROLS,
 * CLASSNAME_LEDGER — is a named list carrying its own justification, never a
 * loosened assertion.
 *
 * Everything here is one case: a rule we author against a DOM we do not write.
 *
 * **The list is empty, and that is the current state rather than an oversight.**
 * It held twelve `cm-*` entries until the CodeMirror dark theme moved out of
 * `styles.css` and into `EditorView.theme` in `components/SqlEditor.tsx`. That
 * theme is injected by style-mod at runtime and never reaches this stylesheet,
 * so there is no longer a rule here targeting a DOM we do not write.
 *
 * Keep the mechanism. The next foreign-DOM rule is a decision somebody should
 * have to write a sentence for, and the staleness assertion below means a dead
 * entry cannot sit here pretending to excuse something.
 */
const FOREIGN_DOM = {}

/**
 * Colours that ship without a token naming them, with the reason each one is
 * allowed to. Same idiom as FOREIGN_DOM above and for the same reason: being
 * outside the audit has to be a sentence somebody wrote.
 *
 * `site` is the custom property the colour is the value of — an `@property`
 * block and the `*,:before,:after,::backdrop` reset that seeds the same property
 * collapse to one entry, which is the honest grouping: they are two halves of
 * one declaration. `colour` must match exactly; an exemption is for a value, not
 * for a property that may then hold anything.
 *
 * Everything here is one case, and it is the mirror of FOREIGN_DOM: a
 * declaration Tailwind writes, in a namespace this codebase does not author.
 */
const TAILWIND_INTERNALS = [
  {
    site: '--tw-ring-offset-color',
    colour: '#fff',
    why:
      "Tailwind's own default for the ring-offset variable, seeded in its reset and in the " +
      '`@property` that types it. It is a fallback, not a paint: it only reaches a pixel through a ' +
      '`ring-offset-*` utility, no element wears one, and `ring` itself is struck off in ' +
      '`@source not inline(…)`. Naming it in `@theme` would put a white into a palette that has none.',
  },
]

/* ---------------------------------------------------------------- reading */

/**
 * The stylesheets the application actually loads.
 *
 * The assertions here are the point of the function, not paperwork around it.
 * A missing `out/`, an empty assets directory, or a zero-byte stylesheet all
 * mean "this audit knows nothing", and an audit that knows nothing must say so
 * loudly rather than return an empty list and let every rule below pass
 * vacuously. That fail-open shape has cost this repository four separate
 * regressions; `stylesheets()` in `sourceScan.ts` carries the same guard for
 * the same reason.
 */
function readArtifact() {
  assert.ok(
    existsSync(artifactDir),
    `no build output at ${artifactDir}.\n` +
      `This audit reads the stylesheet the app actually loads, so there is nothing for it to read ` +
      `and nothing it could honestly say. Run \`pnpm build\` first — it runs this script itself as ` +
      `its last step, which is how the check stays run.`,
  )
  const names = readdirSync(artifactDir).filter((n) => n.endsWith('.css'))
  assert.ok(
    names.length > 0,
    `${artifactDir} exists but holds no .css file. Either the build failed part way or the renderer ` +
      `stopped emitting a stylesheet; both mean this audit is blind, and blind is a failure, not a pass.`,
  )
  const sheets = names.map((name) => ({ name, css: readFileSync(join(artifactDir, name), 'utf8') }))
  for (const sheet of sheets) {
    assert.ok(sheet.css.length > 0, `${sheet.name} is empty — a zero-byte stylesheet audits to nothing.`)
  }

  // The artifact has to be an artifact *of this tree*. See `newestSource`.
  const builtAt = Math.min(...names.map((name) => statSync(join(artifactDir, name)).mtimeMs))
  const newest = newestSource()
  assert.ok(
    builtAt >= newest.ms,
    `the shipped stylesheet is older than the sources that produce it:\n` +
      `    ${newest.rel}  modified ${new Date(newest.ms).toISOString()}\n` +
      `    ${names.join(', ')}  built ${new Date(builtAt).toISOString()}\n\n` +
      `  This audit reads the artifact, which is the only reason it can see a colour no source\n` +
      `  spells and a rule no element wears. That only holds while the artifact is the one the\n` +
      `  current sources compile to. Read a stale one and every assertion below is true of a\n` +
      `  stylesheet nobody is shipping — and it reports that in the same words it uses when the\n` +
      `  tree really is clean, which is the one thing an audit must never do.\n\n` +
      `  Run \`pnpm build\`. It ends by running this script, so the artifact it leaves behind is by\n` +
      `  construction newer than every source that went into it.\n\n` +
      `  If this fired *during* a build, a source was written after the renderer bundle was emitted\n` +
      `  — a concurrent edit. That is still the right answer: the artifact really does not match\n` +
      `  the tree. Build again once the tree is still.\n`,
  )
  return sheets
}

/**
 * The most recently modified file the shipped stylesheet is compiled from.
 *
 * The same two scanners the rest of this script reads, and for the same reason
 * `sourceScan.ts` discovers them rather than listing them: a file set somebody
 * remembered is a file set that goes stale the day a directory is added, and
 * this one is load-bearing in the direction where being wrong is silent. Both
 * halves matter and neither implies the other — `styles.css` is where a colour
 * is declared, and the `.ts`/`.tsx` files are where a class is worn, which is
 * what decides whether a rule is compiled at all.
 *
 * Deliberately not included: everything outside `src/renderer`. The main
 * process, the packages and the config files can all change the *bundle*, and
 * none of them changes the stylesheet — Tailwind's scan is what `@source` says
 * it is. Widening this to the repository would make the check fire on edits that
 * cannot possibly matter, and a guard that cries wolf is a guard that gets
 * deleted.
 */
function newestSource() {
  const files = [
    ...scannedSources(rendererDir).map((rel) => ({ rel, path: join(rendererDir, rel) })),
    ...stylesheets(rendererDir).map((rel) => ({ rel, path: join(rendererDir, rel) })),
  ]
  assert.ok(
    files.length > 100,
    `only ${String(files.length)} source files found under ${rendererDir}. The renderer holds over a ` +
      `hundred and fifty; a list this short means the staleness check below is comparing the artifact ` +
      `against almost nothing, which passes for exactly the wrong reason.`,
  )
  let newest = { rel: files[0].rel, ms: -Infinity }
  for (const file of files) {
    const ms = statSync(file.path).mtimeMs
    if (ms > newest.ms) newest = { rel: file.rel, ms }
  }
  return newest
}

/* -------------------------------------------------------------- CSS side */

/**
 * Every `{ … }` block's prelude, at any nesting depth.
 *
 * Not a CSS parser: it tracks comments, quoted strings and brace depth, which is
 * all that is needed to know whether a `.` is in selector position or in the
 * middle of `calc(var(--spacing) * 2.5)`. Reading declarations as selectors is
 * how a naive version of this reports `.5` as a class.
 *
 * A quote only opens a string if it closes before the next newline. CSS strings
 * cannot span a raw newline, so the guard costs nothing and buys the failure
 * mode this was actually written against: an unpaired quote — one left orphaned
 * by a glob whose middle happens to spell a comment open-and-close, which is
 * exactly what the `__tests__` exclusion in `styles.css` looks like — makes an
 * unguarded scanner swallow the rest of the file and return nothing at all. A
 * scan that silently returns nothing passes every assertion below.
 */
function preludes(css) {
  const out = []
  let buf = ''
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c && css[j] !== '\n') {
        if (css[j] === '\\') j += 1
        j += 1
      }
      if (css[j] === c) {
        i = j + 1
        buf += ' '
        continue
      }
    }
    if (c === '{') {
      out.push(buf.trim())
      buf = ''
      i += 1
      continue
    }
    if (c === '}' || c === ';') {
      buf = ''
      i += 1
      continue
    }
    buf += c
    i += 1
  }
  return out
}

/**
 * CSS identifier characters, escapes excluded — those are unwound separately.
 * The non-ASCII half is written as an explicit range so that it is readable and
 * so that it starts *above* the space: whitespace still ends a name.
 */
const IDENT = /[A-Za-z0-9_\u00A0-\uFFFF-]/

/**
 * The class names named by one selector prelude.
 *
 * Backslash escapes are unwound, which is the whole reason this cannot be a
 * regex over the minified text: Tailwind ships `.hover\:bg-bg-1`, `.h-6\.5`,
 * `.group-hover\/tab\:visible` and `.to-55\%`, and the class an element wears is
 * the unescaped spelling.
 *
 * At-rule preludes are skipped. A nested rule inside `@media` gets its own
 * prelude from `preludes()`, so nothing is lost, and `@supports` conditions stop
 * contributing punctuation that has to be argued about.
 */
function classesIn(prelude) {
  if (prelude.startsWith('@')) return []
  const out = []
  let i = 0
  while (i < prelude.length) {
    if (prelude[i] !== '.') {
      i += 1
      continue
    }
    let j = i + 1
    let name = ''
    while (j < prelude.length) {
      const ch = prelude[j]
      if (ch === '\\') {
        name += prelude[j + 1] ?? ''
        j += 2
        continue
      }
      if (IDENT.test(ch)) {
        name += ch
        j += 1
        continue
      }
      break
    }
    // `.5rem` is a length, not a class.
    if (name && !/^[0-9]/.test(name)) out.push(name)
    i = Math.max(j, i + 1)
  }
  return out
}

/* ------------------------------------------------------------ colour side */

/**
 * Every declaration in the sheet, with the prelude it sits under.
 *
 * `preludes()` above reads the other half of the same grammar and throws the
 * declarations away; this throws the selectors away and keeps them. Sharing one
 * walker would be tidier and is not worth the coupling — each is fifteen lines
 * and they answer opposite questions.
 *
 * The two things this has to get right:
 *
 *  - **At-rule preludes are not declarations.** `@supports (color:color-mix(in
 *    lab,red,red))` — Lightning CSS's own feature probe — contains the word
 *    `red` twice and `rgb(from red r g b)` appears in another one. A prelude
 *    ends at `{`, so none of it is ever read as a value. Nothing in a prelude
 *    can paint anything, so nothing is lost.
 *  - **`@property … { initial-value: #fff }` is a declaration**, and it keeps
 *    its at-rule prelude, which is how the colour audit knows *which* custom
 *    property that value belongs to.
 */
function declarations(css) {
  const out = []
  const stack = []
  let buf = ''
  let i = 0
  const flush = () => {
    const text = buf.trim()
    buf = ''
    if (!text || text.startsWith('@')) return
    const colon = text.indexOf(':')
    if (colon === -1) return
    out.push({
      property: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
      selector: stack[stack.length - 1] ?? '',
    })
  }
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c && css[j] !== '\n') {
        if (css[j] === '\\') j += 1
        j += 1
      }
      if (css[j] === c) {
        i = j + 1
        continue
      }
    }
    if (c === '{') {
      stack.push(buf.trim())
      buf = ''
      i += 1
      continue
    }
    if (c === ';') {
      flush()
      i += 1
      continue
    }
    if (c === '}') {
      flush()
      stack.pop()
      i += 1
      continue
    }
    buf += c
    i += 1
  }
  return out
}

/** Functional colour notations. Not `color-mix` / `light-dark`: those are
 *  containers, and `colourTokens` walks into every function it meets anyway. */
const COLOUR_FN = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'device-cmyk'])

const HEX = /#[0-9a-f]{3,8}\b/gi

/** The two colour keywords that are not literals: one is the absence of colour,
 *  the other is a reference to one. Guarded left and right so that a fragment of
 *  an identifier — `.transparent-ish`, `--currentcolor-x` — is not one. */
const COLOUR_KEYWORD = /(?<![\w.#-])(transparent|currentcolor)(?![\w-])/gi

/**
 * The colours named anywhere in one declaration value.
 *
 * Recursive over parenthesised functions, which is what makes it read
 * `var(--tw-shadow-color,#000a)` and `color-mix(in oklab,var(--color-accent)
 * 18%,transparent)` without needing to know what `var` or `color-mix` are: a
 * function that *is* a colour notation is returned whole so it can be resolved;
 * any other function is walked into and its arguments are scanned in its place.
 *
 * Deliberately not a spelling list. `oklch(.6 .2 20)` is here not because
 * somebody remembered `oklch` — Lightning CSS would have folded it to `#de394b`
 * before it reached this file — but because *whatever* survives to the artifact
 * lands in one of these shapes, and the resolver below either reduces it to
 * three channel values or refuses. Refusal is the safe direction: an
 * unresolvable colour is reported, never waved through.
 */
function colourTokens(text) {
  const out = []
  let plain = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '(') {
      let start = i
      while (start > 0 && /[\w-]/.test(text[start - 1])) start -= 1
      const name = text.slice(start, i).toLowerCase()
      let depth = 0
      let k = i
      for (; k < text.length; k += 1) {
        if (text[k] === '(') depth += 1
        else if (text[k] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (COLOUR_FN.has(name)) out.push(text.slice(start, Math.min(k + 1, text.length)))
      else out.push(...colourTokens(text.slice(i + 1, k)))
      plain = plain.slice(0, plain.length - (i - start))
      i = k + 1
      continue
    }
    plain += text[i]
    i += 1
  }
  for (const m of plain.matchAll(HEX)) out.push(m[0])
  for (const m of plain.matchAll(COLOUR_KEYWORD)) out.push(m[0].toLowerCase())
  return out
}

/**
 * One colour token as `r,g,b,a`, or `null` when it cannot be reduced to that.
 *
 * Hex and `rgb()`/`rgba()` are the whole vocabulary here on purpose: they are
 * what Lightning CSS emits. Every other notation — `oklch()`, `lab()`,
 * `color()`, a relative `rgb(from …)`, an `rgb()` built out of `var()`s —
 * returns null and is reported. Converting them here would be a second colour
 * library to keep correct, and there is nothing to convert: if one ever appears
 * the right response is to look at why, not to silently accept it.
 */
function rgbaOf(token) {
  if (token === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (token.startsWith('#')) {
    const h = token.slice(1)
    if (h.length !== 3 && h.length !== 4 && h.length !== 6 && h.length !== 8) return null
    const wide = h.length > 4
    const part = (n) => {
      const s = wide ? h.slice(n * 2, n * 2 + 2) : h[n] + h[n]
      return parseInt(s, 16)
    }
    const hasAlpha = h.length === 4 || h.length === 8
    return { r: part(0), g: part(1), b: part(2), a: hasAlpha ? part(3) / 255 : 1 }
  }
  const call = /^rgba?\s*\(([^)]*)\)$/i.exec(token)
  if (!call) return null
  if (/var\(|from\s/i.test(call[1])) return null
  const parts = call[1]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const channel = (s) => {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)%?$/.test(s)) return NaN
    const n = parseFloat(s)
    return s.endsWith('%') ? Math.round((n / 100) * 255) : Math.round(n)
  }
  const [r, g, b] = parts.slice(0, 3).map(channel)
  if ([r, g, b].some(Number.isNaN)) return null
  let a = 1
  if (parts.length === 4) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)%?$/.test(parts[3])) return null
    a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  }
  return { r, g, b, a }
}

/** The key a palette membership test compares on: the three channels, no alpha.
 *  Alpha is dropped because `bg-accent/18`, `bg-bg/82` and a mix against
 *  `transparent` are the same colour at a different strength, and the artifact
 *  spells all three as a hex with an alpha byte. A colour is in the palette or it
 *  is not; how much of it is showing is a different question, and `ALPHA_SITES`
 *  in `theme-contrast.test.ts` is the one that asks it. */
const rgbKey = (c) => `${String(c.r)},${String(c.g)},${String(c.b)}`

/** The `@theme` block of the renderer's one stylesheet, as text. */
function themeBlock() {
  const sheets = stylesheets(rendererDir)
  for (const rel of sheets) {
    const m = /@theme\s*\{([\s\S]*?)\n\}/.exec(readFileSync(join(rendererDir, rel), 'utf8'))
    if (m) return m[0]
  }
  assert.fail(
    `no @theme block found in ${sheets.join(', ')}. The palette is the list this audit compares ` +
      `every shipped colour against; with no palette to read, every colour in the artifact would ` +
      `pass for the wrong reason.`,
  )
}

/* ----------------------------------------------------------- source side */

/**
 * One token of class-legal characters. The set is Tailwind's own vocabulary —
 * word characters, `-`, the variant `:`, the `.` of `h-6.5`, the `/` of a slash
 * modifier, the `%` of `to-55%`, the brackets and parentheses of the arbitrary
 * forms (banned here, kept so a violation is seen rather than split in half),
 * the `!` of the important marker and the `*` of the child variant.
 *
 * Keeping `.` and `:` inside the token is what makes this discriminate: it is
 * why `header.resize` is not `resize` and `inline: 'nearest'` is not `inline`.
 */
const TOKEN = /[\w\-:./%[\]()!*]+/g

/** Every class name written in code — comments blanked, guides excluded. */
function wornClasses() {
  const files = scannedSources(rendererDir)
  const worn = new Map()
  for (const rel of files) {
    if (rel.endsWith('.md')) continue
    const text = blankComments(readFileSync(join(rendererDir, rel), 'utf8'))
    for (const token of text.match(TOKEN) ?? []) if (!worn.has(token)) worn.set(token, rel)
  }
  assert.ok(
    worn.size > 2000,
    `only ${String(worn.size)} class-shaped tokens found across ${String(files.length)} renderer sources. ` +
      `The source side of this audit has gone blind, which would pass every rule below for the wrong ` +
      `reason. Fix the scan, not the assertion.`,
  )
  return worn
}

/**
 * The utility names `styles.css` strikes off with `@source not inline(…)`.
 *
 * Read from the stylesheet rather than restated here, because two copies of a
 * blocklist is one copy that goes stale. The list is checked from the other
 * side below: a blocklisted name that some element actually wears is a rule
 * silently deleted out from under a live component, which is the one way this
 * mechanism could do harm.
 */
function blocklist() {
  const sheets = stylesheets(rendererDir)
  const names = new Set()
  for (const rel of sheets) {
    const css = readFileSync(join(rendererDir, rel), 'utf8')
    for (const m of css.matchAll(/@source\s+not\s+inline\(\s*['"]([^'"]*)['"]\s*\)/g)) {
      for (const name of m[1].split(/\s+/)) if (name) names.add(name)
    }
  }
  assert.ok(
    names.size > 0,
    `no \`@source not inline(…)\` found in ${sheets.join(', ')}. Seven utility names that are also ` +
      `ordinary English words are struck off there so that comments may use the words; if that line ` +
      `is gone, seven rules nobody wears are back in the artifact and this check just stopped ` +
      `looking for them.`,
  )
  return names
}

/* ------------------------------------------------------------------ main */

const sheets = readArtifact()
const worn = wornClasses()
const blocked = blocklist()

const shipped = new Map()
for (const sheet of sheets) {
  for (const prelude of preludes(sheet.css)) {
    for (const name of classesIn(prelude)) {
      if (!shipped.has(name)) shipped.set(name, sheet.name)
    }
  }
}

assert.ok(
  shipped.size > 300,
  `only ${String(shipped.size)} class selectors found in ${sheets.map((s) => s.name).join(', ')} ` +
    `(${String(sheets.reduce((n, s) => n + Buffer.byteLength(s.css), 0))} B). This renderer ships ` +
    `roughly five hundred. Either the extractor broke or the build did; either way the audit below ` +
    `is vacuous.`,
)

const unworn = [...shipped.keys()].filter((name) => !worn.has(name) && !(name in FOREIGN_DOM)).sort()

/**
 * An exemption that excuses nothing is a bug, not a spare part.
 *
 * TAILWIND_INTERNALS has been checked for staleness since it was written;
 * FOREIGN_DOM was not, and the gap had teeth. When the CodeMirror theme moved
 * into `EditorView.theme` all twelve `cm-*` entries stopped matching anything,
 * and nothing here would have said so — the audit would have gone on reporting
 * "12 exempt" about a stylesheet containing no rule any of them named. §28.10
 * of the migration record states the general form: a ledger entry that is no
 * longer hit is evidence the scan went blind, so it has to be read as a result
 * rather than left as a comment.
 */
const staleForeign = Object.keys(FOREIGN_DOM).filter((name) => !shipped.has(name)).sort()
assert.deepEqual(
  staleForeign,
  [],
  `${String(staleForeign.length)} entr(ies) on FOREIGN_DOM excuse a class rule the stylesheet no ` +
    `longer ships:\n` +
    staleForeign.map((name) => `    .${name}  (${FOREIGN_DOM[name]})`).join('\n') +
    `\n\n` +
    `  Each of these says "this rule targets a DOM we do not write", but there is no such rule any\n` +
    `  more. Delete the entry. If the rule moved rather than went away — into an\n` +
    `  \`EditorView.theme\`, a package stylesheet, anywhere outside this artifact — say so where it\n` +
    `  went, because this audit no longer covers it and something else has to.\n`,
)

assert.deepEqual(
  unworn,
  [],
  `${String(unworn.length)} rule(s) ship in the stylesheet and no element wears them:\n` +
    unworn.map((name) => `    .${name}`).join('\n') +
    `\n\n` +
    `  Tailwind's extractor reads the raw bytes of every file under \`@source\` — comments and\n` +
    `  Markdown included. A class name written in a sentence compiles into a real rule, and the\n` +
    `  sentence explaining why a class was avoided is the most reliable way to mint it. That has\n` +
    `  happened six times in this repository; one of the rules it produced carried a colour no\n` +
    `  token names, which no source-level sweep could see.\n\n` +
    `  Three ways out, in order of preference:\n` +
    `    1. If a comment names a class, quote it under the variant the element actually wears\n` +
    `       (\`after:m-auto\`, not \`m-auto\`) or describe it in words. Prose in src/renderer/ may\n` +
    `       not name a live class — migration record §8.3.\n` +
    `    2. If the name is an ordinary English word a comment has every right to use, strike the\n` +
    `       utility off instead of the word: add it to \`@source not inline(…)\` in styles.css,\n` +
    `       with the reason, next to the seven already there.\n` +
    `    3. If the rule targets a DOM this codebase does not write, add it to FOREIGN_DOM above\n` +
    `       with the element that wears it. That list is a set of named exceptions with written\n` +
    `       reasons, not a place to park a finding.\n`,
)

const blockedButWorn = [...blocked].filter((name) => worn.has(name)).sort()
assert.deepEqual(
  blockedButWorn,
  [],
  `${String(blockedButWorn.length)} name(s) are on the \`@source not inline(…)\` blocklist in ` +
    `styles.css and are also written on an element:\n` +
    blockedButWorn.map((name) => `    ${name}  (${worn.get(name)})`).join('\n') +
    `\n\n` +
    `  The blocklist stops Tailwind compiling these names at all, so the element is wearing a class\n` +
    `  that generates no CSS — a silent visual regression, exactly the failure mode the blocklist\n` +
    `  was allowed to have and this assertion exists to deny it. Either use a different utility, or\n` +
    `  take the name off the blocklist and reword the comments that were relying on it being dead.\n`,
)

/* ----------------------------------------------------------- the colours */

/**
 * The palette, as a set of channel triples, from two directions.
 *
 * **Why both, and not one.** `@theme` is the authored list, and it is where a
 * new colour has to be declared for the census in `theme-contrast.test.ts` to
 * demand a contrast measurement of it. But six of its entries are `color-mix()`
 * over `var()`s, and Lightning CSS resolves those on the way out — the artifact
 * says `--color-danger-hover:#483c42` where the source says a mix. Reading only
 * the source would mean re-implementing colour interpolation here to recognise
 * six values already sitting in the file being read; reading only the artifact
 * would let a palette entry exist that `@theme` never declared. So: the source
 * block gives the authored literals, the artifact's `:root`/`:host` blocks give
 * what those same declarations resolved to, and the name check below denies the
 * artifact any entry the source did not authorise.
 *
 * `--shadow-*` counts as palette. Tailwind inlines shadow tokens into the
 * utility rather than emitting a variable, so `--shadow-menu`'s black reaches
 * the artifact only as a literal inside `.shadow-menu`; the token that spells it
 * is in `@theme` and it is the same closed list.
 */
const PALETTE_PROP = /^--(color|shadow)-[a-z0-9-]+$/

const themeText = themeBlock()
const themeNames = new Set()
const palette = new Set()
for (const decl of declarations(themeText)) {
  if (!PALETTE_PROP.test(decl.property)) continue
  themeNames.add(decl.property)
  for (const token of colourTokens(decl.value)) {
    const c = rgbaOf(token)
    if (c) palette.add(rgbKey(c))
  }
}

assert.ok(
  themeNames.size > 30,
  `the @theme block yielded only ${String(themeNames.size)} colour tokens. The palette has held ` +
    `thirty-eight colours and five shadows since the migration; a number this low means the block ` +
    `was misparsed, and a palette that is nearly empty rejects nothing it should not and accepts ` +
    `nothing at all — the audit below would report the whole stylesheet or, worse, be edited until ` +
    `it did not.`,
)

const artifactDecls = sheets.flatMap((s) => declarations(s.css).map((d) => ({ ...d, sheet: s.name })))
assert.ok(
  artifactDecls.length > 300,
  `only ${String(artifactDecls.length)} declarations parsed out of the shipped stylesheet(s). This ` +
    `renderer ships around a thousand; the declaration walker has gone blind, and every colour ` +
    `assertion below would pass by finding nothing to look at.`,
)

const rootPalette = artifactDecls.filter((d) => /^:root\b|:host\b/.test(d.selector) && PALETTE_PROP.test(d.property))
const undeclared = [...new Set(rootPalette.map((d) => d.property))].filter((p) => !themeNames.has(p)).sort()
assert.deepEqual(
  undeclared,
  [],
  `${String(undeclared.length)} palette variable(s) are declared on :root in the shipped stylesheet ` +
    `and nowhere in the @theme block:\n` +
    undeclared.map((p) => `    ${p}`).join('\n') +
    `\n\n` +
    `  The artifact's :root blocks are read here as the resolved form of @theme — that is what lets\n` +
    `  a color-mix() token count as a palette colour without this script doing colour arithmetic.\n` +
    `  A variable that appears there and not in @theme breaks that reading: it would enrol its own\n` +
    `  colour into the palette, and the census in theme-contrast.test.ts, which reads @theme, would\n` +
    `  never ask anyone to measure it.\n`,
)
for (const decl of rootPalette) {
  for (const token of colourTokens(decl.value)) {
    const c = rgbaOf(token)
    if (c) palette.add(rgbKey(c))
  }
}

assert.ok(
  palette.size > 20,
  `the palette resolved to only ${String(palette.size)} distinct colours, from ${String(themeNames.size)} ` +
    `tokens. Something in the resolver stopped resolving; a short palette turns every colour in the ` +
    `artifact into an offender, and the temptation then is to shorten the assertion instead.`,
)

/**
 * Every colour the artifact paints with, and whether the palette accounts for it.
 *
 * Three structural passes, in this order:
 *
 *  1. `currentcolor` is not a colour, it is a reference to whatever colour the
 *     element already has — which came from a property audited on its own terms.
 *  2. Alpha zero is not a colour either. `transparent`, `#0000` and Tailwind's
 *     `0 0 #0000` shadow seeds all reduce to it, and nothing invisible can fail
 *     a contrast floor.
 *  3. Otherwise the three channels must be a palette colour's three channels.
 *
 * Then, and only then, the named list. One entry today.
 */
const exemptions = new Map(TAILWIND_INTERNALS.map((e) => [`${e.site} ${e.colour}`, e]))
const exemptionsUsed = new Set()
const strays = []
let colourCount = 0

for (const decl of artifactDecls) {
  // For an `@property --x { initial-value: … }` the site is `--x`: the value and
  // the reset that seeds the same variable are two halves of one declaration,
  // and an exemption should not have to be written twice.
  const atProperty = /^@property\s+(--[\w-]+)/.exec(decl.selector)
  const site = atProperty ? atProperty[1] : decl.property
  for (const token of colourTokens(decl.value)) {
    colourCount += 1
    const lower = token.toLowerCase()
    if (lower === 'currentcolor') continue
    const c = rgbaOf(token)
    if (c && c.a === 0) continue
    if (c && palette.has(rgbKey(c))) continue
    const key = `${site} ${lower}`
    if (exemptions.has(key)) {
      exemptionsUsed.add(key)
      continue
    }
    strays.push(`${decl.sheet}: ${decl.selector} { ${decl.property}: … ${token} … }`)
  }
}

assert.ok(
  colourCount > 40,
  `only ${String(colourCount)} colour values found across ${String(artifactDecls.length)} shipped ` +
    `declarations. The palette alone accounts for more than forty; the colour reader has stopped ` +
    `reading, which is the one failure this assertion exists to make loud.`,
)

assert.deepEqual(
  [...new Set(strays)].sort(),
  [],
  `${String(new Set(strays).size)} colour(s) ship in the stylesheet that no @theme token accounts for:\n` +
    [...new Set(strays)]
      .sort()
      .map((s) => `    ${s}`)
      .join('\n') +
    `\n\n` +
    `  The source-level sweep in theme-contrast.test.ts reads the spelling somebody wrote. This\n` +
    `  reads what Lightning CSS emitted, which is why the spelling does not matter: \`rebeccapurple\`\n` +
    `  arrives here as #639 and \`oklch(.6 .2 20)\` as #de394b, and both were green under the source\n` +
    `  sweep for as long as it existed.\n\n` +
    `  A colour is accounted for when its three channels match a colour @theme declares — at any\n` +
    `  alpha, so a /18 modifier or a mix against transparent still counts — or when it is alpha\n` +
    `  zero, or \`currentcolor\`.\n\n` +
    `  Two ways out:\n` +
    `    1. Name it in the @theme block and point the rule at the token. That is the answer almost\n` +
    `       every time, and it is what puts the colour in front of the contrast census. If it is a\n` +
    `       tint of a colour that already has a name, a color-mix against it says so and keeps\n` +
    `       following it.\n` +
    `    2. If it is a value this codebase does not author — something Tailwind seeds into its own\n` +
    `       --tw-* namespace — add it to TAILWIND_INTERNALS above, with the site, the exact value,\n` +
    `       and a sentence on why no pixel it reaches needs a token. That list is one entry long\n` +
    `       and should stay close to it.\n`,
)

const staleExemptions = [...exemptions.keys()].filter((k) => !exemptionsUsed.has(k)).sort()
assert.deepEqual(
  staleExemptions,
  [],
  `${String(staleExemptions.length)} entr(ies) on TAILWIND_INTERNALS excuse a colour the artifact no ` +
    `longer ships:\n` +
    staleExemptions.map((k) => `    ${k.replace(' ', ': ')}`).join('\n') +
    `\n\n` +
    `  A list of exceptions that outlives the thing it excepts is how a palette gets reported as\n` +
    `  fully audited by a check that stopped looking — the same reason the contrast census counts\n` +
    `  from what it measured rather than from a list of names. Delete the entry.\n`,
)

const bytes = sheets.reduce((n, s) => n + Buffer.byteLength(s.css), 0)
process.stdout.write(
  `audit-shipped-css: ${String(shipped.size)} class rules in ${String(sheets.length)} stylesheet(s), ` +
    `${String(bytes)} B — all worn (${String(Object.keys(FOREIGN_DOM).length)} exempt, ` +
    `${String(blocked.size)} blocklisted and confirmed unused); ` +
    `${String(colourCount)} colour values, all from the ${String(palette.size)}-colour palette ` +
    `(${String(exemptions.size)} exempt)\n`,
)
