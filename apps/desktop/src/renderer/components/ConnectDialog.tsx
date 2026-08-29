import { useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode, RefObject } from 'react'
import { localizedText } from '@peek/core'
import type { DriverId, SavedConnection } from '@peek/core'
import { driverCapabilities, manifestDriverIds } from '../../drivers/manifests'
import { useModalDialog } from '../hooks'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Form, FormHint, FormRow } from '../ui/Form'
import { Segmented } from '../ui/Segmented'
import { useLocale, useT } from '../i18n'
import { dispatch } from '../state/dispatch'
import { usePackagesRevision } from '../state/packagesStore'
import {
  MODAL_BODY,
  MODAL_FOOT,
  MODAL_HEAD,
  MODAL_MASK,
  MODAL_SHELL,
  MODAL_SIZE,
  MODAL_TITLE,
} from './modalClasses'
import {
  buildConnectionConfig,
  connectFields,
  connectFormSpec,
  connectModeFor,
  defaultConnectMode,
  initialConnectValues,
  missingRequiredFields,
  seedDriverId,
  valuesFromConfig,
  type ConnectField,
  type ConnectMode,
} from './connectForm'

/**
 * New connection — or an edit of one that was saved.
 *
 * The form is driven by `connectForm.ts` rather than hard-coded here: every
 * driver asks for different things (redis wants a numeric database index, qdrant
 * an API key, sqlite a path on disk), and the alternative — one text box per
 * driver — either lies about what is configurable or forces the user to hand-
 * assemble a URL peek could have assembled for them.
 *
 * ## Editing does not mean a second write path
 *
 * `initial` only *seeds the form*. What leaves the dialog is a `conn.open` in
 * both cases, and the connection book is written by main when that open
 * succeeds. So there is exactly one description of a connection in the system,
 * and it is the one that has actually connected — a "save" button that did not
 * dial would be a second, unverified one.
 *
 * The password box is the one thing that cannot be seeded: the saved config
 * carries no credential, by construction. Rather than showing a filled box that
 * is a lie, the dialog says the stored password will be used, and typing in the
 * box overrides it.
 */
export interface ConnectDialogProps {
  onClose: () => void
  /** Seed from a saved connection. Absent means a blank form. */
  initial?: SavedConnection
  /**
   * The connection book, as the sidebar last read it — what a **blank** form
   * opens on.
   *
   * The list rather than a driver id already chosen from it: picking one is
   * seeding, and seeding is this dialog's job (`seedDriverId`). The sidebar
   * holds the book because it draws it; it has no reason to know what a form
   * would do with it.
   */
  saved: readonly SavedConnection[]
}

