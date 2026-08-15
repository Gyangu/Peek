import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { MODAL_SHELL, MODAL_SIZE } from '../../modalClasses'

/* ==================================================================
 * The disclosure has to stay answerable, not just readable.
 *
 * ## The incident
 *
 * The dialog's shell clips its own overflow and the shared size object caps it
 * at 80% of the viewport height. For as long as there had been a consent dialog,
 * its five paragraphs and its two buttons sat *directly* in that clipped box —
 * the only dialog in the window whose middle was not a scrolling region. Nothing
 * announced that; it simply happened to fit.
 *
 * Measured in Electron against the built stylesheet, at the product's floor
 * viewport (the window's 600px minimum height at the 1.5 zoom ceiling gives a
 * 400px CSS viewport, so an 80vh cap of 320px): the dialog wanted 296px in
 * English and 260px in zh-CN. Twenty-four pixels of margin. One narrowing had
 * already spent two thirds of it — 760px to 520px pushed the English copy from
 * 240px to 296px — and one more sentence of copy, one more locale, or one step
 * of zoom would have taken the rest.
 *
 * Past that point the buttons are *below* a box with a hidden overflow. Not
 * scrolled out of view — laid out and then clipped away, with no scrollbar and
 * nothing to scroll. Escape still cancels. So the failure mode is a disclosure
 * that can only be refused, which fails closed for data and fails shut for the
 * feature: measured at a 320px viewport, the English accept button lands at
 * y=287..313 against a shell that ends at 288, and a hit test at its centre
 * returns the shell rather than the button.
 *
 * ## Why an assertion and not a measurement
 *
 * Because the measurement is the thing that keeps being redone and the property
 * is the thing that keeps being lost. This same audit round found the caution
 * button's dashed edge — the one thing distinguishing it from `danger` without
 * relying on hue — could be deleted with every test green. An accessibility
 * property that holds only because somebody measured it last quarter is one
 * refactor from not holding.
 *
 * So this pins the *shape*: the prose scrolls, the answer does not, and the two
 * are not the same box. It deliberately does not pin any padding, any size or
 * any of the class strings that make this dialog look unlike the others — that
 * difference is meaningful (it is the one dialog gating what leaves the machine)
 * and it is free to be restyled.
 *
 * ## The channel this file read, and the one that outranks it
 *
 * Everything above is read out of **class strings**. That was enough for exactly
 * as long as nobody wrote through the other channel, and two ways of doing so
 * were measured on this dialog:
 *
 *  - An inline `style` of `overflow: visible; flex: none` on the scrolling
 *    region. **Every class byte-identical**, the whole suite green, the artifact
 *    byte-identical — an inline declaration is never in a stylesheet and never in
 *    the artifact, it rides in the JS bundle and outranks both — and the original
 *    defect back: at a 320px viewport the English Accept lands at y=287..313
 *    against a shell ending at 288, and a hit test at its centre returns the
 *    scrim.
 *  - Deleting the column direction from the shared shell. The two regions become
 *    flex items on the *horizontal* axis, so "takes the slack" and "refuses to
 *    shrink" both stop meaning what this file says they mean: the shell balloons
 *    to the 320px ceiling and the Accept box measures 298px tall. Also green.
 *
 * Hence the two sections at the bottom. The second is one line and belongs with
 * the other premise: what a flex-child class does is decided by an axis stated
 * somewhere else.
 *
 * The first has to be **narrow and it has to say so**, because an inline `style`
 * is the house idiom here rather than a smell: the shell two elements up wears
 * one, and `modalClasses.ts` argues at length that a size which is not a step on
 * any scale belongs in a `style` attribute and not in the token layer. A blanket
 * ban would be a fence against the wrong thing and the next author would be right
 * to route around it. So the rule is scoped twice over — to the three elements
 * this file reasons about, and to the handful of properties it reasons *with*.
 * A size on the shell stays legal, and the one that is already there is checked
 * by name a few lines above rather than waved through.
 * ================================================================== */

const SRC = readFileSync(fileURLToPath(new URL('../ConsentDialog.tsx', import.meta.url)), 'utf8')
const sf = ts.createSourceFile('ConsentDialog.tsx', SRC, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement
type Element = ts.JsxElement | ts.JsxSelfClosingElement

function opening(node: Element): Opening {
  return ts.isJsxElement(node) ? node.openingElement : node
}

/** The class names written into this element's own `className`, string literals only. */
function classesOf(node: Element): string[] {
  const attr = opening(node).attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className',
  )
  if (attr?.initializer === undefined) return []
  const text = attr.initializer.getText(sf)
  const out: string[] = []
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    for (const name of (m[1] ?? m[2] ?? '').split(/\s+/)) if (name !== '') out.push(name)
  }
  return out
}

