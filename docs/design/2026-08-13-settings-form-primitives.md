# Form primitives: a convention becomes an API, arithmetic becomes layout

This continues `2026-08-04-settings-form-gutter.md` and **overturns** it. That
document gathered the four literals scattered across sixty lines of CSS into one
variable, which was the right direction taken as far as it goes. This one takes
the half it could not: there is one variable now, but it is still **one pixel
value shared by every form**, and a form row is still a set of class-name
conventions that nothing enforces.

## 1. What this fixes

### Where things stand

The settings dialog has six sections, each written independently by its own
component. They share one form vocabulary, and the whole implementation of that
vocabulary is four unlayered rules in `styles.css` plus one token:

```css
.form-row        { display: flex; align-items: center; gap: 8px; margin-bottom: 8px }
.form-row label,
.form-row .form-label { width: var(--spacing-form-label); flex: 0 0 auto; … }
.form-hint       { margin: 0 0 10px calc(var(--spacing-form-label) + 8px) }
.form-actions    { margin-left: calc(var(--spacing-form-label) + 8px) }

:root           { --spacing-form-label: 88px }    /* styles.css:896 */
.settings-pane  { --spacing-form-label: 116px }   /* styles.css:2262 */
```

The correct way to write a form row is therefore a recipe written down nowhere: a
`.form-row` container, `<label>` or a `.form-label` span in the first slot
(depending on whether the control to its right can be pointed at by a label), the
control after it, explanatory text as the **next sibling** `.form-hint`, and a
button row that has to remember `.form-actions` or it drops back into the label
column.

### The problems

Four of them, one cause.

**First, the recipe has already drifted.** A button row has two spellings in the
repository:

| spelling | use sites |
|---|---|
| `form-row form-actions` | `AgentSection.tsx:187`, `:278` |
| `flex flex-wrap gap-tight mt-tight form-actions mb-snug` | `McpSection.tsx:164`, `:232`, `TimeoutsSection.tsx:100`, `PackagesSection.tsx:185` |

The second is repeated verbatim at four sites, and its spacing and wrapping
behaviour differ from the first's. Nobody wrote it wrong — both run; it is just
that nowhere says what a button row looks like, so there are as many spellings as
there are authors.

`McpSection.tsx:128` is the same thing in another shape: the `<label>` in
`<label>{t('mcp.state')}</label>` points at a span. All of `form-gutter.md` is
about "`<label>` is a promise to a screen reader", and this line is still making
an empty one — because nothing stopped it at the moment it was written.

**Second, hint text aligns by arithmetic rather than by structure.** `.form-hint`
is a **sibling** of `.form-row`, and the way it aligns with the control is by
computing the label column's width all over again. So that `+ 8px` has to be
written at three points of use, not one of which may be missed and not one of
which may be factored out — `form-gutter.md` §2.1 spends a whole paragraph
explaining why the first version's `--form-indent` failed (a custom property
substitutes its `var()` **at the point of declaration**).

That explanation is accurate, and what it accurately describes is a problem that
should not exist: the only reason a hint needs to know how wide the label is, is
that in the DOM it does not belong to that row.

**Third, one label-column width, shared by six sections.** `.settings-pane`'s
116px is a compromise across the six, so any one section's local need has to be
settled globally. That passage in `form-gutter.md` §3 — "widening the label
column so that `New conversations start in` does not wrap was considered, but the
label column is shared by every section, and widening it to 132px for one line of
copy costs twenty other rows a strip of white space to the right of their
labels" — that dilemma was not caused by the copy, it was caused by sharing one
pixel value.

The comment at `styles.css:855` puts the same hazard more plainly: 88px is "a
width measured against the type size", the widest label `Database index` measures
87.1px, and the headroom is **0.9px**; change the type size and it has to be
measured again, and the failure is the quiet kind — nothing clips, the row just
gets longer. A constant that holds only because somebody remembers to re-measure
it is the appointed place for the next "it went crooked again".

**Fourth, one unlayered rule forced two inline styles.** `.form-hint` is
unlayered, an unlayered declaration beats every `@layer`, and so `text-warn`
written beside it compiles, matches, and then does nothing. The comment at
`McpSection.tsx:215` says this clearly and announces the way out: "when app.css's
form rules move into `@layer base`, these two become `text-warn` / `text-err` and
the inline style goes away". `ConnectDialog.tsx:134` and `:285` are two more
copies of the same hack.

