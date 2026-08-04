/**
 * The application menu's arm inside the renderer.
 *
 * Same shape as `useGlobalKeys`, and for the same reason: the file only
 * *translates*. `applyMenuAction` decides what a menu message means and is a
 * plain function so it can be tested without a window; the hook is the
 * subscription around it. What it translates into is deliberately the same call
 * the gear and `⌘,` make — `openSettings()` — so the three doors cannot drift.
 *
 * Only macOS ever sends anything down this channel today: that is where the
 * `Settings…` item lives, because that is where a Mac user looks for it. See
 * `docs/design/2026-08-04-settings-into-app-menu.md`.
 */

import { useEffect } from 'react'
import type { MenuActionMessage } from '@peek/core'
import { tryBridge } from '../bridge'
import { openSettings } from '../state/settingsDialogStore'

/**
 * One menu message, applied.
 *
 * Unknown actions are dropped rather than thrown on: main and renderer ship
 * together, so a message this does not recognise means a build mismatch, and
 * crashing the window over one is a worse answer than ignoring it.
 */
export function applyMenuAction(msg: MenuActionMessage): void {
  switch (msg.action) {
    case 'openSettings':
      // No section argument, so a dialog that is already open on another section
      // stays where the user left it. Same call `⌘,` makes on Windows and Linux.
      openSettings()
      return
    default: {
      // Exhaustive, and safe at runtime: a variant added to MenuActionMessage
      // fails to compile here until it is handled, while a message from a
      // mismatched build just falls through and is dropped.
      const unhandled: never = msg.action
      void unhandled
      return
    }
  }
}

export function useMenuActions(): void {
  useEffect(() => {
    const bridge = tryBridge()
    // Feature-probed even though `PeekBridge` requires it: `tryBridge` only
    // vouches for `invoke` and `getSnapshot`, and a preload older than this
    // channel would otherwise take the window down on mount.
    if (!bridge || typeof bridge.onMenuAction !== 'function') return
    return bridge.onMenuAction(applyMenuAction)
  }, [])
}
