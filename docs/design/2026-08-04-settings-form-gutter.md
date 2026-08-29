# The form's label column: one width, three references

## 1. What this fixes

### Where things stand

Every row in the settings dialog is the same shape: a right-aligned label, a
fixed-width "label column", then the control. Hint text (`.form-hint`) and button
rows with no label have to indent to the control column, or they look as though
they are hanging in mid-air.

That width is written five times in `styles.css`, as four literals:

| rule | location | value |
|---|---|---|
| base: the `label` element **and** the `.form-label` span | `styles.css:1581` | 88px |
| base hint indent | `styles.css:1602` | 96px |
| settings pane override: **only the `label` element** | `styles.css:1679` | 116px |
| settings pane hint indent | `styles.css:1683` | 124px |
| the settings pane's `.conn-actions` | `styles.css:1690` | 124px |

96 = 88 + 8 and 124 = 116 + 8, where the 8 is `.form-row`'s `gap`. Which is to say
those five numbers are really **one** width, with nowhere saying so.

### The problems

Three symptoms, one cause.

**First, `.settings-pane`'s override misses `.form-label`.** The base rule lists
the `label` element and the `.form-label` span together in one selector — which is
what the comment at `styles.css:1571` intends: a `<label>` is a promise to a
screen reader and is used only when it really points at a control, with a span
taking the layout slot otherwise. They are two spellings of the same column. But
the override at `styles.css:1679` names only `label`, so inside the settings pane
the span rows are 88px and the `<label>` rows are 116px — **28px apart on the same
screen**.

`AgentSection` shows it most clearly: four `<Segmented>` use spans (88px) while
executable / Base URL / API key use `<label>` (116px), and neither column lines up
with the other. `AboutSection` is the same — the version row is a span and the
four path rows are `<label>`.

**Second, every hint is indented 28px further than the control it describes.**
The hints are computed off the 116px step (124px), while a span row's control
starts at 88 + 8 = 96px. The whole Appearance section's controls are spans, so
both of its hints are wrong; Agent and About likewise.

**Third, `.form-actions` has never had a style.** `AgentSection.tsx:178` and
`:268` are the repository's only two uses, and other sections' button rows use
`.conn-actions` — a class that carries `margin-left: 124px` inside
`.settings-pane`. `.form-actions` carries nothing, so the "Save" button retreats
into the label column and sits alone against the far left. This is the one that
is visibly wrong at a glance.

Section by section:

| section | symptoms |
|---|---|
| Chat agent | all three: the orphaned button, the 88/116 offset on one screen, the skewed hints |
| About | the first and second: the version row offset from the four path rows, hints skewed |
| Appearance | the second: every control is a span, so both hints indent 28px too far |
| Databases | unaffected; it uses `.form-row-stack` (label above, stacked) |
| MCP endpoint, Queries and timeouts | correct — they happen to use `<label>` plus `.conn-actions` throughout, and land on the 116/124 step |

Forms outside the settings dialog (the connect dialog and so on) use the 88/96
step, are self-consistent, and show no symptom. They simply hold the same hazard
at a different number.

### Boundary (explicitly not done)

- **No tsx changes.** Every symptom is in the CSS, and the components' division
  between spans and `<label>` is correct; changing it would spend accessibility
  semantics to patch a hole in the styling.
- **No copy changes, and no widening the label column to eliminate a wrap.**
  Reasoning in §3.
- **`.form-row-stack` is untouched** (the Databases section). It is a deliberately
  different arrangement and does not participate in label-column alignment to
  begin with.
- **`.form-actions` and `.conn-actions` are not merged.** Reasoning in §3.

## 2. The plan

### 2.1 One variable, four references (`styles.css`)

The label column's width goes into `:root` beside `--row-h` and `--gutter-w`:

```css
--form-label-w: 88px;
```

The settings pane changes that one value and the other three follow:

```css
.settings-pane {
  --form-label-w: 116px;
}
```

So both overrides — `styles.css:1679` (116px) and `:1683` (124px) — are deleted
entirely. What they meant to say, "labels are wider in this section", is now said
by one variable assignment, and it can no longer be half-changed.

The references:

- `.form-row label, .form-row .form-label` → `width: var(--form-label-w)`
- `.form-hint` → `margin-left: calc(var(--form-label-w) + 8px)`
- `.form-actions` → the same (§2.2)
- `.settings-pane .conn-actions` → the same

**That `+ 8px` has to be written at every point of use and cannot be factored into
a second variable.** The first version did factor it
(`--form-indent: calc(var(--form-label-w) + 8px)` on `:root`), and the measurement
put the hints at 106px with the controls at 134px — the misalignment intact to the
pixel, merely pointing the other way. The reason is that a custom property
substitutes its own `var()` **at the point of declaration**: evaluating
`--form-indent` on `:root` welds 88px into it, and `.settings-pane` changing
`--form-label-w` afterwards can no longer reach it. Written into the rule that
actually consumes it, the `var()` resolves on that element and the override can
reach it.

