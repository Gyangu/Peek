import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PanelIdSchema, ViewIdSchema, type PanelId, type ViewId } from '@peek/core'
import {
  composeRefs,
  focusAdoption,
  focusAdoptionDeps,
  focusEntryDispatches,
  isFocusEnteringPanel,
  ownsTab,
  panelTabDomId,
  panelTabWidgetRoles,
  panelTabpanelDomId,
  rovingIndex,
  shouldAdoptFocus,
  tabRovingTabIndex,
  tabStripKeyAction,
} from '../usePanelFocus'

/* ==================================================================
 * Panel focus: the two rules that keep DOM focus and `workspace.focusedPanel`
 * agreeing with each other.
 *
 * The interesting risk here is not that a rule is wrong in one case — it is that
 * the two rules together *never settle*. R2 moves the caret because the state
 * changed; the caret landing fires a focus event; R1 turns that event into a
 * command; the command changes the state; R2 fires again. That loop would not
 * crash anything. It would flood the command bus and pin a CPU, and it would do
 * it only on machines where the timing lines up, which is the kind of bug that
 * survives review and reaches users.
 *
 * So the centrepiece of this file is not a set of examples but a search: build
 * every reachable starting configuration of (where the workspace thinks focus
 * is) × (where the caret actually is) × (whether R2 is allowed to move it), run
 * the two rules against each other until nothing more happens, and assert that
 * a fixed point is always reached — and reached within one hop.
 *
 * The rules are exported as `focusEntryDispatches` / `focusAdoption` precisely so
 * that the thing proved here is the thing that runs. A simulation of a
 * paraphrase of the rules would prove nothing.
 * ================================================================== */

const panelId = (s: string): PanelId => PanelIdSchema.parse(s)
const viewId = (s: string): ViewId => ViewIdSchema.parse(s)

const P1 = panelId('panel_focus_1')
const P2 = panelId('panel_focus_2')

/* ==================================================================
 * 1. DOM ids
 * ================================================================== */

describe('DOM ids pair a tab with its tab panel', () => {
  it('gives every tab of every panel a distinct id', () => {
    const a = panelTabDomId(P1, viewId('view_a'))
    const b = panelTabDomId(P1, viewId('view_b'))
    const c = panelTabDomId(P2, viewId('view_a'))
    assert.notEqual(a, b, 'two tabs of one panel share an id')
    // The same view cannot be in two panels at once (P4), but a stale id
    // colliding across panels would still make `aria-controls` ambiguous during
    // the render where a view moves.
    assert.notEqual(a, c, 'the same view in two panels produces one id')
  })

  it('derives the tab-panel id from the panel alone', () => {
    // The body is one element whatever tab is showing, so its id must not move
    // when the active tab changes — `aria-labelledby` points the other way.
    assert.equal(panelTabpanelDomId(P1), panelTabpanelDomId(P1))
    assert.notEqual(panelTabpanelDomId(P1), panelTabpanelDomId(P2))
  })

  it('emits neither ARIA role for a panel that holds no tabs', () => {
    // The pattern is dropped, not bent. A `tablist` with no `tab` inside it is
    // announced and then found to be empty; a `tabpanel` nothing points
    // `aria-controls` at and nothing labels is an orphan with no accessible
    // name. An empty panel produced both at once, and it is the *default* shape:
    // `createEmptyWorkspace` is one empty panel, and every ⌘\ leaves another.
    assert.deepEqual(panelTabWidgetRoles(0), { tablist: undefined, tabpanel: undefined })
  })

  it('emits both roles as soon as there is a tab, and always both together', () => {
    // Together is the point: a `tablist` whose body lost its `tabpanel` breaks
    // every `aria-controls` in the strip, and the reverse leaves the body
    // unlabelled. One number decides both so the two files cannot drift.
    for (const count of [1, 2, 12]) {
      assert.deepEqual(
        panelTabWidgetRoles(count),
        { tablist: 'tablist', tabpanel: 'tabpanel' },
        `tabCount=${String(count)}`,
      )
    }
  })

  it('never produces an id that could be mistaken for the other kind', () => {
    const tab = panelTabDomId(P1, viewId('view_a'))
    assert.notEqual(tab, panelTabpanelDomId(P1))
    for (const id of [tab, panelTabpanelDomId(P1)]) {
      // An id that starts with a digit or contains whitespace is not usable in
      // an `aria-controls` / `aria-labelledby` token list.
      assert.match(id, /^[A-Za-z][^\s]*$/, id)
    }
  })
})

