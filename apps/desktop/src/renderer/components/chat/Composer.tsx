import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { MAX_CHAT_PROMPT_CHARS } from '@peek/core'
import { useChatT } from './i18n'

const MIN_H = 34
const MAX_H = 220

/**
 * The input box.
 *
 * ## The draft is the one thing that stays local
 *
 * Everything else in this panel is a Command, but half-typed text is not state:
 * it has no meaning to main, no meaning to `read_workspace`, and no reader other
 * than the person typing it. Sending it to the Command Bus on every keystroke
 * would be the token-per-patch mistake `chat.ts` exists to avoid, in a second
 * place. It becomes state the moment it is sent, and `chat.send` is where that
 * happens.
 *
 * ## IME composition
 *
 * Enter sends — except while an input method is composing, where Enter commits
 * the candidate. Ignoring that would make the panel unusable in Chinese and
 * Japanese: every attempt to pick a character would fire off a half-written
 * message. `isComposing` is checked on the native event, and `keyCode === 229`
 * covers the browsers that report composition only that way.
 */
export function Composer({
  busy,
  disabled,
  disabledReason,
  placeholderOverride,
  onSend,
  onStop,
}: {
  /** A turn is streaming: the send button becomes a stop button. */
  busy: boolean
  /** The agent cannot take a prompt at all (starting up, awaiting permission). */
  disabled: boolean
  disabledReason?: string
  /**
   * Prompt shown instead of the usual one while the box is still usable.
   *
   * Distinct from `disabledReason`: after a crash the agent is broken *and* the
   * next message is what fixes it, so the box has to keep taking input while
   * saying something different from "ask about this data".
   */
  placeholderOverride?: string
  onSend: (text: string) => void
  onStop: () => void
}): ReactElement {
  const t = useChatT()
  const [draft, setDraft] = useState('')
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)

  // Grow with the content, up to a ceiling — past that the box scrolls, so a
  // pasted essay cannot swallow the transcript.
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight))}px`
  }, [draft])

  useEffect(() => {
    if (!disabled && !busy) areaRef.current?.focus()
  }, [disabled, busy])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (text === '') return
    onSend(text)
    setDraft('')
  }, [draft, onSend])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key !== 'Enter') return
      if (e.shiftKey) return // newline
      if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
      e.preventDefault()
      if (busy || disabled) return
      submit()
    },
    [busy, disabled, submit],
  )

  const canSend = draft.trim() !== '' && !busy && !disabled

  return (
    <div className="chat-composer">
      <textarea
        ref={areaRef}
        className="chat-input mono"
        value={draft}
        rows={1}
        maxLength={MAX_CHAT_PROMPT_CHARS}
        spellCheck={false}
        placeholder={
          disabled
            ? (disabledReason ?? t('chat.composer.notReady'))
            : (placeholderOverride ?? t('chat.composer.placeholder'))
        }
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
      />
      <div className="chat-composer-bar">
        <span className="chat-composer-hint">{t('chat.composer.hint')}</span>
        <span className="grow" />
        {busy ? (
          <button type="button" className="chat-stop" onClick={onStop} title={t('chat.composer.stopTitle')}>
            ■ {t('chat.composer.stop')}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!canSend} onClick={submit}>
            {t('chat.composer.send')}
          </button>
        )}
      </div>
    </div>
  )
}
