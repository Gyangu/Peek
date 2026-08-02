import { useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { DriverId, SavedConnection } from '@peek/core'
import { DRIVER_CAPABILITIES, DRIVER_IDS } from '@peek/core'
import { useModalDialog } from '../hooks'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { useT, type TFunction } from '../i18n'
import { dispatch } from '../state/dispatch'
import {
  buildConnectionConfig,
  connectFields,
  connectFormSpec,
  connectModeFor,
  defaultConnectMode,
  initialConnectValues,
  missingRequiredFields,
  valuesFromConfig,
  type ConnectField,
  type ConnectMode,
} from './connectForm'

/**
 * New connection — or an edit of one that was saved.
 *
 * The form is driven by `connectForm.ts` rather than hard-coded here: every
 * driver asks for different things (redis wants a numeric database index, qdrant
 * an API key, sqlite a path on disk), and the alternative — one text box per
 * driver — either lies about what is configurable or forces the user to hand-
 * assemble a URL peek could have assembled for them.
 *
 * ## Editing does not mean a second write path
 *
 * `initial` only *seeds the form*. What leaves the dialog is a `conn.open` in
 * both cases, and the connection book is written by main when that open
 * succeeds. So there is exactly one description of a connection in the system,
 * and it is the one that has actually connected — a "save" button that did not
 * dial would be a second, unverified one.
 *
 * The password box is the one thing that cannot be seeded: the saved config
 * carries no credential, by construction. Rather than showing a filled box that
 * is a lie, the dialog says the stored password will be used, and typing in the
 * box overrides it.
 */
export interface ConnectDialogProps {
  onClose: () => void
  /** Seed from a saved connection. Absent means a blank form. */
  initial?: SavedConnection
}

export function ConnectDialog({ onClose, initial }: ConnectDialogProps): ReactElement {
  const t = useT()
  // Escape, focus containment, focus restoration. The initial focus is left to
  // the first field's `autoFocus` — see the note in `useModalDialog`.
  const dialogRef = useModalDialog({ label: 'connect', onClose })
  const seed = useMemo(() => seedFrom(initial), [initial])
  const [driverId, setDriverId] = useState<DriverId>(seed.driverId)
  const [mode, setMode] = useState<ConnectMode>(seed.mode)
  const [values, setValues] = useState<Record<string, string | boolean>>(seed.values)
  const [label, setLabel] = useState(seed.label)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  /**
   * Whether the stored credential is still the one that will be sent.
   *
   * It stops being true the moment the user types into the password box — main
   * only fills a field that arrives absent — and also when they edit a field the
   * credential is keyed by, because a password saved for one server is never
   * replayed at another. Rather than model that rule twice, the notice
   * disappears as soon as the form no longer matches what was saved.
   */
  const savedSecretInUse =
    initial?.hasSecret === true &&
    driverId === seed.driverId &&
    mode === seed.mode &&
    sameValues(values, seed.values)

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
    /*
     * The mask does **not** close this one, and that is the difference between
     * it and `ValueModal`. This dialog holds typed input — a host, a port, a
     * password — and a stray click on the dimmed area outside it used to discard
     * all of it with no confirmation and no undo. A read-only modal can be
     * dismissed by clicking away; a form cannot. Escape and Cancel are the ways
     * out, and both are deliberate acts.
     */
    <div className="modal-mask">
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={initial ? t('connect.editTitle') : t('connect.title')}
        style={{ width: 520 }}
        onMouseDown={stop}
      >
        <div className="modal-head">
          <span className="t">{initial ? t('connect.editTitle') : t('connect.title')}</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" icon label={t('app.errors.close')} onClick={onClose}>
            ✕
          </Button>
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
              <Segmented
                label={t('connect.mode')}
                value={mode}
                options={spec.modes.map((m) => ({
                  value: m,
                  label: t(m === 'url' ? 'connect.mode.url' : 'connect.mode.fields'),
                }))}
                onChange={(next) => {
                  switchTo(driverId, next)
                }}
              />
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

          {savedSecretInUse ? (
            <div className="form-hint">{t('connect.savedSecretInUse')}</div>
          ) : initial?.hasSecret === true ? (
            // The form has moved away from what the credential was saved for, so
            // it will not be sent. Saying so here is cheaper than an
            // authentication failure the user has to interpret.
            <div className="form-hint">{t('connect.savedSecretNotUsed')}</div>
          ) : null}

          {issue ? (
            // The rejected field, named — evidence, not prose.
            <div className="form-hint" style={{ color: 'var(--err)' }}>
              {t('connect.invalid', { issue })}
            </div>
          ) : null}
          <div className="form-hint">{t('connect.privacyNote')}</div>
        </div>
        <div className="modal-foot">
          <Button onClick={onClose}>{t('connect.cancel')}</Button>
          <Button variant="primary" action="conn.open" disabled={busy || missing.length > 0} onClick={submit}>
            {busy ? t('connect.connecting') : t('connect.submit')}
          </Button>
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

/* ------------------------------------------------------------------ */

interface Seed {
  driverId: DriverId
  mode: ConnectMode
  values: Record<string, string | boolean>
  label: string
}

/** A blank postgres form, or the saved connection unpacked back into one. */
function seedFrom(initial: SavedConnection | undefined): Seed {
  if (!initial) {
    const mode = defaultConnectMode('postgres')
    return { driverId: 'postgres', mode, values: initialConnectValues('postgres', mode), label: '' }
  }
  const config = initial.config as unknown as Record<string, unknown>
  const mode = connectModeFor(initial.driverId, config)
  return {
    driverId: initial.driverId,
    mode,
    values: valuesFromConfig(initial.driverId, mode, config),
    // Only a label the user actually chose is carried back. `SavedConnection.label`
    // falls back to a derived one, and putting that in the box would turn a
    // generated name into a typed one on the next save.
    label: typeof config['label'] === 'string' ? config['label'] : '',
  }
}

function sameValues(
  a: Readonly<Record<string, string | boolean>>,
  b: Readonly<Record<string, string | boolean>>,
): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  return keys.every((key) => a[key] === b[key])
}
