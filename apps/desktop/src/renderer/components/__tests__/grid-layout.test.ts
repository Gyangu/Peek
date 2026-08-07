import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { blankComments } from '../../__tests__/sourceScan'

/* ==================================================================
 * A regression net over the **structural invariants** of the grid's overlays.
 *
 * The incident itself: after `.grid-scroll` went from scrolling on both axes to
 * "native horizontal, hand-drawn vertical", the hand-drawn scrollbar was still
 * rendered inside `.grid-scroll`. Absolutely positioned descendants of a horizontal
 * scroll container count as scrollable content and translate with scrollLeft;
 * add `.grid-scroll`'s `contain: layout paint` clipping on top and
 * **one horizontal scroll takes away the only vertical scrollbar, along with
 * drag-to-jump, the row-number bubble and Shift precision — invisible and
 * unclickable**. All it takes is totalWidth > panel width, which for a database
 * viewer is the normal case.
 *
 * Real geometry can only be computed by a real browser (node has no layout), so
 * what is guarded here is **the upstream of the causal chain**: who is whose
 * descendant. Both structures were measured against these very rules in
 * Electron 43:
 *   under .grid-wrap   (current): scrollLeft 0 / 1000 / 2154 → vsb.right -
 *                                 grid.right is always 0, and elementFromPoint at
 *                                 the thumb's centre is always grid-vsb-thumb;
 *   under .grid-scroll (old)    : the same three → 0 / -1000 / -2154, and hit
 *                                 testing always returns null.
 * Put the structure back and the assertions below go red immediately; measuring
 * the geometry itself stays a job for acceptance on a real machine.
 * ================================================================== */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const GRID_TSX = src('../DataGrid.tsx')

/**
 * What is left of the grid's stylesheet after the Tailwind migration
 * (2026-08-04): the rules no class list can hold. `.grid-scroll` is one of them
 * — see the note on the describe block below — so this file still reads it.
 *
 * It was `components/grid.css` until the eight sheets were merged back into one
 * `styles.css` (§11.1), and a whole-file read would be wrong here rather than
 * merely wider: the last assertion in this file says *every selector in this
 * section is `grid-`-prefixed*, which is true of the grid's own vocabulary and
 * false of the window's. So the section is sliced out by the banner the merged
 * sheet carries — `SHEET: grid`, up to the next `SHEET:` line or the end.
 *
 * The slice is asserted to be non-empty and to be smaller than the file, which
 * is the same guard `stylesheets()` carries: a marker that stops matching would
 * otherwise hand every assertion below an empty string and pass.
 */
function sheetSection(id: string): string {
  const css = src('../../styles.css')
  const open = new RegExp(`^/\\* #+ SHEET: ${id} .*$`, 'm').exec(css)
  assert.ok(open, `styles.css has no "SHEET: ${id}" banner; the merged sheet's section markers moved`)
  const rest = css.slice(open.index + open[0].length)
  const next = /^\/\* #+ SHEET: /m.exec(rest)
  const body = next ? rest.slice(0, next.index) : rest
  assert.ok(body.trim().length > 0, `the "SHEET: ${id}" section is empty`)
  assert.ok(body.length < css.length, `the "SHEET: ${id}" slice took the whole file`)
  return body
}

const CSS = sheetSection('grid')

const sf = ts.createSourceFile('DataGrid.tsx', GRID_TSX, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement

function tagName(node: JsxNode): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.tagName.getText(sf)
}

/** className="literal" — every overlay node here uses a literal; dynamic class
 *  names are out of scope for this file. */
