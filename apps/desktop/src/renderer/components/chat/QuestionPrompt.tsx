import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PendingQuestion, ViewId } from '@peek/core'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { answerQuestion } from './chatCommands'

/**
 * The moment the agent asks *you* something.
 *
 * Sibling of `PermissionPrompt`, and deliberately built from the same parts —
 * same place on the panel, same focus rule, same `role="group"` honesty about
 * not being a DOM modal. Someone who has learned that a bordered box above the
 * composer means "it stopped, and it stopped for you" should not have to learn a
 * second language for the second kind of stop.
 *
 * Three things it does differently, each because the *answer* is different:
 *
 * **There is always an "Other", and it is always open.** It is not one of the
 * agent's options and it is not conditional — see `OTHER_OPTION_ID` in core. A
 * question with three wrong answers and no way out makes a person pick the least
 * wrong one, and the agent then proceeds confidently on an answer nobody meant.
 * The box was collapsed behind a button until 2026-08-29, on the reasoning that
 * an open one would read as a fifth option; it is open now because a control you
 * must first discover is a weaker version of the same corner — see
 * `docs/design/2026-08-29-the-other-box-opens-by-default.md`. A text field does
 * not look like a button, which is what keeps it from being read as an option.
 *
 * **A single-choice question answers on click.** No confirm step: the click *is*
 * the answer, exactly as it is on a permission prompt. Two variants cannot work
 * that way and only those two grow a Send button — multi-select, where the
 * answer is not complete until the person says it is, and a box with something
 * typed in it, which no click can complete. An *empty* box is not a pending
 * answer, which is why the condition reads "has text" rather than "is open".
 *
 * **Nothing is the primary button.** Same reasoning as the permission prompt: the
 * agent offered these as alternatives, and drawing one of them louder would be
 * peek adding a recommendation the agent did not make. The *free-text* Send is
 * primary when it is the only pending act, because there the question is no
 * longer "which one" but "are you done typing".
 */
export function QuestionPrompt({
  viewId,
  question,
}: {
  viewId: ViewId
  question: PendingQuestion
}): ReactElement {
  const t = useT()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [picked, setPicked] = useState<readonly string[]>([])
  const [other, setOther] = useState('')

  // The container, never a button and never the text box — the same rule the
  // permission prompt keeps, and for the same reason: Tab reaches the answers,
  // but no keystroke aimed at the composer can answer by inertia. Focusing the
  // free-text field instead would tell a person to type when most questions are
  // answered by picking. Re-runs per question so a second one arriving behind
  // the first is announced rather than silently swapped.
  useEffect(() => {
    boxRef.current?.focus()
    setPicked([])
    setOther('')
  }, [question.requestId])

  const send = (optionIds: readonly string[], text: string): void => {
    void answerQuestion(viewId, [...optionIds], text.trim(), question.requestId)
  }

  const toggle = (optionId: string): void => {
    if (!question.multiSelect) {
      // Single choice: the click is the answer. Nothing to confirm, and a
      // confirm step here would be a second click for a decision already made.
      // The typed text rides along — "this one, but only for the EU part" is one
      // answer, not two.
      send([optionId], other)
      return
    }
    setPicked((current) =>
      current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId],
    )
  }

  const typed = other.trim() !== ''
  const canSend = picked.length > 0 || typed

  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      // Same class recipe as `PermissionPrompt`, including why every focus
      // utility is quoted under its variant — see the long note there.
      className="flex-none m-tight px-snug py-snug rounded-control select-text border bg-accent-bg border-accent focus:outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      role="group"
      aria-label={t('chat.question.label')}
      aria-live="assertive"
    >
      <div className="flex items-baseline gap-tight mb-tight">
        {question.header === undefined ? null : (
          <span className="flex-none px-tight rounded-control bg-bg-3 text-micro text-fg-dim">
            {question.header}
          </span>
        )}
        <span className="font-semibold text-fg">{question.question}</span>
      </div>

      <div className="mb-snug text-micro text-fg-dim">
        {question.multiSelect ? t('chat.question.waitingMulti') : t('chat.question.waiting')}
      </div>

      <div className="flex flex-col gap-tight">
        {question.options.map((option) => {
          const selected = picked.includes(option.optionId)
          return (
            <Button
              key={option.optionId}
              variant={selected ? 'caution' : 'default'}
              // `human-only` on the surface where the word carries weight. An
              // agent that could click here would be answering its own question,
              // which `chat.answer` refuses on the bus as well — this is the DOM
              // half of the same rule, pinned by `control-spec.test.ts`.
              action="chat.answer"
              exposure="human-only"
              aria-pressed={question.multiSelect ? selected : undefined}
              onClick={() => {
                toggle(option.optionId)
              }}
            >
              {/* The left alignment lives on this span, not in the Button's
                  `className`: that prop is fenced to placement utilities, and
                  `text-left` paints. `w-full` is what makes the span, rather
                  than the button's own centring, decide where the text sits. */}
              <span className="flex w-full flex-col items-start gap-px text-left">
                <span>{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="text-micro text-fg-dim">{option.description}</span>
                )}
              </span>
            </Button>
          )
        })}

        {/* The escape hatch, last in the same column as the options and open
            from the start. No `autoFocus`: it is as available as the options,
            not more so. */}
        <input
          className="w-full px-tight py-tight rounded-control border border-border bg-bg-1 text-fg"
          value={other}
          placeholder={t('chat.question.otherPlaceholder')}
          aria-label={t('chat.question.other')}
          onChange={(e) => {
            setOther(e.target.value)
          }}
          onKeyDown={(e) => {
            // Enter sends, because this input has exactly one purpose and a
            // person who has finished typing an answer should not have to find
            // a button. Escape clears what was typed and hands focus back to the
            // container — a way out of the box that does not answer the
            // question, which is still standing either way.
            if (e.key === 'Enter' && !e.shiftKey && canSend) {
              e.preventDefault()
              send(picked, other)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOther('')
              boxRef.current?.focus()
            }
          }}
        />
      </div>

      {/* Only the two answers that cannot be completed by a single click get a
          Send: a multi-select answer is not complete until the person says so,
          and typed text is not complete until they stop typing. An empty box is
          neither. */}
      {question.multiSelect || typed ? (
        <div className="mt-snug flex gap-tight">
          <Button
            variant="primary"
            // Likewise no id of its own: this is the second half of the same act
            // the option buttons carry the address for.
            exposure="human-only"
            disabled={!canSend}
            onClick={() => {
              send(picked, other)
            }}
          >
            {t('chat.question.send')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