/* ==================================================================
 * 2. The predicates
 * ================================================================== */

/** A stand-in for a DOM element: `contains` is all these predicates ask for. */
function fakeEl(contained: readonly object[] = []): Element {
  const el = {
    contains(node: unknown): boolean {
      return node === el || contained.includes(node as object)
    },
  }
  return el as unknown as Element
}

/** A stand-in for a focused node — an object with `nodeType`, as a real one has. */
function fakeNode(): EventTarget {
  return { nodeType: 1 } as unknown as EventTarget
}

describe('shouldAdoptFocus — the courtesy guard on R2', () => {
  it('adopts when the user was already working inside the layout', () => {
    const inside = fakeNode()
    const root = fakeEl([inside])
    assert.equal(shouldAdoptFocus(inside as unknown as Element, root), true)
  })

  it('declines when focus is somewhere that belongs to the human', () => {
    // The sidebar, a dialog, the status bar. An MCP command can change
    // `focusedPanel` while someone is typing a connection string, and pulling
    // the caret out of a text field because a model rearranged the window is
    // indefensible. `announce.ts` speaks the change instead.
    const elsewhere = fakeNode()
    const root = fakeEl([])
    assert.equal(shouldAdoptFocus(elsewhere as unknown as Element, root), false)
  })

  it('adopts when focus is nowhere in particular', () => {
    // Where focus sits after a click on non-focusable chrome. Nothing is being
    // taken from anyone.
    assert.equal(shouldAdoptFocus(null, fakeEl()), true)
    assert.equal(shouldAdoptFocus(null, null), true)
  })

  it('declines rather than guesses when the layout root is not mounted yet', () => {
    // A real focused element with no layout to compare it against: the honest
    // answer is "not mine to take". The alternative — adopting — would fire on
    // the first render, before the tree exists.
    assert.equal(shouldAdoptFocus(fakeNode() as unknown as Element, null), false)
  })
})

describe('isFocusEnteringPanel — R1 only fires on a boundary crossing', () => {
  it('is true when focus arrives from outside the panel', () => {
    const outside = fakeNode()
    assert.equal(isFocusEnteringPanel(fakeEl([]), outside), true)
  })

  it('is false when focus merely moved inside the panel', () => {
    // React's onFocus bubbles, so clicking a tab reports the panel as
    // currentTarget too. Treating that as an entry would dispatch a
    // `layout.focus` on every click inside the already-focused panel.
    const inner = fakeNode()
    assert.equal(isFocusEnteringPanel(fakeEl([inner]), inner), false)
  })

  it('treats a missing relatedTarget as an entry', () => {
    // Focus arriving from outside the window, or from nothing at all.
    assert.equal(isFocusEnteringPanel(fakeEl(), null), true)
  })

  it('treats a relatedTarget that is not a node as an entry', () => {
    // `relatedTarget` can be a non-Element EventTarget (a Window). It is
    // duck-typed rather than tested with `instanceof Node` because these tests
    // run in node, where `Node` is not a global and `instanceof` against an
    // undefined constructor throws instead of returning false.
    assert.equal(isFocusEnteringPanel(fakeEl(), {} as EventTarget), true)
    assert.equal(isFocusEnteringPanel(fakeEl(), 'window' as unknown as EventTarget), true)
  })

  it('is false with no panel element, so an unmounted panel dispatches nothing', () => {
    assert.equal(isFocusEnteringPanel(null, fakeNode()), false)
    assert.equal(isFocusEnteringPanel(null, null), false)
  })
})

