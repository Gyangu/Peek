import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import { CHAT_PERMISSION_MODES, type ChatAgentStatus, type ChatPermissionMode, type ChatViewState } from '@peek/core'
import { useT } from '../../i18n'
import { useConnection, useViews } from '../../state/workspaceStore'
import { formatCount } from '../../util/format'
import { Button } from '../../ui/Button'
import { ViewError } from '../ViewError'
import { AttachmentBar } from './AttachmentBar'
import { cancelChat, clearChat, sendChat, setChatMode } from './chatCommands'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { isPermissiveMode, needsModeConfirmation } from './permissionOptions'
import { PermissionPrompt } from './PermissionPrompt'
import { restoreChat, useChatChannelReady, useChatMessageCount } from './transcriptStore'

import './chat.css'

/**
 * The chat panel, as an ordinary view.
 *
 * It is a `ViewState` kind like `table` and `query`, which is the whole point:
 * it goes wherever a view can go, so a conversation can sit beside the grid it
 * is about, be dragged into another panel, or be opened twice. Nothing in here
 * knows about panels — `ViewHost` dispatches on `kind` and this renders inside
 * whatever it is given.
 *
 * ## What this component owns, and what it does not
 *
 * It owns nothing. `ChatViewState` (status, mode, staged attachments, the
 * pending permission) comes from the Workspace mirror; the transcript comes from
 * the delta mirror; every change leaves as a Command. The only local state in
 * the whole panel is the half-typed draft in `Composer`, and the note there
 * explains why that is not state.
 */
export function ChatView({ view }: { view: ChatViewState }): ReactElement {
  const t = useT()
  const views = useViews()
  const conn = useConnection(view.connId ?? null)
  const channelReady = useChatChannelReady()
  const messageCount = useChatMessageCount(view.chatId)

  const busy = view.streamingMessageId !== null || view.agentStatus === 'streaming'
  const blocked = view.pendingPermission !== undefined || view.agentStatus === 'awaiting-permission'
  /**
   * States in which the composer genuinely cannot accept a message.
   *
   * `error` is **not** one of them, and that omission is the whole point. An
   * agent crash sets this status, and the host recovers on its own — it restarts
   * the process, and the next `chat.send` brings a fresh session up through
   * `#ensureSession` whether or not the automatic restart got there first. A
   * composer disabled on `error` turned that recoverable state into a dead panel:
   * the only way out was "Clear", which throws the conversation away, while the
   * toast peek itself shows promises the conversation is preserved. The status
   * pill still says `Error`; the input stays live, because trying again is
   * exactly what the user should do.
   */
  const notReady =
    view.agentStatus === 'starting' ||
    view.agentStatus === 'authenticating' ||
    // Replaying an existing conversation. Grouped with the bringup states rather
    // than with `streaming`: there is no turn to stop, so `busy` would put a stop
    // button over a conversation that is only being read off disk.
    view.agentStatus === 'loading'
  const failed = view.agentStatus === 'error'

  /**
   * The way back from a reload.
   *
   * Main keeps the conversation, the mirror does not survive a renderer restart,
   * and the delta stream is append-only so nothing repeats itself. The panel
   * therefore asks — once per conversation, and only when it has nothing, so a
   * live conversation is never interrupted to re-fetch what it can already see.
   *
   * The count that gates this is the **mirror's**, not `view.messageCount` from
   * the Workspace. Comparing the two would make the request more precise ("main
   * says nine, I have none") and would also mean never asking when that number
   * is wrong — which, after a reload, is exactly the situation. A round trip
   * that answers `false` is the cheaper mistake, and `restoreChat` is idempotent
   * per conversation regardless.
   */
  useEffect(() => {
    if (!channelReady || messageCount > 0) return
    void restoreChat(view.chatId)
  }, [channelReady, messageCount, view.chatId])

  const onSend = useCallback(
    (text: string) => {
      void sendChat(view.id, text)
    },
    [view.id],
  )

  const onStop = useCallback(() => {
    void cancelChat(view.id)
  }, [view.id])

  /**
   * A mode change that removes the human from the loop is confirmed first.
   *
   * The select sits in a toolbar people click through while looking for
   * something else, and two of its six entries switch tool approvals off for the
   * rest of the conversation. Nothing else in peek lets one click on a dropdown
   * do that much, so this is the one control that gets a second question.
   *
   * The select is controlled by `view.permissionMode`, so *not* dispatching is
   * all it takes to leave it where it was — the box snaps back on its own while
   * the confirmation is up, which is the honest reading: nothing has changed yet.
   */
  const [pendingMode, setPendingMode] = useState<ChatPermissionMode | null>(null)

  const onMode = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as ChatPermissionMode
      if (needsModeConfirmation(next, view.permissionMode)) {
        setPendingMode(next)
        return
      }
      void setChatMode(view.id, next)
    },
    [view.id, view.permissionMode],
  )

  return (
    <div className="chat-view">
      <div className="toolbar chat-toolbar">
        <span className={`chat-status ${view.agentStatus}`}>
          <span className="chat-status-dot" aria-hidden="true" />
          {t(statusKey(view.agentStatus))}
        </span>

        <span className="sep" />

        <label className="chat-mode" title={t('chat.mode.title')}>
          <span className="chat-mode-label">{t('chat.mode.label')}</span>
          <select
            value={view.permissionMode}
            onChange={onMode}
            className={isPermissiveMode(view.permissionMode) ? 'permissive' : undefined}
          >
            {CHAT_PERMISSION_MODES.map((mode) => (
              // The ⚠ is not decoration: the permissive modes used to be marked
              // by colour alone (`select.permissive`), which is nothing at all
              // to a reader who cannot separate --warn from --fg — and a
              // closed <select> shows one option, so the colour has nothing to
              // contrast against either.
              <option key={mode} value={mode}>
                {isPermissiveMode(mode) ? `⚠ ${t(modeKey(mode))}` : t(modeKey(mode))}
              </option>
            ))}
          </select>
        </label>

        {conn ? (
          <>
            <span className="sep" />
            <span>{conn.label}</span>
          </>
        ) : null}

        <span className="grow" />

        {view.usage ? (
          <span className="chat-usage mono" title={t('chat.usageTitle')}>
            {t('chat.usage', {
              used: formatCount(view.usage.used),
              size: formatCount(view.usage.size),
            })}
          </span>
        ) : null}

        <Button
          variant="ghost"
          disabled={messageCount === 0 && view.messageCount === 0}
          title={t('chat.clearTitle')}
          onClick={() => {
            void clearChat(view.id)
          }}
        >
          {t('chat.clear')}
        </Button>
      </div>

      {pendingMode === null ? null : (
        <ModeConfirm
          mode={pendingMode}
          onCancel={() => {
            setPendingMode(null)
          }}
          onAccept={() => {
            void setChatMode(view.id, pendingMode)
            setPendingMode(null)
          }}
        />
      )}

      <ViewError error={view.error} />

      {failed ? (
        <div className="chat-retry" role="status">
          {t('chat.retry.hint')}
        </div>
      ) : null}

      {channelReady ? null : (
        <div className="chat-gap">
          <strong>{t('chat.gap.title')}</strong>
          <div>{t('chat.gap.detail')}</div>
        </div>
      )}

      {messageCount === 0 ? (
        <div className="chat-empty">
          <div className="chat-empty-title">{t('chat.empty.title')}</div>
          <div className="chat-empty-hint">{t('chat.empty.hint')}</div>
        </div>
      ) : (
        <MessageList chatId={view.chatId} />
      )}

      {view.pendingPermission ? (
        <PermissionPrompt viewId={view.id} permission={view.pendingPermission} />
      ) : null}

      <AttachmentBar viewId={view.id} attachments={view.attachments} views={views} />

      <Composer
        busy={busy}
        disabled={notReady || blocked}
        {...(blocked
          ? { disabledReason: t('chat.status.awaiting-permission') }
          : notReady
            ? { disabledReason: t(statusKey(view.agentStatus)) }
            : {})}
        {...(failed ? { placeholderOverride: t('chat.retry.placeholder') } : {})}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  )
}