function classAttr(node: JsxNode): string | null {
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

/**
 * The classes on a node, as a set.
 *
 * A className used to *be* a name; after the Tailwind migration it is a list, of
 * which one entry is still the name. The four `grid-*` names this file looks for
 * survive on purpose — a utility says what a node looks like and cannot say
 * which node it is, and "which node" is the entire subject of this file. See the
 * comment above `.grid-wrap` in DataGrid.tsx.
 */
function classesOf(node: JsxNode): Set<string> {
  return new Set((classAttr(node) ?? '').split(/\s+/).filter(Boolean))
}

function byClass(nodes: JsxNode[], cls: string): JsxNode | undefined {
  return nodes.find((n) => classesOf(n).has(cls))
}

function byTag(nodes: JsxNode[], tag: string): JsxNode | undefined {
  return nodes.find((n) => tagName(n) === tag)
}

/** The body of one CSS selector's declaration block. */
function cssBlock(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`)
  assert.notEqual(i, -1, `${selector} is not in the grid section of styles.css`)
  const start = CSS.indexOf('{', i)
  const end = CSS.indexOf('}', start)
  return CSS.slice(start + 1, end)
}

describe('the scrollbar and the overlay must not descend from the horizontal scroll container', () => {
  const wrap = byClass(all, 'grid-wrap')
  const gridScroll = byClass(all, 'grid-scroll')

  it('DataGrid still has both .grid-wrap and .grid-scroll, with .grid-scroll inside .grid-wrap', () => {
    assert.ok(wrap, '.grid-wrap is gone: the overlays lost their non-scrolling anchor')
    assert.ok(gridScroll, '.grid-scroll is gone')
    assert.ok(collect(wrap!).includes(gridScroll!), '.grid-scroll must sit inside .grid-wrap')
  })

  it('<GridScrollbar> is a sibling of .grid-scroll, not a descendant (it must not slide away)', () => {
    // ok(!x) rather than equal(x, undefined), so a failure does not diff the whole AST
    assert.ok(
      !byTag(collect(gridScroll!), 'GridScrollbar'),
      'back inside .grid-scroll, the scrollbar slides out of view on the first horizontal scroll and cannot be clicked',
    )
    assert.ok(byTag(collect(wrap!), 'GridScrollbar'), 'the scrollbar must hang off .grid-wrap')
  })

  it('.grid-overlay (Running… / 0 rows) is a sibling of .grid-scroll too', () => {
    assert.ok(!byClass(collect(gridScroll!), 'grid-overlay'), 'the overlay must not travel with scrollLeft either')
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

/*
 * Same three facts, read where each of them now lives.
 *
 * `.grid-scroll` is still a rule in the sheet, and had to be: `overflow-anchor` and
 * `contain` have no utility class at all, and those two are the same decision as
 * the two `overflow` axes beside them. The other three moved into class lists
 * with the elements that wear them, so the assertions follow them there rather
 * than being deleted for having nowhere to look.
 */
describe('positioning context and scroll axes', () => {
  it('.grid-wrap is the positioning context and does not scroll', () => {
    const c = classesOf(byClass(all, 'grid-wrap')!)
    assert.ok(c.has('relative'), '.grid-wrap must establish the positioning context for the overlays')
    assert.ok(
      ![...c].some((n) => n.startsWith('overflow')),
      'make .grid-wrap a scroll container and the overlays travel with the content again',
    )
  })

  it('.grid-scroll scrolls horizontally only: vertical is hidden, so there is no height for Chromium to clamp', () => {
    // Read off the element, not out of the stylesheet. `.grid-scroll` was a rule
    // for one reason — this assertion read it there — and the rule's own note
    // claimed `contain: layout paint` had no utility, which stopped being true in
    // Tailwind 4.3.3 (`contain-layout` + `contain-paint` compile and compose).
    // §29.11.8 moved the whole thing onto the element.
    const worn = new Set(
      /['"]([^'"]*\bgrid-scroll\b[^'"]*)['"]/.exec(blankComments(GRID_TSX))?.[1].split(/\s+/) ?? [],
    )
    for (const u of ['overflow-x-auto', 'overflow-y-hidden', 'overflow-anchor-none']) {
      assert.ok(
        worn.has(u),
        `the horizontal scroll container no longer wears \`${u}\`. It wears: ${[...worn].join(' ')}`,
      )
    }
  })

  it('.grid-vsb and .grid-overlay are absolute, positioned against .grid-wrap', () => {
    // The scrollbar is written in GridScrollbar.tsx, which this file does not
    // parse; the track is the class list that still carries the `grid-vsb` name.
    const track = [...src('../GridScrollbar.tsx').matchAll(/className="([^"]*)"/g)]
      .map((m) => m[1].split(/\s+/))
      .find((names) => names.includes('grid-vsb'))
    assert.ok(track, 'the .grid-vsb track is gone from GridScrollbar.tsx')
    assert.ok(track!.includes('absolute'), 'the scrollbar track must be absolute against .grid-wrap')
    assert.ok(classesOf(byClass(all, 'grid-overlay')!).has('absolute'))
  })
})