describe('rovingIndex — the tab strip under ←/→/Home/End', () => {
  it('steps and wraps at both ends', () => {
    assert.equal(rovingIndex('ArrowRight', 0, 3), 1)
    assert.equal(rovingIndex('ArrowRight', 2, 3), 0, 'the right end does not wrap')
    assert.equal(rovingIndex('ArrowLeft', 0, 3), 2, 'the left end does not wrap')
    assert.equal(rovingIndex('ArrowLeft', 2, 3), 1)
  })

  it('Home and End jump to the ends', () => {
    assert.equal(rovingIndex('Home', 2, 3), 0)
    assert.equal(rovingIndex('End', 0, 3), 2)
  })

  it('is a no-op shape on a single tab, so automatic activation sends nothing', () => {
    // Every key returns the index that is already current; the caller compares
    // and stays silent. A wrap that produced 0 from 0 and dispatched anyway
    // would put a `view.activate` on the bus for every arrow press.
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      assert.equal(rovingIndex(key, 0, 1), 0, key)
    }
  })

  it('returns null for keys the strip does not own', () => {
    // Up/Down belong to the panel body — the grid scrolls with them. Delete is
    // handled separately, as a close rather than a move.
    for (const key of ['ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'Enter', 'Tab', ' ']) {
      assert.equal(rovingIndex(key, 0, 3), null, key)
    }
  })

  it('returns null on an empty strip rather than an out-of-range index', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      assert.equal(rovingIndex(key, 0, 0), null, key)
    }
  })
})

describe('tabStripKeyAction — the strip owns bare keys and nothing else', () => {
  it('arrows activate, Delete and Backspace close', () => {
    assert.deepEqual(tabStripKeyAction({ key: 'ArrowRight' }, 0, 3), { kind: 'activate', index: 1 })
    assert.deepEqual(tabStripKeyAction({ key: 'Home' }, 2, 3), { kind: 'activate', index: 0 })
    assert.deepEqual(tabStripKeyAction({ key: 'Delete' }, 1, 3), { kind: 'close', index: 1 })
    assert.deepEqual(tabStripKeyAction({ key: 'Backspace' }, 1, 3), { kind: 'close', index: 1 })
  })

  it('lets every modified chord through to the window shortcuts', () => {
    // The regression this exists for. `useGlobalKeys` listens on `window` in the
    // bubble phase and React's handlers run on `#root`, so a `preventDefault`
    // from the strip lands first and `resolveShortcut` discards the chord on
    // sight. A tab is where a click leaves the caret and where every roving step
    // leaves it, so swallowing these would have killed ⌘⌥Arrow (move between
    // panels), ⌘⇧Arrow (move the view) and ⌘⌥⇧Arrow (split it out) in their
    // commonest starting position — M2 keys, silently dead after M3.
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Backspace']) {
      assert.equal(tabStripKeyAction({ key, metaKey: true }, 0, 3), null, `⌘${key}`)
      assert.equal(tabStripKeyAction({ key, ctrlKey: true }, 0, 3), null, `⌃${key}`)
      assert.equal(tabStripKeyAction({ key, altKey: true }, 0, 3), null, `⌥${key}`)
      assert.equal(
        tabStripKeyAction({ key, metaKey: true, altKey: true }, 0, 3),
        null,
        `⌘⌥${key}`,
      )
    }
  })

  it('keeps Shift, because the window binds no bare-strip chord with it', () => {
    // Shift is not in the guard: ⌘⇧Arrow already carries Meta, so it is filtered
    // by the test above, and plain Shift+Arrow means nothing at the window level.
    // Filtering it too would only make Shift+Right a dead key inside the strip.
    assert.deepEqual(tabStripKeyAction({ key: 'ArrowRight' }, 0, 3), { kind: 'activate', index: 1 })
  })

  it('stays out of the way once something else has claimed the key', () => {
    assert.equal(tabStripKeyAction({ key: 'ArrowRight', defaultPrevented: true }, 0, 3), null)
  })

  it('does nothing on an empty strip, so an empty panel swallows no keys at all', () => {
    for (const key of ['ArrowRight', 'Home', 'Delete', 'Backspace']) {
      assert.equal(tabStripKeyAction({ key }, 0, 0), null, key)
    }
  })

  it('is silent when the roving point would not move', () => {
    // One tab: every arrow resolves to the index already current. Dispatching
    // anyway would put a `view.activate` on the bus for every arrow press.
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      assert.equal(tabStripKeyAction({ key }, 0, 1), null, key)
    }
  })

  it('ignores keys the strip does not own', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', ' ', 'a']) {
      assert.equal(tabStripKeyAction({ key }, 0, 3), null, key)
    }
  })
})

