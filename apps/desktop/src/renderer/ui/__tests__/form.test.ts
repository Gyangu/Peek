import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import {
  blankComments,
  decomment,
  readShippedCss,
  stylesheets,
  utilityBody,
} from '../../__tests__/sourceScan'

/* ==================================================================
 * The form primitives.
 *
 * What is asserted here is not "the components render" — there is no DOM in this
 * suite — but the four facts the components exist to make unbreakable. Each one
 * was a convention before, each one drifted, and each drift shows up in the
 * design record as a bug somebody had to find by looking:
 *
 *  1. Which element leads a row is decided by a parameter, not by whoever wrote
 *     the row. Two rows promised a screen reader they named a control and did
 *     not, in two different files, two rounds apart.
 *  2. A hint's tone is a class. Four call sites carried an inline colour because
 *     the rules they were fighting sat outside the cascade layers.
 *  3. No rule recomputes the label gutter. Three did, with an `8px` that could
 *     not be factored out of any of them, and the whole of
 *     `2026-08-04-settings-form-gutter.md` is what happened when one of the four
 *     places that had to agree did not.
 *  4. Nothing declares the label column's width a second time. One override
 *     existed, for one pane, and it made every local wish a global ruling.
 *
 * Design record: docs/design/2026-08-13-settings-form-primitives.md
 * ================================================================== */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = blankComments(readFileSync(join(RENDERER, 'ui', 'Form.tsx'), 'utf8'))
const SHIPPED = readShippedCss(RENDERER)

/** Every file that builds a form out of these primitives. */
const CONSUMERS = [
  'components/ConnectDialog.tsx',
  'components/settings/AboutSection.tsx',
  'components/settings/AgentSection.tsx',
  'components/settings/AppearanceSection.tsx',
  'components/settings/McpSection.tsx',
  'components/settings/PackagesSection.tsx',
  'components/settings/TimeoutsSection.tsx',
] as const

describe("the leading element is the API's decision, not the caller's", () => {
  test('a row with an id to point at renders a label; one without renders a span', () => {
    // `<label>` is a promise that a screen reader follows to a named control.
    // While it was the caller's to pick, three rows in two files made it with
    // nothing to name — beside a control that labels itself, and beside plain
    // text, which cannot be labelled at all. Both answers are in one ternary
    // now, so writing a row cannot get it wrong; it can only pass the id or not.
    assert.match(SOURCE, /htmlFor === undefined \?/)
    assert.match(SOURCE, /<label htmlFor=\{htmlFor\}/)
  })

  test('no consumer builds a row out of the class names any more', () => {
    /*
     * The recipe these replace: a row container, a leading cell wearing one of
     * two names, and a hint placed as the row's *next sibling* wearing a third.
     * Nothing enforced any of it, so a button row ended up with two spellings in
     * one dialog — one file wrote the shared name, four wrote a five-class
     * string that differed from it in both spacing and wrapping.
     *
     * The names are spelled here as data rather than in the prose above, because
     * Tailwind's scanner reads this file's raw bytes and has no concept of a
     * comment. None of these four is a utility pattern, so none of them compiles
     * to anything — but the habit is the point, and `sourceScan.ts`'s header is
     * the list of times it was not kept.
     */
    for (const name of ['form-row', 'form-label', 'form-hint', 'form-actions']) {
      for (const rel of CONSUMERS) {
        const src = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
        assert.doesNotMatch(
          src,
          new RegExp(`["'\`][^"'\`]*\\b${name}\\b`),
          `${rel} still wears \`${name}\`. The vocabulary is \`ui/Form.tsx\` now; a class name that ` +
            `no stylesheet defines paints nothing and fails silently.`,
        )
      }
    }
  })
})

