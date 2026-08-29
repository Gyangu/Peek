# Light and dark theme

**Status**: decided. Revises `PLAN.md` §2 and the "peek has one dark palette
only" wording at the head of `styles.css`.
**Motivation**: the user asked for a daytime and a night-time interface.

---

## 1. What this fixes

### 1.1 Where things stand

peek today has one dark palette, and dark is not "the current option" — it is
written into the product's identity:

| source | wording |
|---|---|
| `styles.css` file header | Dark theme at the compact density of a data tool |
| `renderer/packages/PackageFrame.tsx:56` | peek has one theme today |
| `packages/db-neo4j/ui/style.css:18` | peek ships one theme today — there is no `prefers-color-scheme` rule anywhere in the window's CSS |

### 1.2 But a second theme has been expected all along, so this is wiring, not building from nothing

Three places have kept room for it, and all three wrote down why in black and
white:

- **The `@theme` block's comment** (the `styles.css` §2.2 passage) argues against
  moving the tokens into a JS config, and one of its reasons is exactly that "a
  palette that no longer exists as custom properties cannot be re-pointed at
  runtime, **which is what a second theme would need**". Keeping the palette in
  custom properties was done for today all along.
- **The package-view protocol is already complete**:
  `packages/core/src/package-view-channel.ts` has `PackageTheme = 'light' |
  'dark'`, the `init` message carries a `theme` field, and there is a dedicated
  runtime switch message `{ t: 'theme' }`. On the frame side,
  `applyTheme()` at `db-neo4j/ui/main.ts:1495` is already implemented, and the
  canvas's colours are re-read from the CSS variables on every theme change.
- **The neo4j package UI's light palette is already written**
  (`style.css:85`, the whole `:root[data-theme='light']` block); the comment
  explains that it is derived, and "the day the window grows a light mode" is the
  day it has been waiting for.

The only thing genuinely missing is the host's end of it: `const THEME:
PackageTheme = 'dark'` at `PackageFrame.tsx:63`.

### 1.3 Boundary — what this does not do

- **No geometry changes.** Not one number in the four ladders — type sizes, line
  boxes, spacing, radii — changes. This swaps colours and nothing else.
- **No user-defined colour schemes.** Three options are three options.
- **`prefers-color-scheme` is not adopted as CSS's branching mechanism.**
  Reasoning in §3.1.
- **No value in the dark palette changes.** Dark is the baseline; after this
  change, any pixel that differs under dark is a bug. The single exception is
  §2.5's `--color-on-accent` — it splits apart a semantic coincidence that exists
  under dark too, and after the split dark's pixels are **unchanged**.
- **The neo4j package UI's light block is not rewritten.** It already exists and
  holds the same floors; this change wires it up and brings it into
  verification.

---

## 2. The plan

### 2.1 Where the three options live, and why they cannot follow locale

The repository already stores preferences two ways, and this change has to pick
a side:

| preference | stored where | why |
|---|---|---|
| `locale` | the renderer's `localStorage` | purely renderer-local; main does not need to know what language the window is drawn in (`i18n/store.ts`'s header comment) |
| `uiZoom` | `settings.json` | only main can call `webContents.setZoomFactor` |
| **`theme`** | **`settings.json`** | **same as `uiZoom`: main needs it** |

Three things main needs it for, none of which the renderer can do:

1. The `BrowserWindow`'s `backgroundColor` — hard-coded `'#141414'` today
   (`main/index.ts:725`). It decides what colour the window is before the
   renderer paints its first frame, and leaving it as it is under light mode
   means a flash of black at every launch.
2. `nativeTheme.themeSource` — the implementation of "follow the system" itself.
3. The traffic lights. The window is `titleBarStyle: 'hidden'`
   (`main/index.ts:723`), and the three red-yellow-green dots are drawn by the
   system according to `nativeTheme`, out of the renderer's reach.

So:

```ts
// settings.ts
theme?: 'dark' | 'light' | 'system'
```

**Absent = `'dark'`**, on the same principle as every other field in this file:
whoever has not chosen follows the default. The default is dark rather than
follow-the-system, for the reason in §3.4.

Main resolves the effective theme and broadcasts it to the renderer:

```
theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme
```

Main subscribes to `nativeTheme`'s `updated` event, so the window follows the
moment the user changes the system appearance, with no restart. On receiving it,
the renderer writes `document.documentElement.dataset.theme`.

### 2.2 The CSS layer: `@theme` untouched, one override block added

```css
@theme {              /* dark, not one value changed; it is also the default */
  --color-bg: #16181c;
  …
}

