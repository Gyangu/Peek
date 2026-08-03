import type { Capability, ConnectionConfig, DriverId, DriverManifest } from '@peek/core'
import { neo4jManifest } from '@peek/driver-neo4j/manifest'
import { postgresManifest } from '@peek/driver-postgres/manifest'
import { qdrantManifest } from '@peek/driver-qdrant/manifest'
import { redisManifest } from '@peek/driver-redis/manifest'
import { sqlManifests } from '@peek/driver-sql/manifest'

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
 * ## Why the manifests, and not the driver packages
 *
 * `@peek/driver-postgres` reaches `pg`; `@peek/driver-postgres/manifest` reaches
 * `@peek/core` and stops. That subpath is the entire mechanism that lets a
 * window know what a PostgreSQL connection looks like without carrying a
 * PostgreSQL client. `manifest-purity.test.ts` is what keeps it true.
 *
 * ## Why core does not own this list
 *
 * A driver package depends on core. Core importing one back would close the
 * dependency graph into a cycle, so the *shape* (`DriverManifest`) lives in core
 * and the *list* lives here, in the app that assembles them.
 * ================================================================== */

/**
 * **Deliberately not annotated.** The inferred type carries each manifest's
 * literal `labelKey`s, and `renderer/components/connectForm.ts` re-declares this
 * array as `DriverManifest<PlainMessageKey>[]` to check them against the message
 * catalog. Writing `: readonly DriverManifest[]` here widens them to `string`
 * and that check quietly passes on nothing. See `defineManifest` in core.
 *
 * Order matters in one visible place: `driverCapabilities()` is serialized into
 * the `list_connections` receipt, so this is the order an MCP client sees.
 */
export const DRIVER_MANIFESTS = [
  postgresManifest,
  ...sqlManifests,
  redisManifest,
  qdrantManifest,
  neo4jManifest,
]

const BY_ID: ReadonlyMap<DriverId, DriverManifest> = new Map(
  DRIVER_MANIFESTS.map((m) => [m.driverId, m as DriverManifest]),
)

/**
 * The manifest for a driver id, or null.
 *
 * A miss is an ordinary value rather than a throw for the same reason
 * `lookupDriver` returns null: the id can arrive from a connection persisted by
 * a future version of peek, and the caller is the one holding the context to
 * turn that into a structured error.
 */
export function lookupManifest(driverId: DriverId): DriverManifest | null {
  return BY_ID.get(driverId) ?? null
}

/**
 * The manifest for a config's own driver — the case where a miss is impossible.
 *
 * `ConnectionConfig` is a discriminated union built from the same `DRIVER_IDS`
 * this list is checked against (`driver-registry.test.ts`), so every config that
 * type-checks has a manifest here. The throw is for a config that was cast or
 * came off disk unvalidated, and it says so in English because only a developer
 * can act on it.
 */
export function manifestFor(config: ConnectionConfig): DriverManifest {
  const manifest = BY_ID.get(config.driverId)
  if (manifest === undefined) {
    throw new Error(`No driver manifest for driverId=${config.driverId}`)
  }
  return manifest
}

/** The driver ids that have a manifest, in declaration order. */
export function manifestDriverIds(): DriverId[] {
  return DRIVER_MANIFESTS.map((m) => m.driverId)
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
  for (const m of DRIVER_MANIFESTS) out[m.driverId] = m.capabilities
  return out
}

/**
 * One line of address for a connection, for an MCP reader.
 *
 * The manifest is looked up **by the config's own `driverId`**, which is what
 * makes it safe for each package to declare `endpointSummary` over its own
 * config branch rather than over the union: a manifest is never handed a config
 * from another driver. This function is the single place that invariant holds,
 * so it is the single place the narrowing happens.
 *
 * The config must already have been through `redactConnectionConfig` — this
 * only assembles the pieces.
 */
export function endpointSummary(config: ConnectionConfig): string {
  return manifestFor(config).endpointSummary(config)
}
