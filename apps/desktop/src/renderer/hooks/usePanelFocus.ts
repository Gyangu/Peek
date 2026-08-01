/**
 * Panel focus and tab roving — the contract between the accessibility path and
 * the tab-bar path.
 *
 * Two hooks, one file, because they are one problem: a panel is a roving stop in
 * the window, and its tab strip is a roving group inside that stop. Splitting
 * them across files would let the two halves disagree about who owns DOM focus
 * at any instant, which is precisely the bug this file exists to prevent.
 *
 * ## The model
 *
 * Level 1 — the panel element itself. Exactly one panel in the whole layout is a
 * tab stop *as a panel*: the one `workspace.focusedPanel` names, at `tabIndex 0`;
 * every other panel element is `-1`. That stop is the "you are here" landing
 * point R2 uses, and keeping it to one avoids sixteen `role="group"` stops in a
 * row. Movement *between* panels stays on Cmd+Alt+Arrow — arrow keys are not
 * rebound at the panel level, because the panel body owns them (the grid
 * scrolls, the editor moves a caret).
 *
 * **What level 1 deliberately does not claim.** An earlier version of this file
 * promised that every interactive descendant of an unfocused panel was also
 * `-1`, so that one Tab reached the layout and a second left it. That promise
 * was never kept and cannot be: a panel body is a CodeMirror editor or a
 * `DataGrid`, and neither takes a `tabIndex` from us. The result was an
 * asymmetry — Tab walked into an unfocused panel's *body* while its tab strip
 * and its ⊞⊟✕ buttons were skipped, so the strip could only be reached by
 * Shift+Tabbing backwards out of the body. Panel chrome is therefore
 * unconditionally in the tab order (`childTabIndex` is always 0), which makes
 * the sequence within every panel the same one: [group, when focused] → active
 * tab → buttons → body. Consistent and predictable beats a saving we cannot
 * actually deliver.
 *
 * Level 2 — across tabs, inside a strip. Each strip is an ordinary ARIA tablist,
 * and the roving rule is the standard one, per strip: the active tab is
 * `tabIndex 0`, the rest `-1`, Left/Right move, Home/End jump, Delete closes.
 * Activation is **automatic** (arrowing to a tab shows it) because switching a
 * tab in peek is cheap — the view is already open and holds its own `resultId`,
 * so nothing re-runs and nothing re-fetches. The strip owns *bare* arrows only:
 * anything with Cmd/Ctrl/Alt belongs to `useGlobalKeys` (⌘⌥Arrow moves between
 * panels, ⌘⇧Arrow moves a view), and since a tab is the commonest resting place
 * for the caret, swallowing those would disable window navigation exactly where
 * it is most used.
 *
 * ## Why this cannot be local state
 *
 * `focusedPanel` and `activeViewId` both live in main's Workspace. The renderer
 * is a read-only mirror, so this hook never writes them: it dispatches
 * `layout.focus` / `view.activate` and waits for the patch, exactly like a drag
 * does. What the hook *does* own is the DOM side of the relationship, which main
 * knows nothing about.
 *
 * ## The focus loop, and why it terminates
 *
 * There are two directions and each has a guard:
 *
 *   R1  DOM -> state. Focus entering the panel from outside dispatches
 *       `layout.focus`, but **only when `panelId !== focusedPanel`**.
 *   R2  state -> DOM. `focusedPanel` becoming this panel calls `.focus()`, but
 *       **only when DOM focus is not already inside this panel**.
 *
 * Either guard alone breaks the cycle; together they make it unreachable. R2
 * fires, focus lands inside the panel, R1 sees state already agrees and stays
 * silent. R1 fires, state changes, R2 sees focus is already inside and stays
 * silent. One hop, then quiescence.
 *
 * R2 carries a second guard that is about courtesy rather than termination:
 * `shouldAdoptFocus`. An MCP call can move `focusedPanel` while the human is
 * typing a password into the connection dialog, and yanking the caret out of a
 * text field because a model rearranged the window is indefensible. So R2 only
 * takes focus when focus is already inside the layout (or nowhere in
 * particular). When it declines, the change is announced through the live region
 * instead — see `announce` below.
 *
 * ## R2 is also the rescue when the caret's element is deleted
 *
 * R2 re-runs on the panel's `contentKey` (its `activeViewId`), not only on
 * `focused`, and that is what makes closing the last tab survivable. Removing
 * the element the caret sits in drops DOM focus to `document.body`: pressing ⌘W
 * on the last tab takes the tab *and* the body with it, and the same happens
 * with the caret inside the editor. With `focusedPanel` still naming this
 * now-empty panel, R2 sees `focused && !contains(body) && mayAdopt(body)` and
 * puts the caret on the panel's own `role="group"` element, whose label now
 * reads "Empty panel N". Without the `contentKey` dependency the rule never
 * re-ran, and a keyboard user was silently returned to the top of a document
 * with no landmarks to Tab back through.
 *
 * This costs nothing in the ordinary case: on a tab switch the caret is already
 * inside the panel, so the termination guard stops R2 before it moves anything.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PanelId, ViewId } from '@peek/core'
import { dispatch } from '../state/dispatch'
import { useFocusedPanel } from '../state/workspaceStore'

/* ================================================================== */
/* 1. DOM ids                                                          */
/* ================================================================== */

