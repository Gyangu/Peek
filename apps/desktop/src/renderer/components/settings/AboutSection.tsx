import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SettingsReadResult } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { Form, FormHint, FormRow } from '../../ui/Form'
import { Gallery } from '../../ui/Gallery'

/**
 * The version, and where peek keeps what it keeps.
 *
 * The paths are reported by main rather than spelled here: `~/.peek` moves with
 * `PEEK_CONFIG_DIR`, and a renderer that reconstructed the path would be
 * confidently wrong on exactly the machines where someone is looking it up.
 */
export function AboutSection(): ReactElement {
  const [info, setInfo] = useState<SettingsReadResult | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (res) setInfo(res)
    })
  }, [])

  return (
    <>
      <PathsForm info={info} />

      {/*
       * The control gallery, in dev builds only. It lives here rather than
       * behind its own command because it is a reference, not a feature — and
       * because a reference nobody can find is the state this codebase was
       * already in. `import.meta.env.DEV` is a compile-time constant, so the
       * whole subtree is dropped from the production bundle.
       *
       * Outside the form rather than after its last row: a rule and a gallery
       * span the pane, and everything inside a `<Form>` is placed in one of two
       * columns. It was never form content; the flex layout it used to sit in
       * simply had no opinion about that.
       */}
      {import.meta.env.DEV ? (
        <>
          {/* `.gal-sep` until `ui/controls.css` was deleted — the last of the
              gallery's classes, and the only one that was ever worn outside it. */}
          <hr className="h-0 mt-loose mb-snug mx-0 border-0 border-t border-border" />
          <div className="text-fg-faint mb-snug">Control gallery — renderer/ui/CLAUDE.md</div>
          <Gallery />
        </>
      ) : null}
    </>
  )
}

function PathsForm({ info }: { info: SettingsReadResult | null }): ReactElement {
  const t = useT()

  return (
    <Form>
      {/* Version and paths are identifiers; they are never translated. */}
      {/* No `htmlFor`: the value is a span, and a span cannot be labelled. This
          row and the four below it were 28px out of line with each other until
          the element stopped being the caller's to pick. */}
      <FormRow label={t('settings.about.version')}>
        <span className="font-mono tabular-nums">
          {info?.version === '' ? t('settings.about.unavailable') : info?.version}
        </span>
      </FormRow>

      {PATHS.map(([key, label]) => (
        <FormRow key={key} label={t(label)} htmlFor={`peek-path-${key}`}>
          <input
            id={`peek-path-${key}`}
            className="font-mono tabular-nums"
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
        </FormRow>
      ))}
      <FormHint>{t('settings.about.pathsHint')}</FormHint>
    </Form>
  )
}

const PATHS = [
  ['configDir', 'settings.about.configDir'],
  ['settingsFile', 'settings.about.settingsFile'],
  ['connectionsFile', 'settings.about.connectionsFile'],
  ['mcpFile', 'settings.about.mcpFile'],
] as const satisfies readonly (readonly [keyof SettingsReadResult['paths'], Parameters<TFunction>[0]])[]
