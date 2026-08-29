# The row-number gutter has two widths

> 2026-08-24. Found immediately after
> [`2026-08-24-a-spacing-token-shadowed-a-display-utility.md`](2026-08-24-a-spacing-token-shadowed-a-display-utility.md):
> with the gutter finally rendering at the 48px it declares, a 6px band opened
> between it and the first column. The gutter's width is stated twice — once as a
> CSS token, once as a JavaScript constant — and the two have disagreed since
> 2026-08-04.

## 1. What this fixes

### 1.1 The symptom

The row-number gutter is sized by the token:

| site | class |
| --- | --- |
| `DataGrid.tsx:1093` | the header's top-left spacer — `w-gutter h-head` |
| `DataGrid.tsx:1448` | row number, normal — `w-gutter` |
| `DataGrid.tsx:1456` | row number, selected — `w-gutter` |

`w-gutter` is `width: var(--spacing-gutter)`, and `--spacing-gutter` is **48px**.

Every column, however, is positioned against a JavaScript constant:

```
DataGrid.tsx:78    const GUTTER_W = 54
DataGrid.tsx:354   let totalWidth = GUTTER_W
DataGrid.tsx:659   const x = clientX - rect.left + el.scrollLeft - GUTTER_W
DataGrid.tsx:1103  style={{ left: GUTTER_W + vc.start, width: vc.size }}   // header cell
DataGrid.tsx:1407  style={{ left: GUTTER_W + vc.start, width: vc.size }}   // data cell
```

So the gutter ends at 48px and the first column begins at 54px. The 6px between
them is painted by nothing: in the header it shows the strip's `bg-bg-2` past the
gutter's `shadow-rule-r-strong`, and in the body it shows the row's background
with none of the cell rules that start further right. It is on every row of every
table view, and it is in the three screenshots shot for the README today.

### 1.2 What is *not* wrong

The JavaScript side is internally consistent, so nothing is misaligned:
`totalWidth`, the hit test and the two `left` values all use 54, which is where
the cells genuinely are. A click inside the band gives `x` in `[-6, 0)`, and the
prefix-sum loop at `:662` takes its first branch, so the band resolves to column
0 — the first column's clickable area is 6px wider than its painted area, which
is the only behavioural consequence and not one anybody would report.

This is worth stating because it decides the severity: the defect is a visible
band, not a broken grid.

### 1.3 The cause

`GUTTER_W = 54` has been 54 since `f050a63`, the M0 scaffold. `--spacing-gutter`
became 48px in `6b9e0cd`, the Tailwind v4 migration, on 2026-08-04.

That migration's record
([`2026-08-04-tailwind-migration.md`](2026-08-04-tailwind-migration.md)) treats
`--spacing-gutter` as a CSS token throughout — it appears in the token-vs-default
table and in the list of widths measured against the old type scale. The
JavaScript twin is nowhere in it. The token was re-measured for
`--text-micro` and narrowed; the constant that shares its job was not in scope
and did not move.

### 1.4 Why nobody saw it for twenty days

Because a worse bug was sitting on top of it. Until this morning `.inline-block`
carried a second, colliding rule that forced the gutter to 24px — the subject of
the earlier design record. With the gutter at 24px the band was 30px wide, and
the visible complaint was the clipped row numbers, not the gap. Fixing the
collision restored the gutter to 48px and narrowed the band to 6px, which is
where it becomes small enough to read as intentional spacing.

### 1.5 The guard that exists for the other axis

`grid-layout.test.ts:293` — `the row height is one number in three places` —
already asserts exactly this class of drift, for the vertical twin:

```ts
const spacing = /--spacing-row:\s*([0-9.]+)px/.exec(theme)
const rowH = /export const ROW_H\s*=\s*([0-9.]+)/.exec(src('../vscroll.ts'))
assert.equal(
  Number(spacing![1]),
  Number(rowH![1]),
  '--spacing-row and ROW_H have drifted apart: the DOM and the scroll arithmetic now disagree',
)
```

The pattern the repo has settled on is therefore not "read the token at runtime"
but "state it twice and nail the two together with a test". That test was written
for the row height and never written for the gutter, and the gutter is the one
that drifted. The fix below is the horizontal half of a guard that already
exists.

### 1.6 Boundary

- **Not changing `--spacing-gutter`.** 48px is measured, with the arithmetic
  beside it in `styles.css` (48 − 7 − 1 = 40px of content, six digits of SF Mono
  at `--text-micro` = 39.74px). The earlier record fenced this off for the same
  reason and it still holds.
- **Not reading the token from CSS at runtime.** See §3.
- **Not touching the column model.** Column widths, resizing and virtualization
  are unaffected; only the origin they are laid out from moves.
