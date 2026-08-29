# The generic right-click menu primitive, `<Menu>`

> 2026-08-03. One of the next batch of primitives that
> [`2026-08-02-control-spec.md`](2026-08-02-control-spec.md) §2.9.1 named but did
> not build; and it **overturns** one of the lines in
> [`2026-08-02-connection-list.md`](2026-08-02-connection-list.md) §1's "not this
> time" list (see §1.3).

---

## 1. What this fixes

### 1.1 Where things stand: one place in the whole window takes a right click

There are 2 `onContextMenu` handlers in the entire repository, and one of them is
the menu's own overlay:

| location | purpose |
|---|---|
| `components/DataGrid.tsx:715` | rows of the result grid |
| `components/context-actions/ContextMenu.tsx:104` | "a right click closes it too", on the menu's overlay |

Which is to say: **only the result grid's rows take a right click**. Object-tree
nodes, panel tabs, session-list rows, sidebar connection rows — a right click in
any of those four does nothing at all. This is the single most counter-intuitive
thing in a desktop database client: in TablePlus / DBeaver / DataGrip the object
tree's right-click menu is the primary way in.

### 1.2 The existing menu cannot be reused

`context-actions/ContextMenu.tsx` is not a menu control. It is the UI of the "add
what I am looking at to the conversation" feature. The evidence:

- its required prop is `target: ContextTarget`, its contents are decided by
  `contextActionsFor(target)`, and every item of `ContextAction` must carry a
  `build(): ChatAttachment`;
- it carries a disclosure-consent gate of its own (when `consentPending`, the
  whole menu is replaced by `ConsentDialog`);
- it carries its own "there is no chat panel" notice line.

A caller that wants to place two items unrelated to the conversation (the grid's
copy commands) goes through `extraItems`, which is a **bypass**, and the file's
header comment states the reason itself: `ContextAction` cannot fold in an act
that is not an attachment. A primitive should not have a bypass.

### 1.3 Conflict with an existing design document (checked with the user)

`2026-08-02-connection-list.md` §1 "Boundary (not this time)" says:

> No generic popup menu primitive. `context-actions/ContextMenu.tsx` is welded to
> `ContextTarget`, and extending it for the sidebar costs more than it returns;
> the acts stay in the action bar that the selected row expands.

That conclusion is **void**, and both halves change:

1. the generic popup menu primitive is built this time — the reason back then was
   "extending a welded component for the sake of one sidebar is not worth it",
   and the input now is four call sites, so the denominator of that cost has
   changed;