:root[data-theme='light'] {   /* base colours only */
  --color-bg: #f2f4f7;
  …
}
```

The override works because both selectors land on **the same element**, and
`[data-theme]` has the higher specificity. A utility class is `var(--color-*)`
to begin with, so every class already written follows in place and not one
component line changes.

**Derived tokens follow automatically; the light block does not have to rewrite
those 8 `color-mix()`.** A `var()` inside a custom property's value is resolved
**on the element that uses it**, and `:root` and `:root[data-theme='light']` are
the same element — so the `var(--color-accent-dim)` inside
`--color-primary-hover` picks up whichever value won the cascade, which is the
light one. This is where the plan saves the most work, and for exactly that
reason it is the one thing in §4 that must be **measured before anything else
proceeds**.

### 2.3 The light palette

The 30 base colours below were measured, not mixed until they looked pleasant —
every value was run by `theme-contrast.test.ts` against every floor that file
holds today (once per theme), with the results in §4.1.

```
bg        #f2f4f7   fg          #1c2026   accent        #0b5fbe
bg-1      #ffffff   fg-dim      #4a525c   accent-dim    #1b6ad2
bg-2      #ebeef2   fg-faint    #5c6570   ok            #0f7355
bg-3      #e7eaf0                         warn          #745007
bg-hover  #e4e8ee   border      #c6ccd6   err           #a8221e
bg-sel    #dbe8fc   border-strong #7b8592
bg-stripe #eceff3
                    danger-border #b5504c  code-keyword #8f3fbf
scrim     #1c202699 err-border    #e8bfbd  code-type    #0f6f78
                    err-bg        #fdf3f2  code-string  #3f6a17
on-accent #ffffff   warn-bg       #fdf7e8  code-number  #a54710
warn-ink  #fdf6e6   accent-bg     #eef4fd
                                           cell-bool    #8b3fb0
                                           cell-json    #11705a
```

The surface ladder runs in the opposite direction from dark's, which is the one
place that is intuitive: under dark, `bg → bg-1 → bg-2 → bg-3` gets lighter;
under light it gets darker. `bg-1` is still "the raised surface" (pure white),
and `bg` is still the desk.

The gap between layers is **slightly narrower** than dark's, which was forced by
the fourth item in §2.4 rather than chosen for looks. How far it may be narrowed
has a floor: `2026-08-04-tailwind-migration.md` §31.6 records what happened the
last time the hierarchy was flattened (the user's own words: "not nearly as
refined as before"), so this pass raised only the hover layer and did not flatten
the whole ladder.

The five `--shadow-*` need overriding too: dark's black at 45–73% is dirty on top
of a pale surface, so light uses a deep blue-grey in the same family at a low
alpha, with the offsets and blur radii untouched. In the contract they belong to
`DECORATIVE_ONLY` (they carry alpha, so contrast cannot be measured), so this one
rides on §4.3's manual step.

### 2.4 Four direction reversals — the whole of the difficulty is here

Light is not dark with the lightness inverted. In four places the **semantic
direction** is reversed under light, every one of them measured, none of them
visible to the eye:

**First, `--color-warn-ink`.** It is the text on the "external tool call" badge.
Under dark, `--color-warn` is a bright amber used as the **background**, so the
ink is near-black (`#2a2109`). Under light, warn is a deep amber, and the ink on
the same badge has to reverse into near-white (`#fdf6e6`). It is the only token
in the whole table whose semantic direction flips outright.

