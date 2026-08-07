import type { ReactElement } from 'react'
import { isMacPlatform, useAnnouncement, useGlobalKeys, useLayoutAnnouncer, useMenuActions } from '../hooks'
import { useT } from '../i18n'
import { openSettings } from '../state/settingsDialogStore'
import { ChatSessionsRail } from './chat'
import { LayoutTree } from './LayoutTree'
import { SettingsDialog } from './settings'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'
import { Button } from '../ui/Button'

export function App(): ReactElement {
  const t = useT()
  useGlobalKeys()
  useMenuActions()
  useLayoutAnnouncer()
  // Read once per mount, not reactively: the platform cannot change under a
  // running window, and the class it decides drives the traffic-light gutter.
  const mac = isMacPlatform()

  return (
    <div className="flex h-full flex-col">
      {/*
       * On macOS this strip holds nothing at all — it is the traffic lights'
       * gutter and the window's drag handle, which is what a Mac title bar is.
       * What used to be here went three ways: the `peek` wordmark was
       * decoration, the sync and bridge lines moved to the status bar (which
       * already carried a second copy of the bridge one), and the gear became
       * `peek → Settings…` in the application menu. See
       * `design/2026-08-04-settings-into-app-menu.md`.
       *
       * Elsewhere the gear stays: Windows and Linux have no menu bar anyone
       * looks in for preferences, so removing it there would leave `Ctrl+,` as
       * the only way in.
       *
       * `--spacing-bar`, like the sidebar head, the panel head and the status
       * bar: there is no fifth height in this window.
       *
       * `app-drag` is what makes the strip move the window, and it is a class
       * now rather than a rule in `app.css`: `-webkit-app-region` belongs to no
       * Tailwind namespace, so it is declared once as an `@utility` in
       * `theme.css` and worn here. The `titlebar` class it replaces is gone —
       * that name existed only to be the rule's selector, and nothing else in
       * the repo ever read it.
       *
       * The left padding is room for the traffic lights, which main positions at x=12 and
       * whose three buttons end around x=64. It is conditional because Windows
       * and Linux have no lights, and this padding was unconditional before — a
       * blank 82px reserved on every platform for a macOS control.
       */}
      <div
        className={
          mac
            ? 'app-drag flex h-bar flex-none items-center gap-snug shadow-rule-b bg-bg-1 py-0 pr-snug pl-traffic'
            : 'app-drag flex h-bar flex-none items-center gap-snug shadow-rule-b bg-bg-1 px-snug'
        }
      >
        {mac ? null : (
          <>
            <span className="flex-1" />
            {/* The opt-out is on a wrapper rather than on the control, and that
                is the className fence doing its job rather than a hole in it: it
                classifies a passed class by its prefix, and `app-` is neither a
                layout family nor a paint one, so a `<Button>` may not carry it.
                The wrapper's rectangle is the button's, so the region Chromium
                subtracts is the same one either way. `flex` so the span is the
                button's box and not a line box around it. */}
            <span className="app-no-drag flex">
              <Button
                variant="ghost"
                icon
                label={t('settings.open')}
                action="settings.open"
                onClick={() => {
                  openSettings()
                }}
              >
                ⚙
              </Button>
            </span>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <LayoutTree />
        </div>
        {/* Squeezes the work area rather than floating over it: the panel tab
            strip lives in the top-right corner, and an overlay would sit on the
            split and close buttons. See
            `design/2026-08-02-chat-sessions-side-rail.md` §2.1. */}
        <ChatSessionsRail />
      </div>

      <StatusBar />
      {/* Mounted here, not inside the sidebar: it is opened from the application
          menu (macOS) or the title-bar gear (elsewhere), from `⌘,` and from the
          first-run guide, and it must outlive any of them unmounting. Renders
          nothing while closed. */}
      <SettingsDialog />
      <Toasts />
      <LiveRegion />
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The window's one live region.
 *
 * One, deliberately, and mounted here rather than inside a panel: a region per
 * panel would say four things at once the moment a split re-arranges the
 * layout, and a screen reader queues them all. Being a sibling of everything
 * else also means it survives any subtree unmounting, so an announcement about
 * a panel that has just gone away still gets read.
 *
 * `polite`, never `assertive`: nothing announced here is urgent enough to cut
 * across a sentence the user is already listening to. `atomic` because the
 * messages are whole sentences — re-reading only the changed words would
 * produce "3 of 4" with no subject.
 *
 * It is empty on first render and stays empty until something actually changes;
 * see `useLayoutAnnouncer`, which owns the decision of what is worth saying.
 * What it must never carry is streaming query progress — a region that speaks on
 * every row batch is a region users switch off.
 */
function LiveRegion(): ReactElement {
  const t = useT()
  const text = useAnnouncement()
  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t('a11y.region.label')}
    >
      {text}
    </div>
  )
}
