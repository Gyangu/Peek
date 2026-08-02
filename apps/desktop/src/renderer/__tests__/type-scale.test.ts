import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/* ==================================================================
 * The type floor, as an executable assertion.
 *
 * peek is a dense tool and that is deliberate, but density with no floor walks
 * downwards on its own: before this test the window had four rungs and the
 * bottom one was **9px**, on a product that ships zh-CN, where 10px PingFang
 * runs its strokes together. 11px is also the smallest size macOS itself uses
 * for UI text (caption2).
 *
 * The rule this enforces:
 *
 *   Anything that is *words* is at least 11px. The one way to go below is to
 *   write `var(--fs-mark)` explicitly, which is reserved for pure geometry — a
 *   disclosure caret, a checkbox tick. Naming it is the point: you cannot end
 *   up under the floor by writing a number, only by declaring that what you are
 *   sizing has no letters in it.
 *
 * Inline `fontSize` in a component is checked too, because that is how a rule
 * like this gets routed around without anyone meaning to — the session rail's
 * timestamp was an inline `fontSize: 10` that no stylesheet audit would have
 * caught.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.1.
 * ================================================================== */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')

const STYLESHEETS = [
  'styles.css',
  'keyboard-nav.css',
  join('ui', 'controls.css'),
  join('components', 'chat', 'chat.css'),
  join('components', 'context-actions', 'context-actions.css'),
]

/** Text floor, in px. */
const TEXT_MIN = 11
/** How low the geometry escape hatch itself is allowed to go. */
const MARK_MIN = 10

function readVarPx(name: string): number {
  const css = readFileSync(join(RENDERER, 'styles.css'), 'utf8')
  const decl = new RegExp(`${name}\\s*:\\s*([0-9.]+)px`).exec(css)
  assert.ok(decl, `${name} is not defined in styles.css`)
  return Number(decl[1])
}

interface Declaration {
  file: string
  line: number
  raw: string
  px: number
}

/** Every `font-size` in the stylesheets, resolved to pixels. */
function declarations(): Declaration[] {
  const scale = new Map<string, number>()
  for (const name of ['--fs-sm', '--fs-md', '--fs-lg', '--fs-data', '--fs-mark']) {
    scale.set(name, readVarPx(name))
  }

  const out: Declaration[] = []
  for (const sheet of STYLESHEETS) {
    const lines = readFileSync(join(RENDERER, sheet), 'utf8').split('\n')
    lines.forEach((text, i) => {
      const decl = /font-size:\s*([^;]+);/.exec(text)
      if (!decl) return
      const raw = decl[1].trim()
      // `font-size: 0` on .grid-row is a layout trick — it collapses the
      // whitespace text nodes between inline-block cells. It sizes nothing.
      if (raw === '0') return
      const viaVar = /^var\((--fs-[a-z]+)\)$/.exec(raw)
      if (viaVar) {
        const px = scale.get(viaVar[1])
        assert.ok(px !== undefined, `${sheet}:${i + 1} uses unknown ${viaVar[1]}`)
        out.push({ file: sheet, line: i + 1, raw, px })
        return
      }
      const bare = /^([0-9.]+)px$/.exec(raw)
      assert.ok(bare, `${sheet}:${i + 1} has a font-size this test cannot read: ${raw}`)
      out.push({ file: sheet, line: i + 1, raw, px: Number(bare[1]) })
    })
  }
  assert.ok(out.length > 40, 'the scan found suspiciously few font-size declarations')
  return out
}

/* ------------------------------------------------------------------ */

describe('the type scale', () => {
  test('the scale itself is ordered and above the floor', () => {
    const sm = readVarPx('--fs-sm')
    const md = readVarPx('--fs-md')
    const lg = readVarPx('--fs-lg')
    const data = readVarPx('--fs-data')
    const mark = readVarPx('--fs-mark')

    assert.equal(sm, TEXT_MIN, '--fs-sm is the floor; moving it moves the floor')
    assert.ok(md > sm && lg > md, 'sm < md < lg')
    assert.ok(data >= sm, 'data values are never smaller than secondary text')
    assert.ok(mark >= MARK_MIN, `--fs-mark must stay at or above ${MARK_MIN}px`)
    assert.ok(mark < sm, '--fs-mark below the text floor is the only reason it exists')
  })

  test('nothing is set below the text floor except declared geometry', () => {
    const offenders = declarations()
      .filter((d) => d.px < TEXT_MIN && d.raw !== 'var(--fs-mark)')
      .map((d) => `${d.file}:${d.line} → ${d.raw} (${d.px}px)`)
    assert.deepEqual(
      offenders,
      [],
      `text below ${TEXT_MIN}px must either grow or declare itself geometry via var(--fs-mark):\n${offenders.join('\n')}`,
    )
  })

  test('the geometry escape hatch is used sparingly', () => {
    // Not a hard cap on a number for its own sake: if this list grows, it means
    // the exemption is being used as a way around the floor rather than for the
    // two or three glyphs it was carved out for.
    const marks = declarations().filter((d) => d.raw === 'var(--fs-mark)')
    assert.ok(marks.length <= 4, `var(--fs-mark) is used ${marks.length} times; it is meant for a handful of glyphs`)
  })
})

describe('no inline font sizes in components', () => {
  test('every font-size lives in a stylesheet', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
      const path = join(entry.parentPath, entry.name)
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((text, i) => {
        if (/\bfontSize\b/.test(text)) offenders.push(`${relative(RENDERER, path)}:${i + 1}`)
      })
    }
    assert.deepEqual(
      offenders,
      [],
      `inline fontSize bypasses the type scale; give it a class instead:\n${offenders.join('\n')}`,
    )
  })
})