/**
 * `aria-controls` on a tab and `aria-labelledby` on the tab panel have to name
 * each other exactly. Deriving both from these two functions is what stops the
 * two components from spelling the relationship differently — a broken pairing
 * is invisible on screen and silently drops the panel out of the accessibility
 * tree.
 */
export function panelTabDomId(panelId: PanelId, viewId: ViewId): string {
  return `tab-${String(panelId)}-${String(viewId)}`
}

export function panelTabpanelDomId(panelId: PanelId): string {
  return `tabpanel-${String(panelId)}`
}

/**
 * The two ARIA roles a panel emits — or neither, when it holds no tabs.
 *
 * They are decided together, from one number, because they only make sense
 * together. A `tablist` with no `tab` inside is a widget a screen reader
 * announces and then finds nothing in (`aria-required-children`); a `tabpanel`
 * with no tab pointing `aria-controls` at it and no `aria-labelledby` of its own
 * is an unnamed orphan. An empty panel produced both at once, and it is not an
 * exotic state: `createEmptyWorkspace` is a single empty panel, so it is the
 * first thing on screen at a cold start, and every ⌘\ leaves another behind.
 *
 * Dropping the roles loses nothing, because the panel element itself is a
 * `role="group"` labelled "Empty panel N" — which is the whole truth about it.
 * This is also the one place where forcing the ARIA tabs pattern *would* distort
 * the semantics, so it is the one place the pattern is not used.
 */
export function panelTabWidgetRoles(tabCount: number): {
  tablist: 'tablist' | undefined
  tabpanel: 'tabpanel' | undefined
} {
  return tabCount === 0
    ? { tablist: undefined, tabpanel: undefined }
    : { tablist: 'tablist', tabpanel: 'tabpanel' }
}

/* ================================================================== */
/* 2. Pure predicates (unit-testable without a DOM)                    */
/* ================================================================== */

/**
 * Whether a state-driven focus change may move the caret.
 *
 * `active` is `document.activeElement`, `layoutRoot` the `.layout-root` element.
 * True when the user was already working inside the layout, or when focus is
 * nowhere in particular (`document.body`, which is where it sits after a click
 * on non-focusable chrome). False when focus is in the sidebar, a dialog or the
 * status bar — those belong to the human, and a background command does not get
 * to take them.
 */
export function shouldAdoptFocus(active: Element | null, layoutRoot: Element | null): boolean {
  if (active === null) return true
  if (typeof document !== 'undefined' && active === document.body) return true
  if (layoutRoot === null) return false
  return layoutRoot.contains(active)
}

/**
 * Whether a focus event entered this panel from outside it.
 *
 * React's `onFocus` bubbles, so a click on a tab button reports the panel as
 * `currentTarget` too. Only a crossing of the panel boundary should dispatch;
 * moving from a tab to the body inside one panel is not a focus change as far as
 * the workspace is concerned.
 *
 * `relatedTarget` is duck-typed rather than tested with `instanceof Node`: the
 * unit tests run in node, where `Node` is not a global, and an `instanceof`
 * against an undefined constructor throws rather than returning false. A missing
 * `relatedTarget` (focus arriving from outside the window, or from nothing)
 * counts as entering.
 */
export function isFocusEnteringPanel(
  panelEl: Element | null,
  relatedTarget: EventTarget | null,
): boolean {
  if (panelEl === null) return false
  if (relatedTarget === null || typeof relatedTarget !== 'object') return true
  if (!('nodeType' in relatedTarget)) return true
  return !panelEl.contains(relatedTarget as unknown as Node)
}

/* ---------------------------------------------------------------- */
/* The two rules of the focus loop, isolated so they can be proved.  */
/* ---------------------------------------------------------------- */

