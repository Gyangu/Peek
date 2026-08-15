import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { UI_ZOOM_STEPS, type UiTheme } from '@peek/core'
import { isMacPlatform } from '../../hooks'
import { LOCALES, setLocale, useLocale, useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { useThemePreference } from '../../theme'
import { Form, FormRow } from '../../ui/Form'
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
    <Form>
      {/* No `htmlFor`: `<Segmented>` names itself with `aria-label`, and a
          `<label>` with nothing to point at is a promise to a screen reader that
          nothing keeps. Which element that produces is `FormRow`'s decision now,
          not a thing each caller has to remember. */}
      <FormRow label={t('settings.language')} hint={t('settings.languageHint')}>
        <Segmented
          className="grow-0 shrink-0 basis-auto min-w-50"
          label={t('settings.language')}
          value={locale}
          options={LOCALES.map((l) => ({ value: l.id, label: l.label }))}
          onChange={setLocale}
        />
      </FormRow>

      <ThemeRow />
      <ZoomRow />
    </Form>
  )
}

/**
 * Dark, light, or follow the OS.
 *
 * Between the language and the zoom because the three read as one sentence in
 * that order: what it is written in, how it looks, how big it is.
 *
 * Unlike the zoom below, the current value is **not** read on mount. It arrives
 * on `IPC.THEME_CHANGED` and is held in `theme/store.ts`, which is subscribed
 * for the whole session — so this stays correct while the dialog is open, which
 * a mount-time read would not: the OS can cross into dark mode with the settings
 * dialog on screen, and `system` is the one setting in this window that changes
 * without anybody touching it.
 *
 * The write is still a `settings.write`, like the zoom: main owns the window's
 * `backgroundColor`, the traffic lights and `nativeTheme`, and the answer comes
 * back through the store rather than through the reply. No optimistic update for
 * that reason — there is nothing to be optimistic about, the round trip is what
 * repaints the window.
 */
function ThemeRow(): ReactElement {
  const t = useT()
  const theme = useThemePreference()

  return (
    <FormRow label={t('settings.theme')} hint={t('settings.themeHint')}>
      <Segmented
        className="grow-0 shrink-0 basis-auto min-w-50"
        label={t('settings.theme')}
        value={theme}
        options={[
          { value: 'dark', label: t('settings.themeDark') },
          { value: 'light', label: t('settings.themeLight') },
          { value: 'system', label: t('settings.themeSystem') },
        ]}
        onChange={(next: UiTheme) => {
          void dispatch('settings.write', { theme: next })
        }}
      />
    </FormRow>
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
    <FormRow
      label={t('settings.zoom')}
      // Modifier symbols are never translated: they are what is printed on the
      // keys in front of the reader. Same rule as `shortcutHints`.
      hint={t('settings.zoomHint', { keys: isMacPlatform() ? '⌘+ / ⌘− / ⌘0' : 'Ctrl++ / Ctrl+− / Ctrl+0' })}
    >
      {/*
       * `value` is the step this zoom *is*, resolved by proximity rather than by
       * identity: the factor round-trips through a settings file and a
       * `setZoomFactor` call, so 1.25 can come back as 1.2500000000000002 and an
       * exact match would leave the group with nothing selected — which, with a
       * roving tabindex, is a control the keyboard cannot enter.
       */}
      <Segmented
        className="grow-0 shrink-0 basis-auto min-w-50"
        label={t('settings.zoom')}
        value={UI_ZOOM_STEPS.find((step) => zoom !== null && Math.abs(zoom - step) < 0.001) ?? -1}
        options={UI_ZOOM_STEPS.map((step) => ({
          value: step,
          label: `${String(Math.round(step * 100))}%`,
        }))}
        onChange={choose}
      />
    </FormRow>
  )
}