**Second, the 24% wash in `--color-row-sel` / `--color-rownum-sel`.** Under dark,
accent is lighter than the base, so a 24% wash **lifts** the row; under light,
accent is darker than the base, so the same 24% **pulls the row down**, and all
five of the grid's inks drop below 4.5 (measured 3.48–3.87). Under light it
comes down to 12%:

```css
--color-row-sel: color-mix(in srgb, var(--color-accent) 12%, var(--color-bg));
```

The original comment says this wash "is a change of hue, not of lightness" — that
sentence needs a smaller proportion to hold under light.

**Third, `--color-warn` itself.** It is both a text colour and the colour mixed
into `--color-caution-hover`'s background. Under dark the two run in opposite
directions (light text mixed into a dark background), so this was never exposed;
under light both are dark, and **the more you mix in, the lower the contrast**.
Raising the mix from 88% to 94% was tried, and it only climbed from 3.96 to 4.28,
which says the proportion is not the disease — `--color-warn` itself is not
enough on the hover layer. Settling warn at `#745007` fixed it, with **the mix
proportion left at 88%, the same as dark's**: changing the proportion would give
the two themes one more divergence to maintain, in exchange for the same number.

**Fourth, `--color-err` on `--color-danger-hover`, the only one of the four that
needs both ends to give.** It has the same shape as the third — the background of
a danger button on hover is `--color-bg-hover` mixed with 14% `--color-err`, and
the text pressed on top of it is `--color-err` **as well**. Driving the ink
darker does nothing, because the ink is an ingredient of the background: three
different err values all measured out at a ratio stuck at 4.26, immovable.

So this one only passed by raising the surface first and then adjusting the ink:
`--color-bg-hover` went from the first version's `#dbe0e8` up to `#e4e8ee`
(clearing, along the way, two other debts hanging on that layer), and
`--color-err` was then pushed down from `#c0322e` to `#a8221e`, for a final 4.53.
Flattening the whole ladder would also have passed, but that is the cost §31.6
recorded, and it was rejected.

"Mixing the ink into its own background" is the only structural problem to appear
twice in this pass. It exists under dark too (3.69, see `BELOW_FLOOR`), only
nobody had ever measured it — both themes tripping in the same place is one of
the real returns on adding a theme.

### 2.5 One more, but it is a split rather than a reversal: the text on a primary button

Under dark the primary button is a deep blue `--color-accent-dim` background with
`--color-fg` text. That works **purely by coincidence**: dark's `--color-fg`
happens to be light (`#d3d8de`). Under light, `--color-fg` is near-black and
unreadable on a deep blue background — and in the contract this is a pair
`SURFACES` measures explicitly.

So a new token:

```
--color-on-accent   dark  #d3d8de (= today's --color-fg, so dark's pixels do not change)
                    light #ffffff
```

In the control layer, `ui/spec.ts`'s primary variant changes its text colour from
`text-fg` to `text-on-accent`. This is the only place in this pass that touches a
component, and what it fixes is a problem of expression that exists under dark
too: what that position wants has never been "the foreground colour", it is "the
text pressed onto the accent".

### 2.6 Reworking the contract test

`theme-contrast.test.ts` (2300+ lines) had its entire structure built on "one
`@theme` block = the whole palette": `VARS` is a module-level singleton,
`contrast()` resolves from it, and `MEASURED` is a global Set. Adding a second
theme without touching it would make light **a set of colours with no guard at
all** — precisely the thing every comment paragraph in that file argues against.

The shape it landed in:

1. **Two palettes, with light derived by overlay.** `PALETTES.dark` is the
   `@theme` block, `PALETTES.light` is that with the override block laid on top —
   exactly what the browser does to `:root`. Because it is an overlay, the 8
   `color-mix()` resolve correctly without being rewritten in the override block.
2. **`inTheme(theme, fn)` switches the current palette**, and `colorOf` /
   `contrast` / `MEASURED` all switch with it. No parameter was added to those
   three: they have about eighty call sites in this file, and a parameter is
   eighty chances to pass the wrong one. The four groups — `text contrast`,
   `non-text contrast`, `SURFACES`, census — each run twice, with `[dark]` /
   `[light]` in the test name.
