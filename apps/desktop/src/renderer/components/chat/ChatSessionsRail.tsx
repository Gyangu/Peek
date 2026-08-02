import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { metaText, type ChatSessionInfo, type ChatSessionsListResult } from '@peek/core'
import { useLocale, useT, type TFunction } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { useViews } from '../../state/workspaceStore'
import { ConfirmPair } from '../ConfirmPair'
import { setChatRailCollapsed, useChatRailStore } from './railStore'
import { Button } from '../../ui/Button'

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
  const [state, setState] = useState<ChatSessionsListResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The row whose delete button has been armed; two clicks, no modal. */
  const [confirming, setConfirming] = useState<string | null>(null)

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
        <Button
          variant="ghost"
          icon
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
  const open = new Map<string, string>()
  for (const view of views) {
    if (view.kind !== 'chat') continue
    if (view.resumeSessionId) open.set(view.resumeSessionId, view.id)
    if (view.agentSessionId) open.set(view.agentSessionId, view.id)
  }

  const remove = (sessionId: string): void => {
    setConfirming(null)
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
        <span className="chat-rail-title">{t('chat.sessions.title')}</span>
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

      <div className="session-list">
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
          state.sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              t={t}
              locale={locale}
              openViewId={open.get(session.sessionId) ?? null}
              confirming={confirming === session.sessionId}
              onOpen={() => {
                // The rail stays put: reopening a conversation is exactly the
                // moment a user is most likely to reach for a second one.
                void dispatch('view.open', { spec: { kind: 'chat', resumeSessionId: session.sessionId } })
              }}
              onArmDelete={() => {
                setConfirming(session.sessionId)
              }}
              onDisarmDelete={() => {
                setConfirming(null)
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
  openViewId: string | null
  confirming: boolean
  onOpen: () => void
  onArmDelete: () => void
  onDisarmDelete: () => void
  onDelete: () => void
}

function SessionRow(props: RowProps): ReactElement {
  const { session, t, locale, openViewId, confirming } = props
  const busy = openViewId !== null

  return (
    <div className="session-item">
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
      </div>
      <div className="conn-actions">
        <Button
          variant="ghost"
          disabled={busy}
          title={busy ? t('chat.sessions.inUseTitle') : t('chat.sessions.openTitle')}
          onClick={props.onOpen}
        >
          {busy ? t('chat.sessions.inUse') : t('chat.sessions.open')}
        </Button>
        {/* Two clicks rather than a modal, exactly as forgetting a saved
            connection works: it cannot be undone, but a dialog in front of it
            would be heavier than the act deserves. Cancel takes the position
            the Delete button had — see ConfirmPair. */}
        <ConfirmPair
          armed={confirming}
          disabled={busy}
          title={busy ? t('chat.sessions.inUseTitle') : t('chat.sessions.deleteTitle')}
          label={t('chat.sessions.delete')}
          confirmLabel={t('chat.sessions.deleteConfirm')}
          cancelLabel={t('chat.sessions.deleteCancel')}
          onArm={props.onArmDelete}
          onDisarm={props.onDisarmDelete}
          onConfirm={props.onDelete}
        />
      </div>
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