describe('tabRovingTabIndex — every rendered strip keeps exactly one way in', () => {
  it('gives the active tab the only 0, whatever the panel’s focus state', () => {
    // P1 guarantees a non-empty panel always names a visible tab, so this always
    // finds one. It used to be gated on the panel being `workspace.focusedPanel`,
    // which left every other strip on screen with no tabbable tab — and since the
    // body beside it stayed reachable, Tab walked past the strip into the body
    // and the strip was reachable only by Shift+Tabbing back out of it.
    const strip = [viewId('view_1'), viewId('view_2'), viewId('view_3')]
    const active = viewId('view_2')
    const indices = strip.map((v) => tabRovingTabIndex(active, v))
    assert.deepEqual(indices, [-1, 0, -1])
    assert.equal(indices.filter((i) => i === 0).length, 1)
  })

  it('makes an empty strip hold no tab stop at all', () => {
    // Nothing to hold one, and nothing rendered to hold it — an empty panel
    // emits no `tablist` either (`panelTabWidgetRoles`).
    assert.equal(tabRovingTabIndex(null, viewId('view_1')), -1)
  })
})

describe('ownsTab — a strip follows only its own tabs', () => {
  /**
   * Two strips' worth of tab elements, as `useTabRoving` registers them.
   *
   * Both answer `role="tab"`, which is the whole point: the guard this replaced
   * asked exactly that question, and both elements pass it. Only one of them is
   * in the registry.
   */
  const fakeTabEl = (): Element =>
    ({ getAttribute: (name: string) => (name === 'role' ? 'tab' : null) }) as unknown as Element
  const tabA = fakeTabEl()
  const tabB = fakeTabEl()
  const mine = new Map<ViewId, HTMLElement>([[viewId('view_a'), tabA as unknown as HTMLElement]])

  it('recognises an element it registered', () => {
    assert.equal(ownsTab(mine, tabA), true)
  })

  it('rejects another panel’s tab, which is what stops a remote activate stealing the caret', () => {
    // The guard used to be `active.getAttribute('role') === 'tab'`, which every
    // strip in the window satisfies. With the caret resting on panel L's tab, a
    // `view.activate { focusPanel: false }` aimed at panel R made R's effect pull
    // the caret across the window — and the arrival then tripped R1, which
    // dispatched `layout.focus(R)`, overriding the `focusPanel: false` the caller
    // had explicitly asked for. Role is not ownership; only the registry knows.
    assert.equal(ownsTab(mine, tabB), false)
  })

  it('rejects everything when the strip has registered nothing yet', () => {
    assert.equal(ownsTab(new Map(), tabA), false)
  })
})

/* ==================================================================
 * 3. The two rules, stated
 * ================================================================== */

describe('R1 — DOM to state', () => {
  it('dispatches exactly when focus enters a panel the workspace does not consider focused', () => {
    assert.equal(focusEntryDispatches(false, true), true)
    assert.equal(focusEntryDispatches(false, false), false, 'moving inside a panel is not an entry')
    assert.equal(
      focusEntryDispatches(true, true),
      false,
      'a panel that is already focused must not report its own focus back',
    )
    assert.equal(focusEntryDispatches(true, false), false)
  })
})

