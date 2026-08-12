import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PackageListing } from '@peek/core'
import { lookupManifest } from '../../../drivers/manifests'
import { tryBridge } from '../../bridge'
import { useT } from '../../i18n'
import { registeredViewKinds, lookupViewKind } from '../../packages/viewKinds'
import { dispatch } from '../../state/dispatch'
import { usePackagesRevision } from '../../state/packagesStore'
import { Button } from '../../ui/Button'

/**
 * Which database packages are installed, and the buttons that change that.
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
 *
 * ## Two sources, joined on the driver id (design §2.8b)
 *
 * `packages.read` answers *what is installed and where it came from*, one row
 * per package. The manifests answer *what one database is called and what it can
 * do*, one row per driver. Neither can answer the other's question:
 * `PackageListing` carries no display name and no capabilities, and a manifest
 * has no idea which package shipped it or whether peek ships one under that id.
 *
 * So the set of rows comes from the command and three of the cells come from the
 * registry. The two are momentarily out of step whenever `PACKAGES_CHANGED`
 * lands — the registry is replaced synchronously, the re-read of `packages.read`
 * is a round trip behind it — which is why a missed lookup draws the driver id
 * alone rather than throwing. A null from `lookupManifest` is an ordinary value
 * on this path, not a defect.
 *
 * ## Nothing here claims a package was checked
 *
 * Design §2.9 corollary 1: peek runs whatever is in the packages directory, with
 * no signature check, no hash check and no sandbox. So no copy on this surface
 * may contain "verified", "safe" or "trusted", and there is no inspection step
 * to put a progress bar in front of — a check that always passes is what teaches
 * people that warnings are things you click through. What stands in its place is
 * one plain sentence (`trustNote`) stating what installing actually grants, and
 * receipts that say what happened rather than what it means: "Removed postgres",
 * never "completely removed".
 */
