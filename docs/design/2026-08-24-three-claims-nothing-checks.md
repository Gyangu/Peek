# Three claims nothing checks

> 2026-08-24, later the same day. Reviewing the openness pass turned up three
> defects in the code it added, and they share one shape: each *states*
> something — how much a guard covers, what a card's numbers are, what a
> screenshot contains — and nothing in the repository is in a position to
> contradict it.

## 1. What this fixes

### 1.1 The artifact audit's third rule sees four collisions, not the family

`audit-shipped-css.mjs` gained a rule this morning: no class selector may ship
as two rules whose paint-property sets are disjoint. It caught the bug it was
written for, `.inline-block{display}` beside `.inline-block{inline-size}`, and
the design record for that fix
(`2026-08-24-a-spacing-token-shadowed-a-display-utility.md` §2.2) describes it
as covering the collision *family*.

It does not. Two rules under one name is the rare shape. The common one is a
single rule that declares the same property twice:

```css
.inline-block{display:inline-block;inline-size:var(--spacing-block)}  /* caught: two rules */
.w-full{width:100%;width:var(--spacing-full)}                         /* invisible: one rule */
```

Both are the same accident — a `--spacing-*` token whose name is already a
built-in utility's name, so Tailwind mints a second utility under that name and
the later one silently wins. Which shape ships depends only on whether the two
utilities sort adjacently in the emitted sheet, which in turn depends on whether
they came from the same utility root. `width` and `width` do; `display` and
`inline-size` do not. The rule reads `rules.length < 2` and skips the one-rule
shape entirely.

Measured against Tailwind 4.3.3's 23,286 built-in class names, one token per
run, counting the built-ins whose rule gains a second declaration of a property
it already sets:

| token name | built-in utilities it silently rewrites | shape |
| --- | --- | --- |
| `px` | 112 | one rule |
| `full` | 40 | one rule |
| `auto` | 34 | one rule |
| `fit`, `min`, `max` | 13 each | one rule |
| `screen` | 11 | one rule |
| `dvh`, `lvh`, `svh` | 10 each | one rule |
| `none` | 5 | one rule |
| `block`, `flex`, `grid`, `table` | 1 each | two rules — **the only shape caught** |

271 against 4. And the uncovered family is the one this renderer is exposed to:
`w-full` / `h-full` / `size-full` / `m-auto` / `max-w-none` / `inset-0` are worn
about forty times under `apps/desktop/src/renderer`, against three wearers of
`inline-block`. A `--spacing-full: 24px` would pin every one of them to 24px and
`pnpm build` would stay green.

Two smaller errors ride along, in three places that all copy one list. The
assertion message, the ladder's comment in `styles.css` and §1.4 of this
morning's design record all name `inline` as a dangerous token name and stop at
`flex` / `grid` / `table`. `inline` is not dangerous — `--spacing-inline` mints
`.inline-inline`, which is not a built-in, and it rewrites nothing (measured: 0).
Every name that *is* dangerous is missing from all three lists.

### 1.2 The `ask` card's numbers contradict the pane beside them

`shotAgentAsks` hardcodes its two options as "1,461 buckets" and "209 buckets",
and asks "events covers four years — roll it up by day or by week?". The fixture
says otherwise. `day(i / 24)` advances 2.5 minutes per row, so a million rows
span 2025-01-01 → 2029-10-03: 4.75 years, 1,737 day buckets, 252 week buckets.
1,461 and 209 are what four years *would* have given (365 × 4 + 1, then ÷ 7).

This is not a discrepancy a reader has to go looking for. In
`docs/images/agent-asks-*.png` the "Weekly rollup" grid immediately left of the
card runs `GROUP BY strftime('%Y-W%W', occurred_at)` and its status bar reads
`252 rows`, with `2029-W40` on top. The card beside it offers "By week — 209
buckets". Both READMEs then copy "events covers four years" into the image's alt
text. The script's own header says these pictures "are literally the thing the
README claims"; this is the one place they are not.

### 1.3 `screenshot.mjs` discards every probe's failure signal

Four helpers in that script report failure by return value. Three of the four
call sites throw the value away:

| probe | reports failure as | call site |
| --- | --- | --- |
| `waitForRows` | `0` after a 60 s timeout | ignored twice |
| `wheelDown` | `'no .grid-wrap'` | ignored |
| `resetHorizontal` | `'no .grid-scroll'` | ignored |
| `waitForQuestion` | `false` | **checked** — `if (!asked) throw` |

The drain loop has the same property from the other direction: it falls out of
its `while` when the 180 s deadline passes with the workspace still saying
`running`, prints what it saw, and carries on to the shutter. That exact outcome
is recorded in the comment above it — the first full run captured "261000 rows ·
running" under a picture captioned one million — so this is not a hypothetical.
And the line that prints `workspace says: … — fixture has N rows` puts the two
numbers side by side for a human, then compares nothing.

