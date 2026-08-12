import { installPackages } from '../installed'
import { IN_REPO_PACKAGES } from './in-repo-packages'

/* ==================================================================
 * Install the five in-repo packages — the value is next door, in
 * `./in-repo-packages`, and that file's header says what it stands in for.
 *
 * ## Installed on import, on purpose
 *
 * Several tests read the registry while their own module is still evaluating (a
 * `const WITH_SKILL = driverManifests().filter(…)` at file scope). A function
 * they had to remember to call in a `before` hook would be empty for those, and
 * empty reads as "this driver contributes nothing" rather than as a failure. So
 * importing this module *is* the installation, and the import goes first in the
 * files that need it.
 *
 * Which is exactly why the value lives elsewhere: one test has to install *late*
 * to be worth anything, and it cannot do that through a module whose import is
 * the install.
 * ================================================================== */

installPackages(IN_REPO_PACKAGES)
