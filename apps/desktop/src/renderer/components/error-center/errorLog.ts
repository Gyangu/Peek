import { create } from 'zustand'
import type { PeekError, PeekErrorCode } from '@peek/core'
import { useBusyStore } from '../../state/dispatch'
import { useNotifyStore, type Toast } from '../../state/notifyStore'
import { useWorkspaceStore } from '../../state/workspaceStore'

/* ==================================================================
 * The error log behind the error centre.
 *
 * ## Why this exists
 *
 * Until M6 an error had exactly two places to be, and both of them lost it:
 * `ViewError` shows one error, in one pane, until the next fetch overwrites it,
 * and a toast disappears after a few seconds (info) or as soon as it is the sixth
 * one (everything else). Main's Command log — a ring of the last 500 commands,
 * source and error code included — had no UI at all. So "what went wrong a minute
 * ago" was, in a debugging tool, unanswerable.
 *
 * This is a **renderer-side** ring of the failures this window can observe. It is
 * transient UI state, not workspace state, so holding it here breaks no rule (the
 * same argument `notifyStore` makes for itself).
 *
 * ## Where each entry comes from, and how `source` is decided
 *
 * Three channels, and the rule for each is written out because the honest answer
 * differs by channel:
 *
 *   `ui`     A command **this window** sent came back failed, or a renderer-side
 *            operation did. These arrive as toasts shaped `[CODE] …`, which only
 *            `notifyError` produces and which only renderer code can call.
 *   `system` Main pushed it over NOTIFY: driver stderr, a crashed driver process,
 *            mirror-health warnings. Any toast without the `[CODE]` shape.
 *   `mcp`    It appeared in the Workspace mirror — a result set or a connection
 *            went to error — with nothing in flight from this window.
 *
 * The third rule is a **heuristic and is documented as one**, both here and in the
 * panel's own tooltip. A failure that surfaces asynchronously (a query that dies
 * thirty seconds in) carries no evidence of who started it once it reaches the
 * renderer: patches carry a `commandName` but no `source`, and the only place that
 * knows for certain is main's Command log. Attributing it correctly needs that log
 * to reach the window, which needs a new IPC channel in `packages/core/src/ipc.ts`
 * plus a preload member — both outside this change. Until then `mcp` means
 * "nobody at this keyboard appears to have asked for it", which is the true and
 * useful part of the claim, and the code / message / detail — the fields anyone
 * actually debugs with — are exact either way.
 * ================================================================== */

export type ErrorSource = 'ui' | 'mcp' | 'system'

export interface ErrorEntry {
  /** Monotonic, newest highest. */
  id: number
  ts: number
  source: ErrorSource
  code: PeekErrorCode | 'NOTIFY'
  /**
   * Already-resolved text. Toasts are localized when they are pushed (see
   * notifyStore), so re-localizing here would be a lie about when it was said.
   */
  message: string
  detail?: string
  /**
   * The structured error, when the entry came from the Workspace mirror rather
   * than from a toast. Kept so the panel can localize at render time and so a
   * copied report carries `driverCode` / `position`.
   */
  error?: PeekError
  /** What it was about: a connection label, a view id — never translated. */
  context?: string
}

interface ErrorLogState {
  entries: ErrorEntry[]
  /** The panel is open. */
  open: boolean
  /** Entries added since the panel was last open — the badge count. */
  unseen: number
}

/** How many failures the ring keeps. Matches main's Command log order of magnitude without holding its memory. */
export const ERROR_LOG_CAPACITY = 100

/**
 * How long after a UI command was in flight a Workspace error still counts as
 * this window's doing. Short on purpose: it covers the synchronous case (a
 * command fails and the state change lands in the same breath) without claiming
 * anything about a query that dies a minute later.
 */
const UI_ATTRIBUTION_WINDOW_MS = 1_500

export const useErrorLog = create<ErrorLogState>(() => ({ entries: [], open: false, unseen: 0 }))

let seq = 0
/** Last moment this window had a command in flight; drives UI attribution. */
let lastInflightAt = 0

export function recordError(entry: Omit<ErrorEntry, 'id' | 'ts'>): void {
  seq += 1
  const full: ErrorEntry = { ...entry, id: seq, ts: Date.now() }
  useErrorLog.setState((s) => {
    const next = [...s.entries, full]
    return {
      entries: next.length > ERROR_LOG_CAPACITY ? next.slice(next.length - ERROR_LOG_CAPACITY) : next,
      unseen: s.open ? 0 : s.unseen + 1,
    }
  })
}

export function openErrorCenter(): void {
  useErrorLog.setState({ open: true, unseen: 0 })
}

export function closeErrorCenter(): void {
  useErrorLog.setState({ open: false })
}

export function toggleErrorCenter(): void {
  useErrorLog.setState((s) => (s.open ? { open: false } : { open: true, unseen: 0 }))
}

