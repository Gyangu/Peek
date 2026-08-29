# The renderer moves to Tailwind v4

**Status**: decided. Overturns the original conclusions of PLAN §2 and `2026-08-02-control-spec.md` §3.1.
**Motive**: a technical experiment. Not a fix for a known defect — the existing CSS layer is not broken, and that belongs at the very top.

---

## 1. What this fixes

### 1.1 Not a problem to fix — a different foundation

To be honest about it: this change is **not bug-driven**. What exists today is 8
hand-written stylesheets, 4517 lines, 351 class names, plus three contract tests
pinning the type-size floor, the contrast floor and the className fence around
the control layer. It works.

What the user wants is to feel out Tailwind v4 on a real project — CSS-first
configuration, `@theme` tokens, what atomic classes actually read and write like
across 10k lines of TSX. That is a legitimate goal and the document records it
as such, because whoever reads this a year from now needs to know: this change
**cannot be explained by "the old approach had a problem"**.

### 1.2 The conflicts with existing documents, and how they were settled

Two places say no in writing:

| Source | Text |
|---|---|
| `PLAN.md` §2 tech-stack table | Controls: hand-rolled `renderer/ui/`, zero dependencies (**no shadcn / Radix / Tailwind**) |
| `2026-08-02-control-spec.md` §3.1 | "Atomic classes like Tailwind's would scatter every decision in this document out of CSS and into JSX — exactly the opposite of what this is meant to fix" |

The conflict was laid out for the user before any code was touched, and the user
confirmed taking the Tailwind side. **The argument in §3.1 was never refuted**;
it is still correct: decisions really do move out of CSS and into JSX. Section 4
sets out what holds the cost down to something acceptable, and which part of the
cost is simply accepted.

### 1.3 Boundaries — what this does not do

- **main / preload are untouched.** Only `apps/desktop/src/renderer/`.
- **The database package UI is untouched** (`packages/db-neo4j/ui/style.css`,
  440 lines). It is a separate build output, isolated in an iframe, with its own
  CSP; folding it in would only widen the failure surface of this change.
  See `2026-08-03-plugin-architecture.md`.
- **No shadcn / Radix / CVA / tailwind-variants.** What §3.1 concluded about
  those three has nothing to do with Tailwind and still holds: the density does
  not match, the focus models fight, and the 40 lines of `as const` in `spec.ts`
  already finish the variant mapping. This swaps the style engine only, not the
  architecture of the control layer.
- **Pixel-level parity is not the goal**, but **a verifiable absence of
  regression is**: the three contract tests must survive at equivalent strength,
  which is the whole of Section 3.
- **`<Button>` / `<Segmented>` / `<Menu>` are not deleted.** The control layer
  remains the single choke point; only its variants change, from rules in
  `controls.css` to strings of atomic classes in `spec.ts`.

---

## 2. The plan

### 2.1 Tailwind v4, CSS-first, no `tailwind.config.js`

```
apps/desktop/package.json     + @tailwindcss/vite, tailwindcss
electron.vite.config.ts       renderer.plugins: [react(), tailwindcss()]
renderer/theme.css            new: @import "tailwindcss" + @theme
renderer/styles.css           kept: base/reset/@layer base, slimmed down over time
```

v4 needs no PostCSS configuration and no `content` scan configuration —
`@tailwindcss/vite` takes that over itself. This is one of the main reasons for
picking v4 over v3: an order of magnitude less configuration surface, so the
experiment has a better signal-to-noise ratio.

### 2.2 The token layer: `:root` moves into `@theme`, and **the default palette is turned off**

This is the most important step in the whole plan; it decides whether the design
system still exists once the migration is done.

```css
/* renderer/theme.css */
@import "tailwindcss";

@theme {
  /* Clear Tailwind's own namespaces first — this line is the fulcrum of the plan */
  --color-*: initial;
  --text-*: initial;
  --font-*: initial;

  /* Layered backgrounds; the higher the layer, the lighter */
  --color-bg:        #16181c;
  --color-bg-1:      #1b1e23;
  --color-bg-2:      #21252b;
  --color-bg-3:      #292e35;
  --color-bg-hover:  #2d333b;
  --color-bg-sel:    #16324f;

  --color-fg:        #d3d8de;
  --color-fg-dim:    #a8b0ba;
  --color-fg-faint:  #858d97;

  --color-border:        #333941;
  --color-border-strong: #666f79;

  --color-accent:     #4d9cff;
  --color-accent-dim: #2a5a95;
  --color-ok:         #4ec9a0;
  --color-warn:       #e0b341;
  --color-err:        #f0736f;

  --color-danger-border: #b25e59;
  --color-err-border:    #5c2f2f;
  --color-err-bg:        #2a1c1c;

  /* Type: the same five steps, renamed from --fs-* into Tailwind's --text-* namespace */
  --text-sm:   11px;
  --text-md:   12px;
  --text-lg:   13px;
  --text-data: 11.5px;
  --text-mark: 10px;

  --font-ui:   -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI',
               'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;

  /* Geometry: into the --spacing-* namespace, which is what makes utilities like h-row / w-gutter exist */
  --spacing-row:   24px;
  --spacing-head:  26px;
  --spacing-bar:   30px;
  --spacing-gutter: 54px;
  --spacing-form-label: 88px;
  --spacing-hit:   24px;
}
```

After `--color-*: initial`, `bg-red-500`, `text-gray-400` and `text-base`
**no longer exist**; writing one gives you a dead class that generates no CSS.
The palette becomes a finite, auditable closed set again — which is precisely
what lets `theme-contrast.test.ts` keep working, and the main lever holding down
the cost named in §3.1.

Likewise `--text-*: initial` makes `text-xs` (12px) disappear and redefines
`text-sm` as 11px. The type scale still has only five steps, and **the floor is
still pinned by a test**.

The old names — `--fs-*`, `--row-h` and the rest — are all retired with no
aliases kept: keeping an alias means keeping two sources of truth, and two
sources of truth are exactly the loss already taken once in the `--form-label-w`
comment (styles.css:105-120).

### 2.3 The control layer: the `controls.css` matrix moves into `spec.ts`

Today `<Button>` assembles `btn btn-danger btn-md`, and each of those three class
names has a rule in `controls.css`. After the migration `spec.ts` hands out the
atomic-class string directly:

```ts
export const BUTTON_VARIANTS = {
  danger: {
    intent: '…',           // kept, not one word changed
    rule: '…',             // kept
    classes:
      'bg-bg-2 border-danger-border text-err ' +
      'hover:not-disabled:bg-err-bg hover:not-disabled:border-err ' +
      'active:not-disabled:bg-bg-1',
  },
  …
}
```

`spec.ts` is still the single source of truth; `intent` / `rule` / `EXPOSURES` /
`ACTION_ID_PATTERN` are all kept as they are — they have nothing to do with the
style engine. The only thing that changes is what a variant maps to: from
"→ one class name, with the rule in CSS" to "→ a string of atomic classes".

**The five-state completeness contract cannot be lost.** Today
`control-spec.test.ts` asserts by finding selectors like
`.btn-danger:hover:not(:disabled)` in `controls.css`; after the migration it
asserts instead that each variant's `classes` string contains declarations
prefixed `hover:` and `active:`, and that `disabled:` and `focus-visible:` each
appear once in the base `.btn` string. Equivalent strength, read a different way.

`MENU_TONES` for `Menu` and `CONTROL_SIZES` for `Segmented` are handled the same
way.

### 2.4 styles.css splits by module first, then migrates in parallel

This is the prerequisite that makes the parallel work safe, and it must be
**finished serially** before any fan-out.

The 2133 lines of `styles.css` cover selectors for nearly every module. Six
agents editing it at once is a six-way write conflict. So step 0 splits it
mechanically into:

```
renderer/theme.css              @theme (2.2)
renderer/base.css               reset / html,body / scrollbars / element-level rules in @layer base
renderer/components/app.css     App / Panel / PanelTabs / Sidebar / StatusBar / Toasts / every dialog
renderer/components/grid.css    DataGrid / GridScrollbar / tables and virtual scrolling
renderer/components/views.css   the six views under views/
renderer/components/settings.css
```

The split itself **changes not one byte of a declaration**; it is only a move.
Once moved, `pnpm test` must be all green — the three contract tests all scan
the directory recursively (`stylesheets()` in `sourceScan.ts`), so splitting
files is transparent to them.

After the split, each parallel agent owns one CSS file plus one group of
components, and the file sets are disjoint.

### 2.5 Migration order

The two systems coexist, modules switch over one at a time, and a CSS file is
deleted only once it is empty.

| Stage | Contents | Parallel |
|---|---|---|
| 0 | Install deps, write `theme.css`, wire up the vite plugin, split `styles.css`, rewrite the three tests | Serial, one agent |
| 1 | `ui/` — Button / Segmented / Menu + the `classes` field in `spec.ts` | Serial, straight after Stage 0 (every module depends on `.btn`) |
| 2 | chat / grid / views / app / settings + context-actions + error-center | **Parallel, 5 agents** |
| 3 | Delete emptied files, `pnpm typecheck`, `pnpm test`, run the Gallery screenshots | Serial |

The five agents in Stage 2 each touch only their own CSS file and their own
batch of `.tsx`, with no overlap.

---

## 3. How the three contract tests survive

**This section is the main reason this document exists.** The real risk of the
migration is not styles drifting — that is visible; it is that three lower
bounds already pinned by tests turn into empty assertions along the way, while
CI stays entirely green.

### 3.1 `theme-contrast.test.ts` — the smallest change

Today it reads the `:root` block of `styles.css` and computes WCAG 2.1 relative
luminance. After the migration it reads the `@theme` block of `theme.css`, with
`--color-` prefixed onto the variable names. **The nine-line luminance formula
does not change by one character**, and the number of asserted pairs and the
ratio thresholds (4.5 / 3.0 / 1.45) all stay as they are.

There is a further existing assertion that scans every stylesheet for literal
colours (the lesson from `#7a3f3f`). It has to expand to **scan JSX as well**:
in the atomic-class era, the way to bypass a token is `bg-[#7a3f3f]`, not a
declaration line in CSS. Arbitrary-value syntax `[...]` is banned outright for
colours and font sizes, and the test simply looks for the `-[` substring.

### 3.2 `type-scale.test.ts` — swap the scan surface

Today it scans the `font-size:` declarations in the stylesheets, enforces the
11px lower bound, and carries one `assert.ok(out.length > 40)` to keep the
scanner itself from failing silently.

After the migration the `font-size` count in CSS approaches zero, so that
`> 40` is the first thing to break — **which is good, it is designed precisely
to shout when the scan surface stops working**. The new version splits in two:

1. **The ladder itself**: read `--text-*` from `@theme`, assert `sm === 11`,
   `sm < md < lg`, `data >= sm`, `mark >= 10 && mark < sm`. One-for-one with
   today.
2. **Usage**: recursively scan `.tsx` and collect every `text-*` class. The
   legal set is only the five (`text-sm|md|lg|data|mark`) plus the colour
   classes (`text-fg` and friends, a different namespace). Any arbitrary value
   of the `text-[13px]` shape fails outright; the cap on `text-mark` usage is
   still 4. The guard assertion changes from `> 40` to "no fewer than 40
   `text-*` class hits" — the same alarm for a dead scanner.

The inline `fontSize` ban is **kept exactly as is**, not one line changed.

### 3.3 `control-spec.test.ts` §4's className fence — gets cleaner instead

Today's method: take the `x` in `<Button className="x">`, look it up across
every stylesheet to see which properties it declares, and error if any is not in
`LAYOUT_ONLY_PROPERTIES`. This method has a known hole — **when the class name
is in no stylesheet at all, `owners.get(name)` returns `undefined` and the check
passes silently**.

In the atomic-class era there is no table to look up: a class name's prefix
**is** its property family. It becomes a pure-function classifier:

```ts
// Allow: placing the control within its container
/^(absolute|relative|fixed|sticky|inset-|top-|right-|bottom-|left-|z-|
   m[xytrbl]?-|flex-|grow|shrink|basis-|self-|justify-self-|order-|
   col-|row-|translate-|invisible|w-|max-w-|min-w-)/

// Reject: anything that paints, strokes, sets type, or sets a size
/^(bg-|text-|border|rounded|p[xytrbl]?-|h-|max-h-|min-h-|shadow|opacity|font-|ring)/
```

An unknown prefix is **rejected by default**, which is exactly the patch for
today's "not found, so let it through" hole. The fence comes out stricter than
before the migration, not looser — one of the few genuine net gains here, worth
a note of its own.

### 3.4 One new test: atomic classes may not bypass a token

One new test beyond the three old ones, because atomic classes open a back door
that did not exist in the CSS era: arbitrary-value syntax.

```
Banned (all renderer/**/*.tsx):  bg-[…]  text-[…]  border-[…]  w-[…]  h-[…]
```

`--color-*: initial` already turns `bg-red-500` into a dead class (no CSS
generated, visibly broken, found quickly), but `bg-[#f00]` **does take effect**,
and is completely invisible to `theme-contrast.test.ts`. It is the `#7a3f3f`
story's equivalent under the new system, so it gets blocked before it shows up
at all.

---

## 4. Trade-offs

### 4.1 §3.1's objection was not refuted, it was priced

"Decisions scatter out of CSS and into JSX" — that sentence still holds after
the migration. A variant's five states go from 20 consecutive lines in
`controls.css` to one long string in `spec.ts`; a panel's layout goes from one
named rule to a run of classes in JSX. **At any single point, readability
drops.**

It is accepted this time, because:

- The funnel point has not moved. `spec.ts` is still the single source of truth,
  `<Button>` is still the single entry point, and the 87 call sites still have
  no other way through. What §3.1 actually worried about — "adding a library
  will not make 87 call sites funnel themselves" — does not apply here: the
  funnelling is done by `<Button>`, and has nothing to do with the style engine.
- The vocabulary is closed (2.2's `--color-*: initial`). What scatters into JSX
  is **decisions**, not **degrees of freedom**.
- All three lower bounds survive in an equivalent or stronger form (Section 3).

**The part that is not accepted has to be said plainly**: the named class
`.panel-header` carries a layer of meaning; `flex h-head items-center border-b
border-border` does not. After the migration that meaning is carried by
component names, and component names are coarser-grained than class names. This
is a net loss, with nothing hedging it.

### 4.2 Why old variable names such as `--fs-*` are not kept as aliases

It saves one global replace and buys two sources of truth. What the comment on
`--form-label-w` records is exactly this: "four literals spread over sixty
lines, and the change only reached three of them" — an alias is a stealthier
version of the same mistake. Change it clean, once.

### 4.3 Why `@apply` is not used to carry the existing class names over wholesale

`@apply` could make `.panel-header { @apply flex h-head … }` "finish the
migration" overnight, but what that yields is a named-class system written in
Tailwind syntax and otherwise identical to today's — **every bit of information
the experiment would produce is cancelled out**. Tailwind's own documentation
positions `@apply` as an escape hatch for third-party HTML you do not control.

Exception: the element-level rules in `@layer base` (`html` / `body` /
`::-webkit-scrollbar` / the `.cm-*` overrides for CodeMirror) stay plain CSS.
They have no JSX mount point of their own, and forcing them into atomic classes
would mean first inventing a pile of wrappers whose only job is to carry class
names.

### 4.4 Why the database package UI is not migrated along the way

`packages/db-neo4j/ui/` is a separate build output, produced by a separate UI
build script (folded into `build-packages.mjs` today), and constrained by its
own CSP inside an iframe. Pulling it in would widen this change's failure
surface from "main-window styling" to "package UI protocol + build script +
CSP", while the experimental information it can supply overlaps heavily with the
main renderer's. Leave it where it is, and decide on it separately later.

### 4.5 Why Stage 0 and Stage 1 are not done in parallel

The token names in `theme.css` and the class strings in `spec.ts` are inputs to
every module that follows. Running them in parallel with the module migration
means five agents each guessing at what the tokens are called. Two serial steps,
then fan out.

---

## 5. Verification

### 5.1 What must be green

```bash
pnpm typecheck && pnpm test
```

`pnpm test` covers `src/renderer/**/__tests__/*.test.ts` — the three rewritten
tests from Section 3 plus the new arbitrary-value ban. **Any one of them turning
into an empty assertion after the rewrite means this migration failed**, and the
criterion is: deliberately change `--color-fg-faint` in `theme.css` to
`#5a626c` (the historical 2.49:1 value), and `theme-contrast.test.ts` must go
red. Likewise change some `text-sm` to `text-[9px]`, and `type-scale.test.ts`
must go red. **Both inverse checks are to be actually run**, not reasoned about.

### 5.2 What must be looked at

`Gallery.tsx` renders every variant × state × size, at the bottom of the About
section of the settings dialog in a dev build. Screenshot and compare
immediately after migrating `ui/` — it is the only means of proving the five
states were not silently lost, and `ui/CLAUDE.md` already spells it out: "even
if you are an agent, a screenshot is the only way you get to see what you
wrote".

### 5.3 What should be measured

Build output size. PLAN §8 has a performance red line, and renderer CSS is
currently 57,917 → 32,185 B (after minify). Tailwind's output should be smaller
(it only generates the classes in use), but `@theme` writes every token into the
build output as a CSS variable. Re-measure after the migration and update the
table in PLAN §8. If the renderer index chunk goes further past 500KB, record it
here, do not stay silent.

**Measured once the migration was done (end of Stage 3, `pnpm build`)**:

| build output (after minify) | before | after | delta |
|---|---|---|---|
| renderer CSS | 40,794 B | **43,393 B** | +2,599 B (+6.4%) |
| renderer index chunk | 606,500 B | **619,683 B** | +13,183 B (+2.2%) |

The renderer SqlEditor chunk is CodeMirror; not one byte of it was touched this
time, measured at **433,873 B**.

"Before" is the two numbers Stage 0 measured **on the same tree** (§6.6), not
the 32,185 B at the top of this section — that one is a snapshot from when M6
closed, CSS has grown on its own since, and using it as the baseline would
charge someone else's account to this change. Likewise the table in the MINIFY
comment in `electron.vite.config.ts` is M6's; it is only there to argue that
"minification is worth turning on", not as a current size.

**The bet was lost, so write it down**: §5.3 as originally written expected that
"Tailwind's output should be smaller (it only generates the classes in use)".
It is not. Hand-written CSS fell from 4,517 lines to 2,282 (including
`theme.css`'s 365), and the build output grew by 2.6 kB instead. The reason is
that atomic classes do not share: `.px-6` and `.px-2` are two complete rules,
whereas in a hand-written rule `padding: 0 24px` appears exactly once; add to
that the `@property` registrations `@layer properties` emits, the whole
`@theme` token table, and the token rename that made every `var()` six
characters longer. **At peek's density, the build-output cost of atomic classes
is higher than that of the hand-written CSS it replaces.** That is the cleanest
quantifiable conclusion this experiment produced.

One thing measured along the way: the compression ratio of the CSS fell from
−44% to **−31%** (62,506 → 43,393 B). Utility classes have little whitespace or
repetition left to squeeze out — the other face of the point above.

The renderer index chunk at 619,683 B is still above Vite's 500 kB warning line.
Stage 0 recorded that it was already 606,500 B before the migration, so that
line was not crossed here; this change added 13 kB to it, which is the class
strings in JSX plus `spec.ts`. Recorded here as §5.3 requires, not silently.

### 5.4 The manual walkthrough list

The places the contract tests cannot reach, and that carry the most risk here:

- **DataGrid virtual scrolling**: `vscroll.ts` depends on an exact row height
  (`--row-h` → `--spacing-row`). One pixel off and the scroll position of a
  million-row result set drifts cumulatively. Open a big table and scroll to the
  bottom.
- **PanelTabs dragging**: `dragMachine.ts` / `DropZoneOverlay` carry stacking
  assumptions about transform and z-index. Tear a tab out.
- **zh-CN**: the 11px lower bound was set for PingFang. Switch to Chinese and
  look at the settings panel and the status bar.
- **The focus ring**: `focus-visible` is the one of the five states most easily
  lost in a migration, and losing it does not show. Tab through the main
  interface with the keyboard.
- **ConfirmPair / permission prompts**: the visual distinction between `danger`
  and `caution` (solid `--err` vs dashed `--warn`) is a semantic difference §3.6
  deliberately preserved, and must not be merged during the migration.

---

## 6. Where Stage 0's actual landing diverged from the document

This section was **backfilled after the change was made**. It records what only
surfaced once we started: the places the sections above missed or got wrong. The
five agents that follow take this section as authoritative.

### 6.1 The token rename happens once, in Stage 0

§4.2 says "no alias period, rename cleanly in one pass", but it never says which
step the global replacement belongs to. The answer can only be Stage 0: once
`styles.css` is split, the old names `--fg` / `--fs-sm` / `--row-h` no longer
have anything defining them (the whole `:root` block became `theme.css`'s
`@theme`), and leaving them in place is a window where nothing runs. So Stage 0
also replaced all 30 tokens with their new names across **every** renderer
`.css` / `.tsx`, including `chat.css`, `context-actions.css`, `ui/*.css`, and
the 30 inline values of the form `style={{ color: 'var(--fg-faint)' }}`.

This is a pure rename: **not one declaration changed meaning**. It was done with
a regex carrying a `(?![-\w])` lookahead, so `--bg` does not swallow `--bg-1`,
and `--bg-elevated` (a name that was never defined in the first place and only
ever appeared as a fallback) is left as-is.

The mapping (**the five agents below use this table directly**):

| Old | New | | Old | New |
|---|---|---|---|---|
| `--bg` | `--color-bg` | | `--fs-sm` | `--text-sm` |
| `--bg-1` | `--color-bg-1` | | `--fs-md` | `--text-md` |
| `--bg-2` | `--color-bg-2` | | `--fs-lg` | `--text-lg` |
| `--bg-3` | `--color-bg-3` | | `--fs-data` | `--text-data` |
| `--bg-hover` | `--color-bg-hover` | | `--fs-mark` | `--text-mark` |
| `--bg-sel` | `--color-bg-sel` | | `--row-h` | `--spacing-row` |
| `--fg` | `--color-fg` | | `--head-h` | `--spacing-head` |
| `--fg-dim` | `--color-fg-dim` | | `--bar-h` | `--spacing-bar` |
| `--fg-faint` | `--color-fg-faint` | | `--gutter-w` | `--spacing-gutter` |
| `--border` | `--color-border` | | `--form-label-w` | `--spacing-form-label` |
| `--border-strong` | `--color-border-strong` | | `--hit-min` | `--spacing-hit` |
| `--accent` | `--color-accent` | | `--font-ui` | `--font-ui` (unchanged) |
| `--accent-dim` | `--color-accent-dim` | | `--font-mono` | `--font-mono` (unchanged) |
| `--ok` / `--warn` / `--err` | `--color-ok` / `--color-warn` / `--color-err` | | | |
| `--danger-border` | `--color-danger-border` | | | |
| `--err-border` / `--err-bg` | `--color-err-border` / `--color-err-bg` | | | |

### 6.2 Preflight is not brought in

§2.2 writes `@import "tailwindcss"`, and that one line pulls in theme, utilities
and **Preflight** together. Preflight was never discussed anywhere in this
document, and it is not neutral:

```css
ol, ul, menu { list-style: none }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit }
```

Our rules are unlayered, so every property we **do** write wins; the problem is
the ones we don't — `.md-list` only sets margin and padding and relies on the
browser default for its bullets, and `.ctx-consent-title` is an `<h2>`. Copying
§2.2's line verbatim means every markdown list loses its bullets and the consent
dialog's title gets flattened, silently — running straight into §1.3, "not
pixel-perfect parity, but a verifiable absence of regression".

Besides, peek already has a reset of its own (today's `base.css`), and every
line in it carries the reason it exists. Two resets are two sources of truth —
the thing this whole document argues against. So the import became theme and
utilities only:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
```

Width-only utilities like `border-b` do **not** depend on Preflight's
`*{border:0 solid}`: `--tw-border-style` is registered by `@layer properties`
via `@property`, with an initial-value of `solid`. This one was checked against
the build output, not inferred.

### 6.3 `@source` fences the scan surface

§2.1 says v4 "needs no content scanning configuration". It doesn't need one, but
the default auto-detection scans the entire package: in practice it pulled
`ms-30000` out of a timeout constant and `bg-bg-2` out of a string in
`control-spec.test.ts`, and generated real CSS for both. A class name only ever
mentioned by a test is not a class name in the product. So `theme.css` gained
three lines that pin the scan surface to `src/renderer/` and exclude
`__tests__/`.

### 6.4 §3.2's guard becomes the sum of two scan surfaces

§3.2 proposed replacing `assert.ok(out.length > 40)` with "no fewer than 40
`text-*` class hits". That number is **0** at the end of both Stage 0 and Stage
1 — written literally, the assertion is red from the moment it lands, so it gets
commented out, so it watches nothing during exactly the stretch of the migration
most likely to lose a size rung.

What was actually implemented is **the sum of two surfaces**: the number of
`font-size:` declarations in the stylesheets plus the number of `text-*` class
hits in `.tsx`, ≥ 40. Through the migration the weight moves from the former to
the latter and the sum stays non-zero; if the scanner ever breaks it still fires
immediately, which is the entire job of this assertion. The rest of §3.2 (the
ladder assertion, the five legal values, `text-mark` ≤ 4, the inline `fontSize`
ban) is unchanged, word for word.

### 6.5 §3.3's fence keeps a `CLASSNAME_LEDGER`

§3.3 says "in the atomic-class era there is no table to look things up in". True,
but Stage 0 is not that era yet: today there are 5 named classes
(`sidebar-handle` / `tab-close` / `chat-rail-handle` / `chat-jump` / `md-copy`)
passed to `<Button>`, and not one of them matches an atomic-class prefix. A pure
prefix classifier would flag all five red in Stage 0.

So the fence is: the prefix classifier plus a `CLASSNAME_LEDGER` that only ever
shrinks. Classes on the list still go through the old path — look up the
stylesheet, compare against `LAYOUT_ONLY_PROPERTIES`; **any unknown prefix not
on the list is rejected outright**, so the hole §3.3 wants plugged stays
plugged. In Stage 2 each module deletes its own entries as it migrates, and once
the list is empty the classifier is exactly the pure function §3.3 describes —
another assertion forces the list's deletion once it is empty.

The very first run of this fence caught a real one: `AttachmentBar.tsx` passes
`className="chat-chip-x"` to `<Button>`, and that class's rules were absorbed
when the `size="sm"` rung landed — it **exists in no stylesheet at all**. It is
precisely an instance of the hole §3.3 describes, found in the same commit that
plugs the hole.

### 6.6 Build-output size (§5.3 measured)

After `--color-*: initial` no default palette reaches the build output
(`--color-red-500` appears 0 times).

| | Before migration | After Stage 0 |
|---|---|---|
| renderer CSS (minified) | 40,794 B | 49,833 B |
| renderer index chunk | 606.50 kB | 606.50 kB |

The 32,185 B recorded in §5.3 is an older number; the CSS has grown on its own
since. The extra ~9 kB is `@layer properties` + `@layer theme` + the generated
utilities, plus the token rename making every `var()` 6 characters longer. Not
one line of hand-written CSS has been deleted yet; this must be re-measured
after Stages 2 and 3 empty those files.

The renderer index chunk at 606.50 kB is over Vite's 500 kB warning line, but
**this change did not touch it** (identical before and after), so it is not this
change's debt. Recorded here as §5.3 requires, not silently.

---

## 7. Where Stage 1 (the control layer) diverged from the document

Also **backfilled after the change**. §2.3 only wrote "variant → a string of
atomic classes"; the four items below surfaced only in the doing, and Stage 2's
five agents take this section as authoritative.

### 7.1 `base.css`'s `button` rules must go into `@layer base`

§2.3 says the control layer moves out of `controls.css` and into `spec.ts`; it
does not say what happens to the bare `button` element rule in `base.css` after
the move. The answer: **it wins**, and the whole control layer stops working.

In the cascade, **unlayered declarations beat any `@layer`**, regardless of
selector specificity. In the `controls.css` era this didn't matter — `.btn-ghost`
(0,1,0) out-specifies `button` (0,0,1), and the two talk as peers. Atomic
classes are not that: `bg-transparent` lives in `@layer utilities`, while
`base.css` is unlayered in its entirety, so the unlayered
`button { background: var(--color-bg-2) }` beats it and every ghost button in
the window goes back to grey. Same for `padding` / `border` / `min-height`: four
of the five variants would have their `border-color` eaten.

Measured in Electron's own Chromium, not inferred: an unlayered rule beats a
utility class, and the same rule wrapped in `@layer base` loses to it.

So the four `button*` blocks in `base.css` (including `button.primary` /
`button.ghost`) were wrapped in `@layer base`. **Only those four**; the rest
stays unlayered: putting the whole file in a layer would make
`.layout-root .grid-wrap:focus-visible` lose to the unlayered
`.grid-wrap { outline: none }` in `components/grid.css` — the exact focus ring
whose reason for existing is written in that comment in `base.css`, gone the
moment it enters a layer. `input` / `select` / `textarea` stay unlayered and get
the same treatment when the form module migrates; the file says so in as many
words.

Once layered, `button{}` means something different, and it means the right
thing: it is now the **floor for elements nothing else claims** (the menu items,
disclosures and tabs in NOT_CONTROLS, plus the TreeView still on the ledger),
while `<Button>` writes its geometry out in full in `spec.ts` and lifts itself
off that floor.

`font: inherit` and `color: inherit` do **not** move into the spec: what they
correct is a browser default (a button's built-in 13.33px system font), which is
`base.css`'s job; and `font: inherit` has to keep inheriting — an 11px button in
the status bar should be 11px. There is no `font-inherit` utility class, and
there shouldn't be.

### 7.2 No two classes from the same family in one control's class string

This is a capability atomic classes lose relative to CSS, and they lose it
silently: the order class names are written in inside JSX **does not participate
in the cascade** — whether `bg-bg-2` or `bg-bg-3` wins depends on which rule
Tailwind emits last.

Measured, not assumed: Tailwind emits `border-accent` **before**
`border-border-strong`, and `p-0` **before** `px-2.25`. So translating the
CSS-era spelling literally produces two real bugs:

- `.seg-on` layered over `.seg-item` → the selected item wears the **unselected**
  border color;
- `.btn-icon { padding: 0 }` layered over `.btn-md` → icon buttons keep 9px of
  horizontal padding and turn into rectangles.

The countermeasure is structural, not ordering-based:

| Conflict | What was done |
|---|---|
| `elevated` overriding a variant's background | variants split into `classes` (border/text) + `surface` (three background states); `elevated` **replaces** `surface` wholesale |
| selected vs. unselected segmented control | `SEGMENTED.item` carries no color at all; `on` / `off`, one or the other |
| icon shape vs. text shape | each `CONTROL_SIZES` rung gives **complete** `classes` and `iconClasses` shapes; no `p-0` layered on |

`control-spec.test.ts` turns this into an assertion: **exactly one** `bg-*` per
variant per state, and `SEGMENTED.item` may not contain `bg-` or
`border-<color>`.

### 7.3 The 9 new tokens, and one rounding

`color-mix()` does not fit into a utility class (`bg-[color-mix(…)]` is an
arbitrary value, expressly banned by §3.4), so the six mixes inlined in
`controls.css` all became named tokens in `@theme` — which is exactly what §3.4
wants: the derived colors you cannot avoid end up somewhere
`theme-contrast.test.ts` can see them.

| token | value | why |
|---|---|---|
| `--color-primary-hover` / `-active` | the two mixes from `.btn-primary` | the segmented control's selected item uses these two as well |
| `--color-danger-hover` / `-active` | the two mixes from `.btn-danger` | |
| `--color-caution-hover` / `-active` | the two mixes from `.btn-caution` | |
| `--spacing-control-sm` | 20px | the `sm` rung's height, used in four places; writing `h-5` hides a rung inside a multiple of 4 |
| `--shadow-elevated` | `0 2px 10px rgb(0 0 0 / 45%)` | Tailwind's built-in `--shadow-*` are tuned for light interfaces; `shadow-lg`'s 0.1 alpha is invisible on `--color-bg-1` |
| `--shadow-menu` | `0 12px 32px #000b` | same |

`default` and `ghost` need no derived colors: they move between
`--color-bg-hover` and `--color-bg-1`, both existing layers.

**One rounding, stated openly**: `.menu-head`'s `letter-spacing: 0.04em` becomes
`tracking-wider` (0.05em). On an 11px uppercase label, 0.01em ≈ 0.11px per
character, invisible; the only argument for minting a token for that number
would be "it used to be that number". `.gal-row`'s 5px corner radius goes to
`rounded-sm` (4px) on the same grounds, and it is dev-only.

### 7.4 Two tests found to be empty assertions on the spot, and fixed

Neither was introduced by this change, but both went dead at exactly the moment
this change needed them most:

1. **`theme-contrast.test.ts`'s arbitrary-value scan over `ui/spec.ts` used
   `blankNonCode`**, which also blanks string **contents** — and string contents
   are precisely the one place an arbitrary value can hide. Measured: put a real
   `border-[#7a3f3f]` into `spec.ts` and the assertion is green. Switched to
   `blankComments` and it goes red immediately. This is the same mistake recorded
   in `segmented.test.ts` ("having a shared scanner is not the same as picking
   the right variant of it"), happening a second time.
2. **The opacity census's selector tracking was anchored at column 0**, so one
   indent of `@layer base {` swallowed every rule inside it and reported the
   at-rule as a selector. Relaxing the indentation then revealed that column 0
   had been standing in for something real: `50% {` / `to {` are keyframe steps,
   not selectors, and what the reader is looking for is the `@keyframes` around
   them. Both are now in the regex.

The same census also changed its accounting: the three `opacity: 0.45` rules on
`.btn` / `.seg-item` / `.menu-item` are now **one** `disabled:opacity-45` in
`spec.ts`, the three ALPHA_SITES merge into one, and the census gained a pass
scanning `.ts`/`.tsx` for `opacity-<n>` classes. If anyone in Stage 2 writes a
new `opacity-*` class, the census will still stop them and demand it be
classified.

---

## Stage 2 · data grid (`DataGrid` / `GridScrollbar` / `grid.css`) — landing, and where it diverged from the document

Also **written back after the work was done**. §5.4 named this module the
highest-risk one; the items below only became known once it was actually done.

### grid.css was not emptied — three groups remain, each with its reason

§2.5 says "delete the CSS file only once it is empty". This one is not empty, and should not be:

| What stays | Why it cannot be a utility class |
|---|---|
| `.grid-scroll` (called `.grid` at the time, see §12.9) | Tailwind has no utility for `overflow-anchor` or `contain`. The remaining three declarations (two `overflow` axes, `overscroll-behavior-y`) and those two are **one decision** — "the vertical axis does not exist in the DOM". Splitting one rule into half a stylesheet and half a class string is exactly the two sources of truth this document argues against throughout |
| `.grid-row` | `font-size: 0`. It is not a font size; it is the typographic move that collapses the whitespace text nodes JSX leaves between inline-block cells. The type scale has no such step and should not have one — that scale's entire job is "anything below 11px must be declared explicitly as geometry (`--text-mark`)", and 0 is not even geometry. `type-scale.test.ts` exempts it by value |
| `.grid-cell` / `.grid-rownum` / the row's three state rules | The cell's class string is generated by `cellClass()` in `util/format.ts`, and **that file is not on this round's file list**; on top of that, row hover / zebra striping / selection are painted onto the cells through descendant selectors, and a class string has no notion of a descendant |

The third row is a boundary problem, not a technical one: `cellClass()` is a pure
function under `renderer/util/`, and none of Stage 2's five lists got it. The two
ways to force it — rewriting `cellClass`'s logic inside `DataGrid.tsx`, or looking
its return value up in a mapping table — both build a second source of truth, which
is worse than leaving it. Whoever next touches `util/format.ts` migrates
`.grid-cell*` along with it.

`.grid-cell`'s `line-height: calc(var(--spacing-row) - 1px)` makes the same point in
passing: writing it as `leading-5.75` pins 23px to a multiple of 4, the line height
stops following `--spacing-row`, and "cell text sliding out of its own row" is
exactly the drift this file is careful about.

### `.col-resizer`'s alpha is now written unconditionally

It used to be `.col-resizer:hover, .col-resizer.active { background: var(--color-accent); opacity: 0.7 }`.
A literal translation gives two classes, `hover:opacity-70` and `opacity-70`, so one
ALPHA_SITES entry becomes two — the same fact filed twice.

What was actually written keeps `opacity-70` always on and picks between `bg-accent`
/ `hover:bg-accent` for the background. At rest the resizer has **no background**,
and 70% of transparent is still transparent, so the composite result is identical to
the letter, while the census still holds one entry:
`components/DataGrid.tsx:opacity-70` (was `components/grid.css:.col-resizer.active`).

### The only rounding: the drag bubble's corner radius, 3px → 4px

There is no 3px on the `--radius-*` scale. Handled by the rule §7.3 already laid
down: if a token's only argument is "that was the number before", it is not a token.
This is the row-number readout that only appears while dragging; it now shares its
radius with the thumb right next to it. **The only number that changed in this
round**, everything else compared property by property (see below).

### One value with no token, written as two numbers: the 11px scrollbar width

`.grid-vsb`'s 11px and `::-webkit-scrollbar`'s 11px in `base.css` are the same
thing — a hand-drawn scrollbar that is not the native width gets read as something
else. They are now spelled two ways, `w-2.75` and `11px`. No token was made for it
because there are only two sites; a third one should get a name.

### The `grid-*` names were kept, not missed

`grid-wrap` / `grid-inner` / `grid-surface` / `grid-overlay` / `grid-vsb` are still
on the elements. §4.1 says the semantics of a named class "are carried by the
component name after the migration" — but these five are bare divs inside one
component, and there is no component name to carry them. Their **identity**, on the
other hand, is named explicitly by three places outside:
`base.css`'s `.layout-root .grid-wrap:focus-visible` draws exactly the focus ring on
§5.4's list, `grid-layout.test.ts` asserts by name which node descends from which,
and PLAN §8's acceptance counts `.grid-surface`'s children.
A utility class can say what a node looks like, not which node it is.

### Verification: old and new computed styles compared property by property in Electron

§5.4 asks for "open a large table and scroll to the bottom", and that needs a real
machine. Before that, one machine-checkable pass was done: the grid section of
`styles.css` at HEAD (the pre-migration text, with token names swapped per §6.1's
table) was injected under an `o-` prefix, put into two equivalent subtrees of the
same document alongside the post-migration class strings, and compared one by one
across 70 computed properties plus `getBoundingClientRect` using Electron's own
Chromium.

14 differences, every one explained, and no fifteenth:

- the bubble's four corner radii (the rounding above);
- the **colour of the edges that have no width** on `.grid-head` / `.grid-corner` /
  `.grid-head-cell`. `border-b border-border-strong` is two classes: one sets 1px on
  the bottom edge, the other sets the colour on **all four edges**.
  The old rule `border-bottom: 1px solid …` set only the bottom. The other three edges
  are `border-style: none` at width 0 and draw not a single pixel, so it looks exactly
  the same — but this is generic Tailwind behaviour, every pair of
  `border-<edge> border-<colour>` in every Stage 2 module works this way, and it is
  worth knowing;
- the resizer's resting `opacity`, 1 → 0.7 (the one above).

Widths, heights, positions and box rectangles are **all identical**, including
`w-2.75`=11px, `-right-0.75`=-3px, `w-1.75`=7px, `left-0.5`/`right-0.5`=2px,
`right-3.75`=15px, `px-1.5`=6px, `gap-1`=4px, `h-head`=26px, `w-gutter`=54px,
`top-head`=26px.
A negative control was run too: `w-2.75` was deliberately changed to `w-3`, `gap-1`
to `gap-2`, and `top-head` to a name that does not exist; all three reported a
difference at once — so this comparison is not comparing two trees that both have no
styles.

The scroll maths itself did not move a byte: `--spacing-row` is still the `var()` in
`.grid-row`, `ROW_H` / `HEAD_H` are still the constants in `vscroll.ts`, and no extra
layer appeared between them. None of the newly introduced rem values (the 6px
padding, 4px gap, 7px resizer and so on) reaches `computeScroll`.

### Two contract tests changed along with it, both under duress

- `theme-contrast.test.ts`'s "a hand-drawn scrollbar must not be diluted by opacity"
  used to read the `.grid-vsb-thumb` rule in `components/grid.css`. That rule is
  gone, and **a rule that does not exist never has a problem** — left as it was, it
  is an empty assertion. It now reads `GridScrollbar.tsx`'s class string: at rest it
  must be `bg-border-strong`, and no `opacity-*` may appear. The only other change in
  that file is the one ALPHA_SITES `where`.
- `grid-layout.test.ts`'s `byClass` went from "className **equals** this name" to
  "the class list **contains** this name", `.grid-wrap`'s two assertions went from
  reading a CSS block to reading the class list, and the `.grid-vsb` one now reads
  `GridScrollbar.tsx`. The `.grid` one is untouched — it is still in grid.css.

---

## Stage 2 · app shell (the window shell / `components/app.css`) — landing, and where it diverged from the document

Only about half of `app.css` moved; the other half is **not unfinished, it cannot or
should not be done**. Four kinds of reason, each rule annotated with which one it
falls under; the categories themselves are spelled out here because they apply to
the later modules just as much.

### The premise "delete this module's CSS file once it is empty" does not hold for `app.css`

§2.4's assumption when splitting the files was "each agent owns one CSS file + a set
of components, and the file sets are disjoint". The components really are disjoint;
**the class names are disjoint**. A batch of rules in `app.css` is the window's
shared vocabulary, worn on other modules' elements:

| Rule | Who wears it |
|---|---|
| `.modal-mask` / `.modal` / `.modal-head` / `.modal-body` / `.modal-foot` / `.t` | settings' preferences dialog, context-actions' consent dialog |
| `.form-row` / `.form-row label` / `.form-label` / `.form-hint` / `.form-actions` | settings' five sections |
| `.chat-rail` / `.chat-rail.collapsed` / `.session-*` / `.sidebar-head` / `.sidebar-title` | chat's session sidebar |
| `.toolbar` / `.sep` / `.toolbar .grow` | the six views, chat, error-center |
| `.empty-hint` | the connection sidebar, the session sidebar, the object tree |
| `.conn-actions` | the first-run guide, two settings sections |
| `.value-box` / `.view-error` | InspectorView / ResultControls |
| `.statusbar .err` | the unread count in error-center's status bar |

Deleting them breaks someone else; writing the same declarations out again in JSX
while the CSS stays is **one thing with two sources of truth** — what this document
opposes as a whole. So: these classes **stay in use**, the rules **stay**, and they
go once their owners have migrated. Stage 3's wrap-up should walk the table above
row by row.

### Unlayered CSS beats utilities, so an element migrates whole or not at all

§7.1 already recorded this (`base.css`'s `button`); in Stage 2 it becomes a
**boundary rule**: whenever a class has to stay because of "shared vocabulary" or
"pinned by an outside test", that element **cannot** take an extra utility to change a
property it already declares — the utility has no effect, and it fails silently.

Two sites hit this in practice; both kept an inline `style`:

- `ConnectDialog`'s `width: 520`. `.modal` declares `width: min(760px, 86vw)`, and
  `w-130` inside `@layer utilities` loses to it; the dialog would silently widen to 760px.
- the red on the "field is invalid" hint in the same file. `.form-hint` already
  declares `color`, `text-err` loses the same way, and the one hint that has to stand
  out would fade to match the four next to it.

The inline `style` is not laziness at these two sites, it is **the only spelling that
works under the current cascade**; they can become utilities the day `.modal` /
`.form-hint` move.

### Three outside tests pin part of `app.css`, and those test files are not this module's to change

- `components/__tests__/view-drag.test.ts` reads rule bodies by selector: `.panel`'s
  `position: relative` and `overflow: hidden`, `.panel-head`'s `--spacing-bar`,
  `.panel-tabs`'s two `overflow`s, `.panel-tab`'s `--tab-min-width`, and
  `pointer-events: none` on `.panel-drop-overlay` / `.view-drag-ghost` /
  `.tab-insert-caret`. It also asserts that the literal `className="panel-body"`
  exists in `Panel.tsx` and the string `panel-actions` exists in `PanelTabs.tsx`.
- `theme-contrast.test.ts`'s ALPHA_SITES has three entries pointing at this file:
  `.panel.drag-source`, `.conn-key`, `@keyframes pulse`. The census books by
  "file:selector", so moving a declaration = a stale list = red.
- `control-spec.test.ts`'s `CLASSNAME_LEDGER` carries `sidebar-handle` and `tab-close`.
  The list requires **both a `<Button>` passing the name and a stylesheet defining
  it**; either side missing is red.

**So this module did not delete its own two ledger entries**, even though §6.5 asks
that "each Stage 2 module deletes its own from the list once it has migrated them".
Deleting them means changing `control-spec.test.ts` at the same time, and that file
is shared by all five Stage 2 agents. Left to Stage 3:
`.sidebar.collapsed .sidebar-handle { width: 100% }` can become
`<Button className="w-full">` (`w-*` is a layout class the fence allows), `.tab-close`'s
`visibility` has to move together with `.panel-tab`, and both come off the list at once.

### `text-center` / `text-left` / `text-right` are unusable under the current tests

`type-scale.test.ts`'s usage scan judges every `text-*` class to be either "a font
size step" or "a colour", and errors when it is neither. Alignment classes are
precisely neither, so:

- three rules stay in the CSS: `.empty-hint` (`text-align: center`),
  `.form-row label` (`right`), `.package-frame-stalled` (`center`);
- `FirstRunGuide`'s `textAlign: 'left'` stays an inline `style`.

This is not something for this round to fix (the test file is not this module's),
but it is one **every Stage 2 module runs into**, written down here so a fifth agent
does not diagnose it again. On the baseline run `DataGrid.tsx`'s `text-ellipsis` was
failing on exactly the same judgement — that is a case for `truncate`. The fix should
be to let the scan pass an allowlist first
(`text-left|center|right|justify|ellipsis|clip|wrap|nowrap|balance|pretty`), not to
loosen "error on anything unrecognised".

### No new tokens, one rounding

The toast's original `box-shadow: 0 6px 20px #0008` did not become a fourth shadow
token; it merged into `--shadow-float` (`0 8px 24px #0009`) — it is the same class of
surface as the selection action bar and the error center, one that "floats above the
whole window", the difference is two pixels, and "that was the number before" is not
a reason for a token (§7.3). The comment in `theme.css` changed accordingly from "two
values merged into one" to "three".

The crash screen's `.crash-box` 5px radius likewise goes to `rounded-sm` (4px), on the
same reasoning as §7.3's `.gal-row`.

Beyond that **every declaration was checked one by one**: each post-migration class
string was resolved into real declarations out of the build output and lined up
against the pre-migration rule body; widths and heights, margins and padding, colours
and font sizes all match (`h-6.5`=26px, `pl-18`=72px, `px-2.25`=9px, `py-0.75`=3px,
`gap-1.25`=5px, `max-w-140`=560px, `max-h-45`=180px, `z-600`, `border-l-3`=3px).

### How borders are written: `border-y border-r border-l-3`, not `border` with a layer on top

The toast and the crash screen are both "three 1px edges + one 3px coloured edge".
A literal translation of the old rule is
`border border-border-strong border-l-3 border-l-<colour>`, but those are **two
classes from the same family**, which is exactly what §7.2 describes — who wins is
decided by Tailwind's output order. This pair's order happens to be right in practice
(`border-width` before `border-left-width`), but depending on a happens-to-be is
unreliable, so it was split into three disjoint families:
`border-block-*` / `border-right-*` / `border-left-*`.

### Class strings must be complete literals, never assembled

All three contract tests read the string literals inside `className=` through
`classNames()` in `sourceScan.ts`. Two spellings are invisible to it, and what is
invisible is exactly the part that varies:

- `className={SOME_CONST}` — no literal, the whole string is invisible;
- `` className={`shared part ${cond ? 'a' : 'b'}`} `` — quotes inside a template
  string are matched in pairs, the quotes on either side of the interpolation pair up
  with the outer backticks, and **that leaves `'a'` / `'b'` exactly outside the pairing**.

So the toast's three levels each write out a full class string, and so do
`conn-item`'s selected / unselected states. Verbose, but it is the only shape these
three floors can see. (The `classes.push(...)` array assembly in `Panel.tsx` /
`PanelTabs.tsx` is equally invisible; it just assembles named classes that were kept,
and involves no colours or font sizes.)

---

## Stage 2 · chat (`components/chat/*.tsx` + `chat.css`) landing, and where it diverged from the document

`chat.css` 1152 lines → **153 lines**, holding only 9 declarations and 2
`@keyframes`. Every survivor is a different reason a utility class cannot reach
it, worth recording one by one, because three of them are temporary and one is
not.

### The four kinds left in CSS, and how long each has

| What stayed | Why | When it can go |
|---|---|---|
| `.chat-toolbar { gap }`, `.chat-input { line-height }`, `.chat-mode-select` (including `.permissive`) | **Unlayered rules beat utilities**. `.toolbar` in `components/app.css` and `input, select, textarea` in `base.css` are both unlayered, and a same-family property always wins over `@layer utilities`. `font: inherit` is the worst of them: it is a shorthand, so it carries `font-size` and `line-height` away with it | Wait for the step §7.1 describes — once those two blocks move into `@layer base`, these three become `gap-2` / `leading-normal` / `text-sm` outright |
| `.chat-list { overflow-anchor: none }` | Tailwind has no utility for this property, and the arbitrary-property form is exactly what §3.4 forbids | Not unless Tailwind adds one |
| `.md > :first-child` / `:last-child` | It states a position among siblings, not something about the element itself. `first:`/`last:` match the first child of **any** parent, and `renderBlock` recurses into blockquotes and list items, where the first paragraph's top margin has to stay | Not going. The only one of the four that is not temporary |
| `.md-h1` / `.md-h2` | 15px and 14px, the two rungs the type ladder **deliberately does not have** | Not going; reason below |

**Why the ladder does not get two more rungs**: the five `--text-*` rungs measure
peek's **shell**, and their value is that there are only five. `md-h1` / `md-h2`
measure the **body text** an agent writes — content, not shell; lengthening the
shell's ruler by two notches for the sake of body text buys nothing. Both sit
above the 11px floor, and both are still read by `type-scale.test.ts` from the
stylesheet side, so the audit loses no strength. `md-h3` and below land on rungs
that already exist (see `HEADING` in `Markdown.tsx`).

### Nine new tokens

The first 7 were literals hard-coded in `chat.css` — exactly the shape §3.4
wants driven out:

| token | value | where it was |
|---|---|---|
| `--color-warn-bg` / `--color-accent-bg` | `#2a2415` / `#16233a` | The two background colors of the permission panel (and the mode confirmation). Named after the existing `--color-err-bg`: the same sentence, said a third and a fourth time |
| `--color-warn-ink` | `#2a2109` | The **only** place in the window where text is painted on a solid semantic color — the amber badge on non-peek tools. None of the three foreground weights is dark |
| `--color-code-{keyword,type,string,number}` | four hues | The four `.tok-*` rules. Comments and punctuation are not among them: they are `--color-fg-faint` / `--color-fg-dim`, because "this is an aside" and "this is syntax" are things the text ladder already says |

The last 2 are `--animate-chat-pulse` / `--animate-chat-spin`. The `@keyframes`
stay in `chat.css` per §4.3 (and must: ALPHA_SITES in `theme-contrast.test.ts`
carries the entry `components/chat/chat.css:@keyframes chat-pulse`), but
`animate-*` reads only the shorthand from `@theme`, so the shorthand lives in
theme.css and the steps in chat.css, with a comment on each side pointing at the
other. Both call sites write `motion-reduce:animate-none`, and the old
`@media (prefers-reduced-motion)` block went with them — its reason ("no state
is carried by an animation") moved onto `STATUS_DOT` in `ChatView.tsx` and
`TOOL_MARK` in `ToolCallCard.tsx`.

### Six roundings written out

Per §7.3's rule: anything whose only reason is "that was the number before" does
not deserve a token.

- `line-height: 1.6` ×2 → `leading-relaxed` (1.625), `1.55` → `leading-normal` (1.5). At 12px that is at most 0.3px per line.
- `letter-spacing: 0.02em` → `tracking-wide` (0.025em), `0.06em` ×4 → `tracking-wider` (0.05em).
- `border-radius: 3px` ×4 → `rounded-sm` (4px); the chip's `9px` → `rounded-full` (on a 20px-tall chip that is the same pill).
- `#dce9fb` on `.chat-tool-badge.mutating` → `text-fg`. It is a touch bluer than
  `--color-fg`, and the only reason for that is "that was the number before", so
  per §7.3 it folds onto an existing token, saving one.
- The attachment dropdown's `box-shadow: 0 6px 20px rgb(0 0 0 / 55%)` →
  `shadow-menu`. It is a popup menu, and a popup menu should have one shadow.
- The `9%` in the `.chat-tool.peek.mutating` gradient → `from-accent/10`.

One replacement that is **not** a rounding: `vertical-align: -1px` on `.md-check`
was written as `relative top-px`. Tailwind's `align-*` has no length rung, the
arbitrary-value form is forbidden, and this 1px is the optical adjustment that
seats an 11px box on the baseline — not something that can be erased. The same
displacement, said in the existing vocabulary.

### Three named classes are handles for a **script**, not styles

`chat-view`, `chat-msg` and `streaming` now carry no declaration at all. They
stay because `apps/desktop/scripts/verify-chat-restore.mjs`, driving a real
window over CDP, uses these selectors to find the panel, count messages and wait
for a turn to end. The styles are gone, the handles remain, and a comment on the
elements says so — otherwise the next person deletes them as litter.

### Three things that ran past the file boundary

1. **`.chat-rail.collapsed .chat-rail-handle { width: 100% }` at
   `components/app.css:839` is now a dead rule**. It is one of the entries on
   `CLASSNAME_LEDGER`, with the rule in app.css and the JSX in
   `components/chat/ChatSessionsRail.tsx` — two agents each holding half. Change
   the JSX half to `className="w-full"` (same value, same effect) and the list
   clears, and the app.css rule can go along with its comment.
   **It was not deleted because that is not this pass's file.**
2. **`ChatSessionsRail.tsx` did not migrate at all**. The `chat-rail` /
   `sidebar-head` / `sidebar-title` / `session-list` / `session-item` /
   `empty-hint` it wears are all defined by `components/app.css`. The JSX belongs
   to chat, the CSS to the app shell, and either side moving alone breaks the
   other. This is a real seam in the Stage 2 split: either merge it into one
   agent, or run the two in series.
3. **One assertion in `chat/__tests__/chat.test.ts` changed**. It used to look
   for the literal `className="md-link"`; that class is gone, and **the class
   name was never the reason that element was safe**. It now looks for the shape:
   a span with `role="button"` whose click goes through `copyLink`. It asserts
   the same thing — no navigation, and not a fake clickable look.

### Inverse check (§5.1's method, actually run)

Six deliberate breaks, each red in the place it should be, each reverted:
`bg-[#7a3f3f]` written into PlanCard (theme-contrast red, printing the paragraph
about `#7a3f3f`); `text-[9px]` (type-scale red, naming the file and line and the
five legal rungs); `opacity-70` (ALPHA_SITES census red); passing `bg-bg-3` to
`<Button>` (control-spec red, "is a paint utility"); stuffing `chat-jump` back
into a className (red, "matches no utility family, and is not on
CLASSNAME_LEDGER" — the hole §3.3 filled); leaving `chat-jump` on the list
(red, "no <Button> passes them any more").

**Looked at, not only tested**: the real components rendered with
`react-dom/server` against **the build output CSS**, screenshotted inside
Electron's own Chromium. Coverage: user and agent messages; full markdown (four
heading levels, blockquotes, task lists, tables, SQL and an unclosed JSON code
block, inline code, links); five tool cards (peek read-only / peek mutating /
failed / non-peek / a collapsed ToolSearch row); thinking blocks, error blocks,
stop reasons, plan cards, both permission panels, the attachment bar and its
expanded dropdown, both composers, and the toolbar's five states (including the
amber `bypassPermissions` select).
**`danger` and `caution` are still distinguishable in the permission panel**:
Always allow is a dashed amber, the two rejects are solid red — the one §5.4
named as needing a look, looked at.

Checked in the build output (not inferred): `.border` sorts before `.border-l-2`,
`.border-border` before `.border-l-warn`, `.focus\:outline-none` before
`.focus-visible\:outline-solid` (so `--tw-outline-style` at the `focus-visible`
rung ends up `solid` — without `outline-solid` that focus ring compiles to a
width with no style), `.border-b` before `.last\:border-b-0`;
`@keyframes chat-pulse` / `chat-spin` are present; `.chat-*` / `.md-*` /
`.tok-*` are down to the 8 selectors in the table above.

### Build output size

renderer CSS: 52,593 B at Stage 1 → **43,700 B** (including what other Stage 2
agents deleted in parallel). This is the first drop since hand-written CSS
started genuinely disappearing.

---

## Stage 3 · What the closing sweep landed

Stage 3 in §2.5 is "delete the emptied files, typecheck, test, run the Gallery
screenshots". Done for real, **not one CSS file came out empty**, so this section
records why all six are still there, and what the sweep actually swept away.

### `styles.css` really is nothing but a list now

28 lines, six `@import`s, not one rule of its own. This is the result §2.4's
split wanted, **confirmed once**, because "what is left of it after the split" is
the only place that step could have quietly gone wrong.

It was not dissolved into `main.tsx`: the order of those six lines **is the
cascade** (`.grid-row.odd` wins a specificity tie on source order, settings
overrides app.css's form label width), and a decision should live where there is
room for the paragraph that explains it. The line in the header comment saying
"`ui/*.css` likewise ship with the controls" had expired — those three files were
deleted back in Stage 1, and a control's appearance is now a class string in
`ui/spec.ts` — so it was fixed in passing.

### No CSS file came out empty; what each of the six still holds

| file | lines | what is left |
|---|---|---|
| `theme.css` | 365 | `@theme`. It is not "what is left", it is the new source of truth |
| `base.css` | 391 | the reset, `html/body`, `::-webkit-scrollbar`, the `button` floor in `@layer base`, the `.cm-*` overrides for CodeMirror, focus emphasis, reduced-motion |
| `components/app.css` | ~880 | the window's shared vocabulary (modal / form / toolbar / empty-hint), the drag and tab-strip geometry pinned by outside tests, `-webkit-app-region`, `::after` separators, `@keyframes` |
| `components/grid.css` | 193 | `overflow-anchor` / `contain` on `.grid`, `font-size: 0` on `.grid-row`, and the group of `.grid-cell*` descendant rules `cellClass()` generates |
| `components/views.css` | 123 | the `.cm-editor` wrapper for CodeMirror, the `::after` hairline on `.h-resizer`, and `input.vq*` held down by the unlayered `input` |
| `components/settings.css` | 90 | `--spacing-form-label` for the form label width and its `calc()`, two `min()` sizes, `.seg-group` |
| `components/chat/chat.css` | 153 | 9 declarations + 2 `@keyframes`, reasons in the previous section |
| `components/context-actions/context-actions.css` | 30 | one dialog width |

**The premise "delete a CSS file once it is empty" does not hold at all**, and
the way it fails has a pattern: what stays is almost entirely four kinds —
**element-level resets**, **descendant/sibling relationships**, **the custom
properties themselves**, and **properties Tailwind has no utility for**. Atomic
classes can say what a node looks like; they cannot say where a node sits in a
relationship, or what the floor is for a family of elements. Those four kinds
belong in the budget of any comparable migration next time.

### The three dead rules the sweep did delete

1. `.chat-rail.collapsed .chat-rail-handle` (app.css) — the chat half became
   `className="w-full"` back in Stage 2, and from that moment the rule had
   nothing to match. Its reasoning (height is the size rung's business) already
   sits on the element in `ChatSessionsRail.tsx`, so deleting the rule lost no
   sentence of explanation.
2. `.sidebar.collapsed .sidebar-handle` (app.css) — the other half of the same
   thing, which the Stage 2 app shell agent recorded as "left for Stage 3".
   Finished in chat's shape: `className="w-full"`, rule deleted, and
   `sidebar-handle` deleted from `CLASSNAME_LEDGER` with it.
3. `.tree-caret.spin` (in base.css's reduced-motion block) — `.tree-caret` was
   deleted along with the object tree migration, and the `spin` class **was never
   added by any `.tsx`** (the pre-migration `styles.css` was checked too). Which
   means "a loading tree node spins" was written down in that block and never
   wired up. Delete the selector, and write the finding into the block's
   comment — otherwise it comes back next time as "there used to be a spinner
   here".

### The `text-align` lockout is lifted, so three comments expired

Stage 2's app shell recorded that "`text-center` / `text-left` / `text-right` are
unusable under the current tests", and on that reason left three rules plus one
inline `style`. `type-scale.test.ts` later gained the named `TEXT_KEYWORDS`
allowlist, and the lockout was gone. The sweep rejudged them one by one:

- `.package-frame-stalled` was the **only one of the three resting on that reason
  alone**, and it moved — it is now a class string on `PackageFrame.tsx`, with
  `px-6` measured at 24px, matching the original `padding: 0 24px`.
- `.empty-hint` and `.form-row label` already satisfied "other modules wear them"
  as well, so they stay and only the comment changed.
- `FirstRunGuide`'s inline `textAlign: 'left'` **stays, but the reason changed**:
  what actually stops it is not the test, it is the cascade — `.empty-hint` is
  unlayered, `text-left` in `@layer utilities` loses to it, and switching to the
  utility would silently do nothing. TreeView already had this reason written
  correctly at its own site; both places now say the same sentence.

**A comment with the conclusion right and the reason wrong is more dangerous than
a wrong conclusion**: the next person checks the stated reason, finds the lockout
gone, acts on it, and walks into the real wall.

### `CLASSNAME_LEDGER` has a floor, not a zero

§6.5 says this list "only shrinks", and once it is cleared the classifier is the
pure function in §3.3. It shrank to a single entry, `tab-close`, and stopped
there — **and it should not be pursued further**: `.tab-close` is
`visibility: hidden`, uncovered by `.panel-tab:hover` and `.panel-tab.active` —
what decides the button's appearance is **the state of a parent one level up**,
and a class string has no notion of a descendant selector. The tab strip's
geometry is pinned by `view-drag.test.ts` against the rule bodies, and it should
not be touched to empty a list either. Zeroing the list is therefore not a
milestone. That sentence is written into a comment in `control-spec.test.ts`.

### What the sweep swept and confirmed clean

- **Old token names**: every `var(--…)` across the renderer is in the new
  namespaces (`--color-*` / `--text-*` / `--spacing-*` / `--font-*`). Both
  exceptions are correct: `--tab-min-width` is a local property in app.css
  (pinned by `view-drag.test.ts`), and `--bg-elevated` appears only in a comment
  in `ErrorCenter.tsx` explaining that it has been deleted.
- **Arbitrary values `-[`**: zero in product code. Every hit is in a comment, in
  a test's regex, or in the markdown parser's `HR_RE`.
- **Class names with no definer**: every `className` literal was compared against
  the build output CSS as the source of truth. The named classes that remain are
  all documented selector handles — `grid-wrap` / `grid-inner` / `grid-surface` /
  `grid-overlay` / `grid-vsb` (the focus ring in `base.css`,
  `grid-layout.test.ts`, PLAN §8's acceptance), `chat-view` / `chat-msg` /
  `streaming` (`scripts/verify-chat-restore.mjs` uses them over CDP to find the
  panel and count messages), `layout-root` / `statusbar` / `titlebar` (focus
  emphasis and `usePanelFocus`, `.statusbar .err`, `-webkit-app-region`
  respectively). There is no second `chat-chip-x`.

### A process fact that has to be written down: the sweep ran on a moving tree

During the sweep **another session was editing the renderer at the same time**
(measured: `ui/spec.ts`, `theme.css`, `StatusBar.tsx`, `ToolCallCard.tsx` and
`Toasts.tsx` were all changed during this round). It showed up as the contract
test reporting a **different** variant failure on two consecutive runs (`danger`
first, then `caution`), and as the same source file reading out two different
values two minutes apart. This was not introduced by this change and it is not a
flaky test — it is a file being written while it is read.

There is one consequence, and it needs saying plainly: **the size table above is
the reading from the 16:45:09 build**, and two adjacent builds already differed
by 57 B (the other session touched `Toasts.tsx`). The order of magnitude is
right; do not take the last digit seriously. Whoever comes next and wants exact
values should rerun `pnpm build`.

---

## Section 8 · Aligning the audit's definition with Tailwind (hardening after the wrap-up)

This section records a round of hardening done after Stage 3 wrapped up, prompted
by an adversarial audit. It overturns **an unstated implicit premise in §3.1 /
§3.4 of this document**, so it is its own section, not a patch.

### 8.1 Where the implicit premise is wrong

§3.1 says "the tests must expand to scan JSX as well"; §3.4 says "no `-[`
anywhere under renderer/**/*.tsx". Both sentences define the audit surface as
**"string literals inside a `className=` attribute"**, and `classNames()` in
`sourceScan.ts` was written to match.

Tailwind's scanner does not work that way. It extracts candidate tokens from
**the raw bytes of every file** covered by `@source`; it does not know about JSX
attributes, strings, comments or Markdown.

So there is a sentence that has to go at the very top of anything that audits a
Tailwind codebase, and it now also sits in `sourceScan.ts`'s head comment:

> **What is in the build output is decided by Tailwind's scanner, not by ours.
> Every place the two disagree is a hole through which production breaks while
> CI stays green.**

All three holes come from this single difference in definition, and all three
were reproduced on a clean tree:

| | Shape | Measured |
|---|---|---|
| F1 | `` className={`flex ${on ? 'bg-[…]' : '…'}`} `` | What the old scanner extracted from this line was three "class names": `?`, `:`, `}`. Inside a template string the quotes on either side of the interpolation pair up with the outer backticks, and **the half that varies falls exactly outside that pairing**. The renderer has 29 template-string classNames |
| F2 | `const BADGE = 'flex-none px-1.25 text-sm …'` | Not an attribute, so the whole string is invisible. Of the 74 use sites of the type scale, 24 are in constants like this, in template-string branches, and in **`ui/spec.ts`, which is not JSX at all**. A third of the audit surface was missing |
| F5 | Class names in comments | **They really are in the build output.** On a clean tree, the stylesheet `pnpm build` produces holds two rules nobody ever wears; their source is two passages of prose |

F5's two passages of prose are worth recording word for word, because they are
this repository's sharpest example of "a comment is a liability as well as an
asset":

1. Line 32 of `ui/spec.ts`, whose original text read "**some class** compiles,
   paints, and is invisible to the audit" — with that class itself in the
   sentence. **The sentence made itself true**: the 1.91:1 red rule it described
   was compiled into `index.css`.
2. A JSX comment in `components/views/InspectorView.tsx` explaining "why a token
   is used here rather than an arbitrary value" — it likewise spelled out the
   very arbitrary value it had just correctly avoided, and likewise compiled into
   the build output.

Neither is a case of "the test is too strict". They are two real rules in the
build output.

### 8.2 The approach: two scanners with different names

No patch; align the definition itself. `sourceScan.ts` now has a pair of
functions whose responsibilities are written into their names:

| Function | The question it answers | Who uses it |
|---|---|---|
| `attributeClassNames(source)` | "Which classes are hung on **this element**" | Only the className fence in `control-spec.test.ts`. A whole-file scan cannot answer this question — it would treat every class in the file as passed to `<Button>` |
| `tailwindCandidates(source)` | "Which classes in this file **could reach the build output**" | The arbitrary-value ban and the type-scale census. Every rule shaped as "such-and-such must not appear anywhere" |
| `scannedSources(rendererDir)` | "Which files Tailwind will read" | The file set for both of the above, defined in one place |

The candidate shapes in `tailwindCandidates` **were checked against the build
output, not reasoned out**: plant a token with a unique colour at each of 20
different syntactic positions, run `pnpm build`, then grep
`out/renderer/assets/*.css`. What compiles: line comments, block comments,
backtick-quoted inside JSDoc, **Markdown files**, module-level `const`, both
branches of a template-string interpolation, array literals, variant prefixes,
slash modifiers, `class="…"` inside a comment, one following a `.` property
access. What does not compile: a token glued to the tail of an identifier
(`xxbg-…`), one split apart by `+`. **`.css` files do not take part in candidate
scanning at all** — which is why mentioning a banned form in a `theme.css`
comment really is harmless, and mentioning it in a `spec.ts` comment is not.

`scannedSources` therefore includes `.md`: `ui/CLAUDE.md` sits inside
`src/renderer/`, and a class name in its fenced code compiles exactly like a
class name in a component. This one also came out of planting a token and
building, not out of reading the docs.

**The definition should be wider than Tailwind's, never narrower.** Tokens
wrapped in parentheses, or on the tail of a URL, are returned here and dropped by
Tailwind. Get the direction right: a rule can only be slipped past through the
gap where Tailwind sees something we do not.

### 8.3 Scanning comments is right; the price is that prose may not spell out a live class name

This is the one real trade-off in this round; state it plainly.

Prose in `src/renderer/` **may not mention a live class name.** The two comments
in §8.1 were therefore rewritten to describe the shape in words ("a bare hex hung
off the `bg` prefix, wrapped in square brackets"), and **each one carries a
sentence explaining why it is written so awkwardly** — because the next person
will certainly want to "put it back to normal". `ui/CLAUDE.md` gained a section
for this ("Why this file spells banned syntax out in words"), for the same
reason.

This is not giving way to the test. The build output has two fewer rules: CSS
43,393 → 43,282 B.

### 8.4 Fixed along the way: the `text-*` allowlist

Stage 2's app shell recorded that "`text-center` / `text-left` / `text-right` are
unusable under the current tests". `TEXT_KEYWORDS` in `type-scale.test.ts` had
already lifted that (the Stage 3 record says so); this round confirmed it covers
12 keywords across the align / overflow / wrap families, and that it **is a named
allowlist rather than a relaxation of "unrecognised means fail"** —
`text-[13px]` and `text-huge` are equally unrecognised, and both still have to go
red.

### 8.5 Verification (all of it actually run)

- **F1**: replace the template-string branch at `ToolCallCard.tsx:102` with
  `bg-[#7a3f3f] text-[9px]`. The new scanner goes red on three counts, reporting
  `components/chat/ToolCallCard.tsx:102 → bg-[#7a3f3f]` /
  `→ text-[9px]` and `sets type with \`text-[9px]\`, which is not one of the five rungs`.
  On the same tree, running the body of the old `classNames()` on its own, what
  it extracted from this line was `?` / `:` / `}`, with 0 hits for `-[`.
- **F2**: change `text-sm` to `text-huge` inside the `const BADGE` at line 204 of
  the same file. The new scanner goes red, reporting
  `components/chat/ToolCallCard.tsx:204 sets type with \`text-huge\``;
  the old scanner gives `includes('text-huge') === false`.
- **F5**: restore the sentence at `spec.ts:32` to its original wording with the
  class name in it. Red, reporting
  `ui/spec.ts:32 → bg-[#7a3f3f]`, the failure message carrying the pointer "if
  the hit is in a comment, that sentence is compiling a real rule into the build
  output".
- **F5b (a fourth channel, newly found)**: add a line with a class name to the
  end of `ui/CLAUDE.md`. Red, reporting
  `ui/CLAUDE.md:207 → bg-[#7a3f3f]`. No test had ever looked at Markdown before.
- All four reverted. `pnpm typecheck` green, `pnpm test` **1496/1496** green
  (net +1: two new ones, "the scanner sees those three shapes" and "the scan
  surface covers three files", while the old "the spec string must be scanned
  too" was folded into the main scan).
- After `pnpm build`, `grep -c 'bg-\\\[' out/renderer/assets/*.css` = **0**,
  and arbitrary-value classes in **any family** number 0 in the build output.

The change in the type-scale census's definition, measured with the real
functions against the build output:

```
files Tailwind scans (per scannedSources): 153
text-(sm|md|lg|data|mark) sites, whole-file scan : 74
text-(sm|md|lg|data|mark) sites, old attribute scan: 50
```

### 8.6 One sentence Stage 3 got wrong

Stage 3's wrap-up sweep wrote: "**arbitrary values `-[`**: zero in product code.
Every hit is in comments, in test regexes, and in the markdown parser's
`HR_RE`."

The first half is right; the second half filed **comments** under "harmless", and
that was exactly the source of the two live rules then in the build output.
`HR_RE` (`/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}…/`) really is harmless, for a
different reason than comments: there is no letter before `-[`, so it is not a
candidate at all. Two different things were covered by one sentence, and one of
them was wrong.

"A comment that gets the conclusion right and the reason wrong is more dangerous
than one that gets the conclusion wrong" — Stage 3's own sentence, borne out a
second time in the same document.

---

## Section 9 · `ChatSessionsRail` — the one thing Stage 2 did not finish

Stage 2's chat agent recorded this as item 2 under "three things that crossed
file boundaries": `ChatSessionsRail.tsx` was not migrated at all, because every
class it wears is defined in `components/app.css`, and that file belongs to the
app shell. **This is not laziness; it is a counterexample to §2.4's "each agent
owns one CSS file plus a set of components, and the file sets are disjoint"** —
the components are disjoint, the class names are not. This section records what
it actually looked like once both halves were in one pair of hands.

### 9.1 What moved, what stayed, and why what stayed stayed

All 9 rules for this rail in `app.css` are deleted; the box, the list, the row,
the title and the timestamp are now class strings in `ChatSessionsRail.tsx`.
Three names stay, and **the reason is the same class of reason as in the grid
section** — they are handles other people use by name, not styling:

| What stayed | Who uses it | When it goes |
|---|---|---|
| `.sidebar-head` / `.sidebar-title` | `components/Sidebar.tsx` and this component wear them **at the same time**. Two modules, two file lists | Both migrate together, or neither does |
| `.empty-hint` | The connection sidebar, this component, the object tree — three modules | Once the last one has migrated |
| `chat-rail` / `session-list` / `session-item` (the names on the elements; the rules are deleted) | `scripts/verify-chat-restore.mjs` uses CDP to find the panel by `.chat-rail .session-list`, count rows by `.session-item` and click the first | It doesn't. Same as `chat-view` / `chat-msg` |

The first row is the only thing in this round that **genuinely could not be
done**, and it is worth being clear that it is not "couldn't be bothered to cross
files": `Sidebar.tsx` is not in this round's file list, and the moment those two
rules are deleted the connection sidebar's head falls apart. The other way round
— writing the same declarations again in JSX while `app.css` keeps them — is one
thing with two sources of truth. **And "migrate half of it" does not work
either** — `app.css` is unlayered (that's §7.1), so any utility patched onto this
element silently loses to a property the rule has already declared. So: the whole
block stays, and the comments on both sides point at each other.

### 9.2 `session-when`'s type size, written down for the third time

`.session-when` is the timestamp named in `type-scale.test.ts`'s head comment —
historically an inline 10px size in the component, **both below the type floor
and completely invisible to an audit of the read-only stylesheet**; that test's
inline scan grew for its sake.

After the migration it is `text-sm` (11px), not `text-mark`. The criterion is the
ladder's own rule: the rung below the floor is only for things **with no letters,
read by shape**, and `2026-08-04 15:32` is letters.

### 9.3 The fifth "prose is fact", and this time the causality runs the other way

The first four are recorded in `sourceScan.ts`'s head comment; the fifth happened
in this change: after moving the `.session-when` comment from `app.css` into the
`.tsx` verbatim, **`type-scale.test.ts` went red immediately**, because its
inline-size ban regex-matches that property name on the **raw line**, and
comments are not masked out. A sentence explaining "there used to be an inline
type size here" turned itself into an inline type size.

**But this is not the same diagnosis as the first four**, so state it clearly,
lest the next person apply §8.3 across the board:

- In the Tailwind case (F5 in §8.1), a class name in a comment **really does get
  compiled into the build output**. Scanning comments is right, and the price —
  prose may not spell out a live class name — has to be paid.
- In the inline-type-size case, **a comment has never set any inline style at
  all**. This is a problem with the scan's definition, not a real danger. The
  correct fix is for that scan to `blankComments` first (`sourceScan.ts` already
  has this function; the stylesheet scan in the same file already uses it).

**That fix was not made**, because `type-scale.test.ts` is not in this round's
file list, and weakening the assertion is not an option. What this round did
instead was rewrite the comment to describe the shape in words, and **leave a
sentence explaining why it is written so awkwardly** — per the rule §8.3 already
laid down. This suggestion, along with the one-line fix, stays here for whoever
touches that test next.

### 9.4 Two places the handover did not match measurement

1. **`chat-rail-handle` is no longer on `CLASSNAME_LEDGER`.** The list now holds
   only `tab-close` (the Stage 3 record says so: the chat half switched to
   `w-full` back in Stage 2, and the dead rule in app.css was deleted in the
   Stage 3 sweep). So this round **did not touch** `control-spec.test.ts`, not
   one byte.
2. **The rule `.chat-rail.collapsed .chat-rail-handle` is long gone too**, same
   reason.

### 9.5 Verification: compared property by property in Electron, plus one negative control

Done the way the grid section did it, because "row height, hover and selected
state are unchanged" has to be a measured statement. The original rules for this
rail from `git show HEAD:styles.css` (token names swapped per §6.1) were injected
with an `o-` prefix, and put together with the post-migration class string into
two equivalent subtrees of one document; Electron's own Chromium then compared 70
computed properties plus `getBoundingClientRect` one by one. The class string was
not hand-copied; it was read out of the `.tsx` by regex.

**Across the three states — at rest, hover, and `focus-visible` — there is only
one kind of difference, 3 in total**, and it is the general Tailwind behaviour
the grid section already recorded: `border-l border-border` is two classes, and
the second sets the colour on **all four edges**, while the old rule
`border-left: 1px solid …` set only the left. The other three edges are
`border-style: none` at width 0 and do not paint a single pixel.

The readings taken (old and new identical):

| | Value |
|---|---|
| Expanded / collapsed width | 260px / 28px |
| **Row height** | **44.34px** (12px title line 17.40 + 11px time line 15.95 + 5px top and bottom + 1px bottom border) |
| Row padding / radius / bottom border | 5px 7px / 4px / 1px `--color-border` |
| **Hover** | `rgb(33,37,43)` = `--color-bg-2` on both sides (at rest it is transparent, so this state really was applied) |
| **Selected** (`aria-selected="true"`) | `rgb(33,37,43)` on both sides, the same layer as hover |
| **Focus ring** | `2px solid rgb(77,156,255)` on both sides, `outline-offset: -2px` |
| Timestamp | 11px, `rgb(133,141,151)` = `--color-fg-faint` |

Hover and `focus-visible` were applied with CDP's `CSS.forcePseudoState`. **There
is a trap here, recorded for next time**: every `DOM.getDocument` reissues
nodeIds, dropping the state forced on the old ids, so "only the second of the pair
actually entered the state" and the difference reported was the tool's own. It
only came out right once the document was fetched exactly once per round.

**A negative control was run too** (otherwise this comparison might be between
two trees that both have no styling): change `w-65` to a name that never
compiled, `px-1.75` to `px-2`, and `text-sm` to `text-md`; all three immediately
report differences in width, padding, type size and line height.

**Looked at, not only measured**: screenshots from the same window, the old and
new rails (expanded + collapsed) laid over each other, plus one each of the hover
and focus states. `focus-visible` is the one §5.4 named as "you can't tell when
it's lost"; this time it is drawn out for someone to look at.

The `aria-selected:` variant was checked against the build output, not the docs:
`.aria-selected\:bg-bg-2[aria-selected=true]{background-color:var(--color-bg-2)}`.
The `focus-visible:outline-2` rung was also confirmed to land
`--tw-outline-style` as `solid` — this element has no `outline-none`, so it does
not need the `outline-solid` the "chat" section mentions.

### 9.6 Size, and one necessary disclaimer

`pnpm build` green; 0 `.chat-rail` / `.session-*` selectors in the build output,
and 0 arbitrary-value classes in **any family**.

After deleting these 9 rules the renderer CSS measured **42,860 B** (the previous
reading was Section 8's 43,282 B). But **this difference cannot all be charged to
this round**: the very next build came out at 43,070 B, and between those two
`theme.css` and `base.css` were changed by **another session** (mtime three
minutes later than this component's). Stage 3 recorded that "the sweep was done
on a moving tree"; this round is the second time that has borne out. The order of
magnitude is right; do not take the last digits seriously.

---

## Section 10 · The palette goes from "closed set" to "audited closed set"

This section has the same root as Section 8: another adversarial audit, another
finding that **the tests were written right and the coverage did not follow**.
Section 8 fixed "the places the scanner cannot see"; this one fixes "the places
the scanner can see, but nobody looks at".

### 10.1 Two holes

**F3 — 17 of the 32 colours are named by no assertion at all.**

The migration grew the palette from 15 colours to 32, and
`theme-contrast.test.ts` did not gain a single assertion. The evidence is not an
argument: change `--color-code-string` from `#c3e88d` (12.13:1) to `#1d2126` —
**1.03:1 on the `--color-bg-1` code block it actually sits on, literally
invisible** — and all 1495 tests stay green.

The 17 nobody asserts: `accent-bg accent-dim bg-3 bg-hover bg-sel caution-active
caution-hover code-keyword code-number code-string code-type danger-active
danger-hover primary-active primary-hover warn-bg warn-ink`.

The head comment of this file says "the closed set is the premise that makes
every assertion below meaningful". That sentence is true, but it was taken for
more than it says: **`--color-*: initial` guarantees there is no 33rd colour; it
guarantees nothing about these 32.**

**F4 — the literal-colour ban only watches borders.**

`LITERAL_BORDER` matches only `border*` / `outline*`. Adding
`background: #7a3f3f; color: #7a3f3f;` to `.view-error` in `components/app.css`
is green — same value, same failure, different property. This hole was not
introduced by the migration; the test file writes it down itself under "known
hole two", and then **carried that comment through the entire migration**.

### 10.2 The F4 fix: the rule is about values, not about properties

**Listing the property names again is the wrong answer** — the property list is
itself what caused this hole, and the next hole is whichever family the list
misses. `box-shadow` already is one, measured: `.modal` and `.view-drag-ghost`
each carry a shadow value `@theme` knows nothing about, and the comment on
`--shadow-float` is about exactly that — "three values that do not know about
each other".

So the rule becomes: **a colour literal (`#hex` / `rgb()` / `hsl()`) may appear
in exactly one place across the renderer's stylesheets — the `@theme` block in
`theme.css`.** The implementation matches neither lines nor property names: from
the hit it scans back to the nearest `;` / `{` / `}`, reads that declaration's
property name, and lets through only definition lines starting with `--` inside
`theme.css`. So a literal inside a multi-line value, and a `--my-red: #f00`
outside theme.css (a second palette), are both caught.

The widened rule caught 7, all turned into tokens, **with no value changed**:

| Site | Was | Now |
|---|---|---|
| `grid.css:.grid-row.odd .grid-cell` | `background: #1e2228` | `--color-bg-stripe` |
| `grid.css:.grid-cell.bool` | `color: #c98fe0` | `--color-cell-bool` |
| `grid.css:.grid-cell.json` | `color: #7fc9a2` | `--color-cell-json` |
| `app.css:.modal-mask` | `background: #0009` | `--color-scrim` |
| `app.css:.modal` | `box-shadow: 0 18px 48px #000a` | `--shadow-modal` |
| `app.css:.view-drag-ghost` | `box-shadow: 0 6px 18px rgb(0 0 0 / 45%)` | `--shadow-drag` |
| `base.css:.cm-editor .cm-activeLine` | `background: #1b1e2333` | `color-mix(in srgb, var(--color-bg-1) 20%, transparent)` |

The last one **minted no token**: it is 20% of `--color-bg-1`, and a
semi-transparent colour has no colour to speak of until it lands on something
else. Written as a mix, it follows `--color-bg-1`.

The first three are especially worth recording: `.grid-cell.bool` / `.json` are
**body text** — the text of every boolean and JSON cell in the data grid,
`--text-data`, four backgrounds — and under the border ban they were audited not
at all.

### 10.3 The F3 fix: coverage is counted from a runtime record, not from a list

`colorOf()` now records every token it resolves into `MEASURED`, and a census
assertion sits at the end of the file: **every `--color-*` in `@theme` was either
really measured by some assertion, or is on `DECORATIVE_ONLY` carrying a
sentence.** This is the same move as `ALPHA_SITES` / `NOT_CONTROLS` /
`CLASSNAME_LEDGER`.

**Why a record and not a list**: a list can outlive the assertion it points at,
and then the census reports "the palette is fully audited by a test that does not
exist" — exactly the hollow assertion this document exists for. The census
therefore has to be the last `test()` in the file (node:test runs in declaration
order); if that ordering assumption ever stops holding, what it reports is "the
entire palette was never measured" — red, not green.

Three tables:

| Table | What is in it |
|---|---|
| `SURFACES` | Every background + every ink painted on it + the element where that happens. All ≥ 4.5:1 |
| `BELOW_FLOOR` | Pairings that do not reach 4.5. Each one **pins the measured ratio** and states what fixing it would touch |
| `DECORATIVE_ONLY` | Colours with no text painted on or in them. Currently just `--color-scrim` |

Every pair in the tables was **traced to a real element before it was written
down** — a table of "plausible-looking" pairings asserts things the product does
not do, which fails in the other direction and is just as useless.

### 10.4 `colorOf` could not read `color-mix`, so those six colours were never measurable

The six in the `--color-primary-hover` family are `color-mix()`, and `colorOf`
used to understand only six-digit hex. Which means **all six surfaces a control
passes under the pointer were outside the audit by construction**, and the line
in `theme.css` saying "they are named precisely so `theme-contrast.test.ts` can
see them" stated an intention, not a fact.

`colorOf` now resolves `#rgb` / `#rrggbb` / `var()` / `color-mix(in srgb, …)`
recursively. Two easy mistakes are written into the comments: `in srgb`
interpolates **gamma-encoded** channels (straight linear interpolation over
0–255), not the linear light the luminance formula uses; and in
`color-mix(in srgb, A 82%, B)`, B is 18%, not 50%. The alpha forms (`#0009`) are
**deliberately unsupported** — they have no contrast until they land on
something, so they can be neither ink nor surface, and the answer is a sentence
on `DECORATIVE_ONLY`.

### 10.5 Five real pairings measured below the floor — recorded, not fixed

**This is the round's most important output, not a footnote.** Once 10.3's
tables wired the 17 colours into the audit, five genuinely rendered pairings came
in below the 4.5:1 of WCAG 2.1 SC 1.4.3:

| ink on surface | measured | where |
|---|---|---|
| `--color-err` on `--color-danger-hover` | **3.69** | text on a `danger` button while hovered (Stop, Reject) |
| `--color-fg-faint` on `--color-bg-hover` | **3.79** | the argument summary and duration in a hovered tool-card header |
| `--color-fg-faint` on `--color-bg-sel` | **3.90** | NULL cells inside a selection |
| `--color-fg` on `--color-primary-hover` | **3.92** | the label on a `primary` button while hovered |
| `--color-err` on `--color-bg-hover` | **4.48** | hovered `danger` menu items (Close, Forget connection, Clear errors) |

Four of the five are **interaction states**, which is no coincidence: the resting
colours were measured when the legibility baseline was set, the hover/active
derivatives were mixed afterwards, and **nothing measured the result**. The label
on a `primary` button drops from 4.89 to 3.92 the moment the pointer touches it.

**Not one of them is fixed here**, and the reason is in the comment above the
table: every fix changes how the product looks (change a palette value, or change
the ink a component picks), and this round is an audit; **a contrast test that
quietly edits styles while it measures is not a contrast test**. So each row pins
its measured value and states its fix:

- ratio gets worse → red;
- ratio gets better but still does not pass → red (the numbers in the table are
  the table's entire value);
- ratio passes → red, demanding the row move from `BELOW_FLOOR` into `SURFACES`.

It is a ratchet, not an exemption. The wording deliberately avoids the word
"exempt" — the `ALPHA_SITES` exemptions have a clause behind them, the kind that
reads "WCAG explicitly excludes text inside disabled controls"; these five have
no clause. They are debt.

**What the next person does**: work through the `fix` field on each
`BELOW_FLOOR` row, alongside the Gallery screenshots from §5.2. The `primary` /
`danger` hover colours are the same shape (light background + light text) and
will most likely be changed together.

### 10.6 Verification (all really run, each one reverted)

- **F3's original evidence**: `--color-code-string` → `#1d2126`. Red, reporting
  `--color-code-string on --color-bg-1 is 1.03:1`, with the code block's site
  alongside.
- **Census**: add a `--color-untouched-by-anything` nobody mentions to `@theme`.
  Red, reporting "these colours are in `@theme` and this file has never looked at
  them".
- **Ratchet**: change `--color-danger-hover`'s mix from 86% to 70%. Red,
  reporting `recorded at 3.69:1 and now measures 2.88:1 (worse)`.
- **Stale list**: delete the definition of `--color-scrim`. Red, reporting that
  `DECORATIVE_ONLY` names a colour `@theme` no longer defines.
- **List that cannot state a reason**: change scrim's reason to `'decorative'`.
  Red.
- **Self-contradiction**: put `--color-fg-faint` into both `SURFACES` and
  `BELOW_FLOOR`. Both red.
- **Debt with no fix**: add a record with `fix: 'later'`. Red.
- **F4's original evidence**: add `background: #7a3f3f; color: #7a3f3f;` to
  `.view-error`. Two reds. **On the same tree, run the old `LITERAL_BORDER`
  regex on its own: 0 hits** — the old ban really was green.
- **What F4's property list would have missed**: `box-shadow: 0 1px 2px #123456`
  → red; `background: rgb(122 63 63)` → red; `--my-red: #7a3f3f` (a second
  palette outside theme.css) → red; the `#7a3f3f` on the second line of a value
  spanning lines (that line carries no property name) → red.
- `pnpm typecheck` green; `pnpm test` **1502/1502** green (net +6 against 1496);
  `pnpm build` green, arbitrary-value classes in the build output still 0, all
  six new tokens present in the build output.

### 10.7 One wrong comment fixed along the way

The three text weights in `theme.css` are commented "11.7 / 7.6 / 5.0 against
--color-bg-1"; the original said 12.4 — 12.40 is the reading against
`--color-bg`, and against `--color-bg-1` it is 11.66. Two of the three numbers
were bg-1's and one was bg's, mixed into one sentence. Per the line Stage 3 wrote
for itself — "a comment that gets the conclusion right and the reason wrong is
more dangerous than one that gets the conclusion wrong" — they become the
measured values.

---

## Section 11 · Converging on one stylesheet (round three, evening of 2026-08-04)

### 11.1 This section overturns §2.4

§2.4 required splitting `styles.css` into six files. **That rule's reason was
never design, it was scheduling**:

> If six agents edit it at once, that is a six-way write conflict. So step 0
> splits it mechanically into…

The parallel stage is over and the reason expired with it. Keeping six files buys
nothing now; it leaves a directory that does not match Tailwind's usual shape.
This round merges them back into **one `styles.css`**.

This is not a reversal, it is taking down scaffolding. §2.4's text stays as
written, because it was right for the stretch it governed — the split really did
let five agents finish the CSS in parallel without conflicts.

### 11.2 A judgement to correct: Tailwind v4's variants can do more than earlier rounds assumed

Several Stage 2 agents wrote "utilities cannot structurally reach this" again and
again, and kept descendant selectors and pseudo-elements on that basis. On
review, **that judgement was too conservative**. What v4 has:

| Judged impossible in earlier rounds | v4's answer |
|---|---|
| `.divider::after` drawing the divider line (7 sites) | the `after:` variant |
| `.panel.focused .panel-head` (10 descendant rules) | `group` + `group-*` variants; state via `data-*` |
| `.grid-row:hover .grid-cell` | `group-hover:` |
| `-webkit-app-region: drag` | `@utility app-drag { … }` |
| `@keyframes` + the animation shorthand | `@theme { --animate-* }`, with the keyframes themselves still raw CSS |

What genuinely cannot be reached is only the categories in 11.3. Keeping "cannot
be reached" apart from "not done this round" is why this section exists — the
first is a fact, the second is progress, and mixed together they make the next
person think the floor is twice as high as it is.

### 11.3 The floor: about 240 lines, not three

| | code lines | why it has to be CSS |
|---|---|---|
| `@theme` | ~68 | This **is** v4's configuration. That is what CSS-first means; it is not residue |
| CodeMirror `.cm-*` | 56 | DOM the editor renders itself; there is no JSX element of ours to hang a className on |
| `::-webkit-scrollbar` | 21 | No matching utility, and the pseudo-element is not our element |
| Element-level reset (`body` / `#root` / `textarea`) | ~75 | Goes in `@layer base`, which is where Tailwind officially recommends base styles live |
| `@keyframes` ×7 | ~20 | Keyframes can only be raw CSS |

**Why not three lines** (that was v3's `@tailwind base/components/utilities`; v4
is the one line `@import "tailwindcss"`): a fresh Tailwind project's stylesheet is
one line because it has no design system, no embedded third-party editor, no
hand-drawn scrollbar, no Electron title bar. peek has all four. Comparing against
it is comparing different things.

Target shape:

```css
@import "tailwindcss";
@theme      { …tokens… }
@utility    app-drag { -webkit-app-region: drag }
@layer base { …reset / scrollbar / CodeMirror… }
@keyframes  …
```

One file, about 240 lines of code. This repository's comment density will put the
total length at 500–600 lines — **comments are not debt**; every piece of raw CSS
left behind has to state "why utilities cannot reach it", which is the rule
running through Sections 6–10.

### 11.4 Order

Clear first, merge second, never the other way round: changing rules after the
merge means operating inside a 900-line file.

1. **Clear `app.css` (451 lines of code)** — 10 descendant rules → `group-*` /
   `data-*`; 7 `::after` sites → `after:`; `-webkit-app-region` → `@utility`;
   the rest → conditional classes in JSX.
2. **Clear `grid.css` (101 lines of code)** — conditional on refactoring
   `cellClass()` in `util/format.ts`. The Stage 2 grid agent wrote explicitly
   that it was "one file short of finishing"; that file was not on its list,
   missed when the work was carved up, not a technical obstacle.
3. **Clear the remainder** — `views.css` / `settings.css` / `chat.css` /
   `context-actions.css`, part of which depended on the unlayered-CSS wall round
   two took down (§7.1).
4. **Merge into one `styles.css`** — mechanical, not one rule changed.
5. **`stylesheets()`'s assertion has to follow** — `sourceScan.ts` currently
   asserts the list must contain `styles.css`, which still holds and still
   carries weight once one file is left (what it guards against is "the directory
   moves and every rule reading it turns into a hollow assertion at once"). But
   the list length goes from 9 to 1, and any error message grouped by file needs
   a second look.

### 11.5 Risks

Two, both outside what tests cover:

- **The `cellClass()` refactor**. It assembles `grid-cell num` / `null` / `bool`
  / `json` / `trunc` / `pending` at runtime; returning a utility string instead
  means Tailwind has to see those strings statically — written as lookup-table
  constants, not template concatenation. Since §8 aligned the scanner, constants
  of that kind are inside the audit surface, so it is safe now; **doing this
  before §8 would have minted a batch of invisible classes**. The order cannot be
  swapped.
- **`app.css`'s stacking contexts**. `.panel-tabs` / `.drag-ghost` /
  `.divider.dragging` take part in the z-index and transform of a drag, and
  moving to variants swaps out selector specificity. Verify by tearing a tab out;
  tests do not cover this (`view-drag.test.ts` pins geometry, not stacking).

### 11.6 Not in this round

- **The five pairings below the contrast floor from §10.5**. They are debt, but
  the fix changes how the product looks, which is a different thing from
  "converging the stylesheet structure"; mixed into one round, neither side can
  be stated clearly. The `BELOW_FLOOR` ratchet already pins the measured values,
  so they cannot get worse.
- **The database package UI** (`packages/db-neo4j/ui/`), for the same reasons as
  §1.3 and §4.4, unchanged.

---

## Section 11 · Tearing down the unlayered-CSS wall (the form-control half)

§7.1 recorded half of it: `base.css`'s `button` element rules have to go into
`@layer base`, or the control layer fails wholesale. That section's last sentence
reads "`input` / `select` / `textarea` stay unlayered; handle them the same way
when the form module migrates." This section is that step, plus the third module
it failed to cover.

### 11.1 Who this wall blocked — three records, one fact

Stage 2 had three agents each run into it, all three routed around it, and **all
three wrote down why they did** (worth one separate word of praise: the three
comments put together are this change's entire requirement):

| module | the detour they wrote | what was holding it down |
|---|---|---|
| chat | `.chat-input { line-height }`, `.chat-mode-select` (including `.permissive`) left in `chat.css` | `base.css`'s unlayered `input, select, textarea` |
| views | the vector-query bar's `input.vq` / `.vq-id` / `.vq-name` / `.vq-num` left in `views.css`, explicitly marked "blocked, not declined" | same |
| grid | `GridFooter`'s `borderTop` / `borderBottom` can only be written as an inline `style` | `components/app.css`'s unlayered `.toolbar` |
| chat | `.chat-toolbar { gap: 8px }` left in `chat.css` | same |

**The first two rows are fixed here, the last two are not, and should not be
fixed here** — the reason is in 11.4.

`font: inherit` is the nastiest one in the pile and deserves naming: it is a
shorthand, and it takes `font-size` and `line-height` with it. So the composer's
`line-height: 1.5` is not "somebody forgot to write a utility" — it is that
**no** `leading-*` can win against a declaration nobody meant to write.

### 11.2 The move: `input, select, textarea` into `@layer base`

Exactly what §7.1 did for `button`, in the same `@layer base` block, right after
those `button` rules. `input:focus` moves with them.

**What did not move** (judged one by one, not overlooked):

- `*` / `html, body, #root` / `body` — body is not rendered by React, no
  className can attach to it, so there is no contest between it and the
  utilities;
- `::-webkit-scrollbar*` — pseudo-elements, same;
- `.mono` / `.cm-*` / `.layout-root …` / `.sr-only` — these are **classes**, not
  an element floor. `.mono` (0,1,0) already outranks `input` (0,0,1) on
  specificity, so layering makes no difference to it; layer it for real and any
  `font-*` utility other than `font-mono` could knock the monospace out, and
  that is a different decision, not this one.

The three post-migration writings:

| before | after | measured |
|---|---|---|
| `.chat-input { line-height: 1.5 }` | `leading-normal` on the composer's `<textarea>` | `--leading-normal` is exactly 1.5, computed 18px (12px × 1.5), unchanged |
| `.chat-mode-select { padding: 1px 4px; font-size: var(--text-sm) }` | `px-1 py-px text-sm` | 11px / 1px / 4px, unchanged |
| `.chat-mode-select.permissive { border-color; color }` | `border-warn text-warn`, joined with the row above into **two complete literals** behind a ternary | amber `rgb(224,179,65)` on four borders and on the text, unchanged |
| `input.vq { flex: 0 0 auto; height: 22px; padding: 0 6px; font-size: var(--text-sm) }` | `flex-none h-5.5 px-1.5 py-0 text-sm` | 22px / 0 / 6px / 11px, unchanged |
| the 190 / 110 / 70px of `.vq-id` / `.vq-name` / `.vq-num` | `w-47.5` / `w-27.5` / `w-17.5` | 190 / 110 / 70px, unchanged |

`px-1.5` sets only left and right, so a `py-0` has to come with it: the old rule
`padding: 0 6px` set all four sides, and `padding-inline` and `padding-block`
are two different families, so this is not the same-family conflict §7.2
describes.

**Not one number was rounded**, so there is no §7.3-style record to write this
time. The four widths land on half-steps of the multiples of 4 (47.5 / 27.5 /
17.5), which is more honest than minting three tokens: they are not rungs on a
ladder, they are the widths of four fields.

### 11.3 The layer's semantics changed, and changed correctly — two things to state

Once they are inside the layer, `@layer utilities` beats this floor from now on.
Two consequences that **are not side effects; they are what this change buys and
what it costs**:

1. **`font: inherit` still has to be inheritance**, word for word the same
   conclusion §7.1 reached for `button` — an 11px input in the status bar should
   be 11px. A component that wants a different rung writes that rung itself and
   writes nothing else.
2. **`outline: none` and `:focus`'s `border-color` can now be overridden by
   utilities.** So "a component wrote its own border colour" now means "it has
   also taken over the focus colour". The only thing doing that today is the
   permissive mode select (it stays amber while focused), and **it behaved that
   way before this change** — `.chat-mode-select.permissive` (0,2,0) already
   outranked `select:focus` (0,1,1). The behaviour did not change, but it went
   from "one local coincidence" to "a general property", so it goes into a
   comment in `base.css`.

### 11.4 Where `.toolbar` belongs: `@layer components`, but not moved by this change

`.toolbar` is indeed the wall blocking the grid footer and
`.chat-toolbar { gap }`; confirmed by measurement (`components/app.css:616`,
unlayered, declaring `gap` and `border-bottom`).

**It does not belong in `@layer base`.** `@layer base` is the element floor —
"what a `<button>` nobody has claimed looks like". `.toolbar` is **the window's
shared vocabulary**: six views, error-center and the chat panel wear it in eight
places altogether, and app.css's head comment lists this category separately as
"category 2 of what stays: other modules are wearing it". Where it should go is
`@layer components`, and `theme.css`'s first line
`@layer theme, base, components, utilities;` declares that layer **for exactly
this** — named component classes below the utilities, so the call site can
override them.

**It was not moved here, and the reason is a boundary, not laziness**:

- `components/app.css` is not on this change's file list; Stage 2's split handed
  it to another pair of hands;
- moving it would change the cascade on eight elements at once. Each of the
  eight has to be measured again (`ErrorCenter.tsx`'s `toolbar flex-none`
  happens to be the same value as `.toolbar`'s own `flex: 0 0 auto`, which is
  the harmless kind; but "harmless" is a measured conclusion, not a visible
  one). This is one independent change by app.css's owner, with one independent
  verification.

So what stays behind is **two comments and a destination**: the `.chat-toolbar`
line in `chat.css` spells out who it is waiting for and which layer it is
waiting on; the footer element in `DataGrid.tsx` spells out why those two inline
borders **have to** be inline. The latter had no explanation at all — an inline
style that looks like laziness is in fact the only writing that works under the
current cascade, exactly the "a missing comment costs more than a wrong one"
that Stage 2's app shell recorded.

### 11.5 Verification: 319 elements compared property by property, plus one negative control

§5.1 requires the inverse check to actually run. The method here is to mount the
**real components** into Electron's own Chromium with `react-dom/client`
(`renderToStaticMarkup` will not do: several components go through
`useSyncExternalStore` and have no server snapshot), on top of **the built CSS**,
then read 70 computed properties plus `getBoundingClientRect` off every element
of the whole tree by DOM path.

Coverage is "every `<input>` / `<select>` / `<textarea>` the renderer can draw":
the connection dialog (driver select, text fields, checkbox, `mono` field),
settings' four sections (About / Timeouts / MCP / Agent), the table view's
pagination select, the vector-query bar, chat's two mode selects, the composer's
two states. **16 inputs, 4 selects, 4 textareas** in total, 319 elements.

Both runs are real builds: first revert the four source files this change
touched by character-exact reverse replacement, `pnpm build`, measure once;
restore them, `pnpm build`, measure again.

```
paths only in before: 0
paths only in after : 0
elements with a class-string change:  10
elements with a computed-style change: 0
elements with a box-rect change:       0
```

**Ten elements changed class string; zero elements had a computed style or a box
rect move.** The four query fields are still 190×22 / 110×22 / 70×22 / 70×22 at
11px; the composer is still 882×34 with an 18px line height; the two mode
selects are still 137×19, 11px, 1px 4px padding, and the permissive one still
has `rgb(224,179,65)` for its border and its text.

**The negative control was run, and on the path that matters most**: take only
`base.css`'s form block back out of `@layer base` (class strings stay as they
are after migration), rebuild and measure again — **26 elements regress
immediately**: the four query fields 11px→12px and block padding 0→3px; the two
selects 11px→12px, padding 4px→6px, amber back to grey, box growing from 137×19
to 150×25; the four composers' line height 18px→17.4px. That is the wall itself,
measured. So the "0 differences" above is not a comparison of two unstyled
trees.

**And it was actually looked at, not only measured**: one screenshot each of the
vector-query bar, both chat toolbars, the composer, the grid footer and the
connection dialog. The query bar's fields are short and flush, the permissive
mode select is amber-bordered with a ⚠, and the grid footer's line is on top.

### 11.6 Three by-products, written down so the next person does not look them up again

- **`chat.css` drops from 11 declarations to 6**, and group 1 ("held down by an
  unlayered rule elsewhere") from three to one. The head comment's "Nine
  declarations survive here, in four groups" had both numbers wrong; corrected
  to the measured values on the way past.
- **`views.css` loses a whole group**, from "three reasons" to "two reasons",
  and both survivors are permanent — this file is no longer waiting on anyone.
- **Build output CSS 43.28 kB → 43.07 kB**. What went is exactly those 7 rules
  minus the 4 new utilities. (This number was measured on a tree **another
  session was editing at the same time**; see the process note at the end of
  Stage 3. In that same round `theme.css`, `components/app.css`, `base.css` and
  `grid.css` were all touched by someone else, so do not take the last digit
  seriously.)

### 11.7 One point where the handover does not match the measurement

The handover says chat's three lines "become `gap-2` / `leading-normal` /
`text-sm` once the wall is gone". Of those, `gap-2` **cannot be had here**: what
blocks `.chat-toolbar` is not `base.css`'s form block but
`components/app.css`'s `.toolbar` — two walls that look alike and are not the
same wall. 11.4 is the answer to that one.

---

## Section 12 · `grid.css` cleared out (§11.4 step 2)

§11.4 described this step as "conditional on refactoring `cellClass()` in
`util/format.ts`". The premise is right, but it is only one of three things.
Recorded below as "what was done / why this way / what was measured".

### 12.1 What is left is two rules, not three groups

Stage 2's grid agent listed three groups of reasons for leaving things behind;
the third (`.grid-cell` / `.grid-rownum` / three row-state rules) **does not hold
as a group**:

- "`cellClass()` lives in another file" is a **split accident**, not a technical
  obstacle. This round got that file;
- "rows colour cells through a descendant selector, and a class string has no
  notion of descendants" is the judgement §11.2 corrected. The real answer is
  `group` + `group-hover:`, plus **picking one complete literal in JS**.

`grid.css` drops from 201 lines (about 101 lines of code) to 87 lines (16 lines
of code). What remains:

| | code lines | why it has to be CSS |
|---|---|---|
| `.grid-scroll` (then called `.grid`, see §12.9) | 11 | `overflow-anchor` and `contain` have no utilities, and the other three are the same decision |
| `.grid-row` | 1 | `font-size: 0`. The type scale has no such rung and should not have one; `type-scale.test.ts` exempts it **by value** |

### 12.2 Why the five backgrounds are not four `group-data-*` variants

A cell's background has five states: at rest, zebra stripe, row hovered, row
added to chat, cell focused. The old writing ordered them by **selector
precedence plus order within the sheet** (the zebra stripe is written after
hover so it wins the tie; the focus rule uses `!important` to hold the first two
down).

A literal translation to
`bg-bg group-data-…:bg-bg-stripe group-hover:bg-bg-1 group-data-…:bg-row-sel` is
**four classes from one family** — precisely what §7.2 describes; who wins is
decided by Tailwind's output order, and this round measured
`group-hover:bg-bg-1` sorting **after** `.bg-bg-stripe` (15755 vs 24864 in the
build output), while nothing documented promises any relative order between
`data-*` and `hover`. Betting an invisible failure on Tailwind's sort order is
not worth it.

So: **the pointer is the only state JSX cannot observe, and it is the only one
left in CSS** (`group` on the row, `group-hover:` on the cell); the other four
are chosen in `cellSurfaceClass()` as **one complete literal**, each with
exactly one `bg-*`. `!important` disappears entirely as a result — there is no
second background left to hold down.

`.grid-row.row-selected .grid-rownum` is the same: the row number has two
complete class strings, one or the other depending on selection.

### 12.3 The `cellClass()` refactor, and the exact boundary of the rule in §11.5

§11.5 requires it "written as lookup constants, not template concatenation".
Landing it split that sentence one level finer, because it is easy to read as
"not a single character may be concatenated":

- **What cannot be concatenated is the token itself.** With `'text-' + kind`,
  Tailwind never sees `text-warn`, so that rule is never generated and the cell
  silently loses its colour — the audit not seeing it and the build output not
  containing it are the same thing.
- **What can be concatenated is whole strings.** In `` `${CELL} text-right` ``
  both halves are literals in this file, and after §8 the scanner reads raw
  bytes, so every token in both halves has already been seen. The real criterion
  is "does every token appear in complete form in a scanned file", not "is there
  a `+` at runtime".

So `format.ts` has one `CELL` base string plus six constants derived from it
(computed once at module load; `cellClass()` still only returns constants and
allocates nothing), and the backgrounds are another four constants. The call
site joins the two halves with one space.

One incidental fact: the two names `.grid-cell` / `.grid-rownum` stayed, for the
same reason as in §"the `grid-*` names are kept", only one notch weaker —
nothing outside selects on them, but `.grid-row` has to stay as a selector
regardless (`font-size: 0`), and the
`document.querySelectorAll('.grid-cell')` typed by hand during acceptance and
debugging is what this family of names is actually for.

### 12.4 Five new tokens

| token | value | why |
|---|---|---|
| `--color-row-sel` | `color-mix(in srgb, accent 24%, bg)` | it was an inline `color-mix` in `grid.css`; a utility cannot hold an expression |
| `--color-rownum-sel` | `color-mix(in srgb, accent 24%, bg-1)` | same, the row-number half |
| `--leading-cell` | `calc(var(--spacing-row) - 1px)` | the cell's line height **derives from the row height**, not from the number 23px |
| `--leading-row` | `var(--spacing-row)` | same for the row number's line height |
| `--shadow-gutter-sel` | `inset 2px 0 0 var(--color-accent)` | the 2px line to the left of a selected row number; inset so it does not eat layout |

The two `--leading-*` come with a **semantic loss, written down in `theme.css`**:
a custom property expands its own `var()` **at the point of declaration**, so
what they freeze is `--spacing-row` as it stands on `:root`. Nothing overrides it
on a subtree today; the day something does, this pair will not follow. This is
the same CSS rule the `--spacing-form-label` passage recorded.

### 12.5 Naming two colours drags two long-running contrast problems into the audit

The moment `--color-row-sel` / `--color-rownum-sel` enter `@theme`,
`theme-contrast.test.ts` reports two combinations below 4.5:1. **Neither was
introduced here** — both colours have been painting since "add rows to chat"
shipped, only written as an inline `color-mix` in `grid.css`, which is
structurally out of the audit's reach. This is the third time the same thing has
happened (`#7a3f3f`, `--color-bg-stripe`, and these two).

Both go into `BELOW_FLOOR` the established way, pinning the measured value and
stating the fix, **without changing the appearance this round** (§11.6):

- `--color-fg-faint` on `--color-row-sel` = **3.56:1** (a NULL cell in a
  selected row). Fix: NULL in a selected row switches to `--color-fg-dim`
  (5.45 there), or bring the 24% down.
- `--color-accent` on `--color-rownum-sel` = **4.00:1** (a selected row's row
  number). Tinting the ground toward its own ink is the one operation that must
  cost contrast: the same blue on an untinted row-number ground is 5.98. Fix:
  the row number switches to `--color-fg` (7.82); the hue has already been said
  twice, by the ground and by that 2px line.

The `SURFACES` line saying "a data cell has four backgrounds under it" changes
to five, and the `where` on the `--color-bg-sel` line is corrected: it is **the
one focused cell**, not "a cell added to the selection" — the latter was always
that nameless `color-mix`.

### 12.6 Verification: measured inside Electron, not eyeballed

**(a) Property-by-property comparison.** Inject the pre-migration `grid.css`
verbatim into the actually running app under an `o-` prefix; two equivalent
subtrees, 16 states, 62 properties (including `getBoundingClientRect`), 992
comparisons in total. **33 differences, all of them in two known categories, and
no 34th:**

- **32 are zero-width `border-*-color`.** `border-border` sets a colour on all
  four sides; the old rule only set it on the one with width. The other three
  are `border-style: none` at width 0 and do not paint a pixel. This is exactly
  the general Tailwind behaviour every module recorded in Stage 2.
- **1 is the selected row number's `box-shadow`**: Tailwind's `shadow-*`
  assembles five slots, the last of which is byte-identical to the old value
  (`rgb(77,156,255) 2px 0px 0px 0px inset`), and the first four are
  `rgba(0,0,0,0) 0 0 0 0` — transparent, zero-sized, not painted.

Height, line height, padding, background, text colour, font size, font,
alignment, ellipsis, z-order, cursor, outline (colour/style/width/offset) and
box rect are **all identical**. Including: cell `24px / 23px / 6px 6px /
11.5px`, row number `24px / 24px / 0 7px / 11px / 54×24`, row `font-size: 0px`.
The `color(srgb …)` strings the two new tokens generate are **character for
character** the old inline `color-mix`.

**(b) Real mouse events.** Hover real rows with CDP's
`Input.dispatchMouseEvent`: at rest `rgb(22,24,28)` → hovered `rgb(27,30,35)`
(`--color-bg-1`) → restored on leave. An odd row at `rgb(30,34,40)` (zebra
stripe) also turns `rgb(27,30,35)` on hover — that is, `group-hover:` really
does beat the `bg-bg-stripe` in the same string. After clicking the row number
to add row 3 to the selection, cell = `color(srgb 0.138039 0.218353 0.323451)`,
row number = `color(srgb 0.152941 0.236235 0.344314)` plus `rgb(77,156,255)`
text plus that inset 2px; **hover it and not one byte changes** (the old rules
behaved the same). Then click a cell: `rgb(22,50,79)` plus `rgb(77,156,255)
solid 1px @ -1px`, and that was a NULL cell — the focus state still beat the
row's ground **with no `!important`** in play.

**(c) One million rows scrolled to the bottom.** SQLite fixture,
`SELECT * FROM bench`, 1,000,000 rows streamed through: at the bottom the DOM
holds 33 rows, numbers 999,968–1,000,000, **the last visible row number is
exactly 1,000,000**, and the difference in `getBoundingClientRect().top` between
adjacent rows is **24px** (24 at the top and at the bottom). Back at the top,
1–31. Not a byte of the scroll maths moved: `ROW_H` is still the 24 in
`vscroll.ts`, `--spacing-row` is still 24, `h-row` reads exactly that, and there
is no extra layer in between.

### 12.7 Five new cases in `grid-layout.test.ts`, each verified in reverse

The new structure fails **silently**: drop a `group` from the row and the whole
grid simply stops highlighting the hovered row — no error, no missing class. So
five cases are pinned, and each was run once against deliberately broken source
to confirm it goes red (with `shasum` afterwards to check the file was
restored):

1. the row must carry `group`, and a cell at rest must have one
   `group-hover:bg-*`;
2. each of the four surface constants may have **exactly one** unvariant `bg-*`;
3. a selected row must not carry `group-hover:` (under the old rules it did not
   change on hover), and the same for a focused cell;
4. `--spacing-row` and `vscroll.ts`'s `ROW_H` must be equal, and the row must
   wear `h-row`;
5. `.grid-row` in `grid.css` may declare `font-size` and nothing else, and no
   `.grid-cell` / `.grid-rownum` rule may appear — this sheet is **unlayered**,
   and one extra declaration silently beats the class strings on the elements.

### 12.8 One stale comment fixed on the way past

`styles.css`'s head comment used "`.grid-row.odd` is written after the hover
rule and so wins the tie" as one of the two examples that "the order of this
list is load-bearing". That rule is gone; the tie is now decided in
`cellSurfaceClass()`. The only example left is settings overriding the form
gutter.

### 12.9 Something this round did not introduce but did measure: `.grid` collides with a utility, renamed

The identity name `.grid` is also Tailwind's `display: grid` utility;
`.grid{display:grid}` has always been in the build output, and it was in the
pre-migration build output too — **not introduced this round**.

This section's first version stopped at "so the scroll container is a grid
container rather than a block, which looks harmless", and left it for whoever
touched it next. The next round came back and measured **the other direction**
too, and the conclusion reverses: the harmful direction was never the one you
think of first.

**Two directions, only one of them harmless.**

- **identity name → utility**: `DataGrid`'s scroll container picks up one extra
  `display: grid`. It has exactly one child (`grid-inner`, `h-full` plus an
  inline width), so this direction really is harmless.
- **utility → identity name**: `FirstRunGuide.tsx:73` writes
  `className="empty-hint grid gap-3.5"`, where that `grid` **really is being
  used as a utility** and wants `display: grid`. And `components/grid.css` is
  `@import`ed by `styles.css:38` and is **unlayered**, and unlayered rules beat
  everything in `@layer utilities` — so the first-run hint box is wearing the
  scroll container's entire rule.

Measured against the build output in Electron 43 (a probe, with a control that
is the same box minus `grid` plus a hand-written `display:grid`), nine
declarations differ:

| property | FirstRunGuide measured | should be |
|---|---|---|
| `flex-grow` / `flex-basis` | `1` / `0%` | `0` / `auto` |
| `overflow-x` / `overflow-y` | `auto` / `hidden` | `visible` / `visible` |
| `overscroll-behavior-y` | `contain` | `auto` |
| `overflow-anchor` | `none` | `auto` |
| `position` | `relative` | `static` |
| `background-color` | `rgb(22,24,28)` = `--color-bg` | transparent |
| `contain` | `layout paint` | `none` |

Of these, `background` is **visible today**: the sidebar is `bg-bg-1`
(`#1b1e23`) and the first-run guide paints a darker `--color-bg` (`#16181c`)
rectangle on top of it. The rest do not show today only because the parent is a
block at auto height; put `overflow-y: hidden` plus `contain: layout paint`
inside a height-constrained parent and content gets clipped **with no scrollbar
to reach it**.

**So only a rename fixes it.** The other candidate is to keep the name and write
`display` out explicitly inside the `.grid` rule. That plugs only the first
direction and makes the second worse: `FirstRunGuide` would lose even the
`display: grid` it actually wants, and still take all nine of the others.

`.grid` → `.grid-scroll`. With that the family is complete too — `grid-wrap` /
`grid-scroll` / `grid-inner` / `grid-surface` / `grid-overlay` / `grid-row` /
`grid-vsb`, and **not one of them is a bare utility name**. The bare `grid` was
the sole exception, and now it is gone.

Where it landed: `components/grid.css` (rule and comments), `DataGrid.tsx`
(class string and comment), `__tests__/grid-layout.test.ts`
(`byClass(all, 'grid')` and `cssBlock('.grid')`, plus one new assertion), and
the comments naming it in `GridScrollbar.tsx` / `vscroll.ts` / `chat.css` /
`context-actions/index.ts` / `base.css`. `docs/PLAN.md §8` counts
`.grid-surface` and is unaffected.

The new assertion pins **the shape** rather than this one name: every class
selector in `grid.css` must start with `grid-`. A bare name is the only writing
that can collide with a utility, and this sheet is unlayered, so a collision
takes effect silently.

**The shape to leave for the next person**: an identity name that happens to
collide with a live utility is the only collision shape that takes effect
silently when named classes and utilities coexist; and it **collides in both
directions**, with the direction you think of first usually being the harmless
one.

### 12.10 Working on a moving tree again: one real loss, and one false alarm

The end of Stage 3 recorded that "the sweep was done on a moving tree". Both
things happened this round, and they **look very alike and are nothing alike**,
so they are worth writing separately.

**One real loss.** The five tokens just added to `theme.css` were overwritten
file-wide by another session; they were put back verbatim with a targeted Edit —
no `git checkout`, nothing rewritten from memory.

What found it was an assertion, not an eye: `theme-contrast.test.ts`'s palette
census reported `--color-row-sel is not defined in @theme`. **That census is the
only thing that goes red because a token disappeared** — had `--leading-cell`
been the casualty, it would only have shown up as the cell line height silently
becoming `normal`, and no test would have gone red. This is the second use of
the rule that "every `@theme` colour must be seen by some assertion": it was
written to stop the audit missing one, and it also happens to stop a file being
overwritten.

**One false alarm.** For a minute afterwards, the whole tree was back at HEAD:
`git status` empty, `theme.css` and `grid.css` gone from disk,
`GridScrollbar.tsx` back to its pre-migration form. `git reflog` was

    9a023b4 HEAD@{2026-08-04 19:12:44}: reset: moving to HEAD
    9a023b4 HEAD@{2026-08-04 14:34:47}: reset: moving to HEAD

which looks exactly like a whole day of uncommitted work being
`git reset --hard`ed away by someone. **It was not.** A minute later every file
was back unchanged, `shasum` by `shasum` identical to the manual copies; the
14:34:47 entry has the same shape, and the migration plainly survived that one.
"Hash every modified file into a loose blob → hard reset → write it all back
out" is a **snapshot mechanism**, not an accident; those 42 loose blobs at
19:12:44 are that snapshot's content-addressed copy.

The rule this leaves: **in this repository `reset: moving to HEAD` is not by
itself evidence that work was lost**, and neither is an empty `git status` —
look again a few seconds later. What is evidence is a test going red.

(The minute spent on it was not wasted: 214 unreachable objects, along with
mtimes, a content identification index and a candidate path mapping, were all
exported to `RECOVERY/` in the scratchpad, where `git gc --prune` cannot take
them. The cost was a few minutes.)

**Do not take the build-output size seriously this round.** 43.07 kB → 41.44 kB,
but in the same round `PanelTabs.tsx`, `theme.css` and several `.tsx` files were
changed by someone else; that delta is not the grid's alone.

---

## Section 12 · Clearing `app.css` (round 3 step 1, the first item in §11.4)

`components/app.css`: **811 lines / 451 code lines → 536 lines / 203 code lines**, rules down
from 84 to 36, 125 declarations. This section records what §11.2's correction looks like once
actually delivered, and three things measured along the way that are **unrelated to the
migration and were broken to begin with**.

### 12.1 §11.2's corrections were delivered one by one, with none left over

| The "utilities cannot reach it" of round 2 | How it is written this round | Checked in the build output |
|---|---|---|
| `.divider::after` draws the 1px line (both directions) | `after:absolute after:inset-0 after:m-auto` + single-axis 1px | the `after:` variant carries `content:var(--tw-content)` itself |
| `.divider:hover::after` / `.divider.dragging::after` | `hover:after:bg-accent` / `data-dragging:after:bg-accent` | variants emit after the variant-less rule |
| `.split[data-dir='row'] > .divider` | two complete literal class strings, picked by `dir` | — |
| `.panel.focused .panel-head` | `group-data-focused/panel:bg-bg-3` | `:is(:where(.group\/panel)[data-focused] *)` |
| `.panel.focused .panel-tab.active` | `group-data-focused/panel:before:bg-accent` | same as above |
| `box-shadow: inset 0 2px 0` on `.panel-tab.active` | `before:absolute before:inset-x-0 before:top-0 before:h-0.5` | measured 2px, at the top, accent |
| `.panel-tab.provisional .tab-title` | a ternary in the JSX (the state lives in the same component) | — |
| `.panel-tab:hover .tab-close` / `.panel-tab.active .tab-close` | `invisible group-hover/tab:visible focus-visible:visible` | — |
| `.dot.idle|ready|error` | the `CONN_DOT` lookup constant, **five complete literals** | — |
| `-webkit-app-region` on `.titlebar` | `@utility app-drag` / `app-no-drag` in `theme.css` | — |

**Both groups must be named** (`group/panel`, `group/tab`). A bare `group` will not do, and that
is measured: `util/format.ts` writes `group-hover:bg-bg-1` on cells, and today nothing wears
`group`, so it is dead; the moment the panel puts on a bare `group`, moving the mouse into a
panel lights up **every single cell**.

### 12.2 The `--animate-*` route does not work for the connection indicator, and it turned up a broken keyframe in the build output

The table in §11.2 says "`@keyframes` + animation shorthand → `@theme { --animate-* }`". That
holds for chat. It does **not** hold for `.dot.connecting`: Tailwind's default theme ships
`--animate-pulse` **and a `@keyframes pulse`** of its own — a name collision.

Plant `--animate-probe-pulse: pulse 1s …` and build, and the output has exactly one
`@keyframes pulse`, Tailwind's (`50%{opacity:.5}`).

**Then something more important got measured: plant nothing, and a clean tree behaves the same.**
Change that step in `app.css` to a unique value (`opacity: 0.123`) and rebuild, and it cannot be
found anywhere in `out/renderer/assets/*.css` — **our `@keyframes pulse` has never made it into
the build output**. So:

- the connection indicator actually pulses to **0.5**, not 0.25;
- `ALPHA_SITES` in `theme-contrast.test.ts` has been auditing a number the product does not use.

**Not fixed this round**, because the fix is to rename the keyframe, while `ALPHA_SITES` keeps
its books by name and that test is not on this round's file list. Both sides have to change in
one go. The rule in `app.css` carries this note, marked as a finding rather than as something
introduced.

### 12.3 Three things that were **broken before the migration**, visible only once measured

1. **The divider's hover / drag highlight has never worked.** The old rule
   `.split[data-dir='row'] > .divider::after` (0,3,1) outranks `.divider:hover::after` (0,2,1),
   so the line stayed `--color-border` while hovering and while dragging. Measured in Electron
   with `CSS.forcePseudoState`: `rgb(51,57,65)`, in both states. After the migration it is
   `rgb(77,156,255)` — **this is a behaviour change, and it goes in the direction the comments
   have been claiming all along**, so it is written here rather than buried under "zero diff".
2. **The `.panel.focused` rule is dead.** `.layout-root .panel.focused` (0,3,0) in `base.css` has
   been outranking it all along; measured, the focused panel draws `--color-accent`, not the
   `--color-accent-dim` the rule asks for. Deleting it does not change a pixel on screen; the
   `focused` **class name** stays, because that is what base.css selects on.
3. **The collapsed sidebar handle's `w-full` loses to the size tier.** Collapsed, the sidebar is
   28px, and the handle measures **24×24** rather than 28 wide — `className="w-full"` and the
   `w-6` in `CONTROL_SIZES.md.iconClasses` are two classes of the same family (§7.2), the winner
   decided by emission order, and this time the tier won. The session bar's handle is identical.
   **Not fixed**: the fix either touches `ui/spec.ts` or adds a wrapper, and both are out of
   scope this round.

### 12.4 `tab-close` stays on the ledger, but **for a different reason**

The `CLASSNAME_LEDGER` entry used to say: `.tab-close` is "parent state decides child appearance,
and a class string has no descendant selector". That is precisely the definition of
`group-hover/tab:`, so that reason expires this round — `visibility` is on the button now.

What actually keeps the name on the button is **`scripts/verify-chat-restore.mjs`, which uses CDP
to find it by `.panel-tabs .tab-close` and click it** — the same kind of handle as `.chat-view` /
`.session-item`. The ledger's contract demands "some `<Button>` passes this name" and "some
stylesheet defines it, declaring only properties in `LAYOUT_ONLY_PROPERTIES`", so `.tab-close` is
down to a single `flex: 0 0 auto` (which the button needs anyway: without it, the ✕ is the first
thing a narrow tab squashes). **Zeroing it out means retiring that script's handle**, which is a
change to the script, not to this round's files.

Along the way a gap in the fence got filled: `LAYOUT_UTILITY` had `invisible` but not `visible`,
while `visibility` has long been in `LAYOUT_ONLY_PROPERTIES` and the comment beside it names this
very ✕. **This is not a loosening; it brings the prefix classifier up to the list it claims to be
aligned with**; two `classify` assertions were added to pin it.

### 12.5 New tokens and `@utility` (`theme.css` is a shared file, so this is an append)

- `@utility app-drag` / `app-no-drag` — `-webkit-app-region` has no namespace at all.
  **`app-no-drag` hangs on a `<span>` wrapped around the control**, because the fence classifies
  by prefix and `app-` is neither a layout family nor a paint family, so `<Button>` is not
  allowed to carry it. That is the fence working, not a hole; that `<span>`'s rectangle is the
  button's rectangle, and Chromium subtracts the same region.
**No new tokens.** The `letter-spacing: 0.6px` on the two sidebar heads uses Tailwind's own
`0.05em` step, which at 11px is 0.55px — 0.05px per letter of difference. "That is what the
number used to be" is not a reason for a token (§7.3, which is how the shadow and the 5px radius
were decided). Incidentally the two heads landed on **exactly the same shape** as the section
titles in `ui/Menu.tsx`; they were the same thing to begin with.

### 12.6 The three rules shared by three modules moved into `components/shellClasses.ts`

`.sidebar-head` / `.sidebar-title` / `.dot` are the last three of "two modules wearing the same
class", and the one thing Section 9 said explicitly **could not be done at the time**. They did
not become two copies of a class string; they became **one constant**: `LIST_HEAD`,
`LIST_HEAD_TITLE`, `CONN_DOT`.

A file of its own rather than an export from `Sidebar.tsx`, so the connection dialog and the
first-run walkthrough do not get pulled into the import graph of any module that just wants a 7px
dot (`components/chat/index.ts` says in so many words not to reach back). This file imports
nothing.

`CONN_DOT` is **five complete literals**, not `'dot ' + status`: Tailwind cannot see through
concatenation, and after §8 module constants are inside the audit surface — so a lookup table is
safe and concatenation is invisible.

### 12.7 Verification: compared property by property in Electron, three drag states, plus screenshots

Following Section 9: a real build + real Electron, `getComputedStyle` reading **every** computed
property plus `getBoundingClientRect`, 43 selectors × 6 phases (at rest / forced hover / divider
drag / tearing a tab and holding it over its own bar / over another panel / both sides collapsed).
One real build run before the migration and one after.

**Stacking was measured separately**, because `view-drag.test.ts` pins geometry, not stacking:

| | Before | After |
|---|---|---|
| `.panel-tabs` | `static` / `auto` | same |
| `.panel` | `relative` / `auto` / `overflow:hidden` | same |
| `.panel-drop-overlay` | `absolute` / `5` / `pointer-events:none` | same |
| `.drop-highlight` rectangle | 716,67,458,800 | same |
| `.view-drag-ghost` | `fixed` / `999` / `pointer-events:none` | same |
| `.tab-insert-caret` | `fixed` / `998`, rectangle 343,36,2,30 | same |
| divider guide line | `fixed` / `999` / accent / 2×836 | same |
| divider | `relative` / `z-3` | same |
| `.panel.drag-source` | `opacity: 0.75` | same |
| drop-target border | `rgb(77,156,255)` | same |
| `body` cursor | `grabbing` | same |

There are only five kinds of real difference, and all of them are accounted for:

- **Colour on edges that are not drawn**: `border-r border-border` sets the colour on all four
  edges; the other three are `border-style:none` at width 0 and do not draw a pixel. Generic
  Tailwind behaviour, already recorded in Section 9.
- **Panel radius 5px → 4px** and **sidebar head letter-spacing 0.6px → 0.55px**: two roundings,
  both "no matching step, and the difference is not worth a token", handled the same as
  `.crash-box` / `.gal-row`.
- **`translate` rather than `transform`**: `translate-3.5` uses the standalone `translate`
  property, computed value `14px 14px`, identical rectangle (44.63×23.4, same before and after).
- **`box-shadow` goes from one to "four transparent plus that one"**: the v4 `shadow-*` variable
  chain; it paints the same.
- **`color-mix(in srgb, …)` → `in oklab`**: mixing with `transparent` is premultiplied, the
  second colour contributes nothing, only alpha changes. Convert the oklab values Chromium
  reports back to sRGB and both land exactly on `rgb(77,156,255)` and `rgb(22,24,28)`, byte for
  byte.
- One more curve really did change: the `ease-out` keyword is `cubic-bezier(0,0,.58,1)`,
  Tailwind's `ease-out` is `cubic-bezier(0,0,.2,1)`. It applies to the 90ms slide of the drop
  highlight; noted, not changed.

**Looked at, not only measured**: one screenshot each of at rest, of tearing a tab and holding it
over another panel, and of dragging the divider. In the second, the ghost sits over the target
panel, the highlight block has an accent outline, the source panel is dimmed, and the 2px accent
at the top of the active tab is there — exactly the group that "cannot be measured, only seen".

**One reading is unstable; writing it down so the next person does not read it as a regression**:
the focus ring on `.panel:focus-visible` changes between runs (same code, `rest` has it one time
and not the next), while `document.activeElement` is the panel itself throughout. That is
`:focus-visible`'s heuristic following "was the last interaction a keyboard one", not styling.

### 12.8 Numbers

- `components/app.css`: **451 → 203 code lines** (36 rules / 125 declarations).
  Of those, **95 declarations belong to other modules wearing them** (`.toolbar` / `.sep` /
  `.modal-*` / `.form-*` / `.value-box` / `.view-error` / `.empty-hint` / `.conn-*`); this
  module has 30 left of its own.
- Build-output CSS **41,334 B**; arbitrary-value classes **0 in every family** (`grep` for `-\[`
  in the output, 0 hits).
- `pnpm typecheck` green, `pnpm test` **1508/1508** green (0 failures), `pnpm build` green.

**The baseline handover says 1502; the case count went 1502 → 1507 → 1508 over this round, and
not one of them was added here** — this was checked, and it is worth writing down, because the
next person is certain to trip on it too:

- The only test file touched this round is `ui/__tests__/control-spec.test.ts`, and what was
  added is two `classify` assertions **inside an existing test**. Delete those two and re-run:
  the file is still 35 tests / 11 suites, exactly.
- Adding a source file does not change the case count (verified by planting an empty `.ts`).
- Restore `components/app.css` and `theme.css` to their pre-migration text and re-run: the
  renderer side is still **722 tests / 162 suites**, identical to after the migration.
- The last +1 was caught red-handed: sort and diff the **case names** of two `pnpm test` runs,
  and the extra one is `every selector in grid.css is grid-prefixed`, with three more renamed
  from `.grid` to `.grid-scroll`. The mtimes of `components/grid.css` and
  `components/__tests__/grid-layout.test.ts` are later than this round's last edit — **the grid
  round of §11.4 step 2 is landing in parallel**.

Stage 3 and Section 9 each recorded once that "the sweep is happening on a moving tree"; this is
the third time. **The conclusion: every case total in this document is a reading from one run,
not a contract**; what can be a contract is `fail 0`.

---

## Section 13 · Eight stylesheets merged back into one `styles.css` (round 3 step 4, the last item in §11.4)

### 13.1 What this step did

`theme.css` / `base.css` / `components/app.css` / `components/grid.css` /
`components/views.css` / `components/settings.css` / `components/chat/chat.css` /
`components/context-actions/context-actions.css` — eight files, merged into one
`apps/desktop/src/renderer/styles.css`, the originals deleted, and the two `import './*.css'`
lines in `ChatView.tsx` and `ConsentDialog.tsx` removed with them. There is now exactly one
`.css` under `renderer/`.

**Not one rule changed**, the single hard constraint of this round and the thing everything below
sets out to prove.

### 13.2 Lossless proof: 96 / 5 / 323

Run a string-aware CSS lexer over "the eight files concatenated in order" and over the merged
`styles.css`, and both give:

| | Count |
|---|---|
| Blocks (nested included: every rule inside `@layer base`, every frame inside `@keyframes`) | **96** |
| Top-level statements (the `@layer` declaration, two `@import`s, two `@source`s) | **5** |
| Declarations | **323** |

Sorted, the **selector-path list** and the **declaration list** are byte-identical (`diff` prints
nothing).

Writing the lexer hit two traps, both worth keeping, because the repo's own `decomment()` has the
first:

1. **`@source not './**/__tests__/**'` contains `/**/`**, and a naive `/\*[\s\S]*?\*\//` reads it
   as a comment and then swallows everything up to the next `*/` — which happens to swallow the
   `@theme {` line. Brace depth for the whole file is off by one from there. `decomment()` in
   `__tests__/sourceScan.ts` is the same regex, so **every scan that runs `decomment()` over a
   stylesheet today is blind to the `@theme {` line**. Harmless for now (the tokens themselves
   are past the swallowed span, and the rules are further past that), but it is a real blind
   spot, recorded here rather than patched in passing — patching it touches every assertion that
   reads a stylesheet, which is another round.
2. **`[...css]` splits by code point, `indexOf` counts UTF-16 units.** A comment in `app.css`
   contains a 🔑, a surrogate pair, and the two indices drift apart by one from there on, so
   every later comment loses its closing `/`. `css.split('')` is the correct one.

### 13.3 Order: chat and context-actions come second and third, not where they belong

The merged section order is tokens → context-actions → chat → base → app → grid → views →
settings. The first three look misplaced; they are in fact **the only order that preserves the
cascade**.

Those two sheets used to be `import`ed by components (`ChatView.tsx` / `ConsentDialog.tsx`), and
Vite put them **ahead** of the `@import` chain in `styles.css` — `.ctx-consent` is byte 0 of the
build output. Each has one rule at the same specificity as one in the app section (both 0,1,0)
and loses on position:

| Rule | Opponent | Measured winner |
|---|---|---|
| `.ctx-consent { width: min(520px, 86vw) }` | `.modal { width: min(760px, 86vw) }` | **`.modal`**, the dialog is actually 760px |
| `.chat-toolbar { gap: 8px }` | `.toolbar { gap: 6px }` | **`.toolbar`**, actually 6px |

Both were measured in Electron (an element wearing both class names, `getComputedStyle`), **with
the same result before and after the merge**. Which is to say: these are two rules that were
**already dead before the migration** — two comments each claim to win, and both are wrong.

Moving them to "where a reader expects them" would quietly take a dialog from 760 to 520 and a
toolbar's gap from 6 to 8. That is a product change dressed as a refactor; not this round. The
comments now state the measured fact, and the reason for the section order is in the file header.

**Whether to fix it is a separate matter**: putting `.modal` into `@layer components` (§11.4
already assigns this to the app section's owner) settles both at once, along with the "waiting
for modal to enter a layer" notes written on `.settings-modal` and `.ctx-consent`.

### 13.4 Build output: the same 41,341 B, 138 top-level statements, not one more or one fewer

- **41,341 B before the merge / 41,341 B after** (`shasum` differs, see below).
- Top-level statements **138 → 138**, compared as a multiset of whole statement texts: **0 appear
  only in the former, 0 only in the latter**.
- The only difference is **position**: the 7 from chat / context-actions (`.ctx-consent`,
  `.chat-toolbar`, `.chat-list`, `.md-h1`, `.md-h2` — five rules — plus `@keyframes chat-pulse` /
  `chat-spin`) move from slots 0–6 to slots 4–10, that is, from before the four `@layer` blocks
  to after them. Unlayered rules always beat layered ones regardless of position, and the
  relative order of unlayered rules among themselves **did not change**. So those 7 crossing the
  `@layer` boundary changes no outcome.

Not content with the reasoning, a property-by-property comparison was run: generate one element
for each of the **416 class names** that appear anywhere in the build output, add 15 combinations
that fight each other (`modal ctx-consent`, `toolbar chat-toolbar`, `panel focused`,
`modal settings-modal`, form rows, the CodeMirror host, five `<button>` states, …), render
**465 elements** in Electron, export **every computed property + `getBoundingClientRect` +
`::before` / `::after`** for each, and the two JSON files, before and after, are
**byte-identical**.

### 13.5 `stylesheets()` is down to one element, and it still has to stay (§11.4 step 5)

Both assertions in `sourceScan.ts` (non-empty, contains `styles.css`) still hold and still carry
weight — they guard against "the directory moves and every rule reading it turns into an empty
assertion", and that risk has nothing to do with list length. The function is untouched; a line
was added to the comment: **returning one element is not a reason to delete it**, and the second
stylesheet is one commit away.

Consumers were re-read one by one; five changed, three of them paths and two of them the
**criteria**:

1. `type-scale.test.ts` — three `theme.css` reads become `styles.css`, hoisted into one `SHEET`
   constant; the "across N stylesheets" in the failure message now prints 1, and the wording
   follows.
2. `control-spec.test.ts` — `rootVars()` reads the `@theme` in `styles.css`.
3. `view-drag.test.ts` — `src('../app.css')` → `src('../../styles.css')`. It finds rule bodies by
   selector name, all six names are unique across the whole sheet, and reading the whole file
   makes no assertion go empty.
4. `grid-layout.test.ts` — **cannot read the whole file**. Its last assertion is "every selector
   in this section carries the `grid-` prefix", true of grid's own vocabulary and false of the
   whole window (`.toolbar` / `.modal` / `.panel` are all bare names, and `.grow` is literally a
   Tailwind utility). So each section of the merged `styles.css` opens with a `SHEET: <id>`
   banner line, the test slices by banner, and asserts the slice is **non-empty** and **smaller
   than the whole file** — otherwise renaming the banner turns it into an assertion about the
   empty string. Inverse check: rename the banner and the assertion goes red immediately.
5. `theme-contrast.test.ts` — the literal-colour scan used to be exempted by
   `sheet === 'theme.css' && property starts with --`. With only one file left, exempting by
   filename means **exempting the entire product**. It now exempts by the `@theme` block's
   **offset range** (`decomment` preserves length, so offsets map straight onto the original
   text). That is a narrowing, not a loosening, and it was inverse-checked twice:
   `color: #abc123` in a rule goes red; `--sep-tint: #abc123` **in a custom property** goes red
   too (and that is exactly what the old form missed).

The filename prefix on the five `where` entries in `ALPHA_SITES` becomes `styles.css`. The prefix
carries no information from now on; the selector is the identifier. The interface comment says so,
so the next person does not think module attribution was lost. That two-way assertion (both
`unclassified` and `stale` must be empty) guarantees those five keys are not edited casually —
get any one of them wrong and it goes red.

### 13.6 How much of §11.3's target shape was reached

`@import` · `@theme` · `@utility` sit at the top of the file in that order. `@layer base` and the
three `@keyframes` were **not** collected at the end of the file: the former stays in the base
section with the element floors it governs, the latter three sit next to the rules that reference
them. Collecting them means moving rules, and this round moves none.

Line count: about 2,100 lines after the merge, roughly 250 of them code — against §11.3's
estimate of "about 240 code lines, with comment density putting the file at 500–600 lines", the
code matches and the total is more than three times the estimate. The gap is all comments: each
of the eight files had a header explaining "why this one still exists", and the merge deleted
none of those reasons (they record **reasons**, not file boundaries). Rather than deleting
comments, the better reading is: this file's comment density is this repo's comment density, not
debt created by merging files.

### 13.7 One thing that is now possible and deliberately not done this round

`@utility` does not expand in a sheet a component `import`s (the chat section's comment recorded
this; it was planted, built and verified). **The merge removes that limit** — these rules are now
in the root sheet. So `overflow-anchor: none` could be defined as a `@utility`, retiring two
declarations at once (`.chat-list` in the chat section and `.grid-scroll` in the grid section).

Not this round, for the same reason as §13.3: this round's value is that "the build output did
not change" was measured rather than hoped for; retiring two declarations is a change, and it
belongs to the round that can measure it. The comment now reads "the limit is lifted,
deliberately not done, this is the first thing to do next".

### 13.8 Readings from this round

- `pnpm typecheck` green.
- `pnpm test` **1508 / 1508, fail 0** (the same reading as before the merge).
- `pnpm build` green, build-output CSS **41,341 B**, arbitrary-value classes **0 in every family**.
- `.css` files under `renderer/` **8 → 1**, `import './*.css'` **3 → 1**.

Per the rule in §12.10: these case totals are readings from one run; what can be a contract is
`fail 0`. No file was `git checkout`ed this round — every destructive experiment was preceded by
a `cp` backup and followed by a `cp` restore, verified with `shasum`.

---

## Section 14 · Three syntaxes the arbitrary-value ban let through (adversarial audit, round 4, F1)

This section overturns one implementation detail in §3.4, and along the way uses
§8's principle about scope once more. **The direction has not changed — it is the
same rule widening from "one spelling" to "four spellings"**, so there is no need
to stop and check back with the user; the conclusion that was checked ("arbitrary
values are banned outright") is followed here to the letter.

### 14.1 §3.4 wrote down a conclusion and landed a substring

§3.4's original text: "arbitrary-value syntax `[...]` is banned outright on colours
and font sizes, **the test just looks for the `-[` substring**". The first half is
the rule, the second half is the implementation. They are not equivalent, and the
gap is three Tailwind v4 syntaxes:

| What was planted | What compiled into the build output |
|---|---|
| A `property:value` pair in brackets used as a class name (arbitrary property) | One rule setting that property to the literal value |
| The same shape written as the `font` shorthand | `font: 9px/1.2 monospace` — below the 11px floor, and the type census reads `font-size:`, so it cannot see the shorthand |
| The same shape **defining** a custom property, paired with the parenthesised variable shorthand to paint | Two rules: one conjures a palette entry out of nothing, the other paints with it |

All three were planted on real elements, run through `pnpm build`, and read back as
literal rule text in `out/renderer/assets/*.css`. While they were planted,
`theme-contrast` was 23/23, `type-scale` 5/5, `control-spec` 35/35 — **all green**.

(The `<Button>` className fence stops all three: it classifies by prefix and denies
unknowns by default. The global ban does not. §3.3 said the fence is "stricter than
before the migration"; this is the second time that sentence has been cashed in.)

### 14.2 Why widening the ban alone gets you nothing

`sourceScan.ts`'s `CANDIDATE` **cannot start a match at `[`** — its shape is
"family name → optional `-` segments → optional `/` modifier", and every candidate
starts with a letter or a `-`. So these three spellings were never returned as
candidates at all, and no amount of widening the ban would have caught them.

Worse is what it did return: the `property:value` pair inside the brackets was
extracted as **the property name itself** — a family name that looks entirely
plausible. That is the worst failure shape there is: indistinguishable from a real
hit. The custom-property one does not even produce a candidate: `(?<![\w-])` is
blocked by the `-` in front of it.

So the regex and the ban must **change in one step**. This was verified before
touching anything, not reasoned about.

### 14.3 How the scope was set: calibrating against the real compiler again

Following the rule laid down in §8 — **the scope may be wider than Tailwind, never
narrower** — another batch of 20 probes carrying unique hex values, `pnpm build`,
grep the output. What compiles (all 20 of them did):

- `[property:value]`, `[property:value]` containing `url(...)` and `oklch(...)`,
  `[background-shorthand:...]`;
- `[--custom-property:value]`, plus the matching parenthesised variable shorthand
  (`family-(--name)`, `family-(type-hint:--name)`); the same holds for the length
  families and the shadow family;
- with a variant in front (`hover:`), with a **bracketed selector variant**, with
  `supports-[...]`;
- Tailwind's important marker in front and at the back — both compile.

A second batch of probes calibrated the **boundaries**, confirming that Tailwind
itself also rejects: brackets whose first character is an uppercase letter, an
underscore, a digit, `{`, `.` or `$`; brackets with no colon; a colon with nothing
after it. (`[https://...]` also fails to reach the output, but the reason is that
Lightning CSS drops the invalid declaration, not that Tailwind refused — so the ban
does **not** lean on that one; it judges by "would Tailwind accept it", which is one
notch wider than the build output.)

### 14.4 The new `CANDIDATE`, and which shapes it now collects

Two named sub-patterns (`BRACKET` / `PAREN`, neither allowing whitespace or quotes,
both allowing one level of nesting), and candidate = optional variant chain +
(bracketed arbitrary property | family-name form). Brackets now appear in three
positions: after a family name (arbitrary value), standing alone where the family
name would be (arbitrary property), and followed by a colon (selector variant).
Parentheses appear after `-(` and `/(`.

**The important marker is deliberately kept out of the candidate**: the match starts
after a leading `!` and ends before a trailing `!`, so the bracketed part still comes
back, the ban still sees it, and `!` never lands in front of the token to disturb the
other three tests that classify by prefix.

### 14.5 The ban splits into three by shape, and each says which one it is

`-[` (arbitrary value), `(?:^|:)\[[-a-z][^\]]*:[^\]]` (arbitrary property), `-\(`
(parenthesised variable shorthand). Failure messages give "what this is" and "what
to write instead" per shape, in the same voice as the other bans in this file.

**Not banned**: bracketed selector variants with no value. They route around the
cascade, not the palette; the utility class they qualify still has to pass the three
tests below. And the focus-trap selector in the renderer happens to have exactly this
shape — that one is a DOM query.

### 14.6 False-positive control (this is the number this section has to measure)

After widening, the candidate count across the whole renderer went 116,817 →
**116,943** (+126). Of those:

- **283** candidates contain `[`: `[]`, `[0]`, `[name]`, `[a-z]`, `[...rest]`, regex
  character classes, destructuring, type parameters. All prose or code, none of them
  class names;
- **9** candidates contain `(`, all of them destructuring and regexes with parentheses
  nested inside brackets; not one is a `-(` shorthand;
- **flagged red by the ban: 0.** That is the false-positive count, and it also says
  this round has no existing violations to fix.

Why the discriminator stays quiet on those 283: the arbitrary-property clause requires
the bracket **to start with `-` or a lowercase letter**, to contain a colon, and to
have something after the colon. `[{}()...:...]` starts with `{`, `[0]` starts with a
digit, `[a-z]` has no colon, and `[tabindex]:not` has its colon **outside** the
brackets. Those three conditions are written from Tailwind's own candidate parsing.

`(?<![\w-])` carries most of the quiet along the way: the brackets in `rows[i]` and
`string[]` are welded to the end of a word, so no match ever starts.

### 14.7 Verification (all actually run)

- **Shape 1**: `[background:#7a3f3f]` on the real element at `StatusBar.tsx:59`. Red,
  reporting `components/StatusBar.tsx:59 → [background:#7a3f3f]` plus "an arbitrary
  property — a bracketed property/value pair standing in for a utility".
- **Shape 2**: the same spot with a `font` shorthand at 9px. Red, same shape, whole
  string reported.
- **Shape 3**: the same spot with `[--zz-sneak:#7a3f3f] bg-(--zz-sneak)`. **Two** reds,
  one judged an arbitrary property, one "the parenthesised custom-property shorthand —
  a utility painting from a bare var()".
- **What the old scanner read on the same tree** (all three planted at once): the
  candidates extracted from that line were `div` / `class` / `background` / `font` /
  `bg` / `statusbar` / `flex` / …, and `-[` matched **0** times. The custom-property
  one produced no candidate at all.
- All three restored with `cp`; `shasum` identical to before the experiment
  (`c7c1ae84…`).
- `grep -rn` for the probe markers: **0** under the renderer.
- `pnpm typecheck` green; `pnpm test` **1508 / 1508, 0 failures** (case count unchanged:
  the "the scanner can see those three shapes" case expanded in place to six, no new
  cases); `pnpm build` green, output CSS **41,341 B** (byte-for-byte identical to this
  round's baseline), and **0** class selectors with escaped brackets or parentheses in
  the output.

No `git checkout` and no `git stash` this round.

---

## Section 15 · Three paths the opacity census missed (adversarial audit, round 4, F2 / F3 / F5)

Same as §14: **the rule did not change; it is the same rule widening from "three
spellings" to "four", plus two corrections to how it reads.** The conclusion that
"every alpha in the renderer must be in ALPHA_SITES" has been checked with the user
and is followed here to the letter; there is no need to stop and check again.

Only one file changes: `apps/desktop/src/renderer/__tests__/theme-contrast.test.ts`.

### 15.1 Three holes, all in the reading, none in the rule

| ID | Where the hole is | Consequence |
|---|---|---|
| F2 | The census's class-name regex only recognises variant prefixes shaped `[a-z-]+:`, and **named group variants contain a slash** | An opacity utility under a named group variant: all green; the same utility under a plain hover variant: red |
| F3 | The colour slash modifier (`colour/number`) is not one of the census's paths at all | Three real sites in production, not one of them ever classified; plant a low-alpha background and everything is green |
| F5 | The stylesheet path requires "decimal + semicolon" | `opacity: 40%` — perfectly legal CSS, identical meaning — does not even count as a candidate; all green |

F2 deserves a sentence about cause: **§11.2 is what widened this hole.** That round
eliminated descendant selectors, and it is what pushed this code towards named groups
(`Panel` and `PanelTabs`, two places). In the same breath as closing one hole, the
migration widened another. This is not an accusation aimed at that round; it is one
more instance of the thing this document keeps saying: scope and spelling have to
change together.

F3's second half is uglier: a low-alpha **text** colour does go red, but it goes red in
`type-scale.test.ts`, on the grounds that its colour lookup failed, reporting "this is
neither one of the five sizes nor a colour" — **a failure message that describes the
wrong problem**. The worst thing in an audit is not green; it is red in the wrong place.

### 15.2 The approach

- **A fourth path**: a wide regex collects "anything + slash + digits", then narrows by
  **value** — `paletteColourIn()` peels the family name off a segment at a time, and it
  only counts as a colour if what remains resolves to a `--color-*` in `@theme`. No list
  of "which families take colours", because **a list is exactly what caused every hole
  above** (§10.2 already wrote this down as a rule). The judgement is fail-closed, and
  the argument is this file's first assertion: after `--color-*: initial` the palette is
  a closed set, and a colour utility whose name is not in the table is a dead class that
  generates no CSS. **Anything that can reach the screen has its name in the table.**
  Fractional utilities like half-width and half-offset wear the same punctuation, and the
  discriminator is silent on all of them (measured in 15.4).
- **Variant prefixes take the slash**: `VARIANT` is factored out as a named sub-pattern,
  shared by the third and fourth paths.
- **Percent signs**: `OPACITY_DECL` + `declaredAlpha()`, two spellings with one meaning.
- **The `channel` field**: `opacity` composites the whole subtree (background and text are
  **both** diluted), while a colour slash modifier makes **one coat of paint** transparent
  and the text drawn on top of it lands later, at full strength. One formula for both would
  produce a plausible number for "a rendering the window never performs", so each site
  declares which of the two it is.
- **The `breaches` field**: one site can have both "inks that clear the line" and "inks that
  do not". Without it, a site where one of three inks falls 0.22 short gets exempted whole,
  and the other two measured results are deleted silently. The contract copies `BELOW_FLOOR`:
  pin the number, write down the repair order.

### 15.3 Three real sites, and the numbers measured

The three new `ALPHA_SITES` (all `channel: 'colour'`):

| Site | alpha | Measured |
|---|---|---|
| `components/DropZoneOverlay.tsx:bg-accent/18` | 0.18 | Nothing written on it (the zone-name label carries its own background — that is the next row). Exempt, but what it **covers** was measured: the faintest ink on the panel 4.98 → 3.81, the grid layer 5.29 → 4.08. Exempt on the same grounds as the two keyframes: it exists only while a drag passes over, and nobody reads a cell that the thing they are dragging is covering |
| `components/DropZoneOverlay.tsx:bg-bg/82` | 0.82 | `--color-fg` **9.36:1** (`behind` takes `--color-accent` at full strength, the harshest reading a single token can give). Real rendering 11.78:1 (inside the highlight block), 12.11–12.40:1 (the insertion-cursor copy, landing on the tab strip or the grid). Clears the line |
| `components/chat/ToolCallCard.tsx:from-accent/10` | 0.10 | `--color-fg` 10.03 and `--color-fg-dim` 6.56 clear the line; **`--color-fg-faint` 4.28, below the 4.5 floor** |

**The floor did not move.** That 4.28 is booked under `breaches`: pin the number, write
the repair order. The repair order points at one that already exists in `BELOW_FLOOR` —
`--color-fg-faint` / `--color-bg-hover` 3.79, whose `where` reads "the argument summary
and elapsed time on the tool-call header row". **Same row, same ink, same repair**: change
that row in `ToolCallCard.tsx` to `--color-fg-dim` and it is 6.56 on this gradient and 5.81
under the pointer; one edit clears a pair. This is the fourth time "this file gained a
breach because it gained a name" (#7a3f3f, `--color-bg-stripe`, the two staged-row ones,
and now this).

The gradient's scope is written on the entry: `10%` at the card's left edge, falling to zero
at 55%, and what is measured is **the most saturated end**, because which part of the fade a
given piece of text lands on depends on how long the tool name is, and the test cannot hold
on to an x coordinate. Erring towards strict, in line with the direction of this whole file.

### 15.4 False-positive control

Across every `.ts` / `.tsx` in the renderer (skipping `__tests__`), measured with the real
discriminator as landed:

- Slash-modifier candidates judged to be **colour alphas**: **3**, exactly the three in the
  table above;
- Judged **not a colour** and therefore let through: **2** (`left-1/2`, `-translate-x-1/2`),
  both geometric fractions — **0 false positives**;
- On the opacity-class path, the hit set is **identical** before and after the tightening
  (`components/DataGrid.tsx:opacity-70`, `ui/spec.ts:disabled:opacity-45`) — widening did
  not sweep any existing code in by mistake.

### 15.5 Verification (all actually run; `cp` backup before each planting, `shasum` checked after restoring)

- **F2**: `PanelTabs.tsx:442` — that line already wears a named group variant, on a real
  element. Add an opacity class under the named group variant: **the old regex is 25/25, all
  green**; swap the same spot to a plain hover variant and **the old regex goes red at once**.
  That is the hole itself: the same alpha disappears if you spell the variant differently.
  Under the new regex it is red, reporting
  `components/PanelTabs.tsx:group-hover/tab:opacity-50`.
- **F3 (background)**: `bg-err/12` on the real element at `StatusBar.tsx:59`. **Under the old
  census (three paths), theme-contrast + type-scale + control-spec are 63/63, all green**; the
  new census is red, reporting `components/StatusBar.tsx:bg-err/12`.
- **F3 (text)**: the same spot, `text-fg-dim` swapped for a low-alpha version. Under the old
  census theme-contrast goes red **on nothing at all**; what goes red is two cases in
  `type-scale.test.ts`, reporting "neither one of the five sizes nor a colour" — the worst
  shape in an audit. The new census is red, reporting
  `components/StatusBar.tsx:text-fg-dim/30`.
- **F5**: `opacity: 40%` added to `.empty-hint` in `styles.css` (a real rule). **Under the old
  regex, theme-contrast + type-scale + control-spec + view-drag are 126/126, all green**; the
  new regex is red, reporting `styles.css:.empty-hint`.
- **Inverse check**: the pinned 4.28 really is pinned — it is compared with `assert.equal`, and
  a colour change on either side reports "recorded 4.28, now X".
- Four gates: `pnpm typecheck` exit 0; `pnpm test` **1511 / 1511, 0 failures** (1508 → 1511: one
  real assertion for each of the two new sites, plus a self-test that "the census can see these
  spellings"); `pnpm build` exit 0, still exactly 1 `.css` under `src/renderer`, and **0** class
  selectors with escaped brackets or parentheses in the output.

### 15.6 Build-output size: this round's baseline of 41,341 B became 40,035 B, and this section did not do it

It has to be written down, because it looks like this section's bill. **This section changes
one file, `__tests__/theme-contrast.test.ts`**, and that directory is excluded from the scan
surface by `@source not './**/__tests__/**'`, so by construction it cannot affect the output
at all.

The difference comes from **another agent landing a change in parallel on the same tree**:
when this section started, `styles.css` was `97fb6de6…`; when it finished it was `9b9f1c72…`,
and the extra is an `@source not inline(...)` blocklist (dropping seven candidates that are
both ordinary English words and utility names — `ring` / `inline` / `shadow` and four more —
before compilation), which cost the output seven rules and 1,306 B.

**A process warning for whoever comes next**: doing the F5 inverse check, this section planted
a line in `styles.css` and restored it with a whole-file `cp`. On a moving tree, a whole-file
restore also wipes out whatever somebody else wrote into the same file inside the restore
window. It was checked at the end: the current `styles.css` = this section's backup + that
blocklist, both present. But next time, restore only the lines you planted (`perl -pi` reverse
substitution) rather than overwriting the whole file. §12.10 already recorded "working on a
moving tree" once; this is the second time.

No `git checkout` and no `git stash` this round.

---

## Section 15 · The `font` shorthand, a one-line bypass of the className fence, and the other half of the prose (round 4, F5 type side / F6 / second half of F4)

Three things, sharing one property: **the rule was written correctly and the scope covered
half of it.** Same through-line as §8 and §14 — "the scope may be wider than Tailwind, never
narrower" — except here it becomes "the scope may be wider than the author's spelling".

### 15.1 F5 (type side): the size floor reads a property name, not the property

§3.2 laid down the rule "any text is at least 11px". It landed as a property name: the
stylesheet scan looks for `font-size:`. And the `font` shorthand **also carries a size**,
without containing those nine letters:

```
.mono { font: 9px/1.2 monospace }
```

Planted on a real rule in `styles.css`, `type-scale` is 5/5, all green. The old regex
`/font-size:\s*([^;]+);/` returns `null` on that line — it did not judge wrong, it never saw it.

**Why this one is worse than the others**: the same declaration resets `line-height` while it
is at it. The size half is now visible; the line-height half is **watched by no test in this
repository**, and the shorthand's grammar puts the two side by side. So it is not "one more way
around" — it is the only way around that takes two things at once.

**The approach** (`__tests__/type-scale.test.ts`, scanner only, not one assertion changed):

- New `FONT_SHORTHAND`: `(?:^|[;{])\s*font\s*:\s*([^;}]+)`. Anchored at the start of a line or
  after `;`/`{`, this one clause blocks both neighbours — `font-size:` has a `-` where the colon
  should be, and `--font-ui:` has two hyphens in front of the name, so no match starts.
- `FONT_NO_SIZE`: `inherit` / `initial` / `unset` / `revert` / `revert-layer`. What the renderer
  actually writes is `inherit`, in two places (`button` and the three form elements), and the
  **reason** it is written there is exactly "an 11px button in the status bar should be 11px"
  (§7.1).
- `SHORTHAND_SIZE`: `(?:^|\s)(var\(--text-[a-z]+\)|[0-9.]+px)(?:\s*\/\s*\S+)?(?=\s|$)`. The
  shorthand grammar is `[style||variant||weight||stretch]? <size>[/<line-height>] <family>`, so
  reading it means "find the length". The two accepted spellings are exactly the same as for
  `font-size`.
- **System font keywords (`caption` / `menu` / `status-bar` …) are deliberately left off the
  exemption list**: they do set a size — one this test cannot read and that macOS can change.
  They fall onto the "if you cannot read it, go red" assertion, whose message says outright
  "write it as longhand".

`Declaration.raw` stores **the extracted size token** for a shorthand, not the whole declaration —
the `--text-mark` exemption is judged off `raw`, so `font: var(--text-mark)/1 monospace` remains
legal.

### 15.2 F6: the className fence has a one-line bypass, and the choice was "refuse what you cannot read" over "learn to read it"

`<Button className={PAINT}>`, where `PAINT` is a module-level `const` holding painting utilities.
All three test suites green: the fence uses `attributeClassNames`, which only recognises literals,
while `Button.tsx` pushes that string into `classes` verbatim and the element genuinely wears it.

The comment in `sourceScan.ts` **already stated** this limit ("a className computed from a
non-literal is beyond static reach"), which is honest. What is not honest is `ui/CLAUDE.md`: it
says painting classes are rejected "**wherever they are written**". That sentence is false, and it
is precisely the sentence the next agent will rely on.

Two options; the second was chosen, and the reason is written down:

- **(a) Teach the fence to resolve module-level constants.** Not chosen. Crossing files is the
  first problem (a constant can be imported from another module), but it is not the main one. The
  main one is that resolving one hop covers exactly **one spelling**, `className={CONST}`, while
  reading to the next author as "this class of problem is handled" — a constant built from two
  constants, returned by a function, read off an object, all the same bypass in a different
  spelling, and all of them green again under a parser that follows one hop. This is the isomorph
  of the mistake recorded in §14.1 ("the rule was written correctly and landed as a substring").
- **(b) Keep the limit, fix the document, and make the limit speak up where people will hit it.**
  Chosen — and "speak up" was built as a **refusal**, not just a hint.

Landed (`ui/__tests__/control-spec.test.ts`):

- `classNameExpression()` pulls the source text of `className` on a `<Button>` (braces matched by
  depth, for the same reason `openingTags` has to find its own closing angle bracket).
- `withoutLiterals()` deletes every string literal and **keeps template interpolations**. It
  **deliberately does not use** `sourceScan`'s `blankNonCode`: that treats the whole template as one
  literal and would erase the `${…}` along with it — and `${…}` is exactly where the opaque terms
  hide. "Having a shared scanner is not the same as picking the right variant of it", for the third
  time.
- `opaqueTerms()` judges by **position**: an identifier inside a className expression is either a
  **test** (followed by `? . = ! < > & |`) or a **value** — and a value is a list of class names this
  file cannot see. `true`/`false`/`null`/`undefined` are exempted by name (they cannot render a
  class). No parser needed.
- Hits go into the offenders of `no passed class repaints the control`, reporting "this className
  cannot be read, so nothing here was classified".

**False-positive control**: the renderer today has 5 `<Button>`s with a className, and `opaqueTerms`
flags **0**. The only one containing an identifier is `active ? '…' : '…'` in `PanelTabs.tsx`, where
`active` is followed by `?`, i.e. the test position. So this ban landed with no existing violations
and needs no exemption list.

**The remaining gap in scope, stated plainly**: spreading an object into `<Button>` can carry a
className, and this test cannot see it — the value is in the object, not on the tag. There is exactly
one spread in the renderer today (`ConfirmPair.tsx`, carrying `title`). This is written into
`ui/CLAUDE.md`, not hidden.

### 15.3 The second half of F4: the prose got the "ban" half handled and the "allow" half never was

`ui/CLAUDE.md` has a section explaining "why this file describes the banned syntax in words instead
of writing it out". The `className` section of the same file also has an **allow** list — five real
class names, one per family. All five compile under Tailwind; three of them have no other wearer
anywhere in the renderer, so the output carries three rules **whose only reason for existing is that
this document recommended them**.

Those three are three of the seven dead rules the audit counted: `.mt-2`, `.z-10`, `.self-end`.

The fix is the same as for the ban half — describe by **family**, in English, with the only two real
regexes living in `control-spec.test.ts` as `LAYOUT_UTILITY` / `PAINT_UTILITY` and the document
pointing at them. At the same time, that section is renamed to "why **both** of this file's lists are
written in words", with two additions:

1. **The scanner does not know what a sentence is doing.** "Never write this" and "write exactly this"
   are the same kind of input to it. The rule is about what a sentence **names**, not about whether it
   **recommends or forbids** — and the "recommends" half will keep getting missed, because a warning
   feels dangerous to write and an example does not.
2. **Adding a `*` after a stem is not automatically safe.** It works for families where the bare stem
   is not a utility on its own (`bg` / `text` / `p` / `h` / `font` generate no CSS alone), and fails
   for families where **the bare stem is itself a utility**: border, shadow, outline and ring all
   compile written alone, and the `*` merely breaks the token there. Four such stems have been sitting
   in this file all along. They happen to have real wearers elsewhere, so they cost nothing — and
   "happens to be worn" is luck, not design.

### 15.4 Verification (all actually run)

- **F5 inverse**: `font: 9px/1.2 monospace` planted on `.mono` in `styles.css`, red:
  `styles.css:1088 → 9px (9px)`. The old scope's reading of the same line:
  `/font-size:\s*([^;]+);/` returns **null** on it (printed on the spot), while across the whole
  stylesheet `font-size:` matches 10 times, **not including this one**.
- **F5 fail-closed inverse**: the same spot changed to `font: menu`, red on the "cannot find the size in
  `menu`" case, with a message saying "write it as longhand".
- Both restored with `cp`; `shasum` identical to before the experiment (`styles.css = 97fb6de6…`).
- **F6 self-test**: ten new fixtures in `the fence rejects by default, and knows when it cannot read`,
  half positive and half negative: literal attribute, ternary, comparison, all-literal template → empty;
  `PAINT`, `` `mt-2 ${PAINT}` ``, `active ? PAINT : '…'`, `props.className`, `cx('…', extra)` → the
  opaque term reported. The second is the crucial one: it has a readable literal in front of it, and the
  old fence would classify that literal as layout and then report nothing.
- **F4 A/B** (same tree, two back-to-back `pnpm build`s, toggling only that section of `ui/CLAUDE.md`):
  the new output has **0** each of `.mt-2` / `.z-10` / `.self-end`, the old has **1** each; diffing the
  two outputs rule by rule, split on `}`, the "in the old, not in the new" side is exactly those three,
  **with no fourth**. Together they are **89 B** (`.z-10{z-index:10}` 17 + `.mt-2{…}` 42 +
  `.self-end{…}` 30). `.w-full` and `.absolute` **stay** — they have real wearers in the renderer, and
  deleting them from the document does not change the output, which is also why "only three of the seven
  are charged to this section".

**One process fact that has to be written down**: this round was again done on a moving tree (§12.10
recorded it once). Another agent landed between the two A/B builds, so the "in the new, not in the old"
side of the two outputs also carries seven extras (`.collapse` / `.contents` / `.inline` / `.resize` /
`.shadow` / `.ring` / `.transition`), which are **somebody else's bill**. That is exactly why what is
reported here is a **rule-by-rule diff**, not a subtraction of two total byte counts — on a tree like
this, the total byte count is not an attributable quantity.

---

## Section 16 · No test has ever looked at the build output (fourth adversarial audit round, F4)

Every guard in the preceding fifteen sections reads **source**: the palette census
reads `@theme`, the type scale reads `--text-*` and the use sites of `text-*`, the
className fence reads the props of `<Button>`, the arbitrary-value ban reads
candidate tokens. **Not one of them has ever opened the stylesheet the app
actually loads.**

This section fills that gap, and it is the only finding this round that **the
existing shape of the tests could not possibly catch** — not "some test was
written too narrowly", but "the question the tests ask is not the final
question".

### 16.1 The finding: seven rules nobody wears, one of them carrying an unnamed colour

In the stylesheet `pnpm build` produces on a clean tree, **14 class rules have no
wearer anywhere in the renderer** (after removing the 12 CodeMirror ones). All of
them come from prose; not one comes from code.

`.shadow` deserves its own note:

```
.shadow{--tw-shadow:0 1px 3px 0 var(--tw-shadow-color,#0000001a),
        0 1px 2px -1px var(--tw-shadow-color,#0000001a); …}
```

`#0000001a` is Tailwind's own default shadow colour, and **no token names it**.
How did it get into the build output? Because `components/PanelTabs.tsx`,
`ui/Menu.tsx`, `ui/spec.ts` and `components/shellClasses.ts` each have a comment
using the English word "shadow".

The literal-colour scan in `theme-contrast.test.ts` **structurally cannot see
it**: what those four places write in the source is an English word, not a
colour. This is the final form of that sentence from §8 —

> What ends up in the build output is decided by Tailwind's scanner.

— and its next sentence: **so the only trustworthy audit surface is the build
output itself.**

### 16.2 The approach: `scripts/audit-shipped-css.mjs`, run as the last step of `build`

A new script (not a test case; the reason is in 16.3):

1. read `out/renderer/assets/*.css`;
2. extract **every class selector** in it (only in selector position, un-escaping
   escapes, skipping preludes that start with `@`, so the `.5` inside
   `calc(… * 2.5)` is not taken for a class name);
3. extract **every class-shaped token** in the renderer source, after
   `blankComments`, with `.md` excluded wholesale;
4. assert: every class in the build output must be in the set from step 3,
   **otherwise it is a rule nobody wears**.

"Worn" is decided by **whole-token equality**, not by `tailwindCandidates()`. The
two run in opposite directions, each for its own problem: the candidate scanner
answers "what could this file possibly produce" and is deliberately **wider**
than Tailwind; here the build output has already given the exact string, so the
question becomes "did anyone ever write it", and that must be **narrow**. The
narrow side can only false-positive, never let something through. Today the false
positives number **0**.

The token character set keeps `.` and `:`, and that is where the discriminating
power comes from: `header.resize` is not `resize`, `t('sidebar.collapse')` is not
`collapse`, `inline: 'nearest'` is not `inline`.

Counting `.md` wholesale as prose is also a judgement rather than a shortcut:
`ui/CLAUDE.md` lives inside `src/renderer/`, and Tailwind compiles its fenced
examples exactly the way it compiles a className in a component — but nothing in
the product wears a class out of a guide. **A guide can only produce dead rules;
it can never make a rule live.**

### 16.3 Why a build step and not a test case

Two hard constraints press on it:

- **It needs the build output.** `pnpm test` today eats only source, and it
  should go on eating only source. Putting this in the unit tests leaves two
  roads: skip when the build output is absent — exactly the fail-open shape that
  has bitten this repository four times, the shape the non-empty assertion in
  `stylesheets()` was written for; or make the whole test suite depend on the
  bundler.
- **A script nobody runs does not exist.** So it is not standalone:
  `package.json` hangs it on the last step of `build`, a dead rule turns
  `pnpm build` red **in the very build that created it**, and the repository's
  third gate covers it for free. Running it alone is supported too
  (`pnpm audit:css`), and when `out/` is absent it **errors instead of
  skipping**.

Four non-empty assertions are written, each pointing at a specific failure that
would make the audit go mute: `out/` missing, no `.css` in assets, a zero-byte
stylesheet, fewer than 2000 tokens on the source side, fewer than 300 class
selectors in the build output, `@source not inline(…)` unreadable.

### 16.4 Two lists, each with its reason

**`FOREIGN_DOM` (12 entries)** — the category where we write the rules but not
the DOM. CodeMirror hangs `cm-*` on elements it creates at runtime, so those
names are selectors in `styles.css` and are not any className in the renderer;
from the outside they look exactly like a dead rule. **Listed one by one rather
than let through by the `cm-` prefix**: the thirteenth entry should be a decision
somebody wrote down, and an existing entry that has been misspelled should still
go red.

**`@source not inline(…)` (7 entries)** — this one is the real design trade-off
of this section; see 16.5.

### 16.5 Trade-off: not banning the word, banning the class

§8.3 priced the cost of aligning the audit at "prose under `src/renderer/` may
not spell a live class name". That price is affordable for a **class name** —
nobody needs to write a bracketed hex inside a sentence. It is not affordable for
the **word "ring"**: the renderer has 26 comments about the focus ring, 25 about
inline style, plus collapse / resize / shadow / contents / transition.

Rewriting seventy comments for the sake of seven English words would make the
prose worse, and **would only hold until the next person writes "focus ring"**.
So the direction is reversed:

```css
@source not inline('collapse contents inline resize ring shadow transition');
```

Tailwind's own blocklist. Those seven candidates are dropped before compilation,
and no matter which file mentions them, those seven rules are no longer in the
build output. **This is a real deletion, not an exemption**: `.shadow` carried
`#0000001a` and `.ring` carried `currentcolor`, two colours no token ever named
and the source-side scan could never see, and they go with it.

The cost is that those seven utilities no longer exist. This is the same bargain
as a `--color-*: initial` outside a block, and it pays better here: those seven
either bypass the token layer (the hardcoded colours of `shadow` / `ring`, the
all-property transition of `transition`) or are display modes this window never
wanted.

**The one harm it could do is pinned from the other side**: if someone really
does write one of those seven names onto an element, the class will not compile
and the interface breaks silently. So the audit script asserts the converse —
**not one name on the blocklist may be worn** — and it reads the list out of
`styles.css` rather than keeping a second copy inside the script.

Prefixed relatives are untouched; the blocklist only matches whole candidates:
`.inline-block` / `.inline-flex` / `.transition-all` / `.resize-none` and all
five `.shadow-*` tokens are still there. **Verified by building, not inferred**
(see the A/B in 16.7).

That comment spells the seven names out inside a `.css` file, and that is
deliberate: Tailwind does not extract candidates from stylesheets (verified by
the planted token in §8.2), so that is the one place under `src/renderer/` where
those words are free.

### 16.6 The four pieces of prose that changed (the other three do not belong to this section)

Those four are standard §8.3 violations — a comment spelled a live class name,
and the sentence turned itself into a rule in the build output. The fix is
uniform: **cite the variant the element actually wears**, not the bare root word:

| File | Was | Became |
|---|---|---|
| `ui/spec.ts` | the negative-margin class spelled out in parentheses | described in words, "every item is pulled one pixel to the left", plus why it is not spelled out |
| `components/DataGrid.tsx` | the `hover:` prefix and `opacity-70` side by side | "restating the same alpha under a hover variant" |
| `components/LayoutTree.tsx` | bare `inset-0` / `m-auto` | `after:inset-0` / `after:m-auto` (the two actually worn on the element) |
| `components/chat/PermissionPrompt.tsx` | bare `outline-solid` / `outline-none` / `outline-2` | each given its `focus-visible:` / `focus:` prefix |

All four keep a sentence explaining why they are written so awkwardly, for the
same reason as §8.3: the next person will certainly want to "put it back the
normal way".

The three entries `mt-2` / `z-10` / `self-end` in `ui/CLAUDE.md` do not belong to
this section — that file is held by another agent and is recorded in the previous
section (89 B, diffed rule by rule).

### 16.7 Verification (all actually run)

**It went red once, and it was the build that went red, not the script on its
own.** A line was planted in a JSX comment in `components/LayoutTree.tsx`: "the
divider deliberately does not use `z-50`" — exactly the kind of sentence this
repository has produced six times. `pnpm build` **exit 1**, reporting:

```
AssertionError [ERR_ASSERTION]: 1 rule(s) ship in the stylesheet and no element wears them:
    .z-50
```

Followed by three ways out (rewrite the comment / add it to the blocklist / add
it to `FOREIGN_DOM`), each with the conditions under which it applies. `cp`
restored the file, `shasum` matched the pre-planting value
(`LayoutTree.tsx = fd94e9ed…`), and the `grep` probe marks 0.

**A/B on the blocklist** (two back-to-back builds on the same tree, toggling only
that one line):

- Off: 41,111 B; on: 40,035 B; **a difference of 1,076 B**.
- Diffed rule by rule, the class rules that are "present with it off, absent with
  it on" number **exactly seven**, with no eighth:
  `.collapse` 30 B · `.contents` 27 B · `.inline` 23 B · `.resize` 20 B ·
  `.shadow` 244 B · `.ring` 255 B · `.transition` 477 B = **1,076 B**, matching
  the total difference byte for byte.
- `.inline-block` / `.inline-flex` / `.transition-all` / `.resize-none` / the
  five `.shadow-*` are present on both sides.

**Four gates**:

- `pnpm typecheck` **exit 0**.
- `pnpm test` — `apps/desktop` **1511 / 1511, 0 failing** (this section adds
  **0** cases, which is exactly why it does not go into the unit tests;
  1508 → 1511 is the three added by the previous section). Running the full suite
  from the repository root, the "against a live server" group in
  `packages/db-redis` fails, needs a real Redis, is unrelated to the renderer,
  and is the same before and after this round.
- `pnpm build` **exit 0**, and the last line is the audit's own reading:
  `audit-shipped-css: 507 class rules in 1 stylesheet(s), 40035 B — all worn (12 exempt, 7 blocklisted and confirmed unused)`.
- Class selectors with escaped square or round brackets in the build output:
  **0**; `.css` files under `src/renderer` still number **1**.

**Size**: 41,341 B → **40,035 B** (−1,306 B, class selectors 521 → 507). The
attribution is additive: seven blocklist entries **1,076 B** (this section,
measured by A/B) + four pieces of prose **141 B** (this section) +
three entries in `ui/CLAUDE.md` **89 B** (previous section, somebody else's
account) = 1,306 B.

**One process fact that has to be written down**: this round was again done on a
moving tree (§12.10 and the previous section each recorded one). After the
blocklist landed in `styles.css`, another agent's revert wiped it once — and the
way it was found was the audit script itself reporting "cannot read
`@source not inline(…)`", which is that non-empty assertion cashing in its
purpose on the spot. After landing it again, `shasum` is recorded as
`9b9f1c72…`. This round used no `git checkout` and no `git stash`.

### 16.8 Two notes for whoever comes next

- **`FOREIGN_DOM` is not a parking lot.** It holds only the "we write the rules,
  someone else writes the DOM" category. If a rule nobody wears has DOM that is
  ours, then it is a dead rule, and what should be deleted is the rule or that
  piece of prose.
- **The blocklist can grow, but every added name has to answer one question**:
  does the prose really need this word, and does this design system really not
  want this utility? Add it only when both hold, and write the reason down in the
  format of the existing comment.

---

## Section 17 · Wrapping up: clearing 270 unmigrated rules, and moving `@theme` into a JS config (round five, 2026-08-05)

### 17.1 The user's question, and what it got right

> I remember tailwind used to have a config file for customisation, with the CSS
> down to three lines. I would like the CSS file to stay at the one line it is in
> v4.

The memory is accurate: v3 was `tailwind.config.js` plus three lines of CSS
(`@tailwind base/components/utilities`). v4 reversed the direction and went
CSS-first; `@config` still works, but the official documentation positions it as
an upgrade compatibility path, not the recommended practice.

**But that expectation of "one line" exposed something we had never measured
ourselves.** After measuring the 539 lines of code in `styles.css`:

| | Lines | Can it move into config? |
|---|---|---|
| **Ordinary class rules (never migrated at all)** | **270** | ❌ |
| `@theme` tokens | 69 | ✅ |
| `@layer base` | 54 | ❌ |
| CodeMirror overrides | 51 | ❌ third-party DOM |
| element / global selectors | 26 | ❌ |
| `::-webkit-scrollbar` and friends | 20 | ❌ |
| `@keyframes` | 19 | ⚠️ |
| `@media` / `@utility` / `@import` / `@source` | 19 | partly |

**Moving to a config removes only 69 lines, 13%.** What holds this file up is the
270 lines of ordinary class rules **that were never migrated at all**:
`.modal` `.toolbar` `.value-box` `.grid-scroll` `.view-error` `.ctx-consent`
`.chat-toolbar` `.md-*`.

That batch is exactly the one repeatedly marked in the first four rounds as
"shared vocabulary, needs a round of its own". **In four rounds not one of them
actually measured how big it is** — every round's agent only reported "it blocked
me", and nobody reported "it is half of what is left". A shape expectation the
user asked about in passing is the first thing that forced this number out.
Recorded here, because the next report of "such-and-such blocked me" should come
with a size attached.

### 17.2 This section overturns §2.1

§2.1 said "no `tailwind.config.js` is needed … the configuration surface is an
order of magnitude smaller, so experiments have a better signal-to-noise ratio".
That reason held at the time, and is now outweighed by a factor it did not
consider: **the shape the user wants**. The trade-off changed; the original
judgement was not wrong — this is written down so the next reader has both sides
of the reasoning.

### 17.3 The cost, stated plainly

Three contract tests (`theme-contrast` / `type-scale` / `control-spec`) all parse
the CSS text of `@theme` today. Moving the tokens into JS means **rewriting the
audit layer for the fourth time**.

And this session has already produced the empirical data on that: **the first
three rewrites each opened new holes, and four adversarial audit rounds have
found 22 in total**, two of which were "all tests green while a 1.91:1 colour
shipped in the build output". So the acceptance bar for this rewrite is stricter
than for the feature:

1. Every assertion must be **watched going red for the right reason** after the
   rewrite, not reasoned about.
2. The rewrite may not shrink the audit surface. A token object in JS is
   **easier to parse than CSS text**, so the coverage should only widen or hold;
   any narrowing needs a written reason.
3. Once `@theme` is gone, `stylesheets()` and every piece of logic that exempts
   the `@theme` block by offset lose their anchor and must be reviewed one by one
   — this is the fifth possible entrance in this repository for "the scanner
   breaks and everything goes silently green".

### 17.4 Fixing two already-measured cascade bugs along the way

`.ctx-consent`'s `width: min(520px, 86vw)` loses to `.modal`'s
`min(760px, 86vw)` — **the consent dialog actually draws at 760px**.
`.chat-toolbar { gap: 8px }` loses to `.toolbar { gap: 6px }`. Both are
same-specificity, later-wins; both were measured in round three; both are denied
by a comment on the rule. Once these two families are migrated to utilities, the
cascade problem goes with them.

### 17.5 "One line" is not reachable, and where the floor is

CodeMirror overrides, scrollbar pseudo-elements, `body`/`#root` and `@keyframes`
have no JSX element to hang a className on. Tailwind's own documentation likewise
leaves these in the main stylesheet. The realistic floor:

- clear the 270 lines → about 190 lines
- then move `@theme` → about 125 lines

**Do not write the CodeMirror overrides as a JS object literal in order to get
closer to "one line".** Tailwind v3's `plugin()` + `addBase()` can do it, at the
cost of turning 51 readable lines of CSS into a lump of nested objects — and what
it overrides is a third-party DOM we do not control, the kind of code that most
needs to be readable. Shape is a means, not the end.

### 17.6 The numbers re-measured after the sweep, and what the table in §17.1 got wrong

After three parallel groups finished migrating and the serial sweeper deleted the
dead rules, the same script measured the same file again. The methodology is
written here because §17.1's table **sums to 528 across its own rows while
stating a total of 539** — 11 lines off, which says that table's attribution has
a gap and the two measurements cannot be subtracted from each other directly. The
methodology this time: a line counts as a code line as long as it has any
character outside `/* … */`, and every line falls into **exactly** one row, so
the rows sum to the total; both sides are measured with the same script
(`census.mjs`, see the end of this section).

| | Before the sweep | After the sweep |
|---|---|---|
| **Ordinary class rules** | **274** | **203** |
| `@theme` tokens | 69 | 69 |
| `@layer base` | 54 | 54 |
| CodeMirror overrides | 53 | 53 |
| element / global selectors | 30 | 30 |
| `::-webkit-scrollbar` and other pseudo-elements | 20 | 20 |
| `@keyframes` | 19 | 19 |
| `@media` / `@utility` / `@import` / `@source` | 23 | 23 |
| **Code lines, total** | **542** | **471** |
| Total lines in the file | 2,250 | 2,076 |

Only one row moved: class rules −71 lines. Total file lines −174; the remaining
103 lines are the net reduction in prose that expired along with the rules (more
was deleted than that, but several passages were **rewritten** rather than
removed, and the rewrites are longer than the originals).
Build output: 40,035 B / 507 class rules (the starting point of round five) →
**39,416 B / 506**.

**§17.1's table labelled the whole "ordinary class rules" row "never migrated at
all", and that is its most important error.** Of those 274 lines, the ones that
really belong to the families that were never migrated and have lost their last
wearer come to only 71. The remaining 203 fall into four piles by "why it is
still here", and adding them up one by one gives exactly 203:

| Why it is still here | Lines | Which ones |
|---|---|---|
| **1. A test or script outside the module reads it by selector or by name** | 49 | `.panel` 4 · `.panel-head` 3 · `.panel-tabs` 5 · `.panel-tab` 4 · `.panel-body` 7 · `.panel-drop-overlay` 4 · `.tab-insert-caret` 5 · `.view-drag-ghost` 3 (all of the above read one by one by `view-drag.test.ts`) · `.tab-close` 3 (`CLASSNAME_LEDGER` + a CDP handle) · `.conn-key` 5 · `.panel.drag-source` 3 (two `ALPHA_SITES` entries pinning by "file + selector") · `.grid-row` 3 |
| **2. Shared vocabulary; the wearers are still in unmigrated modules** | 83 | `.toolbar` 12 · `.sep` 6 · `.toolbar .grow` 3 · `.value-box` 13 · `.empty-hint` 6 · `.conn-actions` 6 · six form-row rules 30 · `.settings-pane` 3 · `.settings-pane .seg-group` 4 |
| **3. No JSX to hang it on, or no utility that can express it** | 61 | `.sr-only` 11 · `.grid-scroll` 13 · `.editor-wrap` 7 · `.dot.connecting` 3 · `.statusbar .err` 3 · five keyboard-focus rules 24 |
| **4. Already judged a spec problem, not a migration step** | 10 | `.md-h1` 3 · `.md-h2` 3 (already noted in §17.1: prose written for the agent sets the font size, and putting it into `SCALE` would weaken the "five-step scale" assertion) · `.mono` 4 (28 wearers across 15 files, needs a round of its own) |

Piles 1 / 3 / 4 come to **120 lines, and were never migration residue** — they
are what earlier rounds **kept with a written reason**. Counting them into "270
lines not migrated" is the entire source of that floor in §17.5.

**So §17.5's "about 190 lines" was not missed; it was derived from a wrong set of
rows and was never reachable.** Recomputed, separating "has a written way out"
from "cannot move by its shape":

- Today: **471 lines**.
- What can still be cleared and already has a way out written down is three items
  in pile 2: `.toolbar` / `.sep` / `.toolbar .grow`, 21 lines together (waiting
  for the table view, the object tree and the error centre to migrate together),
  `.value-box` 13 lines (only `ValueModal.tsx` is left wearing it),
  `.grid-scroll` 13 lines (needs another `@utility` to hold
  `contain: layout paint`). **47 lines** in total → about **424 lines**.
- Then move `@theme` into a JS config (69 lines) → about **355 lines**.
- Of the remaining 355 lines, 176 are `@layer base` / CodeMirror / element
  selectors / pseudo-elements / `@keyframes`, with no JSX element to hang a
  className on; the rest are class rules from piles 1, 2 and 4, each with its own
  reason. **That is the real floor**, and it is more than twice as high as §17.5
  guessed.

Write this methodological lesson down, because it is the other half of the one
§17.1 drew for itself: §17.1 said "every round's agent only reported 'it blocked
me', and nobody reported 'it is half of what is left'". This round supplied the
size — **and got the size wrong**, because what it measured was "how many lines
are not `@theme`", not "how many lines have no reason to stay". For a number to
support a decision, it has to be broken down along the dimension of that
decision.

Three one-off scripts (`census.mjs` for the rows and totals, `why.mjs` for the
line count of each class rule, `wear.mjs` for whether each selector has a wearer)
were run once before and once after the sweep, all taking the path to
`styles.css` as an argument, so the two sides necessarily share a methodology.
They are not in the repository — the reasoning is written in §19.1, that
rewriting them is cheaper than maintaining three scripts that ran twice; the one
thing that must be copied is how `wear.mjs` reads, which must reuse **word for
word** `preludes()` / `classesIn()` from `audit-shipped-css.mjs` and
`scannedSources()` / `blankComments()` / `TOKEN` from `sourceScan.ts`, or else it
is not measuring what the gate measures.

---

## Section 18 · what landing the modal family looked like (round five, parallel group 1, 2026-08-05)

Of the 270 lines of "ordinary class rules that were never migrated" in §17.1's
table, this group clears the dialog family: `.modal-mask` / `.modal` /
`.modal-head` / `.modal-head .t` / `.modal-body` / `.modal-foot` /
`.settings-modal` / `.ctx-consent` — 8 rules, 42 lines of declarations.

Four components changed: `ValueModal.tsx`, `ConnectDialog.tsx`,
`settings/SettingsDialog.tsx`, `context-actions/ConsentDialog.tsx`. Plus one new
shared vocabulary file, `components/modalClasses.ts`.

### 18.1 The first item in §17.4 is fixed, and it is a real behaviour change

What §17.4 records: `.ctx-consent`'s `width: min(520px, 86vw)` loses to
`.modal`'s `min(760px, 86vw)`, so **the consent dialog actually paints 760px**.

This round measured the real build output inside Electron, both sides:

```
consent.shell  width   760px  ->  520px
consent.h2     width   722px  ->  482px   (760/520 each less a 1px border and 18px padding on both sides)
consent.p1/p2  width   722px  ->  482px
consent.actions width  722px  ->  482px
```

**This is not a "migration with no visual difference", it is a product change**:
from today the consent dialog is 240px narrower. It is the fix §17.4 explicitly
asked for, and the reason is written in the rule's own original comment (this is
prose meant to be read, and a 760px line length is past the width anyone is
willing to read) — a comment that the same rule's cascade denied for three
rounds.

`.settings-modal`'s 800 / `min(560px, 84vh)` does not have this defect — it
fights `.modal` over `width`, same specificity and it comes later, so it has
always won. Measured 800×560, identical before and after.

### 18.2 Sizes go in inline `style`, not a new token and not an `@utility`

The three widths and the one height are all of the shape `min(<px>, <vw>)`; no
token can name that. Three routes:

1. A `--spacing-*` token — **not chosen**. The spacing namespace is open to
   every spacing utility, so naming a width there mints a legal padding and a
   legal gap at the same time: one fact generating three classes. This is the
   "weaker of the two reasons" written in the comments on `.settings-modal` and
   `.ctx-consent`, and it still holds today.
2. `@utility` — **not allowed** this round: three agents run in parallel in this
   stage, and nothing in `styles.css` may be touched except appending `@theme`
   tokens. (In passing: `@utility` now **technically** works — those two
   comments say it does not, on the grounds that the element still wears the
   unlayered `.modal`, so a width in `@layer utilities` would compile and then
   lose to it. That premise went away along with `.modal`. If whoever comes next
   wants to switch to `@utility`, the route is open, but they have to answer
   item 1's "one name generates three classes" question first.)
3. **Inline `style`** — chosen. `error-center/ErrorCenter.tsx`'s `PANEL_SIZE`
   already made the same call for the same shape, and its comment **names
   `.settings-modal` and `.ctx-consent` as the same call**. This section is that
   sentence honoured from the other side. `ConnectDialog`'s 520px was already
   inline, with a comment reading "it can only be inline, because `.modal` is
   unlayered and beats utilities" — that reason is gone, the form stays, and the
   reason is now this one.

Four size objects: the shared `MODAL_SIZE` (`min(760px,86vw)` + `80vh`), and
three more at their own call sites overriding the axis that varies, via
`{ ...MODAL_SIZE, … }`. **The winner of an object spread is whichever is written
later in the literal**, decided here; a class string has no cascade, so its
winner is decided by Tailwind's output order, not by whoever writes it — §7.2.
`SettingsDialog` therefore puts `min(560px,84vh)` and the `80vh` cap it has in
fact always been subject to in the same object for the first time, both numbers
visible at a glance.

### 18.3 The one rounding: outer radius 7px → 8px

Tailwind's own radius ladder has no 7px (6 and 8 are the adjacent steps), and
"it used to be that number" is not a reason for a token — that is the rule the
shadow ladder and the 5px radius already settled (`shellClasses.ts`'s
`LIST_HEAD` comment). 6 and 8 are equidistant; 8 wins because it preserves the
relation "dialogs are rounder than popup menus": the menu is 6px, and the
original 7 > 6 was saying exactly that.

The four dialogs therefore each gain 1px of radius. Measured, written down here,
not hidden inside "no visual difference".

### 18.4 One shared constant file, not four copies

Every rule in the `.modal*` family is worn by 2–4 modules across three
directories. Whoever migrated first would have to either delete a rule others
still use or copy it into four class strings — exactly the situation §12.6
describes for `.sidebar-head` / `.dot`, and the answer is the same:
`components/modalClasses.ts`, one source, written in the JSX vocabulary rather
than in CSS.

`MODAL_TITLE` is `` `mono ${MODAL_TITLE}` `` inside `ValueModal`. Template
concatenation is transparent to Tailwind, because **every complete class name
appears as a literal in some scanned file** (`mono` on this line, the rest in
the constant) — `shellClasses.ts`'s `CONN_DOT` is the same form, and the rule is
written in that file's header comment.

### 18.5 Focus trap and Escape stack: no coupling, checked

`hooks/useModalDialog.ts`'s `FOCUSABLE` holds only element selectors and
attribute selectors (`button:not([disabled])`, `[tabindex]:not([tabindex="-1"])`
and so on), and `hooks/modalStack.ts` does not touch the DOM at all. Across
every `querySelector` / `closest` / `classList` hit in the renderer, not one
reads any class name in this family. Neither file changed **by a single line**
this round.

### 18.6 One closing gate went red, and it overturns a premise of this stage

This stage's handover says "a dead rule is harmless within a stage —
`audit-shipped-css` only goes red when **nobody at all wears** a rule, and a
rule the stylesheet still names by hand is not that". **The second half does not
hold**, measured:

`scripts/audit-shipped-css.mjs`'s `wornClasses()` goes through
`scannedSources()`, and `sourceScan.ts:469` says plainly
`if (rel.endsWith('.css')) continue` — **stylesheets are not among the wearers'
sources**. So the moment JSX stops writing a rule's name, that rule is worn by
nobody.

After landing, `pnpm build`: Vite side all green (build output CSS 40,432 B, 513
class rules), audit side exit 1:

```
8 rule(s) ship in the stylesheet and no element wears them:
    .chat-list .ctx-consent .modal .modal-body .modal-foot
    .modal-head .modal-mask .settings-modal
```

Seven of them are this group's; `.chat-list` belongs to **another group in the
same stage** — two groups hit the same wall, which says this is not one group's
slip but the stage premise itself being wrong.

This group **did not** delete rules itself (the handover expressly leaves
deletion to the serial sweeper) and **did not** go and loosen that assertion.
Three exits are left for the next step, in priority order:

1. **The sweeper deletes these 8 rules** and the gate goes green on its own.
   This is the next step the design already had; it just has to happen
   immediately, not later.
2. If the parallel stage must stay green mid-flight, that needs a **named,
   reasoned, self-expiring** exemption list (something of the shape
   `AWAITING_REAPER`: each entry asserts "this really is in the build output and
   really is worn by nobody", so the sweeper deleting a rule without deleting
   its entry goes red). This group did not build one, because `scripts/` is
   outside this group's file range.
3. Do not stuff them into `FOREIGN_DOM` — §16.8 already says that is not a
   parking lot.

### 18.7 Verification

- **Property-by-property comparison in Electron**: mount the four dialogs' real
  DOM (45 probe elements) against **the build-output CSS from before the
  migration** and **the build-output CSS from after** in turn, and in Electron's
  own Chromium read **all** computed properties with `getComputedStyle` plus
  `getBoundingClientRect`, diffing the lot, skipping not one property. 98
  differences, in four classes, checked class by class:
  - the consent dialog's width and the reflow of its four children (§18.1,
    **wanted**);
  - the four outer radii, 7 → 8 (§18.3, **wanted**);
  - `box-shadow`, whose **rendered value matches to the character**, with four
    extra layers of `rgba(0,0,0,0) 0 0 0 0` on the utility side — Tailwind's
    ring / inset-shadow placeholder layers, transparent and zero-sized;
  - the colour of the three **zero-width** borders on the head and the foot,
    which goes from the inherited `--color-fg` to `--color-border`. The original
    rule set the colour of one edge only; the utilities' colour family sets all
    four; **the widths of all four edges are equal before and after**, so the
    painted pixels are the same.
  Every other declaration — `fixed` / `inset` / `z-index: 500` / the mask
  backdrop colour / flex direction / the three widths / `max-height` / the 30px
  head height / the 8px gap / `0 6px 0 10px` padding / the 10px body padding /
  the `8px 10px` foot padding / `flex-1` / `font-weight: 600` — is byte-for-byte
  identical before and after.
- **Negative control**: take away just the body's min-height class in the
  probes, and the diff immediately reports `min-height 0px -> auto` on all three
  bodies; **and not one of the three bounding boxes moves**. This is exactly why
  what gets measured is computed properties and not screenshots. Restored
  afterwards, probe file shasum checked.
- `pnpm typecheck` **exit 0**.
- `pnpm test` **1511 / 1511, 0 fail** (0 cases added by this group).
- `pnpm build` — Vite side exit 0, `audit-shipped-css` exit 1, **only for
  §18.6's 8 dead rules**, not one more: re-run in a staging directory using the
  audit script's own reading, and after subtracting those 8, `unworn` is empty
  and the blocklist side's `blockedButWorn` is empty too.
- No `git checkout` and no `git stash` this round, and not one byte of
  `styles.css` changed (this group needs no new token at all).

### 18.8 What was not touched, and why

- `.form-row` / `.form-row label` / `.form-row .form-label` / `.form-row input` /
  `.form-hint` / `.form-actions` — **outside this group's range**. They are the
  vocabulary of form rows, shared between dialogs and the settings pane;
  `--spacing-form-label`'s override mechanism hangs on them, and they deserve a
  round of their own.
- `.value-box` — `components/views/InspectorView.tsx` wears it too, and that
  file does not belong to this group. "An element is either migrated whole or
  not at all" applies just as well to "if a rule's wearers are not all in one
  hand, do not migrate it".
- `.settings-pane` / `.settings-pane .seg-group` — kept, and the names on the
  elements kept too. The former is the anchor for `--spacing-form-label: 116px`;
  whether the latter stays is the question of whether `ui/spec.ts`'s
  `SEGMENTED.group` should spend the flex shorthand on itself, which is a
  control-layer decision (the original comment says so).
- One thing **measured in passing and not fixed**: `ui/Menu.tsx`'s backplate
  comment says it sits "below the modal mask", but it is 600 and the mask is
  500 — **it is above**. Nothing goes wrong today, because the context menu is
  closed before the consent dialog opens (`ContextMenu.tsx` says so). Noted on
  the mask comment in `modalClasses.ts`.

---

## Section 19 · the sweep: 11 dead rules deleted (round five, serial close-out, 2026-08-05)

Round five's three parallel groups each turned their elements into utilities and
**did not move one byte of the rule section of `styles.css`** (group three only
appended one `@utility`). All three hit red on the closing gate, and all three
reported the same thing: `audit-shipped-css` does not count a stylesheet's
mention of itself, so the moment JSX stops writing a class name, that rule is
worn by nobody. This section is the next step the design already had — **a
single writer** deleting those rules.

### 19.1 Verify first, delete second — because of these two directions of error, one is loud and one is silent

`audit-shipped-css` catches one direction only: **the rule is in the build
output and nobody wears it**. The reverse — **somebody wears it and the rule was
deleted** — it structurally cannot catch, and that one is a silent visual
regression. So the `deadRules` lists the three groups handed in are **input**,
not a conclusion.

Verification uses `scratchpad/reaper/wear.mjs`: it copies the audit script's own
CSS-side reading (`preludes()` / `classesIn()`, with backslash escapes undone),
takes `sourceScan.ts`'s `scannedSources()` + `blankComments()` + the same
`TOKEN` regex on the source side, then lines the two sides up and answers "who
wears it" for **every** class selector in `styles.css`.

Result: 66 class names in the whole file, of which exactly 22 are unworn — 12
are CodeMirror's (named individually in `FOREIGN_DOM`), and the other 10 are
precisely the batch the three groups reported, **not one more, not one fewer**.
The step "sweep for orphans no group named" therefore comes back empty: there is
no eleventh.

Three places that had to be checked on their own, and that turned up the list
itself being inaccurate:

1. **`.modal-head .t` will not turn the gate red, but it is dead all the same.**
   The audit's `TOKEN` counts the bare identifier `t` that appears all over the
   code (`const t = useT()`) as a wearer of `.t`, so `.t` reports WORN. It is
   dead, and the reason is not "nobody wears `t`" but that **its ancestor
   selector `.modal-head` has no wearer at all**, so this descendant rule can
   never match. Group one raised this in its handover; confirmed by measurement.
2. **`.value-box` is not dead, and group two's list also said "do not delete" —
   correct.** It is still worn by `ValueModal.tsx:114` (group two migrated the
   four sites in `InspectorView.tsx`). Kept, with a note on the rule making
   clear it is no longer shared vocabulary.
3. **`.toolbar` reports WORN, but the first hit is `SelectionActionBar.tsx`'s
   `role="toolbar"` — an attribute value, not a className.** The real wearers
   are `TableView.tsx:114`, `TreeView.tsx:88`, `ErrorCenter.tsx:121`, confirmed
   by grepping each one. Worth recording because this reading can equally
   deceive in the other direction: an attribute value can keep a rule that is in
   fact dead alive.

Also checked, and all empty: across every `querySelector` / `closest` /
`classList` hit in the renderer, not one reads any of these ten names;
`apps/desktop/scripts/` and `scripts/` contain no site that finds elements by
these names; no test reads them through `ruleBody()` / `cssBlock()` (the eight
that `view-drag.test.ts` reads, the two that `grid-layout.test.ts` reads, the
`.tab-close` that `CLASSNAME_LEDGER` wants, and the three sites `ALPHA_SITES`
pins are all outside the deletion set).

### 19.2 What was deleted

11 rules (10 class names; `.modal-head` has two), 71 lines of declarations in
total:

```
.modal-mask  .modal  .modal-head  .modal-head .t  .modal-body  .modal-foot   <- group 1
.settings-modal  .ctx-consent                                                <- group 1
.chat-toolbar  .view-error                                                   <- group 2
.chat-list                                                                   <- group 3
```

`SHEET: context-actions` disappears as a whole section along with them — its
only rule was `.ctx-consent`. This is the first section lost since the eight
stylesheets were merged into one.

### 19.3 Prose is handled by whether its reason still holds, not by whether it mentions a dead class name

Comments on rules are load-bearing in this repository, so the question asked of
each comment when its rule is deleted is **whether the reason it records still
holds**, not whether it mentions a name that no longer exists. Eight of them,
handled four ways:

- **Wholly void, deleted**: all of the `.ctx-consent` section (the reasoning
  about width has moved into `ConsentDialog.tsx`); the large block above
  `.settings-modal` (the 800/560 measurements are already there verbatim
  alongside `SettingsDialog.tsx`'s `style`, §18.2); and the two group banners in
  the chat section, "1. held down by an unlayered rule elsewhere" and "2.
  properties Tailwind has no utility for".
- **Half void, only that half changed**: the block above `.modal-mask` reading
  "the modal shell and the form rows below it belong to the window, not to this
  module" — the modal half is gone, the form-row half still holds, so the whole
  block is rewritten to talk about form rows only, with the modal half's
  destination (`components/modalClasses.ts` + inline `style`) written into the
  same block as an instance of "how reason 2 was honoured".
- **The reason changed, the conclusion did not; change the reason**: the file
  header's "order is cascade, and two sections are not where you think". It was
  originally explaining **why a bug was being kept** (the consent dialog losing
  to the general dialog, the chat toolbar losing to the shared toolbar). Both
  bugs were fixed this round (§17.4 / §18.1), the disclosure section is gone
  entirely, and what is left of the chat section — two Markdown font sizes and
  two `@keyframes` — conflicts with no rule in this file, so **its position now
  decides nothing**. Rewritten to say that, and to state plainly that "it was
  not moved, because moving is a change, and a change nobody has measured is not
  tidying either".
- **Change the numbers**: the app section's reason-2 list (two items fewer), the
  chat section's "four declarations, four groups" (now two and two), the
  settings section's "three rules" (now two), and the shared-toolbar block's
  "six views + the chat panel + the error centre" (now three views + the error
  centre).

**Two comments that live outside `styles.css` but were falsified by this
deletion were changed along with it**, because the reason they went false is
this deletion and nobody else will come and fix them:

- `components/error-center/ErrorCenter.tsx`'s `PANEL_SIZE`: the original said
  "the same call as `.settings-modal` and `.ctx-consent`, which arrive from the
  stylesheet side". All three are now **inline `style`**, arriving from the same
  side — the reason changed, and the conclusion got stronger.
- `hooks/useModalDialog.ts`'s usage example: the JSDoc names a mask class that
  no longer exists, so anyone copying it would get an unstyled mask. Changed to
  `MODAL_MASK`, and per §8.3 the replaced name is described in words rather than
  as a class name.

One place **not changed**, just recorded:
`context-actions/__tests__/consent-gate.test.ts`'s incident narrative says
"`.ctx-consent` appears". That is the record of a manual observation made at the
time, a fact in the past tense, not an assertion about the present.

### 19.4 `@utility overflow-anchor-none` and `.grid-scroll`: the route is open, the handover is written here

The `@utility overflow-anchor-none` group three added retired `.chat-list`.
`.grid-scroll` (13 lines) still declares the same property itself, and it is
**next**; two premises were confirmed this round:

- `@utility` really does expand inside the merged root stylesheet (group three
  measured it: the build output grows by 43 B, containing only the one rule
  `.overflow-anchor-none{overflow-anchor:none}` with nothing else moved; an
  `@utility` nobody wears produces zero bytes);
- the unlayered `.modal` is gone, so the reason "a rule in a layer gets beaten by
  an unlayered rule" no longer holds on the dialog side — but it **still holds**
  for `.grid-scroll` itself, because `.grid-scroll` is unlayered.

The recipe (measured by group three, copied here to save looking it up again):
the class string
`flex-1 min-w-0 min-h-0 overflow-x-auto overflow-y-hidden overscroll-y-contain relative bg-bg outline-none overflow-anchor-none`,
plus a second `@utility` holding `contain: layout paint`; the literal name
`grid-scroll` has to stay on the element (`grid-layout.test.ts:133` uses it to
find the node), the `cssBlock('.grid-scroll')` assertion becomes a read of the
class string, and `grid-wrap` already does exactly this in the same file. One
thing there **has to be measured rather than reasoned about**: `outline: none`
is a shorthand, and v4's `outline-none` only sets `outline-style`, so the
computed values of `outline-width` / `outline-color` have to be compared too.

`.value-box`'s recipe has likewise already been measured — it is what the four
migrated sites in `InspectorView.tsx` write:
`max-h-full overflow-auto rounded-sm border border-border bg-bg p-2 font-mono text-data whitespace-pre-wrap wrap-anywhere select-text`.
Note that it is `font-mono` and not the `mono` class: the latter also carries
`font-variant-numeric: tabular-nums`, which the original rule never had.

### 19.5 Verification

- **Wearer census** (§19.1 above): `wear.mjs` run once before the deletion and
  once after. After deletion `styles.css` holds 55 class names, and the only 12
  unworn ones are CodeMirror names, all of them in `FOREIGN_DOM`.
- **Negative control one (the gate is alive)**: plant `.view-error` back into
  the stylesheet as a single declaration and `pnpm build` immediately exits 1,
  with the assertion's `actual` being exactly `[ 'view-error' ]`. Undone with a
  single reverse Edit; `shasum` matches the value before planting
  (`ca6986a5…`). **No `git checkout` and no `git stash` were used.**
- **Negative control two ("dead" is read, not a constant)**: plant a
  `view-error` className on `components/ViewError.tsx` and re-run the same
  census against a copy of the stylesheet from **before** the deletion —
  `.view-error` flips from UNWORN to `WORN components/ViewError.tsx`, while the
  other nine **all stay UNWORN**. Restored from the `cp` backup, `shasum`
  matches (`47416b79…`). This control is the only thing in this section that can
  prove the verification is not counting a set that is always empty.
- `pnpm typecheck` **exit 0**.
- `pnpm test` **1511 / 1511, 0 fail** (0 cases added by this section, and no
  assertion weakened either).
- `pnpm build` **exit 0**, last line:
  `audit-shipped-css: 506 class rules in 1 stylesheet(s), 39416 B — all worn (12 exempt, 7 blocklisted and confirmed unused)`.
- There is still **only one** `.css` file under `src/renderer`; the build output
  contains **0** escaped square-bracket/parenthesis class selectors
  (`grep -oE '\.[A-Za-z0-9_-]*\\[\[(]'`, count 0), and the three assertions for
  the arbitrary-value and arbitrary-property bans are green under `pnpm test`.

### 19.6 One fact about the process

During the three parallel groups, `styles.css` was appended to once, by group
three (the `@utility`). Its shasum when this section started was `2026771e…`,
matching what group three reported on finishing, so nothing like §15.6's
"restore from a whole-file copy and wipe out someone else's change along with
it" happened. Both experiments in this section used a **targeted reverse Edit**
or a **single-file `cp` restore**, and each time `shasum` confirmed the return
to the original value.

---

## Section 20 · §17.2 withdrawn: `@config` cannot do it on Tailwind 4.3.3 (round five, measured)

### 20.1 The conclusion first: this is a measurement, not a difficulty

§17.2 asked for `@theme` to be moved into `tailwind.config.js`. **It cannot be
done**, and the reason is specific and reproducible:

`@config` itself works — a config holding a single spacing token did compile to
`.h-control-sm{height:20px}`. But it **inlines**: no `--spacing-control-sm`
custom property was emitted. Reproduced once each in the `colors` and `fontSize`
namespaces, same absence of a variable. The compatibility layer registers every
value in the JS config as "inline, do not emit".

That is fatal, because the 402 lines of code in `styles.css` that are **not
`@theme` are not utilities** — they are the base layer, CodeMirror overrides,
scrollbar pseudo-elements and keyframes, and **all of them read tokens through
`var()`**.

Building on the real tree after moving the whole block, measured:

- **86 dangling `var()`s pointing at 23 undefined tokens** appear in the build
  output (baseline 0).
  The sharpest few: `.form-label{width:var(--spacing-form-label);color:var(--color-fg-dim)}`,
  `.leading-row{line-height:var(--spacing-row)}`, `.shadow-gutter-sel{…var(--color-accent)}`.
  The block has 11 tokens derived from another token; all 11 break.
- **`pnpm build` exits 0**, `audit-shipped-css` reports `506 class rules … all worn`.
  **No gate in the repository can see this.**
- Build output 36,406 B vs 39,416 B — the 3 kB saved is the entire palette going
  missing.

### 20.2 Two consequences that outlive the version

Even if some future Tailwind version emits variables, these two should still
weigh on the decision:

1. **Once `--spacing-form-label` is inlined, `.settings-pane`'s override fails
   silently.** That is exactly the subject of the whole of
   `design/2026-08-04-settings-form-gutter.md` — the bug where one value scattered
   into four places and the override only reached three would come back in
   another form.
2. **A palette that is not custom properties cannot be re-pointed at runtime.**
   That is precisely what a second theme needs.

### 20.3 Partial migration: possible, not recommended

Only 8–9 tokens are read by no rule. Moving those saves about 9 lines (of 69),
at the cost of the product's vocabulary living in two files from then on. Not
worth it.

### 20.4 §17.5's floor, re-derived

Neither of §17.5's two numbers — "clear about 190 lines, then move about 125
lines of config" — holds up:

- "190" is an underestimate. After the three families (modal / toolbar /
  markdown) are migrated, **only 10 class rules actually become dead rules**; the
  rest still have wearers. §17.1 recorded the 270 lines wholesale as "migratable",
  but that means **not yet claimed by anyone**, which is not the same as this
  round's range.
- "125" is unreachable, because the 69 lines of `@theme` cannot be moved (20.1).

**Measured today: `styles.css` is 2117 lines / 471 lines of code.**

| | lines |
|---|---|
| Plain class rules (still worn) | 203 |
| `@theme` | 69 |
| `@layer base` | 55 |
| CodeMirror overrides | 53 |
| Element / global selectors | 30 |
| Browser pseudo-elements | 20 |
| `@keyframes` | 19 |
| `@utility` / `@media` / `@source` / `@import` | 22 |

Of the remaining 203 lines of plain class rules, the families nobody has claimed
yet are the `.form-row` family, `.settings-pane`, `.grid-*`, `.panel-*`.
**Whoever clears them next: measure before you schedule** — the lesson of §17.1
is that a report saying "it blocked me" carries no size.

### 20.5 Four findings from round five's adversarial audit

**F1 — `prefers-reduced-motion: reduce` no longer stops the connection status dot, and this migration is what caused it.**
Simulating `reduce` inside Electron, the dot still reads `animation-name: pulse`.
`@media(prefers-reduced-motion:reduce){.dot.connecting{animation:none}}` sits at
offset 32423 in the build output, `.dot.connecting{animation:… pulse}` at 33223 —
**both unlayered, both specificity (0,2,0), so the later one wins**. Before the
migration the order was the other way round, and it worked.

**The reason this one is worth remembering on its own is that it punctures §13's merge proof.** That proof was about **set shape**
("138 top-level statements, not one more and not one fewer"); it proved no rule
was lost, **it did not prove order equivalence** — and the cascade of unlayered
rules is decided by exactly that order. §13.3 reasoned about order only for the
two cascade bugs it deliberately kept. Sweeping all 125 unlayered rules, this
kind of collision occurs exactly once.

**F2 — the literal-colour scan knows only three spellings: hex/rgb/hsl.** Planting
`color: rebeccapurple` on `.empty-hint` (four live wearers): the build output has
`.empty-hint{color:#639}`, `pnpm build` exits 0, renderer 727/727 green.
`oklch(0.6 0.2 20)` likewise, `#de394b` in the build output.
**Lightning CSS lowers them at the exit into shapes the scanner recognises, and the scanner reads the source.**
Named colours, `oklch`/`lab`/`oklab`/`color()`/`hwb`, `light-dark()` are all wide
open.

This is §10.2's lesson one level further down: **the subject of the scan is already "the value", but its reader is still a list of spellings.**

**F3 — `caution`'s `border-dashed` can be deleted and 727/727 stays green.**
`spec.ts:138` says it is dashed "because it must be distinguishable from `danger`
without relying on hue — red against amber is one of the two pairs red-green
colour blindness cannot separate". Delete it, all green. This accessibility
property **holds today by measurement alone; no assertion pins it**.

**F4 — the consent dialog has no scrollable body, and this round spent two thirds of its headroom.** `MODAL_SHELL`
is `overflow-hidden`, `MODAL_SIZE` caps at `80vh`, and the five prose sections and
the action row **sit directly in the shell** — unlike every other dialog, which
wraps a `MODAL_BODY` (`min-h-0 flex-1 overflow-auto`).
Measured with the real copy: en **294px**, zh 258px. The product's floor viewport
is **400px** (`minHeight: 600` ÷ `UI_ZOOM_MAX: 1.5`), where the ceiling is 320px —
**English has 26px of headroom left**.
Any lower and the Accept button is clipped, and `overflow: hidden` means it is
**unreachable**; Escape still cancels, so this dialog becomes decline-only, never
accept.

The 760→520 narrowing pushed the content from 240px to 294px. Group 1 measured
294px and judged it "fits", but that comparison was against a 720px ceiling,
**not the floor viewport's 320px**.

---

## Section 21 · F2 landed: the audit surface for literal colours moves from source to build output (round five, 2026-08-05)

### 21.1 What this section fixes: the subject was right, the reader never caught up

§10.2 changed the **subject** of the literal-colour ban from "the property" to
"the value", and that was right; it still stands today. What F2 found is the
second half of the same sentence: **the reader is still a list of spellings**
(`#hex` / `rgb(` / `hsl(`), while CSS has a dozen-odd colour spellings. A list is
only ever as long as what someone remembered.

The criterion reproduced, both planted on the real tree (see 21.5):

| hand-written rule planted in `styles.css` | what ships | old scanner |
|---|---|---|
| `.empty-hint { color: rebeccapurple }` | `.empty-hint{color:#639}` | green |
| `.mono { background: oklch(0.6 0.2 20) }` | `.mono{background:#de394b}` | green |
| `.panel-head { border-bottom: 1px solid #7a3f3f }` | unchanged | red |

Three of a kind, one build: **the old scanner reports only the third**. That is,
Lightning CSS lowers the first two at the exit into shapes the scanner
recognises, and the scanner reads source spellings, so it happens to be blind to
them.

### 21.2 Two readers, each with its own job, both kept

The question asked was "source side, artifact side, or both". The answer is
**both**, and the reason is written into that comment in
`theme-contrast.test.ts`; in summary:

- **Source side** (`theme-contrast.test.ts`) — it states a **writing rule**,
  reports file and line, and **eats only source**, so it goes red inside
  `pnpm test` with no build needed. Its ceiling is just as clear: the list of
  spellings.
- **Artifact side** (`scripts/audit-shipped-css.mjs`) — it states a **shipping
  rule**. The build output has already been normalised by Lightning CSS into very
  few shapes, so spelling is no longer a variable. It also covers a class the
  source side structurally cannot see: a colour that never appears in any
  stylesheet at all (§16.1's `.shadow` carrying `#0000001a` into the build output,
  sourced from four comments containing the English word "shadow").

The cost is two things to keep in sync. That cost is paid once in that comment:
the two **do not contain each other**; neither is redundant with the other.

The source side was widened in passing to: all 147 named colours + `oklch` /
`oklab` / `lab` / `lch` / `hwb` / `color()` / `light-dark()` / `device-cmyk()`.
**Not taken**: `color-mix()` and `var()` (both are spelled out of tokens
already). **Not taken**: `transparent` / `currentcolor` (neither is a literal).
Named colours are fenced on both sides (no `\w` / `.` / `#` / `-` before, no
`\w` / `-` / `(` after), so `.plum-badge` does not count and neither does
`tan(1rad)`.

**One deliberately left gap, written down**: the system colour keywords
(`Canvas` / `ButtonText` / `AccentColor` …) are not in the named-colour list.
They are not literals (the platform decides the colour), but they do paint
unaudited colours. The reason for leaving them out is that `Menu` / `Mark` /
`Field` / `Highlight` collide too hard with CSS and with English, and taking them
in would make a scanner with zero false positives to date start producing them.
Nothing in this window uses them; if someone does, the artifact side catches it,
and catches it in a way that has nothing to do with spelling.

### 21.3 The artifact-side rule: **every colour is either a colour in the palette or nothing at all**

`audit-shipped-css.mjs` gains a declaration-level scanner (`declarations()`, the
other half of the same grammar the existing `preludes()` reads). It does four
things:

1. **An at-rule's prelude is not a declaration.** Lightning's own probe
   `@supports (color:color-mix(in lab,red,red))` contains two `red`s, and another
   contains `rgb(from red r g b)`. The prelude runs to `{` and is never read as
   values. Colours in a prelude paint no pixels, so nothing is lost. But
   `@property --x { initial-value: #fff }` **is** a declaration, and it keeps its
   at-rule prelude — that is the only way the audit knows which custom property
   the value belongs to.
2. **`colourTokens()` recurses through parentheses**, so it does not need to know
   `var` or `color-mix`: a function that is colour notation is returned whole to
   be parsed, and any other function is walked into to scan its arguments.
   `var(--tw-shadow-color,#000a)` is read this way.
3. **`rgbaOf()` accepts only hex and `rgb()/rgba()`**, because that is Lightning's
   exit vocabulary. Everything else returns null and is reported — **refusal is
   the safe direction**; if one does show up, someone should go find out why, not
   accept it by default.
4. The verdict: `currentcolor` passes (it is a reference, not a colour); alpha 0
   passes (`transparent`, `#0000` and Tailwind's `0 0 #0000` all land here —
   something invisible neither can nor needs to pass a contrast check);
   otherwise **the three channels must equal the three channels of some colour
   declared in `@theme`**, with alpha excluded from the comparison —
   `bg-accent/18`, `bg-bg/82` and mixes with transparent are the same colour at
   different strengths, and strength is `ALPHA_SITES`'s problem, not this one's.

**The palette is read from two directions, and that needs its own explanation.**
`@theme` is the list the author wrote, and it is where `theme-contrast.test.ts`'s
census forces someone to measure contrast; but six of its entries are
`color-mix()` over `var()`, which Lightning computes away at the exit (source
writes a mix, the build output writes `--color-danger-hover:#483c42`).
**Reading source only** would mean re-implementing colour interpolation here to
recognise six values that are already sitting in a file being read; **reading the
artifact only** would allow a palette entry `@theme` never declared. So: the
source `@theme` supplies the literals the author wrote, the artifact's `:root` /
`:host` supplies the computed result of that same set of declarations, plus one
assertion — **any `--color-*` / `--shadow-*` on the artifact's `:root` must have a
same-named entry in `@theme`**, or it errors. That one seals off the route where
the build output slips a colour into the palette by itself.

`--shadow-*` counts as palette: Tailwind inlines shadow tokens into utilities
instead of emitting variables, so `--shadow-menu`'s black appears only as a
literal inside `.shadow-menu`, while the token that spells it lives in `@theme` —
the same closed set.

### 21.4 One list, one entry

`TAILWIND_INTERNALS`, the same pattern as `FOREIGN_DOM` / `ALPHA_SITES` /
`CLASSNAME_LEDGER`: named plus a written reason, not a loosened assertion. Today
there is one entry —

`--tw-ring-offset-color: #fff`: the default Tailwind sows for its own ring-offset
variable, appearing once in its reset and once in the `@property` that gives the
variable its shape (which is why `site` takes "which custom property this value
belongs to", so the `@property` half and the reset half fold into one entry
rather than being written twice). It is a fallback, not paint: to land on a pixel
it has to go through some `ring-offset-*` utility, no element wears one, and
`ring` itself has already been struck out under `@source not inline(…)`. Writing
it into `@theme` would mean slipping a white into a palette that has no white.

A match requires site and colour value to be **exactly** equal — the exemption is
for one value, not for a property that may hold anything from then on. And it is
pinned from the other direction too: **an entry on the list that the build output
no longer ships is red** (verified in 21.5).

### 21.5 Verification (all of it actually run; a `cp` backup before every planting, `shasum` checked after restoring)

**Three plantings, one build, all caught by the artifact side** (three
hand-written rules in `styles.css`, each with live wearers):

```
AssertionError [ERR_ASSERTION]: 3 colour(s) ship in the stylesheet that no @theme token accounts for:
    index-Dh25SbvH.css: .empty-hint { color: … #639 … }
    index-Dh25SbvH.css: .mono { background: … #de394b … }
    index-Dh25SbvH.css: .panel-head { border-bottom: … #7a3f3f … }
```

`pnpm build` **exit 1**. On the same tree the source side goes red too, reporting
three (`styles.css:1081 → background: oklch(`, `:1501 → color: rebeccapurple`,
`:1582 → border-bottom: #7a3f3f`).

**A/B: swapping the source side's regex temporarily back to the old three
spellings**, same plantings — only the third is reported:

```
  styles.css:1582 → border-bottom: #7a3f3f
```

That is F2's original criterion, and the measured evidence that the two readers
are not redundant with each other: of the two the old reader missed, the artifact
side misses none.

**Four hollowness assertions, each planted red** (all done on the artifact,
without touching shared source):

- Move `out/renderer/assets` away → it throws rather than skipping (§16's
  assertion, re-verified this round).
- Replace every hex in the build output with `initial` → `only 6 colour values
  found across 1018 shipped declarations. The palette alone accounts for more
  than forty; the colour reader has stopped reading…`.
- Append `:root,:host{--color-evil:#663399}` to the end of the build output and
  use it in one rule → `1 palette variable(s) are declared on :root in the shipped
  stylesheet and nowhere in the @theme block: --color-evil`.
- Add a fake entry to `TAILWIND_INTERNALS` → `1 entr(ies) on TAILWIND_INTERNALS
  excuse a colour the artifact no longer ships: --tw-gone: #abcdef`.

**Four gates**:

- `pnpm build` **exit 0**, last line
  `audit-shipped-css: 506 class rules in 1 stylesheet(s), 39455 B — all worn
  (12 exempt, 7 blocklisted and confirmed unused); 76 colour values, all from the
  38-colour palette (1 exempt)`.
- `pnpm test` — `apps/desktop` **1548 / 1548, 0 failures**. This section adds **0**
  cases: what changed is how one existing assertion reads, not one more assertion.
- **0** arbitrary-value selectors in the build output; still **1** `.css` file
  under `src/renderer` (2153 lines).
- `pnpm typecheck` **did not return to 0** this round; it is red at
  `ui/__tests__/control-spec.test.ts:1038` on `row.colourOnly` — that is the table
  F3 is writing in the same round, not in either of the two files this section
  changes. The two files this section does change, `theme-contrast.test.ts` and
  `scripts/audit-shipped-css.mjs`, report zero errors.

**Once again on a moving tree (§12.10 and §16.7 each recorded one; this is the
third, and this one is uglier)**: the planting window was only a few minutes, yet
another agent's restore action **brought the three planted rules back into
`styles.css` twice** — once after I had restored with `cp` and the `shasum` check
had passed, and again after that. Both times it was resolved by using `diff`
against the backup to confirm line by line that "the difference is exactly the
three lines I planted, with nobody else's changes mixed in", and then **deleting
only those three lines** (not overwriting the whole file). In the end
`styles.css`'s `shasum` returned to the pre-planting `a8f3bc90…`, `diff` against
the backup was byte-identical, and the probe `grep` counted 0. No `git checkout`
and no `git stash` this round.

### 21.6 Two notes for whoever comes next

- **The source side's list can get longer, but it will never be more than a
  list.** Before adding a spelling, ask: would the artifact side already have
  caught it? Almost certainly yes. The reason to add it should be "make the author
  go red while writing", not "plug a hole".
- **`TAILWIND_INTERNALS` is not a car park**, the same rule as `FOREIGN_DOM`. It
  holds only "the seed values Tailwind sows into its own `--tw-*` namespace". A
  colour in the build output that no token claims, if one of our own rules paints
  it, is bypassing the palette, and the thing to do is give it a name.

---

## Section 22 · The second channel: inline `style`, `!important`, and the layer the UA paints itself (round 7, 2026-08-06)

### 22.1 This round's premise is the shape the first six rounds share

Every fence in the first six rounds reads exactly **one channel** — the class-name
string, or document order, or stylesheet text, or the build output CSS. But this
repository often writes through a **second channel**, and the second channel
sorts ahead of the first: inline `style`, `!important`, and the UA's default for
`color-scheme`.

- An inline `style` is in no stylesheet, and not in the build output CSS either —
  it is in the JS bundle.
- An `accent-color` the UA paints is **written nowhere at all**.

So this section does two things: fix three bugs that are shipping (A1 / A2 / A3),
and add a third reader for colour literals (B). A fourth class — colours computed
at runtime — is explicitly out of this section's range; the reason and the
handover are in 22.6.

### 22.2 A1 — `color-scheme` is declared nowhere in the repository, so a 39th colour has been shipping all along

The criterion is measured, not read:

- Not one `color-scheme` anywhere under `src/`, **0** `prefers-color-scheme`
  queries in the renderer, and
  `getComputedStyle(document.documentElement).colorScheme` reads `normal`.
- `normal` is not neutral. Chromium paints `accent-color: auto` controls with the
  **light scheme's** accent. Sampled against a screenshot of the real build
  output in Electron (the fill area of a checked checkbox, modal pixel):

| `color-scheme` on the root | measured control fill | against `--color-bg` rgb(22,24,28) |
|---|---|---|
| `normal` (what shipped before this change) | **rgb(1, 117, 255)** | **4.22:1** |
| `dark` (after this section) | **rgb(153, 200, 255)** | **10.21:1** |

(The task handover wrote these two as 4.18 / 10.21; 4.18 did not reproduce — same
background, same formula, measured 4.22. A gap of 0.04, recorded here rather than
erased.)

Riding on this: 4 `<select>`s, 4 `<input type="number">`s, the connection
dialog's checkbox, the radio in settings, the password field — **plus two
surfaces no amount of page-level work can change**: the `<select>` system popup
and Chromium's autofill panel. Those last two are the reason to solve this once
at the root rather than control by control.

**Why its home is `styles.css` and not the utility class already in use.**
`scheme-dark` is indeed already in this repository — on the package `<iframe>` in
`packages/PackageFrame.tsx`, and **only there**. It is right there: it is a
statement about another document, spoken by the one element that owns that
document. The main window is the inverse, on three counts:

1. it is a document-level property whose element is `<html>`, and no component
   renders `<html>` (React mounts at `#root`, a grandchild);
2. it must hold **before the first frame**, or the window paints once with light
   scrollbars and then repaints;
3. a class is one step away from silently regressing once someone deletes it,
   whereas a declaration in a stylesheet is read by the stylesheet scanner.

The package iframe site stays; this section does not cover it.

It lands in `@layer base` rather than unlayered, for the reason that block writes
down for itself: **an element floor belongs where a utility class can override
it**. If some element ever really wants a different scheme, the utility on that
element wins — which is exactly the behaviour every other rule in that block
already has.

**Verification (Electron, real build output)**: six controls (checkbox / radio /
range / select / number / password), computed styles exported property by
property, once under `normal` and once under `dark`, **3,426** properties
compared — **the only difference is `color-scheme` itself**, the other 3,420
identical to the character. And the two `capturePage()` PNGs are **not equal**.
That is: the entire effect of this change lives in the layer the UA paints, and
**apart from the declaration itself, no computed CSS property can see it**. That
sentence is this round's reason to exist, and it is measured.

### 22.3 A2 — `.sr-only` ships twice, and the two happen to agree

`styles.css` hand-writes an **unlayered** `.sr-only`, and `App.tsx` also puts
that class name on the live region, so Tailwind generates its own inside
`@layer utilities`. Both are in the build output:

```
.sr-only{clip-path:inset(50%);white-space:nowrap;border-width:0;…}   ← Tailwind, layered
.sr-only{clip-path:inset(50%);white-space:nowrap;border:0;…}         ← hand-written, unlayered
```

Unlayered beats every layer, so **the hand-written one always wins** — by
construction, not by anyone's choice. The two differ in exactly one place:
`border: 0` against `border-width: 0`, and both paint "no border".

**The agreement is an accident, not a design.** Tailwind's utility is what this
class means in this repository, and it can change in any upgrade; a copy that
silently overrides it means a future divergence lands as a behaviour frozen where
nobody looked, rather than as a reviewed change. And there is no third road: who
wins is decided by who is in a layer, not by anyone's choice.

So **delete the hand-written one**; what ships is Tailwind's. The two
declarations it needs — `clip-path: inset(50%)` and `white-space: nowrap` — are
both there, read out of the build output, not out of the documentation.

**Verification**: `.sr-only` rules in the build output **2 → 1**. Adding the
hand-written one back verbatim in Electron through `insertCSS` (unlayered,
character for character), then exporting **572** computed properties plus
`getBoundingClientRect` for the same element: **0 differences**, both rects 1×1
at (−1,−1). So this deletion is the identity in pixels — measured, not argued.

If Tailwind ever really drops one of those declarations, the right move is to
write the rule back into `styles.css` **and** remove the class name from the
element — keep exactly one copy, rather than going back to picking one of two.

### 22.4 A3 — `@keyframes pulse`: our copy has never shipped

`pulse` is also the name of a keyframe in Tailwind's default theme, whose step is
`opacity: 0.5`. Two `@keyframes` under one name are settled by neither
specificity nor layer — **the last definition wins entirely**, and Lightning CSS
drops the other on the way out. On a clean tree the build output holds exactly
one `@keyframes pulse`, body `50%{opacity:.5}`. The 0.25 written in `styles.css`
has never reached a screen.

So the `alpha: 0.25` entry in `ALPHA_SITES` is **a live, green assertion about a
value that does not ship**. Nothing catches it: `audit-shipped-css` asks whether
a class rule has a wearer, and a keyframe is not a class rule; every other fence
reads this source, and the source says exactly 0.25.

The fix: rename the keyframe to `conn-pulse`, follow it in `.dot.connecting`'s
`animation`, and change the `ALPHA_SITES` key to
`styles.css:@keyframes conn-pulse` — **all in one edit**, because that census's
two-way `unclassified` / `stale` assertions will not let them move apart.

This is a real behaviour change: the 7px dot now fades to 0.25 rather than
Tailwind's 0.5. It is also exactly the value the source, the census and this
document have each been stating all along.

**Verification**: `@keyframes conn-pulse{50%{opacity:.25}}` is in the build
output. In Electron,
`getComputedStyle(.dot.connecting).animationName === 'conn-pulse'`; with
`prefers-reduced-motion: reduce` turned on through CDP
`Emulation.setEmulatedMedia` it reads `animationName: none` and
`animationDuration: 0s` — the nested reduced-motion override from §20.5 F1 **was
not broken by the rename**, which is the only thing this rename could have
broken, so it was measured on its own.

**A by-product, recorded and not fixed**: Tailwind's own `@keyframes pulse` is
still at the tail of the build output (33 B), because `--animate-pulse` is still
in `@theme` and `--animate-*` is not among those three `initial` resets.
`.animate-pulse` has no wearer in the build output. Clearing it would mean
touching `@theme`'s reset list or the blocklist, and neither is in this section's
range; `audit-shipped-css` cannot see it either, because it audits class rules
only. **This is itself a handover item**: "is there a keyframe in the build
output nobody uses" is the natural next step for the assertion in §16.

### 22.5 B — a colour literal in an inline `style` is invisible to both colour readers

The source side reads `stylesheets()`, which is `.css` and only `.css`; the
build-output side reads the `.css` that ships. **An inline `style` is in
neither.** It never becomes CSS text at any stage — it compiles into the JS
bundle, gets written onto `element.style` at runtime, and there it beats
everything in the stylesheet.

The criterion is planted, both on a **live element**
(`components/FirstRunGuide.tsx:73`, one exact inverse patch to plant and one to
revert):

```
style={{ textAlign: 'left', background: '#7a3f3f', outlineColor: 'oklch(0.6 0.2 20)' }}
```

- `pnpm build` **exit 0**, `audit-shipped-css` green (506 rules / 76 colours /
  all from the palette);
- the build output CSS is **byte-identical**, down to the `shasum` and the
  filename hash (`616020d7…`, `index-G91og2OX.css`);
- the source-side stylesheet sweep is **green**;
- both strings appear **verbatim, once each, in the shipped JS**
  (`out/renderer/assets/index-*.js`).

So add a **third reader**, in `theme-contrast.test.ts`, alongside the two that
exist:

| reader | what it reads | which rule it states |
|---|---|---|
| stylesheet sweep | `stylesheets()` (`.css`) | the authoring rule, reports file and line, red inside `pnpm test` |
| **added here** | the `.ts` / `.tsx` in `scannedSources()`, comments blanked | the same authoring rule, covering declarations that never become CSS text |
| `audit-shipped-css.mjs` | the build output `.css` | the shipping rule, independent of spelling |

Four judgements in the implementation:

1. **Reuse `COLOUR_LITERAL` as the vocabulary**, unchanged to the character: hex
   of three to eight digits, plus every functional notation (including `oklch` /
   `lab` / `lch` / `hwb` / `color()` / `light-dark()`), plus the 147 named
   colours.
2. **Scan the whole file, not just `style={{`**. Locating a reader by syntax is
   exactly the mistake §10.2 withdrew: a property list produced the border hole,
   a spelling list produced the `rebeccapurple` hole. A colour handed to a
   `<canvas>`, a `setProperty('--color-x', …)`, a colour posted to a package
   iframe — all the same failure, and none of them with a `style={{` anywhere
   near. The subject is still the **value**.
3. **Comments blanked** (the opposite of the arbitrary-value ban, and not a
   contradiction). A class name in a comment compiles into a real rule — this
   repository has paid for that four times — so that ban must read comments. But
   **nothing harvests a hex out of a comment**; reading comments here would only
   ban the sentence explaining why `#7a3f3f` was removed, which is the standard
   script for a fence getting switched off. (The two such sentences that exist
   today, in `ui/Button.tsx` and `ui/spec.ts`, are exactly that kind of sentence,
   and this reader is silent about them.)
4. **The file set comes from `scannedSources`**, filtered to `.ts` / `.tsx`.
   `.css` is already read by the sweep above; `ui/CLAUDE.md` is **excluded on
   purpose**, the one place the two bans genuinely diverge — a class name in that
   guide compiles into the stylesheet (so the ban reads it), while a hex in it
   paints nothing.

**154 files on a clean tree, 0 hits**, so the wide reading costs nothing and
needs no exemption list today. When one is really needed, add a named list with
reasons in the manner of `ALPHA_SITES` / `DECORATIVE_ONLY` — **not** a narrower
reader.

**Where this reader stops (stated, not boasted)**: it reads literals in source
text. It cannot see —

- **colours computed at runtime**: it catches `` `hsl(${h} 50% 40%)` ``, but not
  `'#' + hex`, channel arithmetic, or assembly from a lookup table;
- **colours that arrive as values**: imported from a package, returned by a
  driver, sent by a package, typed by the user;
- **colours with no literal anywhere**: A1, that is — `accent-color: auto` with a
  `color-scheme` nobody ever set, which has Chromium paint rgb(1,117,255) on nine
  controls, present in no stylesheet, no class-name string and no bundle.

All three sit downstream of every text channel, and a fence covering them has to
read **what the browser computes**. Another agent is building that fence; this
section explicitly does not claim that ground.

### 22.6 Verification (all actually run; every destructive experiment checked with `cp` + `shasum` before and after)

**B's positive criterion** (listed in 22.5 above): plant two on a live element,
only the new reader goes red, reporting
`components/FirstRunGuide.tsx:73 → #7a3f3f` and `… → oklch(`. After reverting,
`shasum` is back to `b51207b3…` and `diff` against the backup is byte-identical.
The same planting was done first in a **freshly created throwaway component**
(`ZZProbePanel.tsx`, imported by nobody), and again only the new reader went red
— but that time the two strings were **not** in the bundle (tree-shaken away),
which is exactly why it had to be planted a second time on a live element.

**Four inverse assertions, each planted red** (all touching only the two files I
own):

- census key changed back to `@keyframes pulse` → red:
  `These use \`opacity\` and are not in ALPHA_SITES` (`stale` reports as well,
  which is the whole point of it being two-way).
- the new reader's file filter changed to a suffix that does not exist → red:
  `found only 0 .ts/.tsx files under the renderer`.
- the new reader's "inline style channel" probe broken → red: `only 0 of the 154
  scanned files contain an inline style object, and thirteen did when this was
  written`.
- the hex branch of `COLOUR_LITERAL` broken → **two** reds: the new reader's
  fixture and the existing palette-scope guard each report once.

**Four gates**:

- `pnpm typecheck` **exit 0**.
- `pnpm test` — `apps/desktop` **1554 / 1554, fail 0** (net **+2** against the
  previous round's 1552 baseline: one for the new reader itself, one fixture for
  "the reader recognises the shapes an inline style can carry").
- `pnpm build` **exit 0**, last line
  `audit-shipped-css: 506 class rules in 1 stylesheet(s), 39388 B — all worn (12 exempt,
  7 blocklisted and confirmed unused); 76 colour values, all from the 38-colour palette (1 exempt)`.
- **0** arbitrary-value / arbitrary-property class selectors in the build output;
  still **1** `.css` under `src/renderer`.

**The numbers**:

| | before | after |
|---|---|---|
| build output CSS | 39,455 B | **39,388 B** (−67: one duplicate `.sr-only` removed, one `:root` added, plus Tailwind's now-unclaimed `pulse` at 33 B) |
| class rules | 506 | 506 |
| `styles.css` | 2,153 lines / 471 code | **2,222 lines / 463 code** |
| `.sr-only` in the build output | 2 rules | **1 rule** |
| our own pulse in the build output | none | `@keyframes conn-pulse{50%{opacity:.25}}` |

Per the rule in §12.10: 1554 is only this run's reading; what can serve as a
contract is `fail 0`.
This round used **no** `git checkout`, **no** `git stash`, and **no** whole-file
`cp` restore over someone else's file; the one touch to someone else's file was
the planting in `FirstRunGuide.tsx`, through an exact inverse patch that refuses
to run unless the needle occurs exactly once, with a matching `shasum` before and
after.

### 22.7 Three notes for whoever comes next

- **The `.sr-only` class of bug has no fence today.** "One class selector
  shipping twice, from two sources, one silently overriding the other" can only
  be judged in the build output, so its home is `audit-shipped-css.mjs`, not any
  test that reads source. The same script should also answer "is there an
  `@keyframes` in the build output nobody uses" — Tailwind's `pulse` is one right
  now.
- **The third reader is a text reader, and it stops at literals.** Before adding
  a spelling, ask whether the build-output side already catches it. What
  genuinely lies downstream of it is the layer of values the browser computes,
  and that is a different fence — do not write its credit onto this one.
- **Do not "tidy" the `color-scheme` declaration into a utility class.** It sits
  on `:root` in `@layer base` for a conjunction of three reasons (22.2);
  deleting it turns no test red, and the window quietly returns to light accents.

---

## Section 23 · Four holes in the cascade fence itself (round 7 adversarial audit, B1–B4)

### 23.1 What this section fixes is round 6's fence, not the stylesheet

`__tests__/cascade-order.test.ts` was written in round 6 for the regression where
merging reordered a reduced-motion override. The audit planted four things in it,
and all four times it stayed **12/12 green**:

| | what was planted | why it passed |
|---|---|---|
| B1 | an `!important` on `.dot.connecting`'s `animation` | the fence's win model has no rung for importance |
| B2 | a genuinely broken pair of reduced-motion rules whose last declaration **has no semicolon** | a declaration is only recorded on a `;` |
| B3 | a flat `@media` shadowed dead by a later unconditional rule on the same selector | the same-selector skip cannot tell nesting from flatness |
| B4 | the two rules swapped **in the build output** | the fence reads source and has never read the build output |

B1 carries something worse: that file's header comment says "`!important` and
inline `style`. **Neither of the two is in this sheet.**" — and `styles.css` holds
**4** `!important` declarations. **A false premise is worse than a missing one,
because it reads as though it had already been checked.**

This section changes one file:
`apps/desktop/src/renderer/__tests__/cascade-order.test.ts`. `styles.css` is
untouched to the byte (`shasum` is `9a387bd3…` before and after).

### 23.2 B1 — importance enters the model, and the four `!important`s go on a list

Two things, neither optional:

1. **`winner(a, b, prop)` gained a parameter.** `!important` is decided **per
   declaration**, so "who wins" is not even a complete question without a
   property: two rules can have different winners across three properties.
   Importance now ranks **ahead of** specificity and document order, and every
   declaration on a `Block` carries an `important` flag. Inverse-checked: plant
   that `!important` back on `.dot.connecting`'s `animation` and **3 tests go
   red**, reporting
   `… loses to … over animation-name (!important on the rule being overridden)`.
2. **`IMPORTANT_SITES`, 4 entries, each with a reason.** Not because 4
   `!important`s are a problem, but because importance **inverts the whole
   model** this file computes: it lets the **lower**-specificity rule win, while
   the collision census only pairs blocks of equal specificity — structurally
   invisible. The list is keyed on selector plus property (moving a rule does not
   matter, renaming one goes red), asserted both ways: anything not on the list
   is red, and a dead entry on the list is red too.

A third assertion stands on its own: **no `!important` lands on a motion
property**. That is not a coincidence — it is the one way
`prefers-reduced-motion` can lose that no amount of nesting recovers, so it is
written down.

The four are: the CodeMirror selection background (it writes inline styles at
runtime itself, and this is the one site in the sheet where `!important` is
**answering the second channel** rather than arguing inside the first), `cursor`
/ `user-select` during a drag, and `cursor` on the no-drop variant.

### 23.3 B2 — a declaration ends at a `;` **or** at the end of the block

`.dot.connecting { animation: none }` is legal CSS. The old walk recorded a
declaration only at a `;`, and the inner walk's range is `[i+1, j)` — `j` being
the index of that closing brace, so it **never sees its own `}`**. The result is
not "compared and let through", it is that **the rule does not exist at all**:
the block's `props` is empty → it fails the "shares a property" filter → it
vanishes from both censuses at once.

The fix is one line: `flush(to)` once more after the walk's loop ends.

Inverse-checked, and in **both directions**:

- plant a genuinely broken semicolon-less pair of reduced-motion rules →
  `is never left in a position it loses from` and
  `never wins by document order alone` **both go red**;
- switch `flush(to)` off and run the same planting again → those two are **green
  again** (only the parser fixture added in this section is red). That is the
  direct reading of "the old parser was completely blind to it".

### 23.4 B3 — the criterion moves from "different condition counts" to "is it written inside"

The old criterion: `same selector && different condition count → skip`. The
comment said what it skipped was "a nested narrowing override", but that
predicate cannot tell nesting from its opposite:

```css
@media (min-width: 700px) { .x { color: red; } }   /* flat, first */
.x { color: blue; }                                /* unconditional, later — it wins whenever the query holds */
```

Same selector, different condition counts, so it is **silently skipped** — and it
is dead code: at any viewport width, the first rule paints nothing.

The fix: `Block` gains a `path` (the index of each enclosing `{`).
`nestedIn(inner, outer)` is then "`outer.path` is a proper prefix of
`inner.path`" — **a structural question, not a positional one**. The skip
condition becomes "same selector **and** one is genuinely written inside the
other".

The criterion also moves to **after** the `within()` check, and the whole
collision census is extracted into a `collisions()` function. The extraction is
not tidying: **run it with the old criterion and fixtures that exercise only the
parts — `nestedIn`, `winner` — stay green**, and only a fixture running the full
`collisions()` goes red. That one was measured.

Inverse-checked: plant the pair above → `no equal-specificity collision is
undeclared` goes red; put the old criterion back and run again → 22/22 green.

### 23.5 B4 — not asserting that order, but no longer needing it

The old header comment said: Lightning CSS emits a nested `@media` immediately
after the parent rule's declarations, so depth-first source order is shipping
order — **and it wrote down byte offsets**. The first two auditors both confirmed
that sentence by hand, and **reported two different sets of offsets (33286 /
33255)**. The order part is true, the numbers are not: an offset copied out of
the build output expires on the next build. This is the §13 lesson "a set does
not answer an order" **one level up**: source against build output.

(This round measured a third set: `.dot.connecting` at 33097, the override at
33196. Three runs, three sets of numbers — that is itself the argument.)

So the strict half **no longer asks "who comes later"**; it asks "**could it be
moved and lose**", and requires the answer to be no. Two shapes count:

- **nested inside the rule it overrides** — there is no such thing as an order
  between the two blocks;
- **strictly higher specificity** — order does not participate.

An override that wins by position today is red even when it is correct. **That is
the whole lesson: merging eight sheets broke no rule, it only moved one.**

A reader was still added on the build-output side, but it is not what holds this
guarantee up: when `out/renderer/assets/*.css` exists,
`describe('the shipped stylesheet')` **runs the whole reduced-motion census again
on the build output**; when it does not, it asserts the source-side
order-independence guarantee itself — **no path is an empty assertion**, which is
the shape you get from taking §16.3's rule ("skipping when the build output is
absent is fail-open") seriously rather than routing around it. The genuinely
unconditional build-output assertion belongs in `audit-shipped-css.mjs` (§22.7
already assigned that ground to it), and that file was not mine to change this
round.

Inverse-checked, and this one is the cleanest of the four: **edit the build
output directly**, swapping the two rules (exact inverse patch, refused unless
the needle occurs exactly once) — **the 21 source-side tests stay green and only
the build-output one goes red**. After reverting, `shasum` is back to
`616020d7…`. The build-output path was also pointed at a directory that does not
exist, confirming the fallback branch really asserts (with B2's pair planted at
the same time, the fallback goes red).

### 23.6 The second channel picked up along the way: motion properties in inline `style`

The header comment's "inline `style` is not in this sheet" is a category error:
an inline `style` **never** appears in any stylesheet. There are **24** of them
in the renderer (counted after blanking comments), they beat everything in every
stylesheet, and so **no `prefers-reduced-motion` block can answer them**.

The new assertion covers motion only, and recognises three shapes: JSX
`style={{ … }}`, `el.style.animation = …`, and `setProperty('transition', …)`.
**Locating the reader by syntax is right here and wrong in §22.5**, because the
subject differs: there the subject is the **value** (a hex handed to a canvas is
the same failure, with no `style={{` nearby), here the subject is **a declaration
that beats the stylesheet**, and only those three shapes can be that thing.

It comes with a hollowness guard: file count > 100 (154 today), inline style
objects > 15 (24 today), plus four shape fixtures (shorthand / camelCase
longhand / template value / a word like `transitionable` that merely shares a
prefix).

### 23.7 The header comment's premises, checked one by one

The requirement for this section was that **every premise be true**, so each was
checked, not just the `!important` sentence:

| premise | result |
|---|---|
| "neither `!important` nor inline `style` is in this sheet" | **false** (4 of them) plus a category error → rewritten entirely, into something asserted |
| "Lightning CSS's shipping order = source order, offsets 33192 / 33286" | order true, numbers false (a third measurement gave a third set) → numbers deleted, the dependency removed |
| "`styles.css` is almost entirely unlayered" | **true**: 63 of 73 blocks are unlayered |
| "`@layer theme, base, components, utilities` settles the rest" | **true**: `styles.css:186` |
| "chat's two loops are stopped by motion-reduce variants on the elements" | **true** (`ChatView.tsx` / `ToolCallCard.tsx`); the live class names in the prose were replaced with a description |
| "today it should find `.dot.connecting` against itself" | **true**: the census finds exactly one pair, with `nested=true` |
| "`CASCADE_LEDGER` is empty, and that is a measurement" | **true**: re-run after the B3 fix, collisions are still 0 |
| "the build output is at `out/renderer/assets/*.css`" | **true**, and it was actually read this round (550 blocks) |

`CASCADE_LEDGER` gained a fourth field, `emitted`: a ledger entry is by
definition the shape where order decides the winner, and this file reads the
order of the **source**. So whoever writes an entry has to write down how they
confirmed that winner **in the shipped stylesheet** — **record relative order,
not byte offsets**; two auditors confirmed one true thing with two different sets
of numbers precisely because they recorded offsets. The list is empty today, so
the field costs nothing today.

### 23.8 Four gates

- `pnpm typecheck` **exit 0**.
- `pnpm test` — `apps/desktop` **1564 / 1564, fail 0** (net **+10** against this
  round's 1554 baseline; `cascade-order.test.ts` itself went from 12 tests to
  22).
- `pnpm build` **exit 0**, last line
  `audit-shipped-css: 506 class rules in 1 stylesheet(s), 39388 B — all worn (12 exempt,
  7 blocklisted and confirmed unused); 76 colour values, all from the 38-colour palette (1 exempt)`.
- **0** arbitrary-value / arbitrary-property class selectors in the build output;
  still **1** `.css` under `src/renderer` (2,222 lines).

Per the rule in §12.10: 1564 is only this run's reading; what can serve as a
contract is `fail 0`.
This round used **no** `git checkout`, **no** `git stash`, and **no** whole-file
`cp` restore. Every destructive experiment went through an exact inverse patch
that refuses to run unless the needle occurs exactly once, and was planted in
only two places: **the test file I own** and **a build output that can be
regenerated**. `styles.css` has a matching `shasum` before and after
(`9a387bd3…`), and the build output's `shasum` matches again after reverting
(`616020d7…`).

### 23.9 Three notes for whoever comes next

- **A fixture for the parts is not a fixture for the fence.** B3's first fixture
  exercised `nestedIn` and `winner`, and stayed green with the old criterion put
  back. The inverse check for a census has to run **that census**, which is the
  entire reason `collisions()` was extracted into a function.
- **Never write a build-output byte offset down anywhere.** It changes with every
  build, and the thing it proves needs only relative order. Three rounds, three
  sets of numbers, all three proving the same true thing — this is a lesson about
  **what to record**, not about anyone measuring wrong.
- **This file still reads only text.** It reads the stylesheet, the source, and
  (when there is one) the build output. It cannot see what the browser computes —
  the layer the UA paints, values assembled at runtime — which is another fence's
  ground (end of §22.5), and its credit does not belong on this one.

---

## Section 24 · Three fences that read the wrong thing (round seven adversarial audit, B5–B7)

### 24.1 What this section fixes is three **readers**, not the things they read

B5 / B6 / B7 are three instances of one shape, and it is the same sentence as §22.1:
**a fence reads one channel, and more than one channel is being written.**

| | Fence | What it reads | What is written from the side |
|---|---|---|---|
| B5 | `consent-scroll.test.ts` | class-name strings (TypeScript AST) | inline `style`; and **one word in another module** (the modal shell's main axis) |
| B6 | `control-spec.test.ts` §3b | border-style **keywords** | a keyword and what gets **painted** are not the same thing: at 1px, `border-double` paints as a solid line |
| B7 | `audit-shipped-css.mjs` | the build output CSS | the build output can be from **the previous tree**; change the source without rebuilding and the script still says "all pass" |

This section changes three files, all of them mine:
`components/context-actions/__tests__/consent-scroll.test.ts`,
`ui/__tests__/control-spec.test.ts`, `scripts/audit-shipped-css.mjs`.
`ConsentDialog.tsx` / `modalClasses.ts` / `ui/spec.ts` were touched only as
**planting targets**, every time as an exact inverse patch that refuses to run
unless the needle occurs exactly once, with identical `shasum` before and after
(see 24.5).

### 24.2 B5 — one inline `style` walks straight around the consent dialog's fence

`consent-scroll.test.ts` reads `className` out of the AST and asserts "the body is
in a box that scrolls, the answer is not, and the answer's row must not be
squashed". The evidence is planted:

```jsx
style={{ overflow: 'visible', flex: 'none' }}
```

added to the scrolling region, **without changing a single byte of any class
name**. 767/767 green, the build output CSS byte-identical — of course: an inline
declaration never becomes CSS text, it compiles into the JS bundle and is written
onto `element.style` at runtime, where it beats everything in the stylesheet. And
the original defect from §20.5 F4 comes back exactly as it was: at a 320px
viewport the English Accept sits at y=287..313, the shell ends at 288, and a hit
test at the centre point returns the overlay.

The same round planted a second one: delete the **column direction** from the
modal shell's shared class string. Again 767/767 green, while the shell grew to
the 320px ceiling and the Accept box measured 298px tall. That one is not even a
"second channel" — it is inside the first channel, only written in a shared
constant in **another module**, while this file reads the dialog's own classes.

**The fix has two halves, and the second is one line:**

1. **Assert the axis.** The premise test now pins both `flex` and `flex-col` on
   the shell. The reason is written into the assertion: every flex-child class
   below says "what to do along some axis", and that axis is decided by one word
   somewhere else.
2. **Ban inline `style` only on these three boxes, and only for these
   properties.** This has to be narrow, and the narrowness has to be **written
   down**: inline `style` is house style here, not a smell — the shell wears one
   itself, and a whole section of `modalClasses.ts` argues that a size landing on
   no step of the scale should be written as an inline `style` and should not go
   into the token layer. A blanket ban stops the wrong thing, and the next author
   is right to route around it.

   So the criterion is `CLAIMED_PROPERTIES`: **ban exactly the properties this
   file's reasoning is built on** — `overflow*` (the shell clips), `display` /
   `flexDirection` (it is a column), `height` / `maxHeight` (it has a ceiling),
   `flex*` / `minHeight` (the body takes the slack and can shrink to zero),
   `position` (both boxes are still in flow). The **size** on the shell stays
   legal, and it is not being waved through: `maxHeight` is pinned by name by the
   premise test above.

   `style` is read by the rule from §15.2 — **if you cannot read it, refuse; do
   not follow the name one hop**. `style={SOMETHING}` is red here, not green. The
   only indirection resolved is the spread of `MODAL_SIZE`, and that is not a
   hop: the object is imported in this very file, and its `maxHeight` is asserted
   by name a few lines above.

### 24.3 B6 — §3b reads a keyword, not what is painted

`border-double` at 1px paints as **one unbroken solid line**: CSS leaves anything
under 3px to the implementation, and Chromium does exactly that. The measurement
from round six (Electron's own Chromium, device scale 2, `#b4b4b4` on black, a
luminance cross-section through the top edge row):

```
width 1px   solid [156,156,41,0]              double [156,156,41,0]
width 2px   solid [143,197,197,143,37,0]      double [143,197,197,143,37,0]
width 3px   solid [143,193,184,184,193,143]   double [156,152,28,28,152,156]
```

Byte-identical below 3px. So swapping `caution`'s dashed border for
`border-double` makes §3b record the pair as "told apart by `style`" and pass it,
while the two controls look identical on screen.

**The only thing that stopped it at the time came from an unrelated assertion, and
that assertion's message was wrong**: `no atomic class invents a colour` reported
that `border-double` wants `--color-double`, telling the author to add a colour
token. Its `KEYWORDS` was missing `double` and `hidden` — both real Tailwind
utilities — and the most natural response to that message (add `double` to the
set) is **exactly** what lands this bypass at 767/767 with a clean build.

> **A correct refusal with a misleading reason is an invitation.**

So the fix is to the set **and** the message, not just the set:

- The two `KEYWORDS` merge into one `BORDER_STYLE_KEYWORDS` hoisted to the top of
  the file (six of them, exactly what Tailwind can spell; CSS also has `groove` /
  `ridge` / `inset` / `outset`, no utility spells them, and writing one should be
  red). The census and §3b can no longer disagree about what a keyword is.
- `border-*` gets its own refusal message that **names both vocabularies**: not a
  colour named by `--color-x`, and not one of these six keywords. And a line is
  hardcoded at the end of the overall message: this error is **not** an invitation
  to add a word to `BORDER_STYLE_KEYWORDS` — that set is read by §3b, and adding a
  word means teaching it what the word paints as well.
- "anything left is a style keyword" in `formRole()` becomes **assert-fail on
  anything it does not recognise**. That sentence is the quiet half of the same
  hole: it gives every unknown value a channel and a distinct value, so `border-t`
  or a typo would tell a pair of variants apart because nobody recognises it.
- New `painted(style, width)`: `double` folds to `solid` below 3px, `none` and
  `hidden` fold into the same "paints nothing", and at width 0 every keyword is
  empty. §3b compares what comes out **after** the fold, so "this pair is told
  apart by style" means it really is visible in a greyscale screenshot.

**A latent one found along the way: §3b's header comment said the four slots
`Button.tsx` composes are the whole input, while `variantSpec()` reads only two of
them.** The size step carries no paint, so dropping it is free; but `elevated`
**replaces** `surface` rather than stacking on it (which is the entire reason
`surface` is a field of its own), and under it every variant fills the same base
colour. So **any pair whose only colourless separation is fill has no separation
left once both sides are elevated**. The header comment's line about an assertion
below that rejects a row whose separation is exactly `['fill']` was at the time
**a sentence with no assertion behind it** — this section adds the assertion.
Which is itself one more instance of the thing this document keeps saying: prose
does not execute.

### 24.4 B7 — `pnpm audit:css` fails open on a **stale** build output

§16.3 designed for a **missing** build output, and verified it (it throws loudly),
while at the same time writing the standalone entry point `pnpm audit:css` into
`package.json`. The **stale** case was never considered, and it is easier to hit
than the missing one: the script takes a second, the build takes a minute.

The evidence (done on a **copy** that is file-for-file identical to the real tree,
see 24.5): plant four unaudited colours into `styles.css` — a named colour, an
`oklch()`, a hex and an `hsl()`, all four rules with live wearers — then run the
script **without rebuilding**:

```
audit-shipped-css: 506 class rules in 1 stylesheet(s), 39388 B — all worn (…);
76 colour values, all from the 38-colour palette (1 exempt)
EXIT 0
```

It is not lying, it is **faithfully describing a stylesheet nobody is shipping** —
and in exactly the wording it uses on a clean tree. This is fail-open in a
different coat.

The fix is about three lines: `readArtifact()` compares the build output's own
mtime against the newest of the files that produce it, and refuses if the source
is newer. `newestSource()` still reads both scanners, `scannedSources()` +
`stylesheets()`, for the same reason as "discover, do not enumerate" in
`sourceScan.ts`. Both halves are needed: `styles.css` is where colours are
declared, `.ts` / `.tsx` is where classes are worn, and the latter decides whether
a rule gets compiled at all.

**Deliberately does not cover anything outside `src/renderer`.** The main process,
the packages and the config can all change the bundle, and none of them can change
the stylesheet — Tailwind scans exactly what `@source` says. Widening it to the
whole repo would make this guard shout on edits that cannot possibly be relevant,
and a guard that shouts at nothing gets deleted.

The message spells out a third way out: if it goes red **during a build**, then
somebody wrote source after the renderer output was emitted (a concurrent edit).
That is still the right answer — the build output really does not match the tree.

### 24.5 Verification (all actually run; destructive experiments are always exact inverse patches, `shasum` checked before and after)

**Six plantings, each watched go red, then reverted.** The three target files'
`shasum` are identical before and after: `ui/spec.ts = 7b061d2b…`,
`components/modalClasses.ts = dd8f1fc2…`,
`context-actions/ConsentDialog.tsx = 62b7a1cb…`.

| # | Planted where | What was planted | What it reported |
|---|---|---|---|
| B5-1 | `ConsentDialog.tsx` scrolling region | `style={{ overflow:'visible', flex:'none' }}`, class names untouched | `the scrolling region sets \`overflow\`, \`flex\` in an inline style` — 1 red |
| B5-2 | `modalClasses.ts` | column direction deleted from the shell class string | `the shell no longer stacks its children vertically` — 1 red |
| B5-3 | `ConsentDialog.tsx` scrolling region | `style={MODAL_SIZE}` (a shape it cannot read) | `not an object literal written in the tag … Write the object at the call site` — 1 red |
| B6-1 | `ui/spec.ts` | `caution`'s dashed border swapped for a 1px `border-double` | **7 red**, three of the four pairs reporting `no longer differ in: style`, and `danger/caution` reporting that no channel survives greyscale. **The colour census said nothing** — which is exactly what this section wants: the refusal happens in the right place, for the right reason |
| B6-2 | `ui/spec.ts` | `border-groove` (a keyword CSS has and Tailwind does not) | the census reports `` `groove` is neither a colour --color-groove names nor a border-style keyword (solid, dashed, dotted, double, hidden, none) ``; `formRole` separately reports "teach formRole" |
| B6-3 | `ui/spec.ts` | `default`'s surface transparent in all three states → one pair left with nothing but fill | the new assertion fires once on each of the pairs `primary/default` and `default/danger`: `told apart … by whether the surface paints — and by nothing else` |

**B7's two plantings were done on a copy of the tree**, because it has to modify
`styles.css`, and three other agents were working in that file at the time. The
copy is three verbatim copies — `scripts/` + `src/renderer/` +
`out/renderer/assets/` — running **the same script**, and on a clean run its
readings are word-for-word those of the real tree
(`506 class rules … 39388 B … 76 colour values`), so it is not a model, it is the
same thing in a different directory.

- **Before the fix**: plant four colours, no rebuild → `EXIT 0`, the readings
  above.
- **After the fix**: the same planting → `EXIT 1`, reporting
  `the shipped stylesheet is older than the sources that produce it: styles.css modified … / index-*.css built …`.
- **Inverse**: revert the planting, `touch` the build output → back to `EXIT 0`.
- **mtime only**: `touch src/renderer/components/App.tsx` → `EXIT 1` (it catches
  milliseconds too: 47.363 against 47.249).
- **Hollowness guard**: remove `scannedSources` from `newestSource()` (leaving 1
  file) → `only 1 source files found … which passes for exactly the wrong reason`,
  `EXIT 1`.

**Four gates**:

- `pnpm typecheck` **exit 0**.
- `pnpm test` — `apps/desktop` **1575 / 1575, 0 fail** (this round's baseline was
  1564, net **+11**: +1 in the consent file, +1 per variant pair in `control-spec`
  for 10).
- `pnpm build` **exit 0**, last line
  `audit-shipped-css: 506 class rules in 1 stylesheet(s), 39388 B — all worn (12 exempt,
  7 blocklisted and confirmed unused); 76 colour values, all from the 38-colour palette (1 exempt)`.
  Running `pnpm audit:css` on its own straight after is also **exit 0** — the new
  staleness check does not shout on the normal path.
- Arbitrary-value / arbitrary-property class selectors in the build output: **0**;
  `.css` files under `src/renderer` still **1** (2,222 lines).

Per the rule in §12.10: 1575 is only this run's reading; what can be a contract is
`fail 0`. This round used **no** `git checkout`, **no** `git stash`, and **no**
whole-file `cp` restore over anyone else's file.

### 24.6 Three notes for whoever comes next

- **An assertion's narrowness has to be written next to the assertion.** Had B5's
  inline-`style` ban been blanket, it would be stopping the thing `modalClasses.ts`
  recommends in plain text; the next person is right to route around it, and once
  they do, the fence is only a shape. The narrow criterion (three boxes × one
  `CLAIMED_PROPERTIES` list) is itself the carrier of the "why it is not blanket"
  sentence.
- **The message is as much a part of the fence as the criterion.** B6's hole was
  not "a word missing from a set" — a missing word only causes a false positive,
  which is the safe direction; the hole is that **the message pointed the author at
  the wrong fix**, and that fix happens to let the bypass in. Whenever you fix a
  set, ask on the way past: what will this error make someone do?
- **"Build output missing" and "build output stale" are two failures, not one.**
  §16.3 handled the first carefully and recommended the standalone entry point on
  the way past, thereby creating the second. Any check that reads something
  generated elsewhere has to answer **whether it belongs to this tree**, not just
  **whether it is there**.

---

## Section 25 · The render probe: reading what the browser computed (round eight)

### 25.1 What this fixes

Every one of the first seven rounds added a fence, and the next audit found a
channel it cannot read. Round seven's audit named the shape:

> Every fence reads **one channel** — a class-name string, or document order, or
> stylesheet text, or the build output CSS — and this repo often writes through a
> **second channel**, and that second channel comes before the first:
> inline `style`, `!important`, and the UA's default for `color-scheme`.

An inline `style` is in no stylesheet and in no build output CSS; it rides the JS
bundle and lands on the element at runtime. An `accent-color` painted by the UA is
**written nowhere at all** — not in the source, not in the build output, not in the
bundle. **No fence that reads source can possibly see either of them.**

What this section adds is not an eighth "read the text" fence but a probe that
**reads what the browser computed and painted**: `getComputedStyle`,
`getBoundingClientRect`, `elementFromPoint`, and the real pixels from
`capturePage`. All four are **downstream of every channel**.

**The boundary — what this does not do**: it does not modify `styles.css` (that
file belongs to another piece of work; every destructive experiment in this
section modifies only an **in-memory copy of the build output**); it does not touch
main / preload; it does not chase pixel-exactness, only a verifiable absence of
regressions.

### 25.2 The plan

`apps/desktop/scripts/render-probe/`, five files, cut along process boundaries:

| File | Responsibility |
|---|---|
| `build-page.mjs` | **Inlines** the **shipped** stylesheet (the one in `out/renderer/assets/`) and the bundle of `fixture.tsx` into a single HTML. Both inlinings are forced by `file://`: a `<link>`ed stylesheet is cross-origin and `cssRules` throws; an external module script is blocked outright by CORS. |
| `fixture.tsx` | The page itself. Mounts **the product's own components**, invents no class names, paints no colours. One panel per load. |
| `page-checks.js` | The page side. Injected as **plain script text**, and it only **measures**, it does not judge. |
| `colours.mjs` | The allowed-colour set, derived from the build output stylesheet's **own text**, not a hand-written list. |
| `probe-main.mjs` | Node-side orchestration and **all** the judging. The failure message is written once, in the only place that can report a file name and a number. |

Why measuring and judging are separate: an error has to be able to name names. The
`checks.mjs` that history called out does not exist; the comment has been
corrected.

**Six checks**, each one matching a defect that really happened this round:

1. `sanity` — is this even a styled page? Three independent answers, all required:
   the stylesheet's rules can be **counted**, the theme variables reached the root,
   and a **functional** answer (the product's own control measures like a control).
   The third is the one the other probe this round **did not** have, and the only
   one that would have caught it.
2. `accent-color` — the colour the UA paints, written nowhere. Take a histogram
   from the screenshot and compute contrast against the background.
3. `palette` — every colour on screen has to be one the build output stylesheet
   **can produce**. This is where an inline `style` shows itself.
4. `reduced-motion` — **two** readings required: without emulation the connection
   dots really do move; with `reduce` emulated nothing moves. Test only the latter
   and a blank page passes too.
5. `consent-reach` — the consent dialog's accept button is reachable and hittable
   at the **floor viewport**, in both languages. The floor is derived: main window
   minimum 900×600, UI scale ceiling 1.5, hence 600×400.
6. `border-bands` — does `border-style: double` actually paint two lines? That is
   the question a keyword cannot answer.

### 25.3 Trade-offs

**Why `border-bands` brings its own calibration rig.** This app does not have a
single two-line border (`double` appears 0 times in the build output), so on a
normal run this counter has **nothing to measure**. That is a filthy trap: a
counter that always answers "one line" still catches the planted defect and still
lets the clean run be green — red in the one place anyone checks, blind everywhere
else. **Proving a fence goes red is only half a proof.** So every run first stands
up a rig with a known answer (3px, the narrowest width where line, gap and line
each fill exactly one pixel) and demands the counter read **2** on double and **1**
on solid; only a counter that has just proved it can tell those apart is allowed to
say anything about the real page. The criterion's tolerance is **derived, not
hardcoded**: `borderStrip` leaves background on both sides of the border, so the
two ends of the cross-section **are** the two neighbouring colours, and the
threshold sits halfway between them. Taking half rather than a third is deliberate
— the two directions of error are not symmetric: too loose fills in a real gap, a
real double reads as one line, and the check **shouts**; too tight splits solid's
antialiased interior in two, so a collapsed 1px double reads as healthy and **the
defect passes silently**. Between a false positive and a false negative, this fence
picks the false positive.

**Why all the judging is on the Node side.** An error thrown from the page has no
file name and no reproducible command in its message.

**Why planting a defect only modifies an in-memory copy of the build output.**
`styles.css` is someone else's file. `readShippedCss()` already returns a
**string**, everything downstream runs on that copy, and the page is written to
`out/render-probe/`. A planted defect **does not outlive the process that planted
it**.

**Why `reduce` is emulated over CDP rather than with a command-line switch.** That
switch is **process-wide**, and it would put **every** panel this round into
`reduce`, including the panel whose whole job is to prove the thing was moving in
the first place.

### 25.4 It is guaranteed to terminate

The two previous people to take this task on were both killed by an Electron
process that started in the foreground and never exited. So "it terminates" is a
design requirement, not a wish:

- a **global watchdog**, armed before anything else starts, which on timeout
  reports **which stage it died in** and calls `process.exit(1)`. It is not
  `unref`'d — it is meant to fire;
- every await that touches the page goes through `withDeadline`;
- **every** path calls `app.quit()`, the error paths included. And **the exit code
  is published before the shutdown**: the first version hung `app.exit(code)` on a
  300ms timer, `app.quit()`'s graceful shutdown beat it, and so **stdout said the
  check failed while the exit code was 0**. Now `process.exitCode` is set first and
  `app.exit(code)` is called synchronously and unconditionally;
- `window-all-closed` is **swallowed deliberately**: its default is to quit the
  whole app, and this probe uses one window per panel, so without the swallow the
  second panel's `loadFile` would race a shutdown that has already begun.

### 25.5 Fail closed, and proved

This repo has **six** prior cases of "the scanner quietly read nothing", and this
round added one more: a probe that produced a whole set of perfectly plausible
numbers **on a page whose stylesheet never loaded**. So there is **no skip branch**
here: the page fails to build, the stylesheet is missing or too small, the panel
mounted nothing, the injected script did not evaluate, or a check found no subjects
where it requires subjects — every one of them **fails**.

### 25.6 How it joins the pipeline

It hooks onto the last step of `pnpm build` (after `audit-shipped-css`), on the
same `&&` chain. **A check nobody runs is worse than no check, because it looks
like coverage.** It needs a build and an Electron launch, so it does not belong in
the unit test suite.

    pnpm --filter @peek/desktop build          # the probe measures the build output
    pnpm --filter @peek/desktop probe:render   # or run it on its own

### 25.7 Verification (all actually run)

Baseline: `pnpm typecheck` 0 · `pnpm test` 1575/1575 fail 0 · `pnpm build` 0.
Still exactly one `.css` under `src/renderer`. A clean run is **1.76–1.79 seconds
wall clock**, remeasured three times, exiting on its own every time.

Seven planted defects, each planted with `--plant=<name>` and with the **verdict
inverted** (exit 0 only if that one check goes red), all PLANT PROVEN, 1–2 seconds
each:

| Planted | Caught by | Evidence |
|---|---|---|
| delete `color-scheme` from the root | `accent-color` | rgb(1,117,255) against the background **3.97:1**, below the 4.5 floor; fixed it is rgb(153,200,255) **9.60:1** |
| write a colour into an inline `style` | `palette` | rgb(122,63,63), which the build output stylesheet cannot produce |
| put the reduced-motion override out of reach | `reduced-motion` | the connection dots still run `conn-pulse` (1s, infinite) under `reduce` |
| lay a transparent sheet over the dialog | `consent-reach` | the click at the accept button's centre lands on a div, in both languages |
| a 1px two-line border | `border-bands` | cross-section `22,24,28 ×4 \| 76,156,255 ×2 \| 41,90,149 ×4` — **one unbroken stroke** |
| hand it an empty stylesheet | `sanity` | exactly the accident the other probe really had this round |
| ask for a panel that does not exist | `setup` | nothing mounted |

Fail-closed and the anti-hang paths were likewise actually run, and **all of them
fail fast rather than hang**:

- run under plain `node` → exit 1, printing that this needs a real browser.
  **This used to be unreachable dead code**: ESM's named
  `import ... from 'electron'` fails during **module instantiation**, before this
  file's first statement, so that friendly message never executed and what
  actually printed was a SyntaxError about CommonJS named exports. After switching
  to `createRequire` the guard sits ahead of the require and really does fire;
  verified still working under Electron 43.
- watchdog squeezed to 400ms → exit 1 within a second, reporting that it is still
  in the "building the probe page" stage;
- a second `.css` in the assets directory → `[setup] expected exactly 1 stylesheet`,
  exit 1;
- swap the build output for an 11 B stub → `[setup] ... under the 10000 B floor`,
  exit 1.
  (The real file was `mv`'d aside first and moved back afterwards, `shasum` checked
  identical: `616020d7…`)
- `--selftest=exitcode` → exit 1; still 1 after passing through `pnpm run`, so if
  the probe goes red, the `pnpm build` on the `&&` chain must go red with it.

Cleaned up along the way: `scripts/probe-paint/` (a 605 B early attempt that
rendered those same three components with `renderToStaticMarkup` — static markup
being precisely the channel this probe **deliberately does not read**, fully
superseded by `fixture.tsx`, 0 references repo-wide); and the comment in
`fixture.tsx` pointing at a `checks.mjs` that does not exist.

### 25.8 Three notes for whoever comes next

- **A check nobody has seen go red is an untested check.** So every defect keeps
  its `--plant=`, and the proof becomes a command anyone can rerun instead of a
  paragraph in a report.
- **"Prove it goes red" is only half a proof.** The counter also has to be proved
  to **go green on the real thing**, otherwise the conclusion "one line" is
  unfalsifiable. That is why the calibration rig runs every time.
- **The exit code is the whole fence.** `pnpm build` reads nothing else. The first
  `finish()` failed open right here, so it has a regression test of its own.

## Section 26 · The probe only asks "is this one of our colours", never "can it be read" (round 9, 2026-08-06)

### 26.1 What this fixes

The probe in §25 has six checks, and `contrast()` is called in **one place**
only — inside the accent check, against a checkbox the UA paints. Which is to
say: the only foreground/background pair the whole probe ever graded is a
checkbox's fill colour. The other five ask about something other than legibility.

The palette check is the one most easily mistaken for coverage: what it asks is
**membership** — "is this colour one the shipped stylesheet can produce".
Append one rule to the end of the build output

    button{color:var(--color-bg-1)!important;background-color:var(--color-bg-1)!important;
           border-color:var(--color-bg-1)!important}

and **every button in the window becomes an invisible solid block**, while both
colours are ones the build output can produce, so the predicate cannot fail
structurally: the probe still prints
`295 painted colour(s) checked against 49 … 0 violation(s)`, then
`all checks passed`, and exits 0.

This is the mistake this round keeps making, one level deeper: **the channel is
right, the question is wrong.**

**The boundary — what this does not do**: no change to `styles.css` (§25 already
said it belongs to another piece of work), no change to
`src/renderer/__tests__/theme-contrast.test.ts` (the finding is written up in
§26.6 below, the fix belongs to its own change), and no pixel-level sampling
(reasons in §26.4).

### 26.2 The plan: a seventh check, `legibility`

One more row on the table in §25.2:

| File | What it now owes |
|---|---|
| `page-checks.js` | `textPairs()` hands back the ink colour of **every element that paints text**, along with the **whole stack of paint** beneath it; `inkRig()` erects the calibration rig. Measures only, never judges. |
| `probe-main.mjs` | Compositing, the floor, the verdict, the ledger. `contrast()` is **imported** from `colours.mjs`, not written a second time. |

"Paints text" is three things, not one, and the last two have no text node:

1. the element's own child text nodes;
2. the **value** inside a form control (painted by the control, not by a child
   element);
3. **placeholder** — its ink colour belongs to a pseudo-element, so no scan that
   walks elements can see it. The third kind turned up a real violation on the
   spot; see §26.6.

The floor is 4.5:1, 3.0:1 for large text. Whether text is large is **computed
from the rendered `font-size` / `font-weight`**, not assumed: WCAG's large-text
tier starts at 24px (or 18.66px bold), and this product's type scale is 11–13px,
so in theory nothing reaches it — and this pass **actually counted**: **0** of 99
pairs fell under the large-text floor. That independently confirms, from the
rendering side, the sentence in `theme-contrast.test.ts` that says there is no
large text, so there is no 3.0 exemption to take.

### 26.3 The background is the hard half

The naive version reads the element's own `background-color`, and that way of
being wrong **errs towards passing**: almost no element in this app declares a
background, so the naive version compares the ink against `rgba(0,0,0,0)` and
gets a large, clean, meaningless number. Which layer the text is actually read
against is only known by **compositing along the ancestor chain**. Three rules:

- only a layer that is **fully opaque and not faded** is the terminus. A
  translucent one, or one sitting inside a faded subtree, gets composited in and
  the walk continues upward. `ALPHA_SITES` exists in this repository precisely
  because translucent surfaces change what is behind the text;
- `opacity` **multiplies down the tree**, and it fades both the ink and the paint
  of its own layer — the two are faded by different amounts, so it cannot be
  ignored. Collect it per node and multiply it into that node's own paint;
- `--color-*` reaches elements through `var()` and `color-mix()`. The cascade is
  **not reimplemented** here: what `getComputedStyle` hands back is already
  resolved. That sentence is **verified, not assumed** — every value goes through
  the same canvas normaliser as the palette check, and a value that did **not**
  resolve will not parse, and is reported as an unreadable ink colour and fails;
  the rig's `stacked` specimen, likewise, can only reach 21:1 by genuinely
  passing through two transparent ancestors.

The three ways the walk can fail to produce an answer — a background image on the
chain, a background value that will not parse, reaching the root with no opaque
layer — **all report failure rather than guessing a number**. An exemption goes
into `PAINTED_BACKDROP` with a line saying why. Today it is empty.

### 26.4 Trade-offs

**Why not sample the framebuffer.** Text over a gradient or an image has no
single background, and the other route is to read pixels the way `border-bands`
does. Not done, because the cost and the error are out of proportion: telling
"is this pixel a stroke or the background" apart on 11px text with subpixel
antialiasing on is itself an estimator with an error of its own, and this probe
already has one pixel-reading check, which erects a calibration rig on every pass
precisely because **counters of that kind are unusually good at being confidently
wrong**. When such text really appears, let it ring and let a person write an
exemption — better than quietly handing back a made-up number.

> **[Round 10 addendum] This still stands, but the scope it covers needs stating: what is not sampled is glyphs on the real page.**
> From §27 on, **the rig's specimens** are judged against pixels — what is
> measured there is not a glyph but a **solid swatch** of the same colour as the
> ink, under the same fade and the same ancestor chain, with no antialiasing
> question at all, so the cost argument for that estimator does not reach it. Not
> one pixel of the real page's text is sampled.

**Why the verdict still lives entirely in Node.** Same reason as §25.3, plus a
new one: the floor, the ledger, and the comparison against
`theme-contrast.test.ts` all need to be on the side that can report a filename
and a number.

**Why `disabled` is exempted by state, not by colour.** WCAG 2.1 SC 1.4.3 says it
itself: text in an interface component that is in an **inactive** state has no
contrast requirement. This app's disabled is a 45% fade, and the five variants
measure between 2.17:1 and 3.40:1. The exemption keys on **the state the page
reports back**, never on a colour pair — a rule that exempts by ratio would
exempt live text at the same ratio along with it, and that is exactly what
`--plant=invisible-buttons` plants. And the hole is not allowed to widen quietly:
`INACTIVE_SHARE_MAX` makes an exempted share above 30% a failure, because a
detector that treats a whole page as disabled looks exactly like a page that
really is all disabled controls. The gallery pane is at 16% today. **Exempted
does not mean unmeasured**: every pass prints those five ratios verbatim.

### 26.5 The calibration rig: proving it goes red is half a proof

> **[Round 10 correction] The expected values for the five specimens below were computed by hand, and the reasoning that computed them is the same reasoning as the compositor they check.** So when the compositor had the `opacity` layer
> order backwards, **not one** of the five went red — because none of the five
> has the one shape that can reveal the layer order: **an opaque surface sitting
> inside a faded group**. This is not a loose rig, it is **a rig that is not
> independent of the thing it calibrates**. §27 replaces the expected values with
> pixels taken by `capturePage` and adds three specimens with faded groups. The
> table below is kept as the record of that round as it stood, and `faded-ink`'s
> 5.28 has since been changed to 5.32 by the pixels (see §27.2).

This section did what the closing sentence of §25.8 said to do. A grader that
always returns 21:1 both keeps a clean pass green and gets caught by a planted
defect; a compositor that **ignores alpha** looks flawless on an interface made
entirely of opaque surfaces and is quietly wrong only where things are
translucent. So every pass first grades five specimens **whose answers were
computed by hand**, through **the same** `backdropStack` and the same compositor
as the real page:

| Specimen | Expected | What it pins |
|---|---|---|
| `opaque` | 21.00:1 | The ceiling, by definition |
| `stacked` | 21.00:1 | Only holds after passing through **two transparent ancestors**; a walk that stops at the first background never reaches this number |
| `alpha-surface` | 3.95:1, **must be judged a violation** | Translucent white over black gives rgb(128,128,128); ignoring alpha computes 21:1. This one also proves, every pass, that the grader can still say no |
| `faded-ink` | 5.28:1 | The `opacity` channel. Ignore it and it computes 21:1 |
| `alpha-ink` | 5.32:1 | The same thing through the `rgba()` channel. It differs from the row above in the third decimal, because half an alpha comes back from the canvas as 128/255 rather than 0.5 |

The layer count is asserted too: a walk that stops early can still land on the
right ratio by accident, and "how many layers were composited" is the direct
question.

### 26.6 It really did find something

**One: the placeholder, 3.86:1, under the floor.** "Leave empty to generate one"
on the label field in the connect dialog, ink `#757575` on `#16181c`. That colour
**is written nowhere**: `grep -c placeholder` in the build output is 0,
`grep -c 757575` is 0, and it appears in neither the source, the build output,
nor the bundle. It is the UA's own placeholder ink — the same channel as the
accent check above, and the **first contrast violation in this repository found
by rendering rather than by reading text**. Neither existing fence reaches it:
the token census has no token to look at; the palette census walks elements, and
the placeholder's ink belongs to a pseudo-element (incidentally: this means the
§25 palette census also misses the pseudo-element route, and contrast is not the
only thing out of its reach).

Recorded in `BELOW_FLOOR_RENDERED` per the repository's convention, with the
ratio pinned and the cost of the fix attached: on the same surface the dim
foreground is 8.11:1 and the faint one is 5.29:1, and either clears the floor
outright; the change is one rule in `styles.css` targeting the placeholder
pseudo-element, and that file belongs to another piece of work. **The floor was
not moved, and nothing was exempted to make the run green.**

**Two: the five disabled variants, 2.17–3.40:1.** WCAG exempts them itself;
handled the way §26.4 describes, with the ratios printed every pass.

### 26.7 Against the source-side check: two agreements, one disagreement

`theme-contrast.test.ts` computes ratios from tokens; this computes them from
what was rendered. Three comparisons that can be checked:

- **Agreement (strong)**: the label on a primary button at rest measures
  **4.89:1** on the rendering side; the comment on `BELOW_FLOOR` on the source
  side carries the same number ("4.89 → 3.92 the moment the pointer touches it").
  The two sides arrive at the same number from opposite directions.
- **Agreement**: 0 of 99 pairs fall under the large-text floor; see §26.2.
- **Disagreement, and the disagreement is itself the finding**: on the disabled
  pair, the source side says **3.32:1** and the rendering side measures
  **3.40:1**.

  > **[Round 10 correction, 2026-08-06] The diagnosis that originally followed had the two readers the wrong way round, and so pointed at the wrong file.**
  > It said the browser composites the ink onto the already-faded surface, and
  > concluded that **the source side should be fixed**. Pixels taken from the
  > framebuffer refute that: the probe is the one that is wrong, and **the source
  > side's 3.32 was right all along**. The original sentence "conclusion: the
  > source side's compositing layer order should be fixed" is **void** —
  > following it would break the correct one of the two readers. The full
  > recomputation, the captured pixels, and the fix on the probe's side are in
  > **§27**. The original passage is kept above rather than deleted because the
  > mistake itself — when two readings disagree, defaulting to suspecting the one
  > that is not the new reader — is worth keeping on record.

  The corrected conclusion: `opacity` fades **the result of compositing the whole
  group** — the ink inside the group lands on the group's own surface first, and
  then **the whole block** lands on the layer beneath the group; the ink never
  meets an already-faded backdrop. So `.45 · fg + .55 · bg-1` is the ink,
  `3.3180` is this model's number, 3.32 after rounding, which agrees with the
  source side and with the framebuffer's `rgb(110,114,119)` / `rgb(31,33,39)` =
  **3.3226** (a difference of 0.005, which is 8-bit quantisation). The probe's old
  `3.4005` faded the backdrop first and then faded the ink a second time onto that
  already-faded backdrop, **erring towards the flattering answer**.

  A knock-on correction: for `.panel.drag-source` (a 75% fade), **7.10 / 4.87 are
  the right pair** (group order), and the 7.19 / 4.95 the original labelled "the
  browser's model" are what the flatten-first model produces. Both clear 4.5
  today, so nothing is overturned; but a site sitting right on 4.5 would be judged
  as clearing it under the wrong model.

### 26.8 One thing judged along the way, and deliberately not done

The previous round's audit pointed out that the probe bundles `fixture.tsx` from
`src/` rather than reading the shipped `out/renderer/assets/*.js`, so the page is
shipped CSS worn over freshly compiled source. For the check added in this
section, the judgement is that **the benefit is out of reach, so not now**, and
the reasons are written down:

- the ink colours and surfaces this check reads **all come from the stylesheet**,
  and the stylesheet already is the shipped one; the component source only
  decides which element hangs where, and `probe:render` runs on the same `&&`
  chain immediately after `electron-vite build`, so the two cannot fall out of
  sync;
- what would genuinely be missed is a **build-time transform rewriting an inline
  `style`**. There is not one such rewrite today;
- and mounting the shipped bundle instead is not a small change: that build
  output's entry point is the whole app, with the preload contract and
  main-process IPC attached, and getting it to mount under `file://` is a
  separate piece of work with its risks elsewhere.

The moment someone really does rewrite inline styles at build time, this
judgement has to be made again.

### 26.9 Verification (all actually run)

    pnpm typecheck                                  # 0
    pnpm test                                       # 1575/1575, 0 failures
    pnpm build                                      # 0 (audit-shipped-css → probe:render, same && chain)
    pnpm --filter @peek/desktop probe:render        # all checks passed

A clean pass is **2.05 / 2.12 / 2.09 seconds wall clock**, re-measured three
times, exiting on its own each time, with the `legibility` lines identical to the
character across all three. Before this check the same machine measured
2.05–2.11 seconds, so this extra walk has **no measurable cost**. There is still
exactly one `.css` under `src/renderer`.

All nine planted defects are PLANT PROVEN (`--plant=<name>`, verdict inverted,
exit 0 only if the named check is the one that goes red), two of them added by
this section (round 10 added a tenth, `x-floor`; see §27.3):

| Plant | Caught by | Evidence |
|---|---|---|
| `invisible-buttons` | `legibility` | `#1b1e23 on #1b1e23 is 1.00:1, under the 4.5:1 floor for 12px/400 text`, 25 of them; the palette check reports 0 violations as before |
| `mute-text` | `legibility` | Strips every text node out of the pane with the layout unchanged (`sanity` still passes), reports "the walk found no text at all", plus only 36 pairs graded across the run, below the floor of 60 |

The three experiments that **blind the grader itself** were also actually run
(each a single-point string edit reverted afterwards, with `shasum` checked
identical before and after: `probe-main.mjs 406c6af2…`,
`page-checks.js ff2fea40…`):

- make the compositor ignore alpha → the `alpha-surface` / `faded-ink` /
  `alpha-ink` specimens all fail together, and because calibration did not pass,
  **the real page is never graded at all**;
- make `textPairs()` hand back an empty array → three fail-closed ledgers ring at
  once: the per-pane floor, the run-wide floor, and "the ledger records pairs this
  pass never rendered";
- make the ancestor walk stop at the first layer of paint → `alpha-surface`
  reports "composited 1 layer(s), expected 2".

### 26.10 Two notes for whoever comes next

- **The channel can be right and the question still wrong.** The palette check
  reads what the browser computed — the channel is fine — it just asks "is this
  colour one of ours" rather than "are these two colours still visible together".
  Before adding the next fence, ask once what predicate it actually decides.
- **A predicate that is never decided is no fence at all.** `contrast()` existed
  in this probe for a whole round and was called exactly once; six checks and a
  respectable report, with a hole nobody measured in the middle.

## Section 27 · The grader's arithmetic, and a rig that sets its own exam (round 10, 2026-08-06)

### 27.1 What this fixes

The `legibility` check from §26 has the right channel and the right predicate,
and **the arithmetic is wrong**. The real lesson of this round is not the
arithmetic itself but **why nobody caught it**:

1. `gradePair` composites the ink onto a backdrop that has **already been
   flattened and already been faded**. CSS does not paint that way: `opacity`
   fades **the result of compositing a group's contents**, not the backdrop
   before the ink goes on top. On the product's own disabled controls the probe
   reads **3.40:1** and the browser paints **3.32:1**.
2. **The rig could not possibly have caught it.** The five specimens' expected
   values were computed by hand, and the reasoning that computed them is the
   reasoning that wrote the bug; worse, **not one** of the five has the only shape
   that reveals the layer order — an opaque surface sitting inside a faded group.
   A rig whose answers come from the model under test is not a rig, it is the
   model nodding at itself.
3. **The document pointed whoever came next at the wrong half.** §26.7 diagnosed
   the layer-order discrepancy and then wrote "the source side's compositing layer
   order should be fixed" — while `theme-contrast.test.ts` on the source side had
   pinned 3.32 from the start, and **it is the correct one**. A record that sends
   someone off to change the correct half is worse than no record.
4. **The hollowness guard does not stop the kind of blinding that hurts.** Its
   floors are absolute numbers: 20 per pane, 60 across the run. Drop **every
   button** on the gallery from the walk's results — 35 pairs, 35% of the run's
   99 — and 28 and 64 remain, both floors cleared, and a real violation planted on
   a button walks straight out.

**The boundary — what this does not do**: no change to `styles.css`; no change to
`theme-contrast.test.ts` (this round's conclusion is that **it needs none**);
still not one pixel of the real page's glyphs is sampled (the argument in §26.4
still stands; for its scope see the addendum below).

### 27.2 Group layer order: the probe is the wrong one, settled with pixels

The order in which a browser paints a group with `opacity` is: the group's own
background and everything inside it are **composited into one buffer first**, and
**then the whole block** lands on the layer beneath the group at that `opacity`.
The ink is inside the group, so it **never meets an already-faded backdrop**.

Take the product's disabled controls (a group at `opacity: .45`, surface
`--color-bg-2`, backdrop `--color-bg-1`, ink `--color-fg`):

| Model | Ink | Surface | Ratio |
|---|---|---|---|
| Group order (correct) | `.45·fg + .55·bg-1` = rgb(109.8, 113.7, 119.2) | `.45·bg-2 + .55·bg-1` = rgb(29.7, 33.2, 38.6) | **3.3180** |
| Flatten first (what the probe had) | `.45·fg + .55·(the already-faded surface)` = rgb(111.3, 115.4, 121.1) | same as above | **3.4005** |
| **Framebuffer** (`capturePage`, captured independently) | rgb(110, 114, 119) | rgb(31, 33, 39) | **3.3226** |

The pixels decide: the correct model is off by 0.005 (8-bit quantisation, one
channel of red on the surface), the wrong model by 0.08, **and it errs towards
the flattering answer**. The 3.32 `theme-contrast.test.ts` has said all along is
right.

The fix is `compositeThrough`, a premultiplied compositor that **walks outward**:
at each layer it does two things, first laying what has accumulated so far over
that layer's own background, then multiplying by the fade this layer's group
carries relative to **the previous layer** (both are cumulative values to the
root, and dividing leaves exactly the `opacity` values between the two nodes).
Feed the same walk the ink and it yields the text colour; feed it nothing and it
yields the surface — **one model, two starting points**, so the ink and the
surface cannot each use their own.

One more thing settled by pixels: compositing is done in floating point, but
**quantised to 8 bits before the verdict**. The framebuffer has no half channels;
white at `opacity: .5` over black composites to 127.5 and **is painted as
rgb(128)**. The old `faded-ink` specimen computed 5.28 by hand and photographs at
5.32, a difference of 0.036 — grading a colour the screen cannot paint in
floating point is grading something nobody can see.

### 27.3 The rig now judges against pixels, and gains the shape it lacked

Expected values are no longer computed by hand. `inkRig()` now paints two
**witness swatches** beside every specimen:

- **the ink witness** — a solid square whose `background-color` is the specimen's
  ink colour, carrying the specimen's own `opacity` and sharing the text's parent
  node. Same paint, same alpha, same ancestor chain, so it goes through the same
  group compositing: its pixel **is** the colour a pixel fully covered by a glyph
  ought to be. Using a swatch rather than a glyph is deliberate — telling "stroke
  or background" apart on 12px text with subpixel antialiasing on is precisely
  the estimator §26.4 refused to build. That the witness really is that paint is
  not asserted inside the page: the swatch's own computed style and fade amount
  are **read back** and handed to Node to check;
- **the surface witness** — an unpainted square at the same position, so its pixel
  is what the innermost layer looks like once composited all the way down.

Node takes one capture (`position: fixed` at the top of the z-order, so the rect
is the viewport rect, which is exactly `capturePage`'s coordinate system) and
compares three things per specimen: the composited ink and surface colours match
the photograph **channel by channel** (tolerance 2, because this file quantises
once while the browser quantises step by step and returns values in the display
colour space, and one channel measures out at a ratio difference of 0.008); the
grader's ratio matches `contrast(photo ink, photo surface)` (tolerance 0.02); and
the photograph matches the number pinned in the table (tolerance 0.05). **The
pinned number is the photograph itself**, and how to re-take it is written in the
comment on `INK_SPECIMENS`: run once and copy down the `framebuffer` half of each
`contrast rig` line.

Three specimens were added, all shapes the old five cannot reach:

| Specimen | By hand | Framebuffer | What it pins |
|---|---|---|---|
| `faded-group` | 7.37 | **7.37** | An opaque surface inside an `opacity: .6` group, black ink. Inside the group the ink lands on the white surface first and the block is faded afterwards, so it is still black; flatten first and the ink is lifted along with the surface |
| `disabled-echo` | 3.3304 | **3.32** | A faithful replica of the product's disabled controls. The very pair this section disputes, pinned here so nobody has to overturn it by argument again |
| `nested-fade` | 2.63 | **2.63** | Two faded groups nested. The only specimen that can tell per-layer relative fade from per-layer cumulative fade — the wrong model is already wrong on the **surface**, before the ink is even reached |

Among the old five, `faded-ink`'s expectation was changed by the pixels from 5.28
to **5.32** (see §27.2); the other four agree between hand computation and pixels.

**This rig does catch that bug, and that was verified**: revert `gradePair`'s ink
path to flatten-first and the `faded-group` / `disabled-echo` / `nested-fade`
specimens fail together across all four panes (12 failures), while **not one of
the old five goes red** — direct evidence that the old rig structurally cannot
catch it, not an inference.

### 27.4 The hollowness guard: it asks about coverage, not count

An absolute floor cannot catch **proportional blinding**, because the quantity
that goes wrong is a share of how much there was to begin with. So a second
reader, `subjects()`, was added: **a separate pass** that counts, by element
category (`button` / `field` / `link` / `prose`, four of them), how many pieces of
text this pane actually paints, which Node then compares against what the walk
handed back. **A category present on the page and absent from the walk is a
failure**, however good the totals look.

The count is deliberately not folded into `textPairs` along the way: a number the
walk counts for itself agrees with the walk by construction — that is this
round's lesson. It is also deliberately **conservative**: it counts only
uncontroversial text (non-empty child text nodes, form values, placeholders on
empty fields), and only what is genuinely on screen. Undercounting hands the walk
a free pass; overcounting becomes a false failure, and a false failure is the one
thing a fence must never manufacture.

The two old floors **stay**, because they answer a different question: when a pane
renders as an empty box, the census and the walk are both zero in perfect
agreement — `--plant=mute-text` is the reason they stay.

The tenth plant, `--plant=x-floor`, turns this into one command: it wraps
`textPairs`, drops every `button` pair on the gallery (35/63, 35/99 across the
run), and at the same time plants a **real violation** on a live button —
`--color-err` over `--color-bg-hover` is **4.48:1**, under 4.5, and both colours
are ones the build output can produce, so the palette check stays green and the
violation is `legibility`'s to catch. **The ratio is not made up**: it is one of
the rows already pinned in `BELOW_FLOOR` on the source side, except that no pane
renders a hover state, so the rendering side cannot see it today.

**The escape was actually run too**: change the coverage predicate at a single
point to always true and `--plant=x-floor` prints
`legibility: 64 text/surface pair(s) graded across the run` → `all checks passed`
→ **PLANT ESCAPED**; revert it (`shasum` identical before and after,
`4d37d4ac…`) and it is PLANT PROVEN,
`gallery: coverage by subject button 0/35, prose 28/28`.

### 27.5 Neither reader contains the other, and that needs writing down

`BELOW_FLOOR` in `theme-contrast.test.ts` has **7 rows** today
(`grep -cE "^  \{"` over that array's range), and the probe's
`BELOW_FLOOR_RENDERED` has **1**. The intersection of the two sets is **empty**:

- the source side's 7 are all token pairs in hover or selected states, and no pane
  renders any of those states, so the rendering side **cannot see them**;
- the rendering side's 1 is the UA's own placeholder ink `#757575`, which `grep`
  finds 0 times in the source, the build output and the bundle, and which has no
  token, so the token census **cannot reach it**.

Which is to say: **neither contains the other.** "Now that there is a probe, the
source-side test can be retired" is the one inference this round can say for
certain is wrong. Both stay, and this round already demonstrated that they
correct each other — on the 3.32 occasion, the source side was right.

### 27.6 Trade-offs

**Why not reproduce Chromium's step-by-step quantisation.** This file quantises
once and the browser quantises step by step, and the residual measures out at one
channel, a ratio difference of 0.008. Closing that gap means overfitting the
grader to one version's compositor, while the rig on every pass already
**measures and pins** the residual (tolerance 2 per channel). A known error with a
bound beats arithmetic copied from a particular version.

**Why every pane really is captured on every pass.** It could have been captured
once and pinned thereafter. Across four panes that measures out at only **0.07
seconds** more (2.06→2.13), and a pinned number quietly rotting is exactly the
disease this section is fixing, so there is nothing to save here.

**Why coverage uses buckets as coarse as categories.** What it has to answer is
which **kind** of thing stopped being looked at. One bucket per component would
leave one or two items in each, and any layout change would turn it red — a fence
that cries wolf daily is one step from being loosened.

### 27.7 Verification (all actually run)

    pnpm typecheck                                        # 0
    pnpm test                                             # 1575/1575, 0 failures
    pnpm build                                            # 0 (audit-shipped-css → probe:render, same && chain)
    pnpm --filter @peek/desktop probe:render              # all checks passed
    pnpm --filter @peek/desktop probe:render -- --plant=x-floor   # PLANT PROVEN

A clean pass is **2.13 / 2.13 / 2.15 seconds wall clock**, re-measured after the
document was updated at **2.18 / 2.19 / 2.20 seconds**, exiting on its own all six
times, with the output **byte-for-byte identical** across all six
(`shasum a284966d…`). Before this round the same machine ran 2.06–2.13 seconds,
so capturing every pane on every pass measures out at **about +0.07 seconds**.
There is still exactly one `.css` under `src/renderer`.

All **ten** plants are PLANT PROVEN (`--plant=<name>`, verdict inverted, exit 0
only if the named check is the one that goes red):
`color-scheme` · `inline-colour` · `motion` · `consent-cover` · `double-border` ·
`invisible-buttons` · `mute-text` · `x-floor` · `empty-stylesheet` · `unknown-pane`.

The two experiments that **blind the fence itself** were also actually run (both
single-point string edits reverted afterwards, with `shasum` checked identical
before and after, `probe-main.mjs 4d37d4ac…`):

- coverage predicate changed to always true → `--plant=x-floor` **PLANT ESCAPED**;
  see §27.4;
- ink path reverted to flatten-first → the three faded-group specimens × four
  panes = 12 failures, and **not one** of the old five specimens goes red;
  see §27.3.

The photographs the rig prints every pass, recorded verbatim (identical to the
character across all four panes):

    opaque 21.00:1 #ffffff/#000000   stacked 21.00:1 #000000/#ffffff
    alpha-surface 3.95:1 #ffffff/#808080   faded-ink 5.32:1 #808080/#000000
    alpha-ink 5.32:1 #808080/#000000   faded-group 7.37:1 #000000/#999999
    disabled-echo 3.32:1 #6e7277/#1f2127   nested-fade 2.63:1 #808080/#404040

The coverage ledger (the two readers aligned category by category, four panes):

    gallery         button 35/35, prose 28/28
    connect-fields  button 5/5, field 5/5, prose 12/12
    consent         button 2/2, prose 5/5

The numbers on the real page changed in one place only, the compositing layer
order, and **no floor was moved and nothing new was exempted**: the five disabled
variants go from 2.17–3.40 to 2.12–3.33 (same controls, same pixels, just computed
correctly), the placeholder row is still 3.86:1 and still pinned in
`BELOW_FLOOR_RENDERED`, and the worst live text is still 4.89:1.

`scripts/` and `docs/` are outside Tailwind's scan surface — **checked by
experiment**, not deduced from configuration. The configuration half:
`@import 'tailwindcss/utilities.css' … source(none)` in `styles.css` turns
automatic detection off, leaving only `@source './'`, and that `./` is relative to
`src/renderer/`. The experiment half: a line reading `pt-11 mb-13` (two valid
Tailwind candidates, and `grep -c` in the build output was 0 for both) was dropped
into a comment in `scripts/render-probe/page-checks.js` and at the end of this
file, and `electron-vite build` was re-run once for each — the build output's
**content hash did not move by a character** (still `index-G91og2OX.css`, 39388 B,
both times) and `grep -c` was still 0. The single-point edits were then reverted,
with `shasum` identical before and after (`page-checks.js 6031c485…`).
`audit-shipped-css` was 0 throughout: all 506 class rules have a wearer.

### 27.8 Three notes for whoever comes next

- **A rig's answers must not share a source with the thing being calibrated.** A
  hand-computed expectation checks whether the code matches what I thought, not
  whether the code matches the browser. Take the answer from **downstream**: here,
  the framebuffer.
- **Proving a fence goes red and goes green is not enough; it also has to have
  seen the shape that goes wrong.** The old five specimens went green on every
  pass and could all be turned red by a plant, but not one of them had the shape
  that goes wrong, so they stayed green for a whole round. Before adding a
  specimen, ask which input lets this predicate tell right from wrong.
- **An absolute floor measures how much is left, not how much went missing.** As
  long as the question is "is it enough", proportional blinding stays compliant
  forever. Change the question to "**is everything that was there still there**",
  and let a second reader count how much was there.

## Section 28 · The probe never enters an interactive state, and most of the known violations live there (round 11, 2026-08-06)

### 28.1 What this fixes

Every pass of the probe in the first ten rounds measured only **the page at rest**.
This round's adversarial audit planted seven defects it cannot catch, three of which
are **the same rule** — paint the button into an invisible solid block — hung off the
pointer, the press, and the keyboard ring respectively. All three walked out.

All three states **really do get drawn**; it is not that "this app has no such
states": the diagnostic plant read back `hoverMatches:false` /
`documentHasFocus:false` / `matchesFocus:false`, and the last of those on the very
panel **whose contract is "the accept button holds initial focus"**. Which is to say,
the probe never even asked whether the window had focus.

Measured on the build-output side: **21 `:hover` selectors, 13 of them painting**;
7 pressed-state; 21 `:focus` plus 17 keyboard rings.

And of the **seven** below-the-floor colour pairs `theme-contrast.test.ts` already
measures on the source side (`awk '/^const BELOW_FLOOR/,/^\]/' … | grep -cE '^  \{'`
→ 7, and §27.5 records 7 as well), **four exist only in the hover state**:

- foreground token over the primary button's hover ground = **3.92:1**. The same
  button, whose own baseline in the probe reads "worst live text 4.89:1" — move the
  pointer and it is 3.92, and it was never scored;
- error colour over the danger button's hover ground = **3.69:1**;
- error colour over the generic hover ground = **4.48:1**. This pair **has already
  been proven scorable**: round 10's `--plant=x-floor` painted it **statically** onto
  a button and the scorer caught 4.48 on the spot. It was simply never rendered as a
  state;
- muted foreground over the generic hover ground = **3.79:1**.

**So the scorer is fine; the coverage is not.** This section does exactly one thing:
walk the states, then score them.

**Boundary — what this round does not do**: it does not touch `styles.css` (since
section 25 that has been another job's file), does not touch `theme-contrast.test.ts`,
still samples not one pixel of a glyph on the real page (§26.4's argument still holds,
the calibration rig still photographs solid swatches only), and does not score the
contrast of the keyboard ring itself (an outline is non-text contrast, WCAG 1.4.11,
a different thing). **The floor is not moved to get green, and no pair is exempted to
get green.**

### 28.2 Where the subjects come from: the build output's own selectors, not a hand-written list

"Which elements can enter a given state" — any hand-written answer to that goes stale
**in the direction of "look at less"**. So the subject set is derived from **the build
stylesheet itself** (`stateRules()`):

1. Walk every rule in the build output and keep only the ones that **paint** — the
   test is applied to the **longhand property names** the browser expands to, not to
   the declaration text. The declaration `outline: 2px solid …` does not contain the
   substring `outline-color` at all, and an earlier text-matching filter therefore
   missed 13 of the 14 keyboard-ring rules;
2. **Delete the state pseudo-class** from the selector; what is left is the subject
   selector. `X:hover` becomes `X`; the descendant shape `.a:hover .b` becomes
   `.a .b`, and the subject is exactly the painted `.b` — hovering `.b` puts `.a` into
   hover too (the browser hands `:hover` to the whole ancestor chain), so **the
   element the hover matches** is what makes that rule apply, and no host/descendant
   bookkeeping is needed;
3. Selectors that no longer parse after the deletion (`:not(:hover)` collapses to
   `:not()`) are **reported**, not skipped.

Two kinds are dropped from the subjects: the ones not on screen (a state painted on a
zero box is invisible to everyone), and **disabled** controls — WCAG 2.1 SC 1.4.3
exempts inactive components itself, and this repository's exemption key has always
been **the state the page reports back**, not the colour pair (§26.4). Forcing hover
onto a disabled control and then scoring it is **manufacturing a violation out of an
exemption**, and in the direction of "the fence looks more useful". This shape stays
as it is.

The number excluded is printed verbatim, because "nothing was looked at because
everything was excluded" has to be a number you can read.

### 28.3 Three states, three drivers, and the reason for each

| State | Driver | Why this one |
|---|---|---|
| Hover | **real pointer** (CDP `Input.dispatchMouseEvent`, moved to the subject's centre) | A real pointer measures **hit testing** along with it: a control covered by something else cannot enter the state, and forcing would paper over that. The measured cost is acceptable: 25 subjects, 206 ms |
| Press | **forced pseudo-class** (CDP `CSS.forcePseudoState`) | A real press has to dispatch mousedown, and mousedown fires the product's own handlers — menus open, dialogs close, selection changes — the page moves underfoot, and the scan then scores a different page and blames it on the state. The pressed state is a pure styling question, and **whether forcing and a real press draw the same picture is photographed twice on every pass by the calibration rig** (see §28.5) |
| Focus | **real Tab key** (with `Emulation.setFocusEmulationEnabled` turned on first) | Rounds three and five already paid for this: **a programmatic `.focus()` does not satisfy `:focus-visible`**. The keyboard ring needs a real keypress, and `documentHasFocus:false` says the window had no focus to begin with — the probe's window is hidden, so turn focus emulation on first, then send the key |

The focus pass covers `:focus` and `:focus-visible` **at the same time**: a real
keyboard stop makes both pseudo-classes true (measured: `:focus-visible` was true at
every stop), and focus arrived at by mouse only paints **one layer less** (the
`:focus-visible` rules do not apply), never a new text/surface pair. So the keyboard
pass is the upper bound, and scoring it is enough.

### 28.4 Score only the pairs that **changed**

Each subject walks its own subtree **once before and once after** entering the state
(the same `pairsOver`, the same reader as the at-rest pass), then compares by site:
only where the composited ink or surface colour changed is that a pair belonging to
this state, and only those go to the scorer. The ones that did not change were already
scored by the at-rest pass, and scoring them again would only report the same
violation twice.

That gives three numbers, printed on every pass: **how many subjects were entered**,
**how many pairs were re-read**, and **how many of those changed**. The keyboard-ring
pass will very likely have a `changed` of 0 today — the ring draws an outline, and it
changes no text/surface pair — so **the hollowness guard asks "how many were
re-read", not "how many changed"**: the state really was entered, the subtree really
was walked, and something came out of the walk; that is what counts as having looked.

### 28.5 The calibration rig: the expected value is still a photograph, and it must prove "what is read is the state's pair"

Three samples, one per state, all built on the probe's own blocks with no handlers of
any kind:

- Each sample declares **two colour pairs**: one at rest, one in state, the two ratios
  far apart, and at least one **below the floor** — so every pass proves "the scorer
  still says no inside a state";
- Beside each sample sit the usual two solid swatches, the **ink witness** and the
  **surface witness** (§27.3's method), photographed once at rest and once after
  entering the state. The test is three-way: the scorer's colour matches the
  photograph **channel by channel**, the scorer's ratio matches the photograph's
  ratio, and the photograph matches the number pinned in the table;
- Plus two that are unique to this section: **the in-state photograph must differ from
  the at-rest one** (the driver really moved something, rather than quietly re-reading
  the at-rest colours), and **the sample must report that it entered the state**
  (`matches()` read-back). A driver that sends the pointer into the void, paired with
  a scorer that quietly re-reads at-rest colours, would agree with itself perfectly on
  a clean pass — and the three plants would still go red, because a plant breaks the
  at-rest colours too;
- **The press cell photographs one more time**: the same block, once under forcing and
  once held down by a real pointer, the two equal channel by channel. This is the
  **evidence** for the "use forcing on the real page" trade-off, not a promise.

The **ring cell** in the calibration rig is the one place where the driver differs
from the real page, and it is written here rather than buried in the code: dispatch
**a real keypress** first, then place focus on the sample **programmatically**, then
**read back** `:focus-visible`. The reason is measured: two of the four panels are
modal dialogs, and their focus traps capture **every** Tab on the window and push
focus back into the dialog (measured: three Tabs after a blur, and all three panels
stop on a control inside the dialog), while a `position: fixed` block has an
`offsetParent` of null, which is exactly the condition that trap uses to decide
"does this count as a stop" — so moving the rig into the dialog does not help either.
The keypress establishes the keyboard modality that `:focus-visible` is **about**, and
whether the browser agrees once focus is placed is **asserted**, not assumed
(measured: both `:focus` and `:focus-visible` are true on this path). **The real
page's ring is still walked with real keypresses only.**

One more piece of cleanup, and this round really was bitten by it: **releasing a
forced pseudo-class does not recompute style**. `matches(':active')` says no on the
spot, while `getComputedStyle` hands back the pressed colours — so the scan that came
straight after took "the pressed page" for the at-rest baseline and reported every one
of the 25 pairs as "repainted by the state". So at the end of the press pass, poke a
custom property on the root to force a full recompute, then **read each subject back
and check that it really returned to how it was**; report an error if it does not. A
driver that quietly leaves the page in some state is worse than a driver that never
entered one — the latter produces nothing, the former produces something that looks
like data.

### 28.6 The hollowness guard

Four of them, all asking "is everything that was there still there" (§27.8's third
note):

1. Per panel, per state: **subjects entered == subjects**. All three panels are full
   today (25/25, 5/5, 2/2), and a subject that cannot be entered means something is
   covering it, which is itself a finding;
2. Per panel, per state: pairs re-read > 0;
3. Across the run: **each** of the three states really was entered on at least one
   panel;
4. The pairs re-read across the run have a floor, for the same reason as §27's two
   floors.

`--plant=x-hover` / `x-active` / `x-focus` are the same rule hung off three states —
paint the button into an invisible solid block, **only in that state**. The at-rest
pass stays all green as before and the palette stays at 0 violations (both colours are
ones the build output can produce), so only this section's scan can catch them.

### 28.7 What was found

See the ledger in §28.9. This section's position goes first: **every pair found is
booked at the ratio measured, with the cost of fixing it written down, and not one of
them is allowed to be settled with an "exemption"**.

### 28.8 Trade-offs

**Why forcing is not used for hover.** Forcing is the fastest and steadiest path, and
the cost is that it **skips hit testing**. `--plant=consent-cover` proved this app can
produce "visible but unclickable" defects; a hover scan driven by forcing would hand
back pretty numbers on a page like that. So the hover cell spends those 206 ms on a
real pointer.

**Why press does the opposite and uses forcing.** See the table in §28.3: a real press
changes the page itself. This trade-off is **not taken for free** — the calibration
rig photographs twice on every pass to prove that the two paths draw the same picture.

**Why only the changed pairs are scored.** See §28.4. The alternative is to score
every pair under the state, and then the same at-rest violation gets reported in two
places, and a duplicated error is the first step towards loosening the fence.

**Why focus does not score the outline.** The keyboard ring is an `outline`, and its
contrast against the surface is WCAG 1.4.11 non-text contrast — the test, the floor
and the subject set are all a different thing from 1.4.3. Mixing it in would make one
fence answer two predicates at once, and all of section 26 is about how that ends.

### 28.9 What was found: two pairs, both booked, the floor untouched

The first pass turned up **two** below-the-floor colour pairs on the real page, both
existing **only in the hover state**, both already written into
`BELOW_FLOOR_RENDERED` per repository custom (with ratio, with site, with cost of
fixing), **the floor untouched and not one pair exempted to get green**:

| Rendered pair | name on the token side | rendered side | source side | sites |
|---|---|---|---|---|
| `#d3d8de` on `#3269ac` | foreground on primary button hover ground | **3.90:1** | 3.92 | 9: the gallery's primary sample and the "Action"/"Inline"/"✕" row, the connect dialog's Connect plus its Fields/URL segments, the consent dialog's accept button (in both languages) |
| `#f0736f` on `#483c42` | error colour on danger button hover ground | **3.69:1** | 3.69 | 5: the gallery's danger sample and that row |

The two readers differ by 0.02 on the first pair because the hover ground is a
`color-mix()`, the browser resolves it to `#3269ac`, a few thousandths of a channel
off pure arithmetic — the same order as the compositor residual measured in §27, and
the same conclusion: **the two readers are talking about the same defect**. And this
button's resting-state label is exactly the "worst live text 4.89:1" the probe has
printed on every pass since §26 — **this is what that number looks like one pointer
position later**.

The other two pairs already pinned on the source side (error colour on generic hover
ground 4.48, muted foreground on generic hover ground 3.79) **did not render this
round**: they live on menu rows and tool-call cards, and the four panels the probe
hangs today draw neither. It is written here because "not found" and "does not exist"
are two different things — see §27.5, neither reader contains the other.

### 28.10 Verification (all of it really run)

    pnpm typecheck                                          # 0
    pnpm test                                               # 1575/1575, 0 fail
    pnpm build                                              # 0 (audit-shipped-css → probe:render, the same && chain)
    pnpm --filter @peek/desktop probe:render                # all checks passed
    pnpm --filter @peek/desktop probe:render -- --plant=x-hover   # PLANT PROVEN

A clean pass is **3.02 / 3.08 / 3.06 seconds wall clock**, with three more
measurements after that at 3.07 / 3.07 / 3.08, all six exiting on their own, and three
of the stdouts **byte-for-byte identical** (`shasum b4fa47f3…`). The same machine was
2.09 seconds before this round, so "really drive every state on every panel" measures
out at **about +0.95 seconds**. There is still exactly one `.css` under
`src/renderer`; the build output's content hash did not change
(`index-G91og2OX.css`, 39388 B).

**Thirteen** plants all come back PLANT PROVEN (`--plant=<name>`, inverted verdict,
exit 0 only if the named one is the one that goes red), three of them added by this
section: `color-scheme` · `inline-colour` · `motion` · `consent-cover` ·
`double-border` · `invisible-buttons` · `mute-text` · `x-floor` · **`x-hover`** ·
**`x-active`** · **`x-focus`** · `empty-stylesheet` · `unknown-pane`;
`--selftest=exitcode` → exit 1. The three new plants report **one** error each, each
in its own state, all at `#1b1e23 on #1b1e23` = 1.00:1 — planted on a button that is
already tagged, so the existing ledger still hits and the error is not mixed with any
other cause.

The photographs the calibration rig prints on every pass (identical word for word
across the four panels):

    hover-swap 21.00→1.39:1 #808080/#999999
    press-dim  21.00→4.54:1 #ffffff/#767676   (forced == real press #ffffff/#767676)
    ring-shift 21.00→3.03:1 #949494/#ffffff

The scan ledger for the four panels:

    gallery         hover 25/25, active 25/25, focus 25/25 · 75 pairs re-read · 50 pairs repainted by the state
    connect-fields  hover 5/5,   active 5/5,   focus 13/13 · 20 pairs re-read · 10 pairs repainted by the state
    consent (one pass per language) hover 2/2, active 2/2, focus 3/3 · 11 pairs re-read · 4 pairs repainted by the state
    117 pairs re-read across the run

Note the `focus` column: **the keyboard ring repaints 0 text/surface pairs**. That is
not a miss, it is exactly what §28.4 predicted — the ring draws an outline. The
hollowness guard therefore asks "how many were re-read" rather than "how many
changed"; both numbers are printed, and anyone can see them.

**The two experiments that blinded the fence itself**, both really run, both
single-point string edits reverted afterwards, with `shasum` checked equal before and
after (`probe-main.mjs c50697ab…`):

- **Blind the hover driver** (the pointer is moved to a parking spot off-canvas) → a
  clean pass gives **10 errors**: two per panel across the four panels ("not one of
  the 25 subjects entered this state" plus "0 entered"), plus the run-wide one
  ("`:hover` was not entered on any panel this round"), plus the ledger one. The
  errors name each one and say whether it is "something is covering it" or "the
  pointer never arrived at all" — when hit testing lands on the subject itself, it is
  the latter;
- **Blind "score only the changed pairs"** (the comparison condition is changed to
  always-true, so no pair is ever judged "repainted by the state") → a clean pass
  gives **1 error**, and it is the ledger one: the two hover violations in
  `BELOW_FLOOR_RENDERED` "did not render at all this pass". This one is worth writing
  down on its own: **the ledger is at the same time the state scan's second reader** —
  a record that can only be hit by the state scan, once it stops being hit, says the
  scan has gone blind. This one also shows that plants alone are not enough: with the
  comparison blinded, `--plant=x-hover` still prints PLANT PROVEN, but what caught it
  was the ledger, not the violation planted on the button.

**Scan surface: checked, not assumed.** Drop one line with two valid Tailwind
candidates into the comments of `scripts/render-probe/page-checks.js`, and one more at
the end of this file (`grep -c` in the build output was 0 for both), then rerun
`electron-vite build` — the build output's **content hash did not move a character**
(`index-G91og2OX.css`, 39388 B, `md5 71b28cff…`), and `grep -c` is still 0. Then the
single-point edits were reverted, and `shasum` on both files matches before and after.
So `scripts/` and `docs/` really are outside the scan surface.

### 28.11 Three notes for whoever comes next

- **A fence that measures only the at-rest state measures the half of this interface
  least likely to go wrong.** The colours in interactive states are **derived** from
  the resting colours (mixing, lightening), and nobody measured the result of the
  derivation — both violations this round came from exactly that.
- **Pick the drivers one at a time, and write the reason down.** A real pointer
  measures hit testing along with it, a forced pseudo-class does not disturb the
  product's handlers, and a real keypress is the only thing `:focus-visible` accepts.
  Picking wrong does not produce an error; it just quietly measures less.
- **Clean up, and prove the cleanup happened.** Releasing a forced pseudo-class does
  **not** recompute style: `matches()` says no on the spot, while computed style is
  still at the moment of the press. The next scan then takes "the pressed page" for
  the at-rest baseline and reports all 25 pairs as "repainted by the state". After the
  fence lets go of a state, read back and confirm the page really returned to how it
  was.

---

## Section 29 · Overturns §2.2: the switched-off default palette is switched back on (2026-08-07)

### 29.1 What this fixes

The user's request is one sentence: **"I just want to use as much of the Tailwind
default as possible, that brings a big simplification"**, and among the options
they explicitly picked **"defaults everywhere: drop the initial reset"**.

That request **directly overturns §2.2**. §2.2 called those three lines "the
fulcrum of this plan":

```css
--color-*: initial;
--text-*: initial;
--font-*: initial;
```

Fulcrum was not rhetoric. The whole audit architecture — the 44 colour
assertions, `audit-shipped-css.mjs`'s "all 76 colour values come from the
38-colour palette", the probe's palette check — rests **entirely** on the
palette being a closed, enumerable set. Drop the reset and Tailwind's **288**
default colours (measured: `grep -cE '^\s*--color-[a-z0-9-]+:' tailwindcss/theme.css`
→ 288) enter the namespace, and the question "is this colour one of ours"
**no longer has an answer**.

This section records what is gained, what is lost, and what replaces it.

### 29.2 Measure first: do Tailwind 4.3.3's default scales line up

**Geometry — they line up, and they are exact hits.** With the default
`--spacing: 0.25rem` (4px) as the base, all seven of the app's geometry tokens
land on whole or half steps:

| app token | value | Tailwind default |
|---|---|---|
| `--spacing-row` | 24px | `h-6` ✅ |
| `--spacing-head` | 26px | `h-6.5` ✅ |
| `--spacing-bar` | 30px | `h-7.5` ✅ |
| `--spacing-gutter` | 54px | `h-13.5` ✅ |
| `--spacing-form-label` | 88px | `w-22` ✅ |
| `--spacing-hit` / `--spacing-control-sm` | 24 / 20px | `h-6` / `h-5` ✅ |

**Font sizes — they do not line up, and the failure mode is silent.** This is
the most important measurement in this section. Tailwind 4.3.3 ships 13 default
font sizes, the smallest being `--text-xs: 0.75rem` = **12px**. The app's floor
is **11px** (§2.2's reason: this app ships zh-CN, and PingFang strokes smear
together at 10px). There is **no default step** at 11px.

Worse, the names collide:

| token | app | Tailwind default | uses | after dropping the reset |
|---|---|---|---|---|
| `text-sm` | 11px | **14px** | 85 | **silent +27%** |
| `text-md` | 12px | does not exist | 10 | class name generates no rule |
| `text-lg` | 13px | **18px** | 7 | **silent +38%** |
| `text-data` | 11.5px | does not exist | 8 | class name generates no rule |
| `text-mark` | 10px | does not exist | 16 | class name generates no rule |

`text-sm` and `text-lg` **do not error** — they are legal Tailwind class names,
they just carry different values. 92 pieces of text quietly grow; another 34
class names silently stop doing anything. `type-scale.test.ts`'s 11px floor
assertion would go red on the former, but **the latter is invisible to it** (a
class name that generates no rule has no font size to measure).

**Colours — they do not line up, and cannot be made to.** The 38 tokens are
hand-tuned, and every one of them has a paired contrast ratio measured in
§25–§28. Nothing in Tailwind's 288 colours is "the grey that pairs with
`#16181c` at 7.1:1". Switching to the defaults = **every measured contrast
ratio is void** and has to be measured again.

### 29.3 Measure again: what `@theme inline` is, and why it is required

One item in the material the user supplied decides the shape of the landing
directly: semantic tokens must be declared with `@theme inline`, because without
`inline` a runtime override does not take effect. **This holds up under
measurement.**

Compiled output (Tailwind 4.3.3 CLI, see `scratchpad/twprobe/`):

```css
/* @theme inline { --color-inl: var(--raw-bg) } compiles to */
.bg-inl   { background-color: var(--raw-bg); }      /* references the raw variable directly */

/* @theme { --color-plain: var(--raw-bg) } compiles to */
:root, :host { --color-plain: var(--raw-bg); }      /* evaluated on :root first */
.bg-plain { background-color: var(--color-plain); } /* what is inherited is the computed value */
```

The mechanism: a custom property's `var()` is substituted **on the element that
declares it**, and the resulting computed value is what descends. So without
`inline`, `--color-plain` is frozen to `#16181c` on `:root`, and a descendant's
`.dark { --raw-bg: #000 }` can never catch it.

**Measured at runtime** (Electron, `getComputedStyle().backgroundColor`):

| | under `:root` | after `.dark` re-points |
|---|---|---|
| `@theme inline` | `rgb(22, 24, 28)` | **`rgb(0, 0, 0)`** ✅ works |
| `@theme` (no inline) | `rgb(22, 24, 28)` | `rgb(22, 24, 28)` ❌ does not work |

This also unties the knot recorded in §20.2 — **"a palette that is not custom
properties cannot be re-pointed at runtime, and that is what a second theme
needs"**. `@theme inline` is that mechanism.

Note: this app's current `@theme` holds **literal values** (`--color-bg: #16181c`),
which is neither inline nor a var forward, so today it has no re-pointing ability
and is unaffected by this. Introducing re-pointing takes two steps: declare the
raw variables on `:root`, and forward them through `@theme inline`.

### 29.4 The plan

Three decisions:

**(1) Drop the three `initial` reset lines.** Executed per the user's choice.
Tailwind's 288 colours, 13 font sizes and default spacing all enter the
namespace.

**(2) Take Tailwind's default values, keep the semantic layer for names, and
connect them with `@theme inline`.**

```css
:root {
  --bg:     var(--color-zinc-900);   /* value from Tailwind's default scale */
  --fg:     var(--color-zinc-100);
  --accent: var(--color-blue-400);
}
@theme inline {
  --color-bg: var(--bg);             /* semantic layer, re-pointable at runtime */
  --color-fg: var(--fg);
}
```

The reason is measured, not preferred: **semantic colour class names have 490
references across `.tsx`/`.ts`** (plus 72 `var(--color-*)` in `styles.css`).
Writing `bg-zinc-900` directly in JSX means touching 490 sites, and adding a
theme later means touching those 490 again; keeping semantic names via
`@theme inline` means touching **0**, only the `@theme` block itself. The
material the user supplied reaches the same conclusion: **"don't pile a `dark:`
prefix onto every element, switch to semantic colour tokens"**.

**(3) Font sizes do not follow the defaults.** This is an **explicit exception**
to "defaults everywhere", for the reason in 29.2: the 11px floor is a zh-CN
product constraint and Tailwind has no such step, while the `text-sm`/`text-lg`
collisions fail silently. Keep the five custom font sizes, but **rename them out
of the collision** (`text-sm` → something like `text-11`), so that "this class
name does not exist" becomes an explicit error rather than a silent value swap.

### 29.5 Trade-offs

Three considered and not chosen:

- **Write the default class names directly in JSX (`bg-zinc-900`).** The most
  "default" option, but it means touching 490 sites and tearing the semantic
  layer out entirely — any future theme change then means sweeping every
  component again. The material the user supplied argues against it.
- **Leave the `initial` reset alone.** Keeps the fulcrum of the audit
  architecture, but does not meet the user's request. Explicitly rejected.
- **Use the defaults for font sizes too (accept 12/14/18).** The only genuinely
  "everywhere" option, at the cost of re-laying-out the whole interface: line
  heights, control heights and the grid all have to move with it, and under
  zh-CN going 11px→14px costs a large slice of information density. This app is
  a data grid tool; density is the point. Rejected.

### 29.6 What is lost, and what replaces it

**Lost: the closed-set guarantee.** `audit-shipped-css.mjs`'s "all 76 colour
values come from the 38-colour palette" and `theme-contrast.test.ts`'s 44
assertions both presuppose an enumerable palette. That premise is gone.

**Replacement: the rendered-pair guarantee.** The probe built in §25–§28
measures **the contrast of every text/background pair as actually rendered** —
a guarantee that **does not depend on the palette being closed**. This is a real
architectural swap, not a net loss: the closed-set guarantee answers "is this
colour one of ours", the rendered-pair guarantee answers "are these two colours
legible stacked on each other", and the latter is the question that was actually
wanted (exactly the lesson of the §26 round).

**But the transition leaves a vacuum, and it has to be written down:**

- The probe is currently wired to **3/51** components. The closed-set guarantee
  covers the whole build output; the rendered-pair guarantee covers only the
  wired part.
- `BELOW_FLOOR` (7 entries, source side) ∩ `BELOW_FLOOR_RENDERED` (3 entries,
  probe) = **∅** (§27's conclusion). The two readers do not contain each other —
  remove the source-side one and the probe **does not** automatically take over
  its 7 entries.

So the correct order for this step is: **raise the probe's component coverage
first, then dismantle the closed-set guarantee**, never the other way round.

### 29.7 Verification

1. `pnpm typecheck` = 0
2. `pnpm test` all green (`type-scale.test.ts` has to be renamed along with the
   tokens; after the rename, "this class name does not exist" should go red
   rather than pass silently)
3. `audit-shipped-css.mjs` and `probe:render` on the `pnpm build` chain both pass
4. **Specific**: in the build output, the rule matched by `grep -c 'text-sm'`
   still carries 11px (if renamed, confirm the old name is 0 in the build output
   and 0 in JSX — only both at 0 counts as a clean rename)
5. **Specific**: rerun the `.dark` re-point measurement (the method behind 29.3's
   table) against the real app, confirming the semantic layer really is
   re-pointable

### 29.8 Check-back result: font sizes take the defaults too (2026-08-07, overturns 29.4(3))

29.4(3) proposed "font sizes do not follow the defaults; keep five steps and
rename them out of the collision". **The user rejected that and chose "font
sizes go fully default too, accept 12/14/18".** This subsection overturns
29.4(3) and records the full cost of that decision — because it is much larger
than 29.4(3)'s, and if it is not written down nobody will later know why the
interface got sparser.

**The new font-size mapping:**

| old token | old value | new class name | new value | uses | change |
|---|---|---|---|---|---|
| `text-sm` | 11px | `text-xs` | 12px | 85 | +9% |
| `text-md` | 12px | `text-sm` | 14px | 10 | +17% |
| `text-lg` | 13px | `text-base` | 16px | 7 | +23% |
| `text-data` | 11.5px | `text-xs` | 12px | 8 | +4% |
| `text-mark` | 10px | `text-xs` | 12px | 16 | +20% |

(The mapping rounds up to the nearest step, checked site by site during
implementation; Tailwind has no 11px or 10px step, so `text-sm` and `text-mark`
can only go up.)

**What has to change along with it — font size is not isolated:**

1. **Line height**. `--leading-row` / `--leading-cell` are derived from
   `--spacing-row` (24px), and a 24px line height is workable with 12px text but
   cramped with 14px. Grid row height will most likely have to rise.
2. **Control heights**. `--spacing-control-sm` (20px) holds 11px text; with 12px
   text only 4px of padding is left.
3. **Grid and column widths**. `--spacing-form-label` (88px) and
   `--spacing-gutter` (54px) are both text widths measured against the old font
   sizes.
4. **`--text-mark` loses its meaning**. §2.2 states it "is for pure geometry —
   the disclosure triangle, the checkmark", and 10px is **deliberately** below
   the text floor because it is not text. Raised to 12px, those marks get
   visibly larger.
5. **`type-scale.test.ts`'s 11px floor assertion is void in full** and has to be
   rewritten to a 12px floor.
6. **No measured contrast ratio is affected** (contrast depends on colour, not
   font size), but **WCAG's "large text" exemption line moves** — 3:1 rather
   than 4.5:1 applies above 18.66px, and no step here crosses that line, so the
   exemption relationships are unchanged.

**Cost, summarised: information density drops.** This is a data grid tool, and
how many rows fit on a screen is the core metric. Font sizes rise 9%–23% across
the board, and rows per screen fall accordingly. The user chose this knowing
that (29.2's collision table and §29.5's "rejected" paragraph both laid it out);
recorded here as a decision trace.

**Gain:** all 5 font-size tokens in `@theme` are deleted, `--text-*: initial`
can go with them, and font sizes really do reach zero customisation.

### 29.9 The CodeMirror theme moves into `EditorView.theme` (2026-08-07)

**What was done.** The 13 unlayered `.cm-editor *` rules at the bottom of
`styles.css`, plus a 14th scattered elsewhere — `.editor-wrap .cm-editor`
(sizing) — all move into `PEEK_THEME` (`EditorView.theme`) in
`components/SqlEditor.tsx`.

**Why this is mechanism, not a workaround.** The material the user supplied
names the layer: Tailwind puts every utility class inside `@layer`, and
unlayered rules **always** beat layered ones, so the two-level selectors
CodeMirror injects at runtime via style-mod (`.ͼ1 .cm-content`) hold down any
utility class we can write. This repo's original countermeasure was hand-written
unlayered CSS — **winning that fight**; `EditorView.theme` goes through
CodeMirror's own injection pipeline, landing in the same unlayered bucket at the
same specificity, so **the fight no longer exists**.

The 14th rule makes the point especially well. Its comment reads "`.cm-editor`
is an element CodeMirror creates, there is nowhere to hang a utility, so it has
to be a descendant selector starting from the wrapper" — `EditorView.theme` is
exactly the hook that was missing.

**Two fence debts cleared along the way.**

1. `audit-shipped-css.mjs`'s `FOREIGN_DOM` carries 12 `cm-*` exemptions, **and
   it has no stale check** (`TAILWIND_INTERNALS` has one, this one did not).
   Once the rules move, those 12 silently become dead entries and the audit
   keeps reporting "12 exempt" — exempting something that no longer exists. A
   symmetric stale assertion was added.
2. The first entry of `cascade-order.test.ts`'s `IMPORTANT_SITES` points at
   CodeMirror's selection `!important`. After the move it went stale (**and that
   assertion caught it on the spot**), but the real problem is not the dead
   entry — it is that the `!important` **moved into tsx and escaped this test's
   field of view**: the test only reads stylesheets. Added
   `RUNTIME_IMPORTANT_SITES` and a matching scan: markers that reach real CSS
   from JavaScript, as `EditorView.theme` does, must be written down too. The
   scan runs `blankComments` first, because the trap recorded in `sourceScan.ts`
   (the Tailwind scanner reads comments) holds only for **class names** — an
   `!important` inside a comment compiles to nothing.
3. `type-scale.test.ts` judged `fontSize: 'var(--text-md)'` to be "an inline
   font size bypassing the scale". The real problem is that **a third font-size
   surface** had appeared: `EditorView.theme` is neither a stylesheet nor a class
   name, and both readers are blind to it. The fix is not an exemption but
   **inclusion** — `declarations()` gained a third reader, so the floor still
   governs it; the "no inline font sizes" rule was narrowed to catch only
   spellings that do not reference a step.

**Measured: one declaration that never took effect.** After the move no fence
was watching the rendered result of this change — the tests only read source
text, `audit-shipped-css` reads the build output CSS (and the theme is no longer
in the build output CSS), and the probe is not wired to `SqlEditor`. So the real
editor was rendered once on its own and all 14 declarations compared item by
item. 13 matched; the 14th, `caret-color`, did not: accent blue expected,
`rgba(0, 0, 0, 0)` measured.

Following it down showed **it was transparent before the move too**:

```
.ͼ4 .cm-content { caret-color: transparent !important; }   ← CodeMirror's drawSelection
.ͼo .cm-content { caret-color: var(--color-accent); }      ← ours
```

`drawSelection`, pulled in by `basicSetup`, hides the native caret so it can
draw its own, using a declaration on the same element at the same specificity
**carrying `!important`**. An unmarked rule cannot reach that property. Adding
the old rule back verbatim at the end of the document and measuring again still
gives a computed value of `rgba(0, 0, 0, 0)` — **this CSS has never painted a
pixel since the day it was written**. Deleted, with the reason written down where
it stood. The caret that actually gets painted is `.cm-cursor`'s
`border-left-color` (CodeMirror draws the caret as an element with a border),
measured as `rgb(77, 156, 255)` when focused, which is correct.

That is the fifth "was dead all along" rule of this round; the first four were
`@keyframes pulse` never taking effect, the divider hover accent never working,
`.panel.focused` being dead, and the consent dialog rendering at 760px.
**Every one of them was findable only by rendering.**

**Result:** class rules in the build output 506 → **494**, 38105 B (was
39388 B); `FOREIGN_DOM` 12 → **0**; tests 1575 → **1581** (net +6 assertions),
all green; both audits on `pnpm build` pass.

### 29.10 The order is settled (the user picked 2), and two plans overturned by measurement (2026-08-07)

§29.6's closing sentence read "**raise the probe's component coverage first,
then dismantle the closed-set guarantee, never the other way round**". Put to the
user, the choice was **2: dismantle it now and accept the vacuum in between**.
This subsection overturns that ordering conclusion in §29.6 and writes down the
exact shape of the vacuum, because it is now a **known, accepted** gap rather
than an oversight.

**The exact shape of the vacuum (not "roughly a bit less coverage"):**

- The closed-set guarantee covers **100% of the colour values in the build
  output**; the rendered-pair guarantee covers **the 3/51 components the probe is
  wired to**.
- `BELOW_FLOOR` (7 entries, source side) ∩ `BELOW_FLOOR_RENDERED` (3 entries,
  probe) = **∅** (§27). The two readers do not contain each other, so once the
  source-side one is removed, **nobody picks up the 7 entries it was catching**.
- Result: from now until the probe's coverage is widened, no fence catches
  "a newly introduced contrast problem living in a component the probe is not
  wired to". That is the **entire** cost of picking 2, and the entirety of what
  it means.

The user's choice was informed: all three options and their respective costs
were laid out in the question. Recorded here as a decision trace.

#### 29.10.1 Measurement overturns §29.4(2): no raw variable layer, and no `@theme inline`

§29.4(2) planned "raw variables on `:root`, semantic names through `@theme inline`",
on the grounds that "the semantic layer has to be re-pointable at runtime".
**That rests on a premise nobody measured, and once measured the premise is wrong.**

Two compiles plus two Electron measurements:

| Form | Is `--color-x` emitted to `:root` | Utility compiles to | Can `.dark` re-point it |
|---|---|---|---|
| `@theme inline { --color-x: var(--raw) }` | **No** | `var(--raw)` | Yes |
| `@theme { --color-x: var(--raw) }` | Yes | `var(--color-x)` | **No** |
| `@theme { --color-x: #16181c }` (literal) | Yes | `var(--color-x)` | **Yes** |

The third row is newly measured and it is the decisive one: in Electron,
`light: rgb(22,24,28)` / `dark: rgb(0,0,0)`.

So `@theme inline` solves a **narrower** problem: it is needed only when a theme
token's value is **itself a layer of `var()` indirection** — in that case the
indirection is substituted at the declaration site (`:root`), only the computed
value inherits downward, and `.dark` cannot reach it. **Write the value as a
literal and there is no such indirection; plain `@theme` is already re-pointable.**

The first row also carries a side effect the user's material never mentions, and
one that is a hard constraint for this repository: **`@theme inline` does not emit
its own variables**. `styles.css` holds 72 `var(--color-*)` references, and
`SqlEditor.tsx`'s `PEEK_THEME` another 13 — going `inline` would make all 85
**fail to resolve**.

**Decision: the 38 semantic colours stay in plain `@theme` as literals, with no raw
layer and no `@theme inline`.** It satisfies three things at once: 490 class names
stay put, 85 `var(--color-*)` references stay put, and when a light theme is added
later `.light { --color-bg: … }` works directly. That is one whole naming layer
fewer than §29.4(2), and in direction it sits closer to the user's "use Tailwind
defaults wherever possible, cut hard".

The material the user supplied is not wrong to insist on `inline`; its scenario —
the value comes from another var — just is not the scenario here.

#### 29.10.2 Correcting §29.8's `text-lg` rung: 16px → 18px

The option the user ticked says, literally, "font sizes all default too,
**accept 12/14/18**". §29.8's mapping table rounded to the nearest rung upward and
mapped `text-lg` (13px) onto `text-base` (16px), yielding 12/14/**16**, which does
not match the label the user actually clicked. **The literal text of the user's
option** wins:

| Old token | Old value | New class | New value | Uses |
|---|---|---|---|---|
| `text-sm` | 11px | `text-xs` | 12px | 84 |
| `text-md` | 12px | `text-sm` | 14px | 12 |
| `text-lg` | 13px | `text-lg` (**name unchanged**) | 18px | 8 |
| `text-data` | 11.5px | `text-xs` | 12px | 8 |
| `text-mark` | 10px | `text-xs` | 12px | 16 |

The three rungs come out exactly 12 / 14 / 18, and the 8 `text-lg` sites **need not
a single character changed** — the same name simply goes from 13px to 18px.

#### 29.10.3 The default sizes carry line heights, the biggest knock-on of this change

Measured from the compile (Tailwind 4.3.3):

```css
.text-xs { font-size: var(--text-xs); line-height: var(--tw-leading, var(--text-xs--line-height)); }
/* --text-xs: 0.75rem;  --text-xs--line-height: calc(1 / 0.75)   → 16px */
/* --text-sm: 0.875rem; --text-sm--line-height: calc(1.25/0.875) → 20px */
/* --text-lg: 1.125rem; --text-lg--line-height: calc(1.75/1.125) → 28px */
```

The old five rungs were **bare `font-size`**, no line height, with line height
inherited all the way down from ancestors. On the default rungs, **every element
that sets a font size gets a line height stuffed in alongside it** — which matters
more than the 9%–23% rise in font size itself, because it changes the height of the
box rather than the size of the glyphs.

Tailwind supplies the mitigation itself: `var(--tw-leading, …)` means **an explicit
`leading-*` on the same element still wins**. Places that already set a line
height — cells in `util/format.ts` (`leading-cell text-data`) and the like — are
unaffected; places that do not will change.

Bare references such as `var(--text-xs)` still work after `--text-*: initial` is
torn out — the compile confirms Tailwind emits any referenced default token to
`:root`.

#### 29.10.4 §29.6 said "the closed-set guarantee is gone entirely" — measuring shows far less was lost

§29.6 wrote "**lost: the closed-set guarantee** … the premise is gone", and from
that concluded "the probes must be widened first". Going through those fences one
by one after the removal, the conclusion needs correcting: **the closed-set
guarantee has two halves, only one was lost, and the other has been there all
along — nobody ever cited it.**

| | Mechanism | Depends on `--color-*: initial` | Status |
|---|---|---|---|
| The assertion in `theme-contrast.test.ts` | Prevention: the namespace is empty | **Yes**, those three lines are exactly what it asserts | Deleted, replaced by a new source-side check |
| `audit-shipped-css.mjs` L807 | Detection: any `--color-*` on the build output's `:root` that `@theme` never declared is an error | **No** | **Untouched, and it worked all along** |
| `render-probe`'s palette allowlist | Derived from **the build output text itself** | **No** | Untouched |

The second row is the key one. `bg-red-500` makes Tailwind emit a
`--color-red-500: oklch(…)` onto the build output's `:root`, and that assertion's
own wording is "a palette variable that appears in the build output and not in
`@theme`" — dead on target. **That fence stood there through the entire migration,
and §29.6 did not go look at it when it wrote "the premise is gone".**

The newly written source-side check (`theme-contrast.test.ts`, "no Tailwind default
colour is named in the renderer") reads Tailwind's own `theme.css` for the 288
default colour names, scans every source file Tailwind scans, and errors on any
`bg-/text-/border-/…` family prefix combined with a default colour name. All 18
colour-taking families are listed, including `caret-`/`divide-`/`placeholder-`,
which this repository has never written, and the three gradient stops — **the ones
never written are exactly the ones that would slip in unannounced**.

**Both fences were measured, not reasoned about**: plant a `bg-red-500` in
`StatusBar.tsx` —

```
pnpm test  → ✖ 1 site(s) name a colour out of Tailwind's default palette:
                 components/StatusBar.tsx:59 → bg-red-500
pnpm build → ✖ 1 palette variable(s) are declared on :root ... : --color-red-500
```

Both go red. The plant was pulled straight after; the build output is restored.

**So what was actually lost?** One thing only: **"impossible" became "will be
caught"**. `bg-red-500` used to compile to zero bytes and could not physically
paint; now it really does paint a colour, it just fails the tests and the build.
For a repository with CI the two are much the same; for a "run it, glance at it,
commit" workflow the difference is real. The vacuum recorded in §29.10 — probes at
3/51, the 7 `BELOW_FLOOR` entries with no owner — still holds and is still the price
paid here — **but it is a vacuum in contrast coverage, not in palette closure**, and
§29.6 merged the two into one.

The third "audit premised on a closed set" — the render probe listed in this round's
task list — **needs no change**: its allowlist is derived from the build output
text, and it asks "can the build output produce this colour the browser painted",
not "is it one of the 38".

#### 29.10.5 A knock-on only the tests find: the control census carries its own font-size list

`ui/__tests__/control-spec.test.ts` holds `TYPE_RUNGS = new Set(['sm','md','lg','data','mark'])`
— a **hand-copied** font-size list, whose purpose is to separate a "font size" like
`text-sm` from a "colour" like `text-fg-dim`. The moment the sizes changed it was
wrong: it had never heard of `text-xs`, so it reported that some control wants a
colour token called `--color-xs`.

It now reads `tailwindcss/theme.css`, and **deliberately reads all 13 rungs rather
than the 3 this product uses**: the question here is only "is this `text-` class a
font size"; "is it a font size this product allows" is `type-scale.test.ts`'s
question. Answering the same question once in each of two places is how two answers
begin to diverge.

This is the second time this round the same shape has come up (the first was
`FOREIGN_DOM` missing its stale check): **a copied-down vocabulary belonging to
someone else goes wrong on the day that vocabulary changes, and that is exactly the
day you most need it right.**

#### 29.10.6 The real cost of the size bump, measured

§29.8's "information density drops" was a **prediction**. After the change, three
things were measured on the real build output; the conclusions are more precise than
the prediction, and not entirely the same as it.

**(1) Not one box burst.** Three probe panels (gallery / connect-fields / consent,
184 elements in all) were compared element by element, `scrollHeight` vs
`clientHeight`, plus whether each rect leaves the viewport: **0 clipped, 0 out of
bounds**. This is the safety question, and the answer is clean.

**(2) Controls did get taller, and only one rung moved.** The same page was measured
twice — once as it stands, then again with the old sizes (11/12/13px plus `body`'s
1.45 line height) forced back with `!important`; the difference is the font-size
term alone:

| Control | Old | New | Change | Size/line height |
|---|---|---|---|---|
| `sm` rung (10 of 35) | 20px | 20px | **0** | 11/15.95 → 12/16 |
| `md` rung (25) | 25.4px | 28.3px | **+2.9px (+11%)** | 12/17.4 → 14/20.3 |
| consent dialog buttons | 25.4px | 29px | **+3.6px (+14%)** | 12/17.4 → 14/21 |

Widths grew about 7px per button alongside; consent's longest bilingual button grew
16.9px.

The `sm` rung did not budge, because `h-control-sm`'s 20px is a hard height and 12px
text on a 16px line height still fits. **The `md` rung has no such hard height** —
it is `min-h` plus padding, so a line height going from 17.4 to 20.3 pushes straight
through. §29.8 did not foresee this one: it listed "control height" as a risk but
placed the bet on `sm`, and it was `md` that moved.

**(3) The grid — this tool's core density surface — did not move at all.** The real
row/cell class names were rendered in isolation and measured:

```
row height 24px, row pitch 24px (--spacing-row)
cell line-height 23px  ← --leading-cell won, not the 16px the Tailwind rung carries
row-number cell line-height 24px  ← --leading-row
clipped 0
```

The mechanism is Tailwind's own: `.text-xs` compiles to
`line-height: var(--tw-leading, var(--text-xs--line-height))`, and `leading-cell`
sets exactly `--tw-leading`, so the explicit line height still wins. The font size
rose from 11.5px to 12px and **the box did not change at all**.

**So the shape of the density loss is this**: how many **data rows** fit on a screen
did not change (0%), but every `md` button is 11% taller, so toolbars, forms and
dialogs — the places buttons live — loosen accordingly. For a data-table tool this
is the best of the three possible outcomes: the cost landed on the chrome, not on
the data.

(Both check scripts in this section were themselves wrong once each: the first
version compared `--leading-cell`'s `calc(24px - 1px)` against a string and judged
"the line height did not take effect"; it had. It now compares against the resolved
number. It is recorded here because "the checker itself was wrong" is now the third
occurrence in this migration, each one caught on the spot.)

### 29.11 Classifying and migrating the remaining 41 class rules (2026-08-07)

Classification ran as a 13-agent workflow: 8 read the rules plus their comments
plus their wearers, group by group, and everything they marked movable went to a
dedicated "rebut it" agent to be overturned one at a time. **One agent stalled
and failed mid-classification** (the 7 form-family rules); those 7 were judged by
hand, recorded below.

Result: 41 rules / 211 lines → **26 rules / 124 lines**, build output 493 →
**485 rules**, 38340 → **37744 B**.

#### 29.11.1 The 15 that moved out

| Rule | Where it went |
|---|---|
| `.mono` | `font-mono tabular-nums`, 46 sites |
| `.sep` | `h-3.25 w-px flex-none bg-border-strong`, 9 sites |
| `.toolbar` / `.toolbar .grow` | the whole toolbar class string, 3 sites + `flex-1` at 3 sites |
| `.empty-hint` | `px-2.5 py-3.5 text-center leading-hint text-fg-faint`, 8 sites |
| `.conn-actions` | `flex flex-wrap gap-1 mt-1.25`, 4 sites |
| `.value-box` | the string that matches `InspectorView`'s word for word, 1 site |
| `.md-h2` | `text-sm leading-relaxed` (14px is a Tailwind step now) |
| `.editor-wrap` | `flex flex-none min-h-15 overflow-hidden border-b border-border`, 2 sites |
| `.settings-pane .seg-group` | `grow-0 shrink-0 basis-auto min-w-50`, 6 call sites |
| four `:focus-visible` rules | `focus-visible:outline-*` variants |
| `.layout-root .panel.focused` + `.panel-head` | two new shadow tokens + `group-data-focused/panel:` |

**Two did not round to the nearest step, because that would be silently
re-typesetting the page:**

- `.empty-hint`'s `line-height: 1.7`. The nearest Tailwind step is
  `leading-relaxed` = 1.625, about 1px per line off across the eight sites. It
  became a new token `--leading-hint: 1.7` — `leading-[1.7]` is banned (§3.4),
  and a named token is the legal way to keep the value.
- `.layout-root .panel.focused`'s two `box-shadow`s. No utility expresses "a 1px
  outline plus a glow", so `--shadow-panel-focused` / `--shadow-head-focused`
  were minted. **`--shadow-gutter-sel` was not reused**: `theme-contrast.test.ts`
  describes that token as the selection rule for the grid's line-number gutter,
  and one token shared by two surfaces means tuning one later moves the other.

#### 29.11.2 The focus ring downgraded from "unlayered (0,3,0)" to "a layered utility" — measured, it is still there

`.layout-root .panel.focused` was **unlayered**, and its own comment said "the
`.layout-root` ancestor is where its value is — it guarantees this rule beats any
class the panel wears". Moved to utilities it lands in `@layer utilities`, where
**any unlayered rule beats it by construction**, and `.panel*` still has 6
unlayered rules.

So this cannot be asserted by reading code; the four states were measured by
rendering real markup against the real build output:

```
rest    box-shadow: none                       border: rgb(51,57,65)
focused box-shadow: rgb(77,156,255) 0 0 0 1px,
                    rgb(77,156,255) 0 2px 14px -6px   border: rgb(77,156,255)
head    box-shadow: rgb(77,156,255) 2px 0 0 0 inset
drag    opacity: 0.75            focused+drag: ring still there + opacity 0.75
```

All eight pass, field for field identical to the old rules. (The first version of
the check script got it wrong again: it counted layers with `split('rgb')` and
counted the 4 `rgba(0,0,0,0)` seeds in Tailwind's shadow chain too, judging a
correct value a failure. That is the fourth "the checker was itself wrong" this
round.)

#### 29.11.3 The sixth rule that was dead all along: `.statusbar .err`

Its comment says, in the present tense, "`ErrorCenter.tsx` puts a
`<span className="err">` here". Round 5's ErrorCenter migration changed that span
to `text-err` — **ErrorCenter's own comment records the replacement** — only
nobody came back to change this rule. No element in the repository wears `err`.
The declaration has been in the build output the whole time and has never painted
a pixel.

**Why the build audit did not catch it is a real gap:** `audit-shipped-css.mjs`
asks "is a class name in this rule worn", and `.statusbar .err` has **two** class
names. `statusbar` is worn (`StatusBar.tsx`), so the selector passed on its
**anchor** while its actual **subject** has no wearer at all. Every remaining
compound descendant selector in the file has the same shape. Written into
`styles.css` in place.

#### 29.11.4 The 7 form-family rules (judged by hand — the group whose agent failed)

| Rule | Verdict | Why |
|---|---|---|
| `.form-row` | movable, not moved | `flex items-center gap-2 mb-2`, but across 7 files it is shared vocabulary; left to a round of its own |
| `.form-row label, .form-row .form-label` | **half blocked** | `.form-row label` reaches the descendant `<label>` by **element**, and that half has no element to hang a class on; splitting the two halves would let them drift |
| `.form-row input, .form-row select` | **blocked** | same, reaches descendants by element |
| `.form-row input[type='checkbox']` | **blocked** | attribute selector + descendant |
| `.form-hint` | **blocked** | `calc(var(--spacing-form-label) + 8px)`. Minting a derived token looks feasible, **but it falls into the trap this repository has already recorded**: a derived token in `@theme` substitutes its `var()` at the declaration site (`:root`), so `.settings-pane` repointing `--spacing-form-label` to 116px cannot reach it — settings' label column would silently fall back to 88px |
| `.form-actions` | **blocked** | same, same `calc()` |
| `.statusbar .err` | **dead** | see 29.11.3, deleted |

#### 29.11.5 The remaining 26, in two classes by why they cannot move

**Structurally immovable (10)**: `body.view-dragging *` and its nodrop variant
(the class hangs on `document.body`, the subject is `*`, and it carries
`!important`), `.panel-tabs::-webkit-scrollbar` (pseudo-element), `.panel-tab`
(the rule declares the custom property `--tab-min-width`), `.md-h1` (15px is not
one of the three steps, and `text-[15px]` is banned), `.grid-row`
(`font-size: 0`, and `text-0` compiles to nothing), `.settings-pane` (declares
`--spacing-form-label`), and the 4 form-family rules that reach descendants by
element.

**Pinned only by tests (12)**: `.panel` / `.panel-head` / `.panel-tabs` /
`.panel-body` / `.panel-drop-overlay` / `.tab-insert-caret` / `.view-drag-ghost`
(`view-drag.test.ts` asserts against the rule bodies one by one), `.grid-scroll`
(`grid-layout.test.ts`, same), `.panel.drag-source` / `.conn-key`
(`theme-contrast.test.ts`'s `ALPHA_SITES` keys on `styles.css:selector`),
`.tab-close` (`control-spec.test.ts`'s `CLASSNAME_LEDGER`), `.dot.connecting`
(`cascade-order.test.ts` requires at least one reduced-motion override pair to
exist in the source, and it is the only pair).

The user has authorised "rules a test pins down may be removed too". **But these
12 pins are not bureaucracy** — they guard drag-and-drop behaviour, the contrast
census, reduced motion: real things. The right move is not to delete the pins but
to **change the assertions from reading the stylesheet's text to reading the
classes on the element / reading computed style**: the guarantee stays and the
rule can move. That beats both "keep the rule" and "delete the pin", but it
changes the semantics of 12 fences, is a round of its own, and is not done in
this section.

`.grid-scroll` also carries a **stale reason the agent overturned on the spot**:
it records its blocker as `contain: layout paint` having no utility. Compiled
against Tailwind 4.3.3 and measured, `contain-layout` + `contain-paint` both
exist and compose, and this repository has `@utility`-ed `overflow-anchor-none`
itself — **the whole rule is expressible today, and the only thing in the way is
that test.**

#### 29.11.6 `--spacing-form-label` 88px → 100px: the one knock-on §29.8 flagged that actually landed

Item 3 on §29.8's knock-on list reads "grids and column widths —
`--spacing-form-label` (88px) is a text width measured at the old font sizes". It
did go wrong, and in **the quietest way**: nothing clipped, the row simply grew a
line taller, the "did a box break" check said nothing, and it was spotted on a
screenshot.

Every real label string was rendered and measured once at each of the two font
sizes (not scaled by the font-size ratio — scaling by ratio is exactly the move
that left it with 0.9px of slack in the first place):

| Label | Old | New |
|---|---|---|
| Database index | **87.1px** (88px column) | 99.5px → wraps to two lines |
| Display name | 75.5px | 86.3px |
| the other seven | ≤ 54px | ≤ 62px |

`Database index` had **a ninth of a pixel** of slack in the 88px column. At 100px
all nine are single-line.

**`.settings-pane`'s 116px override is deliberately left alone.** Its labels are
already longer than the column ("New conversations start in" is 171px at the new
sizes and about 147px at the old, over 116px either way); wrapping there is the
design, not a regression, and widening the column to make them single-line would
be a re-layout this change has no mandate for.

#### 29.11.7 The `md` step gets `leading-none`, taking the +11% back

The only density loss 29.10.6 measured is the `md` control at 25.4px → 28.3px.
The cause is not the font size itself but **Tailwind's steps carrying their own
line height**: `text-sm` brings a 20.3px line height, while the `md` step only
has the `min-h-hit` floor plus padding and lets its height follow the content, so
it got pushed out.

`CONTROL_SIZES.md.classes` gains `leading-none` (`iconClasses` likewise).
Measured:

| | Old scale | New scale (before) | New scale (after) |
|---|---|---|---|
| `md` button | 25.4px | 28.3px | **24px** |
| consent dialog button | 25.4px | 29px | **24px** |
| `sm` button | 20px | 20px | 20px |

The same-page A/B (second pass forced back to the old font sizes) now reads
`24px → 24px (0)`: **tighter than it was before**, and the field
`CONTROL_SIZES.md.px: 24` is true for the first time — it always said 24 while
the render was 25.4. 0 clipped, 0 overflowing, and the consent screenshot
confirms no descender is cut.

**Not fixed along with it**: the 6 `<input>` / `<select>` in the connect dialog
are still 25.4 → 28.3px. They are not `<Button>`; their height comes from the
element floor in `@layer base` rather than the control step, a different surface,
untouched here.

### 29.11.8 Turning the 12 "read the stylesheet's text" pins into "read the element" (2026-08-07)

The previous section judged these 12 "pinned only by tests" and wrote that the
right move is **to change the assertion, not to delete it**. This section
finished the job, plus one finding: one of them, measured, **should not move**,
and the reason is not the pin.

`styles.css`'s plain class rules: **26 → 15, 124 → 63 lines** (this round started
at 41 / 211, **-63%** cumulative). Tests 1598 → **1599**, all green.

#### The new fence shape: both halves asserted together

The old assertion `assert.match(ruleBody(CSS, '.panel'), /position:\s*relative/)`
was **correct**, but it had a side effect nobody chose: **it made the rule
immovable**. Six panel rules stayed in the stylesheet for the whole migration for
one reason only — this file was over there reading them.

The new `paints(source, identity, utility, property, where)` asserts two things,
both required:

1. **The element wears the class** — read from the component source, which is
   where the fact lives now.
2. **The class really produces that declaration** — read from the **build
   output**. A class name is a spelling, and a spelling that compiles to zero
   bytes looks exactly like one that compiles fine.

The second half needs a build. With no build it **skips out loud** (prints a line
saying which one went unchecked) rather than passing silently — a silent skip is
exactly the shape this suite exists to fight. `pnpm build` runs the stylesheet
audit unconditionally, so CI always has build output.

`sourceScan.ts` gains `readShippedCss()` / `utilityBody()` for reuse everywhere.

#### The 11 that moved out

| Rule | Where it went | The test pinning it |
|---|---|---|
| `.panel` | `relative overflow-hidden` into `PANEL_BOX` | view-drag ×2 |
| `.panel-head` | `h-bar` | view-drag |
| `.panel-tabs` | `overflow-x-auto overflow-y-hidden scrollbar-none` | view-drag ×2 |
| `.panel-body` | `relative flex min-h-0 flex-1 flex-col` | view-drag (exact string match) |
| `.panel-drop-overlay` | `pointer-events-none absolute` | view-drag ×2 |
| `.tab-insert-caret` | `pointer-events-none fixed shadow-caret` | view-drag ×2 |
| `.view-drag-ghost` | `pointer-events-none` | view-drag |
| `.panel.drag-source` | `opacity-75` | theme-contrast ALPHA_SITES |
| `.conn-key` | `flex-none text-xs opacity-85` | theme-contrast ALPHA_SITES |
| `.grid-scroll` | the whole string (including `contain-layout contain-paint`) | grid-layout |
| `.tab-close` | `flex-none` | control-spec CLASSNAME_LEDGER |

The two ALPHA_SITES keys change from `styles.css:selector` to
`components/X.tsx:opacity-N` — the census already supports alpha in class-name
form (`components/DropZoneOverlay.tsx:bg-bg/82` has been in the table for a
while), and the exemption sentence is **a field on the entry**, not something the
stylesheet carries, so moving it loses nothing. `.conn-key`'s rule comment said
"moving it pulls the exemption out from under the census" — **that sentence was
wrong**.

#### `.panel-body`'s pin is the most glaring of them

`PANEL_TSX.indexOf('className="panel-body"')` — an exact whole-string match, so
**one more utility on the attribute breaks it**. That is not a fence guarding
behaviour, it is a fence forbidding a migration it has no opinion about. Changed
to locating by name.

#### CLASSNAME_LEDGER: `handle` joins `rule`, and it checks harder

`.tab-close` holds one declaration, `flex: 0 0 auto`, and the comment says
outright that the declaration is there **to satisfy the check below** —
backwards: the rule lives to satisfy the fence, and the fence demands a rule only
because that is the one shape it recognises.

The ledger gains a type: `rule` (a stylesheet definition, layout properties only)
or `handle` (defines no style at all, and exists so something **outside**
`src/renderer` can select it), and a `handle` must name its `selectedBy`. **This
is stricter than before**: the old contract only asked "does the stylesheet
define this name", and nothing anywhere asserted that the CDP script still used
it — retiring the script would leave one ledger entry and one stylesheet rule
pointing at each other. The new one goes and reads the script.

(The new check caught me the first time it ran: I wrote one `../` too many in
`selectedBy`'s relative path.)

#### `.dot.connecting` does not move, and the reason was measured

It is the only one that is "pinned on the surface, but should not move". Its
shape is a **nested** `@media`:

```css
.dot.connecting {
  animation: conn-pulse 1s ease-in-out infinite;
  @media (prefers-reduced-motion: reduce) { animation: none; }
}
```

As utilities it is `animate-conn-pulse motion-reduce:animate-none`. Compiled
against 4.3.3 and measured:

```css
@layer utilities {
  .animate-conn-pulse { animation: var(--animate-conn-pulse); }
  @media (prefers-reduced-motion: reduce) {
    .motion-reduce\:animate-none { animation: none; }
  }
}
```

Two rules **in the same layer at the same specificity (0,1,0)**, and which one
wins **is decided by document order alone**. Today the order is right.

And `cascade-order.test.ts` has an assertion named exactly "a reduced-motion
override never wins by document order alone", whose failure message reads: **"the
requirement is not 'later', it is 'inseparable'"** — because the eight-sheet
merge reordered precisely these two blocks, the connecting dot kept pulsing under
`reduce`, and nobody found out until someone actually measured.

So migrating it would downgrade an accessibility switch from "structurally
inseparable" to "the emission order happens to be right", **exactly the state
that bug came out of**. It does not move. A nested `@media` inside a rule is
something a list of class names cannot express; this is a structural blocker, and
it has nothing to do with the test.

#### Two "problems in the fences themselves" fixed on the way

**1. `cascade-order`'s `total > 40` is a countdown.** It is the sentinel for "did
the parser break", calibrated against the size of the stylesheet on the day it
was written — and the **entire point** of this project is to make that file
smaller. It fired at 37 rules with nothing wrong. A failure like that has only
two answers: lower the number (restart the countdown), or stop asking about size.
It now **asks about agreement**: a second scan that shares no code counts the rule
opening braces independently, and the two readers must land in the same place. A
broken parse disagrees with a working one; a file that merely got smaller does
not. An absolute floor stays, at a very low value, for the "both readers read
zero" case.

**2. `utilityBody` reported a live utility as "produces no CSS".** The regex I
wrote allowed `}` or `,` before `.foo` and missed `{` — and in the minified build
output the **first** rule after `@layer utilities{` is preceded by exactly `{`,
and `.pointer-events-none` happens to be that rule. A false report is the one
mistake a function that asks "did this class name compile" must not make.

**3. The first version of `classesOn` did not mask comments**, so it matched the
prose above the element explaining the class names and reported "`panel-head`
wears: .panel-head". That is the **fifth** time this repository has been bitten
by "the scanner read a comment as code"; the file header of
`__tests__/sourceScan.ts` is what the first four left behind.

## 30. Stepping down, and aligning the control floor (2026-08-07, user feedback: "the interface got uglier")

§29.11.8 signed off reporting "all green, nothing committed". The user looked at
the actual interface and replied:

> It's standardised now, but the interface has got uglier.

"Ugly" is not an input you can turn straight into a code change, so measure
first. Two things came out, **one of them caused by the §29.11.7 fix itself**.

### 30.1 First measurement: everything +17%, the top rung +38%

The old scale was **10 / 11 / 11.5 / 12 / 13** — five rungs packed into 3px of
range, the scale of a dense tool. Now it is Tailwind's **12 / 14 / 18**, the
scale of a web document. The pivot is `body`: it says
`font-size: var(--text-sm)`, and `--text-sm` went from 12px to 14px, so
**everything that does not name a rung explicitly grew 17%**.

Weighted by visible characters on screen (not by rule count — a rule may land
not a single character):

| Panel | 12px | 14px | 18px |
|---|---|---|---|
| gallery | 93% | 7% | — |
| connect-fields | — | **100%** | — |
| consent | 6% | 88% | 6% |

The connect dialog is down to one font size for the whole screen. §29.8 wrote
this up as "information density drops" and accepted it as a known cost, but what
it gave was a **percentage**; a percentage reads as something you can live with,
"the whole dialog has one font size" does not.

### 30.2 Second measurement: control-height spread went from 1.4px to 4.3px

| | Before the migration | Before §29.11.7 | After §29.11.7 (now) |
|---|---|---|---|
| `button` | 24 | 28.3 | **24** |
| `select` | 24 | 26.5 | **26.5** |
| `input` ×6 | 25.4 | 28.3 | **28.3** |
| Spread | 1.4px | **0** | **4.3px** |

`leading-none` only fixed the half that goes through the control rung. The
height of `<input>` / `<select>` comes from the element floor in `@layer base`,
where `button` has `min-height: var(--spacing-hit)` and
`input, select, textarea` **do not** — that asymmetry was always there, it just
did not show when 25.4 against 24 was 1.4px under the old font sizes.

**So §29.11.7 turned a form that was too large but consistent into a form that
is correctly sized but ragged.** It was recorded at the time as "another
surface, leave it for a round", and that judgement was wrong: a right-aligned
label column sitting against inputs 4px taller than the button below them is the
most glaring item in "the interface got uglier".

Buttons got wider too: `I understand — add it` is +16.9px.

### 30.3 Check back with the user: this conflicts with the §29.8 decision, so stop and ask

§29.8 recorded a choice the user made explicitly: "use the defaults for font
sizes too, accept 12/14/18". 30.1 conflicts with it directly, so by rule 2 of
CLAUDE.md, stop and lay both sides in front of the user. Three options were
offered; the user chose **"change the rung, not the value — 100% defaults
throughout"**:

- **Not** "change the three rungs' values back to 11/12/13 in `@theme`" — that
  restores the density exactly, but the values are no longer the defaults;
- **Chosen**: "keep Tailwind's default values, change which rung is used" —
  `body` and the sites that were `--fs-md`(12px) step down from `text-sm` to
  `text-xs`, and the sites that were `--fs-lg`(13px) step down from `text-lg`
  to `text-sm`.

**The cost of this choice was stated to the user before they chose, and
accepted: Tailwind has no rung below 12px, so the sites that were 10px / 11px /
11.5px cannot go back; they stop at 12px, the same size as body text. The
distinction "secondary text is smaller than body text" is permanently gone, and
only colour is left.**

Control heights were asked separately; the user chose **"unify all three on the
24px control rung"** — not back to the pre-migration 1.4px spread, but spread to
zero.

### 30.4 Checked site by site, no wholesale replacement

"step every `text-sm` down to `text-xs`" is the wrong rule, because today's
`text-sm` has two origins: sites that were 12px already, and sites that were a
**14px literal**. The second kind is already on the right rung; stepping it down
goes through the floor. So each one goes back to HEAD for its original value:

| Site | Value at HEAD | Now | After the step down | Diff |
|---|---|---|---|---|
| `body` | `--fs-md` 12 | `text-sm` 14 | `text-xs` 12 | **0** |
| `ui/Menu.tsx` menu box | `--fs-md` 12 | `text-sm` 14 | `text-xs` 12 | **0** |
| `PackagesSection` table | 12 literal | `text-sm` 14 | `text-xs` 12 | **0** |
| `SelectionActionBar` | `--fs-md` 12 | `text-sm` 14 | `text-xs` 12 | **0** |
| `ConsentDialog` shell | 12.5 literal | `text-sm` 14 | `text-xs` 12 | −0.5 |
| Markdown h4/h5/h6 | `--fs-md` 12 | `text-sm` 14 | `text-xs` 12 | **0** |
| `TreeView` type glyphs | `--fs-md` 12 | `text-sm` 14 | `text-xs` 12 | **0** |
| `SqlEditor` theme | `--fs-md` 12 | `--text-sm` 14 | `--text-xs` 12 | **0** |
| **Markdown h2** | **14 literal** | `text-sm` 14 | **unchanged** | 0 |
| `ConsentDialog` title | 14 literal | `text-lg` 18 | `text-sm` 14 | **0** |
| Markdown h3 | `--fs-lg` 13 | `text-lg` 18 | `text-sm` 14 | +1 |
| `ChatView` empty/loading headings ×2 | `--fs-lg` 13 | `text-lg` 18 | `text-sm` 14 | +1 |
| `ErrorBoundary` crash heading | `--fs-lg` 13 | `text-lg` 18 | `text-sm` 14 | +1 |

Eight sites land exactly on their original value, four are +1px (the 13px rung
has no default equivalent), one is −0.5px, one was already right and does not
move. 88 `text-xs` sites stop at 12px (formerly 10 / 11 / 11.5).

**`text-lg` usage goes to zero**, and `SCALE` in `type-scale.test.ts` narrows
from three rungs to two.

### 30.5 Two real distinctions this step-down killed

Unwritten, all anyone will see later is "these two are the same size", not that
they were meant to differ.

**1. `.tree-caret` at 10px against `.tree-icon` at 12px.** The old comment said
it plainly: the disclosure triangle is **geometry**, its two states differ by
90°, so it sits **deliberately** below the text floor; the type glyphs are
⛁ ❏ ▦ ◫ ◪ ⧉ ◇, the reader has to tell them apart — "◫ and ◪ at 10px are a coin
flip" — so they sit **deliberately** above the text floor. After the step down
both are 12px, and that one-below-one-above distinction is gone. The comment has
to be rewritten — leaving it is leaving a lie.

**2. Markdown's h2(14) / h3(13).** After the step down h3 is 14 as well, and the
ladder becomes 15 / 14 / 14 / 12 / 12 / 12. Which incidentally shows this has
been broken throughout the migration: once `--fs-lg` became 18px, **h3 was 4px
larger than h2**, the ladder inverted, and nobody saw it from §29.8 onward —
because no fence checks that heading levels decrease monotonically, and the
probe does not mount Markdown.

### 30.6 The control floor: `input` / `select` get the line `button` has had all along

In `@layer base`, `button` has `min-height: var(--spacing-hit)` and
`input, select, textarea` do not. Add it, and pull the vertical padding from
`3px` down to `2px` — because `min-height` is a **lower bound**, and it does
nothing while the content's natural height of 25.4px is above it; the content
has to drop below 24px first for the floor to catch it.

`textarea` **is not included**: the chat input is a textarea, the height of
multi-line text is decided by its content, and forcing a single-line control's
geometry onto it is wrong. `type=checkbox` / `type=radio` are excluded the same
way — a 13px checkbox should not be stretched to 24px.

### 30.7 Knock-on: `--spacing-form-label` 100px → 88px

§29.11.6 raised this width from 88px to 100px, and the reason was written
plainly — it is "a width measured from the font size", and at 14px the longest
label, `Database index`, needs 99.5px. Re-measured after the step down:
**87.1px**, exactly what it was before the migration. Staying at 100px leaves
13px of empty column that nothing reaches.

Back to 88px, not 92px or some other number with slack in it: 0.9px of slack is
the slack this column has always had, and 100px was only ever the answer for
14px body text. Widening something nobody asked to widen, in a round whose whole
purpose is to undo an enlargement, is another kind of drift.

The 116px override on `.settings-pane` still does not move: its longest label is
180.4px at 12px, it wraps anyway, and that has nothing to do with font size.

### 30.8 "The comment is code" again, this time caught by the fence on the spot

The comment in §30.5 that explains "why h3 cannot use the rung above" named that
rung's **class name** in its first draft. `pnpm test` went red on the spot:
`type-scale.test.ts` reported `Markdown.tsx:72 sets type with` that class.

**The fence is right; this is not a false positive.** The trap recorded at the
head of `sourceScan.ts` — Tailwind's scanner reads comments — **only holds for
class names**: write that class name in a comment and Tailwind really does
compile it into the build output, which makes "this product has only two rungs"
false at the level of the shipped CSS. So the comment now refers to the rung by
size ("the rung above is 18px") rather than by class, and states that reason
inside itself.

This is the sixth time this repository has been bitten by "the scanner reads
comments", and the **first time the fence bit me first** rather than me finding
the fence wrong. The previous five are recorded at the head of
`__tests__/sourceScan.ts`.

### 30.9 Verification

1. `pnpm typecheck` clean; `pnpm test` **1599 passing / 0 failing**; `pnpm build` green on both audits
   (`audit-shipped-css: 485 class rules … all worn; 74 colour values, all from the
   38-colour palette`, `render-probe: all checks passed`).
2. **font-size distribution** (weighted by visible characters): gallery 100% @12px, connect-fields 100% @12px,
   consent 94% @12px + 6% @14px (the title). 14px is worn by titles only, matching the table in §30.4.
3. **Control-height spread is zero**: in connect-fields, `button` 24 / `select` 24 / `input[text]` 24 /
   `input[number]` 24 / `input[password]` 24 / segmented control 24. `input[checkbox]` is 13,
   held unchanged by the exclusion in §30.6.
4. **A/B against the old scale**: connect-fields, **13 controls, 0 size changes** — the whole dialog's
   geometry is pixel for pixel identical to the old scale. In gallery only the 10 `sm` controls change
   font size, 11→12 (height still 20px). A stronger result than §29.11.8: form geometry now **does not
   follow font size**, because the floor catches it.
5. **Grid density unchanged**: row height 24px, step 24px, cell line-height 23px, 0 clipping — it is a px token.
6. **Clipping and overflow**: 0 on all three panels.

## 31. Systematising: measure the "not polished" first (2026-08-07)

The user's feedback after §30 landed:

> I feel the interface has become really ugly now, nothing like as polished as
> before. Can you make your earlier design systematic? I think it's the lack of
> a system that keeps producing designs that are off by 0.5px.

Then an additional authorisation:

> I allow you to extend Tailwind with a set of standards of your own.

Which means the §29.5 constraint, "use Tailwind's defaults wherever possible",
**is lifted here** — a scale of our own may be defined in `@theme`. But utility
classes stay the way Tailwind writes them; no going back to hand-written class
rules.

"Ugly" cannot be turned straight into a code change, so measure first. Four
things came out, **three of them not caused by this migration — they were always
there and nobody had ever measured them.**

### 31.1 The half pixel is real, it is in 7 of 8 bars, and the sign flips

The user said designs are "often off by 0.5px". This is not a feeling; the
mechanism can be named.

Render each bar's real class string (copied character for character out of the
component) against the real build output CSS, and read back the content box and
the offset of the text centre from the container centre:

| Container | Outer box | Border | Content box | Text-centre offset | Source |
|---|---|---|---|---|---|
| titlebar | 30 | 1 | **29** | **−0.5** | `App.tsx:56` |
| panel-head | 30 | 1 | **29** | **−0.5** | `PanelTabs.tsx:136` |
| view-toolbar | 30 | 1 | **29** | **−0.5** | `TreeView.tsx:88` |
| grid-footer | 30 | 1 | **29** | **+0.5** | `DataGrid.tsx:1023` |
| grid-head | 26 | 1 | **25** | **−0.5** | `DataGrid.tsx:690` |
| statusbar | 26 | 1 | **25** | **+0.5** | `StatusBar.tsx:59` |
| attach-bar | 26.4 | 1 | 17.4 | **+0.5** | `AttachmentBar.tsx:94` |
| tree-row | 24 | **0** | **24** | **0** | `TreeView.tsx:207` |

**The mechanism.** `h-bar` is a **border-box** height, the 1px border is drawn
inside those 30px, and the content box becomes 29px — odd. `align-items: center`
centring inside an odd box lands on x.5. A border at the bottom (`border-b`)
offsets by −0.5, one at the top (`border-t`) by +0.5, so where a toolbar and a
footer stack, the text on the two sides differs by a full 1px.

On a 2x display half a CSS pixel is a real device pixel, and the text rasterises
onto a half-pixel boundary — **this is the "blur", and it has nothing to do with
font size.**

The only one that lines up is `tree-row`, and the only reason is that it draws
no border.

**This predates the migration.** `.statusbar { height: 26px; border-top: 1px
solid }` at HEAD is the same structure and the same half pixel. So it was not
broken by this work; this work is only when it **got measured**.

### 31.2 The second half-pixel source: line-height is fractional

`body { line-height: 1.45 }`, 12px × 1.45 = **17.4px**. A 17.4px line box
centred in a 30px box leaves 6.3px above — fractional again.

This is independent of 31.1: even with the border moved out of the height, a
17.4 line box still does not land on an integer. **The spec has to govern both
things at once: the content box is even, and the line box is even too.**

### 31.3 The `--leading-cell` fix does not generalise — measured

The one place in the repository that has dealt with this problem is the grid
cell: `--leading-cell: calc(var(--spacing-row) - 1px)` = 23px, subtracting the
border's 1px back out. Before §30 I took this to be "solved but not
generalised". **Measurement proves it cannot be generalised.**

Five candidates, same page and same build output, reading back the geometry and
confirming from the framebuffer that the border is really painted:

| Option | Outer box | Content box | Text offset | Border actually painted |
|---|---|---|---|---|
| A current `border-b` | 30 | 29 | **−0.5** | ✓ |
| **B `inset` shadow** | 30 | **30** | **0** | ✓ |
| **C `::after` 1px** | 30 | **30** | **0** | ✓ |
| D odd height 31px | 31 | 30 | −0.5 | ✓ |
| E subtract it back out of line-height (the `--leading-cell` trick) | 30 | 29 | **−0.5** | ✓ |

**E fails.** What `align-items: center` centres is the **box**, not the line box,
and changing line-height cannot reach it. That trick is only available to the
grid cell because the cell is block layout. Every bar is flex, so that fix could
never have worked on these containers.

**Correction (same day, measurement overturns this section).** Above it says
"the grid cell is the only place that subtracts this 1px back out". **That
sentence is wrong, and wrong in the place that matters most.**

What `--leading-cell` compensates for is the cell's **own** `border-b`, but the
row-number cell it has to line up with has no `border-b` at all (only
`border-r`). Measuring both columns' text line boxes with `Range` (the element
boxes are both 24px, so measuring element boxes says "aligned"; only the line
box tells the truth):

| | Box height | line-height | border-b | Line-box top | Line-box centre |
|---|---|---|---|---|---|
| Row number `grid-rownum` | 24 | 24px | **0px** | 5 | **12** |
| Data cell `grid-cell` | 24 | 23px | 1px | 4.5 | **11.5** |

**Every row of data sits 0.5px higher than its own row number.** This is the most
visible half pixel in the product — it is in the grid, the thing the user stares
at all day. `--leading-cell` is not "the one place it was solved", it
**created a misalignment**: to centre the cell's text inside its own 23px
content box, it pushed the whole data column half a pixel up relative to the row
numbers.

Option E failing in flex containers still holds (what `align-items: center`
centres is the box, not the line box). Both things are true: the trick cannot
reach the bars, and in the grid, where it does reach, it **aligns to the wrong
thing**.

B and C both pass. B is simpler: no extra element, no `relative`, expressible by
minting a shadow token in `@theme` plus Tailwind's `shadow-*` utilities, and the
repository already has a precedent of the same shape
(`--shadow-head-focused: inset 2px 0 0 …`).

**The cost has to be written down:** the `border-bands` check in `render-probe`
finds its subjects by "the element has a border", and once these containers use
a shadow they vanish from its view. That is a net loss of coverage, so the swap
has to add them to some other check at the same time, or it trades a known
defect for a blind spot.

### 31.4 Spacing is drawn freehand: every integer from 0 to 16px is in use

The distribution of actual px values across every `p/m/gap/w/h/inset` utility in
the renderer:

```
0px×118  1px×3  2px×24  3px×13  4px×43  5px×43  6px×82  7px×20
8px×82   9px×8  10px×45 11px×4  12px×14 13px×29 14px×15 15px×1  16px×3
```

**Every integer pixel between 0 and 16 is in use; odd values total 121 sites.**
That is not a scale, it is freehand. The gap is specific: Tailwind's `--spacing`
is 4px, and the `.25` fraction syntax makes `p-2.25` exactly 9px — 1px
granularity comes free.

Whereas the vertical skeleton (`--spacing-row` 24 / `head` 26 / `bar` 30 /
`control-sm` 20 / `gutter` 54) **all lands on the 2px grid, and not one of them
is a multiple of 4** (26, 30 and 54 are not).

So what exists now is: **a 2px grid for the skeleton, freehand 1px for the
filling, and the two do not meet.**

Run down of what the four high-frequency odd values actually are:

- **13px ×29** — all one thing: `h-3.25 w-px flex-none bg-border-strong`, the
  vertical separator in toolbars, the same four-class string repeated 29 times
  across 8 files. 13px is not a fraction of anything: it sits inside a 30px bar.
- **5px ×43** — mostly `gap-1.25` (control gaps ×18) and `py-1.25`.
- **7px ×20** — mostly `px-1.75` (horizontal padding on `sm` controls) and
  `pr-1.75` on the row-number column.
- **3px ×13** — `py-0.75`, the vertical padding on `md` controls.

### 31.5 Two places with a token that do not use it, and one token whose comment is false

- **`StatusBar.tsx:59` says `h-6.5` (26px), not `h-head`.** 26px is exactly the
  value of `--spacing-head`; the token is right there. Of the 13 bars in the
  whole window, 12 use `h-bar`; only this one writes a bare number.
- **The comment on `--spacing-bar` is false.** It says "there is no fifth
  height: the titlebar, the sidebar head, the panel head and the status bar are
  all `--spacing-bar`", while the status bar is 26px and `--spacing-bar` is 30px.
- **`VectorView` has four fields at `h-5.5` (22px)**, a fifth control height
  between `sm`(20) and `md`(24), written as a bare number, and its own comment
  says "these four share one shape" — exactly the "four rules each restating one
  fact = a missing rung" this repository keeps citing, never closed out.

The heights that actually exist in the window: **13 · 24 · 26 · 29 · 30 · 44**,
of which 13 and 29 are not even on the 2px grid (29 = 30 − 1, the content box
from 31.1).

### 31.6 What the migration really lost: two floors that had been written down

`design/2026-08-02-ui-legibility-baseline.md` §2.1 set floors with a source
behind them:

> **Text floor 11px, symbol floor 10px.** The smallest size in macOS system UI
> is 11px (caption2), and peek ships zh-CN — **PingFang SC's strokes merge at
> 10px**. Anything that is words is at least 11px; purely geometric marks
> (`▸`, `✔`) are not bound by the text floor and use 10px, because their
> legibility is carried by shape and size rather than by font size.

§29.10.2 flattened both floors to 12px (Tailwind has no rung below 12px).
**This is where "nothing like as polished as before" was lost**: the status bar,
the table heads, the row numbers, `tree-detail` and the various hints used to be
11px, one rung quieter than 12px body text; now they are all 12px, and that
primary/secondary layer is gone.

As for the 0.5px the user named: `--fs-data: 11.5px` really is a half pixel, and
it really does **have a source** — "cells hold monospaced literals, and
monospaced glyphs carry a higher stroke density than proportional ones at the
same size, so add 0.5px". The reason holds, but patching optical weight with a
half pixel is expedient, not a system. The integer equivalent is to make data
cells **a whole rung** larger than secondary text (11 → 12) and let the rung
difference do the compensating.

### 31.7 The half pixel at glyph level cannot be removed — the three families' parities do not meet

The workflow produced a content-area table for PingFang SC and argued from it
that "12px is the only font size whose content area is odd, so an 18px line box
gives 11px an integer half-leading and 12px 0.5". That was used as the main
reason for `--leading-ui: 18px`, so it gets checked on its own.

The check caught an error of its own first: the first version used canvas
`measureText` with the family string written as `-apple-system` (no quotes, no
fallback stack), and all three families returned **byte-identical** numbers —
three fonts this different in design cannot agree, so that was a fallback, not a
measurement. Re-measured with full family stacks, verifying that each face
really loaded by the width fingerprint of one string (four width sequences, all
different from each other, all loaded).

**The real numbers (canvas `fontBoundingBoxAscent + Descent`):**

| Family | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|
| SF Pro Text (UI) | 12 | **13** | **15** | 16 | **17** | 18 | 18 |
| SF Mono (data) | **11** | **13** | 14 | **15** | 16 | 18 | **19** |
| PingFang SC (Chinese) | 14 | 16 | **17** | 18 | 20 | **21** | 22 |

(bold = odd)

**The workflow's table is the PingFang row, taken for all three families.** Its
conclusion holds for PingFang and holds for neither SF Pro Text nor SF Mono.

More to the point: **no font size makes all three families even at once.** At
12px they are 15 / 14 / 17 — two odd, one even — and half-leading =
(line box − content area) / 2, so all three being integers requires
line box − 15, line box − 14 and line box − 17 to be even at once; 15 and 14
have different parity, so there is no solution.

**So the half pixel that originates in the glyphs cannot be removed in this
product**, and it is not a matter of having picked the wrong line box. This goes
into the spec, so nobody later overturns the whole thing with "there is still a
0.5px".

Two kinds of half pixel, with different priorities:

- **Half pixels at box edges** (a 1px border squeezed into the border-box, the
  17.4px of `line-height: 1.45`) — visible to the eye: on Retina a 1px line
  straddles two physical pixels and renders as two half-bright grey lines.
  **These must go to zero, and they can.**
- **Half pixels that originate in the glyphs** (content-area parity) — all but
  invisible under greyscale antialiasing, and unsolvable across the three
  families. **These are recorded and not chased.**

`--leading-ui: 18px` is still the choice, but for the two reasons that hold up:
one line box governs both the 11px and 12px rungs at once (baselines agree when
they are mixed), and 18/12 = 1.5 and 18/11 = 1.64 are both inside the band
PingFang needs, whereas today's 16px is 1.333, 8% tighter than the 1.45 the
migration started from — a real regression on the zh-CN side that no document
had ever recorded.

## 32. The spec: peek's geometry and type scale (2026-08-07)

§31 was the diagnosis; this section is the spec itself. The user's authorisation:
"I'm allowing you to extend a new spec of your own on top of Tailwind" — §29.5's
"use Tailwind defaults wherever possible" is lifted as of here. The **form** of
the utilities stays Tailwind (`@theme` definitions, utilities written in JSX);
the **values** are set here.

### 32.0 Three invariants (the token tables are only their expansion)

**1. A box that centres content vertically must have an even content box — so a
1px rule may not take space out of that box.**

`h-bar` is a border-box height, the stroke is drawn inside it, so the content box
is 29; centring inside an odd box lands on x.5. Measured: 7 of 8 horizontal bars
carry a half pixel (§31.1). What gets fixed is **how the line is drawn**, not
those heights: a 4px grid cannot fix it (even minus 1 is always odd — measured,
the 28px and 32px bars blur in all twelve cells), and 26→28 would show one row
fewer at 8.3% of window heights.

**2. The scale governs gaps, not sizes.**

Gaps (`p* m* gap*`) use the six-rung ladder. Sizes (`w h max-* min-*`) do not: a
column width, a hit edge, the minimum bounding box of a glyph are all
**measured**, not derived from nesting depth. Forcing them onto the same ladder
either pushes the 88px label column to 96px, or forces a block that wraps into
`h-row` and clips its content. Sizes are only required to be even.

**3. Every odd number must be written as "some grid value ± the one 1px line it
accounts for", and written out.**

The only odd number left legal in the whole window is `--spacing-control-x: 7px`
(8px optical inset − 1px stroke). Refinement is "the exceptions can be
explained", not "there are no exceptions".

### 32.1 Five type sizes, zero half pixels

| token | px | line box | use | before the migration |
|---|---|---|---|---|
| `--text-mark` | **10** | 12 | Not words: `▸▾`, the check ✔. Condition: a size floor exists elsewhere, and it carries no glyph that has to be read | `--fs-mark` 10 ✓ |
| `--text-micro` | **11** | 18 | **The floor for anything with words**: status bar, table headers, line numbers, tree detail, timestamps, `sm` controls | `--fs-sm` 11 ✓ |
| `--text-body` | **12** | 18 | Default, `body` wears it, including the monospace data cells | `--fs-md` 12 / `--fs-data` 11.5 |
| `--text-title` | **14** | 20 | Dialog titles, md-h2/h3, empty-state titles, crash titles | `--fs-lg` 13 + literal 14 |
| `--text-hero` | **16** | 24 | md-h1 only | literal 15 |

Tailwind's thirteen steps are emptied with `--text-*: initial`. The names say
**use**, not size: `text-xs`/`text-sm` say "small" and "slightly smaller"; three
months later nobody knows which one to reach for.

The optical compensation for the monospace face goes from "+0.5px" to "a whole
step" (chrome 11 / data 12) — that half pixel in `--fs-data: 11.5px` is exactly
the kind the user named.

### 32.2 Four line boxes, all even integer px, not one ratio left

| token | px | who |
|---|---|---|
| `--leading-mark` | 12 | `--text-mark` only (the checkbox is a 12×12 inline-block; an 18px line box drops the check out of it) |
| `--leading-ui` | 18 | chrome: **shared** by `--text-micro` and `--text-body`, so an 11px label and a 12px value sit on the same baseline |
| `--leading-prose` | 20 | things you read: `--text-title`, agent prose, empty-state copy, dialog body |
| `--leading-row` | 24 | grid rows and `--text-hero`. Written as `var(--spacing-row)`, because `vscroll.ts` derives every scroll offset from there |

Ratio line-heights are the single source of 43% of the fractional geometry
(`body{line-height:1.45}` × 12 = 17.390625px). Tailwind's `leading-*` is emptied
along with them via `--leading-*: initial` — without that you get the half-dead
state where "17 sites of `leading-relaxed` compile to nothing and fall back to an
8px line box that clips" (this one was caught during implementation by the
clipping probe).

### 32.3 Six spacing steps, each a doubling

| token | px | criterion |
|---|---|---|
| `--spacing-inset` | 2 | Inside a control's own box. Forbidden between two independently clickable things |
| `--spacing-tight` | 4 | Icon ↔ its own text |
| `--spacing-snug` | **8** | **The default step.** control↔control, label↔field, panel padding |
| `--spacing-loose` | 16 | Group↔group within one panel |
| `--spacing-block` | 24 | Block↔block. **Equal to one row**, deliberately |
| `--spacing-page` | 32 | The outermost layer of a modal, around an empty state |

**There is deliberately no 12px step**: 8→16 has to be a clean doubling. What
makes a dense interface feel refined is "one level of nesting, one doubling of
the gap", not "every number is a multiple of 4" — right now 5/6/7/8/9/10 are
crowded into the same container, so no level can be told apart by eye.

The three computed ones (not picked off the ladder): `--spacing-control-y: 2`,
`--spacing-control-x: 7`, `--spacing-cell: 6`, `--spacing-traffic: 72`.
Each one carries a comment saying how it was computed or measured.

### 32.4 Hairlines: `inset` shadows, no layout cost

`--shadow-rule-b / -t / -r`, plus `-b-strong / -r-strong`, plus two combination
tokens: `--shadow-cell` (right + bottom) and `--shadow-head-focused` (focus
marker + bottom rule).

**The combination tokens are necessary, not laziness**: `shadow-rule-r
shadow-rule-b` are two utilities from the same family, a class string has no
cascade, and which one wins is decided by Tailwind's emission order — cast as
many combinations as there are sets of lines you need.

### 32.5 Radii chosen by the height of the element being rounded

`--radius-mark` 2 (h≤16) · `--radius-control` 4 (17–32) · `--radius-surface` 6
(floating surfaces over 32) · `--radius-dialog` 8 (modals only). Tailwind's eight
steps are emptied with `--radius-*: initial`; `rounded-full` is unaffected (a
static utility, it does not go through this namespace).

### 32.6 The vertical skeleton is untouched, except the gutter

`--spacing-row` 24 · `--spacing-hit` 24 · `--spacing-head` 26 · `--spacing-bar` 30 ·
`--spacing-control-sm` 20 · `--spacing-glyph` 14 · `--spacing-divider` 12 ·
`--spacing-form-label` 88 · **`--spacing-gutter` 54 → 48**.

The gutter is the one net gain in horizontal density this round: once line
numbers drop to 11px, 48 − 7 − 1 = 40px fits 6 digits (SF Mono 11px advance
measured at 6.6226px, 39.74px), the same capacity as 54px @12px, and a seventh
digit fits in neither. Six pixels saved permanently, on every row of every table
view.

Three bare numbers get closed out along the way: the `h-6.5` status bar becomes
`h-head` (the comment on `--spacing-bar` used to say the status bar was 30px,
which was untrue); the 29 dividers at `h-3.25` (13px) become `h-divider` (12px);
VectorView's four `h-5.5` (22px) fields fold into the `sm` step.

### 32.7 Measured results

| | before | after |
|---|---|---|
| Bars with an odd content box or a non-zero text offset | **7/8** | **0/10** |
| Heights that occur in the window | 13·24·26·29·30·44 | 12·24·26·30·42 |
| Heights off the 2px grid | 13, 29 | **none** |
| Panel tab height | 29 (the only odd interactive block) | **30** |
| Button height (including prose context) | 24 / 26 | **24 / 24** |
| Line-box centre difference, grid data vs line numbers | **−0.5px** | +0.25px (pure type-size difference, see below) |
| Class rules in the build output | 485 | **448** |
| Type steps / line boxes | 2 / 8 ratios | **5 / 4 integer px** |

The 0.25px left in the grid is the inherent difference between an 11px line
number and 12px data in the same line box (before the migration it was 11 vs
11.5, which also did not share a baseline). Per §31.7: half pixels at box edges
go to zero, sub-pixels at the glyph level are recorded and not chased — the
content areas of the three font families disagree on parity, and there is no
solution.

`pnpm typecheck` clean · `pnpm test` **1601 passing / 0 failing** ·
`pnpm build` both audits green · 0 clipping · 0 overflow · grid row height and
step are still 24px.

### 32.8 Four things the fences caught during implementation

1. **Comments compiled into live rules again** (the seventh time). Chinese
   comments in `spec.ts` and `App.tsx` spelled out two class names, and the build
   audit reported "2 rules nobody wears". Rewritten to name them by size / by
   meaning.
2. **`TYPE_RUNGS` in `control-spec.test.ts` reads Tailwind's theme.css**, and
   that source had been emptied, so it reported `text-micro` as "the control
   wants a colour called `--color-micro`" — exactly the previous failure its own
   comment records, arriving from a different source. Changed to read the
   product's `styles.css`.
3. **The newly written "every step must carry an even integer line box" caught
   `--leading-row` on the spot**: it is written as `var(--spacing-row)` rather
   than a literal. That is **deliberate** (`vscroll.ts` has to follow it), so the
   rule became "resolves to an even integer px", following one `var()` hop. The
   check was wrong, not the code.
4. **The `md` step measures 26px inside the consent dialog**. It did not declare
   its own line box, so it inherited `leading-prose` (20), 20+4+2=26. **A step
   whose size depends on where it lands is not a step** — the same defect as
   §29.11.7's `px: 24` that said 24 and measured 25.4, arriving through a
   different door. Both steps now declare `leading-ui` themselves.

Beyond that, the instruments themselves went stale twice (`halfpx.mjs` and
`chrome.mjs` had old class strings hardcoded), plus one bug in a counting
command: once `grep -h` strips the filename, `grep -v __tests__` no longer
filters test files out, so an `mt-2` in a test was counted as a leftover in
product code.