### The conclusion

The settings page is **six independent authors sharing one global constraint with
no boundary**. The cost of adding a section is therefore not "write a section"
but "write a section, and settle once more the width, the recipe and the cascade
order that every section shares". That is why it goes crooked every time a
feature is added — the two documents from 2026-08-04 were not two incidental
patches, they were two flare-ups of the same structural problem.

### Boundary (not done this time)

- **No change to any section's behaviour, copy, i18n keys, commands or storage.**
  This only swaps out how the form is carried.
- **No change to the categories.** Six sections stay six sections, in the same
  order. "Which section should a new feature go in" is a different question and
  is worth a document of its own.
- **No change to the dialog's size.** 800 × 560 is kept as it is. The width was
  forced by `PackagesSection`'s table (`settings-dialog-width.md`), and that
  section **is not a form**; it takes no part in this change. Decoupling the
  table from the dialog width is a separate change.
- **`PackagesSection`'s table is untouched.** It has already been written down as
  "a list, not form rows". How its hints and actions move is in §2.4a — not into
  `<Form>`, but out of the form system.
- **No `<Disclosure>`, no group headings, no validation states.** This only lands
  the four existing kinds of row in components; it invents no new form
  capability.

## 2. The plan

### 2.1 Three components and a container

New file `renderer/ui/Form.tsx`:

```tsx
<Form>
  <FormRow label={t('settings.language')}>…control…</FormRow>
  <FormRow label={t('settings.agent.executable')} htmlFor="peek-agent-exe">…</FormRow>
  <FormHint>…</FormHint>
  <FormHint tone="warn">…</FormHint>
  <FormActions>…buttons…</FormActions>
</Form>
```

Each of the four recipe items becomes something a compiler or a component
signature can hold:

| what you had to remember | now |
|---|---|
| Use `<label htmlFor>` when the control can be pointed at by a label, a span otherwise | Pass `htmlFor` and it renders `<label>`; leave it out and it renders a span. One parameter, both correct |
| A hint has to be written as the row's next sibling, wearing the right class name | `<FormHint>`, or `<FormRow hint>`; the component decides the position |
| A button row has to remember `.form-actions` | `<FormActions>`, defined in one place |
| A warning colour needs an inline style to win | `tone`, see §2.4 |

`<FormRow>` also accepts a `hint` prop, because "one row plus one line of
explanation" is the most common shape, and `<FormRow label hint>` fits its
meaning better than splitting it into two siblings. The standalone `<FormHint>`
stays, because three kinds of hint belong to no row: a whole paragraph at the top
of a section (`settings.packages.hint`), a notice that appears conditionally
(`notice`), and a closing note at the end of a section
(`settings.timeouts.stageNote`).

### 2.2 Alignment by grid columns, not by margin arithmetic

`<Form>` is a two-column grid, and `<FormRow>` **returns a fragment** — it
generates no element of its own; the label lands in the first column and an
internal flex box lands in the second to hold the children. `<FormHint>` and
`<FormActions>` are grid items placed straight into the second column.

> The draft had a `display: contents` div wrapped around the row; the
> implementation used a fragment instead. Same effect, one element fewer, and one
> fewer paragraph about whether `display: contents` takes accessibility semantics
> with it — that paragraph happens not to be needed here, but "happens not to be
> needed" is something you have to argue, and a fragment does not even need the
> argument.

So:

- **Hints and actions align with the control column by construction**, because
  they sit in the same column as the controls rather than being computed into
  place. The three `calc(var(--spacing-form-label) + 8px)` disappear, and with
  them the whole paragraph explaining why they cannot be factored out — not
  because that paragraph was wrong, but because the arithmetic it describes no
  longer exists.
- **Row spacing comes from the container's `row-gap`**, no longer from each
  `.form-row`'s own `margin-bottom` plus whatever `mb-snug` / `mt-tight` a
  section adds on top.
- **The second column is flex inside**, so `TimeoutsSection`'s "input plus a
  'seconds' suffix" row works with no extra structure.

