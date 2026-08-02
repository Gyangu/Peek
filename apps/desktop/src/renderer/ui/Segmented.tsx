import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

import './segmented.css'
import { indexOfValue, wrapIndex } from '../util/roving'
import type { ControlSize } from './spec'

/**
 * One choice out of several, said in a way a screen reader understands.
 *
 * peek had three of these — the connect dialog's URL/fields switch, the language
 * picker, the zoom steps — written out longhand, identically, three times:
 *
 *     <div className="segmented">
 *       {items.map((x) => (
 *         <button className={sel ? 'seg active' : 'seg'} aria-pressed={sel} …>
 *
 * The duplication is the smaller half. `aria-pressed` on N buttons describes **N
 * independent toggles**: a screen reader says "Chinese, pressed" and then
 * "English, not pressed", two unrelated switches rather than one choice with two
 * options. It never says which of how many, and it announces nothing when the
 * selection moves. WAI-ARIA has a pattern for mutual exclusion and this was not
 * it.
 *
 * The keyboard followed from the same mistake: N separate buttons means N tab
 * stops, so walking past the zoom control took six presses. A radio group is one
 * stop, and the arrows move inside it.
 *
 * Design record: docs/design/2026-08-02-segmented-control.md
 */
export interface SegmentedOption<T> {
  value: T
  label: string
  /** Native tooltip; the accessible name always comes from `label`. */
  title?: string
  disabled?: boolean
}

export interface SegmentedProps<T extends string | number> {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  /**
   * What is being chosen — becomes the group's `aria-label`.
   *
   * Required, for the same reason `<Button icon>` requires one: a group with no
   * name is read out as a list of options with no statement of what they are
   * options *for*. Making it mandatory is what stops that being a thing anyone
   * has to remember.
   */
  label: string
  size?: ControlSize
  /** Layout only, same fence as `<Button>`. */
  className?: string
  style?: never
}

export function Segmented<T extends string | number>(props: SegmentedProps<T>): ReactNode {
  const { value, options, onChange, label, size = 'md', className } = props
  const groupRef = useRef<HTMLDivElement | null>(null)

  const selected = indexOfValue(options, value)

  /**
   * Roving tabindex: the group is one tab stop, and it is the *selected* option
   * that carries it — so tabbing in lands on the current answer rather than on
   * whichever option happens to be first.
   *
   * With nothing selected the first option takes it, because a group no tab key
   * can enter is worse than one that starts in the wrong place.
   */
  const roving = selected >= 0 ? selected : 0

  function move(delta: number): void {
    const target = wrapIndex(options.length, selected, delta)
    const option = options[target]
    if (!option || option.disabled === true) return
    onChange(option.value)
    // Focus follows selection, so the ring stays on the thing that is now
    // checked. Without this the arrow keys would move the answer while the ring
    // sat on the old one.
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[target]?.focus()
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        return
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        return
      case 'Home':
        e.preventDefault()
        move(-selected)
        return
      case 'End':
        e.preventDefault()
        move(options.length - 1 - selected)
        return
      default:
    }
  }

  const classes = ['seg-group', `seg-${size}`]
  if (className !== undefined && className !== '') classes.push(className)

  return (
    // `radiogroup`, not `tablist`: nothing here switches to a panel, and a
    // `tablist` promises a screen reader a `tabpanel` that does not exist.
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={classes.join(' ')}
      onKeyDown={onKeyDown}
    >
      {options.map((option, i) => {
        const checked = i === selected
        return (
          <button
            key={String(option.value)}
            type="button"
            // `<button role="radio">` rather than a native `<input type="radio">`:
            // the semantics are identical, and the native control would have to be
            // stripped to nothing (`appearance: none`, its own label association,
            // its own focus ring) before it could look like this. `PanelTabs`
            // makes the same trade with `div role="tab"`.
            role="radio"
            aria-checked={checked}
            tabIndex={i === roving ? 0 : -1}
            disabled={option.disabled === true}
            className={checked ? 'seg-item seg-on' : 'seg-item'}
            {...(option.title === undefined ? {} : { title: option.title })}
            onClick={() => {
              onChange(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
