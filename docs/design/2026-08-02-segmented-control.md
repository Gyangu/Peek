# `<Segmented>`: writing "pick one of several" as picking one of several

> 2026-08-02. The first item in the later batch listed by the control spec
> ([`2026-08-02-control-spec.md`](2026-08-02-control-spec.md) §2.9). The reason it
> was deferred there was "`.seg` is part of a mutually exclusive selection group,
> and what is needed is a `<Segmented>` rather than a button variant" — this
> document makes good on that sentence.

---

## 1. What this fixes

### 1.1 Three hand-written implementations, word for word identical

`.segmented` has three call sites in the repository, all **exactly** the same
shape:

| location | what it selects | value type |
|---|---|---|
| `ConnectDialog.tsx:172` | URL string / separate fields | `ConnectMode` |
| `settings/AppearanceSection.tsx:37` | interface language | `Locale` |
| `settings/AppearanceSection.tsx:96` | interface zoom (6 steps) | `number` |

```tsx
<div className="segmented">
  {items.map((x) => (
    <button key={…} type="button" className={sel ? 'seg active' : 'seg'} aria-pressed={sel} onClick={…}>
      {label}
    </button>
  ))}
</div>
```

Three copies, not a character apart. This is the disease the control spec's §1.2
recorded, in another organ beyond buttons — except that what is copied this time is
not one CSS rule but a whole **interaction**.

### 1.2 More importantly: the ARIA is describing something else

All three hang `aria-pressed` on each option. That is the semantics of a **toggle
button group**, and a screen reader reads it as N unrelated switches. What the
user hears is

> "中文, pressed" … (Tab) … "English, not pressed"

Two independent switches, rather than **one choice with two options**. It does not
say "1 of 2", and it does not announce the newly selected option on a change.
Mutually exclusive selection has its own pattern in WAI-ARIA, called
`radiogroup` / `radio` plus `aria-checked`, and none of the three uses it.

### 1.3 Keyboard: one control occupying six Tab stops

Because they are N independent buttons, Tab walks through them one at a time. The
zoom group has six steps, so **getting from language to the next setting takes
seven Tab presses**. A radiogroup's convention is one stop for the whole group with
arrow keys moving inside it, which is both the correct ARIA and, incidentally,
brings the Tab count from N down to 1.

### 1.4 `.seg` is two unrelated classes

`styles.css` has two:

```
.segmented .seg   → flex: 1; border-radius: 0        (the connect dialog's segmented control)
.statusbar .seg   → display: flex; align-items: center; gap: 5px   (a status bar cell)
```

Same name, unrelated. This is not merely uncomfortable to look at: the control
spec's className fence looks up declarations **by class name** (it cannot resolve
statically which rule is hit at run time), so **the stricter of two same-named
classes** constrains both. That is why, last round, the reason StatusBar was
blocked was written down wrongly.

### 1.5 Boundary (explicitly not done)

1. **No multi-select variant.** All three call sites are single-select. Multiple
   selection is a different control (a checkbox group) and can wait for a real use
   case.
2. **No "manual activation" mode** (arrow keys move focus only, and Space selects).
   Reasoning in §3.3.
3. **`.settings-pane .segmented`'s width convention is untouched.** That is a
   settings-page layout decision, unrelated to the control.
4. **No `<Field>` or `<Dialog>`.** The batches in the control spec's §2.9 still
   apply.

---

## 2. The plan

### 2.1 The API: data-driven, generic in the value type

```tsx
<Segmented
  value={mode}
  options={[
    { value: 'url', label: t('connect.mode.url') },
    { value: 'fields', label: t('connect.mode.fields') },
  ]}
  onChange={(next) => switchTo(driverId, next)}
  label={t('connect.mode')}
/>
```

- **Generic**: the three values are `ConnectMode`, `Locale` and `number`, so
  `Segmented<T extends string | number>`. `onChange` receives a `T` rather than a
  `string`, and the caller no longer has to cast.
- **An `options` array rather than compound children**
  (`<Segmented><Segmented.Option/></Segmented>`): all three call sites map over
  data, and the compound spelling needs a context to carry `value`/`onChange`,
  buying nothing for the extra indirection. See §3.1.
- **`label` is required**: it is the `aria-label`. Given a selection group with no
  name, a screen reader reads the options and never says what is being chosen. The
  same reasoning as `<Button icon>`'s required `label` — **make "no name"
  inexpressible**.

### 2.2 ARIA: `radiogroup`, not `aria-pressed`

