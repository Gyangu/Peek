import type { ReactElement } from 'react'
import { LOCALES, setLocale, useLocale, useT } from '../../i18n'

/**
 * The language picker.
 *
 * It used to be a cycle button in the status bar — one click, next language —
 * which is genuinely faster than coming in here. It moved anyway: two entry
 * points to one setting drift, and a cycle button stops being obvious the moment
 * a third language exists. The speed is recovered by the dialog's own shortcut
 * (`⌘,`) rather than by a back door into one setting.
 *
 * Locale names are endonyms and never pass through `t()`: a picker that says
 * "Chinese" to someone who only reads Chinese helps nobody.
 *
 * Note what this does *not* do: persist through main. The locale lives in
 * `localStorage`, not `settings.json`, because it is a renderer-local preference
 * — see the note atop `i18n/store.ts`. This dialog changed where the control is,
 * not where the choice is kept.
 */
export function AppearanceSection(): ReactElement {
  const t = useT()
  const locale = useLocale()

  return (
    <>
      <div className="form-row">
        <label>{t('settings.language')}</label>
        <div className="segmented">
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              className={l.id === locale ? 'seg active' : 'seg'}
              aria-pressed={l.id === locale}
              onClick={() => {
                setLocale(l.id)
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-hint">{t('settings.languageHint')}</div>
    </>
  )
}
