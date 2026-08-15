/**
 * The one place that knows peek can speak outside its own window.
 *
 * ## What this is for
 *
 * peek already had toasts, and toasts are not notifications. A toast is
 * transient renderer state (`renderer/state/notifyStore.ts` says so in its first
 * line) drawn in the corner of a window that may be behind a browser, or
 * minimised, or on another Space. It is the right shape for "that command
 * failed" and the wrong shape for the only case that matters here: **the user
 * has gone somewhere else, and something they were waiting for has happened.**
 *
 * So there are two outlets, and the rule between them is about attention rather
 * than about levels or sources:
 *
 *   window in front  → the toast, because the user can see it, and a system
 *                      banner would cover the top-right corner of the very
 *                      window they are reading;
 *   window elsewhere → the system notification, *and* the toast — the banner
 *                      does the calling, the toast is what they find when they
 *                      come back (it lands in the error centre by way of
 *                      `errorLog.ts`, which is peek's existing record of things
 *                      it said).
 *
 * ## Why everything is injected
 *
 * `Notification`, the window and the user's preference all arrive as deps. Not
 * for purity: it is the only way to test the rule above, which is a decision
 * table over "is the window in front" × "does the user allow this" × "does the
 * platform support it" and has no interesting behaviour left once you can't
 * vary those three.
 *
 * Localisation, and why these strings are English: main has no language. The UI
 * language is a renderer-local preference by decision (see `config/settings.ts`),
 * and the same reasoning already keeps `NotifyMessage` untranslated in
 * `bus/effects.ts`. It costs little here — the text an agent sends through
 * `app.notify` is the agent's own, written in whatever language it is talking to
 * the user in, and the only strings peek composes itself are the turn-ended
 * ones in `chat-host.ts`.
 */

import type { AppNotifyResult, NotifyLevel, NotifyMessage, ViewId } from '@peek/core'

/* ================================================================== */
/* 1. What a caller says                                               */
/* ================================================================== */

export interface UserNotice {
  level: NotifyLevel
  /** One line. It is the banner's title, so it has to work read alone. */
  message: string
  detail?: string
  /** Bring this view forward when the user clicks the notification. */
  focusViewId?: ViewId
  /**
   * What to do when peek *is* the window in front.
   *
   * `'toast'` for anything a caller asked for explicitly — an agent that calls
   * `notify` gets a toast even if the user is watching, because it chose to say
   * something and silently dropping it would be a lie.
   *
   * `'nothing'` for what peek decides on its own, which today is "the agent
   * finished". If the user is looking at the panel, the reply is already on
   * screen; announcing it as well is noise that makes the feature worth turning
   * off.
   */
  whenFocused: 'toast' | 'nothing'
}

export type Notifier = (notice: UserNotice) => AppNotifyResult

/* ================================================================== */
/* 2. The seams                                                         */
/* ================================================================== */

/** The part of a BrowserWindow this module needs — a real one satisfies it as is. */
export interface NotifierWindow {
  isFocused(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface SystemNotification {
  show(): void
  /** Called when the user clicks the banner. At most one handler. */
  onClick(handler: () => void): void
}

export interface SystemNotifier {
  supported(): boolean
  create(options: { title: string; body: string; silent: boolean }): SystemNotification
}

export interface NotifierDeps {
  /** The existing in-app outlet: `bus/ipc-main.ts`'s `sendNotify`, already wired. */
  toast(message: NotifyMessage): void
  /** The window, or null before one exists / after it is gone. */
  window(): NotifierWindow | null
  /** Read per call, not captured — a preference change takes effect immediately. */
  systemEnabled(): boolean
  /** How a click reaches a view. Absent, a click only brings peek forward. */
  activateView?(viewId: ViewId): void
  system: SystemNotifier
}

/* ================================================================== */
/* 3. The rule                                                          */
/* ================================================================== */

/**
 * "The user is not looking at peek."
 *
 * Three conditions rather than `isFocused()` alone, because they fail
 * differently and all three mean the same thing to a person: another app is in
 * front, peek is in the Dock, peek is hidden. `isFocused()` alone would be
 * *nearly* right, which is worse than either being right or being obviously
 * wrong — a hidden window that reports focus is exactly the state where a
 * notification is silently dropped and nobody can explain why.
 *
 * No window at all counts as away. Startup raises notices before `createWindow`
 * (see the deferred-notice buffer in `index.ts`), and a person who cannot
 * possibly be reading a window is not reading it.
 */
function userIsElsewhere(win: NotifierWindow | null): boolean {
  if (win === null) return true
  return !win.isFocused() || win.isMinimized() || !win.isVisible()
}

export function createNotifier(deps: NotifierDeps): Notifier {
  return (notice) => {
    const win = deps.window()
    const away = userIsElsewhere(win)

    // The toast goes out whenever the caller asked to be heard, and *always*
    // when the user is away — that copy is not for reading now, it is the trace
    // they find on return. `whenFocused: 'nothing'` is a request not to
    // interrupt, not a request to leave no record.
    const toast = away || notice.whenFocused === 'toast'
    if (toast) {
      deps.toast({
        level: notice.level,
        message: notice.message,
        ...(notice.detail === undefined ? {} : { detail: notice.detail }),
        ...(notice.focusViewId === undefined ? {} : { viewId: notice.focusViewId }),
      })
    }

    if (!away || !deps.systemEnabled() || !deps.system.supported()) {
      return { system: false, toast }
    }

    const banner = deps.system.create({
      title: notice.message,
      body: notice.detail ?? '',
      // Never silent: a notification nobody hears is the toast we already sent.
      silent: false,
    })
    banner.onClick(() => {
      const target = deps.window()
      if (target !== null) {
        // The same three calls `second-instance` makes in `index.ts`, and for the
        // same reason — "bring peek back" is one behaviour, not two spellings.
        if (target.isMinimized()) target.restore()
        if (!target.isVisible()) target.show()
        target.focus()
      }
      if (notice.focusViewId !== undefined) deps.activateView?.(notice.focusViewId)
    })
    banner.show()

    return { system: true, toast }
  }
}

/**
 * The notifier a process that has not assembled a window yet can still hold.
 *
 * Reports what actually happened — nothing — rather than throwing. Same choice,
 * same grounds as `createUnavailableChatRuntime`: the wiring being incomplete is
 * a fact about peek, not an error the caller made.
 */
export const unavailableNotifier: Notifier = () => ({ system: false, toast: false })