`display: contents` is safe here: `<FormRow>`'s div carries no semantic role (the
roles are all on the label, on the control, and on the `role="tabpanel"` outside
`<Form>`), so generating no box takes no accessibility information with it. That
is `display: contents`'s only real trap, and it cannot be stepped into here.

### 2.3 The label column fits its content, instead of being one global pixel value

The first column is `fit-content(<cap>)`: the width is decided by **the longest
label inside this `<Form>`**, and it wraps only past the cap.

This is the crux of the change, and the point where it overturns
`form-gutter.md` head-on:

- `--spacing-form-label: 88px` is demoted from **"how wide the label column is"**
  to **"how wide the label column may get"**. A cap does not need to be measured
  precisely, and does not quietly stop holding because the type size changed —
  the whole class of hazard the 0.9px headroom belongs to disappears.
- `.settings-pane { --spacing-form-label: 116px }` is deleted outright. That the
  settings page's labels are longer than the connect dialog's no longer has to be
  known and written down by anyone: each `<Form>` fits itself.
- The dilemma of "widening the global label column for one line of copy"
  disappears. The Agent section's long label affects only the Agent section.

The cap is **180px**. The basis is the longest label `styles.css:874` has already
measured: `Views contributed by a package` is 180.4px at the 12px body size, which
means 180 lands exactly where "the longest label known to the repository still
wraps" — it is a ceiling, not a target, and picking a point somebody already wraps
at is more honest than picking a width everybody clears.

### 2.4 One `@utility`, not one unlayered rule

The grid's column definition cannot be written as a Tailwind arbitrary value —
`tailwind-migration.md` §3.4 forbids it outright, and `fit-content()` here
carries a `var()` inside as well. So it is a named rule.

What matters is that **it has to be in `@layer utilities`**, written as
`@utility`, rather than unlayered the way `.form-row` / `.form-hint` are today.
This is not fastidiousness:

An unlayered declaration beats every `@layer`, and that is **the entire reason**
`text-warn` beside `.form-hint` does nothing today, and therefore the entire
reason four inline styles exist. Once the rule is in the utilities layer, `tone`
can be an ordinary class-name switch, the thing `McpSection.tsx:215` announced is
delivered, and `ConnectDialog`'s two copies go with it.

Deleted: `.form-row`, `.form-row label, .form-row .form-label`, `.form-row input,
.form-row select`, `.form-row input[type='checkbox']`, `.form-hint`,
`.form-actions` — six rules — and `.settings-pane`'s 116px override. The
`--spacing-form-label` token itself is kept, with its comment rewritten (§2.3's
change of meaning).

Those two rules `.form-row input, .form-row select` (`flex: 1; min-width: 0`) are
carried under the grid by the second column's flex container, written inside
`<FormRow>`; the checkbox special case follows them.

### 2.4a Two things found along the way: a borrowed indent, and a borrowed colour

Two things turned up during implementation, neither in the draft, both downstream
of the same cause.

**The Databases section has no label column at all.** Its hints and button rows
wear the shared class names and therefore indent 124px to line up with a control
column — while the body of this section is a table filling the pane's width, and
that control column never exists here. Which is to say, they align to a line only
other sections have, while the table they introduce starts at the left edge.

So this section **is not a `<Form>`**: three hints and two button rows move to
ordinary utility classes, full width, aligned with the table. This is the one
deliberate visual change in this pass, and the reason is that it swaps a borrowed
alignment for this section's own.

**`.form-label` / `.form-hint` were borrowed as colours.** The
`Views contributed by a package` block in the same section uses both class names,
and its comment says at the same time that "the label column's geometry is not
available here" — which is true, but only because the geometry is written on the
descendant selector `.form-row .form-label`, and this is not that. A borrowing
that is correct only because it fails to match is one step away from the next
person editing the selector. Both were changed to colour utility classes.

**The About section's control gallery moved out of `<Form>`.** A divider rule and
a whole gallery are pane-wide things, and everything inside `<Form>` lands in one
of two columns. It was never form content; the old vertical flex layout simply
had no objection to it.

### 2.5 The files involved

New:

```
apps/desktop/src/renderer/ui/Form.tsx
apps/desktop/src/renderer/ui/__tests__/form.test.ts
```

Changed:

