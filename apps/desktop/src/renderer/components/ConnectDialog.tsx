import { useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { DriverId } from '@peek/core'
import { DRIVER_CAPABILITIES, DRIVER_IDS } from '@peek/core'
import { useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import {
  buildConnectionConfig,
  connectFields,
  connectFormSpec,
  defaultConnectMode,
  initialConnectValues,
  missingRequiredFields,
  type ConnectField,
  type ConnectMode,
} from './connectForm'

/**
 * New connection.
 *
 * The form is driven by `connectForm.ts` rather than hard-coded here: every
 * driver asks for different things (redis wants a numeric database index, qdrant
 * an API key, sqlite a path on disk), and the alternative — one text box per
 * driver — either lies about what is configurable or forces the user to hand-
 * assemble a URL peek could have assembled for them.
 *
 * `conn.open` is landed by main; this only assembles the config.
 */
export function ConnectDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT()
  const [driverId, setDriverId] = useState<DriverId>('postgres')
  const [mode, setMode] = useState<ConnectMode>(() => defaultConnectMode('postgres'))
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    initialConnectValues('postgres', defaultConnectMode('postgres')),
  )
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)

  const spec = connectFormSpec(driverId)
  const fields = connectFields(driverId, mode)
  const missing = useMemo(
    () => missingRequiredFields(driverId, mode, values),
    [driverId, mode, values],
  )

  // Switching driver or mode resets to that form's defaults. Carrying values
  // across would mean a port left over from postgres quietly connecting a redis
  // client to 5432.
  const switchTo = (nextDriver: DriverId, nextMode: ConnectMode): void => {
    setDriverId(nextDriver)
    setMode(nextMode)
    setValues(initialConnectValues(nextDriver, nextMode))
    setIssue(null)
  }

  const setValue = (name: string, value: string | boolean): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setIssue(null)
  }

  const submit = (): void => {
    if (busy || missing.length > 0) return
    const built = buildConnectionConfig(driverId, mode, values, label)
    if (!built.ok) {
      setIssue(built.issue)
      return
    }
    setBusy(true)
    void dispatch('conn.open', { config: built.config, openTree: true })
      .then((res) => {
        if (res) onClose()
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" style={{ width: 520 }} onMouseDown={stop}>
        <div className="modal-head">
          <span className="t">{t('connect.title')}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label htmlFor="peek-driver">{t('connect.driver')}</label>
            <select
              id="peek-driver"
              value={driverId}
              onChange={(e) => {
                const next = e.target.value as DriverId
                switchTo(next, defaultConnectMode(next))
              }}
            >
              {/* Driver ids are identifiers: `postgres` reads the same everywhere. */}
              {DRIVER_IDS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="form-hint">
            {/* Capability names are part of the driver contract, never translated. */}
            {t('connect.capabilities', { list: DRIVER_CAPABILITIES[driverId].join(' · ') })}
          </div>

          {spec.modes.length > 1 ? (
            <div className="form-row">
              <label>{t('connect.mode')}</label>
              <div className="segmented">
                {spec.modes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={m === mode ? 'seg active' : 'seg'}
                    aria-pressed={m === mode}
                    onClick={() => {
                      switchTo(driverId, m)
                    }}
                  >
                    {t(m === 'url' ? 'connect.mode.url' : 'connect.mode.fields')}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {fields.map((field, i) => (
            <FieldRow
              key={`${driverId}:${mode}:${field.name}`}
              t={t}
              field={field}
              value={values[field.name] ?? ''}
              autoFocus={i === 0}
              onChange={(v) => {
                setValue(field.name, v)
              }}
              onSubmit={submit}
            />
          ))}

          <div className="form-row">
            <label htmlFor="peek-label">{t('connect.label')}</label>
            <input
              id="peek-label"
              value={label}
              placeholder={t('connect.labelPlaceholder')}
              onChange={(e) => {
                setLabel(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>

          {issue ? (
            // zod's own words, naming the field it rejected — evidence, not prose.
            <div className="form-hint" style={{ color: 'var(--err)' }}>
              {t('connect.invalid', { issue })}
            </div>
          ) : null}
          <div className="form-hint">{t('connect.privacyNote')}</div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>{t('connect.cancel')}</button>
          <button className="primary" disabled={busy || missing.length > 0} onClick={submit}>
            {busy ? t('connect.connecting') : t('connect.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface FieldRowProps {
  t: TFunction
  field: ConnectField
  value: string | boolean
  autoFocus: boolean
  onChange: (value: string | boolean) => void
  onSubmit: () => void
}

function FieldRow({ t, field, value, autoFocus, onChange, onSubmit }: FieldRowProps): ReactElement {
  const id = `peek-field-${field.name}`
  if (field.type === 'checkbox') {
    return (
      <div className="form-row">
        <label htmlFor={id}>{t(field.labelKey)}</label>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => {
            onChange(e.target.checked)
          }}
        />
      </div>
    )
  }
  return (
    <div className="form-row">
      <label htmlFor={id}>{t(field.labelKey)}</label>
      <input
        id={id}
        className={field.mono === true ? 'mono' : undefined}
        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
      />
    </div>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}
