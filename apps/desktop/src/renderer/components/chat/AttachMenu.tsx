import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { MAX_CHAT_ATTACHMENTS } from '@peek/core'
import { useT } from '../../i18n'
import type { AttachCandidate } from './attachments'

/**
 * The list of things that can be attached, above the composer.
 *
 * One component for both ways in — typing `@`, and clicking the button — because
 * they are the same question ("what can I attach from here?") and a second list
 * would answer it differently within a release. The button path is literally the
 * `@` path: it inserts the character and lets this open.
 *
 * ## It stays open when nothing matches
 *
 * A popover that vanishes on a bad filter reads as "@ is broken". The real
 * answer is usually "you have not opened that table yet", and this is the only
 * place that can say so — hence `context.mention.empty` rather than a dismissal.
 * Same reasoning for the attachment ceiling: hitting `MAX_CHAT_ATTACHMENTS` is a
 * Command failure and a toast if it is discovered by clicking, and a sentence
 * you read before clicking if it is discovered here.
 *
 * ## Keyboard, but no focus
 *
 * Focus never leaves the textarea — the user is mid-sentence. So this is not a
 * `Menu` (which traps focus and is driven by the pointer) but a listbox the
 * composer *aims*: it owns `active`, and the arrow keys it intercepts move that
 * index. `aria-activedescendant` on the textarea is what tells a screen reader
 * which option is current while the caret stays put.
 */
export function AttachMenu({
  id,
  candidates,
  active,
  staged,
  count,
  onPick,
  onHover,
}: {
  /** Ties the textarea's `aria-activedescendant` to the option ids below. */
  id: string
  candidates: readonly AttachCandidate[]
  /** Index of the highlighted option; -1 when none is. */
  active: number
  /** Identities already attached — those options are shown but not offered. */
  staged: ReadonlySet<string>
  /** How many attachments the chat already carries. */
  count: number
  onPick: (candidate: AttachCandidate) => void
  onHover: (index: number) => void
}): ReactElement {
  const t = useT()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const full = count >= MAX_CHAT_ATTACHMENTS

  // Keep the highlighted option in view while the arrows walk past the fold.
  useEffect(() => {
    if (active < 0) return
    boxRef.current?.querySelector(`#${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id])

  return (
    <div
      ref={boxRef}
      className="absolute left-2 right-2 bottom-full z-20 mb-tight p-inset max-h-70 overflow-auto rounded-control bg-bg-2 border border-border-strong shadow-menu"
    >
      <div className="px-tight pb-inset text-micro text-fg-faint" aria-hidden="true">
        {full ? t('context.mention.full', { count }) : t('context.mention.hint')}
      </div>

      {candidates.length === 0 ? (
        <div className="px-tight py-tight text-micro text-fg-faint" role="status">
          {t('context.mention.empty')}
        </div>
      ) : (
        <div role="listbox" id={id} aria-label={t('context.mention.label')}>
          {candidates.map((c, i) => {
            const already = staged.has(c.identity)
            const disabled = already || full
            return (
              // A listbox option, not a control — see NOT_CONTROLS. The classes
              // strip the button shape and lay the hint under the label.
              <button
                key={c.key}
                id={`${id}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                aria-disabled={disabled}
                disabled={disabled}
                // The two backgrounds are written as one either/or and not as
                // `bg-transparent` plus an override: which of two plain `bg-*`
                // utilities wins is decided by their order in the generated
                // stylesheet, not by the order they appear here, and
                // `bg-transparent` was winning — the arrows moved `active` and
                // nothing on screen said so.
                className={
                  'flex flex-col items-start gap-inset w-full px-tight py-inset text-left rounded-control border-0 ' +
                  (i === active && !disabled ? 'bg-bg-hover ' : 'bg-transparent ') +
                  'hover:not-disabled:bg-bg-hover'
                }
                // `onMouseDown` and not `onClick`: the textarea must not lose the
                // caret, and mousedown is where that would happen.
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (!disabled) onPick(c)
                }}
                onMouseMove={() => {
                  onHover(i)
                }}
              >
                {/* An option that cannot be taken reads quieter **in its
                    colours, at full opacity**. `opacity` composites the whole
                    row and would drag the accent under the contrast floor
                    somewhere the theme census structurally cannot look — the
                    same call the receipt chips made, see `chipClasses`. */}
                <span className="flex items-baseline gap-tight">
                  <span className={`font-mono ${disabled ? 'text-fg-faint' : 'text-accent'}`}>@{c.token}</span>
                  <span className={disabled ? 'text-fg-faint' : ''}>{c.label}</span>
                  {already ? <span className="text-micro text-fg-faint">{t('context.mention.added')}</span> : null}
                </span>
                {c.hint ? (
                  <span className="font-mono tabular-nums max-w-full truncate text-micro text-fg-faint">{c.hint}</span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