3. **The literal exemption widens from one block to two** (`THEME_BLOCKS` +
   `inPaletteBlock`), or else the sweep for "no colour literal may appear in any
   stylesheet" reports the entire light palette as a violation.
4. **`BELOW_FLOOR` is split per theme.** Dark's seven debts are kept as they are,
   with the numbers untouched — they are not being fixed here, and rearranging
   the product's appearance in passing is not a change. **Light's table is
   empty.**
5. **`SURFACES` is split per theme too.** This step only turned out to be
   necessary during implementation: the seven pairs dark owes on (the inks on
   primary-hover, danger-hover, bg-hover, bg-sel, row-sel, rownum-sel) **pass**
   under light, so they belong in light's `SURFACES`. Without this, three surface
   tokens under light are not touched by a single assertion — which is exactly
   where the census at the end of the file goes red, and it did.
6. **A new assertion that did not exist before: the two palettes must define the
   same key set** (`the two palettes define the same colours`). A token light
   forgets to define does not become undefined, it **silently falls back to the
   dark value** — a patch of dark left on a pale interface, resolving perfectly
   cleanly and judged sound by every assertion above. All the existing assertions
   only ask "does this value pass"; none asks "does this value exist". The
   exemption rule is a criterion rather than a list: a token whose value contains
   `var()` moves with the palette and need not be restated; one that does not is
   a fixed colour and must be.

`scripts/audit-shipped-css.mjs` (which reads the build output) passed as
expected, but one entry of its `TAILWIND_INTERNALS` exemption list **emptied out
as a result**: the reason given for exempting `--tw-ring-offset-color: #fff` was
"naming it in @theme would put a white into a palette that has none". Light's
`--color-bg-1` is white, so that premise no longer holds, and the script's own
staleness check reported it. See §4.2.

### 2.7 Package views (iframes)

The chain is already all there; only the host end has to be connected:

- `PackageFrame.tsx`'s `THEME` constant becomes the real theme, and `init`
  carries it; on a theme change, `post({ t: 'theme', theme })`. The frame side
  needs no line changed.
- The iframe element's own background colour (`PackageFrame.tsx:312` already
  handles the white-flash frame) follows the theme.
- The hard-coded `data-theme="dark"` on `db-neo4j/ui/index.html` is the first
  frame's default before `init` arrives. Leaving it means opening the graph view
  under light mode flashes dark for a moment — caught by the host giving the
  iframe a background colour matching the theme, and recorded here as one known
  frame.
- neo4j's light block itself is not rewritten; it goes into §4.3's manual
  verification.

### 2.8 UI and i18n

`AppearanceSection` gains a `Segmented` row, positioned between language and zoom
(language → theme → zoom, going from "what do I read" to "how does it look" to
"how big"). `en` / `zh-CN` each gain 4 keys: `settings.theme`,
`settings.themeHint`, and the labels for the three options.

---

## 3. Trade-offs

### 3.1 Why `prefers-color-scheme` is not CSS's branching mechanism

A media query cannot express "the user explicitly chose dark" — when the system
is light and the user wants dark, the rules inside `@media (prefers-color-scheme:
light)` still match. Fixing that means layering a `:root[data-theme]` override on
top inside the CSS anyway, and the result is two sources of truth for one fact.

Besides, main needs **the same answer** (the background colour, the traffic
lights), and main cannot read a media query. Having main resolve it to `'dark' |
'light'` and send it down, with the whole window and the iframe using that one
answer, is one source of truth instead of three. `prefers-color-scheme` appears in
exactly one place: main's read of `nativeTheme.shouldUseDarkColors`.

### 3.2 Why light is an override block rather than a second `@theme`

Tailwind v4 generates a utility's **class names** from `@theme`. A second
`@theme` would generate a second set of class names (`bg-bg-light` and the like),
which amounts to writing every component twice and testing the theme in every
condition. A utility's value is `var(--color-x)` to begin with, and overriding
the custom property is the only mechanism that lets **classes already written
follow in place**. This is precisely the reason that `@theme` comment gave when
it turned down a JS config.

