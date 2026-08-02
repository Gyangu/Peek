/* ==================================================================
 * The control spec — one source of truth, four consumers.
 *
 *                     ┌─ TypeScript types ──→ a coding agent (wrong = won't compile)
 *   this file ────────┼─ CSS contract test ─→ rendering (a missing state = red CI)
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
 * Design record: docs/design/2026-08-02-control-spec.md
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
 */
export const BUTTON_VARIANTS = {
  primary: {
    intent: 'The one action this view exists for — submitting a form, confirming a dialog.',
    rule: 'At most one per visual container. Not checked mechanically: static analysis cannot tell what "one container" means across conditionals, loops and composition.',
  },
  default: {
    intent: 'A real action, but not the one the view is about.',
    rule: null,
  },
  ghost: {
    intent: 'An action that must not compete for attention — toolbar icons, per-row affordances, dismissals.',
    rule: null,
  },
  danger: {
    intent: 'Destructive or irreversible — deleting, disconnecting, rejecting a request.',
    rule: 'Never the default focus target. When the act cannot be undone, wrap it in ConfirmPair so the second click lands somewhere harmless.',
  },
  caution: {
    intent:
      'Not destructive, but the consequence outlives this moment — granting a standing permission, entering a permissive mode.',
    rule: 'Distinct from `danger` on purpose: granting a permission destroys nothing, it just stops asking. Merging the two would force an orthogonal `tone` prop, which is where combinatorial explosion starts.',
  },
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANTS

export const BUTTON_VARIANT_NAMES = Object.keys(BUTTON_VARIANTS) as readonly ButtonVariant[]

/* ------------------------------------------------------------------
 * Sizes
 * ------------------------------------------------------------------ */

/**
 * The control layer's size rungs — shared by every primitive, not just buttons.
 *
 * Named for controls rather than for buttons because `<Segmented>` uses the same
 * two, and calling them "button sizes" would force the next primitive either to
 * restate them or to alias them. Two names for one thing is the failure this
 * whole spec exists to prevent; the class names differ per primitive
 * (`btn-md`, `seg-md`) but the rungs are one set.
 *
 * Two rungs, not three. A third rung would be one more choice for a caller to
 * get wrong, and choosing is exactly what an agent does badly. These two are
 * the rungs the codebase already had — `--hit-min` from the legibility baseline,
 * and the 20px that four separate rules had each reinvented with their own
 * `min-height: 0` exemption.
 */
export const CONTROL_SIZES = {
  md: {
    px: 24,
    intent: 'The default. Every standalone button.',
  },
  sm: {
    px: 20,
    intent: 'Inline inside a compact strip — a 24px row, a 30px tab bar, a chip. Below the hit floor on purpose, and only because the strip itself sets the ceiling.',
  },
} as const

export type ControlSize = keyof typeof CONTROL_SIZES

export const CONTROL_SIZE_NAMES = Object.keys(CONTROL_SIZES) as readonly ControlSize[]

/* ------------------------------------------------------------------
 * States
 * ------------------------------------------------------------------ */

/**
 * The five states every control owes the user. Before this spec, `button` in
 * styles.css defined two of them — hover and disabled. There was no `:active`
 * (press it and nothing acknowledges the press) and no `:focus-visible` at all
 * (tab to it and it vanishes), which is a large part of why the UI read cheap.
 *
 * `perVariant` is the CSS contract:
 *
 * - `true`  — the state carries the variant's colour identity, so each variant
 *             must define it. A `danger` button that falls back to the base grey
 *             hover has stopped being a danger button mid-gesture.
 * - `false` — the state is variant-independent (an opacity, an accent ring), so
 *             one rule on `.btn` covers every variant and five copies would be
 *             worse than one.
 */
export const CONTROL_STATES = {
  rest: { suffix: '', perVariant: true },
  hover: { suffix: ':hover:not(:disabled)', perVariant: true },
  active: { suffix: ':active:not(:disabled)', perVariant: true },
  disabled: { suffix: ':disabled', perVariant: false },
  'focus-visible': { suffix: ':focus-visible', perVariant: false },
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
    intent: 'Safe for an agent to trigger on the user\'s behalf. Requires an `action` id — you cannot address what has no name.',
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
 * Class names — the single mapping from spec to stylesheet
 * ------------------------------------------------------------------ */

export const BASE_CLASS = 'btn'
export const ICON_CLASS = 'btn-icon'

export function variantClass(variant: ButtonVariant): string {
  return `${BASE_CLASS}-${variant}`
}

export function sizeClass(size: ControlSize): string {
  return `${BASE_CLASS}-${size}`
}

/** The selector `controls.css` must contain for a given variant and state. */
export function stateSelector(variant: ButtonVariant, state: ControlState): string {
  const { suffix, perVariant } = CONTROL_STATES[state]
  return `.${perVariant ? variantClass(variant) : BASE_CLASS}${suffix}`
}

/* ------------------------------------------------------------------
 * The escape hatch, and its fence
 * ------------------------------------------------------------------ */

/**
 * `className` on a Button is for **layout only** — where the control sits, not
 * what it looks like. `.chat-jump` is a legitimately positioned button; a class
 * that repaints one is the spec being routed around.
 *
 * `control-spec.test.ts` looks every passed class up in the stylesheets and
 * asserts its declarations stay inside this list. Anything touching colour,
 * border, type or box size belongs to the spec and fails.
 *
 * ## Why `align-self` but not `align-items`
 *
 * The dividing line is not "is this a layout property" — it is **whose layout**.
 * `align-self`, `justify-self`, `order` and the margins place the control inside
 * whatever contains it, which is the caller's business. `align-items`,
 * `justify-content`, `gap` and `display` arrange the control's *interior*, and
 * `.btn` already sets all four; a class overriding them is not positioning the
 * button, it is arguing with the primitive about what a button is.
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
  'width',
  'max-width',
  'min-width',
]
