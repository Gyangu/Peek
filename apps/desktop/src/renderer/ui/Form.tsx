import type { ReactElement, ReactNode } from 'react'

/* ==================================================================
 * The form vocabulary — a label column, a control column, and the three things
 * that live in the second one without a label of their own.
 *
 * ## What this replaces, and why a component rather than a stylesheet
 *
 * A form row used to be an unwritten recipe: a container element, a leading cell
 * that was a `<label>` or a span depending on whether the control beside it can
 * be labelled at all, the control, and then — as the row's *next sibling* — the
 * explanatory line, wearing the class that indents it back under the control by
 * recomputing the label column's width.
 *
 * Nothing enforced any of it, so it drifted. A row of buttons had two spellings
 * in one dialog: one file wrote the shared name, four others wrote out a
 * five-class layout string that differed from it in both spacing and wrapping.
 * A `<label>` in `McpSection` pointed at a span, which is a promise to a screen
 * reader that nothing keeps — the exact failure `2026-08-04-settings-form-gutter.md`
 * was written about, still present two rounds after that record explained it.
 * Nobody was careless. There was a recipe and no collection point, which is the
 * same diagnosis `Button.tsx` opens with.
 *
 * So the four rules of the recipe are four things the API decides:
 *
 *  - `htmlFor` given → a real `<label>`; omitted → a span. One parameter, and
 *    both answers are correct ones.
 *  - the hint is a prop, or a component — never a sibling that has to be placed.
 *  - the button row is a component, so it has one spelling.
 *  - the tone of a hint is a class, because these rules are in the utilities
 *    layer. See below.
 *
 * ## Two properties that are the reason it looks like this
 *
 * **The row is a fragment.** `Form` is the grid; a row contributes its label and
 * its field cell *directly* to that grid's columns. A wrapper element would have
 * had to be `display: contents` to get out of the way, and a fragment is that
 * with nothing to explain and no a11y footnote to check.
 *
 * That is also what makes the column self-sizing: the grid's first track is
 * `fit-content()` of a ceiling, so a form is as wide as its own longest label.
 * The regime this replaces had one width for the window and a second for the
 * settings pane, which made every local wish a global ruling — the form-gutter
 * record turned down a wider gutter for one wrapping label because twenty other
 * labels would have paid for it.
 *
 * **A hint's colour is a class, not an inline style.** The rules these
 * components carry are `@utility`, so they sit in the utilities layer. The ones
 * they replace were unlayered, and unlayered CSS outranks every `@layer`
 * whatever the specificity on either side — so a colour utility written beside a
 * hint compiled, matched the element, and painted nothing. Four call sites
 * carried an inline `style` to say "amber" or "red" at all, and `McpSection.tsx`
 * predicted in a comment that they would come off when these rules moved into a
 * layer. They did.
 *
 * Design record: docs/design/2026-08-13-settings-form-primitives.md
 * ================================================================== */

/**
 * A two-column form: labels, then everything else.
 *
 * One per form, not one per section — the column sizes itself to the labels
 * *inside this element*, so two `<Form>`s side by side are deliberately allowed
 * to disagree about how wide a label column should be.
 */
export function Form({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={className === undefined ? 'form-grid' : `form-grid ${className}`}>{children}</div>
}

interface FormRowProps {
  /** The label text. Rendered right-aligned in the label column. */
  label: ReactNode
  /**
   * The `id` of the control this row names — and the whole of the decision
   * between a `<label>` and a span.
   *
   * `<label>` is a promise: it names one control and a screen reader follows it
   * there. Give this when the row holds a single form element with that id.
   * Leave it out when the control names itself (`<Segmented>` carries its own
   * `aria-label`) or when the "control" is text, which cannot be labelled at
   * all — three rows in the settings dialog were making the promise anyway
   * before the choice was a parameter.
   */
  htmlFor?: string
  /** The line under the row. Same column as the control, because it is in it. */
  hint?: ReactNode
  children: ReactNode
}

/**
 * One row: a label, and the controls it names.
 *
 * Renders no wrapper of its own — see the header. The children share a flex cell
 * in the control column, so a row may hold a field and a unit suffix, or two
 * fields, with no extra structure.
 */
export function FormRow({ label, htmlFor, hint, children }: FormRowProps): ReactElement {
  return (
    <>
      {htmlFor === undefined ? (
        <span className="text-right text-fg-dim">{label}</span>
      ) : (
        <label htmlFor={htmlFor} className="text-right text-fg-dim">
          {label}
        </label>
      )}
      <div className="form-field">{children}</div>
      {hint === undefined ? null : <FormHint>{hint}</FormHint>}
    </>
  )
}

/**
 * What a hint is saying about the thing above it.
 *
 * Three tones and no more: an explanation, something that outlives this moment,
 * and something that is wrong. Named by what the sentence *is*, never by the
 * colour it comes out as — the rule `ui/spec.ts` opens with, for the same reason.
 */
export type HintTone = 'note' | 'warn' | 'error'

const HINT_TONES = {
  note: 'text-fg-faint',
  warn: 'text-warn',
  error: 'text-err',
} as const satisfies Record<HintTone, string>

/**
 * A line in the control column with no label of its own.
 *
 * Free-standing as well as attached: a section's opening sentence, a save
 * confirmation, and a closing note are all hints that belong to no single row,
 * which is why this exists beside `FormRow`'s `hint` prop rather than only
 * inside it.
 */
export function FormHint({
  tone = 'note',
  className,
  children,
}: {
  tone?: HintTone
  /** Layout only. A tone is a tone; adding a colour here re-opens what §2.4 shut. */
  className?: string
  children: ReactNode
}): ReactElement {
  const classes = ['col-start-2', HINT_TONES[tone]]
  if (className !== undefined && className !== '') classes.push(className)
  return <div className={classes.join(' ')}>{children}</div>
}

/**
 * A row of buttons with no label of its own.
 *
 * It belongs to the control column: a button that falls back into the label
 * gutter reads as if it acts on the section rather than on the field above it.
 * It wraps, because three buttons in the wider of two languages do not always
 * fit on one line.
 */
export function FormActions({ children }: { children: ReactNode }): ReactElement {
  return <div className="col-start-2 flex flex-wrap gap-tight">{children}</div>
}