| file | what changes |
|---|---|
| `ui/CLAUDE.md` | Add a "Building a form" section — the place the next person will actually read |
| `styles.css` | Delete six rules and the `.settings-pane` override; add the `@utility`; rewrite the token's comment |
| `components/settings/McpSection.tsx` | Migrate; the empty `<label>` at `:128` becomes a span; two inline styles removed |
| `components/settings/AgentSection.tsx` | Migrate; the two `form-row form-actions` become one |
| `components/settings/AppearanceSection.tsx` | Migrate |
| `components/settings/TimeoutsSection.tsx` | Migrate; the input plus its unit suffix land in the second column |
| `components/settings/AboutSection.tsx` | Migrate |
| `components/settings/PackagesSection.tsx` | Hints / actions go full width (§2.4a); the table is untouched |
| `components/ConnectDialog.tsx` | Migrate; two inline styles removed |

`ui/__tests__/control-spec.test.ts` does not change, which is worth stating:
`PRIMITIVES` is the list of "files allowed to write a bare `<button>`", and these
primitives render no `<button>` at all; `CLASSNAME_LEDGER` only looks at the
`className` a `<Button>` receives, and the four old names were never on it. Both
lists carry a "shrink only" self-check, and both are still green.

### 2.6 Data flow

None. This change touches no state, no IPC, no command, no i18n key.

## 3. Trade-offs

**Adding the components without touching the alignment mechanism was considered**
(`<FormRow>` still flex inside, hints still aligned by margin arithmetic). That
fixes the first and the fourth symptom, at the lowest cost. Rejected, because the
second and the third are what caused `form-gutter.md` and
`settings-dialog-width.md` in the first place — keep the arithmetic and you keep
"the label column's width is a number that has to be settled globally", and the
same discussion opens again the next time a settings section arrives.

**Keeping the label column fixed and merely moving the value into the component
was considered.** That way the control column never shifts when the category
changes. The reason not to is answered head-on in the next item of §3.

**Fitting to content costs a sideways shift of the control column when switching
category, and that is accepted knowingly.** `settings-dialog-width.md` §3
rejected "the width follows the content", on the grounds that "clicking the
sidebar to switch category makes the dialog jump sideways, and the sidebar shifts
under the cursor". That reason **does not hold** here, and the difference is
real: there, what jumps is **the dialog's edge and the sidebar's position** — the
hand is still on the sidebar and the floor moves under it; here what jumps is
**one alignment line inside a screenful of content that has just been replaced
wholesale**, with the sidebar not stirring and the dialog not stirring.
Everything on the right changes anyway when the category changes; one vertical
line landing elsewhere is not the same class of problem.

The same item also means **the label column's width changes when the language
changes**. That too is normal behaviour for fitting to content, and better than
what is there now: today's 116px is set by whichever of the two languages is
longer, and the other language always carries a strip of white space.

**Sharing one measured column width across the six sections was considered** (via
`subgrid`, or by measuring once on the pane). It cannot be done, and the reason it
cannot be done is a good one: the six sections render exclusively, only one is in
the DOM at a time, and "the longest label across all sections" is not something
the browser can see. Sharing would mean going back to a constant settled by a
human — which is precisely the thing being taken apart.

**Making the cap a prop on each `<Form>` was considered.** That hands the
authority just taken away straight back to the caller, only through a more
convenient door. The cap is a typographic floor, not a per-form design option.

**Using an inline style on `<Form>` rather than an `@utility` was considered.**
There is precedent — `MODAL_SIZE` is an inline style, for the reason written at
`styles.css:2240`: a name in the spacing namespace is simultaneously a legal
padding, gap and width, so one fact generates three classes. That reason holds
for **sizes** and does not hold here: `form-grid` is a complete layout rule, not
a number, and `@utility` gives it one name and generates one class. An inline
style, meanwhile, would hold it outside the cascade and recreate the very problem
§2.4 has just solved.

**Putting `<Form>` in `components/` rather than `ui/` was considered.** `ui/`'s
house rule is "a control's appearance lives in `spec.ts` and may be written
nowhere else", form primitives are not controls, and they look as though they do
not belong there. `ui/` is still right: the criterion is **how many consumers
this vocabulary has**, and it has seven, spanning `components/settings/` and
`components/ConnectDialog.tsx`. `ui/Menu.tsx` is the same kind of thing and is
already on `PRIMITIVES`.

