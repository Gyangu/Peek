import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/* ==================================================================
 * A regression net over the **structural invariants** of the grid's overlays.
 *
 * The incident itself: after `.grid` went from scrolling on both axes to
 * "native horizontal, hand-drawn vertical", the hand-drawn scrollbar was still
 * rendered inside `.grid`. Absolutely positioned descendants of a horizontal
 * scroll container count as scrollable content and translate with scrollLeft;
 * add `.grid`'s `contain: layout paint` clipping on top and
 * **one horizontal scroll takes away the only vertical scrollbar, along with
 * drag-to-jump, the row-number bubble and Shift precision — invisible and
 * unclickable**. All it takes is totalWidth > panel width, which for a database
 * viewer is the normal case.
 *
 * Real geometry can only be computed by a real browser (node has no layout), so
 * what is guarded here is **the upstream of the causal chain**: who is whose
 * descendant. Both structures were measured against this very styles.css in
 * Electron 43:
 *   under .grid-wrap (current): scrollLeft 0 / 1000 / 2154 → vsb.right - grid.right
 *                               is always 0, and elementFromPoint at the thumb's
 *                               centre is always grid-vsb-thumb;
 *   under .grid      (old)    : the same three → 0 / -1000 / -2154, and hit
 *                               testing always returns null.
 * Put the structure back and the assertions below go red immediately; measuring
 * the geometry itself stays a job for acceptance on a real machine.
 * ================================================================== */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const GRID_TSX = src('../DataGrid.tsx')
const CSS = src('../../styles.css')

const sf = ts.createSourceFile('DataGrid.tsx', GRID_TSX, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement

function tagName(node: JsxNode): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.tagName.getText(sf)
}

/** className="literal" — every overlay node here uses a literal; dynamic class
 *  names are out of scope for this file. */
function className(node: JsxNode): string | null {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'className') continue
    const init = attr.initializer
    if (init && ts.isStringLiteral(init)) return init.text
  }
  return null
}

function collect(root: ts.Node): JsxNode[] {
  const out: JsxNode[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) out.push(n)
    n.forEachChild(walk)
  }
  walk(root)
  return out
}

const all = collect(sf)

function byClass(nodes: JsxNode[], cls: string): JsxNode | undefined {
  return nodes.find((n) => className(n) === cls)
}

function byTag(nodes: JsxNode[], tag: string): JsxNode | undefined {
  return nodes.find((n) => tagName(n) === tag)
}

/** The body of one CSS selector's declaration block. */
function cssBlock(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`)
  assert.notEqual(i, -1, `${selector} is not in styles.css`)
  const start = CSS.indexOf('{', i)
  const end = CSS.indexOf('}', start)
  return CSS.slice(start + 1, end)
}

describe('the scrollbar and the overlay must not descend from the horizontal scroll container', () => {
  const wrap = byClass(all, 'grid-wrap')
  const grid = byClass(all, 'grid')

  it('DataGrid still has both .grid-wrap and .grid, with .grid inside .grid-wrap', () => {
    assert.ok(wrap, '.grid-wrap is gone: the overlays lost their non-scrolling anchor')
    assert.ok(grid, '.grid is gone')
    assert.ok(collect(wrap!).includes(grid!), '.grid must sit inside .grid-wrap')
  })

  it('<GridScrollbar> is a sibling of .grid, not a descendant (it must not slide away)', () => {
    // ok(!x) rather than equal(x, undefined), so a failure does not diff the whole AST
    assert.ok(
      !byTag(collect(grid!), 'GridScrollbar'),
      'back inside .grid, the scrollbar slides out of view on the first horizontal scroll and cannot be clicked',
    )
    assert.ok(byTag(collect(wrap!), 'GridScrollbar'), 'the scrollbar must hang off .grid-wrap')
  })

  it('.grid-overlay (Running… / 0 rows) is a sibling of .grid too', () => {
    assert.ok(!byClass(collect(grid!), 'grid-overlay'), 'the overlay must not travel with scrollLeft either')
    assert.ok(byClass(collect(wrap!), 'grid-overlay'))
  })

  it('grid-inner no longer sets its own height: no DOM dimension derives from rowCount', () => {
    const inner = byClass(all, 'grid-inner')
    assert.ok(inner)
    const opening = ts.isJsxElement(inner!) ? inner!.openingElement : inner!
    const style = opening.attributes.properties
      .find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'style')
    assert.ok(style)
    const text = style!.getText(sf)
    assert.ok(!/height/i.test(text), `grid-inner's style must not mention height again: ${text}`)
  })
})

describe('positioning context and scroll axes in styles.css', () => {
  it('.grid-wrap is the positioning context and does not scroll', () => {
    const b = cssBlock('.grid-wrap')
    assert.match(b, /position:\s*relative/)
    assert.ok(!/overflow/.test(b), 'make .grid-wrap a scroll container and the overlays travel with the content again')
  })

  it('.grid scrolls horizontally only: vertical is hidden, so there is no height for Chromium to clamp', () => {
    const b = cssBlock('.grid')
    assert.match(b, /overflow-x:\s*auto/)
    assert.match(b, /overflow-y:\s*hidden/)
    assert.match(b, /overflow-anchor:\s*none/)
  })

  it('.grid-vsb and .grid-overlay are absolute, positioned against .grid-wrap', () => {
    assert.match(cssBlock('.grid-vsb'), /position:\s*absolute/)
    assert.match(cssBlock('.grid-overlay'), /position:\s*absolute/)
  })
})
