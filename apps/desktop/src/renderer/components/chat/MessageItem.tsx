import { memo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChatAttachment, ChatAttachmentReceipt, ChatMessage } from '@peek/core'
import { useErrorText, useT } from '../../i18n'
import { detailFor } from '../context-actions/chipDetail'
import { attachmentKindKey, attachmentLabel } from './attachments'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'

/**
 * One message in the transcript.
 *
 * Memoized on the message object, which the store replaces **only** for the
 * message that actually changed (see `transcriptStore`). While the agent
 * streams, every other item in the list bails out of rendering here.
 */
export const MessageItem = memo(function MessageItem({
  message,
}: {
  message: ChatMessage
}): ReactElement {
  const t = useT()
  const errorText = useErrorText(message.error)
  const isUser = message.role === 'user'

  return (
    <article className={`chat-msg ${message.role}${message.complete ? '' : ' streaming'}`}>
      <div className="chat-msg-head">
        <span className="chat-msg-role">{isUser ? t('chat.role.user') : t('chat.role.agent')}</span>
        {message.complete ? null : <span className="chat-msg-live">{t('chat.writing')}</span>}
      </div>

      <div className="chat-msg-body">
        {message.blocks.map((block, i) => {
          switch (block.type) {
            case 'text':
              // A user turn is what the user typed, not Markdown someone else
              // wrote: rendering it as Markdown would mangle a pasted SQL
              // fragment or a value containing underscores.
              return isUser ? (
                <div key={i} className="chat-user-text">
                  {block.text}
                </div>
              ) : (
                <Markdown key={i} text={block.text} />
              )
            case 'thought':
              return <ThoughtBlock key={i} text={block.text} />
            case 'tool':
              return <ToolCallCard key={block.call.toolCallId} call={block.call} />
          }
        })}
      </div>

      {message.attachments && message.attachments.length > 0 ? (
        <div className="chat-msg-attachments" title={t('chat.attach.sentWith')}>
          {message.attachments.map((a) => (
            <AttachmentReceipt
              key={a.id}
              attachment={a}
              receipt={message.attachmentReceipts?.find((r) => r.attachmentId === a.id)}
            />
          ))}
        </div>
      ) : null}

      {errorText ? (
        <div className="chat-msg-error">
          <strong>{t('chat.error.title')}</strong>
          {message.error ? <span className="mono"> [{message.error.code}]</span> : null}
          <div>{errorText}</div>
        </div>
      ) : null}

      {message.stopReason && message.stopReason !== 'end_turn' && !errorText ? (
        <div className="chat-msg-stop">{t(stopKey(message.stopReason))}</div>
      ) : null}
    </article>
  )
})

function stopKey(
  reason: NonNullable<ChatMessage['stopReason']>,
):
  | 'chat.stop.cancelled'
  | 'chat.stop.max_tokens'
  | 'chat.stop.max_turn_requests'
  | 'chat.stop.refusal'
  | 'chat.stop.error' {
  switch (reason) {
    case 'cancelled':
      return 'chat.stop.cancelled'
    case 'max_tokens':
      return 'chat.stop.max_tokens'
    case 'max_turn_requests':
      return 'chat.stop.max_turn_requests'
    case 'refusal':
      return 'chat.stop.refusal'
    // `end_turn` never reaches here (the caller filters it); `error` is the
    // catch-all the delta carries when a turn died without a stop reason.
    case 'end_turn':
    case 'error':
      return 'chat.stop.error'
  }
}

/**
 * The agent's reasoning, collapsed by default.
 *
 * Worth keeping in mind while reading the layout: current models default
 * thinking to "omitted" and stream signature-only blocks, so these are **rare in
 * practice**. The path exists and is correct; nothing above it assumes it will
 * appear.
 */
function ThoughtBlock({ text }: { text: string }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className={`chat-thought${open ? ' open' : ''}`}>
      <button
        type="button"
        className="chat-thought-head ghost"
        onClick={() => {
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        title={open ? t('chat.thought.hide') : t('chat.thought.show')}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {t('chat.thought')}
      </button>
      {open ? <div className="chat-thought-body">{text}</div> : null}
    </div>
  )
}

/**
 * What was attached to a turn, shown after the fact so the transcript is a
 * record.
 *
 * This is also where the *user* half of "never truncate silently" is paid.
 * `budget.ts` writes what was cut into the document the model reads; the same
 * fact rides back as a `ChatAttachmentReceipt` and is shown here. Without it a
 * person who staged twelve thousand rows would have no way to know that a
 * hundred went, and would trust a total computed over the hundred.
 *
 * The detail is rendered from the general catalog (`useT`) rather than the chat
 * one, because the sentences already exist there — they are the same phrases the
 * attachment chips use, and having two translations of "first {n} of {m} rows"
 * is how the two drift apart.
 */
function AttachmentReceipt({
  attachment,
  receipt,
}: {
  attachment: ChatAttachment
  receipt: ChatAttachmentReceipt | undefined
}): ReactElement {
  const t = useT()
  const detail = detailFor(
    receipt === undefined
      ? undefined
      : { ...(receipt.notice ? { notice: receipt.notice } : {}), ...(receipt.failed === true ? { failed: true } : {}) },
    t,
  )
  return (
    <span className={`chat-chip receipt${receipt?.failed === true ? ' failed' : ''}`}>
      <span className="chat-chip-kind">{t(attachmentKindKey(attachment.kind))}</span>
      <span className="chat-chip-label">{attachmentLabel(attachment)}</span>
      {detail === null ? null : <span className="chat-chip-detail">{detail}</span>}
    </span>
  )
}
