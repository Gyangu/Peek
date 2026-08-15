import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  asConnId,
  asPanelId,
  asSplitId,
  asViewId,
  createEmptyWorkspace,
  makePanel,
  type LayoutNode,
  type PanelId,
  type PanelNode,
  type ViewId,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { boundT } from '../../i18n'
import { LOCALES, type Locale } from '../../i18n/locales'
import {
  announcementFor,
  announcementMessage,
  panelAriaLabel,
  panelContentPhrase,
  panelFocusMessage,
  panelPositionOf,
  tabActivationMessage,
  tabPositionOf,
  type FocusProbe,
  type LayoutSnapshot,
} from '../announce'

/* ==================================================================
 * What a screen reader is told.
 *
 * The rule these tests exist to hold down is that **every message names a
 * position**. A view id is the right handle for MCP and useless out loud, and
 * "Query" on its own does not tell someone who cannot see the strip that two
 * more tabs are hiding behind it. Positions are also the shared vocabulary: the
 * numbers spoken here are the same depth-first ones ⌘⌥1 … ⌘⌥9 address and
 * `read_workspace` lists, so a user and the AI count panels alike.
 *
 * The second rule, and the one a refactor breaks silently, is that a view is
 * described the *same way* everywhere. `panelContentPhrase` is the single
 * builder behind the panel's own `aria-label` and both announcements; if the two
 * announcement sentences grew their own copies, a user arrowing between panels
 * and then between tabs would hear one view called two different things.
 * ================================================================== */

const t = boundT('en')

const P = (n: string): PanelId => asPanelId(`panel_${n}`)
const V = (n: string): ViewId => asViewId(`view_${n}`)

const panelOf = (n: string, views: string[] = [], active?: string): PanelNode =>
  makePanel(P(n), views.map(V), active === undefined ? undefined : V(active))

/** A query view with an explicit title, so the phrase under test is predictable. */
const titled = (n: string, title: string): ViewState => ({
  id: V(n),
  connId: asConnId('conn_1'),
  kind: 'query',
  text: `select ${n}`,
  status: 'idle',
  title,
})

/** An untitled table view, to check the fallback naming path. */
const table = (n: string): ViewState => ({
  id: V(n),
  connId: asConnId('conn_1'),
  kind: 'table',
  ref: { kind: 'relation', schema: 'public', name: 'orders' },
  page: { offset: 0, limit: 100 },
  status: 'idle',
})

function workspaceOf(layout: LayoutNode, views: ViewState[], focused?: PanelId): Workspace {
  const ws = createEmptyWorkspace(P('root'))
  ws.layout = layout
  ws.views = Object.fromEntries(views.map((v) => [v.id, v])) as Record<ViewId, ViewState>
  ws.focusedPanel = focused ?? null
  return ws
}

let splitSeq = 0
const split = (dir: 'row' | 'col', children: LayoutNode[]): LayoutNode => ({
  type: 'split',
  id: asSplitId(`split_${(splitSeq += 1)}`),
  dir,
  ratio: children.map(() => 1 / children.length),
  children,
})

/**
 * Four panels, nested, so the announced number is a depth-first position rather
 * than an index into a flat list. Visual order: a, b, c, d.
 */
const fourPanels = (b: PanelNode): LayoutNode =>
  split('row', [panelOf('a', ['1'], '1'), split('col', [b, panelOf('c')]), panelOf('d')])

/* ==================================================================
 * 1. Positions
 * ================================================================== */

describe('panelPositionOf', () => {
  it('numbers panels in the depth-first visual order, from one', () => {
    // The same order ⌘⌥N addresses and `read_workspace` lists. Announcing a
    // different numbering than the keyboard uses would make "panel 3" mean two
    // things in one window.
    const layout = split('row', [panelOf('a'), split('col', [panelOf('b'), panelOf('c')])])
    assert.deepEqual(panelPositionOf(layout, P('a')), { index: 1, total: 3 })
    assert.deepEqual(panelPositionOf(layout, P('b')), { index: 2, total: 3 })
    assert.deepEqual(panelPositionOf(layout, P('c')), { index: 3, total: 3 })
  })

  it('is null for a panel that is not in the tree', () => {
    // A panel closed between the state change and the effect that describes it.
    // Null lets the caller stay silent rather than announce "panel 0 of 3".
    assert.equal(panelPositionOf(panelOf('a'), P('gone')), null)
  })
})

