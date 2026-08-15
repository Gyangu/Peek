import { useState } from 'react'
import type { ReactElement } from 'react'
import type { CommandLogEntry, LogRecord } from '@peek/core'
import { useErrorText, useT, type TFunction } from '../../i18n'
import {
  clearErrorLog,
  closeErrorCenter,
  formatErrorLog,
  formatEntry,
  startErrorCollection,
  toggleErrorCenter,
  useErrorLog,
  type ErrorEntry,
  type ErrorSource,
} from './errorLog'
import { CommandsTabView, LogTabView, useLogPolling } from './LogPanels'
import { formatEntries, formatRecords, setLogTab, useLogTabs, type LogTab } from './logTabs'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Menu } from '../../ui/Menu'
import { Segmented } from '../../ui/Segmented'
import type { MenuNode } from '../../ui/menuModel'
import { useContextMenu } from '../../ui/useContextMenu'

/**
 * The error centre: the window's memory of what went wrong.
 *
 * ## Why a panel and not more toasts
 *
 * A toast answers "something just failed" and is gone in seconds; `ViewError`
 * answers "this pane is broken" and only for the pane you are looking at. Neither
 * answers **"what went wrong while I was reading the other tab"**, which in a
 * database tool is most of the question — a scan that died, a connection that
 * dropped, a tool call an agent made in a pane that is not on screen. This keeps
 * the last hundred failures with their code, message, detail and origin, and lets
 * them be copied out in one press.
 *
 * ## Where it lives
 *
 * Anchored to the status bar rather than mounted at the app root, because that is
 * where the counter that opens it belongs: the bar is already the window's line of
 * ambient state, and a badge sitting in it is discoverable without being loud.
 * `startErrorCollection` runs at module load — one guarded subscription for the
 * life of the window, unaffected by StrictMode double-mounting.
 */

startErrorCollection()

/* ================================================================== */
/* The status-bar trigger                                              */
/* ================================================================== */

/** The badge in the status bar. Silent until something has actually failed. */
export function ErrorCenterButton(): ReactElement | null {
  const t = useT()
  const count = useErrorLog((s) => s.entries.length)
  const unseen = useErrorLog((s) => s.unseen)
  const open = useErrorLog((s) => s.open)

  if (count === 0) return null
  return (
    <>
      {/*
       * The alarm colour moved onto the text, off the control.
       *
       * It used to be `ghost seg err`, where `err` painted the whole button red.
       * But opening the error centre is not a destructive act — the *count* is
       * what is alarming, and `danger` would have said the wrong thing about the
       * button. Colouring the label instead is both what the control layer's
       * fence forces and the more accurate statement.
       *
       * (`seg` in that class list was `.statusbar .seg`, which `<Segmented>`
       * renamed to `.cell`; `.btn` already provides what it declared. `err` was
       * `.statusbar .err`, and is `text-err` now — the token is the same one,
       * said without needing to be inside a status bar to mean it.)
       */}
      <Button
        variant="ghost"
        title={t('app.errors.openTitle')}
        aria-expanded={open}
        onClick={toggleErrorCenter}
      >
        <span className={unseen > 0 ? 'text-err inline-flex items-center gap-tight' : 'inline-flex items-center gap-tight'}>
          <Icon name="warn" />
          {unseen > 0 ? t('app.errors.unseen', { count: unseen }) : t('app.errors.count', { count })}
        </span>
      </Button>
      {open ? <ErrorCenterPanel /> : null}
    </>
  )
}

/* ================================================================== */
/* The panel                                                           */
/* ================================================================== */

