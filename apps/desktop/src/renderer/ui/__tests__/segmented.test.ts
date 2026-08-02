import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { blankComments, decomment } from '../../__tests__/sourceScan'
import { indexOfValue, wrapIndex } from '../../util/roving'
import { CONTROL_SIZE_NAMES } from '../spec'

/* ==================================================================
 * The segmented control.
 *
 * Two halves, and the split follows what can actually be asserted without a DOM:
 * the ring arithmetic and the value lookup are pure and are tested directly; the
 * component's markup is checked by reading it, which is weaker but catches the
 * regressions that matter here — losing `role="radio"`, or ending up with a
 * group no Tab can enter.
 *
 * Design record: docs/design/2026-08-02-segmented-control.md §4
 * ================================================================== */

describe('moving around the ring', () => {
  test('steps and wraps in both directions', () => {
    assert.equal(wrapIndex(3, 0, 1), 1)
    assert.equal(wrapIndex(3, 2, 1), 0)
    assert.equal(wrapIndex(3, 0, -1), 2)
    assert.equal(wrapIndex(3, 1, -1), 0)
  })

  test('Home and End are just large deltas', () => {
    // The component sends `-selected` and `count - 1 - selected` rather than
    // carrying two more cases; this is the assertion that the arithmetic can
    // actually absorb them.
    assert.equal(wrapIndex(6, 4, -4), 0)
    assert.equal(wrapIndex(6, 4, 1), 5)
    assert.equal(wrapIndex(6, 0, 5), 5)
  })

  test('a single option goes nowhere, rather than dividing by itself into trouble', () => {
    assert.equal(wrapIndex(1, 0, 1), 0)
    assert.equal(wrapIndex(1, 0, -1), 0)
  })

  test('an empty group has no answer, and says so', () => {
    assert.equal(wrapIndex(0, 0, 1), -1)
    assert.equal(wrapIndex(0, -1, -1), -1)
  })

  test('a selection that is not in the group still lands somewhere reachable', () => {
    // Real case: the zoom control's value comes back from a settings file and can
    // fail to match any step. Arriving at -1 and staying there would leave a
    // group with no `tabindex="0"` — one the keyboard cannot enter at all.
    assert.equal(wrapIndex(3, -1, 1), 0)
    assert.equal(wrapIndex(3, -1, -1), 2)
    assert.equal(wrapIndex(3, 99, 1), 0)
  })
})

describe('finding the selected option', () => {
  const options = [{ value: 'url' }, { value: 'fields' }]

  test('matches by value, not by position', () => {
    assert.equal(indexOfValue(options, 'fields'), 1)
    assert.equal(indexOfValue(options, 'nope'), -1)
  })

  test('numbers compare as numbers', () => {
    const steps = [{ value: 0.8 }, { value: 1 }, { value: 1.25 }]
    assert.equal(indexOfValue(steps, 1.25), 2)
    assert.equal(indexOfValue(steps, 1.2500000000001), -1, 'exactness is the caller\'s problem to round away')
  })

  test('NaN finds itself, so a broken value never silently means "nothing selected"', () => {
    assert.equal(indexOfValue([{ value: Number.NaN }], Number.NaN), 0)
  })
})

/* ------------------------------------------------------------------ */

const UI = join(dirname(fileURLToPath(import.meta.url)), '..')
/*
 * Comments blanked, strings kept.
 *
 * Blanking is needed because this file's own prose defeats a raw scan:
 * `Segmented.tsx` explains at length why `aria-pressed` is the wrong semantics,
 * and the explanation reads as a use of it. That is the third occurrence of the
 * same trap in one day — the migration ledger, the opacity census, and this.
 *
 * But `blankNonCode` was the wrong reach: it erases string *bodies* too, and
 * every attribute asserted below (`role="radiogroup"`, `aria-checked`) lives in
 * one. Having the shared helper is not the same as picking the right variant of
 * it, which is why there are now two named ones.
 */
const SOURCE = blankComments(readFileSync(join(UI, 'Segmented.tsx'), 'utf8'))
const CSS = decomment(readFileSync(join(UI, 'segmented.css'), 'utf8'))

describe('it says "one of these", not "N switches"', () => {
  test('the group is a radiogroup and the options are radios', () => {
    // The three hand-written copies this replaces used `aria-pressed`, which
    // describes N independent toggles: a screen reader read out "Chinese,
    // pressed" and "English, not pressed" as unrelated switches, never as a
    // choice, and said nothing about which of how many.
    assert.match(SOURCE, /role="radiogroup"/)
    assert.match(SOURCE, /role="radio"/)
    assert.match(SOURCE, /aria-checked=\{checked\}/)
    assert.doesNotMatch(
      SOURCE,
      /aria-pressed/,
      'aria-pressed is the semantics this control was built to stop using',
    )
  })

  test('the group carries a name', () => {
    // `label` is required by the type; this is the other half — that it is
    // actually spent on the group rather than accepted and dropped.
    assert.match(SOURCE, /aria-label=\{label\}/)
  })

  test('exactly one option is reachable by Tab', () => {
    // Roving tabindex. Getting this wrong in the other direction — every option
    // at 0 — is invisible on screen and turns one control back into N tab stops,
    // which is half of what was wrong before.
    assert.match(SOURCE, /tabIndex=\{i === roving \? 0 : -1\}/)
  })
})

describe('the stylesheet covers the states the old rules did not', () => {
  const required = [
    '.seg-item',
    '.seg-item:hover:not(:disabled)',
    '.seg-item:active:not(:disabled)',
    '.seg-item:disabled',
    '.seg-item:focus-visible',
    '.seg-on',
    '.seg-on:hover:not(:disabled)',
    '.seg-on:active:not(:disabled)',
  ]

  for (const selector of required) {
    test(`${selector} is defined`, () => {
      const found = [...CSS.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) =>
        m[1].split(',').map((s) => s.trim()),
      )
      assert.ok(
        found.includes(selector),
        `ui/segmented.css has no rule for \`${selector}\`.\n` +
          `This control is now driven by arrow keys inside a single tab stop, so a missing ` +
          `:focus-visible is not a polish issue — it is a keyboard user unable to tell which ` +
          `option they are on. The rules this replaced defined neither :active nor :focus-visible.`,
      )
    })
  }

  test('both size rungs exist, and they come from the spec', () => {
    for (const size of CONTROL_SIZE_NAMES) {
      assert.match(
        CSS,
        new RegExp(`\\.seg-${size}\\s`),
        `no .seg-${size} rule; the rungs are shared with <Button> and both primitives must offer both`,
      )
    }
  })
})

describe('the class it replaced is gone', () => {
  test('no .segmented or bare .seg survives anywhere', () => {
    const RENDERER = join(UI, '..')
    for (const sheet of ['styles.css', join('ui', 'segmented.css')]) {
      const css = decomment(readFileSync(join(RENDERER, sheet), 'utf8'))
      assert.doesNotMatch(css, /\.segmented\b/, `${sheet} still defines .segmented`)
      // `.seg-item` and `.seg-group` are fine; a bare `.seg` is the name that
      // used to mean two unrelated things at once.
      assert.doesNotMatch(css, /\.seg(?![-\w])/, `${sheet} still defines a bare .seg`)
    }
  })
})