```html
<div role="radiogroup" aria-label="Interface language" class="seg-group">
  <button role="radio" aria-checked="true"  tabindex="0"  class="seg-item">中文</button>
  <button role="radio" aria-checked="false" tabindex="-1" class="seg-item">English</button>
</div>
```

`<button role="radio">` rather than a native `<input type="radio">`: a native
radio's appearance would have to be redrawn wholesale at this density
(`appearance: none` plus painting it), while `role="radio"` gets the same
semantics. This matches the repository's existing practice — the tab strip is
`div role="tab"` too (`PanelTabs.tsx`).

### 2.3 Keyboard: one stop, arrow keys move and select

| key | behaviour |
|---|---|
| `Tab` | into and out of the whole group (roving tabindex: only the selected item has `tabindex=0`) |
| `←` `↑` | previous item, **and select it**, wrapping |
| `→` `↓` | next item, **and select it**, wrapping |
| `Home` / `End` | first / last item, and select it |
| `Space` / `Enter` | select the current item (the equivalent of a click) |

Arrow keys **move focus and select at the same time**, which is the WAI-ARIA radio
group's default convention and the behaviour of a native radio. Trade-off in §3.3.

The wrap arithmetic is a pure function and separately testable — this repository
has no jsdom, and logic that lives only inside a component is untested logic.

**It turned out to exist already.** `nextFocusIndex(count, current, shift)` in
`modalStack.ts` is the same wrapping arithmetic under a different signature (Tab
trapping in a modal, versus arrow keys here). Nearly a second copy was written, so
it is extracted as `wrapIndex(count, current, delta)` in `util/roving.ts`, with a
thin shell on each side — `nextFocusIndex` keeps its contract of "returns `null`
for an empty list", and that difference is why the shell exists.

### 2.4 Visuals: unchanged

The selected state is still an `--accent-dim` background with an `--accent`
border, and the unselected state is still an ordinary button face. Nothing is
**recoloured** here — the same discipline as the control spec's §1.6 item 5:
consolidation is not redesign.

What is added is the two states the control spec added for buttons: `:active` (a
press has feedback) and `:focus-visible` (visible to the keyboard). The old `.seg`
had neither, and this control is now **keyboard-first**.

### 2.5 Sizes: `spec.ts` renamed to a control-layer concept

`BUTTON_SIZES` / `ButtonSize` become `CONTROL_SIZES` / `ControlSize`. Two
primitives share one set of steps (24 / 20px), and calling it "button sizes" forces
the next primitive either to restate it or to alias it — two names for one thing,
which is what this spec has been arguing against throughout. The class names stay
separate (`btn-md` / `seg-md`); what is shared is **the steps themselves**.

### 2.6 `.statusbar .seg` → `.statusbar .cell`

Eliminating §1.4's name collision along the way. Eight `<span className="seg">`
become `cell`, and one CSS rule is renamed. The new primitive's class names are
all prefixed `seg-*` (`seg-group` / `seg-item`), and the old `.segmented` / `.seg`
rules are deleted wholesale once the three call sites are migrated.

### 2.7 Files involved

```
renderer/ui/
├─ Segmented.tsx          # the new primitive
├─ segmented.css          # seg-group / seg-item × states
├─ spec.ts                # BUTTON_SIZES → CONTROL_SIZES
└─ __tests__/segmented.test.ts

renderer/util/roving.ts   # wrapIndex / indexOfValue, shared with modalStack
renderer/__tests__/sourceScan.ts  # adds stylesheets() and blankComments()

migrated: ConnectDialog.tsx (plus its other four buttons), AppearanceSection.tsx ×2, StatusBar.tsx (renaming)
deleted: every .segmented / .seg rule in styles.css
ledger: ConnectDialog and AppearanceSection both move out
```

**`segmented.css` has to enter three inventories**: `type-scale.test.ts`'s
stylesheet scan, `theme-contrast.test.ts`'s literal-border scan and `ALPHA_SITES`
census, and `control-spec.test.ts`'s `STYLESHEETS`. This is exactly the scenario
those three hard-coded inventories should be merged for — **if this new stylesheet
goes unregistered, three rules go blind to it at once**, and each of their failure
modes has already occurred once this round. So this round **also converts the
stylesheet inventory to a filesystem scan** (item 3 of the later recommendations).

---

## 3. Trade-offs

### 3.1 Why not compound children

`<Segmented><Segmented.Option value="url">…</Segmented.Option></Segmented>` is
more flexible: each option can hold arbitrary content. But all three call sites map
over data, so there is no buyer for that flexibility; the cost is that `value`,
`onChange` and the roving tabindex all have to travel through a context, and a
context turns "which one is selected" from an array lookup into a run-time
convention. In the data-driven version `Segmented` knows the index itself, so
keyboard navigation is a few lines of array arithmetic rather than a registration
mechanism.

