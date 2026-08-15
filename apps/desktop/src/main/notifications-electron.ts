/**
 * The Electron half of the notifier, kept in its own module.
 *
 * ## Why this is not three more lines in `notifications.ts`
 *
 * A module that imports `electron` cannot be loaded outside an Electron process,
 * and the test runner is plain Node — `electron`'s entry point there is a
 * package that resolves to a *path string*, so a named import throws at parse
 * time, before any test body runs. It takes down every test that reaches the
 * module through any chain of imports, which for `notifications.ts` means the
 * whole bus: `bus/handlers/app.ts` needs `unavailableNotifier`.
 *
 * The same fence is why `config/handlers.ts` reaches for `connections/timeouts`
 * directly instead of through its barrel, and it says so in a comment. This is
 * that rule applied one level up: the decision table stays testable, and the one
 * thing only Electron can do lives where only Electron looks.
 */

import { Notification } from 'electron'
import type { SystemNotifier } from './notifications'

/**
 * A note on macOS: the banner is attributed to the *bundle*, so under `pnpm dev`
 * it reads "Electron" — that is the bundle running. Packaged builds say peek.
 * Deliberately not worked around; changing the bundle id to improve a
 * development-mode banner would trade a property of the shipped product for an
 * appearance in a mode nobody ships.
 */
export function electronSystemNotifier(): SystemNotifier {
  return {
    supported: () => Notification.isSupported(),
    create(options) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: options.silent,
      })
      return {
        show: () => {
          notification.show()
        },
        onClick: (handler) => {
          notification.on('click', handler)
        },
      }
    },
  }
}
