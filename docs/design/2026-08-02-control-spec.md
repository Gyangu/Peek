# The control spec: one source of truth shared by people, the coding AI and the runtime AI

> 2026-08-02. Carrying on from the same day's
> [`2026-08-02-ui-legibility-baseline.md`](2026-08-02-ui-legibility-baseline.md):
> that one pinned down the **values** (type size, contrast, hit area), this one
> pins down **the controls themselves** — which controls exist, what each one
> means, who is allowed to operate it, and how getting it wrong announces itself
> on the spot.

---

## 1. What this fixes

### 1.1 Today: there is a style layer, there is no control layer

peek's UI is hand-written CSS plus native elements, with no UI library at all.
That is not a defect — for a tool that demands high density it is the right
choice (see §3.1, which this round does not overturn either). The defect is:
**styles have a shared layer, controls have no abstraction layer.**

Scanning every `.tsx` in the repository (87 `<button>`s under `renderer/`):

| spelling | count |
|---|---|
| `className="ghost"` | 49 |
| no `className` (the default state) | 14 |
| `className="primary"` | 10 |
| assembled dynamically | 5 |
| a one-off class of its own | 18 distinct classes, most appearing once |

`components/` is all **feature parts** (Sidebar, DataGrid, ChatView), with no
layer of **base controls**: no `<Button>`, `<Input>`, `<Select>` or `<Dialog>`.
Those 87 buttons each assemble a `className` string by hand, and another 17
native `input/select/textarea` are scattered across 8 files.

### 1.2 The evidence: one meaning, defined independently three times

"Dangerous operation" — one meaning — has three implementations in the
repository, none of which knows about the others:

| class | definition | where |
|---|---|---|
| `.confirm-danger` | `color: var(--err); border-color: #7a3f3f` | `styles.css:354` |
| `.chat-perm-reject` | `color: var(--err); border-color: #7a3f3f` | `chat.css:630` |
| `.chat-stop` | `color: var(--err); border-color: var(--err)` | `chat.css:889` |

The first two are **byte-for-byte identical** and were written out twice anyway;
the third has a brighter border — not a deliberate hierarchy, three independent
improvisations. `#7a3f3f` is a bare hex, not in `:root`, appearing twice; and
`context-actions.css`'s file header states plainly that every colour comes from a
`:root` custom property and none are introduced there. **A convention kept alive
by a comment is a convention that gets walked around.**

Sizes, the same. Button heights actually come in three steps, 24 / 20 / 18, plus
assorted free-form padding: `.tab-close` 20, `.tree-action` 20, `.chat-chip-x`
18, `.md-copy` `min-height: 0`, `.chat-thought-head` `padding: 1px 4px`. There is
no concept of a "step", so every place that needs a small button invents a height
of its own.

### 1.3 What set this round off: I am the seventh case myself

`.confirm-danger` was added **this round** (2026-08-02, the legibility baseline).
I needed a dangerous button, searched the CSS for the concept "danger" and found
nothing, found nowhere saying where it ought to go, and created a class on the
spot — while `.chat-perm-reject` already existed, defined identically.

This is not carelessness. A coding agent's context is single-use: it does not
"read the spec once and remember it", it searches when it needs to. **A spec that
cannot be found is a spec that does not exist.** Conventions written in prose,
understandings passed along in code review, taste held in an old hand's head —
all of it is zero to an AI.

So the goal this round is not "tidy up the CSS" — that treats the symptom, and
the next person (or the next me) will invent an eighth variant. The goal is to
build **a single point of convergence**, and to make going around it audible in
CI.

### 1.4 "Both people and AI can operate it" is three layers, not one

peek's PLAN opens on the line "the interface can be driven by MCP", and its §1
says "people and AI operate through the same command channel, and state is always
consistent". That channel already exists — but it stops at the Command Bus and
does not reach the controls. Taking "AI can operate it" apart, it is really three
different things:

| | who operates | what they operate | today |
|---|---|---|---|
| **A. Authoring time** | a coding agent (Claude Code and the like) changing this repository | the source | ❌ no spec at all to work from |
| **B. Run time · write** | an external / embedded agent changing the interface over MCP | the Command Bus, 13 tools | ✅ as far as view / layout / query; controls are unreachable |
| **C. Run time · read** | the same, asking "what can I do right now" | `read_workspace` | ⚠️ returns **state**, not **available actions** |