When "an icon plus two lines of text in an option" genuinely comes up, adding a
`render` prop will be cheaper than adopting a context now.

### 3.2 Why `radiogroup` rather than `tablist` or `toolbar`

- `tablist` promises "switch to a panel pointed at by `aria-controls`". Neither
  language nor zoom switches any panel, and the connect dialog swaps field sets
  within one form, which is not a tab panel either. `tablist` would send a screen
  reader looking for a `tabpanel` that does not exist.
- `toolbar` plus `aria-pressed` is the status quo, and §1.2 says why it is wrong.
- `radiogroup` says exactly this: a group of mutually exclusive options, exactly
  one of which is selected.

### 3.3 Why arrow keys select directly rather than moving focus for Space to confirm

WAI-ARIA allows both, and manual activation exists for cases where **selecting is
expensive** (switching a tab that has to fetch data, say). All three cases here
cost roughly nothing: changing language is local state, changing zoom is one
`setZoomFactor`, and changing connect mode swaps a set of form fields. Automatic
selection matches a native radio and takes one keystroke fewer.

If a segmented control that "fires a request on selection" ever appears, that is
the time to add `selectionFollowsFocus={false}` — but **adding the parameter before
the use case** is something this spec has been avoiding throughout.

### 3.4 Why `<button>` rather than a native `<input type="radio">`

A native radio gives the same semantics, but its appearance would have to be
painted wholesale (`appearance: none`), and its built-in label association, focus
ring and spacing would each have to be suppressed — the net result being "use the
native control, then turn off everything native about it". There is precedent in
the repository: the tab strip is `div role="tab"`, for the same reason.

### 3.5 Why the stylesheet inventory is merged now

It began as a separate recommendation. But `segmented.css` is **the fifth
stylesheet, added this very round**, and missing it in the three hard-coded
inventories would blind the type-size floor, the literal-border ban, and the alpha
census to it simultaneously. It has already been demonstrated: `#7a3f3f` escaped
the audit by "not being a token", and `opacity` escaped by "not being a colour
declaration" — letting a new stylesheet escape by "not being in the inventory"
would be the third spelling of one error.

---

## 4. Verification

What follows is **results already obtained**.

**Automated**:
1. ✅ Pure-function tests for the wrap arithmetic and value lookup: forwards,
   backwards, wrapping, Home/End, a single element, an empty group, and "the value
   is not in the group". Eight cases.
2. ✅ The DOM contract: `role="radiogroup"`, `role="radio"` plus `aria-checked`,
   `aria-label`, exactly one `tabIndex=0`, and **asserting that not one
   `aria-pressed` remains**.
3. ✅ `segmented.css` covers unselected/selected × rest/hover/active/focus-visible,
   eight selectors, in both size steps.
4. ✅ The stylesheet inventory becomes a filesystem scan (three hard-coded copies
   merged), asserting the scan is non-empty and includes `styles.css`.
5. ✅ The ledger: `ConnectDialog` and `AppearanceSection` both move out, and
   `ledger has no stale entries` is green.
6. ✅ **All 1,267 tests pass**; `pnpm typecheck` across six packages;
   `pnpm build` (renderer 559.47 kB, +1.2 kB).

**Measured over CDP** (build output in a real Electron):

7. ✅ Both segmented controls are `role="radiogroup"` with an `aria-label`, six
   `role="radio"`, correct `aria-checked`, an **`aria-pressed` count of 0**, and
   exactly one `tabIndex=0`, on the selected item.
8. ✅ 25.4px high (≥ the 24 floor), outer corners rounded and inner ones square,
   the selected item in accent.
9. ❗**A screenshot turned up something unplanned**: the settings dialog's ✕ has an
   **amber** focus ring while the control layer's ring is blue — two of them in one
   dialog. The cause is that `styles.css` has **never had** a
   `button:focus-visible`, so an unmigrated bare `<button>` falls through to
   Chromium's default ring, which on macOS follows the **system** accent colour.
   Fixed: the focus ring goes on the element selector, in the same place and for
   the same reason as `min-height: var(--hit-min)` — **a floor cannot hold only for
   the files somebody found time to migrate**. This one could only have been found
   by looking at a screenshot.

**For a person to do**:
10. Verify with VoiceOver whether the announcement really is "M of N". This is the
    core benefit of the change, and precisely the half an agent cannot verify.
    Another entry on PLAN §11.2's ledger.