### 3.3 Why `--color-on-accent` is a new token rather than lightening light's `accent-dim`

Lightening it would let `--color-fg` carry on being used, but
`--color-accent-dim` is **the primary button's solid background**, and a pale
blue background no longer carries the weight of "solid accent"; besides,
`--color-primary-active` is `accent-dim` mixed with black — if the background is
pale to begin with, the direction "pressing it makes it darker" stops meaning
anything. A semantic mismatch should be fixed semantically.

### 3.4 Why the default is dark rather than follow-the-system

peek's identity today is a dark data tool. Somebody already using it who upgrades
to this version should not suddenly get a white window because their system is
light — that is an appearance change nobody asked for. Anyone who wants to follow
the system picks it once, and the choice is remembered.

### 3.5 Why this was not the occasion to wrap an SDK around package UIs

This change is a natural experiment, and its conclusion argues against one:
wiring the theme into the package view needed **not one line changed on the frame
side**. The protocol has had a `theme` field and a `{ t: 'theme' }` message all
along, neo4j implemented `applyTheme()` itself, and the canvas re-reads the CSS
variables on every theme change — the host changed one constant and it worked. An
SDK would have saved nothing: a cross-cutting concern like the theme is solved by
**adding a field to the protocol**, not by a client library.

The genuinely repeated material is elsewhere: the first 216 lines of
`db-neo4j/ui/main.ts` — the port handshake (frame-last, MessagePort adoption),
the `asRecord` / `asString` / `asTheme` / `asStatus` group of structural checks,
`guard()`'s error reporting — are what every Tier C package has to write, and has
to write **correctly** (miss the "everything arriving on the port is untrusted
input" rule and one bad row of data is a blank panel). Only after those 216 lines
does neo4j's own graph begin. That is the candidate for an SDK; the theme is not.

The reason not to do it is N=1: abstracting for the only consumer there is would
only harden neo4j's incidental choices into an API. And its shape is hard-bounded
by the security boundary — the frame has no preload, its own origin,
`connect-src 'none'`, and a bundle that shares no chunk with the window — so it
cannot be an ordinary npm runtime dependency, only **inlinable zero-dependency
source** or a piece of scaffolding. **The trigger is the appearance of a second
Tier C package**: at that point which parts are genuinely common becomes
observable, and it is not observable now.

### 3.6 Why dark's seven debts were not fixed while we were here

All seven in `BELOW_FLOOR` carry a written-out fix. Fixing them means moving
`--color-fg-faint`, `--color-err` or that 24% wash, which is a visible change to
the product's appearance and should be its own change with its own document. This
pass adds a theme; adding a theme is all it adds.

One of them is worth recording separately: `--color-err` on
`--color-danger-hover` (3.69) and the same pair under light are **the same
structural problem** — mixing the ink into its own background. The light half was
fixed in §2.4 and the dark half is left, so the two themes now pass and fail at
the same position. The next time dark is fixed, light's solution (raise the
surface, push the ink darker) is a ready-made reference.

---

## 4. Verification

### 4.1 Measuring the light palette (done, reproduced by the tests)

Before this document was written, a throwaway script ran every floor
`theme-contrast.test.ts` holds against the candidate light palette: three text
weights × three background layers, the ≥1.5 gradient between weights, 4.5 for the
four semantic colours on `bg-1`, 3:1 for `border-strong` and `danger-border`, the
1.45–3 band for `border`, the whole `SURFACES` table, `warn-ink` on `warn`, and
the four code colours on a code block. The first round had 17 failures.

**That script was later shown to have miscalculated one pair** (`err` on
`danger-hover` reported 4.58, actually 3.73), so none of its conclusions count;
the final values were all settled one by one by the reworked test — which reads
the real `styles.css` and uses the nine lines of WCAG arithmetic in that file.
This is a live demonstration of the sentence at the head of that file:
*a number in a design document does not hold a line; a test does*.

