import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SettingsReadResult } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { dispatch } from '../../state/dispatch'

/**
 * The version, and where peek keeps what it keeps.
 *
 * The paths are reported by main rather than spelled here: `~/.peek` moves with
 * `PEEK_CONFIG_DIR`, and a renderer that reconstructed the path would be
 * confidently wrong on exactly the machines where someone is looking it up.
 */
export function AboutSection(): ReactElement {
  const t = useT()
  const [info, setInfo] = useState<SettingsReadResult | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (res) setInfo(res)
    })
  }, [])

  return (
    <>
      {/* Version and paths are identifiers; they are never translated. */}
      <div className="form-row">
        <label>{t('settings.about.version')}</label>
        <span className="mono">{info?.version === '' ? t('settings.about.unavailable') : info?.version}</span>
      </div>

      {PATHS.map(([key, label]) => (
        <div className="form-row" key={key}>
          <label>{t(label)}</label>
          <input
            className="mono"
            readOnly
            value={info?.paths[key] ?? ''}
            spellCheck={false}
            // Scrolled to the end, because the end is the part that differs.
            // All four paths share a directory prefix long enough to fill the
            // box, so the default left-anchored view shows four identical
            // strings and hides the filename that makes each one useful.
            ref={(el) => {
              if (el) el.scrollLeft = el.scrollWidth
            }}
            // Read-only, but selectable: copying the path is the reason this
            // section exists at all.
            onFocus={(e) => {
              e.currentTarget.select()
            }}
          />
        </div>
      ))}
      <div className="form-hint">{t('settings.about.pathsHint')}</div>
    </>
  )
}

const PATHS = [
  ['configDir', 'settings.about.configDir'],
  ['settingsFile', 'settings.about.settingsFile'],
  ['connectionsFile', 'settings.about.connectionsFile'],
  ['mcpFile', 'settings.about.mcpFile'],
] as const satisfies readonly (readonly [keyof SettingsReadResult['paths'], Parameters<TFunction>[0]])[]
