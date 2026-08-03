import { useState } from 'react'
import type { ReactElement } from 'react'
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
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
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
       * renamed to `.cell`; `.btn` already provides what it declared.)
       */}
      <Button
        variant="ghost"
        title={t('app.errors.openTitle')}
        aria-expanded={open}
        onClick={toggleErrorCenter}
      >
        <span className={unseen > 0 ? 'err' : undefined}>
          ⚠ {unseen > 0 ? t('app.errors.unseen', { count: unseen }) : t('app.errors.count', { count })}
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
  const [copied, setCopied] = useState<number | 'all' | null>(null)

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
    <div className="error-center" role="dialog" aria-label={t('app.errors.title')} style={PANEL_STYLE}>
      <div className="toolbar" style={HEADER_STYLE}>
        <strong>{t('app.errors.title')}</strong>
        <span className="grow" />
        <Button
          variant="ghost"
          onClick={() => {
            copy(formatErrorLog(entries), 'all')
          }}
        >
          {copied === 'all' ? t('app.errors.copied') : t('app.errors.copyAll')}
        </Button>
        <Button variant="ghost" onClick={clearErrorLog}>
          {t('app.errors.clear')}
        </Button>
        <Button variant="ghost" title={t('app.errors.close')} onClick={closeErrorCenter}>
          ✕
        </Button>
      </div>

      <div style={LIST_STYLE}>
        {ordered.length === 0 ? (
          <div style={{ padding: '12px', color: 'var(--fg-faint)' }}>{t('app.errors.empty')}</div>
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
    </div>
  )
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
    <div className="error-row" style={ROW_STYLE} onContextMenu={menu.open(null)} title={t('menu.hint')}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        <span className="mono" style={{ color: 'var(--fg-faint)' }}>
          {formatClock(entry.ts)}
        </span>
        <span className="mono" title={t('app.errors.sourceTitle')} style={SOURCE_STYLE}>
          {sourceLabel(t, entry.source)}
        </span>
        <strong className="mono">{entry.code}</strong>
        {entry.context === undefined ? null : (
          // An identifier (view id / connection label): never translated.
          <span className="mono" style={{ color: 'var(--fg-faint)' }}>
            {entry.context}
          </span>
        )}
      </div>
      <div>{text}</div>
      {entry.detail === undefined ? null : (
        <div className="detail" style={DETAIL_STYLE}>
          {entry.detail}
        </div>
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
 * Inline styles rather than stylesheet rules, on purpose and only here: this
 * component is a self-contained overlay that no other component positions, and
 * splitting eight declarations into styles.css would put half of it in a file
 * owned by everybody. The colours are all existing custom properties, so it
 * follows the theme like everything else.
 */
const PANEL_STYLE = {
  position: 'fixed',
  right: '8px',
  bottom: '32px',
  width: 'min(720px, calc(100vw - 16px))',
  maxHeight: 'min(60vh, 520px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-elevated, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
  zIndex: 60,
} as const

const HEADER_STYLE = { flex: '0 0 auto' } as const

const LIST_STYLE = { overflowY: 'auto', overflowX: 'hidden' } as const

const ROW_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  padding: '6px 10px',
  borderTop: '1px solid var(--border)',
} as const

const SOURCE_STYLE = { color: 'var(--fg-faint)' } as const

const DETAIL_STYLE = {
  color: 'var(--fg-faint)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const
