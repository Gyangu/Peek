import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { NotificationSettings } from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { Form, FormRow } from '../../ui/Form'
import { Segmented } from '../../ui/Segmented'

/**
 * Whether peek may speak outside its own window.
 *
 * A section of its own rather than two rows in `AgentSection`, even though one of
 * the switches is about the agent: the other one governs the *channel* — the
 * `notify` tool, and anything peek grows later that needs to reach someone who
 * has walked away. Filing the channel under "Agent" would put it where nobody
 * would look for it the day something other than an agent wants to use it.
 *
 * Read on mount, like `ZoomRow` and for the same reason: this is one command,
 * always current, against a mirror whose only subscriber is a dialog that is
 * usually closed.
 *
 * Both switches are `<Segmented>` rather than a checkbox, which peek has no
 * primitive for and which this section is not the place to invent — see
 * `ui/CLAUDE.md`. On/Off also reads better than a tick for a preference stated
 * as a sentence in its hint.
 */
export function NotificationsSection(): ReactElement {
  const t = useT()
  const [settings, setSettings] = useState<NotificationSettings | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (res) setSettings(res.notifications)
    })
  }, [])

  const write = (patch: Partial<NotificationSettings>): void => {
    // Optimistic, then corrected by the reply — the same shape as the zoom row.
    // Nothing here can be clamped or refused, so the correction is a formality;
    // it is kept because "the file is the truth" costs one line.
    setSettings((current) => (current === null ? current : { ...current, ...patch }))
    void dispatch('settings.write', { notifications: patch }).then((res) => {
      if (res) setSettings(res.notifications)
    })
  }

  return (
    <Form>
      <FormRow label={t('settings.notifications.system')} hint={t('settings.notifications.systemHint')}>
        <OnOff
          label={t('settings.notifications.system')}
          value={settings?.system ?? null}
          onChange={(system) => {
            write({ system })
          }}
        />
      </FormRow>

      <FormRow label={t('settings.notifications.turnEnd')} hint={t('settings.notifications.turnEndHint')}>
        <OnOff
          label={t('settings.notifications.turnEnd')}
          value={settings?.agentTurnEnd ?? null}
          onChange={(agentTurnEnd) => {
            write({ agentTurnEnd })
          }}
        />
      </FormRow>
    </Form>
  )
}

/**
 * A boolean as two segments.
 *
 * `null` — the settings have not been read back yet — selects neither, which is
 * the same "no selection" state `ZoomRow` shows for an unresolved zoom. It lasts
 * one round trip.
 */
function OnOff({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean | null
  onChange: (value: boolean) => void
}): ReactElement {
  const t = useT()
  return (
    <Segmented
      className="grow-0 shrink-0 basis-auto min-w-50"
      label={label}
      value={value === null ? '' : value ? 'on' : 'off'}
      options={[
        { value: 'on', label: t('settings.notifications.on') },
        { value: 'off', label: t('settings.notifications.off') },
      ]}
      onChange={(next) => {
        onChange(next === 'on')
      }}
    />
  )
}
