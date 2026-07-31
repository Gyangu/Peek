import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { ConnectionConfig, DriverId } from '@peek/core'
import { DRIVER_CAPABILITIES, DRIVER_IDS } from '@peek/core'
import { useT, type MessageKey } from '../i18n'
import { dispatch } from '../state/dispatch'

/**
 * Sample connection strings. Not translated: every one of them is syntax, and a
 * placeholder that reads as prose in one language and as a URL in another is
 * harder to copy from, not easier.
 */
const PLACEHOLDER: Record<DriverId, string> = {
  postgres: 'postgresql://user@localhost:5432/database',
  mysql: 'mysql://user@localhost:3306/database',
  sqlite: '/absolute/path/to/db.sqlite',
  redis: 'redis://localhost:6379/0',
  qdrant: 'http://localhost:6333',
}

/**
 * Label of the primary field, which differs per driver (URL vs file path).
 *
 * `as const satisfies` rather than a plain annotation: the annotation would widen
 * every entry to `MessageKey`, and `t()` cannot check the params of a key it only
 * knows as "one of all of them".
 */
const FIELD_LABEL_KEY = {
  postgres: 'connect.field.postgres',
  mysql: 'connect.field.mysql',
  sqlite: 'connect.field.sqlite',
  redis: 'connect.field.redis',
  qdrant: 'connect.field.qdrant',
} as const satisfies Record<DriverId, MessageKey>

/** New connection. `conn.open` is landed by main; this only assembles the config. */
export function ConnectDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT()
  const [driverId, setDriverId] = useState<DriverId>('postgres')
  const [target, setTarget] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    const value = target.trim()
    if (!value) return
    setBusy(true)
    void dispatch('conn.open', {
      config: buildConfig(driverId, value, label.trim()),
      openTree: true,
    })
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
                setDriverId(e.target.value as DriverId)
                setTarget('')
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
          <div className="form-row">
            <label htmlFor="peek-target">{t(FIELD_LABEL_KEY[driverId])}</label>
            <input
              id="peek-target"
              className="mono"
              value={target}
              placeholder={PLACEHOLDER[driverId]}
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setTarget(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
          <div className="form-row">
            <label htmlFor="peek-label">{t('connect.label')}</label>
            <input
              id="peek-label"
              value={label}
              placeholder={t('connect.labelPlaceholder')}
              onChange={(e) => {
                setLabel(e.target.value)
              }}
            />
          </div>
          <div className="form-hint">{t('connect.privacyNote')}</div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>{t('connect.cancel')}</button>
          <button className="primary" disabled={busy || target.trim() === ''} onClick={submit}>
            {busy ? t('connect.connecting') : t('connect.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}

function buildConfig(driverId: DriverId, target: string, label: string): ConnectionConfig {
  const base = label ? { label } : {}
  switch (driverId) {
    case 'postgres':
      return { driverId: 'postgres', url: target, ...base }
    case 'mysql':
      return { driverId: 'mysql', url: target, ...base }
    case 'sqlite':
      return { driverId: 'sqlite', file: target, ...base }
    case 'redis':
      return { driverId: 'redis', url: target, ...base }
    case 'qdrant':
      return { driverId: 'qdrant', url: target, ...base }
  }
}