export function PackagesSection(): ReactElement {
  const t = useT()
  // The registry behind `lookupManifest` and `registeredViewKinds` is a module
  // slot that a `packages.*` command replaces (design §2.7). Without this
  // subscription the panel would keep showing a package that has been
  // uninstalled from underneath it, on the very screen the uninstall was
  // requested from.
  const revision = usePackagesRevision()
  const viewKinds = registeredViewKinds()

  const [packages, setPackages] = useState<PackageListing[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Keyed on `revision` rather than running only on mount: an install performed
  // from an MCP client, or from a second window, moves the registry under this
  // panel while it is open, and the broadcast that carries it is the same one
  // the counter follows.
  useEffect(() => {
    void dispatch('packages.read', {}).then((result) => {
      if (result) setPackages(result.packages)
    })
  }, [revision])

  /**
   * Run one of the three writing verbs and adopt the list it hands back.
   *
   * The receipt's own `packages` is applied rather than waiting for the re-read
   * above, because a refused command returns `null` — `dispatch` has already put
   * the reason in the error centre — and in that case what is on screen is still
   * correct and must not be blanked.
   */
  const run = useCallback(async (act: () => Promise<PackageListing[] | null>): Promise<void> => {
    setBusy(true)
    try {
      const next = await act()
      if (next) setPackages(next)
    } finally {
      setBusy(false)
    }
  }, [])

  const install = (): void => {
    const bridge = tryBridge()
    // Feature-probed even though `PeekBridge` requires it, for the reason
    // `useMenuActions` gives: `tryBridge` only vouches for `invoke` and
    // `getSnapshot`, and a preload older than this channel would otherwise take
    // the window down on a click.
    if (!bridge || typeof bridge.pickPackageDir !== 'function') return
    void run(async () => {
      const dir = await bridge.pickPackageDir()
      // Cancelled. Deliberately silent: the user closed a dialog they had just
      // opened, and a line saying so would be the panel narrating its own
      // inaction.
      if (dir === null) return null
      const result = await dispatch('packages.install', { dir })
      if (!result) return null
      setNotice(
        result.replaced
          ? t('settings.packages.replaced', { id: result.id, version: result.version })
          : t('settings.packages.installed', { id: result.id, version: result.version }),
      )
      return result.packages
    })
  }

  const upgrade = (id: string): void => {
    void run(async () => {
      // The same `packages.install`, naming this build's own copy instead of a
      // directory: §2.4 is explicit that an upgrade *is* an install over an id
      // that is already there, and that there is no second verb for it. The
      // window cannot spell the path — `PackageListing` carries none, by design
      // — so it names the package and main resolves it.
      const result = await dispatch('packages.install', { bundledId: id })
      if (!result) return null
      setNotice(t('settings.packages.replaced', { id: result.id, version: result.version }))
      return result.packages
    })
  }

  const uninstall = (id: string): void => {
    void run(async () => {
      const result = await dispatch('packages.uninstall', { id })
      if (!result) return null
      setNotice(
        result.closedConnIds.length === 0
          ? t('settings.packages.uninstalled', { id: result.id })
          : t('settings.packages.uninstalledClosed', {
              id: result.id,
              count: result.closedConnIds.length,
            }),
      )
      return result.packages
    })
  }

  const restore = (): void => {
    void run(async () => {
      const result = await dispatch('packages.restore', {})
      if (!result) return null
      // Three outcomes, and the empty one is not a failure: it means nothing
      // this build ships was missing, which is what most presses will find.
      // Saying so is the whole difference between a button that worked and a
      // button that did nothing visible.
      setNotice(
        result.failed.length > 0
          ? t('settings.packages.restoreFailed', {
              ids: result.failed.map((entry) => entry.id).join(', '),
            })
          : result.restored.length === 0
            ? t('settings.packages.restoredNone')
            : t('settings.packages.restored', { ids: result.restored.join(', ') }),
      )
      return result.packages
    })
  }

  return (
    <>
      <div className="form-hint">{t('settings.packages.hint')}</div>

      <div className="flex flex-wrap gap-tight mt-tight form-actions mb-snug">
        <Button variant="primary" disabled={busy} onClick={install}>
          {t('settings.packages.install')}
        </Button>
      </div>
      {/* Beside the button that grants it rather than at the foot of the pane:
          the sentence is about what pressing that button does. */}
      <div className="form-hint">{t('settings.packages.trustNote')}</div>

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
            <th scope="col" className="text-left align-top py-tight pr-snug pl-0 border-b border-border text-fg-faint font-medium">
              {t('settings.packages.source')}
            </th>
            {/* The buttons say what they do, so a visible heading over them
                would be a word that helps nobody read the table. It is still a
                column, and a screen reader walking the row announces it. */}
            <th scope="col" className="text-left align-top py-tight pr-snug pl-0 border-b border-border text-fg-faint font-medium">
              <span className="sr-only">{t('settings.packages.manage')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(packages ?? []).map((pkg) =>
            /*
             * One row per database, with source and the buttons spanning the
             * package (design §2.8a). A package may provide several databases —
             * `db-sql` provides mysql and sqlite — and uninstalling takes
             * all of them with it. Two buttons side by side would say the
             * opposite; one button spanning both rows says it exactly, and it is
             * the true shape of the data rather than a layout trick.
             *
             * The three compared columns stay one-per-driver, because that is
             * what they describe: capabilities are declared per driver, and
             * merging two drivers' lists into one cell would be a guess on the
             * day they stop agreeing.
             */
            pkg.driverIds.map((driverId, index) => {
              const manifest = lookupManifest(driverId)
              return (
                <tr key={driverId}>
                  <th scope="row" className="text-left align-top py-tight pr-snug pl-0 border-b border-border font-medium whitespace-nowrap">
                    {manifest?.displayName ?? driverId}
                    {/* The id, not just the proper name: it is what a connection
                        config, an MCP `connect` call and an error message all say,
                        so it is the string someone actually has to match against.

                        It sits under the proper name rather than beside it: the two
                        are the same fact at different levels of formality, and a
                        second column for it would push the numbers people are
                        comparing further apart. */}
                    <span className="font-mono tabular-nums block text-fg-faint text-micro">{driverId}</span>
                  </th>
                  {/* The row's version, not the manifest's, though the two are
                      the same string: a package states one version and the
                      loader stamps it onto each of its drivers. Reading it off
                      the listing keeps this cell answerable during the frame in
                      which the registry is a round trip ahead. */}
                  <td className="font-mono tabular-nums align-top py-tight pr-snug pl-0 border-b border-border">{pkg.version}</td>
                  {/* Capabilities are the longest cell and the least urgent, so they
                      are the one allowed to wrap. */}
                  <td className="font-mono tabular-nums align-top py-tight pr-snug pl-0 border-b border-border text-fg-dim whitespace-normal">
                    {manifest?.capabilities.join(' · ') ?? ''}
                  </td>
                  {index > 0 ? null : (
                    <td rowSpan={pkg.driverIds.length} className="align-top py-tight pr-snug pl-0 border-b border-border text-fg-dim whitespace-nowrap">
                      {pkg.source === 'bundled'
                        ? t('settings.packages.sourceBundled')
                        : t('settings.packages.sourceUser')}
                    </td>
                  )}
                  {index > 0 ? null : (
                    <td rowSpan={pkg.driverIds.length} className="align-top py-tight pr-snug pl-0 border-b border-border">
                      <div className="flex flex-wrap gap-tight">
                        {pkg.upgradeVersion === undefined ? null : (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              upgrade(pkg.id)
                            }}
                          >
                            {t('settings.packages.upgrade', { version: pkg.upgradeVersion })}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            uninstall(pkg.id)
                          }}
                        >
                          {t('settings.packages.uninstall')}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              )
            }),
          )}
        </tbody>
      </table>

      {/* Two different silences, told apart. `null` is a round trip that has not
          come back; an empty list is an answer, and a bleak one — nothing
          installed means no database peek can open. */}
      {packages === null ? (
        <div className="form-hint">{t('settings.packages.reading')}</div>
      ) : packages.length === 0 ? (
        <div className="form-hint">{t('settings.packages.empty')}</div>
      ) : null}

      <div className="form-hint">{t('settings.packages.sourceNote')}</div>

      {/* Decision 1's safety net, and the reason it is a button rather than a
          documented file to go and delete: a user who removed PostgreSQL has to
          be able to get it back with one click, not by reinstalling the app
          (§2.5). */}
      <div className="flex flex-wrap gap-tight mt-tight form-actions mb-snug">
        <Button disabled={busy} onClick={restore}>
          {t('settings.packages.restore')}
        </Button>
      </div>

      {notice ? <div className="form-hint">{notice}</div> : null}

      {/*
       * View kinds are listed separately rather than as a column on the table
       * above, because the relationship is not one per database: a package may
       * contribute none (the five that browse as tables) or more than one, and a
       * kind's registration says which *package* draws it, not which driver id it
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
    </>
  )
}