Final state: **two themes, 43 tests, 0 failures.** Light's `BELOW_FLOOR` is an
empty table; dark owes 7 (kept as they are, see §3.6). Light's three tightest:
`err` on `danger-hover` at 4.53, `fg-faint` on `bg-hover` at 4.62, `err` on
`bg-hover` at 4.67.

### 4.2 Automated (all passing)

- ~~**Do this one first**: whether derived tokens really do recompute under the
  override block (§2.2).~~ **Measured, and it holds.** Measured with
  `getComputedStyle` on a minimal page inside Electron (not a browser — the
  renderer *is* Electron):

  ```
  dark  → --color-primary-hover: color-mix(in srgb, #2a5a95 78%, #4d9cff)
  light → --color-primary-hover: color-mix(in srgb, #1b6ad2 78%, #0b5fbe)
  ```

  The real pixels at the point of use change with it too (`srgb(0.195 0.410
  0.676)` → `srgb(0.092 0.406 0.806)`). A custom property's computed value keeps
  `color-mix()` in its unevaluated form, but the `var()` inside it has already
  been substituted with the post-override value, and evaluation happens at the
  point of use. So the light block writes base colours only, and not one of the 8
  `color-mix()` has to be rewritten.

- `theme-contrast.test.ts`: 43 passed / 0 failed, including the new key-set
  assertion.
- Whole-repository tests: 2507 passed / 0 failed.
- `pnpm build`: passes, including `audit-shipped-css.mjs` (the colour gate at the
  build-output layer) and `render-probe` (real Electron rendering plus
  pixel-by-pixel contrast measurement).
  - The only hand-work needed is the stale exemption noted at the end of §2.6:
    `TAILWIND_INTERNALS` empties to `[]`, with the reason written in place — not
    a tidy-up, but a fact it depended on having changed.
- `typecheck`: all green.

### 4.3 On the real machine (done, with the real app + CDP)

A real peek was launched (with an isolated `PEEK_CONFIG_DIR` and user-data-dir,
leaving the development machine's `~/.peek` alone), driven by the repository's own
`scripts/cdp.mjs`, switching through the options and screenshotting each:

| check | result |
|---|---|
| All three options take effect immediately, no restart | ✅ the `settings.write` receipt carries `theme` and `resolvedTheme`, and `data-theme` in the DOM keeps up |
| `system` resolves correctly | ✅ with `system` selected the machine's appearance was light, `resolvedTheme` came back `light`, and the window went pale with it |
| Derived tokens really did swap | ✅ `--color-bg` `#16181c` ↔ `#f2f4f7`, `--color-on-accent` `#d3d8de` ↔ `#fff`, `body` actually painted `rgb(22,24,28)` ↔ `rgb(242,244,247)` |
| The primary button is readable under light | ✅ deep blue background, white text — `--color-on-accent` working, which is exactly the failure §2.5's token split was meant to prevent |
| The new picker in settings | ✅ positioned between language and zoom; the three labels correct; the selected state follows after a switch, which says it is subscribed while the dialog is open too |
| No regression under dark | ✅ after switching back to dark, every reading is byte-for-byte identical to the initial one |
| The modal scrim, the sidebar's selected state, the status bar, panel borders | ✅ correct under both themes |

**One thing not verified on the real machine, recorded honestly**: that neo4j's
graph view (an iframe) follows a theme switch live. The code path is connected —
`PackageFrame` puts `theme` into `init` and posts `{ t: 'theme' }` on change, with
not a line changed on the frame side — but seeing it needs a real neo4j instance,
and there is none locally. Next time there is one, walk §2.7: open the graph view
→ switch theme → confirm the canvas repaints and does **not** reload (the layout
is not lost), and record whether opening that view under light shows a visible
dark flash on the first frame.

Two more could not be automated this time and are left for next: the first frame
of a cold start (launching under light must not flash black) needs an eye on the
launch moment; and the three traffic lights' colouring is drawn by the system
according to `nativeTheme`, which in a screenshot is the region outside the
window. Both depend only on main's three lines from §2.1, and are logically
already wired.
