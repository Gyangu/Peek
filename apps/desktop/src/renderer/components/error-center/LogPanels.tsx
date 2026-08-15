/**
 * The two tabs that show main's logs.
 *
 * Siblings of `ErrorCenter`'s failure list, inside the same shell. They are a
 * separate file because they answer a different question with different data —
 * the error tab is this window's memory of what broke, and these two are main's
 * record of what *happened*, which includes everything that went right.
 *
 * The state, the polling and the reasoning about why these are pulled rather
 * than pushed all live in `logTabs.ts`.
 */

import { useEffect, type ReactElement } from 'react'
import type { CommandLogEntry, CommandSource, LogLevel, LogRecord } from '@peek/core'
import { LOG_LEVELS } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { detailText, LOG_POLL_MS, refreshLogTab, setCaptureLevel, setLogFilter, useLogTabs } from './logTabs'

/**
 * Re-read while the panel is open.
 *
 * An effect in the panel rather than a subscription in the store, so the polling
 * exists only while somebody is looking at it — a closed panel costs nothing,
 * which is the whole argument for pulling in the first place.
 */
export function useLogPolling(active: boolean): void {
  useEffect(() => {
    if (!active) return
    void refreshLogTab()
    const timer = setInterval(() => {
      void refreshLogTab()
    }, LOG_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [active])
}

/* ================================================================== */
/* The diagnostic tab                                                  */
/* ================================================================== */

export function LogTabView(): ReactElement {
  const t = useT()
  const records = useLogTabs((s) => s.records)
  const level = useLogTabs((s) => s.level)
  const filterLevel = useLogTabs((s) => s.filterLevel)
  const filterTag = useLogTabs((s) => s.filterTag)
  const truncated = useLogTabs((s) => s.truncated)
  const path = useLogTabs((s) => s.logPath)

  // Newest first, like the error tab: the thing that just happened is the thing
  // being looked for. main hands them over oldest-first, which is the right
  // order for a file and the wrong one for a panel.
  const ordered = [...records].reverse()

  return (
    <>
      <div className="flex flex-none items-center gap-tight px-snug py-tight shadow-rule-b text-fg-dim">
        <span title={t('app.logs.captureTitle')}>{t('app.logs.capture')}</span>
        <Segmented
          size="sm"
          label={t('app.logs.capture')}
          value={level}
          options={LOG_LEVELS.map((value) => ({ value, label: value }))}
          onChange={(next) => {
            void setCaptureLevel(next)
          }}
        />
        <span className="flex-1" />
        <span title={t('app.logs.showTitle')}>{t('app.logs.show')}</span>
        <Segmented
          size="sm"
          label={t('app.logs.show')}
          value={filterLevel ?? 'all'}
          options={[
            { value: 'all' as const, label: t('app.logs.filterAll') },
            ...LOG_LEVELS.map((value) => ({ value, label: value })),
          ]}
          onChange={(next) => {
            setLogFilter({ level: next === 'all' ? null : next })
          }}
        />
      </div>

      {filterTag === null ? null : (
        <div className="flex flex-none items-center gap-tight px-snug py-tight shadow-rule-b">
          {/* An id, never translated — it is what the user matches against the transcript. */}
          <span className="font-mono tabular-nums text-fg-dim">{filterTag}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setLogFilter({ tag: null })
            }}
          >
            {t('app.logs.clearTag')}
          </Button>
        </div>
      )}

      <div className="overflow-y-auto overflow-x-hidden">
        {ordered.length === 0 ? (
          <div className="p-snug text-fg-faint">{t('app.logs.empty')}</div>
        ) : (
          <>
            {ordered.map((record, index) => (
              <LogRow key={`${String(record.ts)}:${String(index)}`} record={record} />
            ))}
            {/*
             * Said out loud, at the end where the oldest record is, because a
             * panel showing the last 2000 of 50000 looks exactly like one
             * showing all 2000 that ever existed — and only one of those two
             * means "you are looking at the whole story".
             */}
            {truncated ? (
              <div className="p-snug text-fg-faint">{t('app.logs.truncated', { path })}</div>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

function LogRow({ record }: { record: LogRecord }): ReactElement {
  const t = useT()
  const detail = record.detail === undefined ? null : detailText(record.detail)
  return (
    <div className="flex flex-col gap-inset py-tight px-snug border-t border-border">
      <div className="flex items-baseline gap-tight">
        <span className="font-mono tabular-nums text-fg-faint">{formatClock(record.ts)}</span>
        <strong className={`font-mono tabular-nums ${levelClass(record.level)}`}>{record.level}</strong>
        {/* Namespace and tag are identifiers, so neither is translated. */}
        <span className="font-mono tabular-nums text-fg-faint">{record.ns}</span>
        {record.tag === undefined ? null : (
          /*
           * Clicking a tag filters to it — the fast path from "this line looks
           * wrong" to "show me everything from that conversation".
           *
           * A `<Button>`, per `ui/CLAUDE.md`'s fence, and with **no `className`
           * at all**: the monospace treatment the ids elsewhere on this row get
           * is paint, and the fence is right that paint belongs in a variant
           * rather than at a call site. A tag reads fine in the control's own
           * type, and inventing a spec variant to letterspace one button would
           * be the tail wagging the dog.
           */
          <Button
            variant="ghost"
            size="sm"
            title={t('app.logs.filterByTag')}
            onClick={() => {
              setLogFilter({ tag: record.tag ?? null })
            }}
          >
            {record.tag}
          </Button>
        )}
      </div>
      {/* Untranslated: it is main's own words, and it is evidence. */}
      <div className="whitespace-pre-wrap break-words">{record.message}</div>
      {detail === null ? null : <div className="text-fg-faint whitespace-pre-wrap break-words">{detail}</div>}
    </div>
  )
}

/* ================================================================== */
/* The audit tab                                                       */
/* ================================================================== */

const SOURCES: readonly CommandSource[] = ['ui', 'agent', 'mcp', 'system']

/**
 * Every command, with who asked for it.
 *
 * This tab is the first place `CommandSource` is fully visible. The Command Bus
 * has recorded it on every dispatch since M2 and `command-origin.test.ts` has
 * guarded it — and until now the only surface that showed it was a label on
 * *failures* in the error tab. What a person clicked, what the panel's agent
 * sent, and what an external MCP client sent were indistinguishable as long as
 * they succeeded.
 */
export function CommandsTabView(): ReactElement {
  const t = useT()
  const entries = useLogTabs((s) => s.entries)
  const filterSource = useLogTabs((s) => s.filterSource)
  const ordered = [...entries].reverse()

  return (
    <>
      <div className="flex flex-none items-center gap-tight px-snug py-tight shadow-rule-b text-fg-dim">
        <span>{t('app.logs.source')}</span>
        <Segmented
          size="sm"
          label={t('app.logs.source')}
          value={filterSource ?? 'all'}
          options={[
            { value: 'all' as const, label: t('app.logs.filterAll') },
            ...SOURCES.map((value) => ({ value, label: sourceLabel(t, value) })),
          ]}
          onChange={(next) => {
            setLogFilter({ source: next === 'all' ? null : next })
          }}
        />
      </div>

      <div className="overflow-y-auto overflow-x-hidden">
        {ordered.length === 0 ? (
          <div className="p-snug text-fg-faint">{t('app.logs.emptyCommands')}</div>
        ) : (
          ordered.map((entry) => <CommandRow key={entry.seq} entry={entry} t={t} />)
        )}
      </div>
    </>
  )
}

function CommandRow({ entry, t }: { entry: CommandLogEntry; t: TFunction }): ReactElement {
  const input = entry.input === undefined ? null : detailText(entry.input)
  return (
    <div className="flex flex-col gap-inset py-tight px-snug border-t border-border">
      <div className="flex items-baseline gap-tight">
        <span className="font-mono tabular-nums text-fg-faint">{formatClock(entry.ts)}</span>
        <span className="font-mono tabular-nums text-fg-faint" title={t('app.errors.sourceTitle')}>
          {sourceLabel(t, entry.source)}
        </span>
        {/* The command name is part of a closed vocabulary; showing it raw is the point. */}
        <strong className="font-mono tabular-nums">{entry.name}</strong>
        {entry.ok ? null : (
          <span className="font-mono tabular-nums text-err">{entry.errorCode ?? 'ERROR'}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono tabular-nums text-fg-faint">
          {t('app.logs.elapsed', { ms: entry.elapsedMs })}
        </span>
      </div>
      {entry.ok || entry.errorMessage === undefined ? null : (
        <div className="whitespace-pre-wrap break-words">{entry.errorMessage}</div>
      )}
      {input === null || input === '{}' ? null : (
        // Already redacted by main (`redactCommandInput`): a `conn.open` password
        // never reached this process, let alone this element.
        <div className="text-fg-faint whitespace-pre-wrap break-words">{input}</div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function levelClass(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'text-err'
    case 'warn':
      return 'text-warn'
    default:
      return 'text-fg-faint'
  }
}

function sourceLabel(t: TFunction, source: CommandSource): string {
  switch (source) {
    case 'ui':
      return t('app.errors.source.ui')
    case 'mcp':
      return t('app.errors.source.mcp')
    case 'agent':
      return t('app.errors.source.agent')
    case 'system':
      return t('app.errors.source.system')
  }
}

/** Wall-clock, in the reader's locale — the clipboard copy uses ISO instead. */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}
