import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

import './controls.css'
import {
  BASE_CLASS,
  DEFAULT_EXPOSURE,
  ICON_CLASS,
  sizeClass,
  variantClass,
  type ControlSize,
  type ButtonVariant,
  type Exposure,
} from './spec'

/**
 * The one button in peek.
 *
 * Before this component there were 87 raw `<button>` elements, each assembling
 * its own class string: 49 `ghost`, 10 `primary`, 14 with nothing at all, and
 * eighteen one-off classes that mostly appear exactly once. "Destructive" alone
 * had three independent implementations, two of them byte-for-byte identical,
 * because there was nowhere to look and nowhere to add.
 *
 * What this component is for is therefore not abstraction for its own sake — it
 * is a **collection point**. A rule with no collection point is a comment, and
 * comments get routed around; the `#7a3f3f` border those three red buttons
 * shared measured 1.91:1 against its own background, less than two thirds of the
 * floor the theme had already committed to, precisely because a hard-coded hex
 * is invisible to the test that guards the tokens.
 *
 * Two properties matter more than the API surface:
 *
 * - `style` is typed `never`. The renderer has 56 inline `style={{}}` escapes,
 *   many of them a missing variant being improvised on the spot. Closing the
 *   hatch turns "the spec is not enough" into an explicit change to `spec.ts`
 *   rather than a silent fork.
 * - `className` survives, but only for layout, and a test enforces it (see
 *   `LAYOUT_ONLY_PROPERTIES`). A positioned button is a real need; a repainted
 *   one is the spec being bypassed.
 *
 * Design record: docs/design/2026-08-02-control-spec.md
 */

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'className' | 'type'>

interface ButtonBase extends NativeButtonProps {
  /** What the action *means*, never what it looks like. Defaults to `default`. */
  variant?: ButtonVariant
  /** `md` (24px) unless the control is inline in a compact strip. */
  size?: ControlSize
  /**
   * Layout only — position, margin, flex. Anything that repaints the control
   * belongs in `spec.ts`, and `control-spec.test.ts` will say so.
   */
  className?: string
  /**
   * Deliberately unusable. Typed rather than merely discouraged, because the
   * one thing every drifting design system has in common is a live escape
   * hatch. If you need something this component cannot express, the spec is
   * short of a variant — add it there.
   */
  style?: never
  /** `button` by default: a bare `<button>` inside a `<form>` submits it. */
  type?: 'button' | 'submit'
  /**
   * A stable `domain.verb` handle. Optional today, and it buys three things:
   * a test selector that does not move when the copy is translated, an a11y
   * identity for icon-only controls, and the address an MCP tool would use if
   * peek ever lets an agent operate controls directly.
   */
  action?: string
  /** Who may operate this. Defaults to `human-only`; see `EXPOSURES`. */
  exposure?: Exposure
  ref?: Ref<HTMLButtonElement>
  children?: ReactNode
}

/**
 * An icon-only button must carry a `label`, and a text button must not — the
 * union makes "unlabelled icon button" unrepresentable rather than merely
 * discouraged. It is the single most common a11y regression in a dense toolbar,
 * and the one a screen-reader-less test suite is worst at catching.
 */
type IconShape = { icon: true; label: string } | { icon?: false; label?: never }

export type ButtonProps = ButtonBase & IconShape

export function Button(props: ButtonProps): ReactNode {
  const {
    variant = 'default',
    size = 'md',
    icon = false,
    label,
    className,
    action,
    exposure = DEFAULT_EXPOSURE,
    type = 'button',
    title,
    'aria-label': ariaLabel,
    children,
    ...rest
  } = props

  const classes = [BASE_CLASS, variantClass(variant), sizeClass(size)]
  if (icon) classes.push(ICON_CLASS)
  if (className !== undefined && className !== '') classes.push(className)

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      // An explicit `aria-label` still wins: a text button whose visible label
      // is an abbreviation has a real reason to spell itself out.
      aria-label={ariaLabel ?? (icon ? label : undefined)}
      // Icon buttons get the label as a tooltip too, so the pointer user and the
      // screen-reader user are told the same thing.
      title={title ?? (icon ? label : undefined)}
      // Emitted only alongside an `action`: exposure is a statement about a
      // named thing, and there is nothing to say about a control an agent could
      // not address in the first place.
      {...(action === undefined ? {} : { 'data-peek-action': action, 'data-peek-exposure': exposure })}
    >
      {children}
    </button>
  )
}
