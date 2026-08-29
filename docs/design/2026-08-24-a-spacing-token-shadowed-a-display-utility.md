# A spacing token shadowed a display utility

> 2026-08-24. Found while reviewing screenshots for the README: the row-number
> gutter renders at 24px against a 48px token, so every row number past 99 is
> clipped. The cause is a `--spacing-*` token whose name collides with a built-in
> Tailwind utility. First design record written in English (`CLAUDE.md`).

## 1. What this fixes

### 1.1 The symptom

`DataGrid`'s row-number gutter is sized `w-gutter`, and `--spacing-gutter` is
48px with the arithmetic written beside it in `styles.css`:

> Slot content width = slot width − right padding − `border-r`. Recomputed after
> the row number dropped from 12px to `--text-micro` (11px): SF Mono at 11px
> measures an advance of 6.6226px, so 48 − 7 − 1 = 40px holds six digits
> (39.74px) — exactly the capacity of 54px at 12px. A seventh digit fits in
> neither.

The running app disagrees. Probed through CDP against a real result set:

| | expected | actual |
| --- | --- | --- |
| `getComputedStyle(el).width` | `48px` | **`24px`** |
| content box | 40px — fits 6 digits | 16px — fits 2 |
| `--spacing-gutter` on the element | 48px | 48px ✅ |
| `w-gutter` in the class list | present | present ✅ |
| shipped rule | `.w-gutter{width:var(--spacing-gutter)}` | identical ✅ |
| any rule overriding `.grid-rownum` | none | none ✅ |

Every input is correct and the output is half. At six digits the gutter reports
`scrollWidth: 47` against `clientWidth: 24`: row 799991 draws as `7999`.

### 1.2 The cause

`CSS.getMatchedStylesForNode` — the engine's own answer, not an inference —
lists two rules contributing a width to that element:

```
.w-gutter     { width: var(--spacing-gutter) }        [regular]
.inline-block { inline-size: var(--spacing-block) }   [regular]   ← wins
```

The second one is not hand-written. Tailwind generates an `inline-<name>`
utility for every token in the `--spacing-*` namespace, and the spacing ladder
has a fifth rung called `block`:

```css
/* Block to block, and the inset of a dialog body. **Equal to one line**, deliberately. */
--spacing-block: 24px;
```

So `inline-block` is minted twice, and both rules ship:

```css
.inline-block{display:inline-block}               /* the built-in display utility */
.inline-block{inline-size:var(--spacing-block)}   /* minted by the token */
```

`inline-size` is `width` under `writing-mode: horizontal-tb`. Same specificity,
later in the file, so it wins — and it wins against *any* width the element also
declares, from any utility, at any point in the codebase.

### 1.3 Why the existing guards missed it

This is the sixth-and-a-half disguise of the bug `audit-shipped-css.mjs` was
written for, and it slips past that script's two rules on a technicality:

- **"No rule ships that no element wears."** `.inline-block` *is* worn — three
  elements in `DataGrid` wear it. The rule is legitimate; it is the *second*
  rule of that name that is not.
- **"No colour ships that `@theme` does not account for."** Not a colour.

The comment at `styles.css:229` is where this becomes uncomfortable. It lists
the seven utilities blocked by `@source not inline(...)`, then says:

> Prefixed relatives are untouched; the blocklist matches whole candidates only.
> `.inline-block`, `.inline-flex`, `.transition-all`, `.resize-none` and the five
> `.shadow-*` tokens all still compile. **Verified by building, not assumed.**

The verification was real and it answered the wrong question. It asked *does
`.inline-block` still exist* — yes — and not *how many `.inline-block` rules
exist*. One is a display utility; two is a silent width override.

### 1.4 Blast radius

Narrow, and unlucky. Three elements wear `inline-block`, all in `DataGrid`, and
**all three are the gutter column**:

| site | element |
| --- | --- |
| `DataGrid.tsx:1093` | the header's top-left spacer (`w-gutter h-head`) |
| `DataGrid.tsx:1448` | row number, normal |
| `DataGrid.tsx:1456` | row number, selected |

Data cells are sized by inline `style`, which outranks a class, so the column
model is untouched. The bug is confined to the one column whose entire job is to
report a number — and it silently reports the wrong one from row 100 onward.

`--spacing-block` is the only token in the ladder that collides, and once it is
renamed no rung does. The family of names that would is wider than the `inline-*`
display utilities first listed here, though: any name Tailwind already uses as a
spacing *value* collides too, and reaches far more utilities — `px`, `full`,
`auto`, `fit`, `min`, `max`, `none`, `screen`, `dvh`, `lvh`, `svh`. Bare `inline`
is not one of them, because `.inline-inline` is not a built-in. Measured in
`2026-08-24-three-claims-nothing-checks.md` §1.1.

### 1.5 Boundary

- **Not changing `--spacing-gutter` itself.** 48px is measured and correct; it
  has never been what was on screen.
- **Not changing the spacing ladder's shape.** Six rungs, first four doubling,
  no 12px rung. Only the fifth rung's *name* moves.
- **Not widening any source scan.** That is the move this class of bug has
  already defeated six times, per the audit script's own header.

## 2. The approach

### 2.1 Rename the rung

`--spacing-block` → `--spacing-stack`, keeping the value and the comment.

"Stack" carries the same meaning — the gap between stacked blocks — and mints
`inline-stack`, `w-stack`, `p-stack`, none of which is a built-in utility.

Migration cost is zero: the token has **no callers**. No `p-block` / `gap-block`
/ `mb-block` utility appears anywhere in `apps/` or `packages/`, and
`var(--spacing-block)` is never referenced. Its only effect at runtime today is
the override this document is about.

