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

  /* ---- Error centre ------------------------------------------------
   * The panel that remembers failures past the toast that announced them.
   * `code`, view ids and connection labels inside an entry are identifiers and
   * are rendered untranslated by the component. */
  'app.errors.title': 'Error log',
  'app.errors.count': { one: '{count} error', other: '{count} errors' },
  'app.errors.unseen': { one: '{count} new', other: '{count} new' },
  'app.errors.openTitle': 'Show the recent failures, with their codes and details',
  'app.errors.empty': 'Nothing has failed yet',
  'app.errors.copyAll': 'Copy all',
  'app.errors.copyEntry': 'Copy',
  'app.errors.copied': 'Copied',
  'app.errors.clear': 'Clear',
  'app.errors.close': 'Close',
  /* Reported, not inferred: whoever asked for a result set or a connection is
   * recorded on it when the Command Bus creates it. See errorLog.ts. */
  'app.errors.sourceTitle':
    'Who asked for the thing that failed. “you” is this window, “MCP” an external client, ' +
    '“chat” peek’s own chat panel, and “peek” the app itself — a driver process, a timeout, ' +
    'state sync.',
  'app.errors.source.ui': 'you',
  'app.errors.source.mcp': 'MCP',
  'app.errors.source.agent': 'chat',
  'app.errors.source.system': 'peek',
  /* Raised once at startup when preload's main-world bootstrap failed. Not a
   * transient failure: it lasts until peek is restarted. */
  'app.errors.dataPlaneDown': 'peek started without its data channel — queries will never return rows',
  'app.errors.dataPlaneDownDetail':
    'Connecting, browsing and settings still work, because those travel a different channel. ' +
    'Restart peek. If it happens again, this is a bug worth reporting.',

  /* ----------------------------------------------------------------
   * The other two tabs of the same panel: main's diagnostic stream and
   * the command audit. See docs/design/2026-08-15-logging-and-audit.md.
   * ---------------------------------------------------------------- */
  'app.logs.title': 'Logs',
  'app.logs.tab.errors': 'Errors',
  'app.logs.tab.diagnostics': 'Log',
  'app.logs.tab.commands': 'Commands',
  /* "Capture" is what is being written to the file; "show" is what this panel
   * displays out of it. Two different questions, and conflating them is how a
   * user turns the level down and wonders why nothing new appears. */
  'app.logs.capture': 'Capture',
  'app.logs.captureTitle':
    'How much peek writes to its log file, from now on. Takes effect immediately; nothing already written is lost.',
  'app.logs.show': 'Show',
  'app.logs.showTitle': 'Filter what this panel displays. Does not change what is being written.',
  'app.logs.filterAll': 'All',
  'app.logs.source': 'Asked by',
  'app.logs.empty': 'Nothing logged yet at this level',
  'app.logs.emptyCommands': 'No commands yet',
  'app.logs.clearTag': 'Show everything',
  'app.logs.filterByTag': 'Show only this conversation',
  'app.logs.elapsed': '{ms}ms',
  /* Said where the oldest record is, because a panel showing the last 2000 of
   * 50000 looks exactly like one showing all 2000 there ever were. */
  'app.logs.truncated': 'Older records have been dropped from this view. The full log is at {path}',
  'app.logs.viewForTurn': 'Show this conversation’s log',
} as const

export type AppMessages = typeof app
