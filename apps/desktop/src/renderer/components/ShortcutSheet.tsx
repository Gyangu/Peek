import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { isMacPlatform, useModalDialog } from '../hooks'
import { useT } from '../i18n'
import { formatChord } from '../keys/chord'
import { SHORTCUTS, type ShortcutScope } from '../keys/registry'
import { useBindings } from '../keys/store'
import { closeShortcutSheet, useShortcutSheetOpen } from '../state/shortcutSheetStore'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import {
  MODAL_BODY,
  MODAL_FOOT,
  MODAL_HEAD,
  MODAL_MASK,
  MODAL_SHELL,
  MODAL_SIZE,
  MODAL_TITLE,
} from './modalClasses'

/**
 * Every shortcut, on one screen, on `⌘/`.
 *
 * Until this existed the only written record of peek's keyboard was two status-
 * bar tooltips, and they covered the panel and tab families alone. That was
 * survivable while the window had nine chords and one of them was `⌘\`; it
 * stopped being survivable when the digits changed meaning — `⌘1` moved from
 * panels to tabs — and the only way for a user to find that out was to press it.
 *
 * It reads the *live* bindings, not the registry's defaults, which is the whole
 * reason `keys/store` is a store: a sheet that showed `⌘\` to somebody who had
 * rebound it would be worse than no sheet, because it would be believed.
 *
 * Grouped by scope, because scope is the thing the user is actually asking about
 * — "what can I press *here*" — and because it is the honest way to show that
 * `Escape` appears three times meaning three different things depending on what
 * has focus.
 */
export function ShortcutSheet(): ReactElement | null {
  const open = useShortcutSheetOpen()
  if (!open) return null
  return <OpenSheet />
}

/** Split out for the same reason `SettingsDialog` splits: hooks cannot be conditional. */
function OpenSheet(): ReactElement {
  const t = useT()
  const bindings = useBindings()
  const mac = isMacPlatform()
  const dialogRef = useModalDialog({ label: 'shortcuts', onClose: closeShortcutSheet })

  return (
    <div className={MODAL_MASK} onMouseDown={closeShortcutSheet}>
      <div
        className={MODAL_SHELL}
        style={{ ...MODAL_SIZE, height: 'min(560px, 84vh)' }}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('keys.sheet.title')}
        onMouseDown={stop}
      >
        <div className={MODAL_HEAD}>
          <span className={MODAL_TITLE}>{t('keys.sheet.title')}</span>
          <span className="flex-1" />
          <Button variant="ghost" icon label={t('settings.close')} onClick={closeShortcutSheet}>
            <Icon name="close" />
          </Button>
        </div>

        <div className={MODAL_BODY}>
          {SCOPE_ORDER.map((scope) => (
            <section key={scope} className="mb-snug last:mb-0">
              <h3 className="mb-tight text-fg-dim font-semibold">{t(SCOPE_LABEL[scope])}</h3>
              {/* Rows of flex rather than a two-column grid: the grid would need
                  an arbitrary track (`1fr auto`), and an arbitrary value is a
                  literal hung off a family — the one thing the theme guard
                  refuses, because a value written that way is invisible to every
                  assertion that checks the tokens. Each row aligning its own two
                  ends reads the same and needs no track at all. */}
              <dl className="flex flex-col gap-tight">
                {SHORTCUTS.filter((def) => def.scope === scope).map((def) => {
                  const pattern = bindings.get(def.id)
                  return (
                    <div key={def.id} className="flex items-baseline gap-snug">
                      <dt className="min-w-0 flex-1 truncate">{t(def.labelKey)}</dt>
                      {/* A disabled shortcut shows an em dash rather than
                          disappearing: "you turned this off" is information, and
                          a row that vanished would read as a shortcut peek does
                          not have. */}
                      <dd className="font-mono text-fg-dim whitespace-nowrap">
                        {pattern ? formatChord(pattern, mac) : '—'}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          ))}
        </div>

        <div className={MODAL_FOOT}>
          <Button variant="primary" onClick={closeShortcutSheet}>
            {t('settings.done')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Reading order.
 *
 * The window's own chords first — they are the ones nobody could have guessed —
 * then the surfaces, in the order a user meets them. The menu comes last because
 * its accelerators are also written next to the items themselves, so this is a
 * reminder rather than the only place they appear.
 */
const SCOPE_ORDER: readonly ShortcutScope[] = ['window', 'grid', 'composer', 'nav', 'modal', 'menu']

/* `as const` rather than a `Record<…, string>` annotation: `t` takes a message
 * key, not a string, so the literal types are what make a typo here a compile
 * error instead of a key rendered at the user. */
const SCOPE_LABEL = {
  window: 'keys.scope.window',
  grid: 'keys.scope.grid',
  composer: 'keys.scope.composer',
  nav: 'keys.scope.nav',
  modal: 'keys.scope.modal',
  menu: 'keys.scope.menu',
} as const satisfies Record<ShortcutScope, string>

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}
