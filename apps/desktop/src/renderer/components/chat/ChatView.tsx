import { useCallback } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import { CHAT_PERMISSION_MODES, type ChatAgentStatus, type ChatPermissionMode, type ChatViewState } from '@peek/core'
import { useT } from '../../i18n'
import { useConnection, useViews } from '../../state/workspaceStore'
import { formatCount } from '../../util/format'
import { ViewError } from '../ViewError'
import { AttachmentBar } from './AttachmentBar'
import { cancelChat, clearChat, sendChat, setChatMode } from './chatCommands'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { PermissionPrompt } from './PermissionPrompt'
import { useChatChannelReady, useChatMessageCount } from './transcriptStore'

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
  const notReady = view.agentStatus === 'starting' || view.agentStatus === 'authenticating'
  const failed = view.agentStatus === 'error'

  const onSend = useCallback(
    (text: string) => {
      void sendChat(view.id, text)
    },
    [view.id],
  )

  const onStop = useCallback(() => {
    void cancelChat(view.id)
  }, [view.id])

  const onMode = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      void setChatMode(view.id, e.target.value as ChatPermissionMode)
    },
    [view.id],
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
            className={permissive(view.permissionMode) ? 'permissive' : undefined}
          >
            {CHAT_PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(modeKey(mode))}
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

        <button
          type="button"
          className="ghost"
          disabled={messageCount === 0 && view.messageCount === 0}
          title={t('chat.clearTitle')}
          onClick={() => {
            void clearChat(view.id)
          }}
        >
          {t('chat.clear')}
        </button>
      </div>

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
 * Modes that take the human out of the loop.
 *
 * Flagged rather than hidden. The contract is explicit that this list "exists to
 * be presented, not to be silently defaulted to its most permissive member" — so
 * the user may pick one, and the select says what they picked.
 */
function permissive(mode: ChatPermissionMode): boolean {
  return mode === 'dontAsk' || mode === 'bypassPermissions'
}

type StatusKey =
  | 'chat.status.idle'
  | 'chat.status.starting'
  | 'chat.status.authenticating'
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
