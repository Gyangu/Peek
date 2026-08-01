import { memo } from 'react'
import type { ReactElement } from 'react'
import { useChatT } from './i18n'
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
  const t = useChatT()
  const done = entries.filter((e) => e.status === 'completed').length

  return (
    <div className="chat-plan">
      <div className="chat-plan-head">
        <span className="chat-plan-title">{t('chat.plan.title')}</span>
        <span className="chat-plan-count mono">
          {t('chat.plan.progress', { done, total: entries.length })}
        </span>
      </div>
      <ul className="chat-plan-list">
        {entries.map((entry, i) => (
          <li key={i} className={`chat-plan-item ${entry.status}`}>
            <span className="chat-plan-mark" aria-hidden="true">
              {entry.status === 'completed' ? '✔' : entry.status === 'in_progress' ? '▸' : '○'}
            </span>
            <span className="chat-plan-text">{entry.content}</span>
            <span className="chat-plan-status">{t(planStatusKey(entry.status))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})

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