- **Not re-flowing `DataGrid.tsx:1080`'s comment beyond its number.** It
  describes `totalWidth` when there are no columns, which is `GUTTER_W`, so it
  follows the constant rather than being rewritten.

## 2. The approach

### 2.1 Move the constant onto the token's value

`GUTTER_W` becomes 48, with a comment naming `--spacing-gutter` as the source —
worded the way `ROW_H`'s twin is already documented at `DataGrid.tsx:1441-1443`
("stated twice ... both resolve to `--spacing-row`").

The three comments that reason about the gutter's width follow the number:
`styles.css:992` and `DataGrid.tsx:1453` were corrected to 48px in the same pass
as this document; `DataGrid.tsx:1080`'s "54px stub" was left alone precisely
because it tracks `GUTTER_W`, and it becomes a 48px stub here.

### 2.2 Write the horizontal half of the drift guard

`grid-layout.test.ts` gains a sibling to `the row height is one number in three
places`, asserting that `--spacing-gutter` and `GUTTER_W` agree, and that the
gutter elements take their width from the token rather than from a number.

This is the part that matters beyond today. The value is a one-character edit;
the reason it survived twenty days is that nothing asked.

### 2.3 Files

| file | change |
| --- | --- |
| `apps/desktop/src/renderer/components/DataGrid.tsx` | `GUTTER_W` 54 → 48, with the token named beside it |
| `apps/desktop/src/renderer/components/__tests__/grid-layout.test.ts` | the drift guard for the horizontal twin |
| `docs/images/*.png` | re-shot: every column moves 6px left |
| `README.md`, `README.zh-CN.md` | only if a re-shoot changes a number quoted in alt text |

## 3. Trade-offs

**Change the token to 54px instead.** Cheapest, and it discards a measurement.
48px was derived for `--text-micro`, and the migration banked the difference
explicitly — "6px of horizontal space saved permanently, on every row of every
table view". Widening the token back to 54
would hand that back silently and leave the arithmetic comment in `styles.css`
describing a width nothing uses.

**Read `--spacing-gutter` through `getComputedStyle` at module scope.** Makes the
constant unfalsifiable, and costs more than it looks: the column origin would
depend on a live document, which is the property `vscroll.ts` deliberately does
not have for its own constants ("This module is deliberately pure ... node:test
can assert on 1M / 10M / 100M rows directly"). It would also read layout on a
path that runs while scrolling. The repo already answered this question for the
row height and the answer was a twin plus a test.

**Leave the 6px and document it.** Defensible for a 6px band nobody has
reported — except that it is on the flagship grid, it is in the images this
README is about to be published with, and the fix is one digit plus the test that
should have existed since 2026-08-04.

**Fold this into the earlier record instead of writing a new one.** The two share
a column and a day, but not a cause: that one is a name collision between a token
and a built-in utility, this one is a single quantity with two sources of truth.
That document's §1.5 also fences off the gutter's own width, which is what this
one moves. Two causes, two records.

## 4. Verification

1. **The band is gone.** With a result open, the first header cell's `left` and
   the gutter's `width` must be the same number:

   ```bash
   node apps/desktop/scripts/screenshot.mjs --rows 3000 --theme light
   ```

   `gutterProbe` must still report `width: "48px"`, `honoursToken: true` — the
   earlier fix must not regress — and the shot must show the cell rules starting
   at the gutter's rule rather than 6px past it.

2. **The new guard fails on the old tree.** Set `GUTTER_W` back to 54 and the
   suite must go red naming both numbers. A guard that passes before and after
   the change is not a guard — the same step the earlier record insisted on, for
   the same reason: its first audit rule passed on the broken tree.

   ```bash
   sed -i '' 's/const GUTTER_W = 48/const GUTTER_W = 54/' apps/desktop/src/renderer/components/DataGrid.tsx
   pnpm --filter @peek/desktop test
   ```

   Restore the 48 and it must pass again.

3. **Six digits must still fit.** The token is untouched, so this is a
   regression check on the earlier fix, not a new claim: `digits: 6` with
   `clipped: false` on a million-row result scrolled to the end.

4. **`pnpm -r test` and `pnpm -r typecheck` stay green.** No test referenced 54
   before this change. Afterwards the only `54px` left in shipped source is
   `styles.css:654` and `:658`, which record the token's own 54 → 48 narrowing
   and are correct as history; the rest live in three dated design records
   (2026-08-04, 2026-08-15, and this morning's) and stay as written.

5. **Re-shoot the README images**, and re-read the three alt texts against them.
   Every column moves 6px left, so the images change even though no number in
   them does.
