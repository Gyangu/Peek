import { create } from 'zustand'
import type { CommandSource, PeekError, PeekErrorCode } from '@peek/core'
import { tryBridge } from '../../bridge'
import { tStatic } from '../../i18n'
import { notify, useNotifyStore, type Toast } from '../../state/notifyStore'
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
 * Two channels, and neither of them guesses:
 *
 *   toasts   A `[CODE] …` toast can only come from `notifyError`, which only
 *            renderer code can call, so it is `ui`. Anything else was pushed by
 *            main over NOTIFY — driver stderr, a crashed driver process — so it
 *            is `system`. The shape is the evidence.
 *   mirror   A result set or a connection went to error. Its `origin` says who
 *            asked for it, recorded by the Command Bus when it was created.
 *
 * `origin` replaced a heuristic that timed out after 1.5s of no in-flight command
 * and called anything later `mcp`. That rule was wrong in exactly the case the
 * panel exists for: a query that dies thirty seconds in has no command in flight
 * no matter who started it, so a person's own timed-out query was reported as an
 * agent's. Recording the answer at creation makes it survive any amount of delay
 * — see docs/design/2026-08-02-failure-attribution-and-degraded-boot.md.
 * ================================================================== */

/** No separate enum: the panel names the same four actors the Command Bus does. */
export type ErrorSource = CommandSource

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

export const useErrorLog = create<ErrorLogState>(() => ({ entries: [], open: false, unseen: 0 }))

let seq = 0

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

  reportDegradedDataPlane()
}

/**
 * Say out loud that preload's main-world bootstrap failed.
 *
 * A toast rather than a direct `recordError`, because the subscription above
 * turns every toast into an entry — calling both would log it twice. Going
 * through `notify` also gets it in front of the user immediately, while the
 * error log and the status-bar badge keep it afterwards.
 *
 * Worth the noise because the symptom is otherwise indistinguishable from a slow
 * database: the window opens, connections open, the tree expands, and every
 * query loads forever. Until this existed the only trace was a `console.error`
 * in preload, which is addressed to whoever already had devtools open.
 *
 * Exported so it can be driven with a stubbed bridge; production calls it once,
 * from `startErrorCollection`.
 */
export function reportDegradedDataPlane(): void {
  // No window means node, not a degraded renderer.
  if (typeof window === 'undefined') return
  if (tryBridge()?.dataPlane !== 'degraded') return
  notify('error', tStatic('app.errors.dataPlaneDown'), tStatic('app.errors.dataPlaneDownDetail'))
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
      source: originOf(meta.origin),
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
      source: originOf(conn.origin),
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

/**
 * `system` is the definition, not a fallback: `ui` / `mcp` / `agent` exhaust the
 * ways somebody can ask for something, so an object no command created belongs to
 * peek itself. In a running app this never fires — the Command Bus writes
 * `origin` at both creation sites, and `command-origin.test.ts` asserts it — but
 * the field is optional in core so that tests can hand-build state literals.
 */
function originOf(origin: CommandSource | undefined): ErrorSource {
  return origin ?? 'system'
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
