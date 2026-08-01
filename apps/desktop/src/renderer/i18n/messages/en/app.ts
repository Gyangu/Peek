/**
 * Application chrome: title bar, toasts, command dispatch feedback.
 *
 * English is the source of truth for the whole catalog: the literal types of the
 * strings below are what generate `MessageKey` and the params each key demands.
 * Keep `as const`, or every key silently widens to `string` and the type safety
 * evaporates.
 */
export const app = {
  'app.bridgeNotReady': 'preload bridge not ready',
  'app.syncing': 'Syncing state…',

  'app.toast.dismiss': 'Dismiss',

  'app.command.notSent': 'Command not sent',
  'app.command.bridgeUnavailable': 'The preload bridge is unavailable, so main cannot be reached',
  'app.command.threw': 'Command {name} threw',

  /* Mirror health. The `reason` these toasts carry is an internal diagnostic
   * written in English on purpose — it names revisions and patch state, and it
   * is meant to be pasted into a bug report unchanged. */
  'app.notify.resync': 'State realigned',
  'app.notify.snapshotFailed': 'Could not read the state snapshot',
  'app.notify.bridgeMissingDetail':
    'The window is running in read-only demo mode. Check that preload/index.cjs is built and loaded.',

  /* Chrome around an error, not the error text itself — anything under the
   * reserved `error.*` prefix comes from @peek/core, never from this directory. */
  'app.error.position': 'position {position}',
  'app.error.prefixed': '{context}: {message}',

  /* The window-level crash screen. It has to promise that reloading is safe, or
   * a user with an unsaved query in front of them will not press the button:
   * the workspace lives in the main process, and the renderer only mirrors it. */
  'app.crash.title': 'The window stopped rendering',
  'app.crash.body':
    'Reloading rebuilds it from the state held in the main process. Connections stay open and nothing is lost.',
  'app.crash.reload': 'Reload the window',

  'app.language.title': 'Language',
} as const

export type AppMessages = typeof app
