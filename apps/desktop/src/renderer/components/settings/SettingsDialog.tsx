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
import { AgentSection } from './AgentSection'
import { AppearanceSection } from './AppearanceSection'
import { McpSection } from './McpSection'
import { PackagesSection } from './PackagesSection'
import { TimeoutsSection } from './TimeoutsSection'
import { Button } from '../../ui/Button'
import {
  MODAL_BODY,
  MODAL_FOOT,
  MODAL_HEAD,
  MODAL_MASK,
  MODAL_SHELL,
  MODAL_SIZE,
  MODAL_TITLE,
} from '../modalClasses'

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
    <div className={MODAL_MASK} onMouseDown={closeSettings}>
      <div
        className={MODAL_SHELL}
        /*
         * A fixed height rather than one that follows the section, because the
         * sections are very different sizes — the MCP one is four times the
         * About one — and a dialog that resized as you clicked through it would
         * move the rail out from under the cursor. The width is fixed for the
         * same reason, one axis over.
         *
         * 800 rather than the 760 every other dialog gets, because this one
         * carries the packages table: six rows whose longest cell is an
         * untranslated capability list, and 760 left it 24px short, so all six
         * wrapped and the section grew to twice its height. Measured — the table
         * stops wrapping at 784 in zh-CN and 786 in en; 800 clears both with a
         * little room for a reworded header. The `90vw` never binds at 100%
         * zoom: the window's own minWidth is 900, and 900 × 0.9 = 810. It exists
         * for the zoom steps, which shrink the CSS viewport — at 150% the table
         * wraps again, which is the trade zoom is for. See
         * `design/2026-08-04-settings-dialog-width.md`.
         *
         * The shared ceiling still applies and is still the binding one at most
         * window heights: 560 and 84vh only decide it above a 700px viewport.
         * That was true when both were rules and it is true now that both are in
         * one object; what changed is that a reader can see both at once.
         */
        style={{ ...MODAL_SIZE, width: 'min(800px, 90vw)', height: 'min(560px, 84vh)' }}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onMouseDown={stop}
      >
        <div className={MODAL_HEAD}>
          <span className={MODAL_TITLE}>{t('settings.title')}</span>
          <span className="flex-1" />
          <Button variant="ghost" icon label={t('settings.close')} onClick={closeSettings}>
            ✕
          </Button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* A tablist rather than a plain button row: a screen reader should
              announce "2 of 4", which is the whole reason the sections are a
              fixed, ordered array. */}
          <div
            className="flex flex-col flex-none w-37 gap-px py-snug px-tight bg-bg-2 border-r border-border overflow-y-auto"
            role="tablist"
            aria-label={t('settings.sections')}
          >
            {SETTINGS_SECTIONS.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={id === section}
                /*
                 * The selected and unselected tabs are alternatives, not a base
                 * plus an override: a class list has no cascade, so writing the
                 * resting paint and then patching it would hand whichever rule
                 * Tailwind happened to emit last. Every geometry class is
                 * repeated in both branches on purpose, and each branch names
                 * exactly one background, one border colour and one text colour.
                 * See the migration record §7.2.
                 *
                 * The selected branch states no `hover:`, which is what keeps a
                 * pointer from dragging the current section back to a resting
                 * grey — the same thing `.settings-nav-item.active` used to get
                 * for free by being written after `:hover` in the stylesheet.
                 */
                className={
                  id === section
                    ? 'text-left px-snug py-tight border rounded-control bg-accent-dim border-accent text-fg'
                    : 'text-left px-snug py-tight border rounded-control bg-transparent border-transparent text-fg-dim hover:bg-bg-3 hover:text-fg'
                }
                onClick={() => {
                  useSettingsDialogStore.getState().open(id)
                }}
              >
                {t(SECTION_LABEL[id])}
              </button>
            ))}
          </div>

          {/* `settings-pane` earns its name twice over and neither is a style:
              it is what the label-column override hangs off, and what the two
              descendant rules left in settings.css select through. It is the one
              name on this dialog that survives the move to utilities, and the
              shared body string carries the flex sizing the old pairing stated
              twice. */}
          <div
            className={`${MODAL_BODY} settings-pane min-w-0`}
            role="tabpanel"
            aria-label={t(SECTION_LABEL[section])}
          >
            <Section id={section} />
          </div>
        </div>

        <div className={MODAL_FOOT}>
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
  agent: 'settings.section.agent',
  packages: 'settings.section.packages',
  appearance: 'settings.section.appearance',
  timeouts: 'settings.section.timeouts',
  about: 'settings.section.about',
} as const satisfies Record<SettingsSection, string>

function Section({ id }: { id: SettingsSection }): ReactElement {
  switch (id) {
    case 'mcp':
      return <McpSection />
    case 'agent':
      return <AgentSection />
    case 'packages':
      return <PackagesSection />
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
