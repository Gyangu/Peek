import {
  baseName,
  hostPort,
  redactUrlCredentials,
  urlParts,
  type DriverDisplay,
  type DriverId,
  type MysqlConnectionConfig,
  type SqliteConnectionConfig,
} from '@peek/core'

/**
 * What a MySQL or SQLite connection is *called* — the other half of
 * `manifest.ts`, and the half that stayed code.
 *
 * These three strings used to be spread across two files and three switches:
 * `endpointSummary` on the manifest, `defaultConnectionLabel` and
 * `connectionDetail` in `core/capability.ts`. The core pair is what made the
 * arrangement wrong — it meant the kernel had to know how six particular vendors
 * spell an address, and a database peek did not compile in could not be named at
 * all. The code is unchanged; only its address is. `DriverDisplay`'s header has
 * why these did not become data along with the rest of the manifest, and
 * `docs/design/2026-08-07-database-packages-from-disk.md` §2.3(b) has the
 * interpolation-template scheme that died proving it.
 *
 * **`label` does not check `config.label` first.** The old function opened with
 * `if (cfg.label) return cfg.label`, which is not this driver's business: a name
 * the user typed outranks a name any package computes, for every package, so the
 * kernel applies it and only asks here for the fallback.
 *
 * Allowed imports are the manifest's — `@peek/core` and `zod`, nothing else.
 * This file runs in the package host, where `mysql2` would be harmless, but
 * these strings are wanted in the same places the manifest is and buying that
 * back later costs a rewrite. `hostPort` / `urlParts` / `baseName` stay core's
 * for the same reason they were exported: six packages re-deriving "host, plus a
 * port when there is one" would derive it six slightly different ways.
 */

/* ------------------------------------------------------------------ */
/* MySQL                                                               */
/* ------------------------------------------------------------------ */

export const mysqlDisplay: DriverDisplay<MysqlConnectionConfig> = {
  label(config) {
    // The database name leads, and the address is only the fallback: the row is
    // 240px and truncates at the end, so two databases on one server would read
    // identically right up to the part that tells them apart.
    const parts = urlParts(config.url)
    return (
      config.database ??
      parts?.database ??
      hostPort(config.host ?? parts?.host, config.port ?? parts?.port) ??
      config.driverId
    )
  },

  detail(config) {
    // Scrubbed here rather than trusted to arrive scrubbed: this is the one of
    // the three that returns a URL, it is broadcast to the renderer and to MCP,
    // and a caller who forgot would leak a plaintext password with no symptom.
    if (config.url !== undefined) return redactUrlCredentials(config.url)
    // Assembled in the URL's shape even though no URL was typed, so the tooltip
    // reads as one address rather than as the form that produced it.
    const at = hostPort(config.host, config.port) ?? ''
    const user = config.user === undefined ? '' : `${config.user}@`
    const db = config.database === undefined ? '' : `/${config.database}`
    return `${config.driverId}://${user}${at}${db}`
  },

  endpoint(config) {
    if (config.url) return config.url
    // The driver's own defaults, spelled out: an MCP reader is being told where
    // peek connected, and `:/` with the numbers missing answers nothing.
    return `${config.host ?? 'localhost'}:${config.port ?? 3306}/${config.database ?? ''}`
  },
}

/* ------------------------------------------------------------------ */
/* SQLite                                                              */
/* ------------------------------------------------------------------ */

/**
 * All three fall back to the driver id when there is no `file`, which the schema
 * says cannot happen and a config that skipped the schema can still do. Without
 * it `label` is the one display in the six that answers a bad config with
 * `TypeError: Cannot read properties of undefined` — `baseName` is a `.replace` —
 * and the other two hand a `string` field the value `undefined`, which reaches an
 * MCP receipt as the word "undefined". See `DriverDisplay`.
 */
export const sqliteDisplay: DriverDisplay<SqliteConnectionConfig> = {
  // The file name alone. A path is long and its discriminating end is the file,
  // which is precisely what a row that truncates at the end would cut off.
  label: (config) => (config.file ? baseName(config.file) : config.driverId),
  // The path the label had to drop — the tooltip's whole job.
  detail: (config) => config.file || config.driverId,
  endpoint: (config) => config.file || config.driverId,
}

/**
 * Both displays of this package, keyed the way a dispatcher looks one up.
 *
 * A record where `sqlManifests` is an array, because the two are read
 * differently: manifests are consumed in order (the driver picker draws them),
 * while a display is only ever fetched by the `driverId` of the config in hand.
 * The reason for having a collection at all is `sqlManifests`' — which databases
 * this package ships is this package's business, so the app spreads this rather
 * than naming the two.
 *
 * `Pick` over `Record<DriverId, …>` rather than `Partial<…>`: a partial type
 * makes every key it contributes optional in the table the app spreads it into,
 * so a display that was never wired up would read as merely absent. Naming the
 * two ids keeps this package's claim about itself explicit.
 *
 * It used to also be tied to core's closed `DriverId` union, so dropping an id
 * there failed here. `DriverId` is a string with a shape now (design
 * 2026-08-07 §2.6) and that tie is gone along with the app-side table's
 * totality; `driver-registry.test.ts` reads the collected keys back instead.
 */
export const sqlDisplays: Readonly<Pick<Record<DriverId, DriverDisplay>, 'mysql' | 'sqlite'>> = {
  mysql: mysqlDisplay,
  sqlite: sqliteDisplay,
}