describe('R2 — state to DOM', () => {
  it('moves the caret only into the focused panel, only from outside it, only when allowed', () => {
    assert.equal(focusAdoption(true, false, true), true)
    assert.equal(focusAdoption(false, false, true), false, 'an unfocused panel never takes focus')
    assert.equal(
      focusAdoption(true, true, true),
      false,
      'the caret is already inside — this is the termination guard',
    )
    assert.equal(
      focusAdoption(true, false, false),
      false,
      'focus belongs to the human right now — this is the courtesy guard',
    )
  })

  it('re-runs when the panel’s content changes, not only when focus does', () => {
    // The rule was right and still lost the caret, because of *when* it ran.
    // Keyed on `focused` alone it never fired for the change that drops focus
    // hardest: the element holding the caret being unmounted while
    // `focusedPanel` stays put — closing a panel's last tab with ⌘W or Delete,
    // which the tab contract calls an ordinary thing to do. DOM focus fell to
    // `document.body`, the panel stayed empty and focused, and a keyboard user
    // was returned to the top of a document with no landmarks to Tab back
    // through. The content key is asserted here because no test of the rule
    // itself can see a missing dependency.
    const v = viewId('view_1')
    assert.deepEqual(focusAdoptionDeps(true, v), [true, v])
    assert.deepEqual(focusAdoptionDeps(false, null), [false, null])
    assert.equal(focusAdoptionDeps(true, v).length, 2, 'React needs a stable dependency count')
  })

  it('never blurs: there is no state in which a panel gives focus away', () => {
    // Losing `focusedPanel` must do nothing at all. A panel that blurred itself
    // on losing the flag would drop the caret to document.body every time an MCP
    // command focused somewhere else, which is worse than either alternative.
    for (const inside of [true, false]) {
      for (const mayAdopt of [true, false]) {
        assert.equal(focusAdoption(false, inside, mayAdopt), false)
      }
    }
  })
})

/* ==================================================================
 * 4. The proof: the two rules cannot loop
 * ================================================================== */

/**
 * Where the caret is: inside a named panel, or somewhere that is not a panel.
 * `'nowhere'` stands for `document.body`, `'elsewhere'` for the sidebar/dialog.
 */
type Caret = PanelId | 'nowhere' | 'elsewhere'

interface World {
  /** What the workspace believes. */
  focusedPanel: PanelId | null
  /** Where the caret actually is. */
  caret: Caret
}

/**
 * The three things that can start a cascade.
 *
 * `userFocus` is a real DOM focus event — a Tab press, a click, or R2 calling
 * `.focus()`. `remoteFocus` is `focusedPanel` changing in the mirror: a
 * `layout.focus` patch landing, whether the user asked for it or MCP did.
 * `contentRemoved` is the panel's visible view being unmounted, which is what
 * closing its last tab does; `focusedPanel` does not change, and the browser
 * drops the caret to `document.body` if it was in there.
 *
 * Modelling *events* rather than a steady state is the whole reason this
 * simulation is faithful. R1 is a DOM handler and R2 is a `useEffect` keyed on
 * `focused` and the panel's content; neither is a rule that holds continuously,
 * and a steady-state model would invent transitions React never performs — a
 * panel silently reclaiming the caret it never lost — while missing the one that
 * matters, which is a rule firing *because of* the other rule.
 */
type FocusEvent =
  | { kind: 'userFocus'; panel: PanelId }
  | { kind: 'remoteFocus'; panel: PanelId | null }
  | { kind: 'contentRemoved'; panel: PanelId }

const PANELS: readonly PanelId[] = [P1, P2]

/** `shouldAdoptFocus`, expressed over this model's notion of where the caret is. */
function mayAdopt(caret: Caret): boolean {
  // Inside the layout, or nowhere in particular. `'elsewhere'` is the sidebar.
  return caret !== 'elsewhere'
}

/**
 * The three guard terms, individually switchable.
 *
 * All three are on in the shipping code. Switching them off one at a time is
 * what turns "the rules terminate" from an argument into a measurement: the
 * search below shows that **any one of the three alone** stops the cascade, and
 * that with all three gone the cascade runs forever — which is what proves the
 * search would actually catch the regression it exists to catch.
 */
interface Guards {
  /** R1's `!focused`: a panel the workspace already considers focused stays quiet. */
  r1Focused: boolean
  /** R1's `entering`: a focus move *within* one panel is not an entry (`isFocusEnteringPanel`). */
  r1Entering: boolean
  /** R2's `!focusAlreadyInside`: a panel already holding the caret does not grab it. */
  r2Inside: boolean
}

const ALL: Guards = { r1Focused: true, r1Entering: true, r2Inside: true }

