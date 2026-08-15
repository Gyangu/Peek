/**
 * `app.notify` — the one command whose subject is the user rather than the
 * window.
 *
 * ## Why it is a `read` handler that calls out
 *
 * Every other side effect in this bus goes through an `EffectIntent`, and this
 * one deliberately does not. The reason is the return value: an intent's outcome
 * never comes back to the handler, and what a caller most needs to know here is
 * exactly that outcome — *did the banner actually go out, or was the user
 * looking at peek?* An agent that cannot tell those apart will either repeat
 * itself or fall silent, and both failures land on the user.
 *
 * So it takes the shape the bus already has for "a command that answers a
 * question by leaving the process": a `read` handler over an injected
 * collaborator, built by a factory, exactly like `createChatHandlers` and
 * `createConfigHandlers`. It changes no Workspace state, bumps no rev and
 * broadcasts no patch — and it is still a command, so it is validated by the
 * same gate and lands in the same log. "When did something interrupt me, and
 * what did it say" is answerable from the recording everything else is in.
 *
 * See `docs/design/2026-08-15-notifications.md` §2.2.
 */

import type { AppNotifyResult } from '@peek/core'
import type { Notifier } from '../../notifications'
import { unavailableNotifier } from '../../notifications'
import type { CommandHandlerMap } from '../types'

export function createAppHandlers(notify: Notifier) {
  return {
    'app.notify': {
      read: (_state, input): AppNotifyResult =>
        notify({
          level: input.level ?? 'info',
          message: input.message,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
          ...(input.focusViewId === undefined ? {} : { focusViewId: input.focusViewId }),
          // Asked for explicitly, so it is heard even with peek in front. Only
          // what peek decides on its own stays quiet — see `UserNotice`.
          whenFocused: 'toast',
        }),
    },
  } satisfies CommandHandlerMap
}

/**
 * The pre-assembly stand-in, on the same principle as `unavailableConfigHandlers`:
 * a process with no window and no notifier reports that nothing was delivered,
 * which is true, rather than failing a caller who did nothing wrong.
 */
export const unavailableAppHandlers = createAppHandlers(unavailableNotifier)
