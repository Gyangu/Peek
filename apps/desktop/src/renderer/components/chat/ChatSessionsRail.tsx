import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import {
  metaText,
  type ChatSessionInfo,
  type ChatSessionsListResult,
  type ViewId,
} from '@peek/core'
import { useLocale, useT, type TFunction } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { useViews } from '../../state/workspaceStore'
import { setChatRailCollapsed, useChatRailStore } from './railStore'
import { sessionCursorKey } from './sessionKeys'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import type { MenuNode } from '../../ui/menuModel'
import { useContextMenu } from '../../ui/useContextMenu'

/**
 * The conversation catalogue, as a rail down the right-hand side of the window.
 *
 * ## Why a rail and not a dialog
 *
 * Recorded in `design/2026-08-02-chat-sessions-side-rail.md`. A modal says "answer
 * one question and go away", which is right for `ConnectDialog` and wrong here:
 * users move between conversations *while* looking at data, and a mask makes
 * those two mutually exclusive. The left-hand connection sidebar is the same kind
 * of thing — a list you pick from repeatedly — and it is permanent.
 *
 * ## Why not a seventh view kind
 *
 * Unchanged from `design/2026-08-02-chat-session-management.md` §3.2: peek's six
 * view kinds are each a window onto *data*, and a list of conversations is not.
 * Being a rail rather than a dialog changes how it is present on screen, not
 * whether it is in `VIEW_KINDS`.
 *
 * ## Nothing here is mirrored
 *
 * The rows belong to the **agent**: they are read out of the transcripts it wrote
 * under its own working directory, and they can change without peek's
 * involvement. So they are fetched on open and on demand, never kept in the
 * Workspace — a second copy would be a second answer to "what conversations
 * exist", and only one of them could be right.
 *
 * The one thing this component *does* read from the Workspace is which
 * conversations are open right now, because that is a fact about the window
 * rather than about the agent.
 */