/* ==================================================================
 * The row and its cells, after the last three rules left the grid's stylesheet.
 *
 * Four descendant selectors used to paint a cell from the row above it —
 * hover, the zebra stripe, and the staged selection twice over — and their
 * precedence was the order they were written in. None of that survives a class
 * list, so the same five facts are now split between two mechanisms, and both
 * of them are silent when they break:
 *
 *   - the pointer, which JSX cannot observe, is a `group` on the row plus a
 *     hover variant on the cell. Drop the `group` and every cell simply stops
 *     reacting — no error, no missing class, just a grid that no longer
 *     highlights the row under the cursor;
 *   - everything else is chosen in `cellSurfaceClass`, one complete string per
 *     state, because two backgrounds in one class list are ordered by
 *     Tailwind's emission and not by us.
 *
 * The third fact below is the one this whole module is careful about: the row's
 * height reaches the DOM twice, as a utility and as an inline pixel value, and
 * `vscroll.ts` does its arithmetic in the same number. A drift of one pixel is
 * invisible on screen and is a wrong scroll offset half a million rows down.
 * ================================================================== */
describe('the row paints its cells through a group, not through descendant selectors', () => {
  const FORMAT = src('../../util/format.ts')

  /** The body of one `const NAME = '…'` string in a module. */
  const constant = (file: string, name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*[\`']([^\`']*)[\`']`).exec(file)
    assert.ok(m, `${name} is gone`)
    return m[1]
  }

  it('the row is a hover group and the cells read it with a variant', () => {
    const row = constant(GRID_TSX, 'ROW_CLASS').split(/\s+/)
    assert.ok(
      row.includes('group'),
      `the row must carry \`group\`, or no cell can see the pointer: ${row.join(' ')}`,
    )
    const resting = constant(FORMAT, 'SURFACE_REST').split(/\s+/)
    assert.ok(
      resting.some((n) => n.startsWith('group-hover:bg-')),
      'a resting cell no longer changes background while its row is hovered',
    )
  })

  it('every cell surface states exactly one background', () => {
    // The `!important` on the old focused-cell rule was there because four
    // selectors argued about this property. A class list gives no such argument
    // and no such warning: the loser is decided in the stylesheet Tailwind
    // emits, so the rule is one background per state, stated whole.
    for (const name of ['SURFACE_REST', 'SURFACE_STRIPE', 'SURFACE_ROW_SELECTED', 'SURFACE_CELL_SELECTED']) {
      const plain = constant(FORMAT, name)
        .split(/\s+/)
        .filter((n) => /^bg-/.test(n))
      assert.equal(
        plain.length,
        1,
        `${name} states ${String(plain.length)} unconditional backgrounds (${plain.join(', ')}); ` +
          `which one wins is Tailwind's emission order, not this file's`,
      )
    }
  })

  it('a staged row does not change under the pointer, and the focused cell outranks both', () => {
    assert.ok(
      !/group-hover:/.test(constant(FORMAT, 'SURFACE_ROW_SELECTED')),
      'a staged row used to keep its wash while hovered; a hover variant here would take it away',
    )
    assert.ok(
      !/group-hover:/.test(constant(FORMAT, 'SURFACE_CELL_SELECTED')),
      'the focused cell used to win with !important, hover included',
    )
  })

  it('the row height is one number in three places', () => {
    // --spacing-row → `h-row` on the element, and ROW_H in the driver. The two
    // have to agree or a long scroll lands somewhere else than it says.
    assert.ok(
      constant(GRID_TSX, 'ROW_CLASS').split(/\s+/).includes('h-row'),
      'the row must take its height from --spacing-row, not from a number',
    )
    const theme = src('../../styles.css')
    const spacing = /--spacing-row:\s*([0-9.]+)px/.exec(theme)
    assert.ok(spacing, '--spacing-row is gone from @theme')
    const rowH = /export const ROW_H\s*=\s*([0-9.]+)/.exec(src('../vscroll.ts'))
    assert.ok(rowH, 'ROW_H is gone from vscroll.ts')
    assert.equal(
      Number(spacing![1]),
      Number(rowH![1]),
      '--spacing-row and ROW_H have drifted apart: the DOM and the scroll arithmetic now disagree',
    )
  })

  it('the grid section declares nothing that would silently outrank the class lists', () => {
    // This sheet is unlayered, so it beats every utility for any property it
    // names. That is safe only while it names one: `font-size`, which no class
    // on the row sets. A second declaration here would win in silence.
    const props = [...cssBlock('.grid-row').matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1])
    assert.deepEqual(
      props,
      ['font-size'],
      'the row rule has grown past the one declaration a utility class cannot express',
    )
    assert.ok(
      !/^\.grid-(cell|rownum)/m.test(CSS),
      'a rule for the cell or the gutter is back in the grid section, where it outranks the class list on it',
    )
  })

  it('every selector in the grid section is grid-prefixed, so none of them can be a utility name', () => {
    /*
     * The other half of "unlayered beats layered", and the half that bites in
     * the direction nobody looks. A bare identity name that happens to also be
     * a Tailwind utility does not just pick up that utility — it dresses every
     * element wearing the *utility* in this whole sheet's rule for it, silently
     * and everywhere.
     *
     * That is not hypothetical: this rule was `.grid` until 2026-08-04, and
     * `FirstRunGuide`, which writes `grid` meaning `display: grid`, was wearing
     * nine of the scroll container's declarations — measured in Electron,
     * including a `--color-bg` rectangle over a `bg-bg-1` sidebar. Migration
     * record §12.9.
     *
     * The prefix is the cheap invariant that forecloses the whole shape: no
     * Tailwind utility is named `grid-<something>` that we would ever mint here.
     */
    const selectors = [...CSS.matchAll(/^\.([a-z][\w-]*)/gm)].map((m) => m[1])
    assert.ok(selectors.length > 0, 'no class selectors found in the grid section — did the parse break?')
    const bare = selectors.filter((s) => !s.startsWith('grid-'))
    assert.deepEqual(
      bare,
      [],
      `the grid section must only define grid-*-prefixed names; ${bare.join(', ')} is a bare name that a ` +
        'Tailwind utility can collide with, and this sheet is unlayered so the collision is silent',
    )
  })
})

