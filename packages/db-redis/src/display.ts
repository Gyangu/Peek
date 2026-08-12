import {
  hostPort,
  redactUrlCredentials,
  urlParts,
  type DriverDisplay,
  type RedisConnectionConfig,
} from '@peek/core'

/**
 * What a Redis connection is *called* — the three strings, and the only part of
 * this package's description that is code rather than data.
 *
 * The split is `DriverDisplay`'s header; the short version is that a manifest is
 * on its way to being JSON on disk and JSON cannot hold a `??` chain, while these
 * three are nothing but `??` chains. They run in the package host when a
 * connection opens, once, and the strings travel with the connection from there.
 *
 * ## Same import rule as `manifest.ts`, for a different reason
 *
 * `@peek/core` and `zod`, nothing else. `manifest.ts` obeys that so the renderer
 * chunk stays free of the `redis` client; this file obeys it because the process
 * that loads it is the wrong one to hold a client. `redis` belongs to the
 * per-connection driver host and arrives through `driver.mjs`; a `contrib.mjs`
 * that reached `./driver` would open a socket from the package host, which exists
 * to answer questions about connections rather than to have any (§2.4).
 * `subpath-purity.test.ts` is what enforces this half of the rule —
 * `manifest-purity.test.ts` still scans `src/manifest.ts` and nothing else.
 *
 * All three are moved verbatim — `endpoint` from this package's own
 * `endpointSummary`, `label` and `detail` from the `defaultConnectionLabel` /
 * `connectionDetail` switches in core's `capability.ts` — and deliberately not
 * tidied on the way. The migration is checked by comparing output against the old
 * switch, and an improvement made in passing is the one thing that check cannot
 * tell apart from a mistake.
 */
export const redisDisplay: DriverDisplay<RedisConnectionConfig> = {
  /**
   * The sidebar row is 240px and truncates at the end, so what goes in is the
   * part that **tells two connections apart**. That is why a URL is parsed for
   * its host and port instead of being returned: `redis://user:***@localho…`
   * spends the whole row on the part every redis connection has in common.
   */
  label(config) {
    const parts = urlParts(config.url)
    const at = hostPort(config.host ?? parts?.host ?? 'localhost', config.port ?? parts?.port ?? 6379)
    // The logical database index is part of what names a redis connection, but
    // only when it is not the default one everybody is already on.
    const db = config.db ?? (parts?.database === undefined ? undefined : Number(parts.database))
    return db === undefined || db === 0 || Number.isNaN(db) ? (at ?? config.driverId) : `${at}/${db}`
  },

  /**
   * The full address `label` had to drop, for the row's tooltip — which is why
   * the db index is spelled out even when it is 0, and why the URL is returned
   * whole when there is one.
   *
   * It scrubs that URL itself rather than trusting the caller to have redacted
   * first: this is the one of the three that puts a connection string on screen
   * verbatim, and `redactUrlCredentials` is idempotent, so keeping the call costs
   * nothing when the config arrived scrubbed already and is the difference
   * between a tooltip and a leaked password when it did not.
   */
  detail(config) {
    if (config.url !== undefined) return redactUrlCredentials(config.url)
    const at = hostPort(config.host ?? 'localhost', config.port ?? 6379) ?? ''
    return `redis://${at}/${config.db ?? 0}`
  },

  /**
   * One line of address for an MCP reader: the URL the user actually typed when
   * there is one, and otherwise the address assembled from the fields as
   * `host:port/db` — not as a synthesised `redis://` URL, because a connection
   * opened by fields never had one and quoting a string nobody entered back at a
   * model invites it to be repeated as if it were the connection's own spelling.
   *
   * The config arrives redacted (`DriverDisplay.endpoint`), which is what makes
   * returning `url` verbatim safe here when `detail` has to scrub.
   */
  endpoint(config) {
    return config.url ?? `${config.host ?? 'localhost'}:${config.port ?? 6379}/${config.db ?? 0}`
  },
}
