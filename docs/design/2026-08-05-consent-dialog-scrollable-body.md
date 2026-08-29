# The consent dialog: a scrollable body, so Accept is always reachable

The landing record for F4 of the fifth adversarial audit. The finding itself is
written up in `2026-08-04-tailwind-migration.md` §20.5; this document covers how
it was changed, why that way, and what was measured.

## 1. What this fixes

### 1.1 Where things stand

`ConsentDialog` is the **only** dialog in the window whose body is not wrapped in
a scroll region:

- `MODAL_SHELL` carries `overflow-hidden` and `MODAL_SIZE` caps at
  `max-height: 80vh`;
- the other three dialogs (value expansion, connection form, settings) all wrap
  their middle section in `MODAL_BODY` (zero minimum height + fills the remaining
  space + scrolls automatically);
- the consent dialog's five paragraphs and two buttons **sit directly in the
  shell**.

The shell clips and has no scrollbar, so the moment the viewport is too short for
the content, the buttons do not "scroll out of view" — they are **clipped and
unreachable**. Escape still cancels. So this dialog degrades into one that **can
only be refused, never accepted**.

### 1.2 Boundary (not done here)

- `styles.css` is not touched (this phase has a single writer for it elsewhere).
- `MODAL_SIZE`'s `80vh` does not change, nor the 520px width, nor the copy.
- It is not "unified" into the generic dialog's shape. It has no title bar, no
  button bar, its heading is in the warning colour, and it is typeset as prose
  rather than as a form — **and that difference is itself the signal**: it is the
  one dialog standing at the door where data leaves this machine (`consent.ts`'s
  header comment, `2026-08-03-context-menu-primitive.md` §1.2). Flattening it to
  reuse a class string trades semantics for line count.
- The other three dialogs are untouched (measured this round; see §4.3).

## 2. The plan

Cut the shell in two, **splitting the vertical padding across the two halves**,
and change nothing else:

| | before | after |
|---|---|---|
| shell | size + `pt-4 px-4.5 pb-3.5` | size, no padding |
| body | (no such layer) five paragraphs are direct children of the shell | a new layer: zero minimum height + fills the remainder + scrolls automatically + `px-4.5 pt-4` + a keyboard focus ring, with `tabIndex={0}` |
| action row | `flex justify-end gap-2 mt-1.5` | `flex flex-none justify-end gap-2 px-4.5 pt-1.5 pb-3.5` |

Three points worth writing down separately:

1. **Vertical spacing is conserved.** It used to be "the last paragraph's 10px
   bottom margin + the action row's 6px top margin = 16px", and it is now "the
   last paragraph's 10px bottom margin (inside the scroll region) + the action
   row's 6px top padding = 16px". The bottom 14px moves from the shell to the
   action row. **When the content fits, the geometry is unchanged** — measured
   pixel for pixel identical (§4.1).
2. **The action row is `flex-none`.** Without it, it is a compressible flex item
   and shrinks the moment the body squeezes, putting the buttons back below the
   clip line — the same bug through a different door. The test pins this.
3. **`tabIndex={0}` is not decoration.** A scroll container holding no focusable
   element **cannot be scrolled by keyboard at all**: arrow keys act on "the
   focused element's scrolling ancestor", and here the focus is on a button in the
   row *below*. Without focus, the body is "readable only with a mouse" — which,
   for a dialog that must be read before it can be answered, is the same bug
   wearing gloves. The focus ring uses the window's existing inset 2px accent ring
   (the same one on panels, the grid and popup menus), and **not one CSS rule is
   added**.

`MODAL_BODY` is not reused: that one carries the generic dialog's padding (see
§1.2). A sentence is added to `MODAL_BODY`'s comment in `modalClasses.ts`
explaining why the fourth caller deliberately does not use it.

## 3. Trade-offs

**Option A: raise `MODAL_SIZE`'s ceiling (to 90vh, say).** Rejected. It pushes the
slack from 24px to 40px without changing the shape — one more sentence of copy,
one more language, one more zoom step, and the same failure comes back, and next
time nobody will think to measure. A scroll region deletes the question of whether
it can overflow; raising the ceiling only pushes it further away.

**Option B: shorten the copy.** Rejected. This is a disclosure, and every sentence
removed is something the user is not told; and it likewise only buys slack without
changing the shape.

**Option C: wrap the whole thing in `MODAL_BODY` and add a title bar and button
bar to match the other three.** Rejected, per §1.2: the visual difference is this
dialog's only signal that this time is different.

**Option D (chosen): its own scroll region with its own padding.** The cost is one
more DOM layer and a class string shared with nobody. The benefit is that
overflowing becomes shape-impossible, with the appearance unmoved by a pixel.

## 4. Verification

