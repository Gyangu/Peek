import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  attributeClassNames,
  blankComments,
  blankNonCode,
  decomment,
  scannedSources,
  stylesheets,
  tailwindCandidates,
} from './sourceScan'

/* ==================================================================
 * The theme's contrast floor, as an executable assertion.
 *
 * This file exists because the floor had already been breached once and nobody
 * could see it: the faint text weight shipped at 2.49–2.88:1 depending on the
 * layer under it, which is below the WCAG AA floor for body text (4.5) and below
 * even the large-text floor (3.0) — and it was the weight assigned to the
 * *smallest* type in the window. Nothing in the build said a word.
 *
 * A number in a design document does not hold a line; a test does. If a future
 * palette tweak dims one of these back down, this goes red with the actual
 * ratio in the message.
 *
 * The maths is WCAG 2.1 relative luminance, transcribed from the spec rather
 * than pulled from a package — it is nine lines, and a dependency whose job is
 * nine lines of arithmetic is a dependency to audit forever.
 *
 * ## What the Tailwind migration changed here, and what it did not
 *
 * The tokens moved from `styles.css`'s `:root` into an `@theme` block, and
 * gained the `--color-` prefix Tailwind's namespace requires. They spent one day
 * in a `theme.css` of their own; the eight sheets are one `styles.css` again
 * (migration record §11.1), so the block sits where the `:root` did. That is the
 * whole change to the arithmetic: **the nine lines below are byte-identical**,
 * and every ratio threshold (4.5 / 3.0 / 1.45) is the number it was.
 *
 * What did change is the *surface*. A colour can now escape the palette without
 * appearing in any stylesheet at all — a bracketed hex in a JSX attribute is the
 * 2026-08-02 story told again in a file this test had never opened. The section
 * on arbitrary values, and the alpha census after it, are the answer to that.
 *
 * The other thing the migration changed is the *size* of the palette: fifteen
 * colours became thirty-two, and not one assertion was added. Reading the list
 * of test names in this file is the fastest way to be misled about what it
 * covers — so the count is now itself an assertion, at the foot of the file.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.2 and
 * docs/design/2026-08-04-tailwind-migration.md §3.1, §3.4, §10.
 * ================================================================== */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The renderer's one stylesheet. Eight of them were merged into it; §11.1. */
const SHEET = 'styles.css'

const THEME = readFileSync(join(RENDERER, SHEET), 'utf8')

/**
 * Where the `@theme` block starts and ends in `THEME`, as offsets.
 *
 * Used twice: to read the palette, and — below — to tell a colour literal that
 * *is* the palette from one written into a rule. That distinction used to be
 * "which file is this", which stopped being a question the day there was one
 * file. Offsets rather than a filename keep the exemption exactly as narrow as
 * it was: the block, and nothing else in the sheet.
 */
const THEME_BLOCK = ((): { start: number; end: number } => {
  const m = /@theme\s*\{([\s\S]*?)\n\}/.exec(THEME)
  assert.ok(m, `${SHEET} must contain an @theme block`)
  return { start: m.index, end: m.index + m[0].length }
})()

/** The `@theme` block's custom properties, as a plain map. */
function themeVars(css: string): Map<string, string> {
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(block, `${SHEET} must contain an @theme block`)
  const vars = new Map<string, string>()
  for (const line of block[1].split('\n')) {
    const decl = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (decl) vars.set(decl[1], decl[2].trim())
  }
  return vars
}

const VARS = themeVars(THEME)

/*
 * What used to stand here: an assertion that `--color-*`, `--text-*` and
 * `--font-*` were each reset to `initial`, emptying Tailwind's namespaces so
 * that the palette was a closed set of thirty-eight and this file could claim to
 * audit all of it. Those three lines are gone on purpose (§29, §29.10) and the
 * assertion went with them.
 *
 * It is replaced rather than deleted, because the *property* it protected is
 * still wanted; only the mechanism changed, from prevention to detection, and
 * the detection turns out to live in two places rather than none:
 *
 *  1. **Here, at the source.** A Tailwind default colour class written anywhere
 *     the scanner reads is rejected by name. That is the test below.
 *  2. **`scripts/audit-shipped-css.mjs`, at the artifact.** It already rejected
 *     any `--color-*` on the artifact's `:root` that `@theme` never declared —
 *     which is exactly what `bg-red-500` produces. That check never depended on
 *     the namespace being empty; it was simply never the one anybody cited.
 *
 * Two fences, and they fail at different moments: this one at `pnpm test` on a
 * class nobody has built yet, that one at `pnpm build` on a colour that reached
 * the stylesheet by any route at all, including ones no source scan can see.
 *
 * The migration record's §29.6 said the closed-set guarantee would be lost
 * outright. That was written before either fence was looked at, and it was too
 * pessimistic by one and a half fences; §29.10.4 corrects it. What is genuinely
 * lost is narrower and is recorded there.
 */

/**
 * Tailwind's own colour names, read from its theme rather than listed.
 *
 * `--color-red-500` → `red-500`. The two keyword colours (`black`, `white`) come
 * along in the same sweep and are wanted: a `bg-white` in this window is exactly
 * as unaudited as a `bg-red-500`, and rather more likely to be typed.
 */
const TAILWIND_COLOURS = new Set(
  [
    ...readFileSync(fileURLToPath(import.meta.resolve('tailwindcss/theme.css')), 'utf8').matchAll(
      /^\s*--color-([a-z0-9-]+)\s*:/gm,
    ),
  ].map((m) => m[1]),
)

/**
 * The utility families that take a colour.
 *
 * Listed rather than inferred, and the list is longer than the four this
 * codebase actually writes: `caret-`, `divide-`, `placeholder-` and the three
 * gradient stops have never appeared in `renderer/`, which is precisely why they
 * are the ones that would arrive unnoticed.
 */
const COLOUR_FAMILY = [
  'bg', 'text', 'border', 'outline', 'ring', 'inset-ring', 'shadow', 'inset-shadow',
  'fill', 'stroke', 'decoration', 'accent', 'caret', 'divide', 'placeholder',
  'from', 'via', 'to',
]