/* ==================================================================
 * "Add what I am looking at to the chat" — is it actually reachable?
 *
 * This whole feature shipped once as a directory of correct, tested, and
 * completely unmounted components: nothing outside `context-actions/` imported
 * `SelectionActionBar` or `ContextMenu`, the grid had no row selection at all,
 * and three of the six attachment kinds were unreachable by a human. Every unit
 * test in that directory passed the entire time, because a component that is
 * never rendered fails no test.
 *
 * So the invariant guarded here is mounting, not behaviour: the grid holds a
 * selection, offers the two surfaces, and puts the floating bar where it can be
 * seen — the bar is `absolute` (a class on its own root since the Tailwind
 * migration, not a rule in `context-actions.css`), so inside `.grid-scroll` it would
 * slide out of view on the first horizontal scroll exactly as the scrollbar once
 * did.
 * ================================================================== */
describe('the grid is where a chat attachment is created', () => {
  const wrap = byClass(all, 'grid-wrap')
  const gridScroll = byClass(all, 'grid-scroll')

  it('DataGrid holds a row selection and drives it with the shared click rules', () => {
    assert.match(GRID_TSX, /applyRowClick/, 'the grid must use the shared selection rules, not its own')
    assert.match(GRID_TSX, /RowSelection/)
    assert.match(GRID_TSX, /e\.shiftKey/, 'shift-click extends a range')
    assert.match(GRID_TSX, /e\.metaKey \|\| e\.ctrlKey/, 'cmd/ctrl-click toggles one row')
  })

  it('<SelectionActionBar> is mounted, and outside the horizontal scroll container', () => {
    assert.ok(byTag(all, 'SelectionActionBar'), 'the selection bar is unmounted again: selecting rows leads nowhere')
    assert.ok(
      !byTag(collect(gridScroll!), 'SelectionActionBar'),
      'inside .grid-scroll the bar translates with scrollLeft and disappears',
    )
    assert.ok(byTag(collect(wrap!), 'SelectionActionBar'), 'it must hang off .grid-wrap, like the scrollbar')
  })

  it('<ContextMenu> is mounted and opens from a right-click on a row', () => {
    assert.ok(byTag(all, 'ContextMenu'), 'right-click offers nothing again')
    assert.match(GRID_TSX, /onContextMenu=/, 'the row has to open it')
  })

  it('the selection bar is absolute, so its anchor is load-bearing', () => {
    // Read from the component, not from `context-actions.css`, because that is
    // where the declaration went: the bar's fifteen rules are a class list on
    // its root element after the Tailwind migration, and the sheet keeps only
    // the consent dialog's width. Same fact, one file over.
    const bar = src('../context-actions/SelectionActionBar.tsx')
    const root = /className="([^"]*)"[\s\S]*?role="toolbar"/.exec(bar)
    assert.ok(root, 'SelectionActionBar no longer has a root toolbar with a literal className')
    assert.ok(
      root[1].split(/\s+/).includes('absolute'),
      `the bar must stay absolutely positioned; its classes are: ${root[1]}`,
    )
  })
})
