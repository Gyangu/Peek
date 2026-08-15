import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { MAX_CHAT_PROMPT_CHARS, type ChatAttachment, type ViewId, type ViewState } from '@peek/core'
import { useT } from '../../i18n'
import { useGridSelectionStore } from '../../state/gridSelectionStore'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { ConsentDialog } from '../context-actions/ConsentDialog'
import { useContextActions } from '../context-actions/useContextActions'
import { AttachMenu } from './AttachMenu'
import { AttachmentStrip } from './AttachmentStrip'
import { attachCandidates, attachmentIdentity, stageableAttachment, type AttachCandidate } from './attachments'
import { detachFromChat } from './chatCommands'
import { applyMention, atomicBackspace, dropMention, filterByMention, findMention, hasMention } from './mention'

const MIN_H = 34
const MAX_H = 220

/**
 * The input box, and everything that rides on the next message.
 *
 * Top to bottom: what this message will carry (`AttachmentStrip`), what it says
 * (the textarea), and how to send it. One box, because that is one message —
 * the chips used to be a separate bar above, which drew them as a sibling of the
 * input rather than part of it (design/2026-08-14-composer-inline-context.md §2.1).
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
 * `@` does not bend that rule, but it does sit next to it. Picking a candidate
 * writes `@public.orders` into the draft as plain text **and** stages an
 * attachment, and from then on the two are bound: delete the word and the
 * attachment goes, remove the chip and the word goes (§2.3.1). What still never
 * happens is the draft itself reaching main — `chat.detach` fires when a
 * reference is *dropped*, once, exactly as it does when the chip's ✕ is clicked.
 * That is one intent, not one keystroke.
 *
 * Two pieces make it safe. `mentions` below tracks only what was picked from the
 * list, so a hand-typed `@orders` attaches nothing and detaches nothing; and
 * `atomicBackspace` deletes a mention whole, so there is no half-deleted word to
 * interpret.
 *
 * ## IME composition
 *
 * Enter sends — except while an input method is composing, where Enter commits
 * the candidate. Ignoring that would make the panel unusable in Chinese and
 * Japanese: every attempt to pick a character would fire off a half-written
 * message. `isComposing` is checked on the native event, and `keyCode === 229`
 * covers the browsers that report composition only that way. The `@` popover
 * obeys the same rule — while composing, ↑↓ and Enter belong to the IME, not to
 * the candidate list.
 */