/**
 * **R1, DOM → state.** Does this focus event become a `layout.focus` dispatch?
 *
 * The `!focused` half is the guard that matters: a panel that the workspace
 * already considers focused never reports its own focus back, so a caret that
 * R2 just placed cannot bounce a command out again.
 */
export function focusEntryDispatches(focused: boolean, entering: boolean): boolean {
  return !focused && entering
}

/**
 * **R2, state → DOM.** Does this state change move the caret?
 *
 * `focusAlreadyInside` is the termination guard — once focus is in the panel the
 * rule stops firing, so R1 has nothing new to report. `mayAdopt` is
 * `shouldAdoptFocus`, which is about courtesy, not termination: it is what stops
 * a background command from pulling the caret out of a dialog the user is
 * typing in. When it declines, `announce.ts` speaks the change instead.
 *
 * Between them the cycle is not merely broken but unreachable: R2 fires, focus
 * lands inside, R1 sees the state already agrees and stays silent; or R1 fires,
 * the state changes, R2 sees focus already inside and stays silent. One hop,
 * then quiescence — see `panel-focus.test.ts`, which searches every starting
 * configuration for a longer path and asserts there is none.
 */
export function focusAdoption(
  focused: boolean,
  focusAlreadyInside: boolean,
  mayAdopt: boolean,
): boolean {
  return focused && !focusAlreadyInside && mayAdopt
}

/**
 * R2's dependency list, named so it can be asserted.
 *
 * The rule itself is `focusAdoption`, and it is correct; what broke was *when it
 * ran*. Keyed on `focused` alone, R2 never re-ran for the change that drops the
 * caret hardest — a panel's content being unmounted while `focusedPanel` stays
 * put — so closing the last tab left a keyboard user on `document.body`. That
 * kind of regression is invisible to a test of the rule, so the list is built
 * here and checked in `panel-focus.test.ts` rather than being spelled inline.
 */
export function focusAdoptionDeps(
  focused: boolean,
  contentKey: ViewId | null,
): readonly [boolean, ViewId | null] {
  return [focused, contentKey]
}

/**
 * Just enough of a keyboard event for `tabStripKeyAction` to decide.
 *
 * A React `KeyboardEvent` satisfies this structurally, so the handler passes the
 * real event through and the tests pass an object literal — there is no
 * paraphrase of the rule sitting between them.
 */
export interface TabKeyChord {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  defaultPrevented?: boolean
}

/** What a key press on the tab strip means, by index into `viewIds`. */
export type TabStripAction = { kind: 'close' | 'activate'; index: number }

/**
 * The tab strip's keyboard grammar: **bare** Left/Right/Home/End/Delete/Backspace
 * and nothing else.
 *
 * The modifier test is the load-bearing part. `useGlobalKeys` listens on
 * `window` during the bubble phase while React's handlers run on `#root`, so a
 * `preventDefault()` here always lands first and `resolveShortcut` drops the
 * chord on sight. Without the test, ⌘⌥Arrow (move between panels), ⌘⇧Arrow (move
 * the view) and ⌘⌥⇧Arrow (split it out) would all be swallowed whenever the
 * caret sat on a tab — which is exactly where a click leaves it, and where every
 * roving step leaves it, so the window's navigation keys would have died in
 * their commonest starting position. Delete is covered for the same reason: ⌘⌫
 * is not "close this tab".
 */
export function tabStripKeyAction(
  chord: TabKeyChord,
  current: number,
  count: number,
): TabStripAction | null {
  if (chord.defaultPrevented === true) return null
  if (chord.metaKey === true || chord.ctrlKey === true || chord.altKey === true) return null
  if (count <= 0) return null
  if (chord.key === 'Delete' || chord.key === 'Backspace') return { kind: 'close', index: current }
  const next = rovingIndex(chord.key, current, count)
  if (next === null || next === current) return null
  return { kind: 'activate', index: next }
}

/**
 * One tab's `tabIndex`, from the strip's own state and nothing else.
 *
 * Deliberately not a function of whether the panel is focused. Roving tabindex
 * is a rule *within* a widget: every rendered tablist keeps exactly one way in,
 * and several tablists on a page is the ordinary case, not a conflict. Making
 * this depend on the panel put an on-screen tablist on the page with no `0` in
 * it at all, which is a widget with no keyboard entrance — and, since the panel
 * body next to it stayed reachable, Tab walked *past* the strip into the body
 * and the strip could only be reached by Shift+Tabbing back out.
 */
export function tabRovingTabIndex(activeViewId: ViewId | null, viewId: ViewId): 0 | -1 {
  return viewId === activeViewId ? 0 : -1
}