describe('tabPositionOf', () => {
  it('numbers tabs in strip order, from one', () => {
    const panel = panelOf('a', ['1', '2', '3'], '2')
    assert.deepEqual(tabPositionOf(panel, V('1')), { index: 1, total: 3 })
    assert.deepEqual(tabPositionOf(panel, V('3')), { index: 3, total: 3 })
  })

  it('reads the stored order and never sorts it', () => {
    // P6: `viewIds` order *is* tab-bar order, and it is meaningful state. A
    // position computed against a sorted copy would name a tab the user cannot
    // find by counting along the strip.
    const panel = panelOf('a', ['9', '1', '5'], '1')
    assert.deepEqual(tabPositionOf(panel, V('9')), { index: 1, total: 3 })
    assert.deepEqual(tabPositionOf(panel, V('1')), { index: 2, total: 3 })
    assert.deepEqual(tabPositionOf(panel, V('5')), { index: 3, total: 3 })
  })

  it('is null for a view this panel does not hold', () => {
    assert.equal(tabPositionOf(panelOf('a', ['1']), V('2')), null)
    assert.equal(tabPositionOf(panelOf('a'), V('1')), null)
  })
})

/* ==================================================================
 * 2. Phrases
 * ================================================================== */

describe('panelContentPhrase', () => {
  it('names the visible view and where it sits in the strip', () => {
    const panel = panelOf('a', ['1', '2', '3'], '2')
    const ws = workspaceOf(panel, [titled('1', 'One'), titled('2', 'Two'), titled('3', 'Three')])
    assert.equal(panelContentPhrase(t, ws, panel), 'Two, tab 2 of 3')
  })

  it('omits the position on a single-tab panel', () => {
    // "Query, tab 1 of 1" spends three extra words restating what the absence of
    // a position already says, on the overwhelmingly common panel.
    const panel = panelOf('a', ['1'], '1')
    const ws = workspaceOf(panel, [titled('1', 'One')])
    assert.equal(panelContentPhrase(t, ws, panel), 'One')
  })

  it('describes an empty panel as empty rather than as nothing', () => {
    const panel = panelOf('a')
    assert.equal(panelContentPhrase(t, workspaceOf(panel, []), panel), t('panel.empty'))
  })

  it('names an untitled view the way the tab above it does', () => {
    // Same builder as the tab label (`viewTitleOf`), so the spoken name and the
    // drawn one cannot drift apart.
    const panel = panelOf('a', ['1'], '1')
    const ws = workspaceOf(panel, [table('1')])
    assert.equal(panelContentPhrase(t, ws, panel), 'public.orders')
  })

  it('never reads a raw id out loud when the view has gone missing', () => {
    // A tab whose view has already been dropped from the map — possible for one
    // render between a close landing and the layout patch arriving. An id is
    // unverifiable by someone who cannot check it against a screen.
    const panel = panelOf('a', ['1'], '1')
    const phrase = panelContentPhrase(t, workspaceOf(panel, []), panel)
    assert.ok(!phrase.includes('view_1'), `spoke a raw id: ${phrase}`)
  })
})

describe('panelAriaLabel', () => {
  it('carries the panel number, because it is read on entering the panel', () => {
    // `.panel` is a `role="group"`; this label is what answers "which panel am I
    // in", and the number is the one ⌘⌥N addresses.
    const layout = split('row', [panelOf('a', ['1'], '1'), panelOf('b', ['2'], '2')])
    const ws = workspaceOf(layout, [titled('1', 'One'), titled('2', 'Two')])
    assert.equal(panelAriaLabel(t, ws, panelOf('b', ['2'], '2')), 'Panel 2: Two')
  })

  it('says an empty panel is empty, and still numbers it', () => {
    const layout = split('row', [panelOf('a', ['1'], '1'), panelOf('b')])
    const ws = workspaceOf(layout, [titled('1', 'One')])
    assert.equal(panelAriaLabel(t, ws, panelOf('b')), 'Empty panel 2')
  })

  it('describes the view exactly as the announcements do', () => {
    // The single-builder rule, asserted rather than trusted: one view, two
    // surfaces, one wording.
    const panel = panelOf('a', ['1', '2'], '2')
    const ws = workspaceOf(panel, [titled('1', 'One'), titled('2', 'Two')], P('a'))
    const phrase = panelContentPhrase(t, ws, panel)
    assert.ok(panelAriaLabel(t, ws, panel).includes(phrase))
    assert.ok((panelFocusMessage(t, ws, P('a')) ?? '').includes(phrase))
    assert.ok((tabActivationMessage(t, ws, P('a')) ?? '').includes(phrase))
  })
})

/* ==================================================================
 * 3. The two announcements
 * ================================================================== */

describe('panelFocusMessage', () => {
  it('leads with where you now are, then what is there', () => {
    const layout = fourPanels(panelOf('b', ['2', '3'], '3'))
    const ws = workspaceOf(layout, [titled('1', 'One'), titled('2', 'Two'), titled('3', 'Three')])
    assert.equal(panelFocusMessage(t, ws, P('b')), 'Panel 2 of 4, Three, tab 2 of 2')
  })

  it('is null for a panel that is no longer in the tree', () => {
    const ws = workspaceOf(panelOf('a'), [])
    assert.equal(panelFocusMessage(t, ws, P('gone')), null)
  })
})