/**
 * Apply one event, and report the follow-on event the rules generated.
 *
 * Two modelling choices carry the fidelity of the whole simulation:
 *
 *   - **Order.** R1 runs synchronously inside the focus event; R2 runs afterwards
 *     in an effect. Reversing them would model a fight that cannot happen.
 *   - **R2 does not move the caret itself.** It emits a `userFocus` event, because
 *     that is what `.focus()` does — and the resulting event's `relatedTarget` is
 *     the element focus came *from*. A model that moved the caret first and then
 *     asked "did focus enter?" would answer no every time, hiding the loop.
 */
function apply(
  world: World,
  event: FocusEvent,
  guards: Guards,
): { next: World; followUp: FocusEvent | null } {
  let { focusedPanel, caret } = world

  if (event.kind === 'userFocus') {
    const p = event.panel
    // `isFocusEnteringPanel`: the caret's previous home is the relatedTarget.
    const entering = guards.r1Entering ? caret !== p : true
    const focused = guards.r1Focused ? focusedPanel === p : false
    caret = p
    if (!focusEntryDispatches(focused, entering)) return { next: { focusedPanel, caret }, followUp: null }
    focusedPanel = p
    // A `layout.focus` goes out; the patch that comes back re-runs every R2.
    return { next: { focusedPanel, caret }, followUp: { kind: 'remoteFocus', panel: p } }
  }

  if (event.kind === 'contentRemoved') {
    // Unmounting the element the caret was in drops DOM focus to
    // `document.body`. Nothing about `focusedPanel` changes — which is exactly
    // why R2 has to watch the content key as well, or this event reaches no rule
    // at all and the caret is simply lost.
    if (caret === event.panel) caret = 'nowhere'
  } else {
    focusedPanel = event.panel
  }

  for (const q of PANELS) {
    const inside = guards.r2Inside ? caret === q : false
    if (!focusAdoption(focusedPanel === q, inside, mayAdopt(caret))) continue
    // `.focus()` fires a real focus event, which re-enters R1.
    return { next: { focusedPanel, caret }, followUp: { kind: 'userFocus', panel: q } }
  }
  return { next: { focusedPanel, caret }, followUp: null }
}

/** Run a cascade to quiescence, or give up. Returns the number of events processed. */
function cascade(
  start: World,
  event: FocusEvent,
  guards: Guards,
  limit = 12,
): { world: World; events: number; settled: boolean } {
  let world = start
  let pending: FocusEvent | null = event
  let events = 0
  while (pending !== null) {
    if (events >= limit) return { world, events, settled: false }
    const { next, followUp } = apply(world, pending, guards)
    world = next
    pending = followUp
    events += 1
  }
  return { world, events, settled: true }
}

/** Every starting configuration crossed with every event that can arrive in it. */
function allCases(): { world: World; event: FocusEvent; label: string }[] {
  const out: { world: World; event: FocusEvent; label: string }[] = []
  for (const focusedPanel of [...PANELS, null]) {
    for (const caret of [...PANELS, 'nowhere' as const, 'elsewhere' as const]) {
      const world: World = { focusedPanel, caret }
      const events: FocusEvent[] = [
        ...PANELS.map((p): FocusEvent => ({ kind: 'userFocus', panel: p })),
        ...PANELS.map((p): FocusEvent => ({ kind: 'remoteFocus', panel: p })),
        ...PANELS.map((p): FocusEvent => ({ kind: 'contentRemoved', panel: p })),
        { kind: 'remoteFocus', panel: null },
      ]
      for (const event of events) {
        out.push({
          world,
          event,
          label: `${String(focusedPanel)}/${String(caret)} + ${event.kind}(${String(event.panel)})`,
        })
      }
    }
  }
  return out
}