Argument handling fails open the same way. `--only overvew` matches no shot and
the run exits 0 having produced nothing. `--rows abc` gives `Number('abc')` →
`NaN`, an events table with 0 rows, and a fixture cached as `demo-v2-NaN.sqlite`
that every later run then reuses. `--theme foo` is rejected by the app's settings
schema, so the default theme is captured and written to `overview-foo.png` while
`overview-dark.png` goes stale.

Every one of these has a loud counterpart in the same directory:
`verify-auto-refresh.mjs` throws `'grid never rendered a row'` and
`'no .grid-wrap'` verbatim, and `bench-scroll.mjs`, `bench-startup.mjs` and
`verify-auto-refresh.mjs` all guard numeric arguments with
`if (!Number.isInteger(value) || value < 1) throw`. This script is the outlier.

### 1.4 Boundary

- **Only the day's own new code.** The openness review raised 22 items; the
  other 19 (licensing of the packaged `.app`, third-party notices, README
  accuracy, the two READMEs drifting apart) are untouched here.
- **Not re-shooting `overview` or `million-rows`.** Only the `agent-asks` card
  changes, so only those two PNGs are retaken.
- **The million-row alt text is right as it stands.** The same review reported it
  as transposing the elapsed time — alt `41.08 s` against an image reading
  `40.81 s`. Cropped out of the committed PNGs at 3× and read directly, the light
  image says `41.08 s` and the dark one `41.04 s`: the alt text matches the image
  it hangs on, and was left alone. The thing the report was reaching for is real
  and structural, and outside this change — a per-run wall-clock time written into
  alt text can only ever match one of the two images in a `<picture>`, and goes
  stale the next time anyone re-shoots.
- **Not changing the fixture's shape.** 2.5 minutes per row and a million rows
  stay as they are; §3 says why.
- **Not touching the audit's summary line or the `PHYSICAL` map's comment.**
  Both are separately wrong, both are on the review's minor list, and neither is
  load-bearing for the assertion added here.

## 2. The approach

### 2.1 A second assertion: within one rule, one value per property

`audit-shipped-css.mjs` gains a second, cheaper check beside the existing one:

> **No single-class rule may declare the same physical property twice with two
> different values.**

Same input, same grouping, same `physical()` fold as the first check — it just
looks inside a rule instead of between two. `.w-full{width:100%;width:var(…)}`
fires; `.inline-block{display;inline-size}` stays with the first check, which
already catches it.

The reason it can be this blunt: today's artifact has **0** repeated properties
across its 369 single-class rules (457 top-level rules), so it fires on nothing
legitimate. Repeats of the *same* value stay legal — they are a no-op and a
minifier is entitled to leave one behind.

This retires a justification the first check rested on. The comment above it, and
§2.2 of the morning's design record, both excused not looking inside a rule by
citing Lightning CSS fallback pairs — "the same property twice in one rule,
oldest syntax first, as seen in `.w-gutter{width:var(…);width:var(…)}`". The
shipped artifact contains no such pair, for `.w-gutter` or for anything else. If
a future Lightning CSS does start emitting one, this assertion will say so, with
the selector and both values printed; the answer then is to name that pair in the
check, not to stop looking.

The three copies of the danger list are corrected together: drop `inline`, add
`px`, `full`, `auto`, `fit`, `min`, `max`, `none`, `screen`, `dvh`, `lvh`, `svh`
beside `block`, `flex`, `grid`, `table`.

### 2.2 The card counts its own buckets

The two option descriptions and the question's time span are computed from the
fixture, with the same expressions the grid in the picture uses —
`date(occurred_at)` and `strftime('%Y-W%W', occurred_at)`. The card and the pane
beside it then agree by construction, at any `--rows`.

Arithmetic on `eventRows` was the obvious alternative and it is half wrong. Days
are exact — rows are 2.5 minutes apart, so `ceil(eventRows / 576)` gives 1,737.
Weeks are not: `ceil(1737 / 7)` is 249, and the grid says 252, because
`'%Y-W%W'` is scoped to the calendar year and every year boundary opens a fresh
bucket. Reproducing that in JavaScript means re-implementing the grouping the
query in the same screenshot already performs. Asking the database is three
lines and cannot drift.

Both READMEs' alt text for that image is updated to match — it quoted the "four
years" sentence verbatim, so the error had already reached the prose.

### 2.3 Every probe throws, and the arguments are checked before Electron starts

| site | new behaviour |
| --- | --- |
| `waitForRows` × 2 | throw naming the shot when it returns 0 |
| `wheelDown` | throw unless it returns `'ok'` |
| `resetHorizontal` | throw unless it returns a number |
| drain loop | after the loop, throw if the workspace still says `running` |
| after the drain | throw unless the workspace's row count is `eventRows` |
| `--only` | reject any name that is not one of the three shots |
| `--rows` | reject anything that is not a positive integer |
| `--theme` | reject anything outside `dark` / `light` |

