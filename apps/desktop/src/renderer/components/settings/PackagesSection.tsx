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

      <table className="pkg-table">
        <thead>
          <tr>
            <th scope="col">{t('settings.packages.name')}</th>
            <th scope="col">{t('settings.packages.version')}</th>
            <th scope="col">{t('settings.packages.capabilities')}</th>
          </tr>
        </thead>
        <tbody>
          {DRIVER_MANIFESTS.map((manifest) => (
            <tr key={manifest.driverId}>
              <th scope="row">
                {manifest.displayName}
                {/* The id, not just the proper name: it is what a connection
                    config, an MCP `connect` call and an error message all say,
                    so it is the string someone actually has to match against. */}
                <span className="pkg-id mono">{manifest.driverId}</span>
              </th>
              <td className="mono">{manifest.version}</td>
              <td className="pkg-caps mono">{manifest.capabilities.join(' · ')}</td>
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
      <div className="form-row-stack">
        <span className="form-label">{t('settings.packages.viewKinds')}</span>
        {viewKinds.length === 0 ? (
          <span className="form-hint">{t('settings.packages.noViewKinds')}</span>
        ) : (
          <ul className="pkg-kinds">
            {viewKinds.map((kind) => {
              const entry = lookupViewKind(kind)
              return (
                <li key={kind}>
                  <span className="mono">{kind}</span>
                  {entry === null ? null : <span className="pkg-kind-label">{t(entry.titleKey)}</span>}
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