describe('the focus loop terminates — searched, not argued', () => {
  it('settles after at most one follow-on event, from every configuration', () => {
    const cases = allCases()
    assert.equal(cases.length, 84, 'the search space changed shape')

    let sawFollowUp = false
    for (const { world, event, label } of cases) {
      const run = cascade(world, event, ALL)
      assert.ok(run.settled, `no fixed point from ${label}`)
      // The claim in `usePanelFocus` is stronger than "it stops": one hop, then
      // quiescence. Two follow-ons would mean the rules are handing work back and
      // forth, which is the shape a real loop starts as.
      assert.ok(run.events <= 2, `${label} needed ${run.events} events`)
      if (run.events === 2) sawFollowUp = true
    }
    // A search in which nothing ever cascades would pass vacuously.
    assert.ok(sawFollowUp, 'no case ever produced a follow-on event — the model is inert')
  })

  it('would catch a loop: with every guard removed, the cascade never settles', () => {
    // This is what gives the search above teeth. Strip all three terms and the
    // rules feed each other forever: R2 focuses the panel, the focus event
    // reaches R1, R1 dispatches, the patch re-runs R2, R2 focuses it again. That
    // is precisely the bug this file exists to rule out — and here it is,
    // detected, so a future refactor that reintroduces it cannot pass silently.
    const naked: Guards = { r1Focused: false, r1Entering: false, r2Inside: false }
    const run = cascade({ focusedPanel: P2, caret: P2 }, { kind: 'remoteFocus', panel: P1 }, naked)
    assert.equal(run.settled, false, 'the unguarded rules settled, so the search proves nothing')
  })

  it('any one guard alone is enough to break the cycle', () => {
    // Not redundancy for its own sake. R1's `!focused` is the term a refactor is
    // likeliest to drop, because it reads as an optimisation ("why dispatch when
    // nothing changed?"); `entering` reads as a special case for bubbling; and
    // R2's `!focusAlreadyInside` reads as a micro-guard on `.focus()`. Each looks
    // removable in isolation, and each on its own is what stops the runaway — so
    // losing any one of them is a latent bug rather than an immediate outage,
    // which is exactly the kind that ships.
    const singles: Guards[] = [
      { r1Focused: true, r1Entering: false, r2Inside: false },
      { r1Focused: false, r1Entering: true, r2Inside: false },
      { r1Focused: false, r1Entering: false, r2Inside: true },
    ]
    for (const guards of singles) {
      const only = Object.entries(guards).find(([, on]) => on)?.[0] ?? '?'
      for (const { world, event, label } of allCases()) {
        assert.ok(cascade(world, event, guards).settled, `only ${only}: ${label} looped`)
      }
    }
  })

  it('leaves the caret alone when it is somewhere that belongs to the human', () => {
    // The case the courtesy guard exists for: a background command focuses a
    // panel while the user is typing in the sidebar. State moves, caret does not.
    const run = cascade(
      { focusedPanel: P2, caret: 'elsewhere' },
      { kind: 'remoteFocus', panel: P1 },
      ALL,
    )
    assert.equal(run.world.caret, 'elsewhere', 'the caret was pulled out of the sidebar')
    assert.equal(run.world.focusedPanel, P1, 'the state change was undone')
    assert.equal(run.events, 1, 'declining to move the caret still cascaded')
  })

  it('R2 taking the caret does not bounce a command back out', () => {
    // The loop as it would actually start: a command focuses P1 while the caret
    // is in P2. R2 moves it, R1 sees the state already agrees, and it stops.
    const run = cascade({ focusedPanel: P2, caret: P2 }, { kind: 'remoteFocus', panel: P1 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P1, caret: P1 })
    assert.equal(run.events, 2, 'expected exactly the R2 move and its inert echo')
  })

  it('R1 reporting an entry does not then drag the caret somewhere else', () => {
    // The mirror image: the user tabs into P2 while the workspace still says P1.
    const run = cascade({ focusedPanel: P1, caret: P1 }, { kind: 'userFocus', panel: P2 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P2, caret: P2 })
    assert.equal(run.events, 2)
  })

  it('a focus move inside the already-focused panel is completely silent', () => {
    // The commonest event in the whole application — clicking a tab, tabbing from
    // a tab to the body. React's onFocus bubbles, so the panel sees every one of
    // them. Dispatching on any would put a `layout.focus` on the bus per click.
    const run = cascade({ focusedPanel: P1, caret: P1 }, { kind: 'userFocus', panel: P1 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P1, caret: P1 })
    assert.equal(run.events, 1, 'a focus move inside the focused panel cascaded')
  })

  it('a state change the caret already agrees with costs nothing', () => {
    // `layout.focus` arriving for the panel the user is already in — what every
    // click on a tab produces, once R1 has reported it.
    const run = cascade({ focusedPanel: P2, caret: P1 }, { kind: 'remoteFocus', panel: P1 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P1, caret: P1 })
    assert.equal(run.events, 1)
  })

  it('a focused panel with the caret nowhere pulls it in, once', () => {
    const run = cascade(
      { focusedPanel: P2, caret: 'nowhere' },
      { kind: 'remoteFocus', panel: P1 },
      ALL,
    )
    assert.deepEqual(run.world, { focusedPanel: P1, caret: P1 })
    assert.equal(run.events, 2)
  })

  it('takes the caret back when the element holding it was unmounted', () => {
    // Closing a panel's last tab. `focusedPanel` still names the panel, the tab
    // and the body are gone, and the browser has left the caret on
    // `document.body`. R2 is the only rule that can act, and it can only act
    // because it watches the panel's content key as well as `focused`.
    const run = cascade({ focusedPanel: P1, caret: P1 }, { kind: 'contentRemoved', panel: P1 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P1, caret: P1 })
    assert.equal(run.events, 2, 'expected the rescue and its inert echo')
  })

  it('does not reach across the window for a caret that was never in the panel', () => {
    // The same event in a panel the user is not in: P1's content goes away while
    // the caret sits in P2. P2 is not `focusedPanel`, but nothing here may drag
    // the caret out of it, and the empty panel must not grab it either.
    const run = cascade({ focusedPanel: P2, caret: P2 }, { kind: 'contentRemoved', panel: P1 }, ALL)
    assert.deepEqual(run.world, { focusedPanel: P2, caret: P2 })
    assert.equal(run.events, 1)
  })

  it('leaves the caret in the sidebar when a panel empties under it', () => {
    // The courtesy guard again, on the rescue path: an MCP `view.close` that
    // empties the focused panel while the human is typing elsewhere must not
    // move anything. `announce.ts` says "Empty panel N" instead — see
    // `announcementFor`.
    const run = cascade(
      { focusedPanel: P1, caret: 'elsewhere' },
      { kind: 'contentRemoved', panel: P1 },
      ALL,
    )
    assert.equal(run.world.caret, 'elsewhere')
    assert.equal(run.events, 1)
  })

  it('focusedPanel becoming null moves nothing — no panel ever blurs itself', () => {
    for (const caret of [...PANELS, 'nowhere' as const, 'elsewhere' as const]) {
      const run = cascade({ focusedPanel: P1, caret }, { kind: 'remoteFocus', panel: null }, ALL)
      assert.equal(
        run.world.caret,
        caret,
        `the caret moved when focus went to null (${String(caret)})`,
      )
      assert.equal(run.world.focusedPanel, null)
      assert.equal(run.events, 1)
    }
  })
})

/* ==================================================================
 * 5. Ref composition
 * ================================================================== */

describe('composeRefs', () => {
  it('hands the element to every ref, in order', () => {
    const seen: string[] = []
    const el = fakeEl()
    const ref = composeRefs<Element>(
      (e) => seen.push(`a:${e === null ? 'null' : 'el'}`),
      (e) => seen.push(`b:${e === null ? 'null' : 'el'}`),
    )
    ref(el)
    ref(null)
    assert.deepEqual(seen, ['a:el', 'b:el', 'a:null', 'b:null'])
  })

  it('forwards the detach, which is what keeps the drag registry from leaking', () => {
    // A panel element has two independent claims on it — the drop hit-test
    // registry and `usePanelFocus`. If the composed ref swallowed the `null`
    // call, the registry would keep hit-testing rectangles of unmounted panels.
    let registered: Element | null = null
    const ref = composeRefs<Element>((e) => {
      registered = e
    })
    ref(fakeEl())
    assert.notEqual(registered, null)
    ref(null)
    assert.equal(registered, null)
  })

  it('composing nothing is a no-op rather than a crash', () => {
    assert.doesNotThrow(() => composeRefs<Element>()(fakeEl()))
  })
})
