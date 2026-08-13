import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ExecutionBudgets } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { Button } from '../../ui/Button'
import { Form, FormActions, FormHint, FormRow } from '../../ui/Form'

/**
 * How long a request may run.
 *
 * Only the three **execution** budgets are here. `TimeoutSettings` has nine more
 * — spawn→ready, the connect RPC, the cancel RPC — and those are the app
 * protecting itself from a wedged driver process, not a preference anyone holds.
 * Putting `cancelMs` on screen would invite people to tune a number that can only
 * make peek worse at noticing a dead process. The note at the end of the section
 * says so, rather than leaving their absence to look like an oversight.
 *
 * Seconds on screen, milliseconds on the wire: nobody wants to count the zeroes
 * in `120000`. The conversion happens here and nowhere else — main's unit is
 * milliseconds, and a value that changed unit in transit would be a bug waiting
 * to happen.
 */
export function TimeoutsSection(): ReactElement {
  const t = useT()
  /** The values as typed, in seconds. `null` until the first read lands. */
  const [draft, setDraft] = useState<Record<Field, string> | null>(null)
  const [saved, setSaved] = useState<ExecutionBudgets | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (!res) return
      setSaved(res.execution)
      setDraft(toDraft(res.execution))
    })
  }, [])

  const apply = (): void => {
    if (!draft || !saved) return
    const execution: Partial<ExecutionBudgets> = {}
    for (const field of FIELDS) {
      const seconds = Number(draft[field])
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
        setNotice(t('settings.timeouts.invalid'))
        return
      }
      const ms = seconds * 1000
      // Only what actually changed is sent: the command persists exactly the
      // keys it is given, and the other two should keep following the built-in
      // default rather than being frozen at today's value.
      if (ms !== saved[field]) execution[field] = ms
    }
    if (Object.keys(execution).length === 0) {
      setNotice(t('settings.timeouts.unchanged'))
      return
    }
    setBusy(true)
    void dispatch('settings.write', { execution })
      .then((res) => {
        if (res) {
          setSaved(res.execution)
          setDraft(toDraft(res.execution))
          setNotice(t('settings.timeouts.applied'))
        }
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      <div className="text-fg-dim mb-snug">{t('settings.timeouts.intro')}</div>

      <Form>
        {FIELDS.map((field) => (
          /* The unit sits in the row beside the field, with no structure of its
             own: a row's children share one flex cell in the control column. */
          <FormRow key={field} label={t(LABEL[field])} htmlFor={`peek-timeout-${field}`}>
            <input
              id={`peek-timeout-${field}`}
              type="number"
              min={0}
              max={3600}
              value={draft?.[field] ?? ''}
              disabled={draft === null}
              onChange={(e) => {
                const next = e.target.value
                setDraft((d) => (d === null ? d : { ...d, [field]: next }))
                setNotice(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply()
              }}
            />
            <span className="text-fg-faint">{t('settings.timeouts.seconds')}</span>
          </FormRow>
        ))}
        <FormHint>{t('settings.timeouts.zeroHint')}</FormHint>

        <FormActions>
          <Button disabled={busy || draft === null} onClick={apply}>
            {t('settings.timeouts.apply')}
          </Button>
        </FormActions>
        {notice ? <FormHint>{notice}</FormHint> : null}

        <FormHint>{t('settings.timeouts.stageNote')}</FormHint>
      </Form>
    </>
  )
}

type Field = keyof ExecutionBudgets

const FIELDS = ['queryMs', 'scanMs', 'vectorSearchMs'] as const satisfies readonly Field[]

const LABEL = {
  queryMs: 'settings.timeouts.query',
  scanMs: 'settings.timeouts.scan',
  vectorSearchMs: 'settings.timeouts.vectorSearch',
} as const satisfies Record<Field, Parameters<TFunction>[0]>

function toDraft(execution: ExecutionBudgets): Record<Field, string> {
  return {
    queryMs: String(Math.round(execution.queryMs / 1000)),
    scanMs: String(Math.round(execution.scanMs / 1000)),
    vectorSearchMs: String(Math.round(execution.vectorSearchMs / 1000)),
  }
}
