import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  attributeClassNames,
  blankComments,
  decomment,
  openingTags,
  stylesheets,
} from '../../__tests__/sourceScan'
import {
  ACTION_ID_PATTERN,
  BUTTON_MODIFIERS,
  BUTTON_MODIFIER_NAMES,
  BUTTON_VARIANTS,
  BUTTON_VARIANT_NAMES,
  CONTROL_BASE,
  CONTROL_SIZES,
  CONTROL_SIZE_NAMES,
  CONTROL_STATES,
  CONTROL_STATE_NAMES,
  LAYOUT_ONLY_PROPERTIES,
  MENU_ITEM_BASE,
  MENU_TONES,
  MENU_TONE_NAMES,
  variantClasses,
  type ButtonVariant,
  type ControlState,
} from '../spec'

/* ==================================================================
 * The control spec, as executable rules.
 *
 * Every rule in `spec.ts` that can be checked mechanically is checked here.
 * That distinction is the whole point of the file: a coding agent never gets a
 * code review, so a convention that only lives in prose is a convention that
 * does not apply to half the authors of this codebase. **If it is not in CI, it
 * is not a rule.**
 *
 * Every failure message below is written to say what to do next, not merely what
 * went wrong. An agent's one reliable channel for learning a codebase's rules is
 * the error it just hit; a message that only says `assertion failed` wastes it.
 *
 * Design record: docs/design/2026-08-02-control-spec.md §2.8
 * ================================================================== */

const UI = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(UI, '..')

const STYLESHEETS = stylesheets(RENDERER)

const DOC = 'docs/design/2026-08-02-control-spec.md'
const GUIDE = 'apps/desktop/src/renderer/ui/CLAUDE.md'

/* ------------------------------------------------------------------
 * Reading the sources
 * ------------------------------------------------------------------ */

function tsxFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
    out.push(join(entry.parentPath, entry.name))
  }
  return out.sort()
}

interface Rule {
  selectors: string[]
  properties: string[]
}