2. the sidebar connection row's **action bar is replaced by the right-click
   menu** (user's decision, 2026-08-03). A selected row is still a selected row,
   but it no longer expands `.conn-actions`.

The cost of that trade is written down in §3.2.

### 1.4 Boundary (not this time)

- **No submenus.** Not one of the four call sites needs a second level. Adding
  one means handling hover delay, direction flipping and keyboard traversal, and
  that is where a primitive starts getting away from you. Open a separate
  document when one is genuinely needed.
- **No dropdown anchored to an element.** `chat/AttachmentBar.tsx`'s attachment
  dropdown is the same family of thing, but it anchors to a button rather than to
  the pointer. This `<Menu>` accepts a point and nothing else. It stays in
  `NOT_CONTROLS`, with its reason rewritten to "waiting for the anchored menu".
- **No global command palette / shortcut bindings.** Menu items declare no
  shortcuts.
- **`DataGrid`'s selection model and the "add to conversation" disclosure gate
  are not touched**, only its menu is re-shelled.

---

## 2. The plan

### 2.1 Three layers, divided along "who knows the business"

```
ui/Menu.tsx        primitive: knows only "a list of items, a coordinate, how to close". Zero business.
ui/useContextMenu  gesture: turns an onContextMenu event into {x, y, payload} state. Zero business.
each call site's xxxMenuItems(...)   pure function: business → an array of menu items. Assertable with no DOM.
```

The third layer is the one that matters. `contextActionsFor` is already this
shape (pure, testable); this generalises the same shape to four more places
instead of letting each component assemble an array inline in its JSX.

### 2.2 The API of `ui/Menu.tsx`

```ts
export type MenuNode =
  | { kind: 'item'; id: string; label: string; title?: string; disabled?: boolean
      tone?: MenuTone; confirm?: string; onSelect: () => void }
  | { kind: 'note'; id: string; text: string; tone?: MenuTone }   // a line of explanation, not selectable
  | { kind: 'head'; id: string; text: string }                    // group heading
  | { kind: 'sep'; id: string }

export interface MenuProps {
  label: string            // for the modal stack and the aria-label; not displayed
  at: { x: number; y: number }
  nodes: readonly MenuNode[]
  onClose: () => void
}
```

`style` is not exposed and neither is `className` — a menu is always a floating
layer, and the caller has no layout to speak of. That is one notch tighter than
`<Button>`'s fence, deliberately.

**`tone`** goes into `spec.ts` with two values: `default` and `danger`, each
carrying one sentence of `intent`. It does not reuse `ButtonVariant`: `primary` /
`ghost` / `caution` cannot be expressed in a column of equal-width menu items (a
menu item has neither background nor border, so `ghost` and `default` would
render to the same pixels), and an enum with one member identically equal to
another is lying. The CSS contract test checks the five states of
`menu-item-<tone>` one by one just the same.

**`confirm`** moves `ConfirmPair`'s semantics into the menu: selecting an item
that carries `confirm` **replaces the menu in place with two lines** — "Cancel"
(which takes focus) and the confirming item (`danger`). That preserves the thing
`ConfirmPair` is actually there to guarantee: **the second click lands on the
safe one**. The sidebar's "Remove" and a conversation's "Delete" both rest on it,
which is how those two places lose their action bars without losing that safety
catch.

### 2.3 Keyboard and closing

Reuse `hooks/useModalDialog`: Escape reaches only the topmost layer, Tab is
trapped inside, focus returns to where it was after closing. `ContextMenu`
already does exactly this, and its comment states the reason plainly (the grid's
Escape clears the selection, and the menu is very often open *because of* that
selection). `<Menu>` inherits the rule.

On top of that come the menu's own keys: ↑/↓ move between selectable items
(skipping `sep`/`head`/`note`/`disabled`), Home/End go to the ends, Enter/Space
fire. This sits outside `useModalDialog`'s Tab cycle, because a menu's primary
keyboard is the arrow keys — such is the ARIA convention for `role="menu"`.

### 2.4 Positioning

Keep what the existing implementation does and fix one approximation in it: today
it estimates the size with the constants `MENU_W/H = 260` and then clamps back
into the viewport, so a two-item menu is treated as 260px tall and gets pushed
far away from the pointer on a right click near the bottom edge of the window.
Changed to **render one frame under `visibility: hidden`, measure the real size,
then position** (`useLayoutEffect`, all within the same frame, so the user never
sees the intermediate state). The flip rule: down-and-right first, flip to the
other side of the pointer if it does not fit, clamp to the edge only if it still
does not.

### 2.5 The four call sites

| location | menu items | notes |
|---|---|---|
| `views/TreeView.tsx` node | Open / Search / Copy name / Reload this level | a right click selects that node first, as in every file manager |
| `PanelTabs.tsx` tab | Close tab / Close other tabs / Split left/right / Split top/bottom / Close panel | "Close other tabs" = `view.close` on each remaining `viewId` |
| `chat/ChatSessionsRail.tsx` row | Open / Delete | Delete carries `confirm`; the in-row action bar stays (the user asked only for the sidebar's to go) |
| `Sidebar.tsx` connection row | Connect / Disconnect / Object tree / Query / Edit / Remove | **replaces** `.conn-actions`; Remove carries `confirm` |

The sidebar's existing mutual-exclusion rule — an active connection gets
Disconnect, an inactive one gets Remove — moves into `connectionMenuNodes()`
unchanged: that rule is the conclusion of `2026-08-02-connection-list.md` §2.1,
and changing its carrier does not change the conclusion.

Each site's `xxxMenuNodes()` is a pure function taking the state objects that
already exist plus `t`, and returning `MenuNode[]`; the component's only job is
handing it to `<Menu>`.

### 2.6 The existing `ContextMenu` becomes one caller of `<Menu>`

`context-actions/ContextMenu.tsx` stays (the disclosure gate and the
`hasChatTarget` notice are its business), but it no longer draws DOM internally:
it flattens `extraItems` + `contextActionsFor(...)` into `MenuNode[]` and hands
them to `<Menu>`. The `extraItems` bypass therefore turns into the ordinary case
of "a caller could always pass any `MenuNode` it likes" — the bypass disappearing
is one concrete gain of this change, not a by-product.

The `ctx-menu-*` CSS moves from `context-actions.css` to `ui/menu.css`, renamed
`menu-*`.

### 2.7 What changes in the control-layer ledger

- `ui/Menu.tsx` enters `PRIMITIVES` (it must render a real `<button>`);
- the `context-actions/ContextMenu.tsx` line is deleted from `NOT_CONTROLS` (it
  no longer has a bare button);
- the `chat/AttachmentBar.tsx` line stays, its reason rewritten to "an anchored
  dropdown, waiting on the follow-up in §1.4";
- `ui/CLAUDE.md`'s "next batch of primitives" strikes `<Menu>` off and gains a
  section on how to use it.

---

## 3. Trade-offs

### 3.1 Why not simply add parameters to `ContextMenu`

Ran it through in my head: to have it serve four new call sites as well, `target`
would have to become a union type, `ContextAction.build()` would have to become
optional, the disclosure gate would have to be switchable off, and the "there is
no chat panel" notice would have to be switchable off. The result is a component
with four boolean switches, three of which only one caller ever turns on. That is
not reuse, it is four components stacked on top of each other. The primitive and
"add to conversation" are two different things, and this change separates them.

### 3.2 What the sidebar pays for losing its action bar

**Discoverability drops**: the right click is a hidden gesture, and a new user
will not know a connection row has one. That is a real loss, and the user chose
it knowingly (for a cleaner sidebar). Mitigation: the connection row's `title`
gains a line, "Right-click for actions" — one line of cost, no space on screen.
**Not doing** a "⋯" button on hover: that is the action bar added back in a
different shape.

### 3.3 Why `tone` does not reuse `ButtonVariant`

See §2.2. One more point from the other side: were it reused, `spec.ts`'s CSS
contract test would demand that `menu-item-primary` and `menu-item-ghost` each
define five states, whose real definition is "identical to default". Five
identity rules would appear in the contract test, and the next person to read it
would assume they differ.

### 3.4 Why measure instead of carrying on estimating

The cost of estimating is visible (the bug in §2.4); the cost of measuring is one
extra layout pass. A menu measures once per opening, and there is exactly one
floating layer in the DOM — measuring it is cheaper than arguing about what the
constant should be.

---

## 4. The second batch: replace everything left that can be replaced

> Appended the same day, 2026-08-03. After the first batch landed, the user's
> request was "replace everything that can become a right-click menu", so every
> candidate surface in the renderer was counted through. The count is written
> down here together with **the reasons for the ones not replaced** — "where a
> right click is deliberately withheld" is as much a decision as "where one is
> given".

### 4.1 The ones replaced

| location | menu items | the problem this solves |
|---|---|---|
| `error-center/ErrorCenter.tsx` error row | Copy this entry / Copy the whole log / Clear the log (danger) | one permanent "copy" button per row, so ten rows on screen is ten buttons |
| `DataGrid` column header | Sort ascending / Sort descending / Remove sort / Copy column name | sorting could only cycle by clicking the header, and **removing the sort had no route at all** |
| `chat/MessageItem.tsx` message | Copy message | a message had **no acts whatsoever**, not even copy |
| `chat/ToolCallCard.tsx` tool-call card | Copy arguments / Copy result | same as above: it could only be expanded and looked at, nothing could be taken away |
| `chat/AttachmentBar.tsx` attachment chip | Copy label / Remove (danger) | there was only a 12px `×` |
| `chat/MessageItem.tsx` receipt chip | Copy label | zero acts |
| `views/InspectorView.tsx` key-value row | Copy key / Copy value | zero acts; and this is the thing most often copied away |
| `chat/Markdown.tsx` code block | Copy code | previously a button that appeared only on hover |
| `LayoutTree.tsx` divider | Even split | the ratio could only be dragged, and a bad drag had no way back |

Two places had their **in-row acts deleted**, handled the same way as the
sidebar:

- `chat/ChatSessionsRail.tsx`'s `.conn-actions` action bar — the first batch kept
  it because "the sidebar is the one the user asked to replace", but what keeping
  it produced was two routes to the same thing and two confirmation mechanisms
  (the action bar's `ConfirmPair` and the menu's `confirm`). One thing, one
  route.
- `views/TreeView.tsx`'s `.tree-action` vector search button — it appears on only
  a few nodes, it is an in-row button that only means anything on hover, and the
  menu already carries the same item. Deleting it also strikes one bare
  `<button>` out of the control layer's `MIGRATION_LEDGER` for `TreeView.tsx`.

### 4.2 The ones deliberately not replaced, and why

- **The empty panel's buttons** (`Panel.tsx`). They are the empty panel's **only**
  way out, and hiding the only way out behind a hidden gesture trades usability
  for tidiness. An empty panel has nothing else taking up the space anyway.
- **The settings page's form buttons** (`McpSection` / `TimeoutsSection`'s
  "Apply" and "Rotate token"). They are not "the acts of some row", they are a
  form's submit; a right-click menu is not a substitute for a submit button.
- **The first-run guide, and confirm pairs** (`FirstRunGuide` / `ConfirmPair`).
  Same as above, the only way out.
- **Form inputs** (`ConnectDialog` and the like). A right click on an input should
  be the system's cut/copy/paste, and covering that over is a net loss.
- **Status bar cells** (`StatusBar`). They are **readings**, not objects; giving a
  reading a "copy the revision" menu builds an entrance for an act nobody wanted.
- **`AttachmentBar`'s attachment dropdown**. It anchors to a button rather than to
  the pointer, so it still waits on §1.4's anchored menu; not in this batch.

### 4.3 One new shared piece

Seven of the nine menus do "copy something". `navigator.clipboard.writeText` was
scattered across the renderer in 7 copies, 3 of which handled "clipboard is
undefined outside a secure context" and 4 of which did not. This gathers them
into `copyText()` in `util/clipboard.ts`: **it fails silently**, because not one
of the copies in a menu is worth a toast — the user finds out immediately when
nothing pastes. The grid's copy does not go through it; it has its own `runCopy`,
which has to report how many rows were truncated.

## 5. Verification

**Automated** (`pnpm -C apps/desktop test`):

1. `ui/__tests__/menu.test.ts`
   - `menuFocusables` skips `sep`/`head`/`note`/`disabled`; an empty menu does
     not crash;
   - `placeMenu(at, size, viewport)` across the four quadrants, plus clamping to
     the edge when neither direction fits;
   - the `confirm` state machine: selecting an item carrying `confirm` → replaced
     by [Cancel, confirm], cancel returns to the original menu, only the
     confirmation calls `onSelect`, and before that confirmation `onSelect` has
     not been called even once.
2. `ui/__tests__/control-spec.test.ts`
   - the five states of `menu-item-<tone>` are all present in `ui/menu.css`
     (reusing the existing matrix check);
   - `PRIMITIVES` / `NOT_CONTROLS` are still all green after the §2.7 update.
3. Pure-function assertions on each call site's `xxxMenuNodes()`
   (`components/__tests__/context-menus.test.ts`):
   - sidebar: a row with an active connection **does not contain** "Remove", a
     row with no active connection **does not contain** "Disconnect" (pinning
     `2026-08-02-connection-list.md` §2.1's mutual-exclusion rule as a test);
   - tabs: "Close other tabs" does not appear when there is only one tab;
   - object tree: "Search" does not appear on a node that is not a vector
     collection, "Reload this level" does not appear on a leaf node;
   - column header: a column already sorted ascending **no longer offers** "Sort
     ascending"; an unsorted column **has no** "Remove sort"; a view that cannot
     be sorted (query results, vector search) is left with only "Copy column
     name" rather than a row of greyed-out sort items.

**Manual verification for the second batch**:

6. right-click any row in the error centre → Copy this entry / Copy the whole log
   / Clear the log; confirm the row no longer has a permanent button;
7. right-click a table column header → a sorted column should offer "Remove
   sort", and clicking it returns the table to unordered;
8. right-click delete on a session row → the menu is replaced by two lines;
   clicking a row still opens the session (the opening gesture has since been
   changed from a double click to a single click by
   [`2026-08-03-session-row-single-click.md`](2026-08-03-session-row-single-click.md));
   an already-open row shows "Already open"
   rather than a greyed-out button;
9. right-click the split divider → Even split;
10. the vector-collection nodes in the object tree no longer have a "Search"
    button appearing on hover; that item now lives in the right-click menu.

**Manual**:

1. right-click once each on an object-tree node / a tab / a session row / a
   connection row; the menu appears at the pointer;
2. right-click the connection row in the **bottom-right corner** of the window —
   the menu should flip to hug the pointer, not be pushed far away;
3. open a menu, walk it with ↑↓, close with Escape; focus returns to the row it
   came from;
4. right-click "Remove" in the sidebar → the menu is replaced by two lines, focus
   is on "Cancel", and pressing Enter does nothing;
5. right-click in the result grid; confirm "add to conversation" and the
   first-time disclosure dialog behave exactly as before the change.
