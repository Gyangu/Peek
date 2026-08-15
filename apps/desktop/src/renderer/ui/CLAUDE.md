# `renderer/ui/` — the control layer

Read this before adding or restyling any control. It is short on purpose.

Design records:
[control spec](../../../../../docs/design/2026-08-02-control-spec.md) ·
[segmented](../../../../../docs/design/2026-08-02-segmented-control.md) ·
[context menu](../../../../../docs/design/2026-08-03-context-menu-primitive.md) ·
[Tailwind migration](../../../../../docs/design/2026-08-04-tailwind-migration.md)

## The one rule

**Never write a bare `<button>` in `renderer/`. Never write a utility class that
changes how a control looks.**

Both are enforced by `__tests__/control-spec.test.ts`, not by review. A control's
appearance is a string of Tailwind classes in `spec.ts` and nowhere else — there
is no `controls.css` any more. A paint family handed to a `<Button>` through
`className` is rejected: the colour, edge, radius, type, padding, elevation and
height families, by prefix, whatever variant is written in front of them.

That sentence used to end "wherever they are written", and as written it was
false. The test reads the tag, so a paint utility parked in a module-level
constant and passed by name reached the element with every suite green. It does
not any more — but the fix was to **refuse a `className` the test cannot read**,
not to teach it to read one. Know the difference before you need it: the exact
edge is under *Escape hatches* below.

```tsx
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'

<Button variant="danger" size="sm" onClick={forget}>Remove</Button>
<Button variant="ghost" icon label="Close tab" onClick={close}><Icon name="close" /></Button>

<Segmented
  label="Language"
  value={locale}
  options={[{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '中文' }]}
  onChange={setLocale}
/>
```

## Icons

**Never type a character to draw a picture.** Every icon comes from `icons.ts`
through `<Icon>`, and a test refuses the alternative.

```tsx
import { Icon } from '../../ui/Icon'

<Icon name="refresh" />                       // md, the default
<Icon name="close" size="sm" />               // inside a 20px control
```

The reason is not tidiness. Unicode does not contain most of what a UI needs, so
a glyph picked from it is the *nearest available shape* rather than the right
one — which is how the panel strip spent months drawing "split left/right" as
`⊞`, a symbol whose ordinary meaning is add-or-expand, paired with `⊟`
(collapse) to express two orthogonal directions. The tree's eleven node kinds
had the same problem and its own comment had already predicted it would get
worse.

Three rules, all of them decided inside `<Icon>` so no call site decides them:

- **Names are semantic, never shapes.** `close`, not `x`. Swapping a glyph or the
  whole library then touches `icons.ts` and nothing else. Action-shaped names
  reuse the Command Bus vocabulary, so `panel.splitRow` is at once the i18n key,
  the `data-peek-action` handle and the icon.
- **The size is the rung's**, from `ICON_SIZES`. A call site cannot pass pixels,
  for the reason `CONTROL_SIZES` exists.
- **The colour is `currentColor` and it is `aria-hidden`.** The name comes from
  the `<Button>`'s `label`. Inheriting the text colour is also what puts icons
  *inside* the contrast audits rather than beside them.

Adding one: import it in `icons.ts`, give it a semantic key, use it. The table is
static, so an entry nobody wears ships for nothing — and a test says so.

There is no `<IconButton>`, deliberately. `<Button variant icon label>` is
already the one entrance, and this layer exists because that entrance was missing
once.

Design record: [icon set](../../../../../docs/design/2026-08-15-icon-set.md)

`<Menu>` is the popup menu, and `useContextMenu` is the gesture that opens one:

```tsx
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'

const menu = useContextMenu<NamespaceNode>()

<div onContextMenu={menu.open(node)}>…</div>
{menu.state ? (
  <Menu label={t('menu.tree.label')} at={menu.state.at}
        nodes={treeMenuNodes(connId, menu.state.payload, caps, t, handlers)}
        onClose={menu.close} />
) : null}
```

Build the `nodes` in a **pure function next to the surface**, never inline in
JSX — `treeMenuNodes`, `tabMenuNodes`, `connectionMenuNodes`,
`contextActionsFor`. That is the half worth testing (what is offered, and to
whom), and it needs no DOM. A menu line has two tones, not five variants: see
`MENU_TONES`. An irreversible line gets `confirm`, which swaps the menu for
Cancel + the act, so the second press lands somewhere harmless.