## 4. Verification

### Automated

`ui/__tests__/form.test.ts` (new, 8 assertions). This suite has no DOM — this
repository's rendering assertions read source text plus the **build output**, and
only both together count — so what it tests is not "the components render", but
what each of the four recipe items has become:

| assertion | what it pins |
|---|---|
| The `htmlFor` ternary exists, with a span on one branch and `<label htmlFor>` on the other | The element is decided by the parameter |
| None of the four old class names survives in the seven consumer files | The old recipe has no stragglers |
| No `style=` in `Form.tsx`; no `style={{ color:` in the seven consumers | The escape hatch is shut |
| Each of the three tones compiles to one `color` declaration in the output | The class names are not invented |
| No stylesheet does a `calc()` on the label column | The arithmetic cannot creep back |
| `--spacing-form-label` is declared exactly once in the whole repository | There is no second override |
| `form-grid`'s first column in the output is `fit-content(var(…))` | Fitting to content cannot be changed back to a fixed value |

The last three are the crux of this pass: they are not testing that this change
was written correctly, they are testing that **the next one cannot go wrong the
same way**.

The rest:

- `pnpm --filter @peek/desktop typecheck` — passes.
- `pnpm --filter @peek/desktop test` — 1853 passed, 0 failed (1845 before the
  change).
- `pnpm --filter @peek/desktop build` — passes, `render-probe` included. This one
  matters more than it looks: the probe hangs the **connect dialog** — now built
  entirely out of these primitives — into a page that loads only the built
  stylesheet, renders it for real, then sweeps for accessibility, hit testing,
  contrast and interaction states. All green means the new grid stands up in the
  real output, with no overlapping elements and nothing fallen outside its
  clickable area.
- Output checked: `.form-grid` / `.form-field` / `.col-start-2` and the three
  tone classes all compiled to the expected declarations; the four old rules
  appear **0** times in the output.

### By hand (still to do)

`form-gutter.md` set a rule: **measure, do not just look**. A 28px misalignment
cannot be told apart by eye, and everything this change touches is pixel
positions. None of the following has been walked through in a real window; what
the build probe covers is the connect dialog and nothing else.

1. Open the settings section by section (`⌘,`) and measure with
   `getBoundingClientRect().left` in each: every control, every hint and every
   button row should have **exactly the same** left edge, and the labels' right
   edge should sit one gap away from it. Four sections could not manage this
   before the change.
2. **Chat agent** — the two button rows (bundled and endpoint) have the same
   spacing; before the change they were two different spellings.
3. **MCP endpoint** — force a port fallback (occupy the preferred port, then
   start), and confirm that the warning is amber and that its colour comes from a
   class name rather than from `style` (visible in the dev tools' Styles pane).
4. **Queries and timeouts** — the "seconds" suffix on all three rows sits right
   after the input and does not drop to the next line.
5. **About** — the version row (a span) and the four path rows (`<label>`) have
   the same left edge; before the change they were 28px apart. In a development
   build the gallery is still at the bottom, and still spans the whole pane.
6. **Databases** — the table's width, its column widths and whether anything
   wraps are **all unchanged**; the section's explanatory text and buttons now
   start at the pane's left edge, aligned with the table (§2.4a).
7. Go through 1–6 again in English. The label column's width changes, which is
   expected; the label column should be the only thing that changes.
8. Set the interface size to 150% and to 75%, and confirm the label column
   follows the type size with nobody re-measuring anything — this is the answer
   to that 0.9px headroom in `styles.css`.

### Next: making item 1 not a manual step

`scripts/render-probe/` already renders the connect dialog against the real build
output. The settings dialog cannot get in because every one of its sections needs
`settings.read` before it has any content, and there is no preload behind the
probe page. Giving the probe a check for "every second-column element inside one
`form-grid` has the same left edge" — plus, by that framework's rule, a
deliberately planted misalignment to prove the check is not empty — would turn
item 1 above into something that runs on every build.

That is a separate change with a design space of its own (a new pane or a new
check, and how to feed it data), and by this repository's convention it should go
through a document of its own. Recorded here so it does not become one more
recipe that only a person remembers.
