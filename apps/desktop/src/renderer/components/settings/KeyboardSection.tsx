import { useCallback, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { isMacPlatform } from '../../hooks'
import { useT } from '../../i18n'
import { conflictsWith, DEFAULT_BINDINGS } from '../../keys/bindings'
import { formatChord, recordChord, sameChord, type ChordPattern } from '../../keys/chord'
import { SHORTCUTS, shortcutById, type ShortcutId, type ShortcutScope } from '../../keys/registry'
import { rebind, resetAllBindings, resetBinding, useBindings } from '../../keys/store'
import { openShortcutSheet } from '../../state/shortcutSheetStore'
import { Button } from '../../ui/Button'
import { FormHint } from '../../ui/Form'

/**
 * Rebinding a chord.
 *
 * Three things are worth knowing before reading the code.
 *
 * **Only peek's own chords are editable.** The rows for `Enter` sending a
 * message, `⌘C` copying a selection and `↑` walking a list are here — a user
 * looking for "what are the shortcuts" should find all of them — but they are
 * read-only, because the user learned them from their operating system rather
 * than from peek and rebinding them only builds an app that disagrees with every
 * other app on the machine. `registry.ts` carries that as `rebindable`, and this
 * form obeys it rather than deciding it.
 *
 * **A conflict is a warning, not a rejection.** The form says which shortcut
 * would be shadowed and lets the binding through. Refusing would mean a user has
 * to reason about the order in which to make two swaps — bind A to B's chord,
 * bind B to something else — for a mistake that is visible, reversible and one
 * click from undone. The conflict line stays on screen for as long as the
 * conflict does, which is a stronger signal than a modal nobody reads.
 *
 * **This section is not a form.** It used to be built out of `FormRow`, with the
 * scope name in the label column and a whole group of shortcuts as the
 * "control". A scope is not the label of any control and a group of rows is not
 * a control, and the layout said so: `form-field`'s `flex: 1` is granted to
 * inputs and selects, so each group shrank to its own content and every group's
 * key column landed somewhere different. What this wants is a table — a section
 * heading and rows whose two ends align — which is what `ShortcutSheet` already
 * is, showing the same data. So the two surfaces are built alike now.
 *
 * The recorder is a `<button>` that listens for a keystroke rather than an input
 * that parses text. `recordChord` turns the keystroke into a pattern, including
 * the two family cases: pressing ⌘⌥3 records "⌘⌥ and a digit", because the digit
 * families are one binding and rebinding them one digit at a time is not a
 * keyboard model anyone could state.
 *
 * Design record: docs/design/2026-08-15-keyboard-settings-layout.md
 */
export function KeyboardSection(): ReactElement {
  const t = useT()
  const bindings = useBindings()
  const mac = isMacPlatform()
  const [recording, setRecording] = useState<ShortcutId | null>(null)

  return (
    <div className="flex flex-col">
      {SCOPE_ORDER.map((scope) => {
        const defs = SHORTCUTS.filter((def) => def.scope === scope)
        // Asked of the rows rather than of the scope: today every scope answers
        // the same for all of its members, and writing that coincidence into a
        // constant would be a rule nobody stated.
        const editable = defs.some((def) => def.rebindable)
        return (
          <section
            key={scope}
            className="pb-snug mb-snug border-b border-border last:border-b-0 last:mb-0 last:pb-0"
          >
            <h3 className="mb-tight text-fg-dim font-semibold">{t(SCOPE_LABEL[scope])}</h3>
            <div className="flex flex-col gap-tight">
              {defs.map((def) => (
                <ShortcutRow
                  key={def.id}
                  id={def.id}
                  mac={mac}
                  pattern={bindings.get(def.id) ?? null}
                  recording={recording === def.id}
                  onRecord={() => {
                    setRecording(def.id)
                  }}
                  onDone={() => {
                    setRecording(null)
                  }}
                  conflicts={conflictsOf(def.id, bindings.get(def.id) ?? null)}
                />
              ))}
            </div>
            {/* Why this group looks different from the one above it. The plain
                text and the keycap buttons are two renderings of one table, and
                the difference is exactly "can you change this" — worth seeing,
                but only once it has been said out loud. */}
            {editable ? null : <FormHint className="mt-tight">{t('keys.settings.readOnly')}</FormHint>}
          </section>
        )
      })}

      <div className="flex flex-wrap gap-tight mt-snug">
        <Button onClick={openShortcutSheet}>{t('keys.settings.showSheet')}</Button>
        <Button onClick={resetAllBindings}>{t('keys.settings.resetAll')}</Button>
      </div>
    </div>
  )

  /** What this binding shadows, as it currently stands. */
  function conflictsOf(id: ShortcutId, pattern: ChordPattern | null): ShortcutId[] {
    return pattern === null ? [] : conflictsWith(id, pattern, bindings)
  }
}

/* ================================================================== */
/* One row                                                             */
/* ================================================================== */

interface RowProps {
  id: ShortcutId
  pattern: ChordPattern | null
  mac: boolean
  recording: boolean
  conflicts: ShortcutId[]
  onRecord: () => void
  onDone: () => void
}

function ShortcutRow({ id, pattern, mac, recording, conflicts, onRecord, onDone }: RowProps): ReactElement {
  const t = useT()
  const def = shortcutById(id)

  /**
   * The keystroke, taken before anything else sees it.
   *
   * `preventDefault` and `stopPropagation` are both load-bearing: without them,
   * recording ⌘W would close the tab behind the dialog on the way to being
   * recorded, and Escape would close the dialog rather than cancelling the
   * recording. This handler is the one place in the window where a chord means
   * "the chord itself" rather than what it is bound to.
   */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onDone()
        return
      }
      // Backspace clears the binding: an explicit "off", reachable without
      // having to know which chord is a safe nothing to bind it to.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        rebind(id, null)
        onDone()
        return
      }
      const recorded = recordChord({
        key: e.key,
        code: e.nativeEvent.code,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      })
      // Modifiers alone are the user still on their way to a chord, not a chord.
      if (!recorded) return
      rebind(id, recorded)
      onDone()
    },
    [id, onDone],
  )

  const label = <span className="min-w-0 flex-1 truncate">{t(def.labelKey)}</span>
  const chord = pattern ? formatChord(pattern, mac) : t('keys.settings.off')

  if (!def.rebindable) {
    return (
      // `min-h-hit` is the same floor a `md` button sits on (`ui/spec.ts`): the
      // read-only rows and the editable ones are one table, and a table whose
      // line height changes with the kind of row reads as two interleaved.
      <div className="flex items-center gap-snug min-h-hit">
        {label}
        {/* Not a disabled button: there is no action here to disable. A plain
            readout says "this is how it is" instead of "this is broken". */}
        <span className="font-mono text-fg-dim whitespace-nowrap">{chord}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-tight">
      <div className="flex items-center gap-snug">
        {label}
        {/* Left of the chord, not right of it. It comes and goes with whether
            this row has been changed, and on the right it would shove the key
            column sideways at the exact moment the user is editing it. Here the
            flexible label absorbs it and nothing moves. */}
        {isDefaultBinding(id, pattern) ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              resetBinding(id)
            }}
          >
            {t('keys.settings.reset')}
          </Button>
        )}
        <Button
          variant={recording ? 'primary' : undefined}
          onClick={recording ? onDone : onRecord}
          onKeyDown={recording ? onKeyDown : undefined}
          aria-label={t('keys.settings.record', { name: t(def.labelKey) })}
        >
          <span className="font-mono whitespace-nowrap">
            {recording ? t('keys.settings.recording') : chord}
          </span>
        </Button>
      </div>
      {conflicts.length > 0 && (
        <FormHint tone="warn">
          {t('keys.settings.conflict', {
            others: conflicts.map((other) => t(shortcutById(other).labelKey)).join(', '),
          })}
        </FormHint>
      )}
    </div>
  )
}

/**
 * Is this row still what peek shipped?
 *
 * Three ways to differ, and the null-vs-pattern pair is the one that would be
 * missed by comparing chords alone: a shortcut the user *turned off* is a
 * change, and `null` is how that is spelt.
 */
function isDefaultBinding(id: ShortcutId, pattern: ChordPattern | null): boolean {
  const fallback = DEFAULT_BINDINGS.get(id) ?? null
  if (pattern === null || fallback === null) return pattern === fallback
  return sameChord(pattern, fallback)
}

/* Same order as the sheet, so the two surfaces read alike. */
const SCOPE_ORDER: readonly ShortcutScope[] = ['window', 'grid', 'composer', 'nav', 'modal', 'menu']

const SCOPE_LABEL = {
  window: 'keys.scope.window',
  grid: 'keys.scope.grid',
  composer: 'keys.scope.composer',
  nav: 'keys.scope.nav',
  modal: 'keys.scope.modal',
  menu: 'keys.scope.menu',
} as const satisfies Record<ShortcutScope, string>