describe('a tone is a class, not an inline style', () => {
  test('the primitives write no `style` at all', () => {
    assert.doesNotMatch(
      SOURCE,
      /style=/,
      'An inline style is what the old rules forced on four call sites by being unlayered. A ' +
        'primitive that reintroduces one has given the escape hatch back.',
    )
  })

  test('no consumer colours a hint by hand', () => {
    // Two files carried `color` inline, each with a comment explaining that a
    // colour utility beside a hint would compile, match, and paint nothing —
    // and each naming the same fix. This is the assertion that the fix stuck.
    for (const rel of CONSUMERS) {
      const src = blankComments(readFileSync(join(RENDERER, rel), 'utf8'))
      assert.doesNotMatch(
        src,
        /style=\{\{\s*color:/,
        `${rel} sets a colour inline. The form rules are in the utilities layer now, so a tone is ` +
          `reachable as a class — pass \`tone\` to <FormHint>.`,
      )
    }
  })

  test('each tone ships a colour', () => {
    // The half that a source scan cannot see: that the three class names the
    // component chooses between actually generate a `color` in the artifact. An
    // invented token compiles to nothing and the hint silently reads as prose.
    const tones = SOURCE.match(/const HINT_TONES = \{[^}]*\}/)
    assert.ok(tones, 'HINT_TONES is gone or no longer a literal; this test reads it by shape')
    const names = [...tones[0].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    assert.equal(names.length, 3, `expected three tones, found ${names.join(', ')}`)

    if (SHIPPED === null) {
      console.log('  (no build artifact: the tone classes were not checked against `color`)')
      return
    }
    for (const name of names) {
      const body = utilityBody(SHIPPED.css, name)
      assert.ok(body !== null, `\`${name}\` is a tone but generates no rule in ${SHIPPED.name}`)
      assert.match(body, /color:/, `\`.${name}\` ships as {${body.trim()}} and sets no colour`)
    }
  })
})

describe('the gutter arithmetic is gone, and cannot come back quietly', () => {
  const SHEETS = stylesheets(RENDERER).map((rel) => ({
    rel,
    css: decomment(readFileSync(join(RENDERER, rel), 'utf8')),
  }))

  test('nothing recomputes the label column', () => {
    /*
     * Three rules used to, and the `+ 8px` had to be written out in each of them
     * — a custom property substitutes its own `var()`s where it is *declared*, so
     * an indent computed once in the theme would have frozen the base width into
     * itself and gone on reporting it inside the pane that overrode it. That is a
     * true fact about CSS and it cost an afternoon to establish. It is also a
     * fact about a mechanism this layout no longer has: a hint stands on the
     * control column by being in it.
     */
    for (const { rel, css } of SHEETS) {
      assert.doesNotMatch(
        css,
        /calc\([^)]*--spacing-form-label/,
        `${rel} computes an indent from the label column again. Put the thing in the second grid ` +
          `column instead — that is what \`col-start-2\` on <FormHint> and <FormActions> is for.`,
      )
    }
  })

  test('the column width is declared exactly once', () => {
    // A second declaration is how one number became a global ruling: the pane
    // that needed wider labels said so on an ancestor, and every form in the
    // window then had one of two widths depending on where it happened to be.
    const sites = SHEETS.flatMap(({ rel, css }) =>
      [...css.matchAll(/--spacing-form-label\s*:/g)].map(() => rel),
    )
    assert.deepEqual(
      sites,
      ['styles.css'],
      `the label column is declared in ${String(sites.length)} place(s) (${sites.join(', ')}). One, in ` +
        `the theme, where it is a ceiling — a second is an override, and an override is the ` +
        `regime this replaced.`,
    )
  })

  test('the grid sizes itself to its own labels', () => {
    if (SHIPPED === null) {
      console.log('  (no build artifact: the grid template was not checked)')
      return
    }
    const body = utilityBody(SHIPPED.css, 'form-grid')
    assert.ok(body !== null, `\`form-grid\` generates no rule in ${SHIPPED.name}`)
    assert.match(
      body,
      /grid-template-columns:\s*fit-content\(var\(--spacing-form-label\)\)/,
      `\`.form-grid\` ships as {${body.trim()}}. The first track has to be \`fit-content()\` of the ` +
        `ceiling: a fixed track is the one-number-for-everything regime again, and a plain \`auto\` ` +
        `lets one long label eat the control column.`,
    )
  })
})
