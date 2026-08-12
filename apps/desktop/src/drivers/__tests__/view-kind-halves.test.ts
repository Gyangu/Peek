import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { InstalledPackages } from '@peek/core'
import { clearInstalledPackages, installPackages } from '../installed'
import { IN_REPO_PACKAGES } from './in-repo-packages'
import { VIEW_KIND_CONTRACTS, installedViewKindContracts } from '../viewKinds'

/* ==================================================================
 * A view kind is two halves in two places, and only one of them came off disk.
 *
 * The manifest declares `kind` / `driverIds` / `title` and is parsed by the
 * loader; the four functions behind the kind are still compiled in
 * (`viewKinds.ts`'s header says which two processes are why). `installedViewKindContracts`
 * is the join, and this file is what stops it from becoming a no-op — which is
 * the shape the failure would take, because a filter that lets everything
 * through looks exactly like a filter that works.
 * ================================================================== */

const NOTHING: InstalledPackages = { drivers: [], viewKinds: [], tools: [] }

describe('the contracts the window is allowed to register', () => {
  test('a kind whose package is installed is offered', () => {
    clearInstalledPackages()
    installPackages(IN_REPO_PACKAGES)

    assert.deepEqual(
      installedViewKindContracts().map((contract) => contract.kind),
      VIEW_KIND_CONTRACTS.map((contract) => contract.kind),
      'every compiled-in contract belongs to a package this build also ships, so all of them pass',
    )
  })

  test('a kind whose package is not installed is not offered', () => {
    // What uninstalling neo4j leaves behind: the code that draws a graph is
    // still in the window's chunk, and there is no longer a database it can
    // reach. An offer here becomes a menu item that opens a broken view.
    clearInstalledPackages()
    installPackages(NOTHING)

    assert.deepEqual(installedViewKindContracts(), [])
    assert.ok(VIEW_KIND_CONTRACTS.length > 0, 'the previous assertion is only meaningful if there was something to filter')
  })

  test('the two halves are keyed by the same string', () => {
    clearInstalledPackages()
    installPackages(IN_REPO_PACKAGES)

    // The join is by `kind` and nothing else, so a package renaming its kind in
    // one half and not the other produces an empty offer rather than a mismatch
    // anyone can see. This is what would report it.
    for (const contract of installedViewKindContracts()) {
      const declared = IN_REPO_PACKAGES.viewKinds.find((kind) => kind.kind === contract.kind)
      assert.ok(declared, `${contract.kind} passed the filter, so a manifest must declare it`)
      assert.deepEqual(
        [...contract.driverIds].sort(),
        [...declared.driverIds].sort(),
        `${contract.kind} is offered on different drivers by its manifest and its registration`,
      )
    }
  })
})
