import {
  connectionIdentity,
  parseConnectionConfig as parseAgainstFields,
  type Capability,
  type ConnectFormSpec,
  type ConnectionConfig,
  type ConnectionConfigOutcome,
  type DriverId,
  type DriverManifest,
  type RedactRules,
  type UnknownConfigKeys,
} from '@peek/core'
import { definePackageContribution, type PackageContribution } from './contribution'
import { installedDriver, installedDrivers } from './installed'

/* ==================================================================
 * Every database peek knows about, described without connecting to one.
 *
 * ## Why this file is neither in `main/` nor in `renderer/`
 *
 * Both processes need it. Main needs a display name for the connection book and
 * an endpoint line for the MCP receipts; the renderer needs the connect form and
 * the capability prediction that greys out a query button. Putting it under
 * `main/` would make the renderer import from the main process — which is how an
 * electron dependency ends up in the window — and putting it under `renderer/`
 * would be the same mistake pointing the other way. It has no electron, no
 * React and no database client, so it belongs to neither and is imported by
 * both.
 *
 * ## Where the manifests come from now
 *
 * Off disk, through `drivers/installed.ts`. This file used to import
 * `@peek/db-postgres/manifest` and four siblings and hold the result in a
 * module constant; those subpaths were the mechanism that let a window know what
 * a PostgreSQL connection looks like without carrying a PostgreSQL client, and
 * they are still what `build-packages.mjs` serializes each `peek-package.json`
 * out of. What changed is only *when*: the list is now whatever
 * `loadPackages()` found, so a package the repository has never seen is
 * indistinguishable from one it ships. `manifest-purity.test.ts` still guards
 * the subpaths, because the build script and the package host still read them.
 *
 * ## The display table is gone from here
 *
 * `DRIVER_DISPLAYS` sat below, importing `@peek/db-postgres/display` and four
 * siblings, and neither process that imports this file was allowed to call it:
 * a display runs in the **package host**, which since Phase C `import()`s the
 * `contrib.mjs` those same modules are compiled into. So the five imports were
 * live only for as long as tree-shaking dropped them — a property of the call
 * graph rather than a boundary, and one whose failure is silent in the window.
 * The table is a test fixture now (`__tests__/in-repo-displays.ts`), which is
 * what it had become, and this module's imports are down to what it uses.
 *
 * ## Why core does not own this list
 *
 * A driver package depends on core. Core importing one back would close the
 * dependency graph into a cycle, so the *shape* (`DriverManifest`) lives in core
 * and the *list* lives here, in the app that assembles them.
 * ================================================================== */

/**
 * Every installed driver's manifest, in the order the loader reported them.
 *
 * A function rather than the `DRIVER_MANIFESTS` constant it replaces, and that
 * is the whole of what Phase C does to this file: a module constant is fixed at
 * import, and what is installed is not known until a directory has been read.
 * Every call site that used to read the array reads this instead — the shape it
 * returns is unchanged, which is why none of them had to learn anything else.
 *
 * Order matters in one visible place: `driverCapabilities()` is serialized into
 * the `list_connections` receipt, so this is the order an MCP client sees. It is
 * now the loader's, which sorts package directories by name (`loader.ts`) —
 * stable across machines, and no longer this file's to choose.
 */
export function driverManifests(): readonly DriverManifest[] {
  return installedDrivers().map((driver) => driver.manifest)
}

/**
 * Drivers, as one of the kinds of thing a package contributes.
 *
 * The gate is an identity: `compiled()` is `driverManifests()`, which is already
 * the registry read through a `.map`, so filtering it by the ids the registry
 * declares can remove nothing. That is not a placeholder — it is this kind's
 * actual state. Decision 1 took the compiled-in half away entirely: there is no
 * `DRIVER_MANIFESTS` left for an uninstall to leave behind, which is why this
 * file needed no filter when its two siblings did.
 *
 * It is in the roster anyway, and that is the point of having a roster. A kind
 * left out because it "obviously has nothing to filter" is precisely the kind
 * the guard cannot ask about, and "obviously" is a claim about today's imports —
 * the next compiled-in driver half would re-open the hole in the one file nobody
 * is watching. Here, the claim is written down and `package-contributions.test.ts`
 * checks it holds.
 */
export const driverContribution: PackageContribution<DriverManifest> = definePackageContribution({
  declaredIn: 'drivers',
  what: 'driver',
  declaredKeys: () => installedDrivers().map((driver) => driver.manifest.driverId),
  compiled: () => driverManifests(),
  keyOf: (manifest) => manifest.driverId,
})

/**
 * The manifest for a driver id, or null.
 *
 * A miss is an ordinary value rather than a throw for the same reason
 * `lookupDriver` returns null: the id can arrive from a connection persisted by
 * a future version of peek, and the caller is the one holding the context to
 * turn that into a structured error.
 */
export function lookupManifest(driverId: DriverId): DriverManifest | null {
  return installedDriver(driverId)?.manifest ?? null
}

/**
 * The manifest for a config's own driver — the case where a miss is impossible.
 *
 * Every config that reached main came through `parseConnectionConfig` below,
 * which refuses a driver this build has no manifest for — so by the time one is
 * in hand the lookup cannot miss. The throw is for a config that skipped that
 * gate (cast, or read off disk unvalidated), and it says so in English because
 * only a developer can act on it.
 *
 * It used to be the type system making that promise: `ConnectionConfig` was a
 * union over the same six ids this list is checked against. That check now
 * happens at a value's first contact with main rather than at compile time,
 * which is the trade opening `DriverId` makes everywhere it is made.
 */
