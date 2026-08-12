import { installPackageLocations } from '../locations'
import { IN_REPO_PACKAGES } from '../../../drivers/__tests__/in-repo-packages'

/* ==================================================================
 * Where the five in-repo packages would be on disk — the main-only half of
 * `drivers/__tests__/in-repo-registry.ts`.
 *
 * Two files rather than one for the same reason that pair is two files: the
 * manifests travel to the window and the paths do not, so the two registries
 * they fill are two modules, and a test that only forks a driver host should not
 * have to install the other.
 *
 * The paths are fabricated and never opened. Every test that imports this stubs
 * `utilityProcess`, so what the value has to be is *present* — `manager.connect`
 * refuses to fork a driver whose package it cannot locate, which is the check
 * these paths exist to satisfy. Pointing them at the real `out/packages/` would
 * make a unit test depend on a build having been run.
 *
 * Installed on import, like its counterpart: the fork happens inside the
 * `connect` a test awaits, and there is no hook between construction and that
 * call to fill a slot from.
 * ================================================================== */

installPackageLocations(
  [...new Set(IN_REPO_PACKAGES.drivers.map((driver) => driver.packageId))].map((id) => ({
    id,
    entry: { driver: `/peek-packages/${id}/driver.mjs`, contrib: `/peek-packages/${id}/contrib.mjs` },
  })),
)