`<Segmented>` is one choice out of several — a `radiogroup`, one tab stop, arrow
keys inside. Not a row of buttons with `aria-pressed`; that describes N
independent switches and is what it replaced.

## Building a form

`Form.tsx` is the label-and-control vocabulary. **Never lay a form row out by
hand** — the two dialogs in this app are built from these four, and the reason
they are components is that the same thing written as a recipe drifted twice in
two rounds.

```tsx
import { Form, FormActions, FormHint, FormRow } from '../../ui/Form'

<Form>
  <FormRow label={t('settings.language')} hint={t('settings.languageHint')}>
    <Segmented … />
  </FormRow>
  <FormRow label={t('mcp.port')} htmlFor="peek-mcp-port">
    <input id="peek-mcp-port" type="number" … />
  </FormRow>
  <FormHint tone="warn">{t('mcp.portFallback', …)}</FormHint>
  <FormActions><Button …>{t('mcp.applyPort')}</Button></FormActions>
</Form>
```

Four things worth knowing before you write one:

- **Pass `htmlFor` only when the row holds one control with that id.** It is the
  whole of the choice between a `<label>` and a span, and a `<label>` is a
  promise a screen reader follows. A `<Segmented>` names itself; text cannot be
  named at all. Two rows in this app were making the promise with nothing to keep
  it, which is what moved the decision into a parameter.
- **A row is a fragment.** Its label and its control cell join the enclosing
  `<Form>`'s two columns directly, so a component that returns rows composes into
  the grid of whatever form it is dropped in — and the label column is measured
  across all of them, not per sub-form.
- **The label column sizes itself** to that form's longest label, up to a
  ceiling in the theme. There is no width to set and none to override; a form
  with long labels costs itself and nothing else. Do not reintroduce a per-pane
  declaration of it — a test fails if you do.
- **A tone is `tone`, never a colour.** These rules are in the utilities layer,
  which is exactly what the four inline `style={{ color }}` escapes in this app
  were working around before they existed. If you need a fifth tone, it goes in
  `HINT_TONES`, named for what the sentence *is*.

Anything that spans the pane — a table, a rule, a gallery — belongs **outside**
the `<Form>`, because everything inside one is placed in one of two columns.

Design record: [form primitives](../../../../../docs/design/2026-08-13-settings-form-primitives.md)

## Picking a variant

Pick by **what the action means**, never by what you want it to look like. The
authoritative list, with an `intent` sentence for each, is `spec.ts` —
`BUTTON_VARIANTS`. Read it; it is thirty lines and it is the answer.

| | |
|---|---|
| `primary` | the one action this view exists for. At most one per container |
| `default` | a real action, but not the one the view is about |
| `ghost` | must not compete for attention |
| `danger` | destructive or irreversible |
| `caution` | not destructive, but the consequence outlives this moment |

Two sizes: `md` (24px, the default) and `sm` (20px **and** the smallest type rung, inline in a
compact strip). There is no third size. If neither fits, that is a spec question
— see below.

### Two variants owe each other a difference that is not a colour

`danger` and `caution` land in the same permission prompt — Reject next to
"Allow always" — and red against amber is one of the two pairs a red-green
colour-blind user cannot separate. So that pair is kept apart by the *shape* of
its edge, not only by its colour, and a deuteranopia simulation of the built
window is what the claim rests on: the two collapse to one hue and the edge is
all that is left.

That used to be a sentence in `spec.ts` and nothing else. Deleting the class it
described left every test green. It is a contract now: `__tests__/control-spec.test.ts`
carries a census of **every** pair of variants and what separates it once hue is
gone — whether the surface paints, whether the border paints, the border's style,
its thickness. The census asserts the *distinction*, not the class, so making
both members of a pair look the same fails just as loudly as making one of them
plain.

Three pairs are separated by nothing but colour today, and each says so in
writing with its measured lightness ratio and what fixing it would cost. The
sharpest is `default` beside `danger`, which share a resting surface exactly and
sit in that same permission row. Adding a variant means classifying it against
every existing one; the test will not let you skip it.

One modifier beyond `icon`: `elevated`, for a control that floats over scrolling
content and has to separate itself from whatever is behind it. Orthogonal to
`variant`, one caller today.

## When the spec is not enough

This is the part that matters, because it is the step that got skipped and
produced the mess this layer exists to clean up.