test('no Tailwind default colour is named in the renderer', () => {
  assert.ok(
    TAILWIND_COLOURS.size > 200,
    `read only ${String(TAILWIND_COLOURS.size)} colours out of Tailwind's theme; the reader is ` +
      `broken, and a broken reader here is a green suite with no check.`,
  )

  const offenders: string[] = []
  for (const file of scannedSources(RENDERER)) {
    for (const { line, name: candidate } of tailwindCandidates(
      readFileSync(join(RENDERER, file), 'utf8'),
    )) {
      // `hover:bg-red-500` is the same colour under a condition.
      const name = candidate.slice(candidate.lastIndexOf(':') + 1)
      const family = COLOUR_FAMILY.find((f) => name.startsWith(`${f}-`))
      if (family === undefined) continue
      // `bg-red-500/50` is the same colour at an opacity; the opacity is the
      // alpha census's business, the colour is this one's.
      const value = name.slice(family.length + 1).split('/')[0]
      if (!TAILWIND_COLOURS.has(value)) continue
      // Our own tokens win where the names collide. None do today — the palette
      // is `bg`, `fg-dim`, `err` … and Tailwind's is `red-500`, `zinc-100` —
      // but a token named `white` tomorrow should read as ours, not as theirs.
      if (VARS.has(`--color-${value}`)) continue
      offenders.push(`${file}:${String(line)} → ${candidate}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${String(offenders.length)} site(s) name a colour out of Tailwind's default palette:\n` +
      offenders.map((o) => `    ${o}`).join('\n') +
      `\n\n` +
      `  Those 288 colours compile now — the \`--color-*: initial\` reset that used to make them\n` +
      `  generate nothing is gone (§29.10). They are real, they paint, and no assertion in this\n` +
      `  file has ever measured one against anything. Use a semantic token from @theme in\n` +
      `  ${SHEET}; there are ${String([...VARS.keys()].filter((k) => k.startsWith('--color-')).length)} of them and each one is under the census at the foot of this file.\n` +
      `\n` +
      `  If the colour genuinely does not exist in the palette, add it there — that is the step\n` +
      `  that puts it in front of the contrast floor, and it is the whole point of the detour.\n`,
  )
})

/*
 * Every token some assertion in this file actually resolved, recorded as it is
 * read rather than listed by hand.
 *
 * This is what the coverage test at the foot of the file reads, and recording
 * beats a list for one reason: a list can go on naming a colour after the
 * assertion that named it has been deleted. Coverage then reports a palette
 * fully audited by a test that no longer exists — the same shape of vacuous
 * pass as every hole this file was written to close.
 */
const MEASURED = new Set<string>()

/**
 * A colour from `@theme`, as sRGB.
 *
 * Resolves `var()` and `color-mix(in srgb, …)` as well as a plain hex, and the
 * mixes are not a convenience: six of the palette's colours — the hover and
 * press surfaces of `primary`, `danger` and `caution` — are *only* expressible
 * as mixes, because a derived state should visibly follow the colour it derives
 * from (theme.css says so where they are defined). Before this, `colorOf`
 * rejected anything that was not a six-digit hex, so those six could not be
 * measured at all: the six surfaces a control moves through under the pointer
 * were outside the contrast audit by construction, and the note in theme.css
 * claiming they were named so that "theme-contrast.test.ts can see them" was
 * describing an intention rather than a fact.
 *
 * `in srgb` interpolates the gamma-encoded channels, which is a straight lerp of
 * the 0–255 values — not the linear-light ones the luminance formula below uses.
 * The two spaces are easy to conflate and the mistake is invisible: it lands a
 * few points off rather than obviously wrong. Checked against Chromium's own
 * `color-mix` output, not derived from the spec alone.
 *
 * Alpha is deliberately not supported. `#0009` has no contrast ratio until it
 * lands on something, so a token carrying one cannot be an ink or a surface;
 * it is a scrim, and a scrim is answered on DECORATIVE_ONLY with a sentence.
 */
function colorOf(name: string): [number, number, number] {
  MEASURED.add(name)
  const raw = VARS.get(name)
  assert.ok(raw, `${name} is not defined in @theme`)
  return resolveColor(raw, name, 0)
}

function resolveColor(raw: string, name: string, depth: number): [number, number, number] {
  const text = raw.trim()
  assert.ok(depth < 8, `${name} resolves through more than eight indirections; @theme has a cycle`)

  // Three digits and six, which are the two opaque forms. Four and eight carry
  // an alpha channel and fall through to the failure below on purpose.
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    const n = Number.parseInt(digits, 16)
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  }

  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(text)
  if (ref) {
    const inner = VARS.get(ref[1])
    assert.ok(inner, `${name} is built from ${ref[1]}, which @theme does not define`)
    return resolveColor(inner, ref[1], depth + 1)
  }

  const mix = /^color-mix\(\s*in\s+srgb\s*,(.+)\)$/i.exec(text)
  if (mix) {
    const parts = splitTopLevel(mix[1])
    assert.equal(parts.length, 2, `${name}: this test only reads two-colour mixes, got ${text}`)
    const terms = parts.map((part) => {
      const m = /^\s*(.*?)(?:\s+([\d.]+)%)?\s*$/.exec(part)
      assert.ok(m, `${name}: cannot read \`${part}\` as a colour and a percentage`)
      return { color: m[1], weight: m[2] === undefined ? null : Number(m[2]) / 100 }
    })
    // CSS fills in the missing side rather than defaulting it to a half: one
    // stated percentage decides both. Getting this wrong would silently measure
    // a 50/50 blend of two colours that ship at 86/14.
    const [a, b] = terms
    if (a.weight === null && b.weight === null) {
      a.weight = 0.5
      b.weight = 0.5
    } else if (a.weight === null) a.weight = 1 - (b.weight ?? 0)
    else if (b.weight === null) b.weight = 1 - a.weight
    const total = (a.weight ?? 0) + (b.weight ?? 0)
    assert.ok(total > 0, `${name}: the two percentages in the mix sum to nothing`)
    const ca = resolveColor(a.color, name, depth + 1)
    const cb = resolveColor(b.color, name, depth + 1)
    return [0, 1, 2].map((i) => (ca[i] * (a.weight ?? 0) + cb[i] * (b.weight ?? 0)) / total) as [
      number,
      number,
      number,
    ]
  }

  return assert.fail(
    `${name} is \`${text}\`, which this test cannot turn into a colour. It reads an opaque hex ` +
      `(three digits or six), a \`var()\` naming another token, and \`color-mix(in srgb, …)\`. ` +
      `Anything else — an ` +
      `alpha channel, another interpolation space, a gradient — is a value whose contrast ` +
      `depends on what it lands on, so it cannot be an ink or a surface here. Either give it a ` +
      `form this can read, or put it on DECORATIVE_ONLY with the sentence saying no text is ` +
      `ever drawn on it.`,
  )
}

/** Split on commas that are not inside parentheses. `color-mix` nests `var()`. */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** WCAG 2.1 relative luminance. */
function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(colorOf(a)), luminance(colorOf(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function assertAtLeast(fg: string, bg: string, min: number): void {
  const ratio = contrast(fg, bg)
  assert.ok(
    ratio >= min,
    `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min.toFixed(1)}:1`,
  )
}

/* ------------------------------------------------------------------ */

describe('text contrast', () => {
  /*
   * The three surfaces text actually lands on. --color-bg-3 is deliberately
   * absent: it is a hover/emphasis layer, and the only text drawn on it is
   * --color-fg or --color-fg-dim, both of which clear 4.5 there with room to
   * spare. Adding it would pin --color-fg-faint to a combination that has no
   * instance in the product.
   */
  const LAYERS = ['--color-bg', '--color-bg-1', '--color-bg-2'] as const

  for (const weight of ['--color-fg', '--color-fg-dim', '--color-fg-faint'] as const) {
    test(`${weight} clears AA on every background layer`, () => {
      for (const layer of LAYERS) assertAtLeast(weight, layer, 4.5)
    })
  }

  test('the three weights stay in order and stay apart', () => {
    // A ladder whose rungs are 0.3 apart is one weight wearing three names.
    const ratios = (['--color-fg', '--color-fg-dim', '--color-fg-faint'] as const).map((w) =>
      contrast(w, '--color-bg-1'),
    )
    assert.ok(ratios[0] > ratios[1], '--color-fg must read stronger than --color-fg-dim')
    assert.ok(ratios[1] > ratios[2], '--color-fg-dim must read stronger than --color-fg-faint')
    assert.ok(ratios[0] - ratios[1] >= 1.5, 'fg and fg-dim are too close to tell apart')
    assert.ok(ratios[1] - ratios[2] >= 1.5, 'fg-dim and fg-faint are too close to tell apart')
  })

  test('semantic colours are readable on the surfaces they appear on', () => {
    for (const c of ['--color-accent', '--color-ok', '--color-warn', '--color-err'] as const) {
      assertAtLeast(c, '--color-bg-1', 4.5)
    }
  })
})

describe('non-text contrast', () => {
  test('--color-border-strong clears 3:1, because it outlines real controls', () => {
    // WCAG 1.4.11: the boundary of a control has to be distinguishable. This is
    // the variable on inputs, buttons and selects — at its old value (1.62 on
    // --color-bg-1) a text field was a rumour.
    // All three layers: a segmented control sits on --color-bg-2 inside the
    // settings dialog, an input on --color-bg inside a modal, a button on
    // --color-bg-1 in a toolbar.
    assertAtLeast('--color-border-strong', '--color-bg', 3)
    assertAtLeast('--color-border-strong', '--color-bg-1', 3)
    assertAtLeast('--color-border-strong', '--color-bg-2', 3)
  })

  test('--color-danger-border clears 3:1 too, and is the only red border in the codebase', () => {
    // Same clause, same reasoning as --color-border-strong: it outlines a control.
    //
    // This assertion exists because of a specific escape. Three rules
    // (.confirm-danger, .chat-perm-reject, .chat-stop) each hard-coded #7a3f3f,
    // which measures 1.91:1 on --color-bg-2 — under two thirds of the floor the
    // theme had already committed to. It was never caught because this test reads
    // the token block, and a literal inside a rule is somewhere it structurally
    // cannot look. The token is the fix; the sweep in `nothing paints with a
    // literal colour` is what keeps the literal from coming back. That sweep
    // used to live inside this test, which is how it ended up only looking at
    // borders — see the note above it.
    assertAtLeast('--color-danger-border', '--color-bg', 3)
    assertAtLeast('--color-danger-border', '--color-bg-1', 3)
    assertAtLeast('--color-danger-border', '--color-bg-2', 3)
  })

  test('--color-err-border groups an error block without pretending to be a control', () => {
    // Found by the literal sweep: #5c2f2f appeared three times, and two of
    // those rules (.view-error, .chat-msg-error) were the same error box
    // declared twice in two stylesheets. It is decoration — the `--color-err`
    // text inside is what carries the meaning — so it answers to
    // --color-border's 1.45, not to 3:1, and only on the two layers an error
    // block actually lands on.
    const onBg = contrast('--color-err-border', '--color-bg')
    const onPanel = contrast('--color-err-border', '--color-bg-1')
    assert.ok(onBg >= 1.45, `--color-err-border on --color-bg is ${onBg.toFixed(2)}:1, too faint to bound anything`)
    assert.ok(
      onPanel >= 1.45,
      `--color-err-border on --color-bg-1 is ${onPanel.toFixed(2)}:1, too faint to bound anything`,
    )
    assert.ok(
      contrast('--color-err', '--color-err-bg') >= 4.5,
      'the text inside an error block is what carries the meaning; it has to clear AA on that block',
    )
  })

  test('--color-border stays decorative, and stays visible', () => {
    // Grid lines and panel outlines group things; they do not announce anything
    // interactive, so 3:1 is not required. But 1.32 (the old value) was close
    // enough to invisible that a table read as one undivided field.
    const ratio = contrast('--color-border', '--color-bg')
    assert.ok(ratio >= 1.45, `--color-border on --color-bg is ${ratio.toFixed(2)}:1, too faint to divide anything`)
    assert.ok(
      ratio < 3,
      '--color-border has drifted into --color-border-strong territory; one of them is redundant',
    )
  })
})

/* ==================================================================
 * The literal, the first way past this test — and the one that was still open.
 *
 * A colour written into a rule instead of into `@theme` is invisible here: this
 * file audits the token block, and there is nowhere in it to see a hex sitting
 * in a declaration. That is how `#7a3f3f` shipped at 1.91:1 on three separate
 * controls, and the sweep below was written the day it was found.
 *
 * It was written *inside* the `--color-danger-border` test, and it inherited
 * that test's subject: it matched `border*` and `outline*` and nothing else. So
 * for as long as it has existed, `background: #7a3f3f` and `color: #7a3f3f` in
 * any of the renderer's stylesheets were green — the same value, the same
 * failure, one property over. The file even said so, in a "known holes" note
 * that named this as hole number two and then left it open through a whole
 * migration.
 *
 * The fix is not a longer list of properties. **A property list is what caused
 * this**, and the next hole would be whichever family the list forgot —
 * `box-shadow` was already one, and it was already holding two shadow values
 * nothing in the theme knew about. So the rule is about the *value*, not the
 * property: a colour literal may appear in exactly one place, the `@theme`
 * block, and nowhere else in any stylesheet under `renderer/`.
 *
 * "The `@theme` block" used to be spelled "the file called theme.css", which was
 * the same statement while there were eight sheets. There is one now (§11.1), so
 * a filename would have exempted every rule in the product. The exemption is by
 * *offset* into the sheet instead — see THEME_BLOCK — which is what it always
 * meant and is the only spelling that stays narrow.
 *
 * What it found when it stopped watching borders, all of them real and all of
 * them now tokens: a zebra stripe with grid text on it, the two hues that mark
 * a boolean and a JSON cell (body text, at --text-data, entirely unaudited),
 * the modal scrim, the modal's shadow, the drag ghost's shadow, and the editor's
 * active-line tint.
 *
 * ## The half of that lesson this sweep had not learned
 *
 * The subject of the rule became the value. **The reader stayed a list of
 * spellings** — `#hex`, `rgb(`, `hsl(` — and CSS has a dozen more. `color:
 * rebeccapurple` on a rule with four live wearers ships as `.empty-hint{color:
 * #639}`: the build exits 0, the whole renderer suite is green, and the source
 * says a word this pattern does not know. `oklch(.6 .2 20)` ships as `#de394b`,
 * identically green. Lightning CSS down-converts on the way out, so the artifact
 * held exactly the shape this sweep was written to catch and this sweep could
 * not see it, because it was reading the source spelling.
 *
 * The pattern below is therefore as wide as CSS colour syntax gets: the hex
 * forms, every functional notation including the modern ones, and all 147 named
 * colours. That is worth doing — it costs a list and it fires in `pnpm test`,
 * with no build — but it must be understood for what it is: **a list of
 * spellings can only ever be as long as somebody remembered.** The fence that
 * does not depend on remembering is in `scripts/audit-shipped-css.mjs`, which
 * reads the built stylesheet, where Lightning CSS has already reduced every
 * spelling to a hex, and requires each colour's channels to be a colour `@theme`
 * declares.
 *
 * ## The third reader, and the channel that outranked both of the others
 *
 * Those two readers were described here as "deliberately two, and neither
 * redundant", and that was true of the pair and wrong about the coverage. Both
 * of them read a **stylesheet**: this one walks `stylesheets()`, which is `.css`
 * and only `.css`, and the artifact one reads the built `.css`. A colour written
 * into a React inline `style` object is in neither. It never enters a stylesheet
 * at any stage — it rides in the JS bundle and is applied by the DOM at runtime,
 * where it outranks every rule in the sheet by construction.
 *
 * Demonstrated rather than reasoned about, in the shape this file was founded
 * on: `#7a3f3f` — the 1.91:1 colour the whole section above exists because of —
 * and `oklch(0.6 0.2 20)` were both planted in inline `style` objects on live
 * elements. Every gate stayed green, the built stylesheet came back **byte
 * identical**, and both strings were then found intact in the shipped JS. There
 * are thirteen files in the renderer writing an inline style object today.
 *
 * So there are three readers, each reading a channel the other two cannot:
 *
 *   - **the stylesheet sweep** — states the *authoring* rule for the sheet,
 *     names the file and line, and runs on sources alone, so a colour written
 *     this morning is red before anybody builds;
 *   - **the source sweep below it** — the same authoring rule for `.ts`/`.tsx`,
 *     because an inline style is a declaration that never becomes CSS text;
 *   - **`scripts/audit-shipped-css.mjs`** — states the *shipping* rule, and is
 *     the one that holds when the spelling is one nobody listed, or when the
 *     colour never appears in a stylesheet at all (`.shadow` carried `#0000001a`
 *     into the artifact out of four comments containing an English word).
 *
 * The cost of three readers is three things to keep in step. It is paid once,
 * here: no one of them is a superset of another, and none is redundant.
 * ================================================================== */

/**
 * The 147 CSS named colours, plus `rebeccapurple`. Data, not logic.
 *
 * `transparent` and `currentcolor` are deliberately absent. Neither is a
 * literal: one is the absence of colour, the other a reference to one the
 * cascade already decided, and both are in the sheet today doing exactly the job
 * they should.
 *
 * System colour keywords (`Canvas`, `ButtonText`, `AccentColor`, …) are absent
 * too, and that one is a judgement rather than a definition. They are not
 * literals either — they name a colour the platform picks — but they *would*
 * paint an unaudited colour, so leaving them out leaves a gap. They are out
 * because the words collide with ordinary CSS and ordinary English (`Menu`,
 * `Mark`, `Field`, `Highlight`) hard enough that matching them here would cost
 * false alarms in a sweep whose whole value is that it never has any. Nothing in
 * this window uses one; if something ever does, the artifact reader is where it
 * gets caught, and it will not be by spelling.
 */
const NAMED_COLOURS =
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
   burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
   darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
   darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
   ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
   lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
   lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
   mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
   mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
   orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
   pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
   seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan
   teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .split(/\s+/)
    .filter(Boolean)

/**
 * Every way CSS can spell a colour, minus the two that are not colours.
 *
 * Three alternatives. The hex forms; the functional notations, which include the
 * ones added since this sweep was written (`oklch`, `oklab`, `lab`, `lch`,
 * `hwb`, `color`, `light-dark`) and are the half that was open; and the named
 * colours, longest first so that `darkred` is not read as `dark` + `red`.
 *
 * Two things the function alternative does *not* match, both on purpose:
 * `color-mix()` and `var()`, because both are built out of tokens and that is
 * the thing being asked for. `\bcolor\s*\(` does not match `color-mix(` — a
 * hyphen is not a paren — and it does not match `background-color:` either.
 *
 * The named alternative is fenced on both sides. A colour name may not be
 * preceded by a word character, `.`, `#` or `-`, and may not be followed by a
 * word character, `-` or `(`: that is what keeps `.plum-badge` out of it, and
 * what keeps `tan(1rad)` from reading as the colour `tan` — a colour name is
 * never a function name, so nothing is lost.
 */
const COLOUR_LITERAL = new RegExp(
  [
    '#[0-9a-f]{3,8}\\b',
    '\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark|device-cmyk)\\s*\\(',
    `(?<![\\w.#-])(?:${[...NAMED_COLOURS].sort((a, b) => b.length - a.length).join('|')})(?![\\w\\-(])`,
  ].join('|'),
  'gi',
)

describe('nothing paints with a literal colour', () => {
  test('every colour in every stylesheet comes from @theme', () => {
    const literals: string[] = []
    for (const sheet of stylesheets(RENDERER)) {
      const css = decomment(readFileSync(join(RENDERER, sheet), 'utf8'))
      for (const m of css.matchAll(COLOUR_LITERAL)) {
        // Back to the start of the declaration this sits in. Line-based
        // matching would miss a literal on the continuation line of a
        // multi-line value, and would have to be told about every property
        // name — which is the mistake being undone here.
        const start =
          Math.max(css.lastIndexOf(';', m.index), css.lastIndexOf('{', m.index), css.lastIndexOf('}', m.index)) + 1
        const decl = css.slice(start, m.index)
        const colon = decl.indexOf(':')
        // No colon in front of it: an `#abc` id selector, not a value.
        if (colon === -1) continue
        const property = decl.slice(0, colon).trim()
        // The one exemption, and it is the whole point of the rule rather than a
        // hole in it: `--color-bg: #16181c` inside `@theme` *is* the palette. The
        // same line anywhere else is a second palette, so it is only allowed
        // there — bounded by the block's offsets, not by a filename, because
        // there is only one file now and its name would exempt everything.
        // `decomment` preserves length, so an offset into it indexes THEME too.
        if (
          sheet === SHEET &&
          property.startsWith('--') &&
          m.index >= THEME_BLOCK.start &&
          m.index < THEME_BLOCK.end
        ) {
          continue
        }
        const line = css.slice(0, m.index).split('\n').length
        literals.push(`${sheet.replace(/\\/g, '/')}:${String(line)} → ${property}: ${m[0]}`)
      }
    }

    assert.deepEqual(
      literals,
      [],
      `A colour written as a literal cannot be audited by this file, which reads @theme and only ` +
        `@theme — that is exactly how #7a3f3f survived at 1.91:1 on three controls:\n` +
        `${literals.join('\n')}\n\n` +
        `Give it a name in the @theme block and point the rule at it. If it is a tint of a colour that ` +
        `already has a name, a color-mix against transparent says so and keeps following it. If ` +
        `nothing reads text on it, it still needs the name — and then a line on DECORATIVE_ONLY ` +
        `saying nothing ever will.`,
    )
  })

  /* ------------------------------------------------------------------
   * The same rule, one channel over: a colour in an inline `style`.
   *
   * `style={{ background: '#7a3f3f' }}` is a CSS declaration that never becomes
   * CSS text. It is not in `stylesheets()`, because that walks `.css`. It is not
   * in the artifact stylesheet either — planting one leaves `out/renderer/
   * assets/*.css` byte for byte identical — because it is compiled into the JS
   * bundle and applied to `element.style` at runtime, which is where it outranks
   * every rule in the sheet including `!important` ones on other selectors. Both
   * of this file's colour readers are structurally incapable of seeing it, and so
   * is the build's.
   *
   * ## Why the whole file, and not just the style objects
   *
   * Matching `style={{ … }}` and reading inside it would be a reader keyed on a
   * *syntax*, which is the mistake §10.2 named and undid: a property list caused
   * the border hole, and a spelling list caused the `rebeccapurple` hole. A
   * colour handed to a `<canvas>` context, written into a CSS custom property
   * with `setProperty`, passed to a charting call, or posted into the plugin
   * iframe is the same failure with no `style={{` anywhere near it. So the
   * subject stays the *value*: **no colour literal anywhere in the renderer's
   * own `.ts` / `.tsx`.** On a clean tree that is zero matches across all 154 of
   * them, so the wide reading costs nothing and no exemption list is needed yet.
   * If one ever is, it goes on a named list with a written reason, next to
   * ALPHA_SITES and DECORATIVE_ONLY, and not by narrowing this.
   *
   * The file set is `scannedSources` — the same discovery the arbitrary-value
   * ban uses, so a directory move breaks both at once and loudly — narrowed to
   * `.ts` and `.tsx`. `.css` is already the sweep above. `ui/CLAUDE.md` is
   * dropped, and that is the one place the two bans genuinely differ: a class
   * name in that guide compiles into the stylesheet, which is why the ban reads
   * it, and a hex in it paints nothing at all.
   *
   * ## Comments are blanked here, and are *not* in the arbitrary-value ban
   *
   * The two look inconsistent and are not. A class name in a comment compiles —
   * Tailwind reads raw bytes, and prose in this repo has minted real rules four
   * times — so that ban must read comments. Nothing anywhere harvests a hex out
   * of a comment; a colour in prose paints nothing. Reading them here would only
   * ban writing `#7a3f3f` in the sentence explaining why `#7a3f3f` was removed,
   * which is how a fence gets switched off.
   *
   * ## Where this reader stops, said plainly rather than implied
   *
   * It reads literals in source text. It cannot see:
   *
   *   - a colour computed at runtime — `` `hsl(${h} 50% 40%)` `` is caught by
   *     the pattern, but `'#' + hex`, `String.fromCharCode`, or a channel
   *     arithmetic function is not;
   *   - a colour that arrives as a value — imported from a package, read from a
   *     driver's response, sent by a plugin, or typed by the user;
   *   - a colour with no literal anywhere, which is the sharpest case and the
   *     one this round was opened by: `accent-color: auto` under an unset
   *     `color-scheme` had Chromium painting rgb(1, 117, 255) at 4.18:1 on nine
   *     controls, written down in no stylesheet, no class string and no bundle.
   *
   * All three are downstream of every text channel, so the fence that covers
   * them has to read what the browser computed rather than what anybody wrote.
   * That fence is being built separately; this one deliberately does not claim
   * its ground.
   * ------------------------------------------------------------------ */
  test('every colour in every component comes from @theme as well', () => {
    const sources = scannedSources(RENDERER).filter((rel) => /\.tsx?$/.test(rel))

    const literals: string[] = []
    let inlineStyleFiles = 0
    for (const rel of sources) {
      const raw = readFileSync(join(RENDERER, rel), 'utf8')
      const src = blankComments(raw)
      if (src.includes('style={{')) inlineStyleFiles += 1
      for (const m of src.matchAll(COLOUR_LITERAL)) {
        const line = src.slice(0, m.index).split('\n').length
        literals.push(`${rel.replace(/\\/g, '/')}:${String(line)} → ${m[0]}`)
      }
    }

    assert.deepEqual(
      literals,
      [],
      `A colour literal in a component is the escape neither stylesheet reader can reach: an inline ` +
        `\`style\` never becomes CSS text, so it is absent from \`stylesheets()\` and absent from the ` +
        `built artifact, and at runtime it outranks the sheet:\n${literals.join('\n')}\n\n` +
        `Give it a name in the @theme block and reach it as a utility class, or — if it genuinely ` +
        `has to be an inline style — as \`var(--color-…)\`, which keeps it following the palette. A ` +
        `value that has no business being a token at all is a case for a named exemption list with a ` +
        `sentence on it, the way ALPHA_SITES and DECORATIVE_ONLY work; it is not a case for making ` +
        `this reader narrower.`,
    )

    /*
     * Two aperture guards, because "no offenders" and "read nothing" are the
     * same output. `scannedSources` carries its own; these two say the walk
     * still reaches components at all, and that it still reaches the specific
     * channel this reader was written for. Thirteen files write an inline style
     * object today, so the floor is set well under that: it is here to catch a
     * scan that has stopped reading, not to freeze a count.
     */
    assert.ok(
      sources.length > 40,
      `the source colour sweep found only ${String(sources.length)} .ts/.tsx files under the ` +
        `renderer. It has stopped reading the source, and this rule is now an assertion about nothing.`,
    )
    assert.ok(
      inlineStyleFiles >= 5,
      `only ${String(inlineStyleFiles)} of the ${String(sources.length)} scanned files contain an ` +
        `inline style object, and thirteen did when this was written. Either the channel this reader ` +
        `exists for has been closed — in which case say so here — or the scan is no longer seeing it.`,
    )
  })

  test('the source sweep sees the shapes an inline style can carry', () => {
    /*
     * Testing the test, the same way the arbitrary-value ban does. The first two
     * are the exact pair that was planted on live elements and shipped with
     * every gate green and the artifact byte-identical; the third is the
     * spelling §20.5 found the stylesheet reader missing, restated in the
     * channel that has no stylesheet at all.
     */
    const found = (src: string): string[] => [...blankComments(src).matchAll(COLOUR_LITERAL)].map((m) => m[0])

    assert.deepEqual(
      found("<div style={{ background: '#7a3f3f' }} />"),
      ['#7a3f3f'],
      'the colour this whole file was written about, in the one place neither stylesheet reader looks',
    )
    assert.deepEqual(
      found("<div style={{ color: 'oklch(0.6 0.2 20)' }} />"),
      ['oklch('],
      'a modern colour function: no hex, no rgb, and it never reaches a stylesheet to be down-converted',
    )
    assert.deepEqual(
      found("const S = { borderColor: 'rebeccapurple' }"),
      ['rebeccapurple'],
      'a named colour in a plain object, which is not JSX and carries no style attribute at all',
    )
    assert.deepEqual(
      found('el.style.setProperty("--color-bg", "#123456")'),
      ['#123456'],
      'a custom property written at runtime mints a palette entry the census has never resolved',
    )

    assert.deepEqual(
      found('// the #7a3f3f here was replaced by --color-danger-border'),
      [],
      'a colour in prose paints nothing, so blanking comments here is not the hole it is in the class ban',
    )
    assert.deepEqual(
      found('const w = Math.tan(a) * scale; const rows = data.red; const p = "plum-badge"'),
      [],
      'a colour name is never a function name, a property access, or the head of a hyphenated word',
    )
    assert.deepEqual(
      found('const id = "#root"; const n = 0x16181c; const v = "var(--color-accent)"'),
      [],
      'and it still says no when there is no colour there — including a token, which is the answer',
    )
  })

  test('the sweep still reads the stylesheets it is pointed at', () => {
    // `stylesheets()` carries its own non-empty guard, so this is the other
    // half: a sweep that matches nothing anywhere reports no offenders, and
    // from the assertion above that is indistinguishable from a clean tree.
    // The @theme block is the one region guaranteed to be full of colour
    // literals; slicing it out is also a check that THEME_BLOCK found something.
    const theme = decomment(THEME).slice(THEME_BLOCK.start, THEME_BLOCK.end)
    assert.ok(
      [...theme.matchAll(COLOUR_LITERAL)].length > 20,
      'the literal pattern no longer matches the palette itself; it has stopped matching colours',
    )
  })
})

/* ==================================================================
 * All forty-four of them, or none of them.
 *
 * Forty-four, and it said thirty-six until the census below stopped counting
 * the `--color-` namespace and started counting colours. Thirty-eight tokens
 * are named like colours; six more paint and are not — the five box shadows,
 * each carrying a black nothing had ever measured, and the accent rule down the
 * selected row's gutter, which borrows its colour from a token that is
 * measured. The five are on DECORATIVE_ONLY at the foot of this table with the
 * sentence each of them always needed; the sixth needs none, and the census
 * says why.
 *
 * Everything above audits fifteen colours. The palette held thirty-two when
 * this was written, and the other seventeen were named by no assertion in this
 * file at all — including the four that colour every SQL and JSON block in the
 * chat panel, the ink on the one badge in the window with text on a solid
 * semantic fill, and the six surfaces a control moves through under the
 * pointer. (Thirty-six now: the literal sweep one section up named four more
 * colours that had been shipping all along without one.)
 *
 * The header of this file used to say the closed palette "is what makes every
 * assertion below mean something", and that was true and was being read as more
 * than it says. The reset guaranteed there was no thirty-seventh colour. It
 * guaranteed nothing whatsoever about the thirty-six — and the
 * demonstration is cheap: change --color-code-string from #c3e88d (12.13:1) to
 * #1d2126 (1.03:1 on the block it is drawn on, i.e. literally invisible) and
 * this suite stayed green, because no line in it had ever mentioned that token.
 *
 * So: a colour in `@theme` is either measured against something it is actually
 * drawn on or with, or it is on DECORATIVE_ONLY with a sentence saying why
 * nothing is ever read on it. The same demand ALPHA_SITES makes one section
 * down, and for the same reason — **being outside the audit has to be a
 * sentence somebody wrote, not an accident of nobody looking.**
 *
 * The three tables:
 *
 *   SURFACES        — pairs that clear the floor. The floor is the assertion.
 *   BELOW_FLOOR     — pairs that do not. Each pins its measured ratio, so it
 *                     cannot drift further without going red, and each says
 *                     what fixing it would take. These are breaches, recorded;
 *                     they are not exemptions and the word is avoided on
 *                     purpose.
 *   DECORATIVE_ONLY — colours nothing is read on or in.
 *
 * Every combination below was traced to a real element before it was written
 * down; a table of plausible pairings would assert things the product does not
 * do, which fails in the other direction and is just as useless.
 * ================================================================== */

/*
 * 4.5:1, everywhere, with no large-text carve-out — because there is no large
 * text. WCAG's 3:1 tier starts at 18.66px, or 14px bold; the tallest rung in
 * this product is --text-lg at 13px. A pair that wanted the lower floor would
 * be asking for a font size the type scale does not have.
 */
const TEXT_FLOOR = 4.5

interface Surface {
  /** The colour underneath. */
  readonly on: string
  /** Every colour text is drawn in on top of it. */
  readonly inks: readonly string[]
  /** The element this happens on, so the next reader can check rather than trust. */
  readonly where: string
}

/*
 * A data cell can be any of five things, and **five** backgrounds can be under
 * it: the grid's own --color-bg, the zebra stripe, --color-bg-1 while the row is
 * hovered, --color-row-sel while the row is staged for the chat, and
 * --color-bg-sel on the one cell that is focused. `cellClass()` and
 * `cellSurfaceClass()` in util/format.ts decide which; both are class strings on
 * the element now rather than rules in a sheet.
 *
 * It said four until the grid's stylesheet was migrated. The fifth was a
 * `color-mix()` written inline in `components/grid.css`, which is a place this
 * file structurally cannot look — the same escape as --color-bg-stripe one round
 * earlier, and it was hiding a breach (see BELOW_FLOOR).
 *
 * NULL and a truncated value are said in the text ladder rather than in a hue —
 * an absence and a warning are not types. The two hues mark the two things the
 * text in a cell cannot say about itself.
 */
const CELL_INKS = [
  '--color-fg',
  '--color-fg-faint',
  '--color-warn',
  '--color-cell-bool',
  '--color-cell-json',
] as const

const SURFACES: readonly Surface[] = [
  {
    on: '--color-bg',
    inks: CELL_INKS,
    where: 'A grid cell at rest. The three text weights on this layer are asserted separately above.',
  },
  {
    on: '--color-bg-stripe',
    inks: CELL_INKS,
    where: 'The same cell on an odd row. 1.11:1 from --color-bg, so every ink loses about 0.5 here.',
  },
  {
    on: '--color-bg-1',
    inks: CELL_INKS,
    // A hover variant against the row rather than a descendant selector, since
    // the grid's stylesheet was migrated; same pixels, one file over.
    where: 'The same cell while its row is hovered.',
  },
  {
    on: '--color-row-sel',
    // --color-fg-faint is on BELOW_FLOOR here, for the same reason and with the
    // same shape as the --color-bg-sel entry below: a NULL cell is the faint
    // weight, and this surface is the one it does not clear.
    inks: ['--color-fg', '--color-warn', '--color-cell-bool', '--color-cell-json'],
    where:
      'Every cell of a row staged for "add these to the chat" — a quarter of --color-accent over ' +
      'the cell\'s own background, hover included, because a staged row does not move under the pointer.',
  },
  {
    on: '--color-bg-sel',
    // --color-fg-faint is missing on purpose: a NULL cell inside a selection is
    // the one combination here that does not clear the floor, and it is on
    // BELOW_FLOOR rather than quietly left out of this list.
    inks: ['--color-fg', '--color-warn', '--color-cell-bool', '--color-cell-json'],
    where:
      'The one focused cell in the grid, a selected object-tree node, and the active connection row — ' +
      'the last two carry --color-fg only.',
  },
  {
    on: '--color-bg-3',
    inks: ['--color-fg', '--color-fg-dim'],
    where:
      'The `elevated` button surface (the chat\'s jump-to-latest), the row-number bubble on the grid\'s ' +
      'hand-drawn scrollbar, the drag ghost, the selection action bar, and a focused panel\'s head — ' +
      'where an inactive tab is --color-fg-dim and the active one --color-fg.',
  },
  {
    on: '--color-bg-hover',
    // --color-fg-faint and --color-err are both under the floor here; see
    // BELOW_FLOOR. This layer is the single worst-covered surface in the
    // palette, which is what a hover state gets when nothing measures it.
    inks: ['--color-fg', '--color-fg-dim'],
    where:
      'The hover surface of every `default` and `ghost` button, every menu line, and `.panel-tab:hover` ' +
      '— which switches its own ink to --color-fg at the same time.',
  },
  {
    on: '--color-accent-dim',
    inks: ['--color-fg'],
    where:
      'The resting `primary` button, the chosen option of a segmented control, and the "changed this ' +
      'window" badge on a mutating tool call.',
  },
  {
    on: '--color-primary-active',
    inks: ['--color-fg'],
    where: 'The `primary` button and the chosen segmented option, pressed.',
  },
  {
    on: '--color-danger-active',
    inks: ['--color-err'],
    where: 'The `danger` button pressed — Stop in the composer, the confirming half of a ConfirmPair.',
  },
  {
    on: '--color-caution-hover',
    inks: ['--color-warn'],
    where: 'The `caution` button hovered — "Always allow" in a permission prompt.',
  },
  {
    on: '--color-caution-active',
    inks: ['--color-warn'],
    where: 'The same button pressed.',
  },
  {
    on: '--color-warn-bg',
    inks: ['--color-fg', '--color-fg-dim', '--color-fg-faint', '--color-warn'],
    where:
      'The permission panel, and the confirmation in front of a mode that stops asking: a --color-fg ' +
      'title (--color-warn on the mode confirmation), a --color-fg-dim body, and the key column and ' +
      'always-note in --color-fg-faint.',
  },
  {
    on: '--color-accent-bg',
    inks: ['--color-fg', '--color-fg-dim', '--color-fg-faint'],
    where: 'The same panel when the tool being approved is one of peek\'s own mutating ones.',
  },
  {
    on: '--color-warn',
    inks: ['--color-warn-ink'],
    where:
      'The badge on a tool call that came from outside peek — the only place in the window where text ' +
      'is drawn on a solid semantic colour, which is an argument for measuring it rather than against.',
  },
  {
    on: '--color-bg-1',
    inks: ['--color-code-keyword', '--color-code-type', '--color-code-string', '--color-code-number'],
    where:
      'Syntax highlighting inside a fenced code block in the chat panel. The block states `bg-bg-1` on ' +
      'itself, so this is the surface whichever kind of message it is in. Body text at --text-sm: these ' +
      'four are words, not decoration.',
  },
]

interface Breach {
  readonly ink: string
  readonly on: string
  /** The ratio as it measures today, to two places. Pinned, so it cannot slip further. */
  readonly measured: number
  readonly where: string
  /** What it would take to clear the floor. Not an excuse — a repair order. */
  readonly fix: string
}

/*
 * Found by writing SURFACES above and running it. Every one of these is a real
 * pair of colours the window renders, and every one is under 4.5:1.
 *
 * Four of the five are *interaction* states, which is not a coincidence: the
 * resting colours were audited when the legibility baseline was set, and the
 * hover and press surfaces were derived from them afterwards, by mixing, with
 * nothing measuring the result. `--color-fg` on the primary button goes 4.89 →
 * 3.92 the moment the pointer touches it.
 *
 * None is fixed here. Every fix is a change to what ships — a palette value, or
 * an ink chosen in a component — and this change is an audit; a contrast test
 * that quietly restyles the product while measuring it is not one. Recorded
 * with the number pinned so the next person inherits a decision rather than a
 * discovery.
 */
const BELOW_FLOOR: readonly Breach[] = [
  {
    ink: '--color-fg',
    on: '--color-primary-hover',
    measured: 3.92,
    where: 'The label of the `primary` button, and of the chosen segmented option, while hovered.',
    fix:
      'The hover surface lightens (78% --color-accent-dim, 22% --color-accent) under an almost-white ' +
      'label, so it moves the wrong way for contrast. Mixing towards --color-accent-dim rather than ' +
      'away from it, or darkening the press and hover pair together, both clear it; either is a visible ' +
      'change to the most-clicked control in the window and wants the Gallery screenshot §5.2 asks for.',
  },
  {
    ink: '--color-err',
    on: '--color-danger-hover',
    measured: 3.69,
    where: 'The label of the `danger` button while hovered — Stop in the composer, Reject in a permission prompt.',
    fix:
      'Same shape as `primary`: the surface lightens under a light ink. --color-danger-active is the ' +
      'same mix against --color-bg-1 instead of --color-bg-hover and measures 4.79, so the press state ' +
      'already clears it — the hover is the only rung of the three that does not.',
  },
  {
    ink: '--color-err',
    on: '--color-bg-hover',
    measured: 4.48,
    where: 'A `danger` menu line under the pointer — Close, Forget this connection, Clear the error log.',
    fix:
      'Two hundredths short, which is worse than a wide miss rather than better: it means the value was ' +
      'never measured at all. --color-err is fixed by the semantic palette, so the move is on the ' +
      'surface — a menu line hovering to --color-bg-2 instead of --color-bg-hover clears it at 5.41.',
  },
  {
    ink: '--color-fg-faint',
    on: '--color-bg-hover',
    measured: 3.79,
    where:
      'The argument summary and the elapsed time on a tool call\'s header row, while the header is ' +
      'hovered. Both are children of the button that paints the hover, so they composite onto it.',
    fix:
      'These two readings are --color-fg-faint on --color-bg-1 at rest (4.98, which clears) and drop ' +
      'below the floor only under the pointer. --color-fg-dim on that row would hold everywhere at ' +
      '5.81; it is an ink chosen in ToolCallCard.tsx, not a palette value.',
  },
  {
    ink: '--color-fg-faint',
    on: '--color-bg-sel',
    measured: 3.9,
    where: 'A NULL cell that is also the focused cell in the grid.',
    fix:
      'The narrowest of the five — it needs a NULL and the cursor on the same cell. --color-bg-sel is ' +
      'the darkest surface in the palette by luminance and every other cell ink clears on it; the faint ' +
      'weight is 0.6 short. Either the selection surface darkens further or NULL takes --color-fg-dim ' +
      'inside a selection.',
  },

  /*
   * The last two arrived together, and neither is new to the product: both
   * colours have been painting the staged row selection since the feature
   * shipped, as `color-mix()` expressions inside `components/grid.css` where no
   * assertion in this file could reach them. Naming them for the Tailwind
   * migration is the whole of what changed. That is the third time this file has
   * gained a breach by gaining a name — #7a3f3f, --color-bg-stripe, and now
   * these — and it is the argument for the literal sweep restated as an outcome.
   */
  {
    ink: '--color-fg-faint',
    on: '--color-row-sel',
    measured: 3.56,
    where: 'A NULL cell in a row staged for the chat.',
    fix:
      'Same pair, same shape as the entry above it, and the same two ways out: NULL takes ' +
      '--color-fg-dim inside a staged row (5.45 there), or the 24% accent wash comes down. The wash ' +
      'is the load-bearing half of the selection and 24% was chosen to be a hue change rather than ' +
      'a luminance one, so the ink is the side with room to move.',
  },
  {
    ink: '--color-accent',
    on: '--color-rownum-sel',
    measured: 4.0,
    where:
      'The row number itself in a staged row: --color-accent text on a gutter washed with 24% of ' +
      '--color-accent. The only ink on that surface, so it is here rather than in SURFACES.',
    fix:
      'Tinting a surface towards its own ink is the one move that always costs contrast, and that is ' +
      'the whole of the miss — --color-accent on the untinted gutter (--color-bg-1) is 5.98. ' +
      '--color-fg on the washed gutter measures 7.82 and would clear it outright; the hue is already ' +
      'said twice over, by the wash and by the 2px accent rule down the edge (--shadow-gutter-sel), ' +
      'so saying it a third time in the text is what is being paid for here.',
  },
]

interface Uninked {
  readonly token: string
  readonly why: string
}

const DECORATIVE_ONLY: readonly Uninked[] = [
  {
    token: '--color-scrim',
    why:
      'Pure black at 60%, covering the whole window behind a modal. Nothing is read on it: the dialog ' +
      'it dims sits above it wearing --color-bg-1, and everything under it is being deliberately made ' +
      'unreadable — that is the entire job. A ratio against it would be a ratio against whatever ' +
      'happens to be behind, which is every surface in the product.',
  },

  /*
   * The five drop shadows, and they are here because the census below stopped
   * asking which namespace a token is in and started asking what its value is.
   *
   * Each carries a colour — `#000a`, `#000b`, `#0009`, and 45% black twice — and
   * not one of them had ever been named by an assertion in this file, because
   * every reader in it keyed on the `--color-` prefix. They are the same kind of
   * thing as --color-scrim above and are written off for the same reason, which
   * is exactly why nobody noticed: the sentence was already written, one
   * namespace over, for the one black that happened to be called a colour.
   *
   * Being written off is now a claim with a check behind it rather than a free
   * pass: the census asserts that every colour on this table is one that *could
   * not* have been measured, i.e. carries an alpha. Repainting any of these to an
   * opaque colour goes red here and tells you to measure it instead — which is
   * the mutation that used to leave all three contract suites green.
   */
  {
    token: '--shadow-elevated',
    why:
      'Black at 45%, blurred ten pixels under a control that floats over scrolling content. A shadow ' +
      'is not a surface: it is drawn under an opaque element, so nothing is ever read on it, and what ' +
      'is under *it* is being separated from the control rather than read through it.',
  },
  {
    token: '--shadow-menu',
    why:
      'Black at 73%, the popup\'s. Same clause as --shadow-elevated: the menu itself carries ' +
      '--color-bg-2 and every line of text lands on that, never on the shadow, which falls outside ' +
      'the popup\'s own box on whatever the window happens to be showing behind it.',
  },
  {
    token: '--shadow-float',
    why:
      'Black at 60%, worn by the three things laid over the whole window rather than over one panel — ' +
      'the selection action bar, the error centre, the toast stack. Same clause again: text inside ' +
      'each of them lands on the panel\'s own surface, and the shadow is outside it.',
  },
  {
    token: '--shadow-modal',
    why:
      'Black at 67%, the deepest in the window because the dialog is the only surface with a scrim ' +
      'under it. It is drawn over --color-scrim, which is already written off above for the same ' +
      'reason, and under a dialog wearing --color-bg-1.',
  },
  {
    token: '--shadow-drag',
    why:
      'Black at 45%, under the ghost that follows the pointer while a view is torn out of its panel. ' +
      'The ghost wears --color-bg-3 and its label is measured on that; the shadow only says the thing ' +
      'has been picked up, and it exists for as long as a drag does.',
  },
]

describe('every colour is measured against what it lands on', () => {
  test('the surfaces hold the floor for every ink drawn on them', () => {
    const under: string[] = []
    for (const surface of SURFACES) {
      for (const ink of surface.inks) {
        const r = contrast(ink, surface.on)
        if (r < TEXT_FLOOR) under.push(`${ink} on ${surface.on} is ${r.toFixed(2)}:1 — ${surface.where}`)
      }
    }
    assert.deepEqual(
      under,
      [],
      `These pairs are drawn in the product and no longer clear ${TEXT_FLOOR.toFixed(1)}:1:\n${under.join('\n')}\n\n` +
        `Fix the colour. Moving it to BELOW_FLOOR is for a breach that already existed and has a ` +
        `repair order written against it, not for one this edit just introduced — and the floor ` +
        `itself is WCAG 2.1 SC 1.4.3, so it is not the number to change.`,
    )
  })

  test('the sub-floor pairs are still exactly as bad as they were written down', () => {
    const drifted: string[] = []
    for (const b of BELOW_FLOOR) {
      const now = Number(contrast(b.ink, b.on).toFixed(2))
      if (now >= TEXT_FLOOR) {
        drifted.push(
          `${b.ink} on ${b.on} now measures ${now.toFixed(2)}:1 and clears the floor. Move it into ` +
            `SURFACES — a repair order for a repair that has happened is a comment that lies.`,
        )
      } else if (now !== b.measured) {
        drifted.push(
          `${b.ink} on ${b.on} was recorded at ${b.measured.toFixed(2)}:1 and now measures ` +
            `${now.toFixed(2)}:1 (${now < b.measured ? 'worse' : 'better, but still under the floor'}). ` +
            `The number in the table is the whole value of the table: update it deliberately, or put ` +
            `back whatever moved it.`,
        )
      }
    }
    assert.deepEqual(drifted, [], drifted.join('\n\n'))
  })

  test('nothing is in both tables, and every breach says what would fix it', () => {
    const passing = new Set(SURFACES.flatMap((s) => s.inks.map((ink) => `${ink} on ${s.on}`)))
    for (const b of BELOW_FLOOR) {
      assert.ok(
        !passing.has(`${b.ink} on ${b.on}`),
        `${b.ink} on ${b.on} is in SURFACES and in BELOW_FLOOR. One of the two is wrong, and the ` +
          `table asserting it clears the floor is the one being believed.`,
      )
      assert.ok(
        b.fix.trim().length > 40,
        `${b.ink} on ${b.on} is recorded as under the floor with no account of what would fix it. ` +
          `A breach nobody can describe a repair for is a breach nobody intends to repair.`,
      )
    }
  })
})

describe('the scrollbar the grid draws by hand', () => {
  /*
   * `.grid-vsb-thumb` is the only vertical navigation affordance a million-row
   * result set has — the native one is gone, because a spacer tall enough for
   * the rows hits Chromium's ~16.7M px ceiling (see vscroll.ts). It used to be
   * the faint weight at 40% opacity, i.e. 1.46:1: you had to already know it was
   * there. This asserts it is still painted solid rather than washed out.
   *
   * Read from the component rather than from `components/grid.css`: the thumb's
   * two states are a class list in `GridScrollbar.tsx` now, and a rule that no
   * longer exists is a rule this test would have found nothing wrong with.
   *
   * `attributeClassNames`, deliberately, and it is the one assertion in this
   * file where that is the right half of the pair: the question is what the
   * *element* wears, not what the file contains. Two lines above the thumb there
   * is a comment reading `bg-border-strong bg-fg-faint`, explaining why the two
   * may not be written together — a whole-file scan would let that sentence
   * satisfy the assertion on its own, which is fail-open in the same shape as
   * every hole at the top of sourceScan.ts, mirrored.
   */
  test('is painted solid, not at an opacity that erases it', () => {
    const names = attributeClassNames(
      readFileSync(join(RENDERER, 'components', 'GridScrollbar.tsx'), 'utf8'),
    ).map((c) => c.name)
    assert.ok(
      names.includes('bg-border-strong'),
      'the scrollbar thumb no longer rests on --color-border-strong; at anything fainter it is a rumour',
    )
    assert.ok(
      !names.some((n) => /(^|:)opacity-/.test(n)),
      'the thumb must not be dimmed by opacity',
    )
  })
})

/* ==================================================================
 * The arbitrary value, the fourth way past this test.
 *
 * A Tailwind default colour class used to be a **dead class**: `--color-*:
 * initial` meant it generated no CSS, so the element rendered with no background
 * and the mistake was visible the first time anybody looked. The reset is gone
 * (§29.10) and the first test in this file rejects those names instead — caught
 * rather than impossible, which is a weaker thing and is why that test exists.
 *
 * A hex written straight into a class, in square brackets, was never dead. It
 * compiles, it paints, and it is invisible to every assertion above — the same
 * shape as the literal that started this file, moved into JSX where no
 * stylesheet audit reaches. Banned outright, before the first one is written
 * rather than after: the earlier three escapes were all found by somebody
 * happening to look.
 *
 * The rule is deliberately blunt — **no literal written into a class name, in
 * any family.** Not "no arbitrary colours": a size with no token is the same
 * failure one namespace over, and a rule with a carve-out is a rule with a
 * doorway. If a value is needed and no token has it, that is a real gap and the
 * answer is a line in the `@theme` block, which puts it under audit here.
 *
 * ## Three spellings the blunt rule was not blunt enough to catch
 *
 * "No `-[`" is how this was written, and it was one syntax out of four. Each of
 * the other three was planted on a real element and built; the whole suite —
 * this file, the type scale, the control spec — stayed green while the literal
 * shipped:
 *
 *   - a square-bracketed `property:value` pair used as the class itself, which
 *     compiles to a rule setting exactly the property this section exists to
 *     stop being set to a literal;
 *   - the same, naming a **shorthand**. The one that was planted set the font
 *     shorthand to a size under the 11px floor, which is a rung the type scale
 *     cannot see because it reads the longhand;
 *   - the same, *defining* a custom property, with the parenthesised shorthand
 *     that reads one back painting from it. Two rules: one mints a palette entry
 *     the `@theme` census has never heard of, the other paints with it.
 *
 * None contains `-[`. Widening the substring test alone would still have caught
 * none of them, because the scanner could not begin a candidate at `[` — the
 * tokens never arrived. The regex and the ban had to move together, and
 * `sourceScan.ts` carries the other half.
 *
 * The three shapes below are matched by name so the failure can say which one it
 * is, and each is written to be silent on the wide new candidate stream. The
 * arbitrary-property test insists the bracket opens the way a CSS property does
 * — a dash or a lowercase letter — and carries a colon with something after it,
 * which is the whole of what separates it from the `[]`, `[0]`, `[a-z]` and
 * `[...rest]` this scanner now also returns.
 *
 * Not banned, and the omission is deliberate: a bracketed *selector* variant
 * with no value in it. It escapes the cascade, not the palette, and whatever it
 * qualifies is still a utility the three tests below read. One of the renderer's
 * focus-trap selectors is shaped exactly like one, and it is a DOM query.
 *
 * ## Why this scan reads comments, and why that is not pedantry
 *
 * It used to read `className=` attributes. Tailwind reads raw bytes. Where the
 * two disagree, a rule is breakable in production with CI green — and the gap
 * was not hypothetical: on a clean tree, before this rewrite, `pnpm build`
 * emitted **two** arbitrary-value rules into the shipped stylesheet, both minted
 * by *prose*. One was the paragraph in `ui/spec.ts` stating that such a class
 * "compiles, paints, and is invisible to the audit". One was a JSX comment in
 * `InspectorView.tsx` naming the arbitrary value it had correctly replaced with
 * a token. Neither element wore anything; both sentences shipped a rule.
 *
 * So the ban now reads every file Tailwind reads, comments included, and the two
 * paragraphs describe their hazard in words instead. If a failure here points at
 * a comment, that is not a false positive — it is a class in `index.css`, and
 * the fix is to say it without spelling it.
 *
 * See docs/design/2026-08-04-tailwind-migration.md §3.4 and §8.
 * ================================================================== */

/**
 * The three spellings of "a value stated in the class instead of in `@theme`",
 * each with the sentence the failure uses to name it.
 *
 * Ordered by how the shapes overlap: a bracket hung off a family is reported as
 * an arbitrary value even though it also reads as a property pair, because that
 * is the name this repo has used for it for three rounds.
 */
const ARBITRARY_SHAPES: readonly { readonly shape: RegExp; readonly what: string; readonly instead: string }[] = [
  {
    shape: /-\[/,
    what: 'an arbitrary value — a literal hung off a family with a dash',
    instead: 'Name the value in the @theme block and use the utility the token generates.',
  },
  {
    shape: /(?:^|:)\[[-a-z][^\]]*:[^\]]/,
    what: 'an arbitrary property — a bracketed property/value pair standing in for a utility',
    instead:
      'This is a whole CSS declaration smuggled through the class attribute, and it answers to ' +
      'nothing in @theme. If the property has a utility, use it against a token; if it has none, ' +
      'the declaration belongs in a rule in styles.css where the stylesheet sweeps can read it.',
  },
  {
    shape: /-\(/,
    what: 'the parenthesised custom-property shorthand — a utility painting from a bare var()',
    instead:
      'A variable the @theme census has never resolved is a colour, or a size, outside the audit ' +
      'by construction — and the shape it pairs with mints one in the same class attribute. ' +
      'Point the utility at a token instead; the token namespaces generate the same utilities.',
  },
]

function arbitraryShape(name: string): (typeof ARBITRARY_SHAPES)[number] | undefined {
  return ARBITRARY_SHAPES.find((s) => s.shape.test(name))
}

describe('no atomic class reaches around the palette', () => {
  test('arbitrary values are not written anywhere Tailwind can read them', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const rel of scannedSources(RENDERER)) {
      for (const { line, name } of tailwindCandidates(readFileSync(join(RENDERER, rel), 'utf8'))) {
        scanned += 1
        const hit = arbitraryShape(name)
        if (hit) offenders.push(`${rel}:${String(line)} → ${name}\n    ${hit.what}.\n    ${hit.instead}`)
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `These classes state a value instead of naming one, so they bypass the theme — and a colour ` +
        `written any of these ways is invisible to every contrast assertion in this file, which is ` +
        `precisely how #7a3f3f shipped at 1.91:1:\n` +
        `${offenders.join('\n')}\n\n` +
        `If none of the tokens is the value you need, that is a real gap: add it to the @theme ` +
        `block in styles.css, where this test can see it, and say so in the design record.\n\n` +
        `If the hit is inside a comment: Tailwind's scanner does not know what a comment is, so ` +
        `that sentence is compiling a real rule into the shipped stylesheet. Describe the form in ` +
        `words rather than writing it — and leave a note saying why, or the next reader will ` +
        `helpfully put it back.`,
    )

    // The same guard `stylesheets()` carries: a scanner that finds nothing
    // reports no offenders either, and the two are indistinguishable from here.
    assert.ok(
      scanned > 40,
      `the candidate scan found only ${String(scanned)} class-shaped tokens in the whole renderer. ` +
        `It has stopped reading the source, and this ban has silently become an assertion about nothing.`,
    )
  })

  test('the scan reaches the files a class can hide in', () => {
    /*
     * Three files, named, because each was a hole in a previous version of this
     * ban and a narrowed file set would silently reopen all three:
     *
     *  - `ui/spec.ts` is not JSX and holds no `className=` at all; it is the
     *    single highest-value place to hide a bad token, because one string
     *    there repaints eighty-seven call sites. An earlier version scanned it
     *    separately and did so through `blankNonCode`, which erases string
     *    *bodies* — the only place an arbitrary value can be — so the assertion
     *    read a file of blanks and passed on anything. Same mistake, same fix,
     *    as the one `segmented.test.ts` records: having a shared scanner is not
     *    the same as picking the right variant of it.
     *  - `ui/CLAUDE.md` is Markdown, and was never scanned by anything. Tailwind
     *    scans it: a token in a fenced example there compiles exactly like one
     *    in a component. Verified by planting one and building.
     *  - `components/views/InspectorView.tsx` is ordinary JSX, and is here
     *    because the rule it shipped came out of a JSX comment inside the markup
     *    rather than out of an attribute.
     */
    const scanned = new Set(scannedSources(RENDERER).map((p) => p.replace(/\\/g, '/')))
    for (const rel of ['ui/spec.ts', 'ui/CLAUDE.md', 'components/views/InspectorView.tsx']) {
      assert.ok(
        scanned.has(rel),
        `${rel} is no longer in the scanned set. Every ban in this file has just stopped looking ` +
          `at a place a class has already escaped through.`,
      )
    }
  })

  test('the scanner sees the six shapes that were invisible', () => {
    /*
     * Testing the test, in the same spirit as control-spec.test.ts §0. Each
     * fixture below is a real shape that passed the whole suite while compiling
     * live CSS, reduced to one line. If any of these ever comes back green-by-
     * silence, the ban above is decorative again.
     *
     * The first three are syntactic positions the *scan* could not reach. The
     * last three are syntaxes the *ban* could not name — each verified by
     * planting it on a live element, building, and reading the rule back out of
     * the shipped stylesheet, which is the only evidence that counts here.
     */
    const arbitrary = (src: string): string[] =>
      tailwindCandidates(src)
        .map((c) => c.name)
        .filter((n) => arbitraryShape(n) !== undefined)

    assert.deepEqual(
      arbitrary("const c = `flex ${on ? 'bg-[#7a3f3f]' : 'bg-bg-2'}`"),
      ['bg-[#7a3f3f]'],
      'a template literal hid both branches of the expression, which is where the varying class is',
    )
    assert.deepEqual(
      arbitrary("const BADGE = 'flex-none text-[9px]'"),
      ['text-[9px]'],
      'a module-level constant is not a className attribute, and 24 of 74 type sites live in one',
    )
    assert.deepEqual(
      arbitrary('// the p-[3px] here was replaced by a token'),
      ['p-[3px]'],
      'Tailwind compiles class names out of comments; a scan that skips them audits less than ships',
    )

    assert.deepEqual(
      arbitrary("const c = 'flex [background:#7a3f3f]'"),
      ['[background:#7a3f3f]'],
      'the arbitrary property: a whole declaration in the class attribute, and no dash-bracket in it',
    )
    assert.deepEqual(
      arbitrary("const c = 'flex [font:9px/1.2_monospace]'"),
      ['[font:9px/1.2_monospace]'],
      'the same shape on a shorthand, which reaches a size no scan for the longhand can see',
    )
    assert.deepEqual(
      arbitrary("const c = 'flex [--zz:#7a3f3f] bg-(--zz)'"),
      ['[--zz:#7a3f3f]', 'bg-(--zz)'],
      'one class mints a palette entry, the next paints with it; both have to be named',
    )
    assert.deepEqual(
      arbitrary("const c = 'hover:[background:#7a3f3f] [&>*]:[color:#7a3f3f]'"),
      ['hover:[background:#7a3f3f]', '[&>*]:[color:#7a3f3f]'],
      'variants do not launder it, including the bracketed selector variant that also opens with [',
    )
    assert.deepEqual(
      arbitrary("const c = '![background:#7a3f3f] [color:#7a3f3f]!'"),
      ['[background:#7a3f3f]', '[color:#7a3f3f]'],
      "Tailwind's important marker is not part of the candidate, and must not hide the bracket either",
    )

    assert.deepEqual(
      arbitrary('const url = "https://example.invalid/a"\nconst n = notAClass'),
      [],
      'and it still says no when there is nothing there',
    )
    assert.deepEqual(
      arbitrary('const [a] = xs; const re = /^[a-z]+[.)]$/; f(...[0]); type T = Record<string, [number]>'),
      [],
      'the wide aperture returns all of these as candidates; not one of them is a class, and the ' +
        'ban has to be silent about them or it will be switched off',
    )
  })
})

/* ==================================================================
 * Alpha, the third way past this test.
 *
 * Everything above compares `@theme` token pairs. That is precisely the blind
 * spot: a piece of text can also be pushed under the floor by an alpha, which
 * changes no token and appears in no `color:` declaration. The floor holds only
 * where the test happens to be looking — and this is the third time that
 * sentence has been true in one day:
 *
 *   1. written as a literal instead of a token   → #7a3f3f survived at 1.91:1
 *   2. written on `background` instead of `border` → the literal ban missed it
 *   3. written as an alpha instead of a colour   → this block
 *
 * (The fourth is the section above: written as an arbitrary value in JSX. The
 * fifth is the one none of these five spellings covers, and it is the widest:
 * written correctly, as a token, and named by no assertion at all. Seventeen of
 * the palette's thirty-two colours were in that state — see the census.)
 *
 * Line 2 reads in the past tense now. It was written as a standing known hole,
 * survived a whole migration in that form, and is closed: `nothing paints with
 * a literal colour` stopped inheriting the border test's subject. A note saying
 * a hole is open after it has been filled is worth exactly as much as one
 * saying it is closed while it is open.
 *
 * ## The model
 *
 * `opacity` composites the whole subtree. The element's own background *and* its
 * text are both composited onto whatever is behind, so **both shift**:
 *
 *   effective foreground = α·F + (1−α)·B      effective background = α·S + (1−α)·B
 *
 * where S is the element's own surface (equal to B when it has none). Treating
 * the background as fixed is the intuitive shortcut and it is wrong; here it
 * happens to differ by 0.01 because --color-bg-1 and --color-bg-2 are close
 * neighbours, which is a property of this palette rather than a reason to
 * simplify.
 *
 * That is the model for `opacity`. The slash modifier is a different one and
 * the difference is not a detail: it makes a single *colour* translucent, so
 * only the surface moves and the text painted over it lands afterwards at full
 * strength. Every site records which of the two it is, because sharing one
 * formula between them produces a plausible number for a rendering the window
 * does not perform.
 *
 * ## The shape of the rule
 *
 * Every alpha in the renderer must appear in ALPHA_SITES. That is what makes
 * this durable rather than a one-off fix: a new one fails the census until
 * somebody classifies it. Entries either clear AA, or carry a written reason —
 * the same demand §2.3 of the legibility doc makes of the hit-target exemptions:
 * **being under the floor has to be a sentence somebody wrote, not an accident
 * of arithmetic.**
 *
 * ## Four channels, because "an alpha" has four spellings
 *
 * The census reads all four, and the last two were opened one round apart:
 *
 *  1. an `opacity` declaration in the stylesheet;
 *  2. an inline `opacity` in a component's style object;
 *  3. an `opacity-<n>` class, which the migration made the usual spelling;
 *  4. the slash modifier on a colour, which is the *other* usual spelling and
 *     which nothing here read until it had three live sites.
 *
 * Two of the four were leaking on a green suite when this was written, and both
 * leaks were in the reading rather than in the rule. Channel 1 demanded a
 * decimal followed immediately by a semicolon, so the percentage spelling of the
 * same value — `45%`, which CSS accepts and means exactly the same thing — was
 * matched as far as the digits and then dropped on the floor. Channel 3 accepted
 * variant prefixes made of lowercase letters and dashes, and a *named* group
 * variant has a slash in it; the same class under a plain variant went red while
 * the named one shipped. Each was planted and each was green.
 *
 * The pattern across all four, and the reason the count keeps going up: none of
 * these was a rule anybody disagreed with. Each was a spelling nobody had
 * written down. See sourceScan.ts for the same sentence about a different
 * scanner.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.2.1 and
 * docs/design/2026-08-04-tailwind-migration.md §15.
 * ================================================================== */

interface AlphaBreach {
  readonly ink: string
  /**
   * The composited ratio as it measures today, to two places. Pinned, exactly
   * as BELOW_FLOOR pins its own, so the reading cannot slip further without
   * this going red.
   */
  readonly measured: number
  /** What it would take to clear the floor. Not an excuse — a repair order. */
  readonly fix: string
}

interface AlphaSite {
  /**
   * Where the declaration lives, as `file:selector`.
   *
   * The stylesheet half of the census now always says `styles.css`, because the
   * eight sheets were merged back into one (§11.1). The prefix stops carrying
   * information and is kept only because it is the key the scan below builds —
   * the selector is what identifies the site. If a name here no longer tells you
   * which part of the window it is, that is the merge, not a lost fact; the
   * rules are in `styles.css` under the SHEET banner they arrived with.
   */
  readonly where: string
  /**
   * Which of the two things the alpha is attached to. The arithmetic differs,
   * and using the wrong one flatters the answer rather than failing loudly:
   *
   *   'subtree' — the `opacity` property, on the element. It composites the
   *               whole group, so the element's own surface *and* every glyph
   *               inside it are washed towards what is behind.
   *   'colour'  — the slash modifier, on one colour of one property. Only that
   *               paint is translucent. Text drawn over it is a later, opaque
   *               layer and does not move at all, so the ink stays at full
   *               strength while the surface under it lightens.
   *
   * Treating the second as the first understates the loss on a light ink over a
   * dark surface and overstates it on a dark one; either way it is a number
   * about a rendering the window does not perform.
   */
  readonly channel: 'subtree' | 'colour'
  readonly alpha: number
  /** The surface the composited group lands on. */
  readonly behind: string
  /** The element's own background, or null when it has none. */
  readonly surface: string | null
  /** Text colours rendered inside the group that must clear AA. */
  readonly text: readonly string[]
  /**
   * Text colours rendered inside the group that do *not* clear it. Present so a
   * site can hold both — the alternative is a whole entry exempted because one
   * of its three inks is short, which is how a passing measurement gets quietly
   * deleted. Same contract as BELOW_FLOOR: pinned, and with a repair order.
   */
  readonly breaches?: readonly AlphaBreach[]
  /** null = must clear AA. A string = a written exemption, and its reason. */
  readonly exempt: string | null
}

const ALPHA_SITES: readonly AlphaSite[] = [
  {
    where: 'styles.css:button:disabled',
    channel: 'subtree',
    alpha: 0.45,
    behind: '--color-bg-1',
    surface: '--color-bg-2',
    text: ['--color-fg'],
    exempt:
      'WCAG 2.1 SC 1.4.3 excludes text that is part of an inactive user interface component. ' +
      'Measured 3.32:1; a disabled control that read as strongly as a live one would be worse, ' +
      'because "you cannot press this" is the only thing it has to say.',
  },
  {
    where: 'ui/spec.ts:disabled:opacity-45',
    channel: 'subtree',
    alpha: 0.45,
    behind: '--color-bg-1',
    surface: '--color-bg-2',
    text: ['--color-fg'],
    exempt:
      'Same clause and same number as `button:disabled` — WCAG 2.1 SC 1.4.3 excludes text in an ' +
      'inactive user interface component. This was three entries until the Tailwind migration ' +
      '(`.btn`, `.seg-item` and `.menu-item` each restated it in its own stylesheet); the control ' +
      'layer states it once now, in CONTROL_BASE and MENU_ITEM_BASE, and a menu line composites ' +
      'onto the popup\'s own --color-bg-2 rather than a surface of its own.',
  },
  {
    // Was `styles.css:.panel.drag-source` until §29.11.8. The rule existed only
    // because this key named it, which is a fence keeping a rule alive for its
    // own convenience; the census reads class-borne alphas too, so the fact moved
    // to the element and the key followed it.
    where: 'components/Panel.tsx:opacity-75',
    channel: 'subtree',
    alpha: 0.75,
    behind: '--color-bg',
    surface: '--color-bg-1',
    text: ['--color-fg', '--color-fg-dim'],
    exempt: null,
  },
  {
    // Was `styles.css:.conn-key`. The rule held one declaration and existed only
    // because this key named it — the exemption sentence is a field on this entry,
    // not something the stylesheet was carrying, so nothing was lost by moving the
    // alpha onto the element (§29.11.8).
    where: 'components/Sidebar.tsx:opacity-85',
    channel: 'subtree',
    alpha: 0.85,
    behind: '--color-bg-1',
    surface: null,
    text: [],
    exempt: 'Its content is a single 🔑. Not text — an emoji read by shape, like the disclosure caret.',
  },
  {
    where: 'components/DataGrid.tsx:opacity-70',
    channel: 'subtree',
    alpha: 0.7,
    behind: '--color-bg-1',
    surface: '--color-accent',
    text: [],
    exempt:
      'The column drag bar, 7px wide with nothing written on it. 1.4.11 applies to it, not 1.4.3, and ' +
      'it is drawn in --color-accent. Was `components/grid.css:.col-resizer.active` until the Tailwind ' +
      'migration; the alpha is stated unconditionally now because the bar has no background at rest, ' +
      'so it only ever composites the accent it wears while hovered or dragged.',
  },
  {
    where: 'styles.css:@keyframes conn-pulse',
    channel: 'subtree',
    alpha: 0.25,
    behind: '--color-bg-1',
    surface: null,
    text: [],
    exempt:
      'Animates `.dot.connecting` — a 7px circle, and a moving one. Neither text nor a resting state; ' +
      'the floor is about what a reader has to be able to read. It was keyed on `@keyframes pulse` ' +
      'until the keyframe was renamed, and the rename is the reason this line is worth reading twice: ' +
      '`pulse` is also the name of a keyframe in Tailwind\'s default theme, two definitions of one ' +
      'name resolve by last-one-wins rather than by layer, and the artifact carried Tailwind\'s ' +
      '`50%{opacity:.5}` and not this file\'s 0.25. So this entry pinned an alpha that did not ship. ' +
      'Every fence in the repo was structurally blind to it: this census reads the stylesheet, where ' +
      '0.25 is written, and `audit-shipped-css` asks whether class rules have wearers, which a ' +
      'keyframe is not. Renamed in styles.css and rekeyed here in one edit; the number below is now ' +
      'the number the window renders, confirmed by reading the keyframe back out of the artifact.',
  },
  {
    where: 'styles.css:@keyframes chat-pulse',
    channel: 'subtree',
    alpha: 0.25,
    behind: '--color-bg-1',
    surface: null,
    text: [],
    exempt: 'Animates `.chat-status-dot`. Same shape of exemption as `pulse` above.',
  },

  /*
   * The fourth channel, and the three sites that were already shipping through
   * it when it was opened. All three are the slash modifier; all three are
   * 'colour' rather than 'subtree', so the ink over each one is at full
   * strength and only the surface under it moved.
   */
  {
    where: 'components/DropZoneOverlay.tsx:bg-accent/18',
    channel: 'colour',
    alpha: 0.18,
    behind: '--color-bg-1',
    surface: '--color-accent',
    text: [],
    exempt:
      'The drop-zone wash: the rectangle that lights up the half of a panel a dragged view is about ' +
      'to land in. Nothing is read *on* it — the label naming the zone carries its own surface, which ' +
      'is the entry below this one. What it does dim is the panel underneath, which it covers rather ' +
      'than replaces: the faint weight on the panel measures 4.98:1 at rest and 3.81:1 through the ' +
      'wash, and on the grid layer 5.29:1 becomes 4.08:1. That is the same clause as the two ' +
      'keyframes above — it exists only while a pointer is dragging something across it, and nobody ' +
      'reads a cell they are currently dropping a view on top of. It replaced a color-mix() against ' +
      'transparent and is the same colour to the byte; see the note in the component.',
  },
  /*
   * The chip that names the drop zone, worn twice: inside the highlight above,
   * and under the insertion caret on a tab strip.
   *
   * `behind` is --color-accent rather than the highlight's own paint, and that
   * is deliberately the *harshest* reading available in one token. The chip is
   * inside a rectangle that is itself only 18% accent over a panel, so what
   * actually shows through the chip's 18% is mostly panel; naming the accent
   * neat is the strictest single-token stand-in for a two-layer stack this file
   * has no vocabulary for, and it costs nothing because the chip clears anyway.
   * It measures 9.36:1 modelled this way, 11.78:1 as it really renders inside
   * the highlight, and 12.11–12.40:1 for the caret's copy over a tab strip or
   * the grid. Building the stack properly would buy 2.4 points of headroom on a
   * pair that needs 4.5 and has 9.
   */
  {
    where: 'components/DropZoneOverlay.tsx:bg-bg/82',
    channel: 'colour',
    alpha: 0.82,
    behind: '--color-accent',
    surface: '--color-bg',
    text: ['--color-fg'],
    exempt: null,
  },

  /*
   * The wash down the leading edge of a tool call that *changed* this window,
   * as against one that only read it. A gradient: 10% accent at the card's left
   * edge, gone by 55% across.
   *
   * Measured at the strong end, which is where the header row starts and is the
   * only defensible fixed point — how far into the fade a given glyph lands
   * depends on the length of the tool's name, and a test cannot hold an x
   * coordinate. Over-strict in the direction this file is always over-strict in.
   */
  {
    where: 'components/chat/ToolCallCard.tsx:from-accent/10',
    channel: 'colour',
    alpha: 0.1,
    behind: '--color-bg-1',
    surface: '--color-accent',
    text: ['--color-fg', '--color-fg-dim'],
    breaches: [
      {
        ink: '--color-fg-faint',
        measured: 4.28,
        fix:
          'This is the same ink on the same row as the --color-fg-faint / --color-bg-hover entry in ' +
          'BELOW_FLOOR, and the same repair clears both: --color-fg-dim on a tool call\'s header row ' +
          'measures 6.56:1 through this wash and 5.81:1 under the pointer, so one ink chosen in ' +
          'ToolCallCard.tsx fixes the pair. Moving the wash instead is the weaker option — at 10% it ' +
          'is already the faintest paint in the window that anybody is asked to notice.',
      },
    ],
    exempt: null,
  },
]

/**
 * A run of Tailwind variant prefixes, as they appear in front of a utility.
 *
 * The slash is the whole of the second hole this section was widened for. A
 * group can be given a name, and the variant that reads a named group carries
 * that name after a slash. The pattern this replaces accepted a prefix of
 * lowercase letters and dashes only, so a named-group variant matched nothing —
 * and because that pattern also consumed a quote or a space in front of the
 * whole token, the utility could not be picked up on its own either. An alpha
 * worn under a named group was invisible to this census from both ends, while
 * the identical utility under a plain variant went red.
 *
 * Which matters because of §11.2 of the migration record: the round that
 * removed descendant selectors from this codebase is the round that put named
 * groups into it. The migration widened this hole in the same breath as it
 * closed the one it was aiming at.
 */
const VARIANT = String.raw`(?:[a-z0-9][\w.-]*(?:\/[\w.-]+)?:)*`

/**
 * An `opacity` declaration in a stylesheet, either spelling of the value — the
 * first channel.
 *
 * CSS takes a number or a percentage here and they mean the same thing. The
 * pattern this replaces demanded the digits and then the semicolon, so a
 * percentage matched as far as the `%`, failed, and left the census entirely:
 * not read as opaque, not read at all. Planted on a real rule as `40%` and the
 * four contract tests were 126/126 green with it shipping.
 */
const OPACITY_DECL = /^\s*opacity\s*:\s*([0-9.]+)(%?)\s*(?:!important\s*)?;/

/** The alpha a line declares, as a fraction, or null if it declares none. */
function declaredAlpha(line: string): number | null {
  const m = OPACITY_DECL.exec(line)
  if (m === null) return null
  return m[2] === '%' ? Number(m[1]) / 100 : Number(m[1])
}

/** `opacity-<n>`, under any run of variants. The third channel. */
const OPACITY_CLASS = new RegExp(String.raw`(?<![\w-])(${VARIANT}opacity-(\d+))(?![\w-])`, 'g')

/**
 * A utility carrying the slash modifier — the fourth channel.
 *
 * `opacity` is not the only way to make something translucent, and it is not
 * the way this codebase reaches for first any more: the modifier states an
 * alpha on one colour of one property, and three of them were already shipping
 * when this was written, none of them classified anywhere. One of the three is
 * body text's surface.
 *
 * Wide on purpose — anything at all, then a slash, then a number — because the
 * families that take a colour are a list, and a list is what let every previous
 * hole in this file through. `paletteColourIn` does the narrowing afterwards on
 * the *value* instead, which is the same move the literal sweep made.
 */
const SLASH_ALPHA = new RegExp(
  String.raw`(?<![\w-])(${VARIANT}(-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([0-9.]+))(?![\w-])`,
  'g',
)

/** Colour keywords Tailwind builds in rather than reading out of the palette. */
const BUILT_IN_COLOURS = new Set(['transparent', 'current', 'inherit'])

/**
 * The colour a slash modifier is attached to, or null when the thing in front
 * of the slash is not a colour at all.
 *
 * Half the utilities that wear a slash are fractions — a half-width, a
 * half-offset — and they are geometry, not alpha. Rather than list the families
 * that take a colour, this asks the palette: strip family segments off the
 * front until what is left names a token. That is fail-closed rather than
 * merely convenient, and what makes it so has changed hands — read this before
 * trusting it.
 *
 * It used to rest on `--color-*: initial`: the palette was closed, so a colour
 * utility naming anything the block did not define was a dead class that
 * generated no CSS and painted nothing. If it could reach the screen, its name
 * was in here. That reset is gone (§29.10), and on its own this function is now
 * fail-*open* for exactly one shape: `bg-red-500/50` strips to `red-500`, which
 * is not a token, so it returns null and the slash reads as a fraction — an
 * alpha the census never sees.
 *
 * What closes it is the first test in this file, which rejects any Tailwind
 * default colour by name before it can wear a slash. That is a real dependency
 * between two tests rather than a property of this one, so: **if that test is
 * ever weakened, this function has a hole, and the hole is silent.**
 */
function paletteColourIn(utility: string): string | null {
  const parts = utility.split('-')
  for (let i = 1; i < parts.length; i += 1) {
    const rest = parts.slice(i).join('-')
    if (BUILT_IN_COLOURS.has(rest)) return rest
    if (VARS.has(`--color-${rest}`)) return `--color-${rest}`
  }
  return null
}

describe('alpha never quietly lowers the floor', () => {
  /** Composite `fg` over `bg` at `alpha`, in sRGB, as the browser does. */
  function composite(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
    return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as [number, number, number]
  }

  function ratio(a: [number, number, number], b: [number, number, number]): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  test('every opacity in the renderer is accounted for', () => {
    const sheets = stylesheets(RENDERER)

    const found: string[] = []
    for (const sheet of sheets) {
      const lines = decomment(readFileSync(join(RENDERER, sheet), 'utf8')).split('\n')
      let selector = ''
      lines.forEach((line) => {
        // Leading whitespace tolerated, because indentation is not information:
        // anchoring at column zero meant that wrapping `button` in `@layer base`
        // (base.css, so that utilities can outrank it) hid every rule inside it
        // and reported the at-rule as the selector. A census that reads one
        // formatting convention is a census of whatever happens to be flat.
        //
        // The column was carrying one real fact, though, and it has to be said
        // out loud now: `50%` and `to` are keyframe *steps*, not selectors, and
        // the name a reader would go looking for is the `@keyframes` around
        // them. Two of the entries below are exactly that.
        const open = /^\s*([^\s{][^{}]*)\{\s*$/.exec(line)
        if (open && !/^(from|to|[\d.]+%(\s*,\s*[\d.]+%)*)$/.test(open[1].trim())) selector = open[1].trim()
        // `opacity: 1` is a reset — it restores the floor rather than lowering
        // it. Both spellings of the value are read; see OPACITY_DECL.
        const value = declaredAlpha(line)
        if (value !== null && value < 1) found.push(`${sheet.replace(/\\/g, '/')}:${selector}`)
      })
    }

    // Inline `opacity` in a component is the channel that produced the worst of
    // the three breaches, and no stylesheet audit would ever have seen it.
    for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
      const path = join(entry.parentPath, entry.name)
      // Blanked, not raw: the comment written to explain a *removed* `opacity`
      // re-registered it here, which is the same trap the control-spec scanner
      // shipped with. See __tests__/sourceScan.ts.
      blankNonCode(readFileSync(path, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/\bopacity\s*:/.test(line)) found.push(`${relative(RENDERER, path)}:${String(i + 1)}`)
        })
    }

    /*
     * The third channel, and the one the migration opened: `opacity-45` is a
     * class, not a declaration, so neither scan above can see it — and the
     * control layer's disabled alpha, which was three of the entries below, is
     * written that way now.
     *
     * Keyed by the class rather than by a line number, because that is what the
     * fact actually is: one alpha, stated once, worn by every control in the
     * product. A line number would go stale the next time a variant is added,
     * and a census that cries wolf on an unrelated edit stops being read.
     *
     * `.ts` as well as `.tsx`: `ui/spec.ts` holds class strings and is not JSX.
     *
     * The fourth channel rides along in the same walk, and is the wider of the
     * two: see SLASH_ALPHA.
     */
    for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      const path = join(entry.parentPath, entry.name)
      const rel = relative(RENDERER, path)
      if (rel.includes('__tests__')) continue
      const src = blankComments(readFileSync(path, 'utf8'))
      for (const m of src.matchAll(OPACITY_CLASS)) {
        if (Number(m[2]) < 100) found.push(`${rel}:${m[1]}`)
      }
      for (const m of src.matchAll(SLASH_ALPHA)) {
        // A slash means an alpha only when what precedes it is a colour. The
        // half-width and half-offset utilities wear the same punctuation and
        // are not translucent anything.
        if (paletteColourIn(m[2]) !== null && Number(m[3]) < 100) found.push(`${rel}:${m[1]}`)
      }
    }

    const known = new Set(ALPHA_SITES.map((s) => s.where))
    const unclassified = [...new Set(found)].filter((f) => !known.has(f))
    assert.deepEqual(
      unclassified,
      [],
      `These use \`opacity\` and are not in ALPHA_SITES:\n${unclassified.join('\n')}\n\n` +
        `Add each one, with the surface it composites onto and the text inside it. If it lands ` +
        `under 4.5:1, either fix it or write the exemption down — being under the floor has to be ` +
        `a sentence somebody wrote. Prefer fixing: the two breaches this census first found were ` +
        `both better solved by choosing a dimmer token than by tuning an alpha.`,
    )

    const stale = ALPHA_SITES.map((s) => s.where).filter((w) => !found.includes(w))
    assert.deepEqual(stale, [], `ALPHA_SITES lists sites that no longer use opacity:\n${stale.join('\n')}`)
  })

  for (const site of ALPHA_SITES.filter((s) => s.exempt === null)) {
    test(`${site.where} composites to the ratios written down`, () => {
      const behind = colorOf(site.behind)
      const surface = site.surface === null ? behind : colorOf(site.surface)
      const bg = composite(surface, behind, site.alpha)
      // Only `opacity` reaches the glyphs. A translucent *colour* is one paint
      // layer: text drawn over it arrives afterwards, at full strength.
      const ink = (token: string): [number, number, number] =>
        site.channel === 'subtree' ? composite(colorOf(token), behind, site.alpha) : colorOf(token)

      for (const token of site.text) {
        const r = ratio(ink(token), bg)
        assert.ok(
          r >= 4.5,
          `${site.where}: ${token} composites to ${r.toFixed(2)}:1 at alpha ${String(site.alpha)}.\n` +
            `Raise the alpha, pick a dimmer token and drop the opacity, or add a written exemption ` +
            `to ALPHA_SITES saying why this text does not have to be readable.`,
        )
      }

      for (const breach of site.breaches ?? []) {
        assert.ok(
          !site.text.includes(breach.ink),
          `${site.where}: ${breach.ink} is listed as clearing the floor and as breaching it. One of ` +
            `the two is wrong, and the list asserting it clears is the one being believed.`,
        )
        assert.ok(
          breach.fix.trim().length > 40,
          `${site.where}: ${breach.ink} is recorded as under the floor with no account of what would ` +
            `fix it. A breach nobody can describe a repair for is a breach nobody intends to repair.`,
        )
        const now = Number(ratio(ink(breach.ink), bg).toFixed(2))
        assert.ok(
          now < 4.5,
          `${site.where}: ${breach.ink} now measures ${now.toFixed(2)}:1 and clears the floor. Move ` +
            `it into \`text\` — a repair order for a repair that has happened is a comment that lies.`,
        )
        assert.equal(
          now,
          breach.measured,
          `${site.where}: ${breach.ink} was recorded at ${breach.measured.toFixed(2)}:1 and now ` +
            `measures ${now.toFixed(2)}:1. The number is the whole value of writing it down: update ` +
            `it deliberately, or put back whatever moved it.`,
        )
      }
    })
  }

  test('the census reads the spellings it used to drop', () => {
    /*
     * Testing the test, the same way the arbitrary-value ban one section up
     * does. Each line below is a spelling that shipped past this census while
     * the whole suite was green, reduced to one case. They are cheap to lose
     * again: every one of them is a character or two inside a pattern, and a
     * pattern nobody can see the point of gets tidied.
     */
    assert.equal(declaredAlpha('  opacity: 0.45;'), 0.45)
    assert.equal(
      declaredAlpha('  opacity: 45%;'),
      0.45,
      'the percentage spelling is the same declaration; it used to match the digits and then fall out',
    )
    assert.equal(declaredAlpha('  opacity: 1;'), 1, 'a reset restores the floor rather than lowering it')
    assert.equal(declaredAlpha('  color: var(--color-fg);'), null)

    const classes = (src: string): string[] => [...src.matchAll(OPACITY_CLASS)].map((m) => m[1])
    assert.deepEqual(classes("const c = 'flex hover:opacity-50'"), ['hover:opacity-50'])
    assert.deepEqual(
      classes("const c = 'flex group-hover/tab:opacity-50'"),
      ['group-hover/tab:opacity-50'],
      'a named group puts a slash in the variant, and the same alpha under a plain variant went red',
    )

    const alphas = (src: string): string[] =>
      [...src.matchAll(SLASH_ALPHA)].filter((m) => paletteColourIn(m[2]) !== null).map((m) => m[1])
    assert.deepEqual(
      alphas("const c = 'flex bg-accent/18 text-fg-faint'"),
      ['bg-accent/18'],
      'the modifier states an alpha on one colour, and nothing here read it until it had three sites',
    )
    assert.deepEqual(
      alphas("const c = 'group-hover/tab:bg-bg-1/50'"),
      ['group-hover/tab:bg-bg-1/50'],
      'the two holes compose: a named group in front of a slash alpha',
    )
    assert.deepEqual(
      alphas("const c = 'left-1/2 -translate-x-1/2 basis-1/3 w-3/4 text-sm/6'"),
      [],
      'the same punctuation on a fraction or a line height is geometry; a census that cried wolf on ' +
        'every one of these would be switched off within the week',
    )
  })

  test('every exemption says why', () => {
    for (const site of ALPHA_SITES) {
      if (site.exempt === null) {
        continue
      }
      assert.ok(
        site.exempt.trim().length > 40,
        `${site.where} is exempt without a reason worth reading. An exemption nobody can justify in ` +
          `a sentence is a breach with better paperwork.`,
      )
      // The two mechanisms do not compose: an exempt site runs no assertion at
      // all, so a pinned ratio hung off one would be a number nothing checks.
      assert.ok(
        (site.breaches ?? []).length === 0,
        `${site.where} is exempt and also carries pinned breaches. Nothing measures them — drop the ` +
          `exemption so the site is asserted, or fold what they say into the exemption's sentence.`,
      )
    }
  })
})

/* ==================================================================
 * What counts as "a colour in the palette", which was the wrong question for
 * three rounds.
 *
 * Everything below the census used to read `[...VARS.keys()].filter(name =>
 * name.startsWith('--color-'))`. That is a census of a **prefix**, and it was
 * being read — including by the paragraph under it — as a census of the
 * *colours*. Five tokens are the difference, and all five were shipping:
 * --shadow-elevated, --shadow-menu, --shadow-float, --shadow-modal and
 * --shadow-drag each carry a hard-coded black inside a box-shadow value, and no
 * assertion in this file had ever named one. The demonstration is the same one
 * the paragraph below already tells about --color-code-string, run again a
 * namespace over: repaint --shadow-menu's `#000b` to an opaque red and this
 * file, the type scale and the control spec are 66/66 green while the popup
 * ships with a red glow.
 *
 * That is the fifth spelling of the one mistake this file keeps making, and it
 * is the same one every time: **the subject of a rule was a name rather than a
 * value.** The literal sweep watched `border` and `outline` instead of colour;
 * the alpha census watched `opacity:` instead of translucency; this watched
 * `--color-` instead of paint. Each was fixed by asking about the value, and so
 * is this.
 *
 * So the palette is now every token whose *value* contains a colour, whatever it
 * is called — computed to a fixpoint, because a colour can arrive through a
 * `var()` as well as by being written out. Three consequences worth stating:
 *
 *  1. It cannot narrow. The `--color-` namespace is unioned in unconditionally,
 *     so a token that this reader cannot see a colour in is still audited if it
 *     is named like one. Widening only.
 *  2. A token whose colour is *entirely* somebody else's — --shadow-gutter-sel
 *     is `inset 2px 0 0 var(--color-accent)` and states no colour of its own —
 *     is covered by whatever covers the token it points at. It introduces no
 *     colour, so there is nothing here to measure; the reference has to land on
 *     something covered, which is what makes that different from an exemption.
 *  3. Being written off now has a check behind it. A colour with an alpha has no
 *     ratio until it lands on something, which is the sentence `colorOf` has
 *     always used to refuse one — so that, and only that, is what DECORATIVE_ONLY
 *     is for. An *opaque* colour has a ratio, therefore can be measured,
 *     therefore must be. That is the assertion the mutation above trips.
 * ================================================================== */

/** One colour-ish thing inside a token's value. */
interface Term {
  /** As written, for the failure message. */
  readonly text: string
  /** The token it names, when the term is a `var()` rather than a value. */
  readonly ref: string | null
  /** Carries an alpha channel, so it has no ratio until it lands on something. */
  readonly translucent: boolean
}

/**
 * Colour terms in a value: a literal, a functional colour, a `color-mix()`, or a
 * `var()` naming another token.
 *
 * Deliberately wider than `COLOUR_LITERAL`, which answers a different question
 * one section up ("is there a colour written into a rule"). This one has to see
 * a colour arriving by reference too, or --shadow-gutter-sel reads as a token
 * with no colour in it and the fixpoint below stops halfway.
 */
const COLOUR_TERM = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)|\bcolor-mix\(|\bvar\(\s*(--[a-z0-9-]+)\s*\)/gi

function colourTerms(value: string): Term[] {
  return [...value.matchAll(COLOUR_TERM)].map((m) => {
    const text = m[0]
    if (m[1] !== undefined) return { text, ref: m[1], translucent: false }
    // Four digits and eight are the two hex forms with an alpha pair; `ff` is
    // opaque spelled the long way and is not an escape from being measured.
    const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(text)
    if (hex) {
      const a = hex[1].length === 4 ? hex[1][3].repeat(2) : hex[1].slice(6)
      return { text, ref: null, translucent: Number.parseInt(a, 16) < 255 }
    }
    // `rgb(0 0 0 / 45%)` and `rgba(0, 0, 0, .45)` are the same declaration; the
    // slash form is the one this repo writes and the one a comma-counting
    // reader misses. Either way it is a fourth component.
    const fn = /^(?:rgba?|hsla?)\(([^()]*)\)$/i.exec(text)
    if (fn) {
      const args = fn[1].includes('/') ? fn[1].split('/') : fn[1].split(',')
      return { text, ref: null, translucent: args.length === 4 || (fn[1].includes('/') && args.length === 2) }
    }
    // A mix. Opaque unless one side is transparent, and nothing in the block
    // mixes against transparent today — if that changes, this reads it as
    // opaque and demands a measurement, which is the safe direction.
    return { text, ref: null, translucent: false }
  })
}

/**
 * Every token that paints, to a fixpoint.
 *
 * A token bears colour if it states one, or if it names a token that does. The
 * `--color-` namespace is added whatever its value looks like: a name is a
 * promise, and a reader that could not parse the value is not a reason to stop
 * auditing it.
 */
function colourBearingTokens(vars: Map<string, string>): Set<string> {
  const terms = new Map([...vars].map(([name, value]) => [name, colourTerms(value)]))
  const bearing = new Set<string>()
  for (const [name, list] of terms) {
    if (name.startsWith('--color-') || list.some((t) => t.ref === null)) bearing.add(name)
  }
  for (let pass = 0; pass < vars.size; pass += 1) {
    const before = bearing.size
    for (const [name, list] of terms) {
      if (list.some((t) => t.ref !== null && bearing.has(t.ref))) bearing.add(name)
    }
    if (bearing.size === before) break
  }
  return bearing
}

/*
 * Testing the test, the third time in this file and for the same reason as the
 * other two: the number the census reports is bounded below by the `--color-`
 * namespace it unions in, so a `colourTerms` that had stopped recognising
 * colours would hand it exactly the old, name-shaped palette and every
 * assertion after it would pass — reporting the bug it was written to fix as
 * fixed. The count guard cannot see that. Fixtures can.
 *
 * Each line is a spelling that appears in the block today, plus the two the
 * block does not write but CSS accepts, because "the value has an alpha" is the
 * whole of what separates a shadow from a colour that has to be measured.
 */
test('the colour reader tells the four spellings apart, and alpha from opaque', () => {
  const read = (value: string): string[] =>
    colourTerms(value).map((t) => `${t.text} ${t.ref !== null ? 'ref' : t.translucent ? 'alpha' : 'opaque'}`)

  assert.deepEqual(read('#16181c'), ['#16181c opaque'])
  assert.deepEqual(read('#0009'), ['#0009 alpha'], 'four digits carry an alpha pair; three and six do not')
  assert.deepEqual(read('#000000ff'), ['#000000ff opaque'], 'ff is opaque spelled the long way, not an escape')
  assert.deepEqual(
    read('0 2px 10px rgb(0 0 0 / 45%)'),
    ['rgb(0 0 0 / 45%) alpha'],
    'the slash form is the one this block writes, and a reader counting commas finds three arguments',
  )
  assert.deepEqual(read('rgba(0, 0, 0, .45)'), ['rgba(0, 0, 0, .45) alpha'])
  assert.deepEqual(read('rgb(0, 0, 0)'), ['rgb(0, 0, 0) opaque'])
  assert.deepEqual(
    read('inset 2px 0 0 var(--color-accent)'),
    ['var(--color-accent) ref'],
    'a colour can arrive by reference, which is the whole of why this reads more than a hex',
  )
  assert.deepEqual(read('color-mix(in srgb, var(--color-accent) 24%, var(--color-bg))'), [
    'color-mix( opaque',
    'var(--color-accent) ref',
    'var(--color-bg) ref',
  ])
  assert.deepEqual(read('24px'), [], 'and it still says no when there is no colour there')
  assert.deepEqual(read('chat-pulse 1.1s ease-in-out infinite'), [])
  assert.deepEqual(
    read('var(--spacing-row)'),
    ['var(--spacing-row) ref'],
    'a reference is only a colour when what it names is one, and the fixpoint decides that, not this',
  )
})

/* ==================================================================
 * The census, and it is deliberately the last thing in the file.
 *
 * Coverage is computed from what the assertions above *did*, not from a list of
 * what they are supposed to do — `colorOf` records every token it resolves, and
 * this reads that set. So deleting an assertion deletes its coverage, which is
 * the property a hand-kept list cannot have: the palette went from fifteen
 * colours to thirty-six across the Tailwind migration and the audit stayed
 * exactly fifteen wide, silently, because nothing was counting.
 *
 * Last, therefore. node:test runs a file's tests in declaration order, so every
 * measurement has happened by the time this one starts. If that ever stops
 * being true this test fails loudly — it reports the whole palette as
 * unmeasured — rather than passing on an empty set, which is the direction an
 * ordering assumption has to be wrong in.
 * ================================================================== */

test('every colour in the palette is measured, or is written off in a sentence', () => {
  const palette = [...colourBearingTokens(VARS)].sort()
  const written = new Map(DECORATIVE_ONLY.map((entry) => [entry.token, entry.why]))

  // The ordering guard. A set this small means the tests above did not run,
  // and every conclusion below would be an artefact of that rather than a fact
  // about the palette.
  assert.ok(
    MEASURED.size > 20,
    `only ${String(MEASURED.size)} colours were resolved by the whole file, so the assertions above ` +
      `did not run before this one. Nothing here is a statement about the palette.`,
  )

  /*
   * The aperture guard, and it is not padding either. Everything below reports
   * "nothing uncovered" just as cheerfully when the palette it was handed is
   * empty, and a reader that stops seeing colours is this repo's most repeated
   * failure — the `> 20` above is the same guard pointed at the other end.
   * Bounded from below by the namespace the census used to read, so this can
   * only ever widen: if the value-shaped reading of the block ever finds fewer
   * tokens than the name-shaped one did, it has regressed to the bug it fixed.
   */
  const named = [...VARS.keys()].filter((name) => name.startsWith('--color-'))
  assert.ok(
    palette.length >= named.length && palette.length > 20,
    `the census found ${String(palette.length)} colour-bearing tokens where the --color- namespace ` +
      `alone holds ${String(named.length)}. It reads values rather than names precisely so that it ` +
      `is the larger of the two; a smaller number means \`colourTerms\` has stopped recognising ` +
      `colours and every assertion below is now about whatever is left.`,
  )

  /*
   * Covered, to a fixpoint: a token is covered if an assertion resolved it, if
   * it is written off, or if every colour in it arrives by `var()` from a token
   * that is itself covered. The third clause is the one that needs the reason —
   * a token that states no colour of its own introduces nothing to measure, and
   * the reference still has to land somewhere audited, so it is a derivation
   * rather than an exemption. --shadow-gutter-sel is the only one today.
   */
  const covered = new Set([...MEASURED, ...written.keys()])
  for (let pass = 0; pass < palette.length; pass += 1) {
    const before = covered.size
    for (const token of palette) {
      if (covered.has(token)) continue
      const terms = colourTerms(VARS.get(token) ?? '')
      if (terms.length > 0 && terms.every((t) => t.ref !== null && covered.has(t.ref))) covered.add(token)
    }
    if (covered.size === before) break
  }

  const uncovered = palette.filter((name) => !covered.has(name))
  assert.deepEqual(
    uncovered,
    [],
    `These tokens paint something and no assertion in this file has ever looked at them:\n` +
      `${uncovered.join('\n')}\n\n` +
      `A closed palette is not an audited palette. The two fences above prove there is no colour ` +
      `beyond this list; it proves nothing about the ones on it — --color-code-string was set to a ` +
      `value 1.03:1 against the block it is drawn on and this suite stayed green.\n\n` +
      `Nor is a colour only a colour when the token is named like one: five box shadows carried a ` +
      `hard-coded black through three rounds of this file for exactly that reason.\n\n` +
      `Add it to SURFACES with the ink drawn on it and the element where that happens, or — if ` +
      `nothing is ever read on it or in it — to DECORATIVE_ONLY with the sentence saying so.`,
  )

  /*
   * A written-off colour has to be one that could not have been measured.
   * Otherwise DECORATIVE_ONLY is a way to opt a measurable colour out of the
   * audit by writing a paragraph, which is the shape of every hole above.
   * `colorOf` already refuses an alpha for this reason and says so; this is the
   * same sentence, enforced from the other side.
   */
  const measurable: string[] = []
  for (const token of written.keys()) {
    for (const term of colourTerms(VARS.get(token) ?? '')) {
      if (term.ref !== null || term.translucent) continue
      measurable.push(`${token} → ${term.text}`)
    }
  }
  assert.deepEqual(
    measurable,
    [],
    `DECORATIVE_ONLY says nothing is ever read on these, and each of them states an *opaque* ` +
      `colour:\n${measurable.join('\n')}\n\n` +
      `"Nothing is read on it" is the reason a scrim or a drop shadow is written off, and it works ` +
      `because a colour with an alpha has no ratio until it lands on something — that is the same ` +
      `sentence \`colorOf\` refuses one with. An opaque colour has a ratio wherever it is drawn, so ` +
      `it can be measured and therefore has to be: put it in SURFACES against what it is drawn on. ` +
      `If it genuinely is a shadow, it is the wrong colour for one.`,
  )

  const gone = [...written.keys()].filter((token) => !palette.includes(token))
  assert.deepEqual(gone, [], `DECORATIVE_ONLY writes off colours @theme no longer defines:\n${gone.join('\n')}`)

  const both = [...written.keys()].filter((token) => MEASURED.has(token))
  assert.deepEqual(
    both,
    [],
    `DECORATIVE_ONLY says nothing is ever read on these, and an assertion above measures them:\n` +
      `${both.join('\n')}\n\nOne of the two is wrong, and it is not the measurement.`,
  )

  for (const [token, why] of written) {
    assert.ok(
      why.trim().length > 40,
      `${token} is written off without a reason worth reading. The same demand ALPHA_SITES makes: ` +
        `being outside the audit has to be a sentence somebody wrote.`,
    )
  }
})