describe('tabActivationMessage', () => {
  it('leads with what is now showing, then where', () => {
    // The reverse order of the focus message, deliberately: a tab change is news
    // about the content, and the panel is the trailing context.
    const layout = fourPanels(panelOf('b', ['2', '3'], '3'))
    const ws = workspaceOf(layout, [titled('1', 'One'), titled('2', 'Two'), titled('3', 'Three')])
    assert.equal(tabActivationMessage(t, ws, P('b')), 'Three, tab 2 of 2, panel 2 of 4')
  })

  it('is null for a panel that is no longer in the tree', () => {
    assert.equal(tabActivationMessage(t, workspaceOf(panelOf('a'), []), P('gone')), null)
  })
})

/* ==================================================================
 * 3b. What gets announced at all
 * ================================================================== */

/**
 * A stand-in for the DOM. `inside` is "the caret ended up in this panel", `onTab`
 * the narrower "and on one of its tabs", `onPanel` "and on the panel's own
 * `role=group` element", which is the only place an "Empty panel N" label is
 * read out.
 */
const probe = (
  where: {
    inside?: PanelId[]
    onTab?: PanelId[]
    onPanel?: PanelId[]
  } = {},
): FocusProbe => ({
  insidePanel: (id) => (where.inside ?? []).includes(id),
  onTabIn: (id) => (where.onTab ?? []).includes(id),
  onPanelElement: (id) => (where.onPanel ?? []).includes(id),
})

const snapshot = (focusedPanel: PanelId | null, active: [PanelId, ViewId | null][]): LayoutSnapshot => ({
  focusedPanel,
  active: new Map(active),
})

describe('announcementFor — the live region speaks only what focus did not', () => {
  const twoPanels = (a: ViewId | null, b: ViewId | null): [PanelId, ViewId | null][] => [
    [P('a'), a],
    [P('b'), b],
  ]

  it('reports a focus move the caret did not follow', () => {
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('b'), twoPanels(V('1'), V('2')))
    assert.deepEqual(announcementFor(before, after, probe()), {
      kind: 'panelFocused',
      panelId: P('b'),
    })
  })

  it('stays silent when the caret followed — the group label was read already', () => {
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('b'), twoPanels(V('1'), V('2')))
    assert.equal(announcementFor(before, after, probe({ inside: [P('b')] })), null)
  })

  it('reports a tab change in a panel the caret is not in', () => {
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('1'), V('3')))
    assert.deepEqual(announcementFor(before, after, probe()), {
      kind: 'tabActivated',
      panelId: P('b'),
    })
  })

  it('stays silent when the caret is on a tab of the strip that changed', () => {
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('1'), V('3')))
    assert.equal(announcementFor(before, after, probe({ inside: [P('b')], onTab: [P('b')] })), null)
  })

  it('reports a panel emptying, which nothing else in the window reports', () => {
    // Closing the last tab leaves the panel behind, empty — the tab contract
    // makes that an ordinary thing to do. An earlier version returned early on
    // `activeViewId === null`, so a panel going blank was the one layout change
    // that produced neither a spoken sentence nor, when the caret had been in
    // the removed element, any focus at all.
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('1'), null))
    assert.deepEqual(announcementFor(before, after, probe()), {
      kind: 'panelEmptied',
      panelId: P('b'),
    })
  })

  it('stays silent when the caret landed on the emptied panel’s own element', () => {
    // R2's rescue put focus on the panel's `role="group"`, whose label now reads
    // "Empty panel N". Saying it again would be a stutter.
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('1'), null))
    assert.equal(announcementFor(before, after, probe({ onPanel: [P('b')] })), null)
  })

  it('still speaks when the caret is inside the emptied panel but not on it', () => {
    // The narrower probe earns its keep here. `.panel-body` is a `tabIndex={-1}`
    // div a click can land on, and once the tabs are gone it carries no role and
    // no accessible name — so a caret parked there is inside the panel and has
    // been told nothing. "Somewhere in the panel" would have called that covered.
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('1'), null))
    assert.deepEqual(announcementFor(before, after, probe({ inside: [P('b')] })), {
      kind: 'panelEmptied',
      panelId: P('b'),
    })
  })

  it('says nothing at all when two panels change at once', () => {
    // A re-layout, not a tab switch. Four sentences would bury the one that
    // mattered.
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('a'), twoPanels(V('9'), V('8')))
    assert.equal(announcementFor(before, after, probe()), null)
  })

  it('ignores panels that were not there before, so a split announces nothing', () => {
    const before = snapshot(P('a'), [[P('a'), V('1')]])
    const after = snapshot(P('a'), twoPanels(V('1'), V('2')))
    assert.equal(announcementFor(before, after, probe()), null)
  })

  it('says nothing when focus goes nowhere', () => {
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(null, twoPanels(V('1'), V('2')))
    assert.equal(announcementFor(before, after, probe()), null)
  })

  it('prefers the focus move when focus and content changed together', () => {
    // Where you are outranks what is in it: the caret's new home is the news.
    const before = snapshot(P('a'), twoPanels(V('1'), V('2')))
    const after = snapshot(P('b'), twoPanels(V('1'), V('3')))
    assert.deepEqual(announcementFor(before, after, probe()), {
      kind: 'panelFocused',
      panelId: P('b'),
    })
  })
})