There were three separate implementations of "destructive" in this codebase —
`.confirm-danger`, `.chat-perm-reject` and `.chat-stop` — two of them
byte-for-byte identical. Nobody was careless. Each author needed a red button,
found no place to look and no place to add, and did the only remaining thing.
The third one was written by an agent, in this repo, one day before this layer
existed.

So: **do not solve it locally.** If you need something `spec.ts` cannot express:

1. Add the variant (or size) to `spec.ts`, with a real `intent` sentence. A
   variant whose intent you cannot state in one line is a variant named after
   its colour, which is the thing this spec exists to prevent.
2. Give it classes — **all five states**. The contract test fails if you write
   three of them. Two shapes it also fails on, both of which cost an afternoon
   to find the first time:
   - **A colour with no token.** An invented name used to generate nothing at
     all, so the control simply lost that colour and you saw it. Tailwind's own
     palette is switched back on now, so an invented name is far more likely to
     *be* one of its 288 defaults and paint something plausible that no contrast
     audit has looked at. Two tests reject those by name — one at the source, one
     at the artifact — but the failure you get is a red suite rather than a
     visibly broken control. Add the token to the theme block; an arbitrary value
     — a raw hex inside square brackets, hung off a colour family's prefix — is
     banned outright and tested for.
   - **Two classes from one utility family in one control's string.** A class
     list has no cascade — `bg-bg-2 bg-bg-3` is decided by Tailwind's emission
     order, not yours. That is why `surface` is a separate field from `classes`,
     and why each size rung states a whole shape instead of being patched.
3. Write it down in a design doc under `docs/design/`, per the repo's
   docs-before-code rule in the root `CLAUDE.md`.

That path is longer than adding a class. It is supposed to be: every step of it
leaves the next reader something to find.

## Escape hatches

- `style` — typed `never`. There is no way through. This is not an oversight.
- `className` — allowed, **layout only**: where the control sits, never what it
  looks like. Yes to the families that place a box inside whatever holds it: the
  position keywords and their offsets, stacking depth, margins, the flex-child
  properties, row and column placement, translation, width, and either spelling
  of visibility. No to the families that colour it, edge it, round it, set its
  type, pad it, raise it, fade it, or give it a height — those belong to the spec.

  Neither list is spelled out here in class names, and that is not vagueness.
  Both exist once, as `LAYOUT_UTILITY` and `PAINT_UTILITY` in
  `__tests__/control-spec.test.ts`, which is the file that actually decides. Read
  them there. The last section of this file says why a second copy here would be
  worse than no copy at all.

  The test classifies your class **by its prefix**, and an unrecognised prefix is
  **rejected**. That is stricter than it used to be, and deliberately: the old
  check looked the name up in the stylesheets, so a class no stylesheet defined
  owned no properties, declared nothing, and passed. A typo passed. It found a
  live `chat-chip-x` on a `<Button>` the first time it ran with the hole closed.

  A handful of pre-Tailwind names are still allowed, by name, on
  `CLASSNAME_LEDGER`. It only ever gets shorter — delete your entry when you
  migrate the module that owns it, and a test will tell you if you forget.

  What the test can see is what you write **in the tag**: a quoted attribute,
  both arms of a conditional, and the pieces of a template literal. It cannot see
  a value that is not there — a name standing for a class list, a property read
  off an object, whatever a helper returns — and `<Button>` appends what it is
  handed either way. So a `className` it cannot read in full is rejected *as
  unreadable*, and the failure tells you to write the classes out at the call
  site. One line was all this took: a module-level constant of paint utilities,
  passed by name, sailed past all three suites.

  Refusing is deliberately not the same as resolving. Following a name one hop
  would cover exactly one spelling of the bypass while reading, to the next
  author, as though it covered the idea — and the second spelling, a name
  imported from another module, would be green again. Two short duplicated
  placement strings cost less than a fence with a gap in it.

  One residue, named because it is real, and because a guide that hides one is
  worth less than no guide: an object spread into a `<Button>` can carry a
  `className` the test never sees, since the value is in the object and not in
  the tag. There is one spread on a `<Button>` in the renderer today and it
  carries a title. If you write the second, keep classes out of it.

## Why this file spells both of its lists out in words

This file lives **inside** `src/renderer/`, and `styles.css`'s `@source './'`
points Tailwind's scanner at the whole directory. That scanner does not know
what a comment is, what Markdown is, or what a code fence is: it pulls
candidates out of raw text and compiles every one that happens to be valid. A
class name written here as an example of *what not to do* therefore ships in
`index.css` exactly as if somebody had worn it — which is how a sentence
explaining that a bracketed hex "compiles, paints, and is invisible to the
audit" made itself true, in two files at once.

