/* ==================================================================
 * The control spec — one source of truth, four consumers.
 *
 *                     ┌─ TypeScript types ──→ a coding agent (wrong = won't compile)
 *   this file ────────┼─ contract test ─────→ rendering (a missing state = red CI)
 *   (`as const`)      ├─ the gallery ───────→ humans (see it) / agents (screenshot it)
 *                     └─ DOM attributes ───→ runtime (a11y today, MCP later)
 *
 * Why a data structure and not a paragraph in a design doc: a person can read a
 * convention once and remember it. An agent cannot — its context is one-shot, so
 * it does not recall the rules, it searches for them. **A spec that cannot be
 * grepped to a definite answer does not exist.** Prose also drifts from the code;
 * a `const` that generates the types cannot.
 *
 * The naming rule that makes this work for all three readers: **name by intent,
 * never by appearance**. A human can infer intent from pixels and a stylesheet
 * can encode it in a class name, but an agent sees neither. Intent — "this act
 * is destructive" — is the only vocabulary all three share, and it is also the
 * only one derivable from a task description.
 *
 * ---- What the Tailwind migration moved into this file -------------------
 *
 * A variant used to be a name (`btn-danger`) whose twenty lines of rules lived
 * in `ui/controls.css`. It is a string of utility classes now, and the
 * stylesheet is gone. The spec did not gain a responsibility so much as stop
 * delegating one: it already said what every variant *meant*, and it now also
 * says what every variant *is*.
 *
 * Two rules govern every string below, and both are load-bearing rather than
 * stylistic:
 *
 *  1. **No arbitrary values.** A raw hex hung off a `bg` prefix inside square
 *     brackets compiles, paints, and is invisible to `theme-contrast.test.ts` —
 *     the 2026-08-02 story retold one namespace over. Every colour here is a
 *     `--color-*` token, and a value with no token is a line in `theme.css`, not
 *     a bracket here. There is a test.
 *
 *     That sentence used to spell the class out, in backticks, as an example.
 *     **It shipped.** Tailwind's scanner reads raw bytes and has no concept of a
 *     comment, so this paragraph compiled a real rule painting the exact 1.91:1
 *     red the whole story is about, straight into `index.css`, on a green
 *     suite — the sentence made itself true. It is written the long way round on
 *     purpose; putting the token back is the failure, not a tidy-up, and the ban
 *     in `theme-contrast.test.ts` now reads this file the way Tailwind does and
 *     will say so.
 *
 *  2. **Never two classes from the same utility family in one control's
 *     string.** A class list has no cascade: `bg-bg-2 bg-bg-3` is decided by
 *     wherever Tailwind happened to emit the two rules, not by the order they
 *     are written in. Checked, not assumed — Tailwind emits `border-accent`
 *     *before* `border-border-strong`, so a selected segmented option written
 *     the obvious way would have worn the unselected border. That is why
 *     `surface` is split out of a variant's `classes` (so `elevated` can replace
 *     it rather than fight it) and why each size rung states a whole shape.
 *
 * Design records: docs/design/2026-08-02-control-spec.md
 *                 docs/design/2026-08-04-tailwind-migration.md §2.3
 * ================================================================== */

/* ------------------------------------------------------------------
 * Variants
 * ------------------------------------------------------------------ */

/**
 * The complete set of button meanings. Adding a member here is the *only* way
 * to add a button style — see `ui/CLAUDE.md` for the change protocol.
 *
 * `intent` is not decoration. It is the field an agent reads to choose, and
 * `control-spec.test.ts` asserts it is non-empty, because a variant without a
 * stated intent has quietly gone back to being named after its colour.
 *
 * `rule` is a constraint that cannot be expressed in the type system. Where one
 * can be checked mechanically the test does it; where it cannot, the rule says
 * so here and is enforced by review. Pretending to cover a rule is worse than
 * admitting it is uncovered.
 *
 * `classes` and `surface` are the variant's paint, split at exactly one seam:
 *
 * - `surface` is the background across all three pointer states. `elevated`
 *   replaces it wholesale, which is the entire reason it is a separate field —
 *   an atomic class cannot be overridden by a later atomic class.
 * - `classes` is everything else the variant owns: its border and its text, in
 *   whichever states it moves them.
 *
 * Colour is restated per variant, including for `default` where it repeats the
 * bare-element floor in `base.css`. Two redundant classes are worth a uniform
 * matrix: the variant layer owns colour completely, so the contract test needs
 * no exceptions — and an exception in a completeness test is where the next
 * missing state hides.
 *
 * ## Adding one costs more than a row
 *
 * A new member also creates a pair with every variant already here, and each of
 * those pairs is a claim that somebody who does not see the difference between
 * two colours can still tell the two controls apart. `control-spec.test.ts`
 * keeps that census and will refuse a pair nobody has classified. Three pairs
 * carry a written debt there today because nothing but their colour separates
 * them; read those before adding a fourth.
 */
