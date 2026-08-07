import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { useNotifyStore } from '../state/notifyStore'
import { Button } from '../ui/Button'

/**
 * Bottom-right notifications: command failures, driver crashes, and NOTIFY
 * messages pushed by main.
 *
 * The text itself is already resolved — `notifyStore` localizes at push time so
 * that a toast keeps the language it was raised in (see the note there). Only the
 * chrome around it goes through `t()`.
 */
export function Toasts(): ReactElement | null {
  const t = useT()
  const toasts = useNotifyStore((s) => s.toasts)
  const dismiss = useNotifyStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    // `bottom-9` clears the status bar, which is 26px plus its 1px top rule.
    <div className="fixed right-3 bottom-9 z-600 flex max-w-95 flex-col gap-tight">
      {toasts.map((toast) => (
        // A screen reader heard none of these before: the window's one live
        // region (`App`'s `LiveRegion`) is driven by `useLayoutAnnouncer` and
        // carries layout changes only, so every failure notice in peek — a
        // driver crash, a refused command — arrived silently. `alert` is the
        // assertive role and is right for a warning or an error; an info toast
        // is `status`, which is polite and waits its turn.
        //
        // The level is a 3px stripe down the leading edge and nothing else: the
        // body of a toast reads the same whatever raised it, so the colour is a
        // margin note rather than a wash. Two things about how that is written.
        //
        // The three plain edges are stated separately from the stripe
        // (`border-y border-r`) rather than as a `border` the stripe overrides —
        // two classes from one utility family on one element are resolved by
        // Tailwind's emission order, not by writing order (§7.2). These are
        // disjoint families, so there is no order to depend on.
        //
        // And each branch is a whole class list rather than one shared string
        // with the stripe interpolated in. `classNames()` in
        // `__tests__/sourceScan.ts` reads the literals inside a `className={…}`,
        // and inside a template literal the quotes pair off *around* the
        // interpolation — the three names that actually differ would be the
        // ones it could not see. The colour ban and the type floor both read it.
        //
        // `shadow-float` is shared with the selection bar and the error centre;
        // this was `0 6px 20px #0008`, two pixels away from theirs, and a token
        // whose only justification is "the old number was that" is not one.
        <div
          key={toast.id}
          className={
            toast.level === 'error'
              ? 'rounded-control border-y border-r border-l-3 border-y-border-strong border-r-border-strong border-l-err bg-bg-2 px-snug py-tight shadow-float select-text'
              : toast.level === 'warn'
                ? 'rounded-control border-y border-r border-l-3 border-y-border-strong border-r-border-strong border-l-warn bg-bg-2 px-snug py-tight shadow-float select-text'
                : 'rounded-control border-y border-r border-l-3 border-y-border-strong border-r-border-strong border-l-accent bg-bg-2 px-snug py-tight shadow-float select-text'
          }
          role={toast.level === 'info' ? 'status' : 'alert'}
        >
          <div className="flex items-start gap-snug">
            <span className="flex-1">{toast.message}</span>
            <Button
              variant="ghost"
              size="sm"
              icon
              label={t('app.toast.dismiss')}
              onClick={() => {
                dismiss(toast.id)
              }}
            >
              ✕
            </Button>
          </div>
          {toast.detail ? (
            <div className="mt-tight max-h-35 overflow-auto font-mono text-micro whitespace-pre-wrap text-fg-dim">
              {toast.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