export function ChatSessionsRail(): ReactElement {
  const t = useT()
  const locale = useLocale()
  const views = useViews()
  const collapsed = useChatRailStore((s) => s.collapsed)
  /**
   * Keyboard cursor, as a row index.
   *
   * The list is a `listbox`, so it is **one** tab stop and the arrows move
   * inside it — twenty-seven conversations must not be twenty-seven stops on the
   * way to the workspace. Selection here means "the row the keyboard is on", not
   * "the conversation that is open": opening is an act, and this widget's act is
   * Enter.
   */
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  /**
   * The view the last click opened, as a fallback target for the double-click
   * that may follow it.
   *
   * A double-click fires `click` first, so by the time it arrives the row is
   * already open provisionally and the right answer is to *keep* that view, not
   * to open a second one. Normally the row itself knows the view id by then
   * (the patch has landed and `open` below has it); this covers the case where
   * it has not. Keyed by session so a double-click that lands on a *different*
   * row than the last click cannot upgrade the wrong conversation.
   */
  const justOpened = useRef<{ sessionId: string; viewId: ViewId } | null>(null)
  const [state, setState] = useState<ChatSessionsListResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback((): void => {
    setBusy(true)
    void dispatch('chat.sessions.list', {})
      .then((result) => {
        // `null` means the command failed and a toast has already been pushed;
        // this line only decides what the rail shows in its place.
        setFailed(result === null)
        if (result) setState(result)
      })
      .finally(() => {
        setBusy(false)
      })
  }, [])

  // Re-read when the rail comes back into view rather than only once at mount:
  // unlike the dialog it replaces, this component stays mounted for the life of
  // the window, so without this the list would age for as long as peek is open.
  // Collapsed costs nothing — the effect does not run while it stays collapsed.
  useEffect(() => {
    if (!collapsed) refresh()
  }, [refresh, collapsed])

  if (collapsed) {
    return (
      <div className="chat-rail collapsed">
        {/* The collapsed rail is 28px of chrome and this is all of it, so the
            handle fills it rather than sitting as a 24px square inside. Layout
            only — `ghost` still says what it looks like. */}
        <Button
          variant="ghost"
          icon
          className="chat-rail-handle"
          label={t('chat.sessions.expand')}
          aria-expanded={false}
          onClick={() => {
            setChatRailCollapsed(false)
          }}
        >
          ‹
        </Button>
      </div>
    )
  }

  /**
   * Session ids that already have a view.
   *
   * Keyed on both fields on purpose: `resumeSessionId` is what the user asked
   * for and exists from the moment the view opens, `agentSessionId` is what the
   * agent confirmed and is the only one a *new* conversation ever has. Reading
   * one alone would either mark a still-loading view as absent or miss every
   * conversation that was started rather than reopened.
   */
  const open = new Map<string, ViewId>()
  for (const view of views) {
    if (view.kind !== 'chat') continue
    if (view.resumeSessionId) open.set(view.resumeSessionId, view.id)
    if (view.agentSessionId) open.set(view.agentSessionId, view.id)
  }

  /**
   * The one act this list has, in its two strengths.
   *
   * - `keep: false` (a click, Enter) opens the conversation **provisionally**:
   *   the next one takes its tab back. Skimming the rail costs one tab, not one
   *   per row. Main owns that rule — see `ViewBase.provisional`.
   * - `keep: true` (a double-click, ⌘Enter) says the conversation is one to work
   *   in, so it gets a tab of its own.
   *
   * A row that is already open never opens twice: it is shown instead. The user
   * asked to look at that conversation, and there is only one of it.
   */
  const openRow = (sessionId: string, openViewId: ViewId | null, keep: boolean): void => {
    if (openViewId) {
      void dispatch('view.activate', { viewId: openViewId, focusPanel: true })
      if (keep) void dispatch('view.promote', { viewId: openViewId })
      return
    }
    // The double-click that follows a click must not open a second copy — it
    // upgrades what the click already opened.
    const just = justOpened.current
    if (keep && just && just.sessionId === sessionId) {
      void dispatch('view.promote', { viewId: just.viewId })
      return
    }
    void dispatch('view.open', {
      spec: { kind: 'chat', resumeSessionId: sessionId },
      provisional: !keep,
    }).then((result) => {
      justOpened.current = result ? { sessionId, viewId: result.viewId } : null
    })
  }

  const rows = state?.supported ? state.sessions : []

  const remove = (sessionId: string): void => {
    void dispatch('chat.sessions.delete', { sessionId }).then((result) => {
      if (!result) return
      // Drop the row locally rather than re-listing: the delete runs as an effect
      // and the agent may not have finished it yet, so an immediate re-read can
      // honestly return the conversation that is on its way out. The next manual
      // refresh — or the next time this rail is reopened — reads the truth.
      setState((prev) =>
        prev === null ? prev : { ...prev, sessions: prev.sessions.filter((s) => s.sessionId !== sessionId) },
      )
    })
  }

  return (
    <div className="chat-rail">
      <div className="sidebar-head">
        {/* `.sidebar-title`, shared with the connection sidebar: both heads are a
            title that gives up its width plus buttons grouped at the end. */}
        <span className="sidebar-title">{t('chat.sessions.title')}</span>
        <Button
          variant="ghost"
          title={t('chat.sessions.new')}
          aria-label={t('chat.sessions.new')}
          onClick={() => {
            void dispatch('view.open', { spec: { kind: 'chat' } })
          }}
        >
          ＋
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          title={t('chat.sessions.refresh')}
          aria-label={t('chat.sessions.refresh')}
          onClick={refresh}
        >
          ↻
        </Button>
        <Button
          variant="ghost"
          icon
          label={t('chat.sessions.collapse')}
          aria-expanded={true}
          onClick={() => {
            setChatRailCollapsed(true)
          }}
        >
          ›
        </Button>
      </div>

      {/* `listbox` and not a list of buttons: a row has two acts of different
          strength (open, keep) plus a menu, which no single button expresses,
          and twenty-seven buttons would be twenty-seven tab stops in front of
          the workspace. One stop, arrows inside — see `sessionListKeys`. */}
      <div
        ref={listRef}
        className="session-list"
        role={rows.length > 0 ? 'listbox' : undefined}
        aria-label={rows.length > 0 ? t('chat.sessions.title') : undefined}
        onKeyDown={(e) => {
          const next = sessionCursorKey(e.key, cursor, rows.length)
          if (next === null) return
          e.preventDefault()
          setCursor(next)
          const el = listRef.current?.querySelector(`[data-row="${next}"]`)
          if (el instanceof HTMLElement) el.focus()
        }}
      >
        {failed ? (
          <div className="empty-hint">{t('chat.sessions.failed')}</div>
        ) : state === null ? (
          <div className="empty-hint">{t('chat.sessions.loading')}</div>
        ) : !state.supported ? (
          <>
            <div>{t('chat.sessions.unsupported')}</div>
            <div className="empty-hint">{t('chat.sessions.unsupportedHint')}</div>
          </>
        ) : state.sessions.length === 0 ? (
          <>
            <div>{t('chat.sessions.empty')}</div>
            <div className="empty-hint">{t('chat.sessions.emptyHint')}</div>
          </>
        ) : (
          rows.map((session, index) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              t={t}
              locale={locale}
              index={index}
              cursor={cursor}
              onCursor={setCursor}
              openViewId={open.get(session.sessionId) ?? null}
              onOpen={(keep) => {
                // The rail stays put: reopening a conversation is exactly the
                // moment a user is most likely to reach for a second one.
                openRow(session.sessionId, open.get(session.sessionId) ?? null, keep)
              }}
              onDelete={() => {
                remove(session.sessionId)
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface RowProps {
  session: ChatSessionInfo
  t: TFunction
  locale: string
  /** Non-null when this conversation is already open somewhere in the window. */
  openViewId: ViewId | null
  /** Row position, and where the list's single keyboard cursor is. */
  index: number
  cursor: number
  onCursor: (index: number) => void
  /** `keep` distinguishes the two strengths of the one act — see `openRow`. */
  onOpen: (keep: boolean) => void
  onDelete: () => void
}

function SessionRow(props: RowProps): ReactElement {
  const { session, t, locale, openViewId, index, cursor } = props
  const busy = openViewId !== null
  const menu = useContextMenu<null>()
  const el = useRef<HTMLDivElement | null>(null)

  /**
   * The same two acts as the strip below, reachable without aiming.
   *
   * The strip stays. Unlike the sidebar's — which this change removed — it is
   * two lines in a rail that has room for them, and "Already open" is a status
   * this list is expected to show at a glance rather than on demand.
   *
   * Delete carries `confirm` instead of arming the strip's `ConfirmPair`: two
   * confirmation mechanisms for one act would be two places to get it wrong, and
   * the menu can honour the rule that matters — the second press lands on Cancel
   * — inside itself.
   */
  const nodes: MenuNode[] = [
    {
      kind: 'item',
      id: 'session.open',
      label: busy ? t('chat.sessions.reveal') : t('chat.sessions.open'),
      title: busy ? t('chat.sessions.revealTitle') : t('chat.sessions.openTitle'),
      onSelect: () => {
        // From the menu, always the strong form: choosing an item off a menu is
        // a deliberate act, and nothing about it says "I am only glancing".
        props.onOpen(true)
      },
    },
    {
      kind: 'item',
      id: 'session.delete',
      label: t('chat.sessions.delete'),
      title: busy ? t('chat.sessions.inUseTitle') : t('chat.sessions.deleteTitle'),
      disabled: busy,
      tone: 'danger',
      confirm: t('chat.sessions.deleteConfirm'),
      onSelect: props.onDelete,
    },
  ]

  /**
   * Click opens provisionally, double-click keeps — and the double-click does
   * **not** open a second time: `openRow` upgrades what the click just opened.
   * That is what makes the two gestures feel like one act with two strengths
   * rather than two competing acts, and it is why there is no click delay: the
   * cheap thing happens immediately, always.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onOpen(e.metaKey || e.ctrlKey || e.shiftKey)
      return
    }
    // Delete opens this row's menu rather than deleting: the confirmation lives
    // inside the menu, and a keyboard that could destroy a conversation without
    // passing through it would be a second, weaker rule for the same act.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const rect = el.current?.getBoundingClientRect()
      if (rect) menu.openAt(null, { x: rect.left + 8, y: rect.bottom })
    }
  }

  return (
    <div
      ref={el}
      className="session-item"
      role="option"
      data-row={index}
      aria-selected={index === cursor}
      tabIndex={index === cursor ? 0 : -1}
      aria-describedby={busy ? `${session.sessionId}-state` : undefined}
      onFocus={() => {
        props.onCursor(index)
      }}
      onClick={() => {
        props.onOpen(false)
      }}
      onDoubleClick={() => {
        props.onOpen(true)
      }}
      onKeyDown={onKeyDown}
      onContextMenu={menu.open(null)}
      title={busy ? t('chat.sessions.revealTitle') : t('chat.sessions.rowHint')}
    >
      <div className="session-row">
        {/* The title is the agent's summary of a conversation, which may have
            quoted a database cell verbatim — so it is untrusted text and gets the
            same treatment as any other: one line, no control characters, bounded
            length. React escapes the markup; `metaText` is what stops a title
            from forging a second line of this list. */}
        <span className="session-name">
          {session.title
            ? metaText(session.title, { maxLen: 120, truncationMark: '…' })
            : t('chat.sessions.untitled')}
        </span>
      </div>
      <div className="session-row">
        <span className="session-when">{formatWhen(session.updatedAt, locale)}</span>
        {/* "Already open" survives the strip's removal as a *reading* rather
            than a disabled button. It was never an action — it was the reason
            the action was unavailable — and this list is scanned, so it has to
            be visible without a gesture. */}
        {busy ? (
          <span className="session-when" id={`${session.sessionId}-state`}>
            {t('chat.sessions.inUse')}
          </span>
        ) : null}
      </div>
      {menu.state ? (
        <Menu label={t('menu.session.label')} at={menu.state.at} nodes={nodes} onClose={menu.close} />
      ) : null}
    </div>
  )
}

/**
 * The agent's ISO timestamp, as something a person reads.
 *
 * Absent or unparseable is rendered as nothing rather than as "Invalid Date":
 * `updatedAt` is optional in the protocol, and a missing time is not worth
 * saying out loud in a list already ordered by it.
 */
function formatWhen(iso: string | undefined, locale: string): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
}
