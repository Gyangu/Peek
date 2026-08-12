import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { InstalledPackages } from '@peek/core'
import { PackageManifestSchema } from '@peek/core/package-manifest'
import { NOT_A_CONTRIBUTION, PACKAGE_CONTRIBUTIONS } from '../contributions'
import { clearInstalledPackages, installPackages, installedPackages } from '../installed'
import { IN_REPO_PACKAGES } from './in-repo-packages'

/* ==================================================================
 * Everything a package contributes has to disappear when the package does.
 *
 * ## The shape this is written against, rather than the bug it came from
 *
 * A contribution is declared on disk and implemented in this build, and the two
 * halves fail asymmetrically: **installing is checked by everything, and
 * uninstalling by nothing.** A missing install is visible the moment someone
 * looks — the database is not in the dialog, the tool is not in `tools/list`. A
 * missing *uninstall* looks exactly like a working app until the offer is taken,
 * because the compiled-in half is still there and still answers.
 *
 * That is the direction acceptance 13 was false in twice. `expand_node` stayed
 * in `tools/list` after neo4j was gone — same session, fresh session, and across
 * a restart with the directory deleted — while the sibling table next to it was
 * filtered correctly and looked identical from the outside.
 *
 * So this file does not test the three kinds peek ships today. It walks
 * `PACKAGE_CONTRIBUTIONS` and asks every row the same three questions, and the
 * roster's type (`Record<keyof InstalledPackages, …>`) is what makes a fourth
 * kind arrive here on its own. The value is entirely in the loop being generic:
 * a per-kind test is a test the next kind does not get.
 *
 * `pnpm test` does not run `tsc`, so the type is only half of the mechanism —
 * every assertion below is one a `node --test` run can fail on its own.
 * ================================================================== */

/** No package installed at all — a legal state, and the one an uninstall walks toward. */
const NOTHING: InstalledPackages = { drivers: [], viewKinds: [], tools: [] }

const ROSTER = Object.entries(PACKAGE_CONTRIBUTIONS)

describe('every kind of thing a package contributes', () => {
  test('the roster is not empty, so the loops below assert something', () => {
    assert.ok(ROSTER.length > 0)
  })

  for (const [key, gate] of ROSTER) {
    describe(gate.what, () => {
      test('is filed under the registry list it reads', () => {
        // A row under the wrong key would make the count check below compare a
        // gate against someone else's list, which is the one way these
        // assertions could all pass while describing nothing.
        assert.equal(gate.declaredIn, key)
      })

      test('is offered when the package that declares it is installed', () => {
        clearInstalledPackages()
        installPackages(IN_REPO_PACKAGES)

        assert.deepEqual(
          [...gate.liveKeys()].sort(),
          [...gate.declaredKeys()].sort(),
          `every declared ${gate.what} of an installed package must be offered, or peek is dropping one it has`,
        )
        assert.ok(
          gate.declaredKeys().length > 0,
          `the in-repo packages declare no ${gate.what}, so nothing above was compared`,
        )
      })

      test('is not offered when nothing is installed', () => {
        // The assertion the whole file exists for. A compiled-in half that
        // outlives its package fails here and nowhere else: with no manifest to
        // declare it, anything still named is something an uninstall did not
        // take away.
        clearInstalledPackages()
        installPackages(NOTHING)

        assert.deepEqual(
          [...gate.liveKeys()],
          [],
          `an uninstalled ${gate.what} is still being offered`,
        )
      })

      test('declares exactly what the registry carries', () => {
        clearInstalledPackages()
        installPackages(IN_REPO_PACKAGES)

        // Ties `declaredKeys()` to the registry rather than to any list of its
        // own. Without this a gate could answer from a constant and satisfy both
        // tests above by agreeing with itself.
        assert.equal(
          gate.declaredKeys().length,
          installedPackages()[gate.declaredIn].length,
          `${gate.what} declarations were counted from somewhere other than installedPackages().${gate.declaredIn}`,
        )
      })
    })
  }
})

describe('the roster is complete', () => {
  test('every key of a manifest is a contribution with a gate, or is named as not one', () => {
    // Default deny, and the runtime source is the schema itself rather than a
    // second list of keys to keep in step: a fifth thing a package can declare
    // lands in the remainder and reports here, whether or not anyone thought of
    // this file while adding it.
    const declarable = Object.keys(PackageManifestSchema.shape)
    const unclassified = declarable.filter((key) => !NOT_A_CONTRIBUTION.includes(key))

    assert.deepEqual(
      [...unclassified].sort(),
      Object.keys(PACKAGE_CONTRIBUTIONS).sort(),
      'a manifest key is a contribution with no gate, or a gate for something a manifest cannot declare',
    )
  })

  test('nothing is exempted that a manifest cannot declare', () => {
    // Keeps the exemption list from outliving the keys it exempts — a stale
    // entry there is a name that could later be reused by a real contribution
    // and be waved through on arrival.
    const declarable = new Set(Object.keys(PackageManifestSchema.shape))
    for (const key of NOT_A_CONTRIBUTION) {
      assert.ok(declarable.has(key), `'${key}' is exempted but is not a manifest key`)
    }
  })

  test('every list an install carries has a gate', () => {
    // The same completeness the roster's type states, asserted at runtime
    // because `pnpm test` does not typecheck. `InstalledPackages` is what the
    // gates are indexed into; a fourth list added there and forgotten here would
    // otherwise only report in `pnpm typecheck`.
    //
    // Read from the empty registry rather than from the fixture: `installed.ts`
    // builds that one out of the type, so this asks the app what a registry has
    // rather than asking a test file what it remembered to put in one.
    clearInstalledPackages()

    assert.deepEqual(
      Object.keys(installedPackages()).sort(),
      Object.keys(PACKAGE_CONTRIBUTIONS).sort(),
      'a registry list has no contribution gate, or a gate names a list the registry does not carry',
    )
  })
})
