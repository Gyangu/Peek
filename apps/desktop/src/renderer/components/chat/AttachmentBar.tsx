import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChatAttachment, ViewId, ViewState } from '@peek/core'
import { useT } from '../../i18n'
import { ConsentDialog } from '../context-actions/ConsentDialog'
import { useContextActions } from '../context-actions/useContextActions'
import { viewTitleOf } from '../panelTitle'
import { attachCandidates, attachmentKindKey, attachmentLabel, stageableAttachment } from './attachments'
import { detachFromChat } from './chatCommands'
import { useChatT } from './i18n'

/**
 * Staged context.
 *
 * ## Where the data is (and is not)
 *
 * These chips are `ChatAttachment` descriptors read straight out of the
 * Workspace mirror — the panel keeps no copy and stages nothing locally. Adding
 * is `chat.attach`, removing is `chat.detach`, and the bar redraws when the
 * patch comes back. That is not ceremony: it is what makes the AI's
 * `read_workspace` and the human's screen agree on what is pinned.
 *
 * ## Two entry points, on purpose
 *
 * A grid selection attaches itself (the data view owns that gesture — a chip bar
 * has no idea which rows are highlighted). This menu covers the other direction:
 * the user is looking at the *chat*, and wants to hand over the workspace, a
 * result set or the SQL of a query without going back to find it.
 *
 * ## Both entry points go through the same gate
 *
 * Staging happens through `useContextActions`, not through `chat.attach`
 * directly, and that is the whole reason it is worth the indirection: the
 * disclosure that this data leaves the machine has to be shown before the *first*
 * attachment, whichever gesture made it. This menu used to dispatch straight past
 * it, which meant a user who only ever attached from here was never told.
 */
export function AttachmentBar({
  viewId,
  attachments,
  views,
}: {
  viewId: ViewId
  attachments: readonly ChatAttachment[]
  views: readonly ViewState[]
}): ReactElement {
  const t = useT()
  const ct = useChatT()
  const actions = useContextActions()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const candidates = useMemo(
    () =>
      attachCandidates(views, {
        workspace: ct('chat.attach.option.workspace'),
        workspaceHint: ct('chat.attach.option.workspaceHint'),
        resultOf: (view) => ct('chat.attach.option.result', { view }),
        queryOf: (view) => ct('chat.attach.option.query', { view }),
        viewName: (view) => viewTitleOf(t, view),
      }),
    [views, t, ct],
  )

  // Dismiss on a click elsewhere or on Escape — the same two gestures every
  // other transient surface in peek closes on.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const remove = useCallback(
    (attachment: ChatAttachment) => {
      void detachFromChat(viewId, [attachment.id])
    },
    [viewId],
  )

  return (
    <div className="chat-attach-bar" ref={boxRef}>
      <span className="chat-attach-label">{ct('chat.attach.label')}</span>

      {attachments.length === 0 ? (
        <span className="chat-attach-empty">{ct('chat.attach.empty')}</span>
      ) : (
        attachments.map((a) => (
          <span key={a.id} className="chat-chip" title={attachmentLabel(a)}>
            <span className="chat-chip-kind">{ct(attachmentKindKey(a.kind))}</span>
            <span className="chat-chip-label">{attachmentLabel(a)}</span>
            <button
              type="button"
              className="chat-chip-x"
              aria-label={ct('chat.attach.remove')}
              title={ct('chat.attach.remove')}
              onClick={() => {
                remove(a)
              }}
            >
              ×
            </button>
          </span>
        ))
      )}

      <span className="grow" />

      <button
        type="button"
        className="ghost chat-attach-add"
        title={ct('chat.attach.addTitle')}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        + {ct('chat.attach.add')}
      </button>

      {open ? (
        <div className="chat-attach-menu">
          {candidates.length === 0 ? (
            <div className="chat-attach-none">{ct('chat.attach.noCandidates')}</div>
          ) : (
            candidates.map((c) => (
              <button
                key={c.key}
                type="button"
                className="chat-attach-option"
                onClick={() => {
                  setOpen(false)
                  void actions.add(stageableAttachment(c.spec, c.label), viewId)
                }}
              >
                <span className="chat-attach-option-label">{c.label}</span>
                {c.hint ? <span className="chat-attach-option-hint mono">{c.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* Held, not dropped: accepting stages the attachment the user asked for,
          so the gesture survives reading the disclosure. */}
      {actions.consentPending ? (
        <ConsentDialog onAccept={actions.acceptConsent} onCancel={actions.cancelConsent} />
      ) : null}
    </div>
  )
}
