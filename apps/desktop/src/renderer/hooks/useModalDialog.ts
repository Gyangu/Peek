import { useEffect, useRef, type RefObject } from 'react'
import { isTopModal, nextFocusIndex, popModal, pushModal } from './modalStack'

/**
 * The three things every modal in this window was missing.
 *
 * 1. **Escape reaches exactly one dialog.** Each modal used to listen on
 *    `window` and close without stopping the event, so a single press could
 *    close a dialog *and* clear the grid's row selection underneath it. The
 *    listener here runs in the capture phase and stops propagation, and only the
 *    dialog on top of `modalStack` acts — so the key does one thing.
 * 2. **Tab stays inside.** None of them trapped focus, so tabbing out of a
 *    dialog walked into the window behind it — where every control is still
 *    clickable, because the mask only blocks the pointer. For a screen-reader
 *    user, `aria-modal="true"` said the opposite of what the tab order did.
 * 3. **Focus comes back.** On close, focus returned to `<body>` and the next Tab
 *    started from the top of the document. It now goes back to whatever had it
 *    when the dialog opened — the row, the button, the tab that led here.
 *
 * Usage: put the returned ref on the dialog element (the panel, not the mask).
 *
 *     const ref = useModalDialog({ label: 'value', onClose })
 *     return <div className="modal-mask"><div ref={ref} role="dialog" aria-modal="true">…
 */
export interface ModalDialogOptions {
  /** For debugging; shows up as the symbol description in the stack. */
  label: string
  onClose: () => void
  /**
   * What to focus on open. Defaults to the first focusable in the dialog.
   *
   * Worth setting whenever the first control in DOM order is not the one a
   * keyboard user should land on — the disclosure dialog puts it on the accept
   * button, because reaching that one by Tab means passing over Cancel.
   */
  initialFocus?: RefObject<HTMLElement | null>
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalDialog(options: ModalDialogOptions): RefObject<HTMLDivElement | null> {
  const { label, onClose, initialFocus } = options
  const ref = useRef<HTMLDivElement | null>(null)

  // Kept in a ref so that a caller passing an inline arrow does not re-register
  // the listener — and, more importantly, does not re-run the effect and push a
  // second entry onto the stack on every render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const initialFocusRef = useRef(initialFocus)
  initialFocusRef.current = initialFocus

  useEffect(() => {
    const id = pushModal(label)
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null

    /*
     * Do not fight `autoFocus`. React runs it during commit, before this effect,
     * so by now the dialog's own idea of where to start is already in place —
     * `ConnectDialog` puts the caret in the first field that way. Stealing it
     * back to the ✕ button would make every dialog open on its close control.
     */
    const alreadyInside = ref.current?.contains(document.activeElement) === true
    if (!alreadyInside) {
      const target = initialFocusRef.current?.current ?? focusables(ref.current)[0] ?? ref.current
      target?.focus()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (!isTopModal(id)) return
      if (e.key === 'Escape') {
        // Both, and in this order: `stopPropagation` is what keeps the grid from
        // also clearing its selection, `preventDefault` keeps the platform from
        // acting on it (leaving full screen, say).
        e.stopPropagation()
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables(ref.current)
      const current = items.findIndex((el) => el === document.activeElement)
      const next = nextFocusIndex(items.length, current, e.shiftKey)
      e.preventDefault()
      e.stopPropagation()
      if (next !== null) items[next]?.focus()
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popModal(id)
      // Only if the focus is still somewhere in this dialog. If something else
      // deliberately took it during the close (a toast action, a newly opened
      // dialog), pulling it back would be the rude one.
      const active = document.activeElement
      if (active === null || active === document.body || ref.current?.contains(active) === true) {
        restoreTo?.focus()
      }
    }
  }, [label])

  return ref
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // `offsetParent` is null for anything `display: none`; a hidden control is
    // in the DOM but not in the tab order, and trapping onto one strands the
    // keyboard.
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}
