import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/* ==================================================================
 * The theme's contrast floor, as an executable assertion.
 *
 * This file exists because the floor had already been breached once and nobody
 * could see it: `--fg-faint` shipped at 2.49–2.88:1 depending on the layer
 * under it, which is below the WCAG AA floor for body text (4.5) and below even
 * the large-text floor (3.0) — and it was the weight assigned to the *smallest*
 * type in the window. Nothing in the build said a word.
 *
 * A number in a design document does not hold a line; a test does. If a future
 * palette tweak dims one of these back down, this goes red with the actual
 * ratio in the message.
 *
 * The maths is WCAG 2.1 relative luminance, transcribed from the spec rather
 * than pulled from a package — it is nine lines, and a dependency whose job is
 * nine lines of arithmetic is a dependency to audit forever.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.2.
 * ================================================================== */

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

/** The `:root` block's custom properties, as a plain map. */
function rootVars(css: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(block, 'styles.css must open with a :root block')
  const vars = new Map<string, string>()
  for (const line of block[1].split('\n')) {
    const decl = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (decl) vars.set(decl[1], decl[2].trim())
  }
  return vars
}

const VARS = rootVars(CSS)

function colorOf(name: string): [number, number, number] {
  const raw = VARS.get(name)
  assert.ok(raw, `${name} is not defined in :root`)
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)
  assert.ok(hex, `${name} is expected to be a 6-digit hex colour, got ${raw}`)
  const n = Number.parseInt(hex[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
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
   * The three surfaces text actually lands on. --bg-3 is deliberately absent:
   * it is a hover/emphasis layer, and the only text drawn on it is --fg or
   * --fg-dim, both of which clear 4.5 there with room to spare. Adding it would
   * pin --fg-faint to a combination that has no instance in the product.
   */
  const LAYERS = ['--bg', '--bg-1', '--bg-2'] as const

  for (const weight of ['--fg', '--fg-dim', '--fg-faint'] as const) {
    test(`${weight} clears AA on every background layer`, () => {
      for (const layer of LAYERS) assertAtLeast(weight, layer, 4.5)
    })
  }

  test('the three weights stay in order and stay apart', () => {
    // A ladder whose rungs are 0.3 apart is one weight wearing three names.
    const ratios = (['--fg', '--fg-dim', '--fg-faint'] as const).map((w) => contrast(w, '--bg-1'))
    assert.ok(ratios[0] > ratios[1], '--fg must read stronger than --fg-dim')
    assert.ok(ratios[1] > ratios[2], '--fg-dim must read stronger than --fg-faint')
    assert.ok(ratios[0] - ratios[1] >= 1.5, 'fg and fg-dim are too close to tell apart')
    assert.ok(ratios[1] - ratios[2] >= 1.5, 'fg-dim and fg-faint are too close to tell apart')
  })

  test('semantic colours are readable on the surfaces they appear on', () => {
    for (const c of ['--accent', '--ok', '--warn', '--err'] as const) {
      assertAtLeast(c, '--bg-1', 4.5)
    }
  })
})