export const BUTTON_VARIANTS = {
  primary: {
    intent: 'The one action this view exists for — submitting a form, confirming a dialog.',
    rule: 'At most one per visual container. Not checked mechanically: static analysis cannot tell what "one container" means across conditionals, loops and composition.',
    /* `text-on-accent`, not `text-fg`: the label sits on a solid accent, which is
       a different question from "the window's foreground" and only had the same
       answer while there was one theme. See --color-on-accent in styles.css. */
    classes: 'border-accent text-on-accent',
    surface: 'bg-accent-dim hover:not-disabled:bg-primary-hover active:not-disabled:bg-primary-active',
  },
  default: {
    intent: 'A real action, but not the one the view is about.',
    rule: null,
    classes: 'border-border-strong text-fg',
    /* Press states darken while hover lightens, so the two are never confusable
       and a press is felt as a press. peek had no `:active` at all before the
       control layer: clicking a button produced no acknowledgement whatsoever,
       which is a large part of why the interface read cheap next to native
       controls. Every `surface` below moves the same way, and there is a test. */
    surface: 'bg-bg-2 hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-1',
  },
  ghost: {
    intent: 'An action that must not compete for attention — toolbar icons, per-row affordances, dismissals.',
    rule: null,
    classes: 'border-transparent text-fg-dim hover:not-disabled:text-fg active:not-disabled:text-fg',
    surface: 'bg-transparent hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-1',
  },
  danger: {
    intent: 'Destructive or irreversible — deleting, disconnecting, rejecting a request.',
    rule: 'Never the default focus target. When the act cannot be undone, wrap it in ConfirmPair so the second click lands somewhere harmless.',
    /*
     * This variant replaced three independent implementations: `.confirm-danger`,
     * `.chat-perm-reject` (byte-for-byte identical to it) and `.chat-stop`. All
     * three used a hard-coded `#7a3f3f` border, which measured **1.91:1** against
     * `--color-bg-2` — against a documented 3:1 floor for control boundaries.
     * They passed review for months because a literal hex is invisible to
     * `theme-contrast.test.ts`, which only ever sees the token block. Hence
     * `--color-danger-border`, which that test now audits like every other token.
     */
    classes: 'border-danger-border text-err hover:not-disabled:border-err active:not-disabled:border-err',
    surface: 'bg-bg-2 hover:not-disabled:bg-danger-hover active:not-disabled:bg-danger-active',
  },
  caution: {
    intent:
      'Not destructive, but the consequence outlives this moment — granting a standing permission, entering a permissive mode.',
    rule: 'Distinct from `danger` on purpose: granting a permission destroys nothing, it just stops asking. Merging the two would force an orthogonal `tone` prop, which is where combinatorial explosion starts.',
    /*
     * A broken edge rather than an unbroken one, because this variant must be
     * distinguishable from `danger` **without relying on hue**: red against
     * amber is one of the two pairs a red-green colour-blind user cannot
     * separate, and the two sit side by side in the same permission prompt —
     * Reject next to "Allow always". Rendered in Electron against the built
     * stylesheet and put through a deuteranopia matrix: the two collapse to the
     * same olive-yellow, at which point the edge is the only thing left telling
     * them apart. In plain greyscale the edge is the *first* thing you see.
     *
     * Deleting this class used to be free — every renderer test stayed green,
     * because the sentence above was the whole enforcement. `control-spec.test.ts`
     * now records, for every pair of variants, which hue-free channel keeps that
     * pair apart, and this pair has exactly one: the edge's shape.
     *
     * What it asserts is the **distinction**, never this class. Making `danger`
     * broken-edged as well fails it just as loudly, and a rule phrased as "the
     * caution variant is broken-edged" would have waved that through with the
     * two variants once again identical.
     */
    classes: 'border-warn border-dashed text-warn',
    surface: 'bg-bg-2 hover:not-disabled:bg-caution-hover active:not-disabled:bg-caution-active',
  },
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANTS

export const BUTTON_VARIANT_NAMES = Object.keys(BUTTON_VARIANTS) as readonly ButtonVariant[]

/** Everything a variant paints, in one string — what the contract test reads. */
export function variantClasses(variant: ButtonVariant): string {
  const { classes, surface } = BUTTON_VARIANTS[variant]
  return `${classes} ${surface}`
}

/* ------------------------------------------------------------------
 * Menu item tones
 * ------------------------------------------------------------------ */

/**
 * What a *menu item* can mean. Two values, and deliberately not `ButtonVariant`.
 *
 * A menu item has no background and no border at rest — it is a full-width line
 * of text in a popup. Three of the five button variants (`primary`, `ghost`,
 * `default`) would therefore render as the same pixels, and an enum whose
 * members are indistinguishable is an enum that lies. `caution` has no menu case
 * either: the standing-consequence acts peek has all live behind the disclosure
 * dialog, not behind a menu line.
 *
 * What survives the translation is the one distinction that still changes what
 * the user sees and how careful they should be — destructive or not.
 *
 * No `surface` split here: `elevated` is a button modifier and a popup is
 * already elevated by being a popup, so nothing ever replaces a tone's
 * background and the seam would buy nothing.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md §2.2
 */
export const MENU_TONES = {
  default: {
    intent: 'An ordinary act. Everything that is not the one below.',
    classes: 'bg-transparent text-fg hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-1',
    noteClasses: 'text-fg-faint',
  },
  danger: {
    intent: 'Destructive or irreversible — closing, deleting, forgetting.',
    rule: 'Never the first item, and never the one the arrow keys land on first. When the act cannot be undone, give the item a `confirm` label so the second press lands on Cancel.',
    classes: 'bg-transparent text-err hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-1',
    /* A note that explains why something is missing or refused reads as a
       warning, not as an error that already happened. */
    noteClasses: 'text-warn',
  },
} as const

export type MenuTone = keyof typeof MENU_TONES

export const MENU_TONE_NAMES = Object.keys(MENU_TONES) as readonly MenuTone[]

/**
 * The line itself, before its tone.
 *
 * A menu item is a real `<button>`, so most of this is undoing the bare-element
 * floor in `base.css`: a menu line is full-width, left-aligned, and has neither
 * a background nor a border at rest. That undoing is the reason these are not
 * `<Button>`s — see `ui/CLAUDE.md`'s NOT_CONTROLS note, which predicted it.
 *
 * The ring is inset by 1px rather than offset outward like a button's: a menu
 * line spans the popup's full width, and a ring outside it would be clipped by
 * the popup's own padding. The arrow keys move real focus between these lines,
 * so without it the menu is unusable without a pointer.
 */
/*
 * `flex`, not `block`: an item that can carry a tick has two cells, and the tick
 * column is reserved on *every* item of such a menu so the labels line up. The
 * shape it replaced padded the unticked items with three spaces, which lines up
 * in a monospaced font and in nothing else — this menu is set in the UI face.
 */
export const MENU_ITEM_BASE =
  'flex items-center gap-tight w-full min-h-0 px-snug py-tight border-0 rounded-control text-left cursor-pointer ' +
  'disabled:opacity-45 disabled:cursor-default ' +
  'focus-visible:outline-1 focus-visible:outline-accent focus-visible:-outline-offset-1'

/* ------------------------------------------------------------------
 * Sizes
 * ------------------------------------------------------------------ */

/**
 * The control layer's size rungs — shared by every primitive, not just buttons.
 *
 * Named for controls rather than for buttons because `<Segmented>` uses the same
 * two, and calling them "button sizes" would force the next primitive either to
 * restate them or to alias them. Two names for one thing is the failure this
 * whole spec exists to prevent. Since the migration the two primitives do not
 * merely share the rungs, they share the very strings.
 *
 * Two rungs, not three. A third rung would be one more choice for a caller to
 * get wrong, and choosing is exactly what an agent does badly. These two are
 * the rungs the codebase already had — `--spacing-hit` from the legibility baseline,
 * and the 20px that four separate rules had each reinvented with their own
 * `min-height: 0` exemption. `--spacing-control-sm` is that 20px, named.
 *
 * A rung states a whole *shape*, padding included, and states the icon shape
 * separately rather than layering a `p-0` over it. Two padding utilities in one
 * class list resolve in Tailwind's emission order, and its order puts `px-*`
 * after `p-*`: an icon button written the layered way would have kept the text
 * button's 9px of side padding and come out oblong. Duplicating a height across
 * the two fields is the cheap half of that trade.
 */
export const CONTROL_SIZES = {
  md: {
    px: 24,
    intent: 'The default. Every standalone button.',
    /*
     * 24px is **computed**, not caught by `min-h-hit`.
     *
     * --leading-ui(18) + 2×--spacing-control-y(2) + 2×1px border = 24. It is a
     * spec only when both sides of that equation hold: `<input>` and `<select>`
     * run the same arithmetic in `@layer base`, so all three stand the same
     * height by construction rather than each landing somewhere nearby and
     * being planed flat by the floor.
     *
     * This replaced the previous version's patch, the one that pinned the line
     * box (the class is not written out here — Tailwind's scanner reads
     * comments, so spelling it would compile a live rule no element wears and
     * the build audit would stop it on the spot; this is the seventh time in
     * this repository). It was a patch: it crushed the line box to 12px, which
     * dropped the content below the floor, and then let `min-h-hit` push the
     * box back out to 24 — the number was right, but the answer to "why is a
     * button 24px" had become "because the floor is 24", and `<input>` does not
     * take that floor, so the same form carried button 24 / input 28.3, a
     * spread of 4.3px (§30.2). The arithmetic is the same on both sides now,
     * and the spread is 0 by construction.
     *
     * `min-h-hit` stays, but it really is only a **floor** now: in the 11px
     * status bar the content height falls to 22px, and that is when it acts.
     *
     * **`leading-ui` has to be stated by the rung itself, for the same reason
     * `sm` states its own type size.** Left unstated, the line box is
     * inherited, and the very same "24px button" measured 26px in the consent
     * dialog — that dialog is `leading-prose`(20px), and 20+4+2=26. A size
     * that depends on which rung it lands in is not a rung, and that is the
     * previous version's `px: 24` — which said 24 and rendered 25.4 — the same
     * fault through another door.
     */
    classes: 'min-h-hit px-control-x py-control-y gap-tight leading-ui',
    iconClasses: 'min-h-hit w-hit p-0 gap-0 leading-ui',
  },
  sm: {
    px: 20,
    intent:
      'Inline inside a compact strip — a 24px row, a 30px tab bar, a chip. Below the hit floor on purpose, and only because the strip itself sets the ceiling.',
    /*
     * The small rung belongs to the size, not to the caller.
     *
     * Every site that reached for this height also restated the small type size
     * next to it — `.md-copy`, `.chat-attach-add`, `.tab-close`,
     * `.chat-thought-head`. That is the same discovery the height itself
     * produced: four rules each restating one fact is what a missing rung looks
     * like. A 20px control set in the body size was never what any of them
     * wanted.
     *
     * The rung it names moved with the scale (§29.10.2) — it was 11px and is
     * 12px now, on an unchanged 20px box. `h-control-sm` is a fixed height
     * rather than a floor, which is why this rung absorbed the change and `md`
     * above, which floors at `min-h-hit` and grows, did not.
     */
    classes: 'min-h-0 h-control-sm px-control-x py-0 gap-tight text-micro leading-ui',
    iconClasses: 'min-h-0 h-control-sm w-control-sm p-0 gap-0 text-micro leading-ui',
  },
} as const

export type ControlSize = keyof typeof CONTROL_SIZES

export const CONTROL_SIZE_NAMES = Object.keys(CONTROL_SIZES) as readonly ControlSize[]

/**
 * How big an icon is, per control rung.
 *
 * Keyed by `ControlSize` on purpose: an icon inside a `sm` button is the `sm`
 * icon, and nobody has to decide that twice. `<Button>` passes its own rung
 * down, so a call site writes a name and nothing else.
 *
 * The numbers are derived from the box, not picked. A 24px icon button minus
 * two 1px strokes leaves 22px of interior; 14px fills about 58% of the button's
 * width, which is the ordinary density for a stroked icon in a square control —
 * bigger crowds the edge, smaller floats as a dot in a box it does not fill.
 * The 20px rung takes the same proportion down to 12.
 *
 * **These ship as element attributes, never as classes.** A Tailwind size class
 * would compile to a real rule, and `audit-shipped-css.mjs` holds every shipped
 * rule to having a wearer. Sizing through `width`/`height` keeps the icon layer
 * out of the stylesheet's ledger entirely — it adds not one line to it.
 *
 * Design record: docs/design/2026-08-15-icon-set.md
 */
export const ICON_SIZES: Record<ControlSize, number> = {
  md: 14,
  sm: 12,
}

/* ------------------------------------------------------------------
 * States
 * ------------------------------------------------------------------ */

/**
 * The five states every control owes the user. Before this spec, `button` in
 * the global stylesheet defined two of them — hover and disabled. There was no
 * `:active` (press it and nothing acknowledges the press) and no
 * `:focus-visible` at all (tab to it and it vanishes), which is a large part of
 * why the UI read cheap.
 *
 * `variant` is the Tailwind prefix a class must carry to speak for that state.
 * It used to be a CSS selector suffix (`:hover:not(:disabled)`) that the
 * contract test looked for in `controls.css`; the strings the test reads are
 * class lists now, so the same fact is written the way those lists write it.
 * `hover:not-disabled:` compiles to exactly the old `:hover:not(:disabled)`.
 *
 * `perVariant` is the contract:
 *
 * - `true`  — the state carries the variant's colour identity, so each variant
 *             must define it. A `danger` button that falls back to the base grey
 *             hover has stopped being a danger button mid-gesture.
 * - `false` — the state is variant-independent (an opacity, an accent ring), so
 *             one declaration on the base covers every variant and five copies
 *             would be worse than one.
 */
export const CONTROL_STATES = {
  rest: { variant: '', perVariant: true },
  hover: { variant: 'hover:not-disabled:', perVariant: true },
  active: { variant: 'active:not-disabled:', perVariant: true },
  disabled: { variant: 'disabled:', perVariant: false },
  'focus-visible': { variant: 'focus-visible:', perVariant: false },
} as const

export type ControlState = keyof typeof CONTROL_STATES

export const CONTROL_STATE_NAMES = Object.keys(CONTROL_STATES) as readonly ControlState[]

/* ------------------------------------------------------------------
 * Runtime handles — the part that is reserved, not built
 * ------------------------------------------------------------------ */

/**
 * Who may operate a control.
 *
 * peek's whole premise (PLAN §1) is that people and agents drive the same
 * interface through the same channel. That channel currently stops at the
 * Command Bus. If it is ever extended to controls, this is the field that says
 * which ones — and the default has to be the safe one, because agents use
 * defaults far more than people do.
 *
 * The concrete case that fixes the default: the chat panel asks a human to
 * approve an agent's permission request. **If MCP could ever click buttons, the
 * first button it must not reach is "Allow".** An agent that can approve its own
 * permission requests has no permission system. So the boundary is written down
 * and tested now, long before anything reads it.
 *
 * Nothing consumes these attributes yet. That is deliberate: a reserved
 * interface with the boundary already decided beats half a feature.
 */
export const EXPOSURES = {
  'human-only': {
    intent: 'A person decides this. The default, and the default is the safe one on purpose.',
  },
  'agent-ok': {
    intent:
      "Safe for an agent to trigger on the user's behalf. Requires an `action` id — you cannot address what has no name.",
  },
} as const

export type Exposure = keyof typeof EXPOSURES

export const DEFAULT_EXPOSURE: Exposure = 'human-only'

/**
 * A stable semantic handle, in the Command Bus's `domain.verb` shape (PLAN §6)
 * so that the two vocabularies never have to be reconciled later.
 *
 * Three uses, in order of certainty: a test selector that survives i18n today;
 * an a11y fallback for icon-only buttons today; the address an MCP tool would
 * use tomorrow.
 *
 * ## The rule the pattern cannot enforce
 *
 * **An id names what the control actually triggers.** The regex checks shape; it
 * cannot check truth, and the difference is not academic — `FirstRunGuide`'s
 * connect button shipped as `action="conn.open"`, which is a real command it does
 * not dispatch. What it does is open a form; the form sends `conn.open` later, if
 * the user finishes. It is `connectDialog.open` now.
 *
 * Borrowing a real command name for a control that does not send it is worse than
 * inventing one, because the borrowed name reads as verified. Nothing can catch
 * it statically — no analysis follows a callback to whatever it eventually
 * reaches — so it is stated here and left to review, per the same principle as
 * the one-primary-per-container rule. Membership in `COMMAND_NAMES` would not
 * help: it would have accepted `conn.open` on that very button while rejecting
 * honest local names like `settings.open`.
 */
export const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

/* ------------------------------------------------------------------
 * The classes themselves — what used to be `ui/controls.css`
 * ------------------------------------------------------------------ */

/**
 * Everything a button is before it has a meaning or a size.
 *
 * This layer did not exist before the migration, and its absence was the whole
 * subtlety of the old arrangement: `.btn` added four declarations and inherited
 * the rest from the bare `button` element rule, which is what made adopting
 * `<Button>` visually free. Utilities cannot inherit that way — `@layer base`
 * loses to `@layer utilities` by design, and that is the mechanism the whole
 * control layer now rides on — so the geometry is stated here instead of being
 * borrowed. `base.css` keeps its copy as the floor for the bare `<button>`s that
 * are deliberately outside this layer.
 *
 * The two states marked `perVariant: false` live here, once, rather than five
 * times. The focus ring is offset outward by 1px rather than inset like the
 * panel rings: a 20px `sm` button has no room to spare inside its own border,
 * and an inset ring would eat the variant's border colour, which for `danger`
 * and `caution` is carrying meaning.
 *
 * `font` and `color` are absent on purpose — see the head of `base.css`. They
 * are `inherit`, which is a browser-default correction rather than a control
 * decision, and a button in the 11px status bar has to stay 11px.
 */
export const CONTROL_BASE =
  'inline-flex items-center justify-center rounded-control border whitespace-nowrap cursor-pointer ' +
  'disabled:opacity-45 disabled:cursor-default ' +
  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'

/**
 * Orthogonal modifiers — shapes and surfaces that cut across every variant.
 *
 * Separate from `BUTTON_VARIANTS` because they answer a different question.
 * A variant says what the action *means*; these say what the control has to
 * survive — no room for a word, or an unpredictable surface behind it. Folding
 * either into the variant list would double it for a fact that changes no
 * semantics.
 *
 * `icon` carries no classes of its own: an icon button's geometry is a *rung*
 * fact (its width is the rung's height, its padding is nothing), so it is
 * `CONTROL_SIZES[size].iconClasses`. Stating it here as well would put two
 * padding utilities in one class list, which is the one thing these strings must
 * never do.
 */
export const BUTTON_MODIFIERS = {
  icon: {
    intent: 'Square, no words. Requires a `label`, which the type union enforces.',
  },
  elevated: {
    intent:
      'Floats over scrolling content, so it must separate itself from whatever happens to be behind it.',
    /*
     * Replaces the variant's `surface` rather than being layered over it. A
     * lighter shade and a shadow are what separate a control from a transcript
     * scrolling underneath; the variant beneath keeps saying what the action
     * means, which is why the border and the text colour are untouched.
     */
    classes: 'bg-bg-3 shadow-elevated hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-2',
  },
} as const

export const BUTTON_MODIFIER_NAMES = Object.keys(BUTTON_MODIFIERS) as readonly string[]

/**
 * `<Segmented>`, split at the same seam as a button variant and for the same
 * reason: the chosen option repaints both the surface *and* the border, and a
 * class list cannot override a class list.
 *
 * The group is one control, not adjacent buttons — only the outer corners are
 * round, and neighbours share an edge instead of stacking two 1px borders into a
 * 2px seam: every item but the first pulls itself one pixel left with a negative
 * left margin, spelled out in `item` below under a not-first variant. The class
 * is described here rather than named, because prose in this directory compiles
 * — a bare utility name in a comment becomes a rule no element wears, which is
 * what `scripts/audit-shipped-css.mjs` now refuses to ship. The chosen option
 * lifts itself one layer so that its
 * accent border is never clipped by the sibling whose margin overlaps it, and
 * focus lifts one layer further.
 *
 * `focus-visible` matters more here than anywhere else in the window: this is a
 * single tab stop with the arrow keys moving *inside* it, so a keyboard user who
 * cannot see which option has focus cannot use the control at all. The rules
 * this replaced defined neither `:active` nor `:focus-visible`.
 *
 * Size comes from `CONTROL_SIZES` — the same strings a button wears.
 */
export const SEGMENTED = {
  group: 'flex flex-1 gap-0',
  item:
    'flex-1 border rounded-none first:rounded-l-control last:rounded-r-control not-first:-ml-px ' +
    'cursor-pointer whitespace-nowrap ' +
    'disabled:opacity-45 disabled:cursor-default ' +
    'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 ' +
    'focus-visible:relative focus-visible:z-2',
  off: 'bg-bg-2 border-border-strong hover:not-disabled:bg-bg-hover active:not-disabled:bg-bg-1',
  // `text-on-accent` for the same reason as the primary button above: a selected
  // segment is filled with the accent, so its label is ink-on-accent.
  on: 'bg-accent-dim border-accent text-on-accent relative z-1 hover:not-disabled:bg-primary-hover active:not-disabled:bg-primary-active',
} as const

/* ------------------------------------------------------------------
 * The escape hatch, and its fence
 * ------------------------------------------------------------------ */

/**
 * `className` on a Button is for **layout only** — where the control sits, not
 * what it looks like. `.chat-jump` is a legitimately positioned button; a class
 * that repaints one is the spec being routed around.
 *
 * `control-spec.test.ts` classifies every passed class by its prefix and fails
 * on anything that paints, outlines, sets type or sizes the box. The list below
 * is the property-level statement of that same line, and it is still the
 * question asked of the handful of named classes left over from before the
 * migration (`CLASSNAME_LEDGER`), which own real declarations in a stylesheet.
 *
 * ## Why `align-self` but not `align-items`
 *
 * The dividing line is not "is this a layout property" — it is **whose layout**.
 * `align-self`, `justify-self`, `order` and the margins place the control inside
 * whatever contains it, which is the caller's business. `align-items`,
 * `justify-content`, `gap` and `display` arrange the control's *interior*, and
 * `CONTROL_BASE` already sets all four; a class overriding them is not
 * positioning the button, it is arguing with the primitive about what a button
 * is.
 *
 * The design record's §2.5 wrote this list as `align-*` / `justify-*`, which
 * reads as though the whole family were allowed. The wildcard was loose prose,
 * not a decision — the doc has been narrowed to match. Recorded because the
 * mismatch looked, briefly and convincingly, like the code being wrong.
 *
 * (`style` needs no fence — its type is `never`.)
 */
export const LAYOUT_ONLY_PROPERTIES: readonly string[] = [
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'z-index',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-self',
  'justify-self',
  'grid-area',
  'grid-column',
  'grid-row',
  'order',
  'transform',
  /*
   * Whether the surrounding UI reveals a control at all is the caller's
   * business, in exactly the way `position` is — the tab strip keeps its ✕
   * hidden until the tab is hovered so the title beside it never reflows. It
   * hides the whole control without saying anything about what the control looks
   * like when shown, which is the line this list draws.
   *
   * `display` is deliberately *not* here: `CONTROL_BASE` sets `inline-flex`, and
   * overriding that rearranges the control's interior.
   */
  'visibility',
  'width',
  'max-width',
  'min-width',
]