export function clearErrorLog(): void {
  useErrorLog.setState({ entries: [], unseen: 0 })
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

/** Only `notifyError` produces this shape, and only renderer code can call it. */
const UI_TOAST_SHAPE = /^\[[A-Z0-9_]+\]/

/** Pull the code back out of a `[CODE] message` toast, so the panel can group by it. */
function splitToastMessage(text: string): { code: ErrorEntry['code']; message: string } {
  const match = /^\[([A-Z0-9_]+)\]\s*(.*)$/s.exec(text)
  if (!match) return { code: 'NOTIFY', message: text }
  return { code: match[1] as PeekErrorCode, message: match[2] }
}

let started = false
let lastToastId = 0
/** Result sets already logged, so a patch storm cannot record the same failure twice. */
const loggedResults = new Set<string>()
/** Last error signature recorded per connection; a reconnect that fails again is a new entry. */
const loggedConnections = new Map<string, string>()

/**
 * Subscribe to everything this window can learn a failure from.
 *
 * Called at module load with a guard rather than from an effect, for the same
 * reason `startWorkspaceSync` is: StrictMode mounts twice, and a double
 * subscription would double every entry.
 */
export function startErrorCollection(): void {
  if (started) return
  started = true

  useBusyStore.subscribe((state) => {
    if (state.inflight > 0) lastInflightAt = Date.now()
  })

  useNotifyStore.subscribe((state) => {
    for (const toast of state.toasts) {
      if (toast.id <= lastToastId) continue
      lastToastId = toast.id
      recordToast(toast)
    }
  })

  useWorkspaceStore.subscribe((state) => {
    const ws = state.workspace
    if (!ws) return
    harvestResults(ws.results)
    harvestConnections(ws.connections)
  })
}

function recordToast(toast: Toast): void {
  // `info` is a notification, not a failure. The panel is an error log, and
  // padding it with successes is how a log stops being read.
  if (toast.level === 'info') return
  const { code, message } = splitToastMessage(toast.message)
  recordError({
    source: UI_TOAST_SHAPE.test(toast.message) ? 'ui' : 'system',
    code,
    message,
    ...(toast.detail === undefined ? {} : { detail: toast.detail }),
  })
}

type ResultsMap = NonNullable<ReturnType<typeof useWorkspaceStore.getState>['workspace']>['results']
type ConnectionsMap = NonNullable<ReturnType<typeof useWorkspaceStore.getState>['workspace']>['connections']

function harvestResults(results: ResultsMap): void {
  for (const meta of Object.values(results)) {
    if (meta.status !== 'error' || !meta.error) continue
    if (loggedResults.has(meta.id)) continue
    loggedResults.add(meta.id)
    recordError({
      source: attributeStateError(),
      code: meta.error.code,
      message: meta.error.message,
      ...(meta.error.detail === undefined ? {} : { detail: meta.error.detail }),
      error: meta.error,
      // The view id, not a label: it is how the user, the log and MCP all name
      // the same pane, so it stays untranslated and unformatted.
      context: meta.viewId,
    })
  }
  // A result that main has evicted can never come back, so its dedupe entry is
  // dead weight; without this the set grows for the life of the window.
  if (loggedResults.size > ERROR_LOG_CAPACITY * 4) {
    for (const id of loggedResults) {
      if (!(id in results)) loggedResults.delete(id)
    }
  }
}

function harvestConnections(connections: ConnectionsMap): void {
  const live = new Set<string>()
  for (const conn of Object.values(connections)) {
    live.add(conn.id)
    if (conn.status !== 'error' || !conn.error) {
      // Cleared on recovery, so the *next* failure of this connection is recorded
      // even when it fails the same way twice.
      loggedConnections.delete(conn.id)
      continue
    }
    const signature = `${conn.error.code}::${conn.error.message}`
    if (loggedConnections.get(conn.id) === signature) continue
    loggedConnections.set(conn.id, signature)
    recordError({
      source: attributeStateError(),
      code: conn.error.code,
      message: conn.error.message,
      ...(conn.error.detail === undefined ? {} : { detail: conn.error.detail }),
      error: conn.error,
      context: conn.label,
    })
  }
  for (const id of loggedConnections.keys()) {
    if (!live.has(id)) loggedConnections.delete(id)
  }
}

/** See the module header: this is the documented heuristic, isolated so it is easy to replace. */
function attributeStateError(): ErrorSource {
  return Date.now() - lastInflightAt <= UI_ATTRIBUTION_WINDOW_MS ? 'ui' : 'mcp'
}

/* ------------------------------------------------------------------ */
/* Copying                                                             */
/* ------------------------------------------------------------------ */

/**
 * Render the log as plain text for the clipboard.
 *
 * Deliberately **not localized**: this text exists to be pasted into an issue or
 * shown to somebody else, where a Chinese error code and an English one must read
 * identically. `formatEntry` is exported on its own so a single row can be copied
 * with the same layout as the whole log.
 */
export function formatEntry(entry: ErrorEntry): string {
  const head = `${new Date(entry.ts).toISOString()}  [${entry.source}]  ${entry.code}`
  const where = entry.context === undefined ? '' : `  (${entry.context})`
  const err = entry.error
  const extra: string[] = []
  if (err?.driverCode !== undefined) extra.push(`driverCode=${err.driverCode}`)
  if (err?.position !== undefined) extra.push(`position=${String(err.position)}`)
  if (err?.retryable !== undefined) extra.push(`retryable=${String(err.retryable)}`)
  return [
    `${head}${where}`,
    `  ${entry.message}`,
    ...(extra.length > 0 ? [`  ${extra.join(' ')}`] : []),
    ...(entry.detail === undefined ? [] : [`  ${entry.detail.replace(/\n/g, '\n  ')}`]),
  ].join('\n')
}

export function formatErrorLog(entries: readonly ErrorEntry[]): string {
  if (entries.length === 0) return 'peek error log: (empty)'
  return [`peek error log — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, newest last`, '']
    .concat(entries.map(formatEntry))
    .join('\n')
}