What the user wants this time is mainly A. But since the PLAN's whole position is
B, designing the spec without considering B/C would be short-sighted: **the names
given to variants today are MCP's vocabulary tomorrow.** Get the names wrong and
either the wrong names get exposed later, or they get redone.

### 1.5 The key judgement: the only language all three share is "intent"

- People can read **pixels**: this one is red, this one is bigger, this one is
  bottom right.
- Code can read **class names**: `.confirm-danger`.
- AI can read neither. A coding agent cannot see the rendered result; a runtime
  agent cannot see the CSS.

All three share exactly one thing: **what this action means**. "It is
destructive" — a person infers it from the red, code looks it up from the class
name, an AI derives it straight from the task description ("delete this
connection").

Hence the first axiom of the whole spec: **name by intent, not by appearance.**
`danger`, not `red`; `primary`, not `blue-filled`. This serves A and B/C at once:
a coding agent picking a variant derives it from the semantics of the task, and a
runtime agent addressing an action has nothing but semantics to work with either.

### 1.6 Boundary (explicitly not done)

1. **No UI library.** No shadcn, no Radix, no button library of any kind.
   Reasoning in §3.1, consistent with the conclusion given to the user last round.
2. **No MCP control-operation tools.** §2.6 lands **the attributes and the safety
   boundary** only, not the tools. PLAN §1's "the AI only operates the built-in
   views" is unchanged; adding tools is another change and another document.
3. **Not migrating all 87 call sites at once.** The first batch is in §2.9, the
   rest go into an allowlist, and the list itself is the to-do.
4. **No `<Input>` / `<Select>` / `<Dialog>`.** The 17 form elements and the modals
   are the same class of problem, but the evidence on buttons is the hardest and
   the payoff the largest, so the methodology gets one full run first. The spec's
   skeleton (§2.2's data shape, §2.8's test shape) is designed to be reusable for
   the primitives that follow.
5. **No visual result changes.** This round converges what already exists; it is
   not a recolour. The only intentional visual change is the three red buttons
   being unified (two of which were already identical), plus filling in the
   missing `:active` / `:focus-visible` states.

---

## 2. The plan

### 2.1 Design axioms: six things people do not need and AI does

Each one states why a person can do without it and an AI cannot.

**Axiom 1 — name by intent, not by appearance.**
A person can infer intent from pixels; an AI has only the name.
`variant="danger"` can be derived from a task description,
`className="confirm-danger"` cannot. This also settles the vocabulary of layers
B/C.

**Axiom 2 — the spec is a data structure, not prose.**
One `spec.ts`, at once the type source, the documentation, the test fixture and
the CSS contract. A person can "read the docs once and remember"; an AI will not
— it greps. Data greps out a definite answer, prose greps out a passage that has
to be understood. The harder reason: prose drifts, a type generated by `as const`
cannot.

**Axiom 3 — a closed set to converge on, and the error message is the
documentation.**
`variant` is a closed union. `variant="destructive"` does not compile, and
TypeScript lists the four legal values outright. This is a learning channel
unique to AI: **it does not read the README, it reads the red text.** So the red
text has to be good enough.

**Axiom 4 — rules ring in CI, not in review.**
AI has no code review. "At most one primary per container", if it is only a
sentence in a document, may as well not exist. It has to be a test that can fail.
Every rule written into this document has a matching assertion in §2.8; a rule
that cannot be made into an assertion is declared as relying on people.

**Axiom 5 — an escape hatch is either sealed or counted.**
The repository has 56 inline `style={{}}` today, a good share of them "the
variants were not enough, so I assembled one in place". `Button`'s `style` prop is
typed `never`. Once it is sealed, "the spec is not enough" becomes **an explicit
evolution of the spec** (edit spec.ts, write the document) rather than **a silent
fork**.

**Axiom 6 — the default must be the safe one.**
AI will use defaults heavily — they save tokens and they save decisions. So the
choice of default is a safety decision, not a convenience decision. `exposure`
defaults to `human-only`: for a control to be operable by an agent, somebody has
to write that down explicitly.

### 2.2 `ui/spec.ts`: the single source of truth

One `as const` data structure, with four consumers drawing from the same place:

```
                     ┌─ TypeScript types ───→ coding agent (a mistake fails to compile)
   ui/spec.ts ───────┼─ CSS contract test ──→ rendering (one state short turns it red)
   (as const)        ├─ the gallery ────────→ people (can see it) / agents (can screenshot it)
                     └─ DOM attributes ─────→ runtime (a11y + MCP later)
```

The shape:

```ts
export const BUTTON_VARIANTS = {
  primary: {
    intent: 'The one action this view exists for. Submitting a form, confirming a dialog.',
    rule: 'At most one per container.',
  },
  default: {
    intent: 'A real action, but not the one the view is about.',
    rule: null,
  },
  ghost: {
    intent: 'An action that must not compete for attention — toolbar icons, row affordances.',
    rule: null,
  },
  danger: {
    intent: 'Destructive or irreversible. Deleting, disconnecting, rejecting.',
    rule: 'Never the default focus target; pair with ConfirmPair when irreversible.',
  },
  caution: {
    intent: 'Not destructive, but the consequence outlives this moment — granting a standing permission, entering a permissive mode.',
    rule: null,
  },
} as const
```

`intent` is written for the AI to read (in English, matching every comment in the
repository), and for people too. It is not decoration: §2.8 has a test asserting
every variant carries a non-empty `intent`, because **a variant with no statement
of intent is back to naming by appearance**.

`caution` earns its own entry rather than being folded into `danger`:
`chat-perm-always` (granting a permission permanently) destroys nothing, but its
consequence outlives the current interaction. Using `--warn` rather than `--err`
is already the fact on the ground; this only gives it a name.

`seg` is **not** a button variant; it is part of a separate control (a mutually
exclusive selection group). It stays inside the `.segmented` container, untouched
this round, and a `<Segmented>` primitive goes into a later batch (§2.9).

### 2.3 Variants converge: 7 wild ones → 5 named ones

| today | count | converges to |
|---|---|---|
| no class | 14 | `default` |
| `ghost` | 49 | `ghost` |
| `primary` | 10 | `primary` |
| `.confirm-danger` | 1 | `danger` |
| `.chat-perm-reject` | 1 | `danger` (already the same CSS as the line above) |
| `.chat-stop` | 1 | `danger` (border unified to `--danger-border`) |
| `.chat-perm-always` | 1 | `caution` |

`#7a3f3f` is promoted to `:root` as `--danger-border`, and the two hard-coded
copies disappear.

### 2.4 Size and shape

Keeping the `--hit-min: 24px` settled by the legibility baseline's §2.3, and
promoting the four `min-height: 0` **exemptions** of that round into a **step**:

| step | height | use |
|---|---|---|
| `md` (default) | 24px (`--hit-min`) | every standalone button |
| `sm` | 20px + `--fs-sm` | tight inline: an inline control inside a 24px row or a 30px bar |

> **Correction (found during the migration)**: `sm` originally gave a height only.
> By the fifth call site it was clear — `.md-copy`, `.chat-attach-add`,
> `.tab-close` and `.chat-thought-head` **each** wrote their own
> `font-size: var(--fs-sm)` beside the height. This is the same discovery as the
> height being written out by four separate rules in the first place: **a thing
> restated four times is a missing step**. The type size belongs to the step, not
> to the caller.

Plus an orthogonal prop `icon?: boolean`: square, no text. When `icon` is true,
`label` is required (used as `aria-label` and `title`) — enforced at the type
level, not by convention:

```ts
type ButtonProps = BaseProps & ({ icon: true; label: string } | { icon?: false; label?: string })
```

`.chat-chip-x` is 18px today, 2px shorter than `sm`. The migration raises it to
20px; the chip itself is tall enough, and the measurement is in §4. **No third
step**: three steps means the caller has to make a choice, and choices are exactly
where AI goes wrong.

### 2.5 Handling the escape hatches

| prop | decision | why |
|---|---|---|
| `style` | typed `never` | Axiom 5. This is the source of the 56 inline styles |
| `className` | allowed, but **layout only** | positioning classes are a legitimate need (`.chat-jump` is an absolutely positioned button); appearance classes are not |

"Layout only" is enforced by a test (§2.8 item 5): collect every class name passed
to `<Button>`, look up their declarations in the CSS, and assert that only
`position` / `inset` / `margin` / `flex` / `align-self` / `justify-self` / `order`
/ `grid-*` / `transform` / `z-index` / `width` appear. `color` / `background` /
`border` / `font-size` / `padding` / `height` fails — because those are things the
spec owns.

**The dividing line is not "is this a layout property" but "whose layout"**.
`align-self` / `justify-self` / `order` / `margin` decide how the control sits in
its container, which is the caller's business; `align-items` / `justify-content` /
`gap` / `display` decide how the control is arranged **inside**, and `.btn` sets
all four — a class overriding those is not placing a button, it is arguing with
the primitive about what a button is.

> **Erratum (2026-08-02)**: the first draft of this section wrote that list as
> `align-*` / `justify-*`, which reads as letting the whole family through, while
> `spec.ts` implements `align-self` / `justify-self`. That wildcard was loose
> prose, not a decision — it has been tightened to match the implementation. It is
> written down because the inconsistency briefly looked (and quite convincingly)
> like a bug in the code.

`.chat-jump` currently carries `background: var(--bg-3)`, and will fail. That is
**expected**: it either splits into "positioning class + variant", or it shows
that a floating button is a real, missing variant. Letting the gap surface itself
is more accurate than guessing at it now.

### 2.6 Semantic handles and exposure: the interface reserved for layers B/C

Two optional props, landing in the DOM:

```tsx
<Button variant="danger" action="conn.book.forget" exposure="human-only">
```

```html
<button class="btn btn-danger" data-peek-action="conn.book.forget" data-peek-exposure="human-only">
```

**`action`** is a stable semantic handle, named after the Command Bus's
`domain.verb` (PLAN §6). Three uses, in order of certainty:

1. **Today**: a test selector. Steadier than `getByText('Remove')`, and it does
   not move with i18n.
2. **Today**: an a11y backstop. A stable identifier for an `icon` button that has
   no visible text.
3. **Later**: MCP's operation handle. If `read_workspace` is to answer "what can
   this view do right now", the answer is these ids plus their `intent`.

**`exposure`** is the field I consider the most important in this spec, because
what it captures is a **safety boundary**, not merely a design one:

```ts
type Exposure = 'human-only' | 'agent-ok'
```

Defaulting to `human-only` (Axiom 6). The reason is very concrete: this round has
just redone the chat panel's permission prompt — an agent requests a permission, a
person approves it. **If MCP can one day click buttons, then the first button it
must not be able to click is "approve".** An agent that can approve its own
permission requests is a permission system that does not exist.

So the boundary is written into a test this round (§2.8 item 6) rather than
thought about when the MCP tools are actually built. An interface reserved and a
boundary settled first beats half a feature.

**Explicitly not done**: no MCP tool that reads or executes these attributes is
written. Today the attributes are only attributes.

### 2.7 The gallery

`ui/Gallery.tsx`, dev-only, drawing the full variant × state × size matrix: 5
variants × 5 states (rest / hover / active / disabled / focus-visible) × 2 sizes,
plus the icon form.

- **People**: see what exists and what it looks like on one page, without reading
  the CSS.
- **AI**: a surface that can be screenshotted. It was a CDP screenshot this very
  round that turned up the padding miscalculated in the design document (written
  as 25.4px, measured 23.9px). **Without a gallery, an agent never sees its own
  output.**

The entry point hangs under the settings panel's About category and only under
`import.meta.env.DEV`; it does not enter the production build.

### 2.8 Enforcement: nine assertions

Written in `renderer/ui/__tests__/control-spec.test.ts`. Every failure message
must say **what to do next** (Axiom 3) — not `assertion failed`, but an actionable
instruction.

| # | assertion | what it prevents |
|---|---|---|
| 1 | every variant × every state has a rule in `controls.css` | adding half a variant |
| 2 | every variant's `intent` is non-empty | sliding back to naming by appearance |
| 3 | the `btn-*` namespace holds no class the spec does not know | privately inventing a variant inside the control layer |
| 4 | for every variant, hover is brightest and active is darker than hover | a press with no feedback (see below) |
| 5 | the `className` passed to `<Button>` declares layout properties only | the escape hatch reopening |
| 6 | `action` ids are globally unique and match `domain.verb` | colliding handles, and layer B later addressing the wrong object |
| 7 | `exposure="agent-ok"` requires an `action` | exposing something that has no name |
| 8 | every button inside a permission prompt is `human-only` | an agent approving its own permission request |
| 9 | a bare `<button>` may appear only in the files the allowlist names, and the allowlist has no stale entries | the migration going backwards |

Item 4 was not in the original plan; it was **caught by a screenshot during
implementation**: `controls.css` says "hover brightens, press darkens", and the
first two variants I wrote under it (`danger` / `caution`) both mixed **more** of
the accent colour into the pressed state, so active came out brighter than hover
and `caution`'s active smeared into olive green.

A rule that holds only because somebody happened to look is precisely what this
layer exists to eliminate. So it became an assertion: the test parses
`color-mix(in srgb, var(--a) N%, var(--b))`, looks up `:root`, and computes
luminance. **What a screenshot can find, CI should be able to find.**

(It does not assert that active is darker than rest: on a dark ground, mixing in
red or amber naturally leaves the pressed state slightly brighter, and that degree
of freedom is reasonable. What actually decides whether a press "feels pressed" is
hover > active.)

**Plus three assertions testing the test itself.** All nine above depend on one
JSX scanner, and it shipped with a hole: **tag-name matching runs on the raw
source, and the comment state machine only starts after the match** — so a
`<button>` written in prose is treated as a real element. `PanelTabs.tsx:188` has
exactly such a sentence (explaining why a tab is a `div` and not a `button`).
Three consequences, the heaviest being: item 8's permission tripwire, the one that
went out of its way to say "do not delete this test to make it pass", **can be
satisfied by a comment that mentions `<Button>`**, after which the `exposure`
check iterates over comment text and passes trivially.

The fix is to blank out comments and string bodies before searching (the slices
still come from the original text, or every attribute value turns into spaces —
the second pit stepped into while fixing the first). **Writing tests for the
checker itself is not ceremony**; it is the difference between a boundary and the
appearance of one.

Three extensions to existing tests, as well: `type-scale.test.ts` already forbids
inline `fontSize`, and this round brings `controls.css` into its scan;
`theme-contrast.test.ts` gains a 3:1 assertion for `--danger-border`, plus **a ban
on any border colour written as a literal** — because `#7a3f3f` survived precisely
by "not being a token, so the tests cannot see it".

Item 7's allowlist is the concrete form of the migration: an array of strings
listing the files not yet migrated. It can only get shorter. This is the standard
practice from a TypeScript strict migration, and the price is that it cannot
mechanically prevent "a new file being added to the list" — that one relies on
people, is stated in the documentation, and is not pretended to be automated.

The rule "at most one primary per container" did **not** make it into the test
set: static analysis cannot decide "the same container" (conditional rendering,
loops and cross-component composition all mislead it). It is written into the
`primary` variant's `rule` field and enforced by the gallery and by review.
**Automate what can be automated, and say plainly what cannot** — pretending to
cover something is worse than not covering it.

### 2.9 Migration strategy

**First batch (this round, 8 files)**:
- landing the `ui/` layer: `spec.ts` / `Button.tsx` / `controls.css` /
  `Gallery.tsx` / `CLAUDE.md`
- the three reds unified → `danger`; `chat-perm-always` → `caution`; `#7a3f3f`
  gone
- call sites migrated: `ConfirmPair`, `PermissionPrompt`, `Composer`, `ChatView`
  (`ModeConfirm` only), `Toasts`, `App`, `FirstRunGuide`, `ValueModal`,
  `SelectionActionBar`
- the other 24 files go into the allowlist

**`StatusBar` was in the plan and backed out during execution**: both of its
buttons are `ghost seg`, and `.seg` carries `border-radius` — that is painting,
not layout, and **§2.5's fence blocked it**. This is the fence working as
intended: `.seg` is part of a mutually exclusive selection group, and what is
needed is a `<Segmented>` rather than a button variant. Loosening the fence on the
spec's first day in order to migrate one more file is the worse trade. It goes
into the allowlist and waits for the next batch.

**Later batches** (all completed, on 2026-08-02):
1. ✅ the `<Segmented>` primitive, see
   [`2026-08-02-segmented-control.md`](2026-08-02-segmented-control.md)
2. ✅ the other 20 files, 60 bare `<button>`s in total
3. `<Field>` (17 form elements) and `<Dialog>` (the modal shell) — still not done,
   see the last part of §2.9.1

### 2.9.1 After the migration: the ledger's premise is wrong

The ledger's premise is that "every `<button>` should eventually become a
`<Button>`". After migrating 80 of them, **that premise is proved false**.

The remaining 5 are **a different kind of thing**: menu items (two context menus,
one attachment dropdown), disclosure headers (the tool-call card, the thought
block), and one `role="tab"`. What they need is a button's **semantics**
(focusable, triggered by Enter/Space, read as pressable), and nothing at all from
the control layer — they would have to override every single declaration `.btn`
makes. Forcing them into `<Button>` is not migration, it is a fight.

So the ledger splits in two:

| list | meaning | check |
|---|---|---|
| `MIGRATION_LEDGER` | to be migrated, shrinks only | no stale entries |
| `NOT_CONTROLS` | **deliberately** not controls, each entry must carry a reason | reason non-empty + **the element count must match the declaration** |

The count is what makes a file-granularity exemption tenable: without it, a file
waved through because "it has two menu items" would silently absorb a third, real
control.

`MIGRATION_LEDGER` is now down to 1 file (`TreeView.tsx`), and stuck for a reason
outside this change — it contains somebody else's uncommitted work, and migrating
a file someone is editing trades a clean ledger for a merge conflict.

**The next batch of primitives** (`<Menu>`, `<Disclosure>`, `<Field>`,
`<Dialog>`) now has use cases that are **counted rather than guessed**: 3 menu
items, 2 disclosure headers, 17 form elements, 4 modals.

### 2.10 File list

```
apps/desktop/src/renderer/ui/
├─ CLAUDE.md            # the spec introducing itself: every failure message points here
├─ spec.ts              # the single source of truth (as const)
├─ Button.tsx           # the one button primitive
├─ controls.css         # the full variant × state matrix
├─ Gallery.tsx          # the dev-only gallery
└─ __tests__/control-spec.test.ts
```

`ui/CLAUDE.md` is not optional: a coding agent's context is single-use, and Claude
Code loads a subdirectory's `CLAUDE.md` automatically. **The spec has to be able
to introduce itself**, and every path that hits a wall (a compile error, a test
failure) has to point back at it.

---

## 3. Trade-offs

### 3.1 Why no shadcn / Radix / any button library

> **2026-08-04 update**: the four conclusions in this section about shadcn /
> Radix / CVA **all still hold**. But the judgement about Tailwind at the end has
> been overturned — the renderer has migrated to Tailwind v4, see
> `2026-08-04-tailwind-migration.md`. That document does not rebut the sentence
> below; it prices it: the decisions really did scatter into JSX, and the cost was
> pushed down to something acceptable by `--color-*: initial` (the vocabulary is
> still a closed set) and by an equivalent rewrite of three contract tests.
> `spec.ts` is still the single source of truth, and `<Button>` is still the one
> point of convergence.

The conclusion was given last round; archiving it here:

| reason | detail |
|---|---|
| **Density does not match** | shadcn's button is `h-9` (36px), peek's row height is 24px and its status bar 26px. Taking it down to 24px means rewriting every one of its components, at which point writing our own is cheaper |
| **Size** | the renderer's output is already 557KB, past vite's 500KB warning line; PLAN §8 has a performance red line |
| **It does not plug in** | Radix's value is focus management and ARIA primitives, but peek's focus model is bound to the Workspace state tree via `PanelTabs` / `usePanelFocus`, and Radix's machinery would fight it |
| **Opposite direction** | pulling in a library adds a dependency; what is missing is **a point of convergence**, not a dependency. Adding a library will not make 87 call sites converge on their own |

And atomic classes of the Tailwind sort would scatter every decision in this
document out of the CSS and into the JSX — exactly the opposite of the problem
being solved here.

### 3.2 Why not CVA / tailwind-variants and the like

What they solve is "mapping a variant to a class string", and the hard part here
is not the mapping, it is **making the spec discoverable by AI and enforceable by
CI**. Those 40 lines of `as const` in `spec.ts` do the mapping already, and adding
a package only moves the source of truth somewhere else.

### 3.3 Why no code generation (spec → CSS)

Played out in my head: generating `controls.css` from `spec.ts` would guarantee
the two never drift, but it means either adding a build step or stuffing the CSS
into JS (injected at run time, inconsistent with CSP and with the four existing
stylesheets). Instead there is **a contract test** (§2.8 item 1): the two files
may each be hand-written, but one missing cell turns it red. Same benefit, cost an
order of magnitude smaller.

### 3.4 Why `exposure` defaults to `human-only` rather than `agent-ok`

The other side is tempting: default to `agent-ok` and, when the MCP tools are
built, "everything already works". But that means anybody adding a new button has
handed it to the agent by default — including permission approval, including
deletion. The price of a safe default is having to annotate a batch of controls
explicitly later, and that is the right price.

### 3.5 Why "at most one primary per container" gets no test

See the end of §2.8. If a reliable static assertion cannot be written, do not
write a fake one.

### 3.6 Why `caution` is kept rather than folded into `danger`

Four variants are cleaner than five. But `chat-perm-always`'s visuals (a `--warn`
dashed border) already differ from `danger`'s (`--err` solid border), and the
semantics really do differ — "grant permanently" destroys nothing, "delete"
destroys something. Merging the two would force out an orthogonal prop along the
lines of `tone`, and that is where the combinatorial explosion starts.

