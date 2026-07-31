import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { ConnectionConfig, DriverId } from '@peek/core'
import { DRIVER_CAPABILITIES, DRIVER_IDS } from '@peek/core'
import { dispatch } from '../state/dispatch'

const PLACEHOLDER: Record<DriverId, string> = {
  postgres: 'postgresql://user@localhost:5432/database',
  mysql: 'mysql://user@localhost:3306/database',
  sqlite: '/absolute/path/to/db.sqlite',
  redis: 'redis://localhost:6379/0',
  qdrant: 'http://localhost:6333',
}

const FIELD_LABEL: Record<DriverId, string> = {
  postgres: '连接串',
  mysql: '连接串',
  sqlite: '文件路径',
  redis: '连接串',
  qdrant: '服务地址',
}

/** 新建连接。conn.open 由 main 落地，这里只负责组装 ConnectionConfig。 */
export function ConnectDialog({ onClose }: { onClose: () => void }): ReactElement {
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
          <span className="t">新建连接</span>
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label htmlFor="peek-driver">驱动</label>
            <select
              id="peek-driver"
              value={driverId}
              onChange={(e) => {
                setDriverId(e.target.value as DriverId)
                setTarget('')
              }}
            >
              {DRIVER_IDS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="form-hint">
            能力：{DRIVER_CAPABILITIES[driverId].join(' · ')}
          </div>
          <div className="form-row">
            <label htmlFor="peek-target">{FIELD_LABEL[driverId]}</label>
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
            <label htmlFor="peek-label">显示名</label>
            <input
              id="peek-label"
              value={label}
              placeholder="留空则自动生成"
              onChange={(e) => {
                setLabel(e.target.value)
              }}
            />
          </div>
          <div className="form-hint">
            连接串里的密码只存在 main 进程；发回界面的配置一律脱敏。
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || target.trim() === ''} onClick={submit}>
            {busy ? '连接中…' : '连接'}
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