Renaming rather than deleting keeps the ladder honest. The comment block opens
with "the spacing ladder — six rungs, the first four doubling" and explicitly warns that the missing 12px
rung is where a future reader will damage it. A ladder documented as six rungs
should have six rungs, even while one is unused — the alternative invites
somebody to reintroduce 24px later under whatever name is free.

### 2.2 A third rule for the artifact audit

The rename fixes today. The guard is what stops `--spacing-flex` from being
added in a year.

`audit-shipped-css.mjs` gains: **no class selector may ship as two rules whose
paint-property sets do not intersect at all**, which is only ever a name
collision between utility families.

That covers the shape found here — `.inline-block{display}` beside
`.inline-block{inline-size}` — and only that shape. A collision whose two
utilities set the *same* property ships as one rule with the property declared
twice, and this rule cannot see it; `--spacing-full` would mint
`.w-full{width:100%;width:var(--spacing-full)}` and pass. That is the common
shape, not the rare one. A second assertion covering it is designed in
`2026-08-24-three-claims-nothing-checks.md` §2.1, which also retires the
assumption written here that within-rule repetition is always a Lightning CSS
fallback pair — the shipped artifact contains no such pair, for `.w-gutter` or
for anything else.

Three details decide whether the check is real or decorative, and each was found
by running it rather than by reasoning about it:

- **`width` and `inline-size` are one property.** The check folds logical
  properties onto their physical equivalents before comparing, or it reads the
  collision as two unrelated properties — which is precisely the blindness that
  let the override stand.
- **`@layer` is transparent.** Only `@media` / `@supports` / `@container` are
  conditional contexts where a selector may legitimately restate itself.
  Tailwind v4 ships every utility inside `@layer utilities{…}`, so treating
  `@layer` as conditional skips the entire stylesheet and yields an assertion
  that cannot fail. The first version of this check did exactly that.
- **A rule that only assigns custom properties paints nothing.** Tailwind splits
  single utilities across rules on purpose — `.bg-linear-to-r` sets
  `--tw-gradient-position` in one rule and reads it from `background-image` in
  another; `.from-accent/10` sets two `--tw-gradient-*` variables and paints
  nothing. Those sets are disjoint by construction and legitimate. Both were
  false positives until the check required *both* rules to declare a
  non-custom property.

This belongs in the artifact audit and nowhere else, for the reason that script
already argues at length: a source-level check can only ask "could this file mint
a class". The collision is invisible in source — `inline-block` is spelled once,
in a className string, and looks exactly like the display utility it is meant to
be. Only the built stylesheet knows it became two rules.

### 2.3 Files

| file | change |
| --- | --- |
| `apps/desktop/src/renderer/styles.css` | rename the rung; note the collision beside it so the name is not "tidied" back |
| `apps/desktop/scripts/audit-shipped-css.mjs` | the third rule |
| `apps/desktop/scripts/screenshot.mjs` | drop the four-digit workaround; the million-row shot can sit where the stream ended |

## 3. Trade-offs

**Delete the rung instead of renaming it.** Cheapest, and wrong for the reason
in §2.1: the ladder is documented as six rungs and a hole invites a 24px rung to
come back under a new name — possibly another colliding one.

**Keep the name, raise the gutter's specificity** (`min-w-gutter`, or a
hand-written `.grid-rownum` rule). Treats the symptom on one column and leaves
the landmine armed for every future `inline-block` element. It also spends the
one thing the migration record is proudest of — that the renderer's geometry
lives in tokens, not in hand-written overrides.

**Add `inline-block` to `@source not inline(...)`.** That blocklist matches whole
candidates, so blocking `inline-block` kills the display utility too, and
`DataGrid` needs it. It would trade a wrong width for a wrong `display`.

**Widen a source scan to detect collisions.** The audit script's header lists six
consecutive fixes of this shape and explains why each failed: a source scan
answers a proxy question. The collision is not visible in source at all.

## 4. Verification

1. **The probe that found it.** `screenshot.mjs` carries `gutterProbe` and
   `matchedWidthRules`; the latter asks the engine which rules set a width on
   `.grid-rownum`. After the fix it must list one rule, not two, and
   `getComputedStyle().width` must read `48px`.

   ```bash
   node apps/desktop/scripts/screenshot.mjs --rows 3000 --theme dark
   ```

2. **Six digits must fit, seven must not.** The token's comment claims exactly
   this. With a million-row result scrolled to the end, the probe must report
   `digits: 6` with `clipped: false`; the seventh digit staying clipped is the
   documented, intended limit and not a regression.

3. **The new audit rule fails on the old tree.** Reintroducing
   `--spacing-block: 24px` must make the audit exit non-zero, naming
   `.inline-block` and the two properties. A guard that passes before and after
   the fix is not a guard.

   This step earned its place. The first implementation passed on the broken
   tree — it treated `@layer` as a conditional context and therefore examined
   nothing — and the only thing that revealed it was putting the bug back and
   watching the guard stay silent. Run it both ways, in this order:

   ```bash
   # with the collision restored, the audit must fail naming .inline-block
   sed -i '' 's/--spacing-stack/--spacing-block/' apps/desktop/src/renderer/styles.css
   pnpm --filter @peek/desktop exec electron-vite build && pnpm --filter @peek/desktop audit:css
   ```

   Observed: `1 class selector(s) ship as two rules that have no property in
   common: .inline-block — rule 1 sets: display / rule 2 sets: width`. Restore
   the name and it passes with 446 class rules, zero exemptions.

4. **`pnpm -r test` and `pnpm -r typecheck`** stay green; no test references the
   old token name (checked: zero occurrences outside `styles.css`).

5. **Re-shoot the README images.** The million-row screenshot then shows a
   six-digit row number in full, and `screenshot.mjs` no longer needs to park the
   viewport in the four-digit range to stay presentable.
