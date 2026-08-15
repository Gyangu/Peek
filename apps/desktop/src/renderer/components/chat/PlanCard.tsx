import { memo } from 'react'
import type { ReactElement } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import type { PlanEntry } from './toolCalls'

/**
 * The agent's checklist.
 *
 * Rendered from whatever plan-shaped payload arrived — today the `TodoWrite`
 * tool call, tomorrow ACP's own `plan` session update if the contract grows a
 * home for it (see `extractPlan`). Both normalize to `PlanEntry[]` before they
 * reach this component, so it does not care which.
 *
 * A plan is the one part of the transcript a user reads *for its state* rather
 * than its text, so progress is shown as a count and each row carries its status
 * as a word, not only as a colour.
 */
export const PlanCard = memo(function PlanCard({ entries }: { entries: PlanEntry[] }): ReactElement {
  const t = useT()
  const done = entries.filter((e) => e.status === 'completed').length

  return (
    // Neutral chrome on purpose. A plan is the agent reporting where it is, not
    // asking anything — so it stays --color-border and never borrows the amber
    // the permission prompt uses to mean "answer me".
    <div className="my-tight rounded-control bg-bg-1 border border-border">
      <div className="flex items-center gap-snug px-snug py-tight border-b border-border">
        <span className="text-micro uppercase tracking-wider text-fg-dim">{t('chat.plan.title')}</span>
        <span className="font-mono tabular-nums text-micro text-fg-faint">
          {t('chat.plan.progress', { done, total: entries.length })}
        </span>
      </div>
      <ul className="m-0 py-tight list-none">
        {entries.map((entry, i) => (
          /* `items-baseline` was the glyphs' requirement — they sat on the text
             baseline. An icon has no baseline to sit on, so the row centres its
             first line instead. */
          <li key={i} className="flex items-center gap-snug px-snug py-inset">
            <span className={`flex-none flex ${MARK[entry.status]}`}>
              <Icon
                name={
                  entry.status === 'completed'
                    ? 'status.completed'
                    : entry.status === 'in_progress'
                      ? 'status.active'
                      : 'status.pending'
                }
                size="sm"
              />
            </span>
            <span
              className={`flex-1 min-w-0 break-words${
                entry.status === 'completed' ? ' text-fg-faint line-through' : ''
              }`}
            >
              {entry.content}
            </span>
            <span className="flex-none text-micro text-fg-faint">{t(planStatusKey(entry.status))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})

/** The mark's colour, one per status — never two, which a class list cannot resolve. */
const MARK: Record<PlanEntry['status'], string> = {
  completed: 'text-ok',
  in_progress: 'text-accent',
  pending: 'text-fg-faint',
}

function planStatusKey(
  status: PlanEntry['status'],
): 'chat.plan.status.pending' | 'chat.plan.status.in_progress' | 'chat.plan.status.completed' {
  switch (status) {
    case 'completed':
      return 'chat.plan.status.completed'
    case 'in_progress':
      return 'chat.plan.status.in_progress'
    case 'pending':
      return 'chat.plan.status.pending'
  }
}