/**
 * The properties this element's `style` attribute sets, or `null` for no
 * attribute. `own` is false for a property that arrives through a spread.
 *
 * It refuses rather than guesses, which is the rule §15.2 of the migration
 * record settled on for the className fence and for the same reason: following a
 * name one hop covers one spelling of an indirection while reading, to the next
 * author, as though it covered the idea. `style={SOMETHING}` is therefore a
 * failure here, not a pass — an unreadable value is the shape a bypass takes.
 *
 * The single exception is not a hop: `MODAL_SIZE` is imported into this file and
 * its `maxHeight` is asserted by name in the premise test, so its keys are as
 * visible from here as a literal's.
 */
function styleProperties(node: Element): { name: string; own: boolean }[] | null {
  const attr = opening(node).attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'style',
  )
  if (attr === undefined) return null

  const init = attr.initializer
  const expr = init !== undefined && ts.isJsxExpression(init) ? init.expression : undefined
  assert.ok(
    expr !== undefined && ts.isObjectLiteralExpression(expr),
    `the \`style\` on <${opening(node).tagName.getText(sf)}> is not an object literal written in the ` +
      'tag, so this file cannot read which properties it sets — and an inline declaration outranks ' +
      'every class string this file reads. Write the object at the call site.',
  )

  const out: { name: string; own: boolean }[] = []
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      out.push({ name: prop.name.getText(sf).replace(/^['"]|['"]$/g, ''), own: true })
      continue
    }
    if (ts.isSpreadAssignment(prop) && prop.expression.getText(sf) === 'MODAL_SIZE') {
      for (const name of Object.keys(MODAL_SIZE)) out.push({ name, own: false })
      continue
    }
    assert.fail(
      `\`${prop.getText(sf)}\` in this element's inline style is something this file cannot read. ` +
        'The one indirection it resolves is the shared size object, because that object is imported ' +
        'here and pinned by name above. Anything else has to be written out.',
    )
  }
  return out
}

function elements(root: ts.Node): Element[] {
  const out: Element[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) out.push(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
  return out
}

/** Element children of a JSX element, skipping text and expression containers. */
function childElements(node: ts.JsxElement): Element[] {
  return node.children.filter((c): c is Element => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))
}

/** The dialog panel: the element that interpolates the shared shell. */
function shell(): ts.JsxElement {
  const found = elements(sf).filter((el) => {
    if (!ts.isJsxElement(el)) return false
    const attr = opening(el).attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className',
    )
    return attr?.initializer?.getText(sf).includes('MODAL_SHELL') === true
  })
  assert.equal(found.length, 1, 'expected exactly one element wearing the shared dialog shell')
  return found[0] as ts.JsxElement
}

/** The one child of the shell that scrolls. */
function scroller(): Element {
  const found = childElements(shell()).filter((el) => {
    const c = classesOf(el)
    return c.includes('overflow-auto') && c.includes('flex-1') && c.includes('min-h-0')
  })
  assert.equal(
    found.length,
    1,
    'expected exactly one scrolling region directly inside the shell. Zero means the dialog is ' +
      'back to laying its content out inside a box that clips and cannot scroll; two means the ' +
      'reader has to work out which one holds the prose',
  )
  return found[0] as Element
}

/** The one child of the shell that holds the answers. */
function row(): Element {
  const found = childElements(shell()).filter((el) => el.getText(sf).includes('context.consent.accept'))
  assert.equal(found.length, 1, 'expected the answers to sit in one row, directly inside the shell')
  return found[0] as Element
}

/**
 * The properties this file's reasoning is made of.
 *
 * Not "layout properties" and not "properties that could matter" — these are the
 * ones the assertions below actually spend: the shell clips (`overflow*`), it is
 * a column of flex children (`display`, `flexDirection`), it has a ceiling
 * (`height`, `maxHeight`), the prose region takes the slack and may shrink to
 * nothing (`flex*`, `minHeight`), the answer row refuses to (`flex*`), and both
 * of them are in the flow at all (`position`).
 *
 * Kept short on purpose. A list of everything CSS can do would ban the size that
 * is legitimately there and turn this into the blanket rule the header explains
 * why not to write.
 */
const CLAIMED_PROPERTIES: ReadonlySet<string> = new Set([
  'overflow',
  'overflowX',
  'overflowY',
  'display',
  'flexDirection',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'minHeight',
  'maxHeight',
  'height',
  'position',
])

