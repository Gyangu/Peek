import type { ReactElement } from 'react'
import { DRIVER_MANIFESTS } from '../../../drivers/manifests'
import { useT } from '../../i18n'
import { registeredViewKinds, lookupViewKind } from '../../plugins/viewKinds'

/**
 * Which database packages this build carries, and at what version.
 *
 * ## Why this section exists at all
 *
 * Up to now "which databases does peek support" was answerable only by reading
 * the connect dialog's picker, and "which build of the connector am I running"
 * was not answerable at all. The second question is the one that matters when a
 * driver behaves differently from yesterday, and it is the question Phase C
 * makes unavoidable: once a package can be installed from outside the repo and
 * updated on its own, the app's own version stops describing it.
 *
 * ## Everything here is read from the manifests, nothing is restated
 *
 * `displayName`, `version` and `capabilities` all come off the same
 * `DriverManifest` the connect dialog and the MCP receipts read, by identity. A
 * hand-written table here would be a fourth description of the same six
 * packages, and the first one to go stale would be this one — because nothing
 * fails when a settings panel is wrong.
 *
 * The capability names are **not** translated. They are the vocabulary of the
 * contract (`introspect`, `tabularQuery`, …), they appear verbatim in the MCP
 * receipts a user may be reading beside this dialog, and inventing a localized
 * synonym would make the two impossible to line up. Same rule the version and
 * the driver id follow.
 */
export function PackagesSection(): ReactElement {
  const t = useT()
  const viewKinds = registeredViewKinds()

  return (
    <>
      <div className="form-hint">{t('settings.packages.hint')}</div>

      {/*
       * A real table, not a list of `.form-row`s. What is being read here is
       * three values compared down a column ("which of these is at a different
       * version"), and the label-gutter form layout the rest of this pane uses
       * cannot line up a column at all. It gets the full pane width, hence no
       * label gutter.
       *
       * The cell shape is spelled out on every `th` and `td` rather than hoisted
       * into a shared constant. A constant would read better and would also be
       * invisible to the three contract tests, which scan `className` attributes
       * — the same blind spot `ui/spec.ts` had to be given its own scan for.
       * Six repetitions is the price of staying auditable.
       */}
      <table className="w-full border-collapse mt-tight mb-loose text-body">
        <thead>
          <tr>
            <th scope="col" className="text-left align-top py-tight pr-snug pl-0 border-b border-border text-fg-faint font-medium">
              {t('settings.packages.name')}
            </th>
            <th scope="col" className="text-left align-top py-tight pr-snug pl-0 border-b border-border text-fg-faint font-medium">
              {t('settings.packages.version')}
            </th>
            <th scope="col" className="text-left align-top py-tight pr-snug pl-0 border-b border-border text-fg-faint font-medium">
              {t('settings.packages.capabilities')}
            </th>
          </tr>
        </thead>
        <tbody>
          {DRIVER_MANIFESTS.map((manifest) => (
            <tr key={manifest.driverId}>
              <th scope="row" className="text-left align-top py-tight pr-snug pl-0 border-b border-border font-medium whitespace-nowrap">
                {manifest.displayName}
                {/* The id, not just the proper name: it is what a connection
                    config, an MCP `connect` call and an error message all say,
                    so it is the string someone actually has to match against.

                    It sits under the proper name rather than beside it: the two
                    are the same fact at different levels of formality, and a
                    second column for it would push the numbers people are
                    comparing further apart. */}
                <span className="font-mono tabular-nums block text-fg-faint text-micro">{manifest.driverId}</span>
              </th>
              <td className="font-mono tabular-nums align-top py-tight pr-snug pl-0 border-b border-border">{manifest.version}</td>
              {/* Capabilities are the longest cell and the least urgent, so they
                  are the one allowed to wrap. */}
              <td className="font-mono tabular-nums align-top py-tight pr-snug pl-0 border-b border-border text-fg-dim whitespace-normal">
                {manifest.capabilities.join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/*
       * View kinds are listed separately rather than as a column on the table
       * above, because the relationship is not one per database: a package may
       * contribute none (the five that browse as tables) or more than one, and a
       * kind's registration says which *plugin* draws it, not which driver id it
       * belongs to. Joining the two on a name that happens to match today would
       * be a coincidence dressed as a fact.
       */}
      {/* A label above its content rather than beside it, for the one block here
          whose content is a list and would otherwise be indented into a narrow
          column. `.form-label` therefore picks up none of the label-column
          geometry: that rule is `.form-row .form-label`, and this is not one. */}
      <div className="flex flex-col gap-tight mb-snug">
        <span className="form-label">{t('settings.packages.viewKinds')}</span>
        {viewKinds.length === 0 ? (
          <span className="form-hint">{t('settings.packages.noViewKinds')}</span>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-tight">
            {viewKinds.map((kind) => {
              const entry = lookupViewKind(kind)
              return (
                <li key={kind}>
                  <span className="font-mono tabular-nums">{kind}</span>
                  {entry === null ? null : <span className="ml-snug text-fg-faint">{t(entry.titleKey)}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Honest about what this build is: everything above is compiled in, so
          nothing here can be installed or removed yet. Saying so is better than
          a disabled "Install…" button that implies otherwise. */}
      <div className="form-hint">{t('settings.packages.builtinHint')}</div>
    </>
  )
}