/**
 * The second question, asked once, before the approvals go away.
 *
 * Focus lands on **Keep asking me**, not on the accepting button. This is a
 * confirmation the user walked into deliberately, so a default is appropriate —
 * and the default a confirmation offers should be the one that changes nothing.
 * (Contrast `PermissionPrompt`, which pre-focuses no button at all: there the
 * panel appears on the agent's schedule, not the user's, so *any* default would
 * be under whatever key they were about to press.)
 */
function ModeConfirm({
  mode,
  onAccept,
  onCancel,
}: {
  mode: ChatPermissionMode
  onAccept: () => void
  onCancel: () => void
}): ReactElement {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <div className="chat-mode-confirm" role="group" aria-label={t('chat.mode.confirmTitle')} aria-live="assertive">
      <div className="chat-mode-confirm-title">{t('chat.mode.confirmTitle')}</div>
      <div className="chat-mode-confirm-body">
        {t('chat.mode.confirmBody', { mode: t(modeKey(mode)) })}
      </div>
      <div className="chat-mode-confirm-actions">
        <Button ref={cancelRef} onClick={onCancel}>
          {t('chat.mode.confirmCancel')}
        </Button>
        {/* Turning the asking off is not destructive — it is the other thing
            `caution` names: a choice whose consequence outlives the click. */}
        <Button
          variant="caution"
          action="chat.setMode"
          exposure="human-only"
          onClick={onAccept}
        >
          {t('chat.mode.confirmAccept')}
        </Button>
      </div>
    </div>
  )
}

type StatusKey =
  | 'chat.status.idle'
  | 'chat.status.starting'
  | 'chat.status.authenticating'
  | 'chat.status.loading'
  | 'chat.status.ready'
  | 'chat.status.streaming'
  | 'chat.status.awaiting-permission'
  | 'chat.status.error'

type ModeKey =
  | 'chat.mode.auto'
  | 'chat.mode.default'
  | 'chat.mode.acceptEdits'
  | 'chat.mode.plan'
  | 'chat.mode.dontAsk'
  | 'chat.mode.bypassPermissions'

function statusKey(status: ChatAgentStatus): StatusKey {
  switch (status) {
    case 'idle':
      return 'chat.status.idle'
    case 'starting':
      return 'chat.status.starting'
    case 'authenticating':
      return 'chat.status.authenticating'
    case 'loading':
      return 'chat.status.loading'
    case 'ready':
      return 'chat.status.ready'
    case 'streaming':
      return 'chat.status.streaming'
    case 'awaiting-permission':
      return 'chat.status.awaiting-permission'
    case 'error':
      return 'chat.status.error'
  }
}

function modeKey(mode: ChatPermissionMode): ModeKey {
  switch (mode) {
    case 'auto':
      return 'chat.mode.auto'
    case 'default':
      return 'chat.mode.default'
    case 'acceptEdits':
      return 'chat.mode.acceptEdits'
    case 'plan':
      return 'chat.mode.plan'
    case 'dontAsk':
      return 'chat.mode.dontAsk'
    case 'bypassPermissions':
      return 'chat.mode.bypassPermissions'
  }
}