The argument checks run before the fixture is built and before the app is
launched, so a typo costs a second rather than four minutes and a poisoned
cache entry.

### 2.4 Files

| file | change |
| --- | --- |
| `apps/desktop/scripts/audit-shipped-css.mjs` | the second assertion; the danger list in the first assertion's message |
| `apps/desktop/src/renderer/styles.css` | the danger list in the spacing ladder's comment |
| `apps/desktop/scripts/screenshot.mjs` | bucket counts from the fixture; probes throw; arguments validated |
| `docs/images/agent-asks-{dark,light}.png` | re-shot |
| `README.md`, `README.zh-CN.md` | alt text for the `agent-asks` image |
| `docs/design/2026-08-24-a-spacing-token-shadowed-a-display-utility.md` | §2.2 corrected — it describes a coverage the rule does not have |

## 3. Trade-offs

**Widen the first assertion instead of adding a second.** The two shapes need
different comparisons — one between rules sharing a prelude, one between
declarations sharing a rule — and the first already carries three hard-won
false-positive guards (`@layer` transparency, custom-property-only rules,
logical/physical folding). Threading a second traversal through it makes both
harder to read and neither cheaper. Two assertions, one paragraph of shared
rationale.

**Ban repeated properties outright, same value or not.** Simpler to state, and it
would fire on a legal no-op the day a minifier leaves one behind. The value
difference is what makes it an override; that is the thing worth asserting on.

**Shorten the fixture's time axis so "four years" becomes true.** Cheapest, and
it fixes one sentence while leaving two hardcoded counts to rot the first time
somebody passes `--rows`. It also costs the fixture the thing it is for: 2.5
minutes per row is what makes a million rows a plausible event stream rather than
a synthetic ramp.

**Warn instead of throwing in `screenshot.mjs`.** This is what the script does
today — every failure is already printed. The output is six PNGs committed to the
repository and quoted number-by-number in both READMEs' alt text, and the "261000
rows · running" run proves a printed warning is one a human scrolls past.

## 4. Verification

1. **The audit passes on a clean tree, and reports the same as before.**

   ```bash
   pnpm --filter @peek/desktop build
   ```

   Observed: `446 class rules in 1 stylesheet(s), 38855 B`, byte-identical to the
   line before the second assertion went in — it examines 369 single-class rules
   and clears them all.

2. **The new assertion fails on the shape the old one misses.** Add
   `--spacing-full: 24px` to the `@theme` block, rebuild, and the audit must exit
   non-zero naming `.w-full` and both values. A guard that cannot fail is the
   failure mode this whole script exists to deny — §4.3 of the morning's record
   records the first version of the *first* rule doing exactly that.

   ```bash
   pnpm --filter @peek/desktop exec electron-vite build && pnpm --filter @peek/desktop audit:css
   ```

   Observed: `8 class rule(s) declare one property twice with two different
   values` — `.w-full`, `.h-full`, `.max-w-full`, `.min-w-full`, `.max-h-full`,
   `.basis-full`, `.top-full`, `.bottom-full`, each `100% then var(--spacing-full)`.
   Eight live rules in this renderer, from one token nobody would look at twice.

3. **The old assertion still fails on its own shape.** Same procedure with
   `--spacing-block: 24px`; the message must still name `.inline-block`.

   Observed: `1 class selector(s) ship as two rules that have no property in
   common: .inline-block — rule 1 sets: display / rule 2 sets: width`.

4. **The card agrees with the pane.** Re-shoot and read the numbers out of the
   PNG: the "By week" option and the grid's status bar must show the same count.

   ```bash
   node apps/desktop/scripts/screenshot.mjs --only agent-asks
   ```

   Observed in both themes: card "By week — 252 buckets" against a status bar
   reading `252 rows | Done`, top row `2029-W40`, and a question that says
   `events spans 2025 to 2029`.

5. **The probes throw, and the row count is not merely printed.** A short run
   exercises every new throw on the path that has the most of them; temporarily
   comparing against `eventRows + 1` proves the last one is not vacuous.

   ```bash
   node apps/desktop/scripts/screenshot.mjs --only million-rows --theme dark --rows 3000
   ```

   Observed: passes, reporting `3000 rows · done` and a gutter of `48px` with
   `honoursToken: true`; with the comparison sabotaged, `Error: the workspace says
   3000 rows · done …, but the fixture has 3000 rows` — and no PNG written, because
   the assertion sits before the shutter. **Restore the image this overwrites**:
   `million-rows-dark.png` is a million-row shot and a 3,000-row one is not a
   substitute for it.

6. **Bad arguments exit non-zero without launching anything.** `--only overvew`,
   `--rows abc`, `--rows 0`, `--theme foo` and `--theme system` must each throw
   before the fixture is built.

7. **Formatting.** `npx prettier --check .`
