import { useEffect, useRef } from 'react'
import type { FocusEvent as ReactFocusEvent, ReactElement } from 'react'

import { Button } from '../ui/Button'

/**
 * A destructive action that asks twice — and moves the second target.
 *
 * peek has two of these (forget a saved connection, delete a conversation) and
 * the design decision behind them is still right: neither act deserves a modal
 * in front of it, and two clicks is the proportionate amount of friction. What
 * was wrong was *where the second click landed*.
 *
 * Both used to swap the button's label in place:
 *
 *     [ Remove ]   →   [ Remove for good? ]
 *
 * Same element, same pixels. A double-click — the gesture people produce by
 * accident more than any other — therefore armed and fired in one go, and both
 * acts are irreversible (forgetting a connection also drops its keychain
 * entry). A delay would not fix that: an accidental double-click is often
 * slower than any timeout worth having, and a timeout punishes the deliberate
 * user too.
 *
 * So the confirm state is two buttons, with **cancel in the original
 * position**:
 *
 *     [ Remove ]   →   [ Keep ] [ Remove for good ]
 *
 * The stray second click hits Keep. Inertia now resolves towards the harmless
 * outcome, which is the only property that actually makes a confirmation worth
 * having.
 *
 * Focus moves to Keep for the same reason — the armed state is reached by a
 * click, so the keyboard default should be the answer that changes nothing —
 * and it is also what makes the blur-to-disarm behaviour work at all: React
 * unmounts the original button when the state flips, so without an explicit
 * focus call the focus would land on `<body>` and the pair would never hear
 * about the user clicking elsewhere.
 */
export interface ConfirmPairProps {
  armed: boolean
  /** Resting label, e.g. "Remove". */
  label: string
  /** The label that carries out the act. */
  confirmLabel: string
  /** The label that backs out — drawn first, where `label` used to be. */
  cancelLabel: string
  onArm: () => void
  onDisarm: () => void
  onConfirm: () => void
  disabled?: boolean
  /** Tooltip for the resting button only; the armed pair speaks for itself. */
  title?: string
}

export function ConfirmPair(props: ConfirmPairProps): ReactElement {
  const { armed, label, confirmLabel, cancelLabel, onArm, onDisarm, onConfirm, disabled, title } = props
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (armed) cancelRef.current?.focus()
  }, [armed])

  if (!armed) {
    return (
      <Button variant="ghost" disabled={disabled === true} {...(title === undefined ? {} : { title })} onClick={onArm}>
        {label}
      </Button>
    )
  }

  return (
    // Blur is read on the pair rather than on either button, so moving between
    // the two does not count as leaving. `relatedTarget` is null when focus goes
    // nowhere at all (a click on the window chrome), which also disarms.
    <span
      className="confirm-pair"
      onBlur={(e: ReactFocusEvent<HTMLSpanElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onDisarm()
      }}
    >
      <Button variant="ghost" ref={cancelRef} onClick={onDisarm}>
        {cancelLabel}
      </Button>
      {/*
       * Was `ghost confirm-danger`: transparent, with the *only* difference from
       * Keep being the text colour. Two buttons that a red-green colour-blind
       * user cannot tell apart, one of which is irreversible. The `danger`
       * variant carries a background and a border as well, so the distinction
       * survives without hue — and the class that used to be here turned out to
       * be a byte-for-byte duplicate of `.chat-perm-reject`.
       */}
      <Button variant="danger" onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </span>
  )
}