function rules(css: string): Rule[] {
  const out: Rule[] = []
  for (const m of decomment(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const properties = [...m[2].matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((p) => p[2])
    if (selectors.length > 0) out.push({ selectors, properties })
  }
  return out
}

interface Usage {
  file: string
  attrs: string
}

function buttonUsages(): Usage[] {
  const out: Usage[] = []
  for (const path of tsxFiles()) {
    const src = readFileSync(path, 'utf8')
    for (const attrs of openingTags(src, 'Button')) out.push({ file: relative(RENDERER, path), attrs })
  }
  return out
}

/** The value of a static `name="..."` attribute, if there is one. */
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
}

/**
 * The `className` value on an opening tag, as source, or `undefined` if it has
 * none. A braced expression comes back without its outer braces; a quoted
 * attribute comes back with its quotes.
 *
 * Braces are matched by depth rather than by pattern, for the same reason
 * `openingTags` finds its own closing bracket that way: `className={cond ? f({
 * a }) : ''}` legitimately nests them, and stopping at the first `}` truncates
 * the expression into something that reads as simpler than it is.
 */
function classNameExpression(attrs: string): string | undefined {
  const src = blankComments(attrs)
  const m = /\bclassName\s*=\s*/.exec(src)
  if (!m) return undefined
  const i = m.index + m[0].length
  if (src[i] === '{') {
    let depth = 0
    let j = i
    for (; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1
      else if (src[j] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    return attrs.slice(i + 1, j)
  }
  if (src[i] === '"' || src[i] === "'") {
    const end = src.indexOf(src[i], i + 1)
    return end === -1 ? undefined : attrs.slice(i, end + 1)
  }
  return undefined
}

/**
 * The expression with every string literal deleted and every template
 * interpolation kept, so what is left is only the code that *decides* which
 * literal wins.
 *
 * Written by hand rather than reached for from `sourceScan`, and the difference
 * is the whole point: `blankNonCode` treats a template as one literal and erases
 * its interpolations along with its text, which is precisely where an opaque
 * term hides. Using it here would report a clean skeleton for the one shape this
 * check exists to catch.
 */
function withoutLiterals(expression: string): string {
  let out = ''
  let i = 0
  while (i < expression.length) {
    const c = expression[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < expression.length && expression[j] !== c) {
        if (expression[j] === '\\') j += 1
        j += 1
      }
      out += ' '
      i = j + 1
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < expression.length && expression[j] !== '`') {
        if (expression[j] === '\\') {
          j += 2
          continue
        }
        if (expression[j] === '$' && expression[j + 1] === '{') {
          let depth = 0
          let k = j + 1
          for (; k < expression.length; k += 1) {
            if (expression[k] === '{') depth += 1
            else if (expression[k] === '}') {
              depth -= 1
              if (depth === 0) break
            }
          }
          out += ` ${withoutLiterals(expression.slice(j + 2, k))} `
          j = k + 1
          continue
        }
        j += 1
      }
      i = j + 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * Words that contribute a class list nobody can read from here.
 *
 * The rule is positional and needs no parser: in a className expression an
 * identifier is either a **test** — the thing before a `?`, an `&&`, a
 * comparison — or it is a **value**, and a value is a class list arriving from
 * somewhere this file cannot see. So an identifier followed by one of the
 * operators below is fine, and an identifier followed by anything else (a `}`, a
 * `:`, a `(`, a `+`) is reported.
 *
 * `true` / `false` / `null` / `undefined` are values, but they are the values
 * that render no class at all, which is why they are excused by name rather than
 * by shape.
 */
const TEST_POSITION = /^[?.=!<>&|]/
const NOT_A_CLASS = new Set(['true', 'false', 'null', 'undefined', 'void', 'typeof'])

function opaqueTerms(expression: string): string[] {
  const code = withoutLiterals(expression)
  const out: string[] = []
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (NOT_A_CLASS.has(m[0])) continue
    if (TEST_POSITION.test(code.slice(m.index + m[0].length).trimStart())) continue
    out.push(m[0])
  }
  return out
}

/* ------------------------------------------------------------------
 * 0 — the checker itself
 *
 * Every rule below is only as true as the scanner that feeds it, and that
 * scanner shipped with a hole: it matched tag names on raw source and only began
 * tracking comments *after* a match, so a `<button>` written in prose counted as
 * an element. Testing the test is not ceremony here — it is the difference
 * between a boundary and the appearance of one.
 * ------------------------------------------------------------------ */

describe('the scanner reads code, not prose', () => {
  const FIXTURE = [
    '/**',
    ' * A `div` with role="tab" rather than a `<button>`, for a plain HTML reason.',
    ' */',
    'export function X() {',
    '  // A bare <button> here would bypass the spec.',
    '  const help = "write <Button variant=\\"danger\\"> instead"',
    '  return (',
    '    <Button variant="danger" action="conn.forget">',
    '      {/* <button> in a JSX comment */}',
    '      Remove',
    '    </Button>',
    '  )',
    '}',
  ].join('\n')

  test('a tag named in a comment or a string is not an element', () => {
    assert.deepEqual(
      openingTags(FIXTURE, 'button'),
      [],
      'prose mentioning <button> was counted as a bare button — the migration ledger can then ' +
        'never shrink past it, and a file that is fully migrated stays exempt for good',
    )
    assert.equal(
      openingTags(FIXTURE, 'Button').length,
      1,
      'exactly one real <Button> is present; a comment and a string literal also name one',
    )
  })

  test('attribute values survive the blanking', () => {
    // The scan runs over a blanked copy but slices from the original. Getting
    // this backwards is silent: every `action` and `exposure` reads as empty,
    // every assertion about them passes, and nothing anywhere reports a problem.
    const [attrs] = openingTags(FIXTURE, 'Button')
    assert.equal(attr(attrs, 'variant'), 'danger')
    assert.equal(attr(attrs, 'action'), 'conn.forget')
  })

  test('the permission boundary cannot be satisfied by a sentence', () => {
    // The tripwire asserts PermissionPrompt still renders a <Button>. If prose
    // counted, reverting the file to bare <button> while leaving a comment that
    // mentions <Button> would keep every check in this file green — including
    // the one that stops an agent being handed its own approval dialog.
    const decoy = '// this file used to render <Button exposure="agent-ok"> here\nconst x = 1\n'
    assert.deepEqual(openingTags(decoy, 'Button'), [])
  })
})

/* ------------------------------------------------------------------
 * 1 & 2 — the spec is complete in itself
 *
 * Until the Tailwind migration these sections read `ui/controls.css` and
 * `ui/menu.css` and asserted that a selector existed for every variant × state
 * the spec declared. Those files are gone; a variant is a string of utility
 * classes in `spec.ts` now. **The contract is unchanged and so is its strength**
 * — five states, none of them optional — only what is read has moved, from a
 * selector list to a class list. `hover:not-disabled:` compiles to exactly the
 * `:hover:not(:disabled)` the old assertion looked for.
 * ------------------------------------------------------------------ */

/** The classes in `spec` that speak for `state`, by their variant prefix. */
function forState(spec: string, state: ControlState): string[] {
  const { variant } = CONTROL_STATES[state]
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => (variant === '' ? !name.includes(':') : name.startsWith(variant)))
}

/** A class with its variant prefix stripped: `hover:not-disabled:bg-x` → `bg-x`. */
function bare(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1)
}

const PER_VARIANT = CONTROL_STATE_NAMES.filter((s) => CONTROL_STATES[s].perVariant)
const SHARED = CONTROL_STATE_NAMES.filter((s) => !CONTROL_STATES[s].perVariant)

describe('the spec is complete in itself', () => {
  test('every variant states an intent', () => {
    for (const name of BUTTON_VARIANT_NAMES) {
      const { intent } = BUTTON_VARIANTS[name]
      assert.ok(
        intent.trim().length > 20,
        `Variant "${name}" has no usable \`intent\`.\n` +
          `\`intent\` is the sentence an agent reads to choose this variant over the others — ` +
          `it is not documentation garnish. A variant nobody can describe in one line is a variant ` +
          `named after its colour, which is what ${DOC} §1.5 exists to prevent.`,
      )
    }
  })

  test('every modifier states one too', () => {
    for (const name of BUTTON_MODIFIER_NAMES) {
      const { intent } = BUTTON_MODIFIERS[name as keyof typeof BUTTON_MODIFIERS]
      assert.ok(
        intent.trim().length > 20,
        `Modifier "${name}" has no usable \`intent\`. A modifier is a claim about what the control ` +
          `has to survive; one nobody can state is a variant in disguise.`,
      )
    }
  })
})

describe('the variant strings cover the whole matrix', () => {
  for (const variant of BUTTON_VARIANT_NAMES) {
    test(`${variant} defines all ${PER_VARIANT.length} of its own states`, () => {
      const spec = variantClasses(variant)
      const missing = PER_VARIANT.filter((state) => forState(spec, state).length === 0)
      assert.deepEqual(
        missing,
        [],
        `Variant "${variant}" is missing ${missing.length} state(s): ${missing.join(', ')}.\n` +
          `Add to BUTTON_VARIANTS.${variant} in ui/spec.ts — a background belongs in \`surface\`, ` +
          `a border or a text colour in \`classes\`:\n` +
          missing.map((s) => `  ${CONTROL_STATES[s].variant}bg-…`).join('\n') +
          `\n\nA variant with no \`active:\` gives no feedback when pressed, and one with no ` +
          `\`hover:\` falls back to the base grey mid-gesture — a danger button that stops looking ` +
          `dangerous exactly while the pointer is on it. Half a variant is why this test exists.`,
      )
    })
  }

  test('the base carries the two states no variant should restate', () => {
    const missing = SHARED.filter((state) => forState(CONTROL_BASE, state).length === 0)
    assert.deepEqual(
      missing,
      [],
      `CONTROL_BASE is missing ${missing.join(', ')}.\n` +
        `These are marked \`perVariant: false\`, which means every button in the product depends on ` +
        `this one string for them. \`focus-visible\` is the one that disappears silently: tab ` +
        `through the window and the caret is simply nowhere.`,
    )
  })

  test('both size rungs state a whole shape', () => {
    for (const size of CONTROL_SIZE_NAMES) {
      const rung = CONTROL_SIZES[size]
      for (const [field, spec] of [
        ['classes', rung.classes],
        ['iconClasses', rung.iconClasses],
      ] as const) {
        assert.ok(
          /(^|\s)(min-h-|h-)/.test(spec),
          `CONTROL_SIZES.${size}.${field} sets no height. A rung that does not is not a rung.`,
        )
        assert.ok(
          /(^|\s)p[xy]?-/.test(spec),
          `CONTROL_SIZES.${size}.${field} sets no padding.\n` +
            `A rung states a whole shape, padding included — it cannot leave the icon case to be ` +
            `patched with a \`p-0\` layered over it, because Tailwind emits \`px-*\` after \`p-*\` ` +
            `and the patch would lose. See the header of ui/spec.ts.`,
        )
      }
    }
  })
})

describe('the menu tones cover the whole matrix', () => {
  /*
   * The same contract the button variants are held to, for the other primitive.
   *
   * `<Menu>`'s lines are not `<Button>`s — a menu item undoes almost everything
   * a button declares — so they get their own two-value scale (`MENU_TONES`).
   * What does *not* change is the completeness rule: a tone that defines three
   * of the five states is half a tone, and the missing halves are always
   * `:active` and `:focus-visible`, which are exactly the two nobody notices
   * until a keyboard user cannot see where they are.
   */
  for (const tone of MENU_TONE_NAMES) {
    test(`${tone} defines all ${PER_VARIANT.length} of its own states`, () => {
      const missing = PER_VARIANT.filter((state) => forState(MENU_TONES[tone].classes, state).length === 0)
      assert.deepEqual(
        missing,
        [],
        `Menu tone "${tone}" is missing ${missing.join(', ')}.\n` +
          `Add them to MENU_TONES.${tone}.classes in ui/spec.ts.`,
      )
    })
  }

  test('the menu base carries the shared states', () => {
    const missing = SHARED.filter((state) => forState(MENU_ITEM_BASE, state).length === 0)
    assert.deepEqual(
      missing,
      [],
      `MENU_ITEM_BASE is missing ${missing.join(', ')}. The arrow keys move real focus between ` +
        `these lines, so a menu with no focus ring cannot be driven without a pointer at all.`,
    )
  })
})

describe('the control layer has left the stylesheets', () => {
  test('no sheet styles a class the primitives stopped emitting', () => {
    // What `no stray .btn-*` used to say, now that the answer is "none at all".
    // Both namespaces are empty: `<Button>` emits utilities and `<Menu>` emits
    // utilities, so a rule here cannot reach anything. It is either dead weight
    // or — the case worth catching — a variant being reinvented in CSS by
    // somebody who did not find `spec.ts`, which is the failure the control
    // spec's §1.2 documents.
    const stray = new Set<string>()
    for (const sheet of STYLESHEETS) {
      for (const rule of rules(readFileSync(join(RENDERER, sheet), 'utf8'))) {
        for (const selector of rule.selectors) {
          for (const m of selector.matchAll(/\.(btn[a-zA-Z0-9_-]*|menu-item[a-zA-Z0-9_-]*)/g)) {
            stray.add(`${sheet} → .${m[1]}`)
          }
        }
      }
    }
    assert.deepEqual(
      [...stray],
      [],
      `These rules style the control layer from a stylesheet:\n${[...stray].join('\n')}\n\n` +
        `Nothing wears those names any more. Declare the variant in BUTTON_VARIANTS or the tone in ` +
        `MENU_TONES — with an intent, and all five states — or give it a name outside the ` +
        `btn-/menu-item- namespaces. See ${GUIDE}.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 3 — a press has to feel like a press
 * ------------------------------------------------------------------ */

/** The theme's custom properties, resolved one level deep. */
function rootVars(): Map<string, string> {
  // The `@theme` block, which is where `styles.css`'s `:root` went in the
  // Tailwind migration. Same tokens, `--color-` prefixed. It spent a day in a
  // `theme.css` of its own; the eight sheets are one `styles.css` again (§11.1).
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(readFileSync(join(RENDERER, 'styles.css'), 'utf8'))
  assert.ok(block, 'styles.css must contain an @theme block')
  const out = new Map<string, string>()
  for (const line of decomment(block[1]).split('\n')) {
    const decl = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (decl) out.set(decl[1], decl[2].trim())
  }
  return out
}

type Rgb = [number, number, number]

/** Resolve the small set of colour syntaxes the theme actually uses. */
function resolveColor(value: string, vars: Map<string, string>): Rgb | null {
  const raw = value.trim()
  if (raw === 'transparent') return null

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\)$/.exec(raw)
  if (mix) {
    const a = resolveColor(mix[1], vars)
    const b = resolveColor(mix[3], vars)
    if (!a || !b) return null
    const w = Number(mix[2]) / 100
    return [0, 1, 2].map((i) => a[i] * w + b[i] * (1 - w)) as Rgb
  }

  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw)
  if (ref) {
    const v = vars.get(ref[1])
    return v === undefined ? null : resolveColor(v, vars)
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    const n = Number.parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return null
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const VARS = rootVars()

/**
 * The one background `spec` sets for `state`, resolved to RGB.
 *
 * The `length === 1` assertion is not defensive tidiness — it is the migration's
 * central hazard stated mechanically. Two `bg-*` classes in one string resolve
 * in whatever order Tailwind emitted the two rules, which the author does not
 * control and cannot read; the surface would then be decided somewhere nobody is
 * looking. It is why `surface` is a field of its own.
 */
function background(label: string, spec: string, state: ControlState): Rgb | null {
  const hits = forState(spec, state).filter((name) => bare(name).startsWith('bg-'))
  assert.equal(
    hits.length,
    1,
    `${label} sets ${String(hits.length)} backgrounds for \`${state}\` (${hits.join(', ') || 'none'}).\n` +
      `Exactly one, always: a class list has no cascade, so two of them is a coin flip decided by ` +
      `Tailwind's emission order, and none of them leaves the state to fall through to the base.`,
  )
  const value = bare(hits[0]).slice('bg-'.length)
  if (value === 'transparent') return null
  const token = `--color-${value}`
  assert.ok(VARS.has(token), `${label} names \`bg-${value}\`, and ${token} is not in @theme`)
  return resolveColor(`var(${token})`, VARS)
}

describe('hover and active are not the same gesture', () => {
  /*
   * This rule was written in the old stylesheet as prose — "press states darken
   * while hover lightens" — and the very first two variants written under it
   * broke it: `danger` and `caution` mixed *more* of their hue into the press,
   * which made the pressed state lighter than the hover. A screenshot caught it.
   *
   * A screenshot catching it is exactly the failure mode this whole layer exists
   * to remove: it means the rule held only as long as someone happened to look.
   * The invariant below is the part that can be stated mechanically — hover is
   * the brightest of the three, and a press moves back down from it. Whether the
   * press lands above or below rest is left free, because for a dark surface
   * tinted with red or amber it legitimately does not.
   *
   * The mixes it resolves used to be written inline in `controls.css`; they are
   * `--color-*-hover` / `--color-*-active` tokens now, for the plain reason that
   * a utility class cannot hold a `color-mix()`. Same arithmetic, one hop later.
   */
  const surfaces: [string, string][] = [
    ...BUTTON_VARIANT_NAMES.map((v): [string, string] => [v, variantClasses(v)]),
    // `elevated` was never covered here, and it moves through three surfaces
    // like any variant. It is one string now, so there is no reason not to.
    ['elevated', BUTTON_MODIFIERS.elevated.classes],
  ]

  for (const [label, spec] of surfaces) {
    test(`${label} lightens on hover and comes back down on press`, () => {
      const rest = background(label, spec, 'rest')
      const hover = background(label, spec, 'hover')
      const active = background(label, spec, 'active')

      assert.ok(hover, `${label} hover must set a background this test can resolve`)
      assert.ok(active, `${label} active must set a background this test can resolve`)

      assert.ok(
        luminance(hover) > luminance(active),
        `${label}: the pressed state is lighter than the hovered one ` +
          `(${luminance(hover).toFixed(4)} vs ${luminance(active).toFixed(4)}).\n` +
          `A press that brightens reads as another hover — there is no acknowledgement in it. ` +
          `Derive the active token from a darker surface (--color-bg-1) rather than from more of ` +
          `the variant's hue.`,
      )

      // `ghost` rests on transparent, so there is nothing to compare it against.
      if (rest) {
        assert.ok(
          luminance(hover) > luminance(rest),
          `${label} hover is not lighter than its resting state; nothing happens under the pointer.`,
        )
      }
    })
  }
})

/**
 * The `border-style` keywords Tailwind v4 spells as `border-<keyword>`.
 *
 * One set, read by both of the sections below, and that is the whole point of
 * hoisting it here. The colour census needs it to know that `border-dashed` is
 * not a colour with a missing token; §3b needs it to know that a value which is
 * neither a width nor a colour is a *style* and which style it is. When those
 * two lists were separate — a literal in the census, "whatever is left" in
 * §3b — the census rejected `border-double` with a message telling the author to
 * add `--color-double` to the theme, and taking that advice was impossible while
 * simply adding the word to the census set let the class through into a section
 * that then read it as a fourth distinct edge shape. A correct rejection with a
 * misleading reason is an invitation, and this is where it was accepted.
 *
 * Six keywords, which is Tailwind's whole set: CSS also has `groove`, `ridge`,
 * `inset` and `outset`, and no utility spells any of them. A class naming one
 * would fail here, correctly — there is no rule for it to compile to.
 */
const BORDER_STYLE_KEYWORDS: ReadonlySet<string> = new Set([
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'none',
])

describe('no atomic class invents a colour', () => {
  /*
   * A wrong colour name used to be a *missing* colour rather than an unaudited
   * one — the `--color-*` reset made it generate nothing, so it was visible the
   * first time anybody looked. That reset is gone (§29.10) and a wrong name now
   * paints something plausible instead, which makes this net matter more rather
   * than less. It has a hole exactly here:
   * `spec.ts` is the one file where nobody looks at each string individually,
   * because one of them paints eighty-seven call sites at once and the gallery
   * shows five of them.
   *
   * So every colour these strings name is checked against `@theme` directly.
   * `theme-contrast.test.ts` then audits the token itself; between the two, a
   * colour reaching the screen without passing a contrast assertion has nowhere
   * left to enter.
   */
  /*
   * Words that follow a colour family's prefix without being colours. The
   * border-style half is not restated here — it is `BORDER_STYLE_KEYWORDS`
   * above, so that this census and §3b can never disagree about what a keyword
   * is. They did, and the message below is written to say which of the two
   * lists an offender belongs on.
   */
  const KEYWORDS = new Set([
    ...BORDER_STYLE_KEYWORDS,
    'transparent',
    'current',
    'inherit',
    'left',
    'right',
    'center',
  ])
  /**
   * The type half of the `text-` prefix, read from Tailwind rather than listed.
   *
   * It was a literal `['sm', 'md', 'lg', 'data', 'mark']` and it went stale the
   * hour the bespoke scale was replaced by Tailwind's (§29.10.2): `text-xs`
   * arrived, this set had never heard of it, and the census reported a control
   * asking for a colour token named `--color-xs`. A hardcoded copy of somebody
   * else's vocabulary is a copy that will be wrong on the day the vocabulary
   * changes, which is exactly the day you need it to be right.
   *
   * It read Tailwind's `theme.css` for one round, on the reasoning that the
   * widest possible vocabulary was the safe one here — the question is only "is
   * this `text-` class a size rather than a colour", and whether it is a size
   * this product is *allowed* to write is `type-scale.test.ts`'s question.
   *
   * That source is empty now. §32 clears Tailwind's ladder with `--text-*:
   * initial` and mints five named rungs, so the product's own `@theme` is the
   * only place the vocabulary exists — and the same reader kept pointing at the
   * old file reported `text-micro` as a control asking for `--color-micro`,
   * which is the identical failure the paragraph above is about, one source
   * over. A reader that survives its source being emptied is the thing to want,
   * so this one asserts it read something.
   */
  const TYPE_RUNGS = new Set(
    [...readFileSync(join(RENDERER, 'styles.css'), 'utf8').matchAll(/^\s*--text-([a-z0-9]+)\s*:/gm)].map(
      (m) => m[1],
    ),
  )
  assert.ok(
    TYPE_RUNGS.size >= 4,
    `read only ${String(TYPE_RUNGS.size)} type rungs out of styles.css; the reader is broken`,
  )

  const strings: [string, string][] = [
    ['CONTROL_BASE', CONTROL_BASE],
    ['MENU_ITEM_BASE', MENU_ITEM_BASE],
    ...BUTTON_VARIANT_NAMES.map((v): [string, string] => [`BUTTON_VARIANTS.${v}`, variantClasses(v)]),
    ['BUTTON_MODIFIERS.elevated', BUTTON_MODIFIERS.elevated.classes],
    ...MENU_TONE_NAMES.flatMap((t): [string, string][] => [
      [`MENU_TONES.${t}`, MENU_TONES[t].classes],
      [`MENU_TONES.${t}.noteClasses`, MENU_TONES[t].noteClasses],
    ]),
    ...CONTROL_SIZE_NAMES.flatMap((s): [string, string][] => [
      [`CONTROL_SIZES.${s}`, CONTROL_SIZES[s].classes],
      [`CONTROL_SIZES.${s}.iconClasses`, CONTROL_SIZES[s].iconClasses],
    ]),
  ]

  test('every colour a control names is a token in @theme', () => {
    const unknown: string[] = []
    for (const [label, spec] of strings) {
      for (const name of spec.split(/\s+/).filter(Boolean)) {
        const m = /^(bg|text|border|outline|shadow)-(.+)$/.exec(bare(name))
        if (!m) continue
        const value = m[2]
        if (KEYWORDS.has(value) || /^-?[\d.]+$/.test(value) || value.startsWith('offset-')) continue
        // `text-sm` is the type ladder wearing the same prefix; it answers to
        // type-scale.test.ts, not to the palette.
        if (m[1] === 'text' && TYPE_RUNGS.has(value)) continue
        const token = m[1] === 'shadow' ? `--shadow-${value}` : `--color-${value}`
        if (VARS.has(token)) continue
        // The border family is the one that accepts two vocabularies, so it is
        // the one whose rejection has to name both of them. Reporting it as a
        // missing colour is how `border-double` was let in: the message asked
        // for a token that cannot exist, and the only way to satisfy it was to
        // widen the keyword set — which is the other half of this check.
        unknown.push(
          m[1] === 'border'
            ? `${label} → \`${name}\`: \`${value}\` is neither a colour ${token} names nor a ` +
                `border-style keyword (${[...BORDER_STYLE_KEYWORDS].join(', ')})`
            : `${label} → \`${name}\` wants ${token}`,
        )
      }
    }
    assert.deepEqual(
      unknown,
      [],
      `These classes name something @theme does not define:\n${unknown.join('\n')}\n\n` +
        `This check used to rest on \`--color-*: initial\`: a name the theme did not have generated ` +
        `no CSS at all, so the control silently lost that colour and the gallery or a user found ` +
        `out. That reset is gone (§29.10) and the failure mode inverted — an unknown name now most ` +
        `likely resolves to one of Tailwind's 288 defaults and paints something plausible that no ` +
        `contrast audit has ever looked at. Quieter, and worse. Add the token to the @theme block ` +
        `in styles.css, where theme-contrast.test.ts audits it, or use one that exists.\n\n` +
        `A line reporting a \`border-*\` class as neither a colour nor a keyword is **not** an ` +
        `invitation to add the word to BORDER_STYLE_KEYWORDS. That set is read by §3b below, which ` +
        `reasons about what each keyword *paints*; a seventh member arriving without that reasoning ` +
        `is a new edge shape the hue-free census would count as a real separation on the strength of ` +
        `its spelling. Teach both, or use a keyword that is already there.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 3b — two variants, with the hue taken away
 *
 * `spec.ts` says `caution` draws a broken edge "because it must be
 * distinguishable from `danger` without relying on hue: red-versus-amber is one
 * of the two pairs a red-green colour-blind user cannot separate". Until this
 * section existed that sentence *was* the enforcement. Delete the utility that
 * breaks the edge and all 727 renderer cases stayed green — an accessibility
 * property standing on a comment, in the layer whose own premise is that a rule
 * with no collection point *is* a comment and comments get routed around.
 *
 * What is asserted here is deliberately **not** "caution wears that class".
 * That pins the implementation instead of the property, and it would stay green
 * if somebody broke `danger`'s edge as well — at which point the pair is
 * identical again, the reason the class exists has been undone, and the
 * assertion never noticed. What is asserted is the *distinction*: every pair of
 * variants must differ in something a greyscale copy still shows.
 *
 * ## The four channels, and why only four
 *
 * A class string can only be honest about form. These are the separations that
 * can be read out of one and that survive the loss of hue:
 *
 *   fill    — whether the surface paints at all, or the control is see-through
 *   edge    — whether the border paints at all
 *   style   — what the border's edge *looks* like: unbroken, broken, or blank
 *   width   — how thick the border is
 *
 * `style` is read as a rendering and not as a keyword, and that distinction is
 * load-bearing rather than pedantic. `border-double` at 1px is not a double
 * line: CSS leaves the sub-3px case implementation-defined and Chromium draws
 * one unbroken line. Measured in Electron's own Chromium, a cross-section of the
 * top border at device scale 2, `#b4b4b4` on black:
 *
 *   width 1px   solid [156,156,41,0]              double [156,156,41,0]
 *   width 2px   solid [143,197,197,143,37,0]      double [143,197,197,143,37,0]
 *   width 3px   solid [143,193,184,184,193,143]   double [156,152,28,28,152,156]
 *
 * Byte-identical below 3px; the 28s at 3px are the gap between the two lines.
 * `none` and `hidden` paint nothing at any width, and so does any keyword at
 * width 0. So the keyword is folded through `painted()` before it is compared,
 * and a pair that "differs in style" differs in something a greyscale screenshot
 * would show. Reading the keyword instead let `caution`'s dashed edge be swapped
 * for a double one — three of its four pairs still recorded `style`, the whole
 * suite green, and the two variants identical on screen.
 *
 * A channel counts only if it differs in **every** state both variants can be
 * seen in. A difference that exists at rest and closes under the pointer tells
 * two moments apart, not two controls.
 *
 * ## What this does not cover, stated rather than implied
 *
 *  - **A glyph.** A leading mark in the label is a perfectly good hue-free
 *    signal, and it is not in the class string at all — it is in the caller's
 *    children. A variant that separated itself that way would read here as
 *    unseparated. That is the safe direction to be wrong in, but it is a false
 *    alarm waiting to happen, so it is written down rather than discovered.
 *  - **Type weight, tracking, a different rung.** Readable in principle, used by
 *    no variant today, and left out rather than added as machinery with nothing
 *    to say.
 *  - **A simulated colour-vision deficiency.** The ratios below are WCAG
 *    relative luminance, the standard stand-in for "what is left when hue goes".
 *    That is not a protanope's or a deuteranope's percept, and a number here is
 *    evidence rather than a certificate. The check that goes with it is a
 *    greyscale screenshot of `Gallery.tsx`; the design record says what it
 *    showed and that is the part a test cannot replace.
 *  - **Anything reaching the control from outside the two strings read here.**
 *    Those two are `CONTROL_BASE` and the variant's own `classes` + `surface`,
 *    which is what `variantSpec` composes. `Button.tsx` puts two more strings on
 *    the element and this section reads neither, for two different reasons that
 *    are worth separating because only one of them is safe:
 *
 *      · the **size rung** carries no paint — height, padding, gap and, on `sm`,
 *        a type rung. Nothing it sets is one of the four channels, so leaving it
 *        out costs nothing.
 *      · **`elevated` replaces `surface`.** It is not a fifth slot layered on
 *        top; `variantClasses` and the modifier are alternatives, which is the
 *        entire reason `surface` is a field of its own (see the head of
 *        `ui/spec.ts`). Under it *every* variant is filled with the same
 *        `bg-bg-3`, so any pair whose only hue-free separation is `fill` has
 *        none at all as soon as both members are elevated.
 *
 *    The second is a real hole and is closed by an assertion rather than by this
 *    sentence: a row measuring exactly `['fill']` is refused below. Recording it
 *    would be reporting a separation the product can erase with a modifier.
 *    A `className` from the caller is layout-only, and §4 is the fence for that.
 * ------------------------------------------------------------------ */

type Channel = 'fill' | 'edge' | 'style' | 'width'

const CHANNELS: readonly Channel[] = ['fill', 'edge', 'style', 'width']

/** One variant in one state, with hue thrown away. */
type Form = Record<Channel, string>

/**
 * What one class says about a control's form, if anything.
 *
 * The border families are told apart by their **value**: a number is a width,
 * `transparent` is the absence of an edge, a name the theme defines is a colour,
 * and a style keyword must be one this file knows — `BORDER_STYLE_KEYWORDS`,
 * shared with the colour census above so the two can never disagree.
 *
 * "Whatever is left is a style keyword" is what this used to say, and it was the
 * quiet half of the same hole. It gave every unrecognised value a channel and a
 * distinct value, so a per-side border (`border-t`) or a typo would have read as
 * a fourth edge shape and separated its pair on the strength of being unknown.
 * Now it refuses. The header promised the author would be told to teach this
 * function rather than be handed a wrong answer; this is that promise, kept.
 */
function formRole(name: string): { channel: Channel; value: string } | null {
  if (name.startsWith('bg-')) {
    return { channel: 'fill', value: name.slice('bg-'.length) === 'transparent' ? 'clear' : 'filled' }
  }
  if (name === 'border') return { channel: 'width', value: '1' }
  const m = /^border-(.+)$/.exec(name)
  if (m === null) return null
  const value = m[1]
  if (/^\d+(\.\d+)?$/.test(value)) return { channel: 'width', value }
  if (value === 'transparent') return { channel: 'edge', value: 'absent' }
  if (VARS.has(`--color-${value}`)) return { channel: 'edge', value: 'present' }
  assert.ok(
    BORDER_STYLE_KEYWORDS.has(value),
    `\`${name}\` is not a border width, not a colour @theme names, and not one of the border-style ` +
      `keywords (${[...BORDER_STYLE_KEYWORDS].join(', ')}).\n` +
      `This section reads a control's form out of its class string, so a value it does not ` +
      `understand cannot be given a channel — it would separate its pair by being unrecognised, ` +
      `which is a separation nobody can see. A per-side border (\`border-t\`) is the likely case and ` +
      `it needs a real decision: a top edge and a full edge are different shapes and the four ` +
      `channels have no way to say so yet. Teach formRole first.`,
  )
  return { channel: 'style', value }
}

/**
 * A border-style keyword as the thing it *paints* at a given width.
 *
 * The three foldings, each measured rather than reasoned about — see the numbers
 * in the section header:
 *
 *   - `double` under 3px is one unbroken line, byte for byte the same pixels as
 *     `solid`. CSS says the sub-3px case is implementation-defined; this is what
 *     Chromium does with it.
 *   - `none` and `hidden` paint nothing. They are not two blanks, they are one.
 *   - at width 0 there is no edge to carry a keyword, so every keyword is blank.
 *
 * A keyword added to `BORDER_STYLE_KEYWORDS` without a line here is the failure
 * this function exists to prevent, which is why the census's message says to
 * teach both.
 */
function painted(style: string, width: string): string {
  if (style === 'none' || style === 'hidden' || Number(width) === 0) return 'blank'
  if (style === 'double' && Number(width) < 3) return 'solid'
  return style
}

/** The colour token a variant paints in one role, or `null` where it paints none. */
function colourRole(name: string): { role: 'surface' | 'border' | 'ink'; token: string } | null {
  for (const [prefix, role] of [
    ['bg-', 'surface'],
    ['text-', 'ink'],
    ['border-', 'border'],
  ] as const) {
    if (!name.startsWith(prefix)) continue
    const value = name.slice(prefix.length)
    return VARS.has(`--color-${value}`) ? { role, token: `--color-${value}` } : null
  }
  return null
}

/** Everything a `<Button>` of this variant wears that is not its size rung. */
function variantSpec(variant: ButtonVariant): string {
  return `${CONTROL_BASE} ${variantClasses(variant)}`
}

/**
 * Read one variant's form in one state.
 *
 * A state that does not restate a role keeps the unprefixed class, because that
 * is what a Tailwind variant *is* — a second rule on the same element, not a
 * replacement string. So every channel falls back to `rest`, and `danger`, which
 * recolours only its border under the pointer, still reads as filled and edged
 * in all three states rather than as a control that loses its surface on hover.
 */
function formOf(variant: ButtonVariant, state: ControlState): Form {
  const spec = variantSpec(variant)

  const read = (from: ControlState): Partial<Form> => {
    const seen: Partial<Form> = {}
    for (const name of forState(spec, from)) {
      const hit = formRole(bare(name))
      if (hit === null) continue
      assert.equal(
        seen[hit.channel],
        undefined,
        `Variant "${variant}" sets \`${hit.channel}\` twice in its \`${from}\` classes ` +
          `(${seen[hit.channel] ?? ''} and ${hit.value}).\n` +
          `A class list has no cascade, so which of the two paints is Tailwind's emission order ` +
          `rather than yours — the rule at the head of ui/spec.ts. State one shape per state.`,
      )
      seen[hit.channel] = hit.value
    }
    return seen
  }

  const own = read(state)
  const rest = state === 'rest' ? own : read('rest')
  const width = own.width ?? rest.width ?? '0'
  return {
    fill: own.fill ?? rest.fill ?? 'clear',
    edge: own.edge ?? rest.edge ?? 'absent',
    // `--tw-border-style` is registered with an initial value of `solid`, so a
    // bare width utility draws an unbroken line with no Preflight. Checked in
    // the built stylesheet — see the head of styles.css.
    //
    // Folded through `painted` because the channel is what the edge looks like,
    // not what the class is called: the keyword and the width decide the
    // rendering together, and comparing keywords let a 1px `double` — which
    // Chromium draws as a plain solid line — count as a shape of its own.
    style: painted(own.style ?? rest.style ?? 'solid', width),
    width,
  }
}

/** The channels that separate two variants in *every* state they can both be seen in. */
function formChannels(a: ButtonVariant, b: ButtonVariant): Channel[] {
  return CHANNELS.filter((channel) =>
    PER_VARIANT.every((state) => formOf(a, state)[channel] !== formOf(b, state)[channel]),
  )
}

/**
 * How far apart two variants are once hue is gone: the strongest achromatic
 * separation the pair has, measured in its **weakest** state.
 *
 * Per state, each of the three colour roles is compared against its opposite
 * number as a WCAG relative-luminance contrast ratio, and the best of the three
 * is that state's separation. The pair's number is the worst of those, because a
 * pair that is only told apart while at rest is not told apart.
 *
 * A role either side leaves unpainted contributes nothing — `ghost` rests on
 * whatever is behind it, and that is not knowable from here. Conservative on
 * purpose: it can understate a pair's separation, never overstate it.
 */
function apart(a: ButtonVariant, b: ButtonVariant): number {
  const colours = (variant: ButtonVariant, state: ControlState): Map<string, Rgb> => {
    const spec = variantSpec(variant)
    const out = new Map<string, Rgb>()
    for (const from of [state, 'rest'] as const) {
      for (const name of forState(spec, from)) {
        const hit = colourRole(bare(name))
        if (hit === null || out.has(hit.role)) continue
        const rgb = resolveColor(`var(${hit.token})`, VARS)
        if (rgb !== null) out.set(hit.role, rgb)
      }
    }
    return out
  }

  const perState = PER_VARIANT.map((state) => {
    const left = colours(a, state)
    const right = colours(b, state)
    const ratios = [...left].flatMap(([role, rgb]) => {
      const other = right.get(role)
      if (other === undefined) return []
      const [x, y] = [luminance(rgb), luminance(other)]
      return [(Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)]
    })
    return ratios.length === 0 ? 1 : Math.max(...ratios)
  })
  return Math.min(...perState)
}

/**
 * Every unordered pair of variants, and what keeps the two apart when the colour
 * is taken out of the question.
 *
 * `form` is the recorded answer, and it is recorded exactly rather than as a
 * floor: losing a channel is the failure this section was written for, and
 * gaining one is a real change to how the product reads, which somebody should
 * have to write down.
 *
 * `colourOnly` is required precisely when `form` is empty, and it is the
 * `BELOW_FLOOR` shape from §10.5 of the migration record — a debt, not an
 * exemption. It pins the measured separation, says where the two are seen
 * together, and states what fixing it would cost. Three rows carry one today,
 * and all three are the same shape: two filled, unbroken-edged, equally thick
 * controls whose whole difference is which colour they are.
 *
 * **This table is not the place to fix them.** Every fix is a change to what the
 * product looks like, decided by whoever owns the variant, next to a screenshot
 * — not by an audit editing a row on its own authority.
 */
const VARIANT_PAIRS: readonly {
  pair: readonly [ButtonVariant, ButtonVariant]
  form: readonly Channel[]
  colourOnly?: { apart: number; where: string; fix: string }
}[] = [
  {
    pair: ['primary', 'default'],
    form: [],
    colourOnly: {
      apart: 1.851,
      where:
        "every dialog footer — ConnectDialog's Cancel sits immediately left of Connect, and the " +
        'settings and value dialogs repeat the pair',
      fix:
        'Give one of the two a form of its own — a heavier edge on the affirmative is the cheapest, ' +
        'since neither variant spends its border on meaning the way danger and caution do. Changing ' +
        'a surface token instead moves every primary control in the window.',
    },
  },
  {
    pair: ['primary', 'ghost'],
    form: ['edge'],
  },
  {
    pair: ['primary', 'danger'],
    form: [],
    colourOnly: {
      apart: 1.983,
      where:
        "the composer's one action slot — Send *becomes* Stop when the agent is working, in place " +
        'rather than beside it, so the discrimination is between two moments and not two neighbours',
      fix:
        'The label already differs and one of them carries a glyph, which this section cannot read ' +
        '(see the note above). If the pair is ever shown side by side, that stops being enough.',
    },
  },
  {
    pair: ['primary', 'caution'],
    form: ['style'],
  },
  {
    pair: ['default', 'ghost'],
    form: ['edge'],
  },
  {
    pair: ['default', 'danger'],
    form: [],
    colourOnly: {
      apart: 1.983,
      where:
        "the permission prompt's answer row — allow_once is default and reject_once is danger, and " +
        'they render as neighbours in the same wrapped flex row (permissionOptions.ts)',
      fix:
        'This is the pair the caution sentence stops one short of. The two share a resting surface ' +
        'exactly, their borders measure 1.13:1 apart, and the whole separation is the label colour. ' +
        'Breaking or thickening one edge is the same fix caution already got.',
    },
  },
  {
    pair: ['default', 'caution'],
    form: ['style'],
  },
  {
    pair: ['ghost', 'danger'],
    form: ['edge'],
  },
  {
    pair: ['ghost', 'caution'],
    form: ['edge', 'style'],
  },
  {
    pair: ['danger', 'caution'],
    form: ['style'],
  },
]

describe('a variant pair survives the loss of hue', () => {
  const key = (a: ButtonVariant, b: ButtonVariant): string => `${a}/${b}`

  test('every pair of variants is accounted for, exactly once', () => {
    const wanted: string[] = []
    for (let i = 0; i < BUTTON_VARIANT_NAMES.length; i += 1) {
      for (let j = i + 1; j < BUTTON_VARIANT_NAMES.length; j += 1) {
        wanted.push(key(BUTTON_VARIANT_NAMES[i], BUTTON_VARIANT_NAMES[j]))
      }
    }
    const declared = VARIANT_PAIRS.map((row) => key(row.pair[0], row.pair[1]))
    assert.deepEqual(
      [...declared].sort(),
      [...wanted].sort(),
      `VARIANT_PAIRS no longer lists every pair of variants exactly once.\n` +
        `Declared: ${declared.join(', ')}\nExpected: ${wanted.join(', ')}\n\n` +
        `Adding a variant adds ${String(BUTTON_VARIANT_NAMES.length - 1)} pairs, and each of them ` +
        `is a claim about whether two controls can be told apart by somebody who does not see the ` +
        `difference between their colours. A pair nobody listed is a claim nobody made — which is ` +
        `the state this whole section was added to end.`,
    )
    // Order matters only in that both spellings of a pair must not appear.
    assert.equal(new Set(declared).size, declared.length, 'a pair is listed twice in VARIANT_PAIRS')
  })

  for (const row of VARIANT_PAIRS) {
    const [a, b] = row.pair

    test(`${key(a, b)} is separated by what the record says`, () => {
      const measured = formChannels(a, b)
      const lost = row.form.filter((c) => !measured.includes(c))
      const gained = measured.filter((c) => !row.form.includes(c))

      assert.deepEqual(
        measured,
        [...row.form],
        (lost.length > 0
          ? `\`${a}\` and \`${b}\` no longer differ in: ${lost.join(', ')}.\n\n` +
            `That channel was the pair's hue-free separation, and removing it is invisible to every ` +
            `other assertion in this repository — which is exactly how it was found. If the removal ` +
            `is deliberate, the pair needs another channel first, or a written debt below saying ` +
            `what it has instead and what fixing it costs. Restoring the channel is one class.`
          : `\`${a}\` and \`${b}\` now also differ in: ${gained.join(', ')}.\n\n` +
            `Nothing is broken — record it. The channels are pinned exactly rather than as a floor ` +
            `so that both directions are somebody's decision: a pair that gains a way to be told ` +
            `apart is a change to how the product reads.`) +
          `\n\nRecorded: [${row.form.join(', ')}]  ·  measured: [${measured.join(', ')}]\n` +
          `The channels are fill / edge / style / width, each counted only when it differs in all ` +
          `of ${PER_VARIANT.join(', ')}. Update VARIANT_PAIRS in this file.`,
      )
    })

    test(`${key(a, b)} is not separated by a surface the elevated modifier erases`, () => {
      const measured = formChannels(a, b)
      assert.ok(
        !(measured.length === 1 && measured[0] === 'fill'),
        `\`${a}\` and \`${b}\` are told apart, once hue is gone, by whether the surface paints — and ` +
          `by nothing else.\n\n` +
          `That separation is not the pair's to keep. \`elevated\` is not a fifth string layered on ` +
          `top of the variant's own; it *replaces* the surface, which is the whole reason \`surface\` ` +
          `is a field of its own in ui/spec.ts. Under the modifier both members are filled with the ` +
          `same colour, so this pair goes from "one channel apart" to "nothing but hue apart" ` +
          `because a caller passed a prop — and this section reads the variant strings, so it would ` +
          `not notice.\n\n` +
          `Recording it as a real separation would report a distinction the product can erase. Give ` +
          `the pair an edge, a border style or a width instead — those survive the modifier, which ` +
          `sets none of them — or, if the fill really is all there is, say so as a \`colourOnly\` ` +
          `debt with the elevated case named in \`where\`.`,
      )
    })

    test(`${key(a, b)} states what it has instead of a form difference`, () => {
      const measured = formChannels(a, b)

      if (measured.length > 0) {
        assert.equal(
          row.colourOnly,
          undefined,
          `\`${a}\` and \`${b}\` differ in ${measured.join(', ')}, so the \`colourOnly\` debt on ` +
            `this row is paid. Delete it — a debt list that outlives its debt reports the product ` +
            `as worse than it is, and the next reader spends the afternoon confirming that.`,
        )
        return
      }

      assert.ok(
        row.colourOnly,
        `\`${a}\` and \`${b}\` differ in no channel that survives greyscale: same fill, same edge, ` +
          `same border style, same border width, in every state. Whatever tells them apart is a ` +
          `colour.\n\n` +
          `That may be acceptable — three pairs are in that position today and say so. It is not ` +
          `acceptable *silently*: add a \`colourOnly\` entry to this row with the measured ` +
          `separation (${apart(a, b).toFixed(3)}:1 as of this run), where the two are seen ` +
          `together, and what fixing it would cost. If you got here by deleting a class from ` +
          `ui/spec.ts, the comment above that class says why it was there.`,
      )
      for (const [field, text] of [
        ['where', row.colourOnly.where],
        ['fix', row.colourOnly.fix],
      ] as const) {
        assert.ok(
          text.trim().length > 30,
          `${key(a, b)}'s \`colourOnly.${field}\` says nothing usable. A debt whose reason nobody ` +
            `wrote cannot be told apart from an oversight — the same rule NOT_CONTROLS is held to.`,
        )
      }
    })

    const debt = row.colourOnly
    if (debt !== undefined) {
      test(`${key(a, b)} is no further apart, and no closer, than recorded`, () => {
        const measured = apart(a, b)
        const recorded = debt.apart
        const drift = measured - recorded
        assert.ok(
          Math.abs(drift) < 0.005,
          `\`${a}\` and \`${b}\` were recorded ${recorded.toFixed(3)}:1 apart and now measure ` +
            `${measured.toFixed(3)}:1 (${drift < 0 ? 'closer' : 'further apart'}).\n\n` +
            `This pair has no form difference at all, so this ratio is the entire reason a user who ` +
            `cannot separate their hues can still separate the controls. It is a ratchet, not a ` +
            `threshold: closer is a regression, further apart is good news that has to be written ` +
            `down, and clearing it altogether means giving the pair a real form channel and deleting ` +
            `the debt. Nothing here is a licence to move the number to match the code.`,
        )
      })
    }
  }
})

/* ------------------------------------------------------------------
 * 4 — the className hatch stays a layout hatch
 *
 * The rule has not moved: `className` on a `<Button>` says **where the control
 * sits**, never what it looks like. What moved is how that can be decided.
 *
 * The old check looked each passed class up in the stylesheets and compared its
 * declarations against `LAYOUT_ONLY_PROPERTIES`. It shipped with a hole big
 * enough to drive the whole rule through: `owners.get(name)` returns `undefined`
 * for a class that is in no stylesheet, `?? []` turned that into "declares
 * nothing", and **a class nobody could find passed silently**. A typo passed. A
 * class deleted from the CSS but left in the JSX passed. So did every atomic
 * class, the moment the migration started.
 *
 * In the atomic era the lookup is unnecessary: a class name's prefix *is* its
 * property family, so classification is a pure function of the string. That is
 * the classifier below, and its default is **reject**. The fence comes out of
 * this migration stricter than it went in — one of the few places that is true,
 * which is why it is written down here rather than left to be noticed.
 *
 * ## The hole under the classifier, and why it is closed this way
 *
 * Classifying a class is only a fence if the classes can be *found*, and one
 * line took them out of reach: a module-level constant holding paint utilities,
 * handed to a `<Button>` by name. The classifier never saw a string; the
 * component appended it to the element anyway. `sourceScan.ts` says plainly that
 * a className computed from a non-literal is beyond static reach, and that
 * remains true — the fix here is not to start resolving constants.
 *
 * Resolving them was considered and rejected, and the reason is worth keeping:
 * one level of resolution covers `className={CONST}` and covers nothing else,
 * while reading, to the next author, as though the whole class of problem were
 * handled. A constant imported from another module, assembled from two others,
 * returned by a helper, or read off an object are all the same bypass wearing a
 * different spelling, and each one would come back green under a resolver that
 * only followed the first.
 *
 * So the fence rejects what it cannot read, instead. An identifier standing in
 * value position inside a `className` is a class list arriving from outside the
 * call site; it is reported there, with the message telling the author to write
 * the classes out. That turns an invisible bypass into a loud one without
 * claiming a reach this file does not have. `opaqueTerms` above is the whole of
 * it, and the residue it does *not* cover is named in `ui/CLAUDE.md`, because
 * the residue is the part a guide has to be honest about.
 *
 * See docs/design/2026-08-04-tailwind-migration.md §3.3 and §15.
 * ------------------------------------------------------------------ */

/**
 * Utilities that place the control inside whatever contains it. The caller's
 * business, and the exact set `LAYOUT_ONLY_PROPERTIES` allows, one namespace
 * over: position and its offsets, z-index, margins, the flex-child properties,
 * grid placement, transform, width, visibility.
 *
 * `visible` joined `invisible` when the tab strip's ✕ stopped being a descendant
 * selector and became `invisible group-hover/tab:visible`. It is not a widening:
 * `visibility` has been on `LAYOUT_ONLY_PROPERTIES` since that list was written,
 * with a paragraph naming this exact button, and only one of the two classes that
 * spell it was ever listed here. The omission was invisible while the rule that
 * revealed the ✕ still lived in CSS.
 */
const LAYOUT_UTILITY =
  /^(absolute|relative|fixed|sticky|static|visible|invisible|grow|shrink|inset-|top-|right-|bottom-|left-|z-|m[xytrbl]?-|flex-|grow-|shrink-|basis-|self-|justify-self-|order-|col-|row-|translate-|w-|max-w-|min-w-)/

/**
 * Utilities that paint, outline, set type, or size the box. These belong to the
 * spec — `.btn` already declares every one of them, and a class that overrides
 * one is not positioning the button, it is arguing with the primitive about what
 * a button is.
 */
const PAINT_UTILITY =
  /^(bg-|text-|border|rounded|p[xytrbl]?-|h-|max-h-|min-h-|shadow|opacity|font-|ring|outline)/

type ClassKind = 'layout' | 'paint' | 'unknown'

/**
 * What a class name does, from the name alone.
 *
 * Variants are stripped first (`hover:bg-bg-2` is a background, whatever
 * condition it is under), so a modifier cannot smuggle a paint utility past the
 * prefix test.
 */
function classify(name: string): ClassKind {
  const bare = name.slice(name.lastIndexOf(':') + 1).replace(/^-/, '')
  if (PAINT_UTILITY.test(bare)) return 'paint'
  if (LAYOUT_UTILITY.test(bare)) return 'layout'
  return 'unknown'
}

/**
 * Named classes still passed to a control, from before the migration.
 *
 * Every one of these is a hand-written rule in a stylesheet, so the old
 * lookup — is every property it declares in `LAYOUT_ONLY_PROPERTIES`? — is still
 * the right question to ask about it, and is still asked below. What is *not*
 * allowed is a name nobody wrote a rule for, which is the hole being closed:
 * an entry here is checked against the stylesheets and fails if it is missing
 * from all of them.
 *
 * This list may only get shorter. Each phase-2 module deletes its own entries as
 * it migrates, and `no stale entry survives` fails if one is left behind — a
 * finished entry is an open door for the next edit to that file.
 *
 * One left, and **the reason it is left has changed** — which is worth more than
 * the entry itself, because the old reason was wrong and was being repeated.
 *
 * It used to read: `.tab-close` is `visibility: hidden` revealed by
 * `.panel-tab:hover` and `.panel-tab.active`, the tab's state deciding the
 * button's appearance two elements apart, and a class list has no descendant
 * selector. That is precisely what `group-hover/tab:` is, and the ✕ wears it now
 * (`components/PanelTabs.tsx`); the migration record's §11.2 corrects the general
 * form of that claim.
 *
 * What actually keeps the name on the button is that
 * `scripts/verify-chat-restore.mjs` finds it over CDP as `.panel-tabs .tab-close`
 * and clicks it, exactly as it finds the chat panel by `.chat-view`. So the entry
 * stays, and the stylesheet check below stays satisfied by the one layout
 * declaration the button genuinely needs (`flex: 0 0 auto` — without it the ✕ is
 * the first thing a narrow tab squeezes). Emptying the list means retiring a
 * script's handle, which is a change to that script and not to this one.
 */
interface LedgerEntry {
  name: string
  /**
   * `rule` — a stylesheet defines it, and may declare only layout properties.
   * `handle` — nothing defines it; it exists so that something *outside*
   *            `src/renderer` can select the element. `selectedBy` then names
   *            the file that does, and is checked.
   */
  kind: 'rule' | 'handle'
  selectedBy?: string
  why: string
}

/*
 * `tab-close` moved from `rule` to `handle` in §29.11.8.
 *
 * It was a `rule` for one declaration, `flex: 0 0 auto`, and the note above
 * described that as what "keeps the stylesheet check below satisfied" — which is
 * the tail wagging the dog: the rule existed to satisfy the fence, and the fence
 * demanded a rule because that was the only shape it knew. The declaration is
 * `flex-none` on the button now.
 *
 * A `handle` entry is checked *harder* than a `rule` one, not exempted. The old
 * contract was "some stylesheet defines this name"; nothing anywhere asserted
 * that the CDP script still used it, so retiring the script would have left a
 * name on the ledger, a rule in the sheet, and no reason for either. The new one
 * reads the script and fails if the selector is gone.
 */
const CLASSNAME_LEDGER: readonly LedgerEntry[] = [
  {
    name: 'tab-close',
    kind: 'handle',
    selectedBy: '../../../scripts/verify-chat-restore.mjs',
    why:
      'A CDP script finds the ✕ as `.panel-tabs .tab-close` and clicks it, the same way it finds ' +
      'the chat panel by `.chat-view`. The name is an automation handle, not a style.',
  },
]

const LEDGER_NAMES = new Set(CLASSNAME_LEDGER.map((e) => e.name))

describe('className on a Button is layout only', () => {
  /** Every property declared anywhere for a given class name. */
  const owners = new Map<string, string[]>()
  for (const sheet of STYLESHEETS) {
    for (const rule of rules(readFileSync(join(RENDERER, sheet), 'utf8'))) {
      for (const selector of rule.selectors) {
        for (const m of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
          owners.set(m[1], [...(owners.get(m[1]) ?? []), ...rule.properties])
        }
      }
    }
  }

  /** Every class name passed to a `<Button>`, with the file it came from. */
  function passedClasses(): { file: string; name: string }[] {
    /*
     * `attributeClassNames`, and this is the one place in the repo where the
     * attribute-precise half of the pair is the right one. Everywhere else — the
     * arbitrary-value ban, the type census — the question is "does this file
     * contain X anywhere", and the answer has to be read the way Tailwind reads
     * it, comments and constants included. Here the question is *which element*
     * a class landed on, and a whole-file scan cannot answer it: it would report
     * every class in the file as if it had been handed to a Button, and the
     * fence would reject `ChatView.tsx` for its own panel background.
     *
     * It reads `className="a b"`, `className={cond ? 'a' : 'b'}`, and — since
     * the scanner was rewritten — the branches inside `className={`x ${…}`}`,
     * which used to fall through the quote pairing and were the reason the
     * migration record tells authors to write class strings out in full. A
     * className computed from a bare identifier is still beyond static reach,
     * which is why `unreadableClassNames` below refuses it outright rather than
     * letting the silence read as approval.
     */
    return buttonUsages().flatMap(({ file, attrs }) =>
      attributeClassNames(attrs).map(({ name }) => ({ file, name })),
    )
  }

  /** Every `<Button>` whose `className` carries something read from elsewhere. */
  function unreadableClassNames(): { file: string; terms: string[] }[] {
    const out: { file: string; terms: string[] }[] = []
    for (const { file, attrs } of buttonUsages()) {
      const expression = classNameExpression(attrs)
      if (expression === undefined) continue
      const terms = opaqueTerms(expression)
      if (terms.length > 0) out.push({ file, terms: [...new Set(terms)] })
    }
    return out
  }

  test('the fence rejects by default, and knows when it cannot read', () => {
    // The whole point of the rewrite, asserted directly rather than inferred
    // from the absence of offenders — which is what the old version's `?? []`
    // amounted to, and it was wrong for two years' worth of edits.
    assert.equal(classify('mt-2'), 'layout')
    assert.equal(classify('bg-bg-2'), 'paint')
    assert.equal(classify('hover:bg-bg-2'), 'paint', 'a variant must not launder a paint utility')
    assert.equal(classify('h-row'), 'paint', 'box height belongs to the size rung, not to the caller')
    assert.equal(
      classify('w-full'),
      'layout',
      "width is the caller's, height is not — see LAYOUT_ONLY_PROPERTIES",
    )
    assert.equal(classify('invisible'), 'layout')
    assert.equal(
      classify('group-hover/tab:visible'),
      'layout',
      'both spellings of `visibility`, named group and all — see LAYOUT_ONLY_PROPERTIES',
    )
    assert.equal(classify('totally-made-up'), 'unknown')
    assert.equal(classify('tab-clsoe'), 'unknown', 'a typo used to sail through: it owned no properties')

    /*
     * The half above only fences classes it can find, and the fixtures below are
     * the shapes that used to hide them. Each one was reachable with the whole
     * suite green: the constant reaches the element, the classifier is simply
     * never handed a string. `PAINT` here stands for exactly the module-level
     * `const` the audit found — the name is not resolved and is not meant to be.
     */
    const opaque = (expression: string): string[] => opaqueTerms(expression)

    assert.deepEqual(opaque('"mt-2 self-end"'), [], 'a quoted attribute is entirely readable')
    assert.deepEqual(opaque("active ? 'mt-2' : 'mt-2 invisible'"), [], 'a test is not a class list')
    assert.deepEqual(opaque("kind === 'wide' && 'w-full'"), [], 'nor is a comparison')
    assert.deepEqual(opaque("on ? 'w-full' : undefined"), [], 'nor is a value that renders nothing')
    assert.deepEqual(
      opaque('`mt-2 ${on ? "z-10" : "w-full"}`'),
      [],
      'a template made of literals is readable',
    )

    assert.deepEqual(opaque('PAINT'), ['PAINT'], 'the one-line bypass: a constant handed over by name')
    assert.deepEqual(
      opaque('`mt-2 ${PAINT}`'),
      ['PAINT'],
      'and the same bypass with a readable literal in front of it, which is what makes it quiet — ' +
        'the fence used to find `mt-2`, classify it as layout, and report nothing',
    )
    assert.deepEqual(opaque('active ? PAINT : "mt-2"'), ['PAINT'], 'a branch is a value position too')
    assert.deepEqual(opaque('props.className'), ['className'], 'so is a property read off an object')
    assert.deepEqual(opaque("cx('mt-2', extra)"), ['cx', 'extra'], 'so is anything a helper returns')
  })

  test('no passed class repaints the control', () => {
    const offenders: string[] = []

    /*
     * First the classes that are not there to classify. A `className` built out
     * of a name this file cannot follow puts every rule below out of reach in
     * one line — the constant is appended to the element exactly as a literal
     * would be — so it is reported as unreadable rather than passing for want of
     * anything to object to. This is not "resolve the constant"; see the section
     * header for why that fix was turned down.
     */
    for (const { file, terms } of unreadableClassNames()) {
      offenders.push(
        `${file} → className carries ${terms.map((t) => `\`${t}\``).join(', ')}, which this test ` +
          `cannot read, so nothing here classified it`,
      )
    }

    for (const { file, name } of passedClasses()) {
      switch (classify(name)) {
        case 'layout':
          break
        case 'paint':
          offenders.push(`${file} → "${name}" is a paint utility`)
          break
        case 'unknown': {
          const entry = CLASSNAME_LEDGER.find((e) => e.name === name)
          if (entry === undefined) {
            offenders.push(`${file} → "${name}" matches no utility family, and is not on CLASSNAME_LEDGER`)
            break
          }
          const declared = owners.get(name)
          if (entry.kind === 'handle') {
            // A handle owns no CSS. If a stylesheet has grown one for it, the
            // entry is lying about what the name is for.
            if (declared !== undefined) {
              offenders.push(
                `${file} → .${name} is on CLASSNAME_LEDGER as a \`handle\` — a name with no style — ` +
                  `but a stylesheet now declares ${[...new Set(declared)].join(', ')} for it. Either ` +
                  `move that onto the element, or change the entry to \`rule\`.`,
              )
            }
            break
          }
          if (declared === undefined) {
            offenders.push(`${file} → .${name} is on CLASSNAME_LEDGER but no stylesheet defines it`)
            break
          }
          const bad = [...new Set(declared)].filter((p) => !LAYOUT_ONLY_PROPERTIES.includes(p))
          if (bad.length > 0) offenders.push(`${file} → .${name} declares ${bad.join(', ')}`)
          break
        }
      }
    }

    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `A Button's \`className\` may place the control, not paint it:\n${[...new Set(offenders)].join('\n')}\n\n` +
        `Split the class in two — keep the positioning, and move anything visual into a variant in ` +
        `spec.ts. If no existing variant fits, that is a real gap in the spec and the answer is to ` +
        `add one (see ${GUIDE}), not to reach around it.\n\n` +
        `If the complaint is that a class "cannot be read": write the classes out in the tag. This ` +
        `fence reads what is at the call site — a quoted string, both arms of a conditional, the ` +
        `pieces of a template — and a name standing for a class list is a list it has no way to ` +
        `see, while <Button> appends it to the element regardless. That was a real bypass, not a ` +
        `hypothetical one. Sharing a placement string between two call sites is the one honest ` +
        `reason to want this, and two short duplicated strings cost less than a fence with a gap ` +
        `in it.`,
    )
  })

  test('the scan actually finds the call sites it is fencing', () => {
    /*
     * A fence over an empty list is not a fence, and `openingTags` has been
     * broken once already (it counted prose) with the failure invisible from
     * here. The population counted is the `<Button>`s themselves rather than the
     * classes they pass: the class count is legitimately small and could reach
     * zero if every caller stopped needing to place its control, at which point
     * a guard on it would be asserting nothing. The call sites cannot — there
     * were 87 of them when the control layer landed and the whole design is that
     * the number only grows.
     */
    const sites = buttonUsages().length
    assert.ok(
      sites > 40,
      `only ${String(sites)} <Button> call sites were found in the whole renderer. There are dozens. ` +
        `The JSX scan has stopped reading source, and this section is fencing an empty list.`,
    )
  })

  test('no stale entry survives on the ledger', () => {
    const passed = new Set(passedClasses().map((c) => c.name))
    const stale = [...LEDGER_NAMES].filter((name) => !passed.has(name))
    assert.deepEqual(
      stale,
      [],
      `These are on CLASSNAME_LEDGER but no <Button> passes them any more:\n${stale.join('\n')}\n\n` +
        `Delete their lines. The ledger is the pre-Tailwind residue and it only ever shrinks; a ` +
        `finished entry left on it re-opens the "class in no stylesheet" hole for the next edit.`,
    )
  })

  test('every handle entry still has the reader it exists for', () => {
    /*
     * The half the old ledger never checked.
     *
     * Its contract was "some stylesheet defines this name", which said nothing
     * about *why* the name was wanted. `tab-close`'s real reason was always a CDP
     * script's selector, written in a comment and asserted nowhere — so retiring
     * that script would have left the entry, the rule and the name all standing,
     * each pointing at the others. A handle that nothing reads is exactly the
     * dead weight this ledger exists to shed.
     */
    for (const entry of CLASSNAME_LEDGER) {
      assert.ok(entry.why.length > 40, `the reason for \`${entry.name}\` is too short to be a reason`)
      if (entry.kind !== 'handle') continue
      assert.ok(entry.selectedBy, `\`${entry.name}\` is a handle and names no file that selects it`)
      const path = join(UI, entry.selectedBy)
      assert.ok(existsSync(path), `\`${entry.name}\` names ${entry.selectedBy}, which does not exist`)
      assert.ok(
        readFileSync(path, 'utf8').includes(entry.name),
        `\`${entry.name}\` is on the ledger as a handle for ${entry.selectedBy}, and that file no ` +
          `longer mentions it. The name is dead: take it off the button and off this list.`,
      )
    }
  })
})

/* ------------------------------------------------------------------
 * 4 & 5 — semantic handles
 * ------------------------------------------------------------------ */

describe('action handles', () => {
  const withAction = buttonUsages()
    .map((u) => ({ ...u, action: attr(u.attrs, 'action'), exposure: attr(u.attrs, 'exposure') }))
    .filter((u) => u.action !== undefined || u.exposure !== undefined)

  test('ids follow the Command Bus domain.verb shape', () => {
    const bad = withAction
      .filter((u) => u.action !== undefined && !ACTION_ID_PATTERN.test(u.action))
      .map((u) => `${u.file} → action="${u.action}"`)
    assert.deepEqual(
      bad,
      [],
      `Action ids share a vocabulary with the Command Bus (PLAN §6), so they take its shape: ` +
        `lower-case \`domain.verb\`, e.g. "conn.book.forget".\n${bad.join('\n')}`,
    )
  })

  test('ids are unique across the renderer', () => {
    const seen = new Map<string, string[]>()
    for (const u of withAction) {
      if (u.action === undefined) continue
      seen.set(u.action, [...(seen.get(u.action) ?? []), u.file])
    }
    const dupes = [...seen]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => `${id} → ${files.join(', ')}`)
    assert.deepEqual(
      dupes,
      [],
      `An action id is an address. Two controls sharing one means a test — or, later, an MCP ` +
        `caller — cannot say which it meant:\n${dupes.join('\n')}`,
    )
  })

  test('anything exposed to an agent has a name', () => {
    const nameless = withAction
      .filter((u) => u.exposure === 'agent-ok' && u.action === undefined)
      .map((u) => u.file)
    assert.deepEqual(
      nameless,
      [],
      `exposure="agent-ok" without an \`action\` id is unreachable by definition — there is no ` +
        `handle to address it by. Give it one, or drop the exposure:\n${nameless.join('\n')}`,
    )
  })
})

/* ------------------------------------------------------------------
 * 6 — the boundary that is a security property, not a style rule
 * ------------------------------------------------------------------ */

describe('an agent cannot be handed its own permission prompt', () => {
  test('every control in the permission prompt stays human-only', () => {
    const file = join(RENDERER, 'components', 'chat', 'PermissionPrompt.tsx')
    const attrs = openingTags(readFileSync(file, 'utf8'), 'Button')

    assert.ok(
      attrs.length > 0,
      `PermissionPrompt.tsx no longer renders any <Button>. Either it was reverted to bare ` +
        `<button> — which puts it outside every rule in this file — or the prompt moved and this ` +
        `test needs to follow it. Do not delete the test to make it pass.`,
    )

    const exposed = attrs.filter((a) => attr(a, 'exposure') === 'agent-ok')
    assert.equal(
      exposed.length,
      0,
      `A button in the permission prompt is marked agent-ok.\n\n` +
        `This prompt is where a person decides what an agent may do. An agent able to answer it ` +
        `approves its own requests, and the permission system stops meaning anything. Nothing reads ` +
        `data-peek-exposure yet — the boundary is written down now precisely so that whoever does ` +
        `build that reader inherits it rather than rediscovers it. See ${DOC} §2.6.`,
    )
  })

  /**
   * The same boundary around the agent's *own question*, and the stricter half.
   *
   * A permission prompt answered by an agent leaks an authorisation. A question
   * answered by an agent fabricates **a person's judgement**: the user is later
   * shown a decision that reads as theirs — "you said weekly" — when nobody ever
   * looked at it, and every step the model takes afterwards rests on an answer
   * it wrote itself. `chat.answer` refuses `source: 'agent'` on the bus; this is
   * the DOM half of the same rule, in place before any reader of
   * `data-peek-exposure` exists.
   *
   * See `docs/design/2026-08-15-agent-asks-a-question.md` §2.6.
   */
  test('every control in the question prompt stays human-only', () => {
    const file = join(RENDERER, 'components', 'chat', 'QuestionPrompt.tsx')
    const attrs = openingTags(readFileSync(file, 'utf8'), 'Button')

    assert.ok(
      attrs.length > 0,
      `QuestionPrompt.tsx no longer renders any <Button>. Either it was reverted to bare ` +
        `<button> — which puts it outside every rule in this file — or the prompt moved and this ` +
        `test needs to follow it. Do not delete the test to make it pass.`,
    )

    const exposed = attrs.filter((a) => attr(a, 'exposure') !== 'human-only')
    assert.equal(
      exposed.length,
      0,
      `A button in the question prompt is not marked human-only.\n\n` +
        `Asserted as "every one of them says human-only", not merely "none says agent-ok", because ` +
        `here the default is the dangerous answer: an unmarked button is one nobody decided about, ` +
        `and this is the surface where the decision is the whole point.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 7 — migration only moves one way
 * ------------------------------------------------------------------ */

/**
 * Bare `<button>` elements that are deliberately **not** controls.
 *
 * The ledger below started from an assumption that turned out to be false:
 * that every `<button>` in the renderer wants to be a `<Button>`. Migrating 80
 * of them proved otherwise. What is left is a different kind of element — a menu
 * item, a disclosure header, a tab — that needs button *semantics* (focusable,
 * activated by Enter and Space, announced as pressable) and nothing at all from
 * the control layer. Forcing one through `<Button>` would mean overriding every
 * declaration `.btn` makes, which is not migration, it is a fight.
 *
 * They are listed rather than pattern-matched because "this is not a control" is
 * a judgement, and a judgement that nobody wrote down is indistinguishable from
 * an oversight. Same demand as the opacity census and the hit-target exemptions:
 * **being outside the rule has to be a sentence somebody wrote.**
 *
 * `count` is the part that keeps this honest at file granularity. Without it,
 * a file admitted here for its two menu items would silently accept a third
 * element that *is* a control.
 */
const NOT_CONTROLS: readonly { where: string; count: number; reason: string }[] = [
  {
    where: 'components/chat/AttachMenu.tsx',
    count: 1,
    reason:
      "A listbox option, in the @-mention list. The `<Menu>` primitive that took the context menu's " +
      'two items anchors to a *point* and takes focus; this list is aimed by the composer while ' +
      'focus stays in the textarea, which is a different element entirely.',
  },
  {
    where: 'components/chat/ToolCallCard.tsx',
    count: 1,
    reason:
      'A disclosure header: it carries `aria-expanded` and wraps a status mark, a name and a summary ' +
      'across the full width of the card. It is a region you can open, not an action you can take.',
  },
  {
    where: 'components/chat/MessageItem.tsx',
    count: 1,
    reason: "The thinking block's disclosure header. Same kind as ToolCallCard's.",
  },
  {
    where: 'components/settings/SettingsDialog.tsx',
    count: 1,
    reason:
      'A tab — `role="tab"` inside a `role="tablist"`, so a screen reader announces "2 of 4". ' +
      'PanelTabs reached the same conclusion from the other direction and uses a `div role="tab"`.',
  },
]

/**
 * Files still to migrate. This list may only get shorter.
 *
 * It is down to one, and that one is blocked on something outside the change:
 * `TreeView.tsx` has uncommitted work in it from another thread, and migrating a
 * file someone else is editing trades a tidy ledger for a merge conflict.
 *
 * The honest limit, unchanged: this cannot stop someone appending a new file. A
 * newly created file is indistinguishable from a half-migrated one to a static
 * check. That half is enforced by people; saying so beats a test that pretends
 * to cover it.
 */
const MIGRATION_LEDGER: readonly string[] = ['components/views/TreeView.tsx']

/** Not on either list — they are the primitives, and must render the real element. */
const PRIMITIVES: readonly string[] = ['ui/Button.tsx', 'ui/Segmented.tsx', 'ui/Menu.tsx']

describe('bare <button> is confined to what is written down', () => {
  const exempt = new Set([...PRIMITIVES, ...MIGRATION_LEDGER, ...NOT_CONTROLS.map((n) => n.where)])

  test('no file outside those lists renders one', () => {
    const offenders: string[] = []
    for (const path of tsxFiles()) {
      const rel = relative(RENDERER, path)
      if (exempt.has(rel)) continue
      if (openingTags(readFileSync(path, 'utf8'), 'button').length > 0) offenders.push(rel)
    }
    assert.deepEqual(
      offenders,
      [],
      `These files render a raw <button>:\n${offenders.join('\n')}\n\n` +
        `Use <Button> from renderer/ui/Button. It is the collection point — the reason "destructive" ` +
        `ended up with three separate implementations, two of them identical, is that there was ` +
        `nowhere to look and nowhere to add. See ${GUIDE}.`,
    )
  })

  test('a file that is not a control has exactly the elements it declared', () => {
    // The tightening that makes a file-level exemption safe: an entry admitted
    // for its two menu items must not quietly grow a third element that is a
    // control.
    const wrong: string[] = []
    for (const entry of NOT_CONTROLS) {
      const found = openingTags(readFileSync(join(RENDERER, entry.where), 'utf8'), 'button').length
      if (found !== entry.count) wrong.push(`${entry.where}: declared ${entry.count}, found ${found}`)
    }
    assert.deepEqual(
      wrong,
      [],
      `A file listed as not-a-control changed shape:\n${wrong.join('\n')}\n\n` +
        `If the new element is a menu item or a disclosure like its neighbours, raise the count and ` +
        `say so in the reason. If it is a control, it belongs in <Button>.`,
    )
  })

  test('every not-a-control entry says why', () => {
    for (const entry of NOT_CONTROLS) {
      assert.ok(
        entry.reason.trim().length > 60,
        `${entry.where} is exempt without a reason worth reading. "This is not a control" is a ` +
          `judgement, and a judgement nobody wrote down cannot be told apart from an oversight.`,
      )
    }
  })

  test('the ledger has no stale entries', () => {
    const stale = MIGRATION_LEDGER.filter((rel) => {
      let src: string
      try {
        src = readFileSync(join(RENDERER, rel), 'utf8')
      } catch {
        return true
      }
      return openingTags(src, 'button').length === 0
    })
    assert.deepEqual(
      stale,
      [],
      `These files are on the migration ledger but no longer need to be — they are done, or gone:\n` +
        `${stale.join('\n')}\n\nDelete their lines from MIGRATION_LEDGER. The list only ever ` +
        `shrinks, and leaving a finished entry on it re-opens the hole for the next edit to that file.`,
    )
  })
})