describe('announcementMessage', () => {
  it('speaks an emptied panel with the same words its aria-label uses', () => {
    // One wording, two routes to it: whether focus landed on the group (the
    // label is read) or not (this sentence is spoken), the user hears the same
    // thing about the same panel.
    const layout = fourPanels(panelOf('b'))
    const ws = workspaceOf(layout, [titled('1', 'One')])
    const message = announcementMessage(t, ws, { kind: 'panelEmptied', panelId: P('b') })
    assert.equal(message, 'Empty panel 2')
    assert.equal(message, panelAriaLabel(t, ws, panelOf('b')))
  })

  it('is null for a panel that has left the tree', () => {
    const ws = workspaceOf(panelOf('a', ['1'], '1'), [titled('1', 'One')])
    assert.equal(announcementMessage(t, ws, { kind: 'panelEmptied', panelId: P('gone') }), null)
  })

  it('routes the other two kinds to their own builders', () => {
    const layout = fourPanels(panelOf('b', ['2', '3'], '3'))
    const ws = workspaceOf(layout, [titled('2', 'Two'), titled('3', 'Three')])
    assert.equal(
      announcementMessage(t, ws, { kind: 'panelFocused', panelId: P('b') }),
      panelFocusMessage(t, ws, P('b')),
    )
    assert.equal(
      announcementMessage(t, ws, { kind: 'tabActivated', panelId: P('b') }),
      tabActivationMessage(t, ws, P('b')),
    )
  })
})

/* ==================================================================
 * 4. Every locale, not only English
 * ================================================================== */

describe('every locale produces a spoken sentence, not a key', () => {
  it('fills each announcement in each locale', () => {
    // A missing key renders as the key itself, which a screen reader would read
    // out as "a11y dot announce dot panel focused". That is the failure mode this
    // catches, and it is invisible to anyone testing in English.
    const layout = fourPanels(panelOf('b', ['2', '3'], '3'))
    const ws = workspaceOf(layout, [titled('1', 'One'), titled('2', 'Two'), titled('3', 'Three')])
    for (const { id } of LOCALES) {
      const tl = boundT(id as Locale)
      for (const [name, message] of [
        ['panelFocused', panelFocusMessage(tl, ws, P('b'))],
        ['tabActivated', tabActivationMessage(tl, ws, P('b'))],
        ['ariaLabel', panelAriaLabel(tl, ws, panelOf('b', ['2', '3'], '3'))],
      ] as const) {
        assert.ok(message, `${id}: ${name} produced nothing`)
        assert.ok(!message.startsWith('a11y.'), `${id}: ${name} rendered a raw key: ${message}`)
        // The view title and the positions have to survive interpolation in every
        // locale; a translation that dropped a placeholder would still be a
        // grammatical sentence, and useless.
        assert.ok(message.includes('Three'), `${id}: ${name} lost the view title: ${message}`)
        assert.ok(message.includes('2'), `${id}: ${name} lost its positions: ${message}`)
      }
    }
  })

  it('fills the empty-panel wording, which is now spoken and not only read', () => {
    // `a11y.panel.empty` used to reach a screen reader in one way only — as the
    // panel's label, when focus happened to land there. It is now also the
    // sentence announced when a panel empties without the caret following, so a
    // locale missing the key would be read out as "a11y dot panel dot empty".
    const ws = workspaceOf(fourPanels(panelOf('b')), [])
    for (const { id } of LOCALES) {
      const tl = boundT(id as Locale)
      const message = announcementMessage(tl, ws, { kind: 'panelEmptied', panelId: P('b') })
      assert.ok(message, `${id}: produced nothing`)
      assert.ok(!message.startsWith('a11y.'), `${id}: rendered a raw key: ${message}`)
      assert.ok(message.includes('2'), `${id}: lost the panel number: ${message}`)
    }
  })
})