/** Next index for a roving group under Left/Right/Home/End. `null` means "not a roving key". */
export function rovingIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'ArrowRight':
      return (current + 1) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/* ================================================================== */
/* 3. usePanelFocus                                                    */
/* ================================================================== */

export interface PanelFocusApi {
  /** True when this panel is `workspace.focusedPanel`. */
  focused: boolean
  /** For the panel element itself: 0 on the focused panel, -1 on every other. */
  panelTabIndex: 0 | -1
  /**
   * For interactive descendants that are not tabs — the ⊞⊟✕ buttons, and the two
   * buttons an empty panel offers.
   *
   * Always 0. It stays a field rather than becoming a literal because it is the
   * one place the policy is written down: panel chrome is unconditionally
   * reachable, because the bodies beside it (CodeMirror, `DataGrid`) are
   * unconditionally reachable and nothing we can do makes them otherwise. Tabs
   * do not use this — a tablist roves within itself, through `useTabRoving`.
   */
  childTabIndex: 0 | -1
  /** Attach to the panel element. Compose with other refs via `composeRefs`. */
  ref: (el: HTMLElement | null) => void
  /** Attach to the panel element's `onFocus`. Implements R1. */
  onFocus: (e: ReactFocusEvent<HTMLElement>) => void
  /** `id` for the panel body, and the target of every tab's `aria-controls`. */
  tabpanelId: string
  /** `id` for one tab, and the target of the body's `aria-labelledby`. */
  tabId: (viewId: ViewId) => string
}

/**
 * @param contentKey the panel's `activeViewId`. R2 re-runs when it changes, which
 * is what rescues the caret when the element holding it is removed — see the
 * header. Passing anything else (a counter, a constant) would either make R2 fire
 * for changes that cannot have dropped focus, or never fire when one did.
 */
export function usePanelFocus(panelId: PanelId, contentKey: ViewId | null): PanelFocusApi {
  const focusedPanel = useFocusedPanel()
  const focused = focusedPanel === panelId
  const elRef = useRef<HTMLElement | null>(null)

  const ref = useCallback((el: HTMLElement | null) => {
    elRef.current = el
  }, [])

  // R2: state -> DOM. The decision is `focusAdoption` and nothing else, so the
  // rule the tests prove terminating is the rule that actually runs.
  //
  // `contentKey` is in the dependency list for the rescue described in the
  // header, and it cannot reintroduce a loop: `focusAdoption` is the same
  // function with the same guards whatever re-ran it, and its termination guard
  // (`el.contains(active)`) is false only when the caret is genuinely outside
  // this panel.
  useEffect(() => {
    const el = elRef.current
    if (el === null) return
    const active = document.activeElement
    const mayAdopt = shouldAdoptFocus(active, el.closest('.layout-root'))
    if (!focusAdoption(focused, el.contains(active), mayAdopt)) return
    el.focus({ preventScroll: true })
  }, focusAdoptionDeps(focused, contentKey))

  // R1: DOM -> state.
  const onFocus = useCallback(
    (e: ReactFocusEvent<HTMLElement>) => {
      const entering = isFocusEnteringPanel(elRef.current, e.relatedTarget)
      if (!focusEntryDispatches(focused, entering)) return
      void dispatch('layout.focus', { panelId })
    },
    [focused, panelId],
  )

  return {
    focused,
    panelTabIndex: focused ? 0 : -1,
    childTabIndex: 0,
    ref,
    onFocus,
    tabpanelId: panelTabpanelDomId(panelId),
    tabId: (viewId: ViewId) => panelTabDomId(panelId, viewId),
  }
}

/* ================================================================== */
/* 4. useTabRoving                                                     */
/* ================================================================== */

export interface TabRovingOptions {
  panelId: PanelId
  /** Tab-bar order, i.e. `PanelNode.viewIds`. */
  viewIds: readonly ViewId[]
  activeViewId: ViewId | null
}

export interface TabRovingApi {
  /**
   * 0 for this strip's active tab, -1 for the rest.
   *
   * Per strip, not per window: a tablist that is on screen but holds no `0` is
   * a widget with no way in, and the panel's own focus state is not what decides
   * that — see the level-1 note in the header.
   */
  tabIndexOf: (viewId: ViewId) => 0 | -1
  /** Attach to the tablist element. Handles Left/Right/Home/End/Delete. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
  /** Attach to each tab element, so roving can move DOM focus and scroll it into view. */
  registerTab: (viewId: ViewId) => (el: HTMLElement | null) => void
}