All of it measured inside Electron's own Chromium against the **build output**, in
both languages. The floor viewport is reproduced the way the product actually
reaches it: a content height of 600 (`main/index.ts`'s `minHeight`) × zoom 1.5
(`UI_ZOOM_MAX`) ⇒ a 400px CSS viewport ⇒ `80vh` = 320px.

**Every class name in the probe page comes from the real source**
(`modalClasses.ts`, `ui/spec.ts`, and both message catalogues) and was checked
with the repository's own `attributeClassNames`: 57 classes in the component, 57
in the probe, with an empty difference both ways.

### 4.1 The floor viewport (400px CSS), before / after

| | before | after |
|---|---|---|
| shell height en | 296px | **296px** |
| shell height zh | 260px | **260px** |
| Accept rect en | 307..333 | **307..333** |
| Accept rect zh | 289..315 | **289..315** |
| Accept inside the shell | yes | yes |
| hit test lands on the button | yes | yes |

**Pixel-identical when it fits.** The two numbers from §20.5 were re-checked along
the way: `scrollHeight` reads en 294 / zh 258, matching the audit; computed from
the layout height the slack is 320 − 296 = **24px** (the audit's 26px was derived
from `scrollHeight`, and the 2px difference is noted here so the next person does
not take it for two different measurements).

### 4.2 Pressed downwards: clipping before, scrolling after

The CSS viewport stepped down from 400px (content heights 600/540/480/420/360/300
× zoom 1.5):

| CSS viewport | before, en | before, zh | after, en | after, zh |
|---|---|---|---|---|
| 400 | complete | complete | complete | complete |
| 360 | bottom padding eaten | complete | scrolls 8px | complete |
| 320 | **Accept clipped, hit test misses** | complete | scrolls 40px | scrolls 4px |
| 280 | **last paragraph + action row clipped** | **Accept clipped** | scrolls 72px | scrolls 36px |
| 240 | **two paragraphs + action row clipped** | one paragraph + action row clipped | scrolls 104px | scrolls 68px |
| 200 | **two paragraphs + action row clipped** | two paragraphs + action row clipped | scrolls 136px | scrolls 100px |

Three things hold at every step afterwards (all measured, not reasoned):

- Accept falls entirely inside the shell, entirely inside the viewport, and **a hit
  test at its centre point returns the button itself**;
- scrolled to the bottom, the last paragraph is fully visible (its bottom margin
  is **inside** the scroll region and is not eaten);
- while scrolling, Accept's rectangle **does not move by a pixel**.

Before the change at a 320px CSS viewport, the English Accept sat at 287..313 while
the shell ended at 288, and `elementFromPoint` at the button's centre returned the
shell rather than the button — **that is what "unreachable" looks like when
measured**.

### 4.3 The other three dialogs (measured while here)

Their copy varies with the row, the driver and the partition, so measuring one
piece of copy says nothing about the next; what was measured is the **structure**:
stuff 2,000px of content into each one's scroll region and see whether the control
that dialog exists for is still inside the shell.

| | fixed chrome height | slack at the floor viewport | control inside shell / hit |
|---|---|---|---|
| value expansion (head, no foot) | 32px | 288px | yes / yes |
| connection form (head + foot) | 74px | 246px | yes / yes |
| settings (head + foot + sidebar) | 74px | 246px | yes / yes |

All still hold pressed down to a 200px CSS viewport. **None is close**: their
fixed chrome adds up to 74px at most, leaving 246px below the 320px ceiling, and
the middle section scrolls to begin with. The settings dialog's category sidebar
scrolls on its own too (when the content genuinely does not fit; the probe measured
it as "does not scroll" the first time because the filler block was squashed by
flex, and it read "scrolls" once made incompressible — recorded here so the next
person does not tread on it again).

### 4.4 Assertions: eight plantings, eight reds for **their own** reasons

A new `context-actions/__tests__/consent-scroll.test.ts` (4 cases). It pins the
**shape**, and pins no padding, no dimension, and no class string that makes this
dialog look different.

Each planting was preceded by a `cp` backup, restored afterwards, with `sha256`
compared before and after (**no `git checkout` and no `git stash`** — the tree has
73+ uncommitted files):

| planting | which case went red |
|---|---|
| remove the scroll region (i.e. the shape before) | "the shell should hold exactly one scroll region" |
| move the last paragraph outside the scroll region | "every paragraph must be inside the scroll region" |
| move the action row into the scroll region | "neither answer may be inside it" |
| remove the action row's incompressibility | "the action row must refuse to be compressed" |
| remove `tabIndex` | "the scroll region must be reachable by keyboard" |
| `tabIndex={-1}` | as above, and naming "it must be 0" |
| stop the shell clipping | "does the premise still hold" |
| change the ceiling from `80vh` to `90vh` | as above, with the arithmetic for the 24px slack attached |

Eight reds out of eight, no false greens; after all eight restorations the sha256
matched the pre-planting value exactly.

### 4.5 Gates

- `pnpm typecheck` — 0
- `pnpm test` — all green (4 cases added this round)
- `pnpm build` — 0, with `audit-shipped-css` passing throughout
- **The build output's byte count and rule count are unchanged**: every class this
  change uses is already worn elsewhere, so the stylesheet gained not one rule and
  not one byte.

## 5. Two sentences for the next person

1. **This dialog's slack is 24px, not "enough".** One more sentence of copy, one
   more language, or one change of width spends it. Shape-wise it can no longer
   break, but if the body ever grows long enough that only two lines of the scroll
   region are left at the floor viewport, that is a **copy** problem rather than a
   layout one — and what to discuss then is the copy, not raising the ceiling
   again.
2. **When measuring, do not take the 720px ceiling for the floor.** The fifth
   audit's first group measured 294px and concluded "it fits", comparing against
   720px rather than the floor viewport's 320px. The number was right and the frame
   of reference was wrong.