So the banned forms are described in prose here rather than typed out. If you
are about to improve one of these sentences by putting the real token back
between backticks: that is the failure, and `__tests__/theme-contrast.test.ts`
now reads this file and will stop you.

### The half that was missed for two rounds: the list of what is *allowed*

That treatment was applied to the forbidden syntax and stopped there. The
`className` paragraph also carried a list of what you *may* write — five real
examples, one per family — because when you are telling somebody what to write,
an example is the obvious thing to reach for and it does not feel like a hazard
at all. Tailwind compiled all five. Three were worn by nothing else in the
renderer, so the shipped stylesheet carried three rules whose only reason to
exist was that this file had recommended them. An audit found them as dead
weight, which is the mild version of the outcome; the sharp version is that a
guide can mint live CSS by being helpful.

Two things to take from the omission, which is more instructive than the fix:

**A scanner has no idea what a sentence is doing.** "Never write this" and
"write this instead" are the same input to it. The rule is about what a sentence
*names*, never about what it *recommends* — and the recommending half is the one
that will keep being missed, because a warning feels dangerous to write and an
example does not.

**A stem with a `*` after it is not automatically safe either.** That trick works
for the families whose bare stem is not a utility on its own, and does nothing
for the families where the stem *is* one: the edge, elevation, focus-outline and
focus-halo families all compile with no suffix at all, because the `*` merely
ends the token. Four such stems sat in this file the whole time. They happened to
have real wearers elsewhere, so they cost nothing — and "it happened to be worn"
is luck, not a design.

The way out of both is what the `className` paragraph now does: name the families
in English and point at the file holding the real patterns. One copy, it is the
copy that runs, and prose naming a family compiles to nothing.

## The runtime attributes

`action` and `exposure` are optional and nothing consumes them yet.

- `action` is a stable `domain.verb` handle, matching the Command Bus vocabulary
  (PLAN §6). Use it for controls a test needs to find, and for icon-only buttons.
  Ids must be globally unique — the test checks.
- `exposure` says who may operate the control: `human-only` (the default) or
  `agent-ok`. It is reserved for the day peek lets an agent drive controls
  directly. **Do not mark a permission-prompt button `agent-ok`** — an agent that
  can approve its own permission requests has no permission system. There is a
  test for exactly that.

## Seeing your work

`Gallery.tsx` renders every variant × state × size. In a dev build it is at the
bottom of the settings dialog's About section. Open it after changing anything
here — including if you are an agent: a screenshot is the only way you will ever
see what you just wrote.

## The two lists in `control-spec.test.ts`

**`MIGRATION_LEDGER`** — files still using a bare `<button>` that should not be.
One left. It may only get shorter.

**`NOT_CONTROLS`** — bare `<button>` elements that are deliberately outside this
layer, each with a written reason and a declared count.

That second list exists because the ledger's original premise was wrong. Not
every `<button>` wants to be a `<Button>`: a menu item, a disclosure header and a
tab all need button *semantics* and nothing from the control layer — `CONTROL_BASE`
sets a background, a border, a radius, centred content and a minimum height, and
all of them would override every one. Forcing them through is not migration.

What those bare elements still get is `base.css`, which keeps the `button` floor
— font, hit height, focus ring — inside `@layer base`. The layer is not
decoration: unlayered rules outrank every `@layer`, so as long as that block sat
outside one it beat every utility the control layer writes, and every ghost
button in the window came back grey. Verified in Electron's own Chromium.

So before you migrate something, ask which it is. If it is a menu item or a
disclosure, add it to `NOT_CONTROLS` with a reason — and note that the reason is
checked for length, because "this is not a control" is a judgement, and a
judgement nobody wrote down cannot be told apart from an oversight.

`<Menu>` exists now (2026-08-03) and took two of those five — the context menu's
items. Its own lines are bare `<button>`s, which is why `ui/Menu.tsx` is on
`PRIMITIVES` rather than on either list: a primitive has to render the real
element. `AttachmentBar`'s item stays exempt because it anchors to a *button* and
`<Menu>` anchors to a *point*; element anchoring is deferred, on purpose, rather
than invented for one caller.

`<Disclosure>` still does not exist. Two use cases, both counted.