---

## 4. Verification

What follows is **results already obtained**, not a to-do list.

**Automated**:
1. ✅ §2.8's nine assertions all green (`control-spec.test.ts`, 20 tests).
2. ✅ **All 1,225 tests in the desktop package pass**, no regressions. The
   permission tests in `chat.test.ts` that asserted on class names now assert on
   variants, which is semantically stronger than before.
3. ✅ `type-scale.test.ts` still green after taking `controls.css` into its scan;
   the two additions to `theme-contrast.test.ts` (`--danger-border` ≥ 3:1, no
   literal border colours) green.
4. ✅ `pnpm typecheck` across six packages; `pnpm build` passes, renderer output
   **558.23 kB** (+1.2 kB — the gallery is stripped by `import.meta.env.DEV` and
   does not enter the production bundle).
5. ⚠️ `pnpm -r test` has 8 failures on `db-postgres` and stops the later packages
   — this is the pre-existing problem already recorded in PLAN §11.2 (the test
   suite does not stand up its own database, `PEEK_TEST_PG_URL` is missing), **not
   a regression from this round**. The desktop package was run on its own.

**Measured over CDP** (build output plus real Electron, injecting the matrix into
a real page):

6. ✅ All 5 variants × 5 states render, no empty cells. hover / active /
   focus-visible were forced with `CSS.forcePseudoState` — a programmatic
   `.focus()` does not trigger `:focus-visible`, which is why the first
   measurement read `outline: none`, not a missing rule.