### 2.2 A rule for `.form-actions`

```css
.form-actions {
  margin-left: calc(var(--form-label-w) + 8px);
}
```

With no `.settings-pane` prefix. `.form-actions` means "this row has no label, but
its buttons belong to the control column", which holds in any form using a label
column; outside the settings pane it computes to 96px on its own, which is exactly
where those forms' controls start.

### 2.3 Data flow

None. This change is styling only, and touches no tsx, no state and no IPC.

## 3. Trade-offs

**Renaming `.form-actions` to `.conn-actions` and deleting the class nobody
implemented was considered.** That would be one CSS rule fewer. Rejected because
it points the wrong way: `.conn-actions` belongs to the sidebar's connection list
(`styles.css:417`, with `flex-wrap` and a 4px gap), its appearance in the settings
pane is borrowing to begin with, and the comment at `styles.css:1687` admits as
much itself ("`.conn-actions` comes from the sidebar, where there is no label
column to miss"). Making the agent settings depend on a class named "connection
actions" would make the loan permanent. The other way round, `.form-actions` is
the name this form system should have, and all it lacks is an implementation.
`.conn-actions`'s override in the settings pane stays as it is, referencing the
same variable — the day its two users (`McpSection`, `TimeoutsSection`) also
switch to `.form-actions`, that override can be deleted outright, but that is a
separate change.

**Widening the label column so that "New conversations start in" does not wrap was
considered.** The zh-CN copy is ten Han characters, roughly 120px at 12px, which
116px cannot hold, so in the screenshot it is two lines. But widening does not
solve it: the English is `New conversations start in`, which is two lines however
wide it gets — both strings are deliberately written as "label plus value read as
one sentence", and being long is simply their shape. Meanwhile the label column is
shared by **every** section, and widening it to 132px for one line of copy costs
twenty other rows a strip of white space to the right of their labels.

A right-aligned two-line label against a control with `align-items: center` is
aligned, not defective. What actually makes that screen look disordered is the
three problems in §1, and whether this wrap still grates is worth looking at once
they are fixed — if it does, that is a copy question, not a layout one.

**Adding only the `.form-actions` rule and leaving the rest was considered.** That
fixes the most conspicuous orphaned button, but the 28px misalignment stays put,
and the next person adding a settings section falls into the same hole — five
literals scattered across sixty lines of CSS, with nothing to indicate they must
change together. This whole situation was caused by the last change altering only
half of them.

## 4. Verification

- `pnpm --filter @peek/desktop typecheck` — a pure CSS change should have no
  effect; the run confirms no tsx was touched by accident.
- `pnpm --filter @peek/desktop test` — likewise. `theme-contrast.test.ts` reads
  `:root`, and this new geometric variable is not a colour, so it should not
  react.
- **Measure it, do not just look.** This change is entirely about pixel
  positions, and the eye cannot tell whether a 28px misalignment was actually
  fixed — the first version's `--form-indent` looked "about right" and was wrong
  throughout. Hang the three stylesheets on a static page, reproduce the real DOM
  structure (`.settings-pane` > `.form-row` + `.form-label` / `<label>` /
  `.seg-group` / `.form-actions`), and measure each one's left edge relative to
  the pane with `getBoundingClientRect().left`. Measured after the change:

  | probe | left edge |
  |---|---|
  | the three `.seg-group`, the executable input | 134 |
  | the four `.form-hint`, `.form-actions` and its buttons | 134 |
  | label width (one span and one `<label>`) | 116 / 116 |

  Measure the step outside the settings pane at the same time; it should be
  unchanged: labels 88/88, controls and hints both at 96 (plus `modal-body`'s 10px
  padding = 106), and the sidebar's `.conn-actions` with no indent.

- By hand, section by section with the settings open (`⌘,`):
  1. **Chat agent** — the left edges of the four `<Segmented>`, the executable
     input, every hint, and the "Save" button: all five on one vertical line.
  2. **Chat agent → your own endpoint** — the same line, with "Save" and "Forget
     key" aligned together.
  3. **About** — the version value aligned with the four path inputs.
  4. **Appearance** — the language and interface-size button groups aligned with
     the hints beneath each.
  5. **MCP endpoint, Queries and timeouts** — these two were already correct;
     confirm they were not broken.
  6. Go through 1–5 again in English; longer labels must not shift any column.
- Outside the settings dialog: open the connect dialog and confirm the 88/96 step
  is unchanged.
