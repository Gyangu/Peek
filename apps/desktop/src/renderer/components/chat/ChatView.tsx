import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import {
  CHAT_PERMISSION_MODES,
  type ChatAgentStatus,
  type ChatPermissionMode,
  type ChatViewState,
} from '@peek/core'
import { useT } from '../../i18n'
import { useConnection, useViews } from '../../state/workspaceStore'
import { formatCount } from '../../util/format'
import { Button } from '../../ui/Button'
import { ViewError } from '../ViewError'
import { cancelChat, clearChat, sendChat, setChatMode } from './chatCommands'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { isPermissiveMode, needsModeConfirmation } from './permissionOptions'
import { PermissionPrompt } from './PermissionPrompt'
import { QuestionPrompt } from './QuestionPrompt'
import { composerDisabled, strandedOnSnapshot, transcriptState } from './panelState'
import { restoreChat, retryLoad, useChatChannelReady, useChatMessageCount } from './transcriptStore'

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
  const asking = view.pendingQuestion !== undefined || view.agentStatus === 'awaiting-answer'
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
  // Why both halves are required, and why this is not just `failed`, is in
  // `panelState.ts`.
  const stranded = strandedOnSnapshot(view)

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
    // `chat-view` carries no styles. It is the handle
    // `scripts/verify-chat-restore.mjs` drives the real window by — it finds the
    // panel and its composer over CDP — so it outlives the rule it used to name.
    <div className="chat-view flex flex-col h-full min-h-0 bg-bg">
      {/*
       * The shared view strip, with one deliberate difference: this row carries
       * two separators and a select, so it takes the wider of the two gaps.
       *
       * That difference is a **behaviour change**, not a restatement. The panel
       * had a rule of its own asking for the wider gap and it never took effect:
       * the shared strip's rule was one class specific too and later in the
       * sheet, so it won, and this row has been drawing at the narrow gap since
       * the two sheets were written. Measured in Electron against the built
       * stylesheet, before and after — 6px before, 8px now. Migration record
       * §17.4.
       */}
      <div className="flex h-bar flex-none items-center gap-snug overflow-hidden shadow-rule-b bg-bg-1 px-snug text-fg-dim">
        <span className="inline-flex items-center gap-tight whitespace-nowrap">
          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[view.agentStatus]}`} aria-hidden="true" />
          {t(statusKey(view.agentStatus))}
        </span>

        <span className="h-divider w-px flex-none bg-border-strong" />

        <label className="inline-flex items-center gap-tight" title={t('chat.mode.title')}>
          <span className="text-fg-faint">{t('chat.mode.label')}</span>
          {/* A mode that removes the human from the loop is flagged, never
              hidden — the amber border and text below, and the ⚠ in the option
              text for the reason the next comment gives.

              Both branches are written out whole rather than appended to a
              shared prefix: a class list has no cascade, so a state that changes
              a colour states the colour it wants instead of layering one over
              another (migration record §7.2). None of this could be classes at
              all until the `input, select, textarea` floor moved into
              `@layer base` — unlayered, its `font: inherit` and `border`
              outranked every utility, whatever the specificity. */}
          <select
            value={view.permissionMode}
            onChange={onMode}
            className={
              isPermissiveMode(view.permissionMode)
                ? 'px-tight py-px text-micro border-warn text-warn'
                : 'px-tight py-px text-micro'
            }
          >
            {CHAT_PERMISSION_MODES.map((mode) => (
              // The ⚠ is not decoration: the permissive modes used to be marked
              // by colour alone (`select.permissive`), which is nothing at all
              // to a reader who cannot separate --color-warn from --color-fg — and a
              // closed <select> shows one option, so the colour has nothing to
              // contrast against either.
              <option key={mode} value={mode}>
                {isPermissiveMode(mode) ? `⚠ ${t(modeKey(mode))}` : t(modeKey(mode))}
              </option>
            ))}
          </select>
          {/* Where this mode came from, and the reason settings may hold a mode
              that stops asking at all (`AGENT_DEFAULT_PERMISSION_MODES`). Shown
              only while nobody has touched the dropdown here: after that the
              mode is this conversation's own and there is nothing to disclose.

              Text, not a colour or an icon — it is a sentence about provenance,
              and the ⚠ beside it already carries the severity. */}
          {view.permissionModeInherited && view.permissionMode !== 'default' ? (
            <span className="text-fg-faint" title={t('chat.mode.inheritedTitle')}>
              {t('chat.mode.inherited')}
            </span>
          ) : null}
        </label>

        {conn ? (
          <>
            <span className="h-divider w-px flex-none bg-border-strong" />
            <span>{conn.label}</span>
          </>
        ) : null}

        <span className="flex-1" />

        {view.usage ? (
          <span className="font-mono tabular-nums text-micro text-fg-faint" title={t('chat.usageTitle')}>
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

      {/*
       * A conversation peek is showing from its own snapshot says so, and says
       * it differently depending on whether the agent's copy is still coming.
       *
       * The `strandedOnSnapshot` branch is the one that matters, and it is the
       * one rule this feature is not allowed to soften: the transcript on
       * screen is real, but the agent does not have it, so continuing the
       * conversation here would have the model answer questions it cannot see.
       * The composer below is disabled for that reason and no other. See
       * `design/2026-08-06-opening-a-stored-conversation.md` §2.4.
       */}
      {stranded ? (
        <div
          className="flex-none mx-tight mb-tight px-snug py-tight rounded-control select-text text-micro bg-warn-bg border border-warn"
          role="status"
        >
          <div className="font-semibold text-warn">{t('chat.snapshot.failed.title')}</div>
          <div className="mt-inset text-fg-dim">{t('chat.snapshot.failed.detail')}</div>
          <Button
            className="mt-tight"
            size="sm"
            onClick={() => {
              void retryLoad(view.chatId)
            }}
          >
            {t('chat.snapshot.retry')}
          </Button>
        </div>
      ) : view.showingSnapshot ? (
        // Still on its way. A quiet line rather than a warning: nothing is wrong,
        // the user is just reading a moment ahead of the agent.
        <div
          className="flex-none mx-tight mb-tight px-snug py-tight rounded-control select-text text-micro text-fg-faint bg-bg-2 border border-border"
          role="status"
        >
          {t('chat.snapshot.loading')}
        </div>
      ) : failed ? (
        // Shown while `agentStatus` is `error`. The composer beside it stays live
        // — sending is the retry — so this reads as an instruction, not as a wall.
        // The amber edge is the whole of the alarm: a bar down the leading side,
        // not a red block, because nothing here has failed permanently.
        <div
          className="flex-none mx-tight mb-tight px-snug py-tight rounded-control select-text text-micro text-fg-dim bg-bg-2 border border-l-2 border-border-strong border-l-warn"
          role="status"
        >
          {t('chat.retry.hint')}
        </div>
      ) : null}

      {channelReady ? null : (
        <div className="flex-none m-tight px-snug py-tight rounded-control select-text text-fg-dim bg-bg-2 border border-border-strong">
          <strong className="text-warn">{t('chat.gap.title')}</strong>
          <div>{t('chat.gap.detail')}</div>
        </div>
      )}

      {/* Which of the three, and why in that order, is `transcriptState`. */}
      {transcriptState(view.agentStatus, messageCount) === 'messages' ? (
        <MessageList chatId={view.chatId} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-tight px-block text-center text-fg-faint">
          {transcriptState(view.agentStatus, messageCount) === 'loading' ? (
            <>
              {/* The conversation's own title when the rail passed one through,
                  the generic line when it did not. Never a guess: a wrong title
                  here would be a claim about *which* conversation is loading. */}
              <div className="text-title text-fg-dim">{view.title ?? t('chat.loading.title')}</div>
              <div className="max-w-105 leading-prose">{t('chat.loading.hint')}</div>
            </>
          ) : (
            <>
              <div className="text-title text-fg-dim">{t('chat.empty.title')}</div>
              <div className="max-w-105 leading-prose">{t('chat.empty.hint')}</div>
            </>
          )}
        </div>
      )}

      {view.pendingPermission ? (
        <PermissionPrompt viewId={view.id} permission={view.pendingPermission} />
      ) : null}

      {/* Below the permission prompt, and never both: the agent cannot be
          blocked on a tool call and on a question of its own at the same moment
          — it asked one of them and is suspended in it. */}
      {view.pendingQuestion ? <QuestionPrompt viewId={view.id} question={view.pendingQuestion} /> : null}

      {/* The recovery placeholder below invites the user to send, which is right
          for a crashed agent and wrong for a stranded snapshot — there, sending
          is the one thing that must not happen. */}
      <Composer
        viewId={view.id}
        attachments={view.attachments}
        views={views}
        busy={busy}
        disabled={composerDisabled(view)}
        {...(blocked
          ? { disabledReason: t('chat.status.awaiting-permission') }
          : asking
            ? { disabledReason: t('chat.status.awaiting-answer') }
            : stranded
              ? { disabledReason: t('chat.snapshot.composer') }
              : notReady
                ? { disabledReason: t(statusKey(view.agentStatus)) }
                : {})}
        {...(failed && !stranded ? { placeholderOverride: t('chat.retry.placeholder') } : {})}
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
    // The same shape as `PermissionPrompt`, because it is the same kind of
    // moment: a question about authority that has to be answered deliberately.
    // It is reached from the toolbar's mode select — a control people click
    // through while looking for something else — and the two modes behind this
    // gate switch the tool approvals off for the rest of the conversation.
    <div
      className="flex-none m-tight px-snug py-snug rounded-control select-text bg-warn-bg border border-warn"
      role="group"
      aria-label={t('chat.mode.confirmTitle')}
      aria-live="assertive"
    >
      <div className="mb-tight font-semibold text-warn">{t('chat.mode.confirmTitle')}</div>
      <div className="mb-snug text-fg-dim">{t('chat.mode.confirmBody', { mode: t(modeKey(mode)) })}</div>
      <div className="flex flex-wrap gap-tight">
        <Button ref={cancelRef} onClick={onCancel}>
          {t('chat.mode.confirmCancel')}
        </Button>
        {/* Turning the asking off is not destructive — it is the other thing
            `caution` names: a choice whose consequence outlives the click. */}
        <Button variant="caution" action="chat.setMode" exposure="human-only" onClick={onAccept}>
          {t('chat.mode.confirmAccept')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The status pill's dot: what colour it is, and whether it breathes.
 *
 * One entry per member of `ChatAgentStatus`, so a new member is a type error
 * here rather than an uncoloured dot nobody notices — the same reason
 * `statusKey` below is written as an exhaustive switch.
 *
 * Exactly one `bg-*` per entry: a class list has no cascade, so a colour layered
 * over a base colour would be decided by Tailwind's emission order rather than
 * by the order written here. Alternatives, never overrides.
 *
 * `motion-reduce:animate-none` on the two that move. Nothing is carried by the
 * motion: a streaming agent is a solid --color-accent dot next to the word
 * "Streaming" whether or not it pulses, and it is still distinguishable from
 * idle (green) and error (red) with every animation stopped. The pulse is
 * emphasis. Any future state that is legible only while animating is a bug
 * against this comment. `@keyframes chat-pulse` is in chat.css; the shorthand it
 * is named by is `--animate-chat-pulse` in theme.css.
 */
const PULSE = 'animate-chat-pulse motion-reduce:animate-none'

const STATUS_DOT: Record<ChatAgentStatus, string> = {
  idle: 'bg-ok',
  ready: 'bg-ok',
  starting: `bg-accent ${PULSE}`,
  authenticating: `bg-accent ${PULSE}`,
  streaming: `bg-accent ${PULSE}`,
  'awaiting-permission': `bg-warn ${PULSE}`,
  // The same amber as a permission prompt, because to the person glancing at the
  // tab strip the two mean one thing: it stopped, and it stopped for you.
  'awaiting-answer': `bg-warn ${PULSE}`,
  error: 'bg-err',
  // Replaying a conversation off disk. Quiet on purpose — it is the one busy
  // state the user did not ask for and cannot hurry.
  loading: 'bg-fg-faint',
}

type StatusKey =
  | 'chat.status.idle'
  | 'chat.status.starting'
  | 'chat.status.authenticating'
  | 'chat.status.loading'
  | 'chat.status.ready'
  | 'chat.status.streaming'
  | 'chat.status.awaiting-permission'
  | 'chat.status.awaiting-answer'
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
    case 'awaiting-answer':
      return 'chat.status.awaiting-answer'
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