function ErrorCenterPanel(): ReactElement {
  const t = useT()
  const entries = useErrorLog((s) => s.entries)
  const tab = useLogTabs((s) => s.tab)
  const records = useLogTabs((s) => s.records)
  const commands = useLogTabs((s) => s.entries)
  const [copied, setCopied] = useState<number | 'all' | null>(null)

  useLogPolling(tab !== 'errors')

  const copy = (text: string, mark: number | 'all'): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(mark)
        setTimeout(() => {
          setCopied((c) => (c === mark ? null : c))
        }, COPIED_FEEDBACK_MS)
      })
      .catch(() => {
        // A clipboard the OS refused is not worth a second error in the error log.
        setCopied(null)
      })
  }

  // Newest first: the thing that just broke is the thing being looked for.
  const ordered = [...entries].reverse()

  return (
    <div
      className="fixed right-2 bottom-8 z-60 flex flex-col bg-bg border border-border rounded-surface shadow-float"
      role="dialog"
      aria-label={t('app.errors.title')}
      style={PANEL_SIZE}
    >
      <div className="flex h-bar flex-none items-center gap-tight overflow-hidden shadow-rule-b bg-bg-1 px-snug text-fg-dim">
        {/*
         * Three tabs, one shell.
         *
         * The panel used to be the error centre and nothing else, and its title
         * said so. It now also holds main's diagnostic stream and the command
         * audit — so the strip replaces the title, because a panel with a
         * Commands tab in it is not an error centre. The badge that opens it
         * still counts failures only, which is why the trigger and the panel
         * disagree about what this thing is: the trigger is an alarm, the panel
         * is a record.
         */}
        <Segmented
          size="sm"
          label={t('app.logs.title')}
          value={tab}
          options={[
            { value: 'errors' as const, label: t('app.logs.tab.errors') },
            { value: 'logs' as const, label: t('app.logs.tab.diagnostics') },
            { value: 'commands' as const, label: t('app.logs.tab.commands') },
          ]}
          onChange={setLogTab}
        />
        <span className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => {
            copy(copyTextFor(tab, entries, records, commands), 'all')
          }}
        >
          {copied === 'all' ? t('app.errors.copied') : t('app.errors.copyAll')}
        </Button>
        {/*
         * Clear empties this window's failure ring, which only the error tab
         * shows. Deliberately absent on the other two: they are views of main's
         * log, and a button here that appeared to erase it would either lie or
         * destroy the record somebody opened the panel to read.
         */}
        {tab === 'errors' ? (
          <Button variant="ghost" onClick={clearErrorLog}>
            {t('app.errors.clear')}
          </Button>
        ) : null}
        <Button variant="ghost" icon label={t('app.errors.close')} onClick={closeErrorCenter}>
          <Icon name="close" />
        </Button>
      </div>

      {tab === 'logs' ? <LogTabView /> : null}
      {tab === 'commands' ? <CommandsTabView /> : null}
      {tab === 'errors' ? (
        <div className="overflow-y-auto overflow-x-hidden">
          {ordered.length === 0 ? (
            <div className="p-snug text-fg-faint">{t('app.errors.empty')}</div>
          ) : (
            ordered.map((entry) => (
              <ErrorRow
                key={entry.id}
                entry={entry}
                onCopy={() => {
                  copy(formatEntry(entry), entry.id)
                }}
                onCopyAll={() => {
                  copy(formatErrorLog(entries), 'all')
                }}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What the header's copy button puts on the clipboard.
 *
 * Per tab, because "copy all" means the thing being looked at. All three formats
 * are unlocalized for the reason `formatErrorLog` gives: this text is pasted
 * somewhere it has to read identically to whoever opens it.
 */
function copyTextFor(
  tab: LogTab,
  entries: readonly ErrorEntry[],
  records: readonly LogRecord[],
  commands: readonly CommandLogEntry[],
): string {
  if (tab === 'logs') return formatRecords(records)
  if (tab === 'commands') return formatEntries(commands)
  return formatErrorLog(entries)
}

/**
 * One failure.
 *
 * The language rules are `ViewError`'s, for the same reasons: `code` is an
 * identifier and is shown raw, the message is localized only when peek wrote it
 * (`useErrorText` passes driver text through untouched), and `detail` is evidence
 * and never translated. Entries that arrived as toasts carry no structured error —
 * their text was resolved when the toast was raised — so those render as-is.
 */
function ErrorRow({
  entry,
  onCopy,
  onCopyAll,
}: {
  entry: ErrorEntry
  onCopy: () => void
  onCopyAll: () => void
}): ReactElement {
  const t = useT()
  const localized = useErrorText(entry.error)
  const text = entry.error ? localized : entry.message
  const menu = useContextMenu<null>()

  /*
   * The row's own copy button is gone.
   *
   * It was a permanent ghost button on every row, so a screen of ten failures
   * carried ten of them — competing for attention with the codes and messages
   * that are the reason anyone opened this panel. The act itself is the one
   * thing people do here, so it is not being hidden lightly; it is being moved
   * to the gesture that means "act on this row", alongside the two acts that
   * used to be reachable only from the header.
   */
  const nodes: MenuNode[] = [
    { kind: 'item', id: 'error.copy', label: t('menu.error.copyEntry'), onSelect: onCopy },
    { kind: 'item', id: 'error.copyAll', label: t('menu.error.copyAll'), onSelect: onCopyAll },
    { kind: 'sep', id: 'error.sep' },
    {
      kind: 'item',
      id: 'error.clear',
      label: t('menu.error.clear'),
      // It throws away the window's only memory of what failed, and nothing
      // rebuilds it. The header keeps its own Clear button — this is the same
      // act, and the header is where someone looking to empty the panel looks.
      tone: 'danger',
      onSelect: clearErrorLog,
    },
  ]

  return (
    <div
      className="flex flex-col gap-inset py-tight px-snug border-t border-border"
      onContextMenu={menu.open(null)}
      title={t('menu.hint')}
    >
      <div className="flex items-baseline gap-tight">
        <span className="font-mono tabular-nums text-fg-faint">{formatClock(entry.ts)}</span>
        <span className="font-mono tabular-nums text-fg-faint" title={t('app.errors.sourceTitle')}>
          {sourceLabel(t, entry.source)}
        </span>
        <strong className="font-mono tabular-nums">{entry.code}</strong>
        {entry.context === undefined ? null : (
          // An identifier (view id / connection label): never translated.
          <span className="font-mono tabular-nums text-fg-faint">{entry.context}</span>
        )}
      </div>
      <div>{text}</div>
      {entry.detail === undefined ? null : (
        <div className="text-fg-faint whitespace-pre-wrap break-words">{entry.detail}</div>
      )}
      {menu.state ? (
        <Menu label={t('menu.error.label')} at={menu.state.at} nodes={nodes} onClose={menu.close} />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */

const COPIED_FEEDBACK_MS = 1200

function sourceLabel(t: TFunction, source: ErrorSource): string {
  switch (source) {
    case 'ui':
      return t('app.errors.source.ui')
    case 'mcp':
      return t('app.errors.source.mcp')
    // peek's own embedded chat panel, told apart from an external client since
    // `source: 'agent'` was actually wired up.
    case 'agent':
      return t('app.errors.source.agent')
    case 'system':
      return t('app.errors.source.system')
  }
}

/**
 * Wall-clock time, in the reader's locale.
 *
 * The clipboard copy uses an ISO timestamp instead — a report that travels needs
 * an unambiguous instant, and a panel being read in place needs a glanceable one.
 */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/*
 * The panel's two dimensions, and the only styling here that is not a class.
 *
 * The other twelve declarations used to be inline too, with a comment saying why:
 * this is a self-contained overlay nobody else positions, and splitting it into
 * styles.css would have put half of it in a file owned by everybody. Utilities
 * grant that wish exactly — the declarations are on the elements, and there is no
 * shared file to put half of them in — so they are `className`s now.
 *
 * These two are not, because neither is a value the theme has any business
 * holding. `min(720px, calc(100vw - 16px))` is this panel's answer to a narrow
 * window; a `--spacing-*` token for it would also be a legal padding and a legal
 * gap, which is three generated classes for one fact. The settings dialog and
 * the disclosure dialog made the same call, and used to reach it from the
 * stylesheet side; both are inline `style` on their own shells now, so all three
 * arrive here the same way. See `components/modalClasses.ts` and the migration
 * record §18.2.
 *
 * The background moved from `var(--bg-elevated, var(--color-bg))` to `bg-bg`:
 * `--bg-elevated` has never been defined anywhere, so the fallback was the value
 * and the name in front of it was decoration.
 */
const PANEL_SIZE = {
  width: 'min(720px, calc(100vw - 16px))',
  maxHeight: 'min(60vh, 520px)',
} as const