describe('the disclosure cannot become a dialog that can only be refused', () => {
  it('the premise still holds: the shell clips, and the size object caps its height', () => {
    // If either of these stops being true the reasoning below is about a dialog
    // that no longer exists — which is a thing to read, not a thing to skip.
    assert.ok(
      MODAL_SHELL.split(/\s+/).includes('overflow-hidden'),
      'the shell no longer clips its own overflow; re-derive whether the split below is still what ' +
        'keeps the buttons reachable before relaxing anything here',
    )
    // The axis. Every flex-child class read below says how a box behaves along
    // it, and neither of them says which one it is — that is stated once, here,
    // in a shared string in another module. Take the direction away and the two
    // regions lay out side by side: "takes the slack" and "refuses to shrink"
    // both go on being true and both stop meaning what this file says. Measured:
    // the shell balloons to the 320px ceiling and the accept box is 298px tall,
    // with every case in this file still green.
    const shellClasses = MODAL_SHELL.split(/\s+/)
    for (const [name, why] of [
      ['flex', 'the shell no longer lays its children out as flex items at all'],
      ['flex-col', 'the shell no longer stacks its children vertically'],
    ] as const) {
      assert.ok(
        shellClasses.includes(name),
        `${why}. The scrolling region and the answer row below are flex children of it, and every ` +
          'claim this file makes about them is a claim about the vertical axis. Re-derive them ' +
          'against whatever the shell does now before relaxing anything here.',
      )
    }
    assert.equal(
      MODAL_SIZE.maxHeight,
      '80vh',
      'the shared height ceiling moved. At the floor viewport (400px CSS) 80vh is 320px and the ' +
        'English copy measures 296px, so the margin this dialog lives on is 24px — a different ' +
        'ceiling is a different margin and wants measuring again',
    )
  })

  it('every paragraph of the disclosure is inside the scrolling region', () => {
    const inside = scroller().getText(sf)
    for (const key of ['title', 'body', 'scope', 'production', 'once']) {
      assert.ok(
        inside.includes(`context.consent.${key}`),
        `context.consent.${key} is outside the scrolling region, so it is clipped rather than ` +
          'scrolled the moment the viewport is short enough',
      )
    }
  })

  it('neither answer is inside it, and the row holding them cannot be squeezed', () => {
    const inside = scroller().getText(sf)
    for (const key of ['accept', 'cancel']) {
      assert.ok(
        !inside.includes(`context.consent.${key}`),
        `context.consent.${key} is inside the scrolling region. A control that scrolls away with ` +
          'the prose is exactly the failure this file describes, one indirection later',
      )
    }

    assert.ok(
      classesOf(row()).includes('flex-none'),
      'the action row must refuse to shrink. Without it the row is a flex item that can be ' +
        'compressed by the prose above it, which puts the buttons back under the clip',
    )
  })

  it('the scrolling region is reachable from the keyboard', () => {
    // A scroll container holding no focusable element cannot be scrolled by
    // keyboard: the arrow keys act on the scrolling ancestor of whatever has
    // focus, and what has focus here is a button in the row *below* this box.
    // Without this the prose is readable by mouse only, which for the one dialog
    // that has to be read before it is answered is the same bug wearing gloves.
    const attrs = opening(scroller()).attributes.properties
    const tab = attrs.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'tabIndex',
    )
    assert.ok(tab !== undefined, 'the scrolling region needs tabIndex to be keyboard-scrollable')
    assert.match(
      tab.initializer?.getText(sf) ?? '',
      /\{\s*0\s*\}/,
      'tabIndex must be 0 — a negative one is reachable by script and not by Tab, which is the ' +
        'half that does not help here',
    )
  })

  it('no inline style states a property these assertions are made of', () => {
    for (const [label, node] of [
      ['the shell', shell()],
      ['the scrolling region', scroller()],
      ['the answer row', row()],
    ] as const) {
      const claimed = (styleProperties(node) ?? []).filter((p) => p.own && CLAIMED_PROPERTIES.has(p.name))
      assert.deepEqual(
        claimed.map((p) => p.name),
        [],
        `${label} sets ${claimed.map((p) => `\`${p.name}\``).join(', ')} in an inline style.\n\n` +
          'Everything this file asserts, it reads out of class strings — and an inline declaration ' +
          'is not in a stylesheet, not in the built artifact, and beaten by nothing: it is compiled ' +
          'into the bundle and written onto the element at runtime. So a class-string assertion ' +
          'about a box that also carries one of these properties inline is an assertion about a ' +
          'string that does not decide anything. Planted as two properties on the scrolling region, ' +
          'with every class byte-identical, it restored the original defect with the whole suite ' +
          'green and the artifact unchanged.\n\n' +
          'The ban is deliberately only these three boxes and only the properties listed in ' +
          'CLAIMED_PROPERTIES. An inline style is the right answer for a size that is not a step on ' +
          'any scale — modalClasses.ts makes that case and the shell is the caller taking it up. ' +
          'If one of these boxes genuinely needs one of these properties inline, it needs the ' +
          'assertion that reads it rewritten first, not an exemption bolted on here.',
      )
    }
  })
})