export function manifestFor(config: ConnectionConfig): DriverManifest {
  const manifest = installedDriver(config.driverId)?.manifest
  if (manifest === undefined) {
    throw new Error(`No driver manifest for driverId=${config.driverId}`)
  }
  return manifest
}

/** The driver ids that have a manifest, in declaration order. */
export function manifestDriverIds(): DriverId[] {
  return driverManifests().map((m) => m.driverId)
}

/**
 * Capabilities per driver **before** a connection exists — the prediction the UI
 * and the MCP tools adapt to. Once connected, `ConnectionState.capabilities`
 * wins; see `renderer/state/capabilities.ts`, which is where that switch-over
 * happens exactly once.
 *
 * Rebuilt on each call rather than cached: it is consulted per render and per
 * receipt, both of which already allocate more than this, and a frozen module
 * constant would be one more thing that can go stale against the list above.
 */
export function driverCapabilities(): Record<DriverId, readonly Capability[]> {
  const out = {} as Record<DriverId, readonly Capability[]>
  for (const m of driverManifests()) out[m.driverId] = m.capabilities
  return out
}

/**
 * Which fields of a driver's config are secret, and how each one is scrubbed.
 *
 * `redactConnectionConfig` needs this table and core cannot hold it, so every
 * outbound copy of a config in main goes `redactConnectionConfig(cfg,
 * redactRulesFor(cfg.driverId))`. Spelled out at each call site rather than
 * wrapped in a `redactConfig(cfg)` helper on purpose: redaction stays the one
 * chokepoint it has always been, and a reader of `store/sanitize.ts` can see
 * *that* it is rules-driven without following another hop.
 *
 * An unknown driver answers `{}`, which means the config travels verbatim. That
 * is plugin-architecture's decision 5 rather than an oversight here — peek does
 * not validate packages, so a defensive default would be theatre over code that
 * can read the config anyway — and the loader is what warns about it. The case
 * stays unreachable because `parseConnectionConfig` refuses a config whose
 * driver has no manifest; it is no longer unreachable because the *type* said so.
 */
export function redactRulesFor(driverId: DriverId): RedactRules {
  return installedDriver(driverId)?.manifest.redact ?? {}
}

/* ------------------------------------------------------------------ */
/* Parsing a config against the driver that owns it                    */
/* ------------------------------------------------------------------ */

/**
 * The form a driver declares, which is also the schema its config is parsed by.
 *
 * Null for a driver with no manifest, and the null is what the parse below
 * turns into a refusal: core's `ConnectionConfigSchema` cannot tell a driver
 * peek has never heard of from one it ships, so this is where that question is
 * answered.
 */
export function connectFormOf(driverId: DriverId): ConnectFormSpec | null {
  return installedDriver(driverId)?.manifest.connectForm ?? null
}

/**
 * Parse an untrusted value into a config **whose driver this build has**.
 *
 * The registry-bound half of `parseConnectionConfig` in core, and the reason
 * both halves exist: core validates everything that does not need a manifest —
 * a record, a servable `driverId` — and stops, because a driver package depends
 * on core and core cannot look one up. This adds the two things only the app
 * knows: whether that driver is loaded at all, and what fields it declared.
 *
 * **It is what the discriminated union used to be.** Every caller below was
 * once `ConnectionConfigSchema.safeParse`, and got three things from it: the
 * value is a config, its driver is one of the six, and its fields are the right
 * types. The open schema keeps the first; this restores the other two, at the
 * same call sites, so nothing downstream had to learn a new failure mode.
 *
 * Callers that report to a person want the issues; the ones here want a value or
 * a null, and the null is always read the same way — a config peek cannot use is
 * dropped, redacted wholesale, or refused, never passed along half-understood.
 */
export function parseConnectionConfig(value: unknown, unknownKeys: UnknownConfigKeys): ConnectionConfig | null {
  const outcome = parseConnectionConfigOf(value, unknownKeys)
  return outcome.ok ? outcome.config : null
}

/** As above, but keeping the issues — for the callers that report them. */
export function parseConnectionConfigOf(
  value: unknown,
  unknownKeys: UnknownConfigKeys,
): ConnectionConfigOutcome {
  const driverId = driverIdOf(value)
  if (driverId === null) return { ok: false, issues: ['driverId: expected a string'] }
  const form = connectFormOf(driverId)
  if (form === null) {
    return { ok: false, issues: [`driverId: no database package provides '${driverId}'`] }
  }
  return parseAgainstFields(value, form, unknownKeys)
}

/**
 * The `driverId` of an unparsed value, when it has one.
 *
 * Read before parsing rather than after, because the manifest it selects is what
 * the parse needs. Nothing else is trusted from `value` — the id itself is still
 * measured by `ConnectionConfigSchema` inside the parse.
 */
function driverIdOf(value: unknown): DriverId | null {
  if (typeof value !== 'object' || value === null || !('driverId' in value)) return null
  const raw: unknown = value.driverId
  return typeof raw === 'string' ? raw : null
}

/**
 * The identity of a connection: which server and account it names.
 *
 * The *fields* come from the manifest and the *joining* stays in core, which is
 * the split `connectionIdentity` explains at length: declaring which fields
 * matter is harmless, deciding whether two connections are the same one is what
 * releases a stored credential, so a package may not do it.
 *
 * `manifestFor` rather than a fallback: a config whose driver has no manifest
 * cannot be keyed at all, and the two guesses available — an empty field list,
 * or all fields — differ by whether every such connection collapses into one
 * identity. That is a keychain read for the wrong server, so it throws instead.
 */
export function connectionIdentityOf(config: ConnectionConfig): string {
  return connectionIdentity(config, manifestFor(config).identity)
}
