import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { MAX_CHAT_PROMPT_CHARS } from '@peek/core'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'

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
  const t = useT()
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
    <div className="flex-none flex flex-col gap-tight px-snug pt-tight pb-snug bg-bg-1 border-t border-border">
      <textarea
        ref={areaRef}
        // The growth range is `MIN_H`/`MAX_H` above, restated here as the two
        // classes that bound it — the effect below writes an explicit height
        // between them, and these are what the box falls back to.
        //
        // The line height is stated because `base.css`'s `font: inherit` is a
        // shorthand: it carries the body's 1.45 along with the size, and the
        // composer wants the looser 1.5 for prose somebody is drafting. It was a
        // rule in chat.css until that floor moved into `@layer base`; unlayered,
        // it beat this class whatever the specificity.
        className="font-mono tabular-nums w-full min-h-8.5 max-h-55 resize-none overflow-y-auto leading-prose"
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
      <div className="flex items-center gap-snug">
        <span className="text-micro text-fg-faint">{t('chat.composer.hint')}</span>
        <span className="flex-1" />
        {busy ? (
          /* Was `.chat-stop`, the third independent spelling of "this button is
             destructive" in the codebase. It is a `danger` variant now, and the
             class is gone. */
          <Button variant="danger" action="chat.cancel" onClick={onStop} title={t('chat.composer.stopTitle')}>
            ■ {t('chat.composer.stop')}
          </Button>
        ) : (
          <Button variant="primary" action="chat.send" disabled={!canSend} onClick={submit}>
            {t('chat.composer.send')}
          </Button>
        )}
      </div>
    </div>
  )
}
