import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { useModalDialog } from '../../hooks'
import { useT } from '../../i18n'
import {
  SETTINGS_SECTIONS,
  closeSettings,
  useSettingsDialogStore,
  type SettingsSection,
} from '../../state/settingsDialogStore'
import { AboutSection } from './AboutSection'
import { AppearanceSection } from './AppearanceSection'
import { McpSection } from './McpSection'
import { TimeoutsSection } from './TimeoutsSection'
import { Button } from '../../ui/Button'

/**
 * Everything peek can be configured to do, in one place.
 *
 * Before this dialog the preferences were three surfaces that each belonged to
 * something else: the MCP endpoint hung off the *connection* list's title row,
 * the language sat in the status bar, and the timeouts had no interface at all.
 * None of them could answer "what can I change?" — and the settings file was
 * only going to grow.
 *
 * Two decisions worth keeping:
 *
 * - **A modal, not a view.** Settings is open-change-close; it never needs to sit
 *   beside a table. Making it a `ViewKind` would have bought the layout tree's
 *   full power in exchange for answering "what if two are open" and "does it
 *   persist", questions nothing here wants to have.
 * - **The section is store state, not a prop.** `⌘,` is handled by a `window`
 *   listener that cannot reach a `useState` setter, and the first-run guide opens
 *   this straight on the MCP section. See `state/settingsDialogStore.ts`.
 */
export function SettingsDialog(): ReactElement | null {
  const section = useSettingsDialogStore((s) => s.section)
  if (section === null) return null
  return <OpenSettings section={section} />
}

/**
 * The dialog, when there is one.
 *
 * Split out because `useModalDialog` — which owns Escape, the focus trap and
 * putting focus back where it came from — cannot be called conditionally, and
 * the closed state renders nothing. Keeping the hook mounted exactly as long as
 * the dialog is on screen is also what makes its push/pop of the modal stack
 * correct with no extra bookkeeping.
 */
function OpenSettings({ section }: { section: SettingsSection }): ReactElement {
  const t = useT()
  const dialogRef = useModalDialog({ label: 'settings', onClose: closeSettings })

  return (
    <div className="modal-mask" onMouseDown={closeSettings}>
      <div
        className="modal settings-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onMouseDown={stop}
      >
        <div className="modal-head">
          <span className="t">{t('settings.title')}</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" icon label={t('settings.close')} onClick={closeSettings}>
            ✕
          </Button>
        </div>

        <div className="settings-split">
          {/* A tablist rather than a plain button row: a screen reader should
              announce "2 of 4", which is the whole reason the sections are a
              fixed, ordered array. */}
          <div className="settings-nav" role="tablist" aria-label={t('settings.sections')}>
            {SETTINGS_SECTIONS.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={id === section}
                className={id === section ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => {
                  useSettingsDialogStore.getState().open(id)
                }}
              >
                {t(SECTION_LABEL[id])}
              </button>
            ))}
          </div>

          <div className="modal-body settings-pane" role="tabpanel" aria-label={t(SECTION_LABEL[section])}>
            <Section id={section} />
          </div>
        </div>

        <div className="modal-foot">
          <Button variant="primary" onClick={closeSettings}>
            {t('settings.done')}
          </Button>
        </div>
      </div>
    </div>
  )
}

const SECTION_LABEL = {
  mcp: 'settings.section.mcp',
  appearance: 'settings.section.appearance',
  timeouts: 'settings.section.timeouts',
  about: 'settings.section.about',
} as const satisfies Record<SettingsSection, string>

function Section({ id }: { id: SettingsSection }): ReactElement {
  switch (id) {
    case 'mcp':
      return <McpSection />
    case 'appearance':
      return <AppearanceSection />
    case 'timeouts':
      return <TimeoutsSection />
    case 'about':
      return <AboutSection />
  }
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}
