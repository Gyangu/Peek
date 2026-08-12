import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/* ==================================================================
 * The two questions answered before peek forks a child: **where does its code
 * come from**, and **what does it get to see**.
 *
 * Split from `host-process.ts` and `manager.ts` — which do the forking — for the
 * same reason `packages/assets.ts` is split from `packages/protocol.ts`: those
 * modules import `electron` and therefore cannot be loaded by `node --test`,
 * while both answers here are pure functions of a record. A check that only runs
 * inside a packaged app is a check nobody runs, and these two are checks
 * (`__tests__/hardening.test.ts`, design 2026-08-07 §4.8).
 *
 * Both kinds of child fork under these rules — the driver host (one per
 * connection) and, from design §2.4bis, the package host (one per package).
 * Stating either rule twice would be two chances for one copy to quietly grow an
 * entry.
 * ================================================================== */

/**
 * The variables a driver host inherits — an allowlist, not a filter.
 *
 * ## Why an allowlist
 *
 * This process runs a database package's code, and after
 * `docs/design/2026-08-07-database-packages-from-disk.md` that package may have
 * come from outside this repository with nothing checked about it (decision 6:
 * no signature, no hash, no manifest of permissions). It is handed a plaintext
 * password because connecting is its job. It is *not* handed `AWS_*`,
 * `GITHUB_TOKEN`, `npm_config_*`, a proxy URL with credentials in it, or the
 * hundred other things a developer's shell exports — none of which have
 * anything to do with opening a database connection.
 *
 * The previous version of this function passed `process.env` through whole and
 * only dropped `undefined` values, which is what `ForkOptions.env` requires. It
 * was named `sanitizeEnv` and sanitized nothing.
 *
 * ## Why each of these is on the list
 *
 * The rule for adding one: a database client breaks without it, and it says
 * nothing about the user beyond what the OS tells every process anyway.
 *
 * - `PATH` — not for spawning (no driver does), but several libraries probe it
 *   during initialisation and behave oddly when it is absent entirely.
 * - `HOME` / `USERPROFILE` — `os.homedir()` and, through it, `pg`'s `~/.pgpass`
 *   support. Dropping it would not stop a hostile package from finding the home
 *   directory (`getpwuid` still answers), so the cost is real and the benefit is
 *   zero — the wrong trade in both directions.
 * - `TMPDIR` / `TEMP` / `TMP` — where a client writes spill files.
 * - `LANG` / `LC_ALL` / `LC_CTYPE` — text decoding.
 * - `TZ` — how a client renders timestamps. A driver host with a different `TZ`
 *   from the window would show two different times for one row.
 * - The Windows block — `SystemRoot` and friends are required by node's own
 *   startup on that platform, not optional.
 *
 * ## What is deliberately absent
 *
 * - **`PEEK_DRIVER_HOST_DIR`.** It selects this process's own entry point
 *   (`manager.ts`), so inheriting it would let a driver host choose where the
 *   *next* one loads from. See `resolveHostDir` for the check on the value
 *   itself; this is the other half.
 * - **`ELECTRON_RUN_AS_NODE`** and every other `ELECTRON_*` — changing how the
 *   binary starts is not a driver's business.
 * - **`PG*` / `MYSQL*` / `REDIS*`** and every other client-specific variable.
 *   These are a *feature* being removed: a client that falls back to
 *   `PGPASSWORD` when the config omits a password is a connection whose
 *   credential peek never saw and cannot show, redact, or store. peek's
 *   connection book is the only supported way to say where a connection goes.
 *   **This is a behaviour change**, recorded in the design doc §2.10 rather than
 *   discovered by whoever relied on it.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows: node's own startup requires these; they are not client-specific.
  'SystemRoot',
  'SystemDrive',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'WINDIR',
]

/** Filter an environment down to {@link ENV_ALLOWLIST}. */
export function allowedEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ENV_ALLOWLIST) {
    const value = src[name]
    // `ForkOptions.env` rejects undefined values, and an empty string is a
    // meaningful value for some of these — so the test is on the type, not on
    // truthiness.
    if (typeof value === 'string') out[name] = value
  }
  return out
}

export interface HostDirDecision {
  /** The directory the driver host will actually be loaded from. */
  dir: string
  /** English, for the log. Non-null whenever a human should know about this. */
  note: string | null
}

/**
 * Decide where `driver-host.js` is loaded from, given the environment.
 *
 * ## What `PEEK_DRIVER_HOST_DIR` is, and why it needed a check
 *
 * It is an undocumented escape hatch that integration runs use to point at a
 * staged build. It is also — as `docs/design/2026-08-03-plugin-architecture.md`
 * §1.2d put it — "a switch that loads the highest-value process entry point from
 * an arbitrary path, with no validation at all": the driver host is the process
 * that receives *unredacted* connection configs, so whatever it loads reads
 * every password the user connects with.
 *
 * Three rules, and the third is the one that matters:
 *
 * 1. **A packaged app ignores it entirely.** Nothing in a shipped peek needs to
 *    relocate its own bundle. `allowOverride` is `!app.isPackaged`, passed in by
 *    `main/index.ts` rather than read here — this module is imported by
 *    `node --test`, and importing `electron` for one boolean would put it back
 *    out of reach (see the constructor's comment about parameter properties for
 *    the last time that happened).
 * 2. **An absolute, existing directory, or it is refused.** A relative path is
 *    resolved against the working directory, which for a GUI app is wherever the
 *    launcher happened to be — that is a stale-shell accident, not a choice.
 * 3. **It is never silent.** Accepted, refused or ignored, a human is told. The
 *    threat this variable poses is not that it exists (a developer who can set
 *    it can already replace the file it points at); it is that it can change
 *    where credentials-handling code comes from *without anyone noticing*.
 *    A check that refused quietly would keep exactly the half worth having.
 *
 * `host-process.ts` holds the other half: the variable is not on the driver
 * host's env allowlist, so a driver host cannot set it for the next one.
 */
export function resolveHostDir(
  defaultDir: string,
  env: NodeJS.ProcessEnv,
  allowOverride: boolean,
): HostDirDecision {
  const raw = env['PEEK_DRIVER_HOST_DIR']
  if (raw === undefined || raw === '') return { dir: defaultDir, note: null }

  if (!allowOverride) {
    return {
      dir: defaultDir,
      note:
        `PEEK_DRIVER_HOST_DIR is set (${raw}) but this is a packaged build; ignoring it `
        + 'and loading the driver host from the app bundle.',
    }
  }
  if (!isAbsolute(raw)) {
    return {
      dir: defaultDir,
      note: `PEEK_DRIVER_HOST_DIR must be an absolute path; refusing ${raw} and using ${defaultDir}.`,
    }
  }
  if (!existsSync(raw)) {
    return {
      dir: defaultDir,
      note: `PEEK_DRIVER_HOST_DIR points at ${raw}, which does not exist; using ${defaultDir}.`,
    }
  }
  return {
    dir: raw,
    note: `PEEK_DRIVER_HOST_DIR is set: loading the driver host from ${raw}, not from the app bundle.`,
  }
}