describe('non-text contrast', () => {
  test('--border-strong clears 3:1, because it outlines real controls', () => {
    // WCAG 1.4.11: the boundary of a control has to be distinguishable. This is
    // the variable on inputs, buttons and selects — at its old value (1.62 on
    // --bg-1) a text field was a rumour.
    // All three layers: a segmented control sits on --bg-2 inside the settings
    // dialog, an input on --bg inside a modal, a button on --bg-1 in a toolbar.
    assertAtLeast('--border-strong', '--bg', 3)
    assertAtLeast('--border-strong', '--bg-1', 3)
    assertAtLeast('--border-strong', '--bg-2', 3)
  })

  test('--danger-border clears 3:1 too, and is the only red border in the codebase', () => {
    // Same clause, same reasoning as --border-strong: it outlines a control.
    //
    // This assertion exists because of a specific escape. Three rules
    // (.confirm-danger, .chat-perm-reject, .chat-stop) each hard-coded #7a3f3f,
    // which measures 1.91:1 on --bg-2 — under two thirds of the floor the theme
    // had already committed to. It was never caught because this test reads
    // :root, and a literal inside a rule is somewhere it structurally cannot
    // look. The token is the fix; the second half of this test is what keeps the
    // literal from coming back.
    assertAtLeast('--danger-border', '--bg', 3)
    assertAtLeast('--danger-border', '--bg-1', 3)
    assertAtLeast('--danger-border', '--bg-2', 3)

    // The lookbehind keeps `--border: #333941` in :root from matching: a custom
    // property *definition* is the thing being audited, not an evasion of it.
    const LITERAL_BORDER = /(?<![-\w])(border[a-z-]*|outline[a-z-]*)\s*:[^;]*?(#[0-9a-f]{3,8})/i
    const sheets = [
      'styles.css',
      'keyboard-nav.css',
      join('ui', 'controls.css'),
      join('components', 'chat', 'chat.css'),
      join('components', 'context-actions', 'context-actions.css'),
    ]
    const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')
    const literals: string[] = []
    for (const sheet of sheets) {
      readFileSync(join(RENDERER, sheet), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .forEach((line, i) => {
          const m = LITERAL_BORDER.exec(line)
          if (m) literals.push(`${sheet}:${i + 1} → ${m[2]}`)
        })
    }
    assert.deepEqual(
      literals,
      [],
      `A border colour written as a literal cannot be audited by this test — that is exactly how ` +
        `#7a3f3f survived at 1.91:1. Move it into :root and assert it here:\n${literals.join('\n')}`,
    )
  })

  test('--err-border groups an error block without pretending to be a control', () => {
    // Found by the literal sweep above: #5c2f2f appeared three times, and two of
    // those rules (.view-error, .chat-msg-error) were the same error box
    // declared twice in two stylesheets. It is decoration — the `--err` text
    // inside is what carries the meaning — so it answers to --border's 1.45, not
    // to 3:1, and only on the two layers an error block actually lands on.
    const onBg = contrast('--err-border', '--bg')
    const onPanel = contrast('--err-border', '--bg-1')
    assert.ok(onBg >= 1.45, `--err-border on --bg is ${onBg.toFixed(2)}:1, too faint to bound anything`)
    assert.ok(onPanel >= 1.45, `--err-border on --bg-1 is ${onPanel.toFixed(2)}:1, too faint to bound anything`)
    assert.ok(
      contrast('--err', '--err-bg') >= 4.5,
      'the text inside an error block is what carries the meaning; it has to clear AA on that block',
    )
  })

  test('--border stays decorative, and stays visible', () => {
    // Grid lines and panel outlines group things; they do not announce anything
    // interactive, so 3:1 is not required. But 1.32 (the old value) was close
    // enough to invisible that a table read as one undivided field.
    const ratio = contrast('--border', '--bg')
    assert.ok(ratio >= 1.45, `--border on --bg is ${ratio.toFixed(2)}:1, too faint to divide anything`)
    assert.ok(ratio < 3, '--border has drifted into --border-strong territory; one of them is redundant')
  })
})

describe('the scrollbar the grid draws by hand', () => {
  /*
   * `.grid-vsb-thumb` is the only vertical navigation affordance a million-row
   * result set has — the native one is gone, because a spacer tall enough for
   * the rows hits Chromium's ~16.7M px ceiling (see vscroll.ts). It used to be
   * --fg-faint at 40% opacity, i.e. 1.46:1: you had to already know it was
   * there. This asserts the CSS keeps it solid rather than washed out.
   */
  test('is painted solid, not at an opacity that erases it', () => {
    const rule = /\.grid-vsb-thumb\s*\{([^}]*)\}/.exec(CSS)
    assert.ok(rule, '.grid-vsb-thumb rule not found')
    assert.match(rule[1], /background:\s*var\(--border-strong\)/)
    assert.doesNotMatch(rule[1], /opacity/, 'the thumb must not be dimmed by opacity')
  })
})