7. ✅ Geometry: `md` text button 25.4px (≥ the 24 floor), `md` icon 24×24, `sm`
   20px, `sm` icon 20×20.
8. ✅ Colour: `danger` border `rgb(178,94,89)` = `#b25e59` = `--danger-border`;
   text `rgb(240,115,111)` = `--err`; `caution` measured `border-style: dashed`.
9. ✅ Focus ring: all five variants `rgb(77,156,255) solid 2px`. This is the state
   added this round — before it, `button` had no `:focus-visible` rule at all, and
   all 87 controls gave no feedback when Tab landed on them.
10. ❌→✅ A screenshot found that `danger` / `caution` had an active brighter than
    hover, and `caution`'s active smeared into olive green. Fixed (the pressed
    state now mixes up from `--bg-1`), and backfilled as §2.8's item 4 assertion.

**For a person, an agent cannot**:
11. Test the `icon` buttons' `aria-label` with VoiceOver. PLAN §11.2 already
    records this debt, and this round adds `data-peek-action` on top; the debt only
    grows, and the books say so.
12. The **feel** of hover / active. CDP can prove the luminance relation between
    the three states is right; it cannot prove that pressing it feels good.

---

## 5. Relationship to existing documents

| document | relationship |
|---|---|
| [`2026-08-02-ui-legibility-baseline.md`](2026-08-02-ui-legibility-baseline.md) §2.3 | **extends**. The four `min-height: 0` exemptions are promoted into the `sm` step |
| the same, `.confirm-danger` | **overturns**. Absorbed by the `danger` variant (it was added the same day, and was annexed by its own spec in under a day — see §1.3) |
| `PLAN.md` §1 "people and AI go through the same command channel" | **extends**. The channel reaches from the Command Bus to the controls' **naming and visibility**, but not to execution (§1.6 item 2) |
| `PLAN.md` §2 tech-stack table | **adds a row**: the control layer is in-house with no dependency, reasoning pointing at §3.1 |
| `PLAN.md` §11.2 | **adds to the books**: the migration allowlist is explicit technical debt; the a11y debt grows by `data-peek-action` |