export function ConnectDialog({ onClose, initial, saved }: ConnectDialogProps): ReactElement {
  const t = useT()
  // Everything below reads the installed registry synchronously — the picker's
  // ids, the field list, the capability line — so this subscription is what makes
  // a package installed while this dialog is open show up in it, which is design
  // §2.7 step 5 ("it can be picked in the connect dialog immediately"). The value
  // is deliberately unused.
  usePackagesRevision()
  // The locale itself, not just a bound `t`: a field's label is text the package
  // carries, so it is looked up in the manifest rather than in peek's catalog.
  const locale = useLocale()
  // Escape, focus containment, focus restoration. The initial focus is left to
  // the first field's `autoFocus` — see the note in `useModalDialog`.
  const dialogRef = useModalDialog({ label: 'connect', onClose })
  const seed = useMemo(() => seedFrom(initial, saved), [initial, saved])
  const [driverId, setDriverId] = useState<DriverId | null>(seed.driverId)
  const [mode, setMode] = useState<ConnectMode>(seed.mode)
  const [values, setValues] = useState<Record<string, string | boolean>>(seed.values)
  const [label, setLabel] = useState(seed.label)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const title = initial ? t('connect.editTitle') : t('connect.title')

  /**
   * The selected driver, but only while a package still provides it.
   *
   * Everything below this line reads the manifest — the mode list, the fields,
   * the assembly on submit — and `connectForm.ts` throws for a driver that has
   * none. Since Phase C that is not a wiring bug but an ordinary state with
   * three ways in, and this one expression is where all three are answered:
   *
   *   - `initial` names a driver whose package was uninstalled. The sidebar
   *     still lists that connection, because the book stores its own name
   *     (design 2026-08-07 §2.3(b-2)), so "edit" is still offered on a row
   *     nothing can open;
   *   - the package went away **while this dialog was open**. That is not
   *     hypothetical: `usePackagesRevision()` above exists precisely so this
   *     component re-renders when it does, and re-rendering is what would run
   *     the throw;
   *   - nothing is installed at all, so `seedDriverId` had nothing to pick.
   *     Both new-connection entrances are disabled in that state
   *     (`Sidebar.tsx`), which makes this the backstop rather than the notice.
   *
   * A throw here is not a broken dialog, it is a blank window: this runs inside
   * a render, and React's answer to that is to unmount the tree — `ErrorBoundary`
   * then offers a reload that lands in the same state, because what caused it is
   * on disk. Design 2026-08-11 §2.3.
   */
  const live = driverId !== null && manifestDriverIds().includes(driverId) ? driverId : null

  const missing = useMemo(
    () => (live === null ? [] : missingRequiredFields(live, mode, values)),
    [live, mode, values],
  )

  if (live === null) {
    return (
      <DialogShell shellRef={dialogRef} title={title} onClose={onClose}>
        <div className={MODAL_BODY}>
          {/* Named, and the name is the driver id — the same identifier the
              picker, the settings table and the MCP receipts spell, so the
              sentence lines up with the row the user is looking at.

              Not inside a `<Form>`: this branch is the dialog with no form in
              it. A hint outside the grid keeps its tone and loses only the
              column placement it has nothing to line up with. */}
          <FormHint tone="error">
            {driverId === null ? t('connect.noPackages') : t('connect.driverGone', { driverId })}
          </FormHint>
        </div>
        <div className={MODAL_FOOT}>
          <Button onClick={onClose}>{t('connect.cancel')}</Button>
        </div>
      </DialogShell>
    )
  }

  /**
   * Whether the stored credential is still the one that will be sent.
   *
   * It stops being true the moment the user types into the password box — main
   * only fills a field that arrives absent — and also when they edit a field the
   * credential is keyed by, because a password saved for one server is never
   * replayed at another. Rather than model that rule twice, the notice
   * disappears as soon as the form no longer matches what was saved.
   */
  const savedSecretInUse =
    initial?.hasSecret === true &&
    live === seed.driverId &&
    mode === seed.mode &&
    sameValues(values, seed.values)

  const spec = connectFormSpec(live)
  const fields = connectFields(live, mode)

  // Switching driver or mode resets to that form's defaults. Carrying values
  // across would mean a port left over from postgres quietly connecting a redis
  // client to 5432.
  const switchTo = (nextDriver: DriverId, nextMode: ConnectMode): void => {
    setDriverId(nextDriver)
    setMode(nextMode)
    setValues(initialConnectValues(nextDriver, nextMode))
    setIssue(null)
  }

  const setValue = (name: string, value: string | boolean): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setIssue(null)
  }

  const submit = (): void => {
    if (busy || missing.length > 0) return
    const built = buildConnectionConfig(live, mode, values, label)
    if (!built.ok) {
      setIssue(built.issue)
      return
    }
    setBusy(true)
    void dispatch('conn.open', { config: built.config, openTree: true })
      .then((res) => {
        if (res) onClose()
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <DialogShell shellRef={dialogRef} title={title} onClose={onClose}>
      <div className={MODAL_BODY}>
        <Form>
          <FormRow
            label={t('connect.driver')}
            htmlFor="peek-driver"
            // Capability names are part of the driver contract, never translated.
            hint={t('connect.capabilities', { list: (driverCapabilities()[live] ?? []).join(' · ') })}
          >
            <select
              id="peek-driver"
              value={live}
              onChange={(e) => {
                const next = e.target.value as DriverId
                switchTo(next, defaultConnectMode(next))
              }}
            >
              {/* Driver ids are identifiers: `postgres` reads the same everywhere. */}
              {/* Straight from the collected manifests, so a package that is loaded is
                  a package that is offered — there is no second list of ids to
                  fall out of step with, which is what `DRIVER_IDS` was. */}
              {manifestDriverIds().map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </FormRow>

          {spec.modes.length > 1 ? (
            /* No `htmlFor`: `<Segmented>` names itself. This row carried a bare
               `<label>` until the element stopped being the caller's to pick. */
            <FormRow label={t('connect.mode')}>
              <Segmented
                label={t('connect.mode')}
                value={mode}
                options={spec.modes.map((m) => ({
                  value: m,
                  label: t(m === 'url' ? 'connect.mode.url' : 'connect.mode.fields'),
                }))}
                onChange={(next) => {
                  switchTo(live, next)
                }}
              />
            </FormRow>
          ) : null}

          {fields.map((field, i) => (
            <FieldRow
              key={`${live}:${mode}:${field.name}`}
              locale={locale}
              field={field}
              value={values[field.name] ?? ''}
              autoFocus={i === 0}
              onChange={(v) => {
                setValue(field.name, v)
              }}
              onSubmit={submit}
            />
          ))}

          <FormRow label={t('connect.label')} htmlFor="peek-label">
            <input
              id="peek-label"
              value={label}
              placeholder={t('connect.labelPlaceholder')}
              onChange={(e) => {
                setLabel(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </FormRow>

          {savedSecretInUse ? (
            <FormHint>{t('connect.savedSecretInUse')}</FormHint>
          ) : initial?.hasSecret === true ? (
            // The form has moved away from what the credential was saved for, so
            // it will not be sent. Saying so here is cheaper than an
            // authentication failure the user has to interpret.
            <FormHint>{t('connect.savedSecretNotUsed')}</FormHint>
          ) : null}

          {/* The rejected field, named — evidence, not prose. It carried an
              inline colour, because the hint rule was unlayered and outranked
              any utility written beside it; the one hint that has to stand out
              read like the four around it. A tone is a tone now. */}
          {issue ? <FormHint tone="error">{t('connect.invalid', { issue })}</FormHint> : null}
          <FormHint>{t('connect.privacyNote')}</FormHint>
        </Form>
      </div>
      <div className={MODAL_FOOT}>
        <Button onClick={onClose}>{t('connect.cancel')}</Button>
        <Button variant="primary" action="conn.open" disabled={busy || missing.length > 0} onClick={submit}>
          {busy ? t('connect.connecting') : t('connect.submit')}
        </Button>
      </div>
    </DialogShell>
  )
}

/* ------------------------------------------------------------------ */

interface DialogShellProps {
  shellRef: RefObject<HTMLDivElement | null>
  title: string
  onClose: () => void
  children: ReactNode
}

/**
 * The mask, the box and the title bar — everything this dialog is before it
 * knows whether it has a form to draw.
 *
 * Extracted when the "no package provides this driver" state arrived: that state
 * is still *this dialog*, with the same title, the same Escape key and the same
 * position on screen, and the alternative was a second copy of the markup below
 * whose only job would be to stay identical to the first.
 *
 * The mask does **not** close this one, and that is the difference between it
 * and `ValueModal`. This dialog holds typed input — a host, a port, a password —
 * and a stray click on the dimmed area outside it used to discard all of it with
 * no confirmation and no undo. A read-only modal can be dismissed by clicking
 * away; a form cannot. Escape and Cancel are the ways out, and both are
 * deliberate acts.
 */
function DialogShell({ shellRef, title, onClose, children }: DialogShellProps): ReactElement {
  const t = useT()
  return (
    <div className={MODAL_MASK}>
      <div
        className={MODAL_SHELL}
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        /* Narrower than the shared dialog: a form of short labelled fields does
           not want a 760px measure. It was already an inline width, with a note
           saying it had to be one because the shared rule was unlayered and beat
           every utility on this element. The rule is gone; the width stays
           inline for the reason `modalClasses.ts` gives, and it now states the
           height ceiling it used to inherit from that rule. Flat pixels rather
           than a viewport clamp, which is what it has always shipped. */
        style={{ ...MODAL_SIZE, width: 520 }}
        onMouseDown={stop}
      >
        <div className={MODAL_HEAD}>
          <span className={MODAL_TITLE}>{title}</span>
          <span className="flex-1" />
          <Button variant="ghost" icon label={t('app.errors.close')} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface FieldRowProps {
  locale: string
  field: ConnectField
  value: string | boolean
  autoFocus: boolean
  onChange: (value: string | boolean) => void
  onSubmit: () => void
}

function FieldRow({ locale, field, value, autoFocus, onChange, onSubmit }: FieldRowProps): ReactElement {
  const id = `peek-field-${field.name}`
  if (field.type === 'checkbox') {
    return (
      <FormRow label={localizedText(field.label, locale)} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => {
            onChange(e.target.checked)
          }}
        />
      </FormRow>
    )
  }
  return (
    <FormRow label={localizedText(field.label, locale)} htmlFor={id}>
      <input
        id={id}
        className={field.mono === true ? 'font-mono tabular-nums' : undefined}
        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder}
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
      />
    </FormRow>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}

/* ------------------------------------------------------------------ */

interface Seed {
  /**
   * Null only when nothing is installed and there was no `initial` to name a
   * driver — the one case with no id to put in the message, which is why the
   * guard above has two sentences rather than one.
   */
  driverId: DriverId | null
  mode: ConnectMode
  values: Record<string, string | boolean>
  label: string
}

/**
 * A blank form, or the saved connection unpacked back into one.
 *
 * Neither branch may call into `connectForm.ts` for a driver with no manifest —
 * that is the throw design 2026-08-11 is about, and seeding is the one place
 * that used to do it unconditionally (with the literal `'postgres'`). So both
 * check first and hand the guard an unusable seed rather than a form built from
 * a lookup that cannot succeed.
 */
function seedFrom(initial: SavedConnection | undefined, saved: readonly SavedConnection[]): Seed {
  const installed = manifestDriverIds()
  if (!initial) {
    const driverId = seedDriverId(saved, installed)
    if (driverId === null) return { driverId, mode: 'fields', values: {}, label: '' }
    const mode = defaultConnectMode(driverId)
    return { driverId, mode, values: initialConnectValues(driverId, mode), label: '' }
  }
  if (!installed.includes(initial.driverId)) {
    // The id is kept so the guard can name it: this is the row the user clicked
    // "edit" on, and "some package is missing" would leave them to work out
    // which one.
    return { driverId: initial.driverId, mode: 'fields', values: {}, label: '' }
  }
  const config = initial.config as unknown as Record<string, unknown>
  const mode = connectModeFor(initial.driverId, config)
  return {
    driverId: initial.driverId,
    mode,
    values: valuesFromConfig(initial.driverId, mode, config),
    // Only a label the user actually chose is carried back. `SavedConnection.label`
    // falls back to a derived one, and putting that in the box would turn a
    // generated name into a typed one on the next save.
    label: typeof config['label'] === 'string' ? config['label'] : '',
  }
}

function sameValues(
  a: Readonly<Record<string, string | boolean>>,
  b: Readonly<Record<string, string | boolean>>,
): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  return keys.every((key) => a[key] === b[key])
}
