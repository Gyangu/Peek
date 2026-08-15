/**
 * The two tabs that read main's logs, and the state behind them.
 *
 * ## Why these are pulled and the error tab is pushed
 *
 * The error tab subscribes: it is built from toasts and the Workspace mirror,
 * both of which the window already receives, so a failure appears the instant it
 * happens with nothing asked for. These two cannot work that way and should not
 * try — a diagnostic log at `debug` is dozens of records per turn, and
 * broadcasting all of them to a panel that is usually closed would be a tax paid
 * by every session for a view nobody is looking at.
 *
 * So they are read on demand, through the Command Bus like everything else
 * (`log.read` / `log.readCommands`), and polled while the panel is open. The
 * cost is honest and worth naming: **these two tabs are not live.** What is
 * lost by that is only "watching history scroll", and what would have been lost
 * the other way — knowing something just failed — is exactly what the error tab
 * still does the moment it happens.
 *
 * ## Why `log.*` is not in the audit
 *
 * Because of this file: polling every two seconds would otherwise write two
 * entries per second into the very log the panel is showing. `CommandLog.push`
 * skips `log.*` for that reason, and `state.read` is deliberately *not* skipped
 * — see the note there.
 */

import { create } from 'zustand'
import type { CommandLogEntry, CommandSource, LogLevel, LogRecord } from '@peek/core'
import { dispatch } from '../../state/dispatch'
import { useErrorLog } from './errorLog'

export type LogTab = 'errors' | 'logs' | 'commands'

/** How often an open panel re-reads. Slow enough to be free, fast enough to feel live. */
export const LOG_POLL_MS = 2000

interface LogTabsState {
  tab: LogTab

  /* --- the diagnostic tab --- */
  records: LogRecord[]
  /** What main is capturing at — main's answer, not a local guess. */
  level: LogLevel
  /** Absolute path of `peek.log`, shown so the user can go and get the file. */
  logPath: string
  /** main's ring has evicted records this session; the tab says so. */
  truncated: boolean
  /** Filters. `null` means "no filter", which is not the same as any level. */
  filterLevel: LogLevel | null
  filterNs: string | null
  filterTag: string | null

  /* --- the audit tab --- */
  entries: CommandLogEntry[]
  auditPath: string
  filterSource: CommandSource | null

  /** A read is in flight; used only to avoid stacking polls. */
  loading: boolean
}

export const useLogTabs = create<LogTabsState>(() => ({
  tab: 'errors',
  records: [],
  level: 'info',
  logPath: '',
  truncated: false,
  filterLevel: null,
  filterNs: null,
  filterTag: null,
  entries: [],
  auditPath: '',
  filterSource: null,
  loading: false,
}))

export function setLogTab(tab: LogTab): void {
  useLogTabs.setState({ tab })
  // Read immediately rather than waiting out a poll interval: a tab that paints
  // empty and fills two seconds later reads as broken the first time, every time.
  if (tab !== 'errors') void refreshLogTab()
}

export function setLogFilter(patch: {
  level?: LogLevel | null
  ns?: string | null
  tag?: string | null
  source?: CommandSource | null
}): void {
  useLogTabs.setState((s) => ({
    filterLevel: patch.level === undefined ? s.filterLevel : patch.level,
    filterNs: patch.ns === undefined ? s.filterNs : patch.ns,
    filterTag: patch.tag === undefined ? s.filterTag : patch.tag,
    filterSource: patch.source === undefined ? s.filterSource : patch.source,
  }))
  void refreshLogTab()
}

/**
 * Open the panel on one conversation's records.
 *
 * The entry point from the chat transcript's context menu, and the reason
 * `LogRecord.tag` exists at all: without this the user is handed a text box and
 * asked to know a `chatId`, which is the same as not shipping the filter.
 */
export function openLogsForTag(tag: string): void {
  useErrorLog.setState({ open: true, unseen: 0 })
  useLogTabs.setState({ tab: 'logs', filterTag: tag, filterLevel: null, filterNs: null })
  void refreshLogTab()
}

/**
 * Ask main to capture at a different level, from now on.
 *
 * Goes through `settings.write`, so it is applied **and** persisted by one
 * command — the level is in force before this resolves, and it is still in force
 * after a restart. Nothing already written is discarded, which is what makes
 * "turn it up, then do the thing again" work.
 */
export async function setCaptureLevel(level: LogLevel): Promise<void> {
  const result = await dispatch('settings.write', { logLevel: level })
  // main's answer, not the requested value: the two differ if a future build
  // ever clamps or refuses one, and showing the request would be a lie.
  if (result) useLogTabs.setState({ level: result.logLevel })
  await refreshLogTab()
}

/** Re-read whichever of the two tabs is showing. A no-op on the error tab. */
export async function refreshLogTab(): Promise<void> {
  const state = useLogTabs.getState()
  if (state.tab === 'errors' || state.loading) return
  useLogTabs.setState({ loading: true })
  try {
    if (state.tab === 'logs') {
      const result = await dispatch('log.read', {
        limit: 500,
        ...(state.filterLevel === null ? {} : { minLevel: state.filterLevel }),
        ...(state.filterNs === null ? {} : { ns: state.filterNs }),
        ...(state.filterTag === null ? {} : { tag: state.filterTag }),
      })
      if (result) {
        useLogTabs.setState({
          records: result.records,
          level: result.level,
          logPath: result.path,
          truncated: result.truncated,
        })
      }
    } else {
      const result = await dispatch('log.readCommands', {
        limit: 200,
        ...(state.filterSource === null ? {} : { source: state.filterSource }),
      })
      if (result) useLogTabs.setState({ entries: result.entries, auditPath: result.path })
    }
  } finally {
    useLogTabs.setState({ loading: false })
  }
}

/* ------------------------------------------------------------------ */
/* Copying                                                             */
/* ------------------------------------------------------------------ */

/**
 * Render records as the text the clipboard gets.
 *
 * Deliberately the same layout `formatLogLine` writes into `peek.log`, and
 * deliberately not localized — for the reason `formatErrorLog` gives: this text
 * is pasted into an issue, where it must read identically to whoever opens it.
 */
export function formatRecords(records: readonly LogRecord[]): string {
  if (records.length === 0) return 'peek log: (empty)'
  return records
    .map((record) => {
      const ts = new Date(record.ts).toISOString()
      const tag = record.tag === undefined ? '' : `  [${record.tag}]`
      const head = `${ts}  ${record.level.toUpperCase().padEnd(5)}  ${record.ns.padEnd(8)}${tag}  ${record.message}`
      const detail = record.detail === undefined ? null : detailText(record.detail)
      return detail === null ? head : `${head}\n  ${detail.replace(/\n/g, '\n  ')}`
    })
    .join('\n')
}

/** One audit entry per line, as JSON — the format the file itself holds. */
export function formatEntries(entries: readonly CommandLogEntry[]): string {
  if (entries.length === 0) return 'peek command log: (empty)'
  return entries.map((entry) => JSON.stringify(entry)).join('\n')
}

export function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2) ?? String(detail)
  } catch {
    return String(detail)
  }
}
