import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { UI_ZOOM_STEPS } from '@peek/core'
import { isMacPlatform } from '../../hooks'
import { LOCALES, setLocale, useLocale, useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { Segmented } from '../../ui/Segmented'

/**
 * The language picker, and how large the window is drawn.
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
 * Note what the language does *not* do: persist through main. The locale lives
 * in `localStorage`, not `settings.json`, because it is a renderer-local
 * preference — see the note atop `i18n/store.ts`.
 *
 * **The zoom is the opposite**, and the asymmetry is deliberate. It is applied
 * by `webContents.setZoomFactor`, which only main can call, so it travels as a
 * `settings.write` and is remembered in `settings.json` next to the port and the
 * timeouts. See `design/2026-08-02-ui-legibility-baseline.md` §2.4.
 */
export function AppearanceSection(): ReactElement {
  const t = useT()
  const locale = useLocale()

  return (
    <>
      <div className="form-row">
        {/* A span, not a label: `<Segmented>` names itself with `aria-label`, and a
            `<label>` with nothing to point at is a promise to a screen reader that
            nothing keeps. */}
        <span className="form-label">{t('settings.language')}</span>
        <Segmented
          label={t('settings.language')}
          value={locale}
          options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={setLocale}
        />
      </div>
      <div className="form-hint">{t('settings.languageHint')}</div>

      <ZoomRow />
    </>
  )
}

/**
 * The zoom stops.
 *
 * Read on mount rather than mirrored: the value can also change from the View
 * menu (`⌘+` / `⌘-`), and this dialog is opened far less often than that chord
 * is pressed. Re-reading each time it appears is one command and is always
 * right; a mirror would need a channel from main whose only subscriber is a
 * dialog that is usually closed.
 *
 * The click is optimistic because the window resizes *before* the reply comes
 * back — main applies the zoom inside the handler. A selected state that waited
 * for the round trip would visibly lag the thing it describes.
 */
function ZoomRow(): ReactElement {
  const t = useT()
  const [zoom, setZoom] = useState<number | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (res) setZoom(res.uiZoom)
    })
  }, [])

  const choose = (next: number): void => {
    setZoom(next)
    void dispatch('settings.write', { uiZoom: next }).then((res) => {
      // The reply is what actually took effect after clamping, so a value that
      // was out of range corrects itself here rather than lying in the UI.
      if (res) setZoom(res.uiZoom)
    })
  }

  return (
    <>
      <div className="form-row">
        <span className="form-label">{t('settings.zoom')}</span>
        {/*
         * `value` is the step this zoom *is*, resolved by proximity rather than by
         * identity: the factor round-trips through a settings file and a
         * `setZoomFactor` call, so 1.25 can come back as 1.2500000000000002 and an
         * exact match would leave the group with nothing selected — which, with a
         * roving tabindex, is a control the keyboard cannot enter.
         */}
        <Segmented
          label={t('settings.zoom')}
          value={UI_ZOOM_STEPS.find((step) => zoom !== null && Math.abs(zoom - step) < 0.001) ?? -1}
          options={UI_ZOOM_STEPS.map((step) => ({
            value: step,
            label: `${String(Math.round(step * 100))}%`,
          }))}
          onChange={choose}
        />
      </div>
      {/* Modifier symbols are never translated: they are what is printed on the
          keys in front of the reader. Same rule as `shortcutHints`. */}
      <div className="form-hint">
        {t('settings.zoomHint', { keys: isMacPlatform() ? '⌘+ / ⌘− / ⌘0' : 'Ctrl++ / Ctrl+− / Ctrl+0' })}
      </div>
    </>
  )
}