export function useTabRoving(opts: TabRovingOptions): TabRovingApi {
  const { panelId, viewIds, activeViewId } = opts
  const tabEls = useRef(new Map<ViewId, HTMLElement>())
  /**
   * Set by this hook's own key handler, cleared by the effect below.
   *
   * It exists for one case: `Delete` closes the tab the caret is sitting on, and
   * when that element unmounts the browser drops focus to `document.body`. The
   * "focus was on a tab" test below is false at that moment, so without this the
   * user would close a tab and find themselves at the top of the document.
   */
  const claimFocus = useRef(false)

  const registerTab = useCallback(
    (viewId: ViewId) => (el: HTMLElement | null) => {
      if (el === null) tabEls.current.delete(viewId)
      else tabEls.current.set(viewId, el)
    },
    [],
  )

  // Roving requires the tabIndex=0 element to be the focused one whenever the
  // group holds focus: keep DOM focus on the active tab after it changes, but
  // only when the user was driving from within **this** strip. A remote
  // `view.activate` must not pull the caret across the window — the live region
  // reports that case instead.
  useEffect(() => {
    const claimed = claimFocus.current
    claimFocus.current = false
    if (activeViewId === null) {
      // The panel just emptied, so this strip has nothing left to hold the
      // caret. The rescue is not here: `usePanelFocus`'s R2 re-runs on the same
      // change and puts focus on the panel's own `role="group"` element, which
      // covers this case *and* the one where the caret was in the body rather
      // than on a tab (⌘W with the cursor in the editor). Doing it in both
      // places would mean two rules racing for one caret.
      return
    }
    const active = document.activeElement
    // Ownership, not just role. Asking only whether the active element is *a*
    // tab lets a `view.activate` aimed at another panel drag the caret across
    // the window — and the arrival then trips R1, which dispatches
    // `layout.focus` and overrides the caller's `focusPanel: false` outright.
    const onOwnTab = active !== null && ownsTab(tabEls.current, active)
    // `claimed` only rescues the case it was set for: focus fell out of the
    // document because the element under it was removed. It is set by this
    // hook's own key handler and nowhere else, so a stale claim cannot be
    // manufactured by another panel; and if the user has since moved the caret
    // somewhere real, the `body`/`null` test refuses to steal it back.
    const fellOut = claimed && (active === null || active === document.body)
    if (!onOwnTab && !fellOut) return
    const el = tabEls.current.get(activeViewId)
    if (el === undefined || el === active) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeViewId])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): void => {
      const current = activeViewId === null ? 0 : Math.max(0, viewIds.indexOf(activeViewId))
      const action = tabStripKeyAction(e, current, viewIds.length)
      if (action === null) return
      const target = viewIds[action.index]
      if (target === undefined) return
      e.preventDefault()
      claimFocus.current = true
      if (action.kind === 'close') void dispatch('view.close', { viewId: target })
      // Automatic activation: moving the roving point *is* selecting.
      else void dispatch('view.activate', { viewId: target, focusPanel: true })
    },
    [viewIds, activeViewId],
  )

  const tabIndexOf = useCallback(
    (viewId: ViewId): 0 | -1 => tabRovingTabIndex(activeViewId, viewId),
    [activeViewId],
  )

  void panelId
  return { tabIndexOf, onKeyDown, registerTab }
}

/**
 * Is this element one of the tabs *this* strip registered?
 *
 * A `Map#values()` scan over at most `MAX_PANEL_TABS` entries, rather than a
 * `role="tab"` test on the element: the role is shared by every strip in the
 * window, and "the caret is on a tab" is not the question. The question is "the
 * caret is on a tab of mine", and only the registry can answer it.
 */
export function ownsTab(tabs: ReadonlyMap<ViewId, HTMLElement>, el: Element): boolean {
  for (const tab of tabs.values()) {
    if (tab === el) return true
  }
  return false
}

/* ================================================================== */
/* 5. Ref composition                                                  */
/* ================================================================== */

/**
 * Fan one element out to several callback refs.
 *
 * A panel element now has two independent claims on it: the drag registry
 * (`registerPanelEl`, which hit-tests drops against panel rectangles) and this
 * hook. Both are callback refs, and React only accepts one `ref` prop, so the
 * composition has to live somewhere shared rather than being re-improvised in
 * each component.
 */
export function composeRefs<T>(
  ...refs: readonly ((el: T | null) => void)[]
): (el: T | null) => void {
  return (el: T | null) => {
    for (const ref of refs) ref(el)
  }
}