export function Composer({
  viewId,
  attachments,
  views,
  busy,
  disabled,
  disabledReason,
  placeholderOverride,
  onSend,
  onStop,
}: {
  /** The chat view this composer belongs to; where `@` attaches. */
  viewId: ViewId
  /** Staged context, straight from the Workspace mirror. */
  attachments: readonly ChatAttachment[]
  /** Every open view, which is what `@` can offer. */
  views: readonly ViewState[]
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
  const actions = useContextActions()
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  /**
   * The `@` the user dismissed with Escape, by position.
   *
   * Remembered rather than a plain "closed" flag because the mention is derived
   * from the text: a boolean would be re-opened by the next keystroke, which is
   * the opposite of what Escape said.
   */
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)
  /**
   * Mentions this composer put in the draft: attachment identity → the word.
   *
   * A ref and not state — nothing renders off it, and it must be readable inside
   * the keydown handler without a stale closure. Identity rather than
   * `AttachmentId` because the id arrives later (main mints it) and may never
   * arrive at all if the disclosure dialog is cancelled; the entry is then
   * harmlessly stale and is dropped by the reconcile below.
   */
  const mentions = useRef(new Map<string, string>())

  const mention = useMemo(() => findMention(draft, caret), [draft, caret])
  const menuOpen = mention !== null && dismissed !== mention.start && !disabled
  const selection = useGridSelectionStore((s) => s.selection)
  const candidates = useMemo(() => attachCandidates(views, t, selection), [views, t, selection])
  const matches = useMemo(
    () => (menuOpen && mention ? filterByMention(candidates, mention.filter) : []),
    [menuOpen, mention, candidates],
  )
  const staged = useMemo(() => new Set(attachments.map(attachmentIdentity)), [attachments])

  // A new filter is a new list; leaving the highlight where it was would confirm
  // whatever happens to be at that index now.
  useEffect(() => {
    setActive(0)
  }, [mention?.filter, menuOpen])

  // Grow with the content, up to a ceiling — past that the box scrolls, so a
  // pasted essay cannot swallow the transcript.
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight))}px`
  }, [draft])

  // Putting the caret back after this component rewrote the text under it —
  // React restores neither the position nor the focus when `value` changes.
  useLayoutEffect(() => {
    if (pendingCaret === null) return
    const el = areaRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(pendingCaret, pendingCaret)
    }
    setCaret(pendingCaret)
    setPendingCaret(null)
  }, [pendingCaret])

  useEffect(() => {
    if (!disabled && !busy) areaRef.current?.focus()
  }, [disabled, busy])

  /**
   * The draft no longer refers to a mention → drop its attachment.
   *
   * This is the catch-all: `atomicBackspace` handles the common gesture, but a
   * selection delete, a cut, a paste over the top and an undo all reach here
   * instead, and every one of them means the same thing.
   *
   * Only ever *removes*. Typing a word cannot attach anything, which is what
   * keeps peek from guessing what a hand-typed `@orders` was supposed to mean.
   */
  useEffect(() => {
    for (const [identity, token] of [...mentions.current]) {
      if (hasMention(draft, token)) continue
      mentions.current.delete(identity)
      const staged = attachments.find((a) => attachmentIdentity(a) === identity)
      if (staged) void detachFromChat(viewId, [staged.id])
    }
  }, [draft, attachments, viewId])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (text === '') return
    onSend(text)
    // Cleared *before* the draft is, or the reconcile above would read the empty
    // draft, decide every mention has been dropped, and race `chat.send` to
    // detach the attachments it is carrying.
    mentions.current.clear()
    setDraft('')
    setCaret(0)
    setDismissed(null)
  }, [draft, onSend])

  /**
   * Take a candidate: rewrite the mention, stage the attachment, bind the two.
   *
   * The text is rewritten unconditionally, including when the disclosure dialog
   * comes up and the user then cancels it. What stays behind is a word in a
   * sentence — the tracked entry beside it finds no attachment to detach and is
   * dropped the moment the word is.
   */
  const pick = useCallback(
    (candidate: AttachCandidate) => {
      if (!mention) return
      const next = applyMention(draft, mention, candidate.token)
      mentions.current.set(candidate.identity, candidate.token)
      setDraft(next.text)
      setPendingCaret(next.caret)
      setDismissed(null)
      void actions.add(stageableAttachment(candidate.spec, candidate.chipLabel), viewId)
    },
    [actions, draft, mention, viewId],
  )

  /**
   * The ✕ on a chip. Takes the word out of the draft with it, when there is one.
   *
   * Chips staged from the grid have no word — nothing in a sentence can stand for
   * "these 16 highlighted rows" — so for those this is only the detach.
   */
  const removeAttachment = useCallback(
    (attachment: ChatAttachment) => {
      const identity = attachmentIdentity(attachment)
      const token = mentions.current.get(identity)
      if (token !== undefined) {
        mentions.current.delete(identity)
        const next = dropMention(draft, token)
        const at = areaRef.current?.selectionStart ?? draft.length
        setDraft(next)
        setPendingCaret(Math.max(0, Math.min(next.length, at - (draft.length - next.length))))
      }
      void detachFromChat(viewId, [attachment.id])
    },
    [draft, viewId],
  )

  /** The button path *is* the `@` path: it types the character. */
  const openMenu = useCallback(() => {
    const el = areaRef.current
    const at = el ? (el.selectionStart ?? draft.length) : draft.length
    const before = draft.slice(0, at)
    const pad = before === '' || /\s$/u.test(before) ? '' : ' '
    setDraft(`${before}${pad}@${draft.slice(at)}`)
    setPendingCaret(before.length + pad.length + 1)
    setDismissed(null)
  }, [draft])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      const inIme = composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229

      if (menuOpen && !inIme) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setDismissed(mention?.start ?? null)
          return
        }
        if (matches.length > 0) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : matches.length - 1
            setActive((i) => (i + step) % matches.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            const candidate = matches[active]
            if (candidate && !staged.has(candidate.identity)) {
              e.preventDefault()
              pick(candidate)
              return
            }
          }
        }
      }

      // A mention deletes whole. Only for a collapsed caret, and only for a plain
      // Backspace: ⌥⌫ and ⌘⌫ are "delete a word / a line" and mean what they
      // always mean, whatever they happen to swallow.
      if (e.key === 'Backspace' && !inIme && !e.metaKey && !e.altKey && !e.ctrlKey) {
        const el = e.currentTarget
        if (el.selectionStart === el.selectionEnd) {
          const hit = atomicBackspace(draft, el.selectionStart ?? 0, [...mentions.current.values()])
          if (hit) {
            e.preventDefault()
            setDraft(hit.text)
            setPendingCaret(hit.caret)
            return
          }
        }
      }

      if (e.key !== 'Enter') return
      if (e.shiftKey) return // newline
      if (inIme) return
      e.preventDefault()
      if (busy || disabled) return
      submit()
    },
    [active, busy, disabled, draft, matches, mention, menuOpen, pick, staged, submit],
  )

  const track = useCallback((el: HTMLTextAreaElement): void => {
    setCaret(el.selectionStart ?? 0)
  }, [])

  const canSend = draft.trim() !== '' && !busy && !disabled

  return (
    <div className="relative flex-none flex flex-col px-snug pt-tight pb-snug bg-bg-1 border-t border-border">
      <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />

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
        // Focus stays here while the popover is up — the user is mid-sentence —
        // so the textarea is what announces the list and the current option.
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? `${viewId}-mentions` : undefined}
        aria-activedescendant={menuOpen && matches.length > 0 ? `${viewId}-mentions-${active}` : undefined}
        aria-autocomplete="list"
        placeholder={
          disabled
            ? (disabledReason ?? t('chat.composer.notReady'))
            : (placeholderOverride ?? t('chat.composer.placeholder'))
        }
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value)
          track(e.target)
        }}
        onKeyUp={(e) => {
          track(e.currentTarget)
        }}
        onClick={(e) => {
          track(e.currentTarget)
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(e) => {
          composing.current = false
          track(e.currentTarget)
        }}
      />

      <div className="flex items-center gap-snug pt-tight">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={t('chat.attach.addTitle')}
          onClick={openMenu}
        >
          @ {t('chat.attach.add')}
        </Button>
        <span className="text-micro text-fg-faint">{t('chat.composer.hint')}</span>
        <span className="flex-1" />
        {busy ? (
          /* Was `.chat-stop`, the third independent spelling of "this button is
             destructive" in the codebase. It is a `danger` variant now, and the
             class is gone. */
          <Button variant="danger" action="chat.cancel" onClick={onStop} title={t('chat.composer.stopTitle')}>
            <Icon name="stop" />
            {t('chat.composer.stop')}
          </Button>
        ) : (
          <Button variant="primary" action="chat.send" disabled={!canSend} onClick={submit}>
            {t('chat.composer.send')}
          </Button>
        )}
      </div>

      {menuOpen ? (
        <AttachMenu
          id={`${viewId}-mentions`}
          candidates={matches}
          active={active}
          staged={staged}
          count={attachments.length}
          onPick={pick}
          onHover={setActive}
        />
      ) : null}

      {/* Held, not dropped: accepting stages the attachment the user asked for,
          so the gesture survives reading the disclosure. */}
      {actions.consentPending ? (
        <ConsentDialog onAccept={actions.acceptConsent} onCancel={actions.cancelConsent} />
      ) : null}
    </div>
  )
}
