import {
  hostPort,
  redactUrlCredentials,
  urlParts,
  type DriverDisplay,
  type QdrantConnectionConfig,
} from '@peek/core'

/**
 * How a Qdrant connection is *called*: the sidebar row, its tooltip, and the one
 * line an MCP reader sees.
 *
 * These three used to be a `switch` over `driverId` in core (`defaultConnectionLabel`
 * / `connectionDetail`) plus a method on this manifest (`endpointSummary`), which
 * meant core had to know how six particular databases spell an address. They are
 * the package's now, run in the package host, and are computed once when the
 * connection opens — a config never changes after that. See `DriverDisplay` in
 * `@peek/core` for why these are code while `redact` and `identity` stayed data.
 *
 * **Same import rule as `manifest.ts`: `@peek/core` and `zod`, nothing else.**
 * The three strings are produced on the host side, but the reason for the rule is
 * unchanged — this file sits next to `./driver`, and one relative import away is
 * `@qdrant/js-client-rest`.
 */
export const qdrantDisplay: DriverDisplay<QdrantConnectionConfig> = {
  /**
   * `host:port` out of the URL, because that is the only part that tells two
   * Qdrant connections apart in a 240px row that truncates at the end — the
   * scheme and the path are the same on every one of them.
   *
   * The `driverId` arm is unreachable for a config that came through
   * `QdrantConnectionConfigSchema`, which types `url` as a non-empty string, and
   * is kept anyway because it is what the other five packages answer with when a
   * config makes no sense. Without it this one degrades differently from all of
   * them: `redactUrlCredentials` is a `.replace`, so a config that was cast, or
   * read out of a hand-edited `connections.json`, leaves here as a `TypeError`
   * where every sibling leaves as a plain-looking name. See `DriverDisplay`.
   */
  label(config) {
    const parts = urlParts(config.url)
    return (
      hostPort(parts?.host, parts?.port) ?? (config.url ? redactUrlCredentials(config.url) : config.driverId)
    )
  },

  /**
   * The whole URL — the scheme and path `label` had to drop, scrubbed all the
   * same, and falling back the same way for the same reason.
   */
  detail(config) {
    return config.url ? redactUrlCredentials(config.url) : config.driverId
  },

  /**
   * The URL verbatim: for Qdrant the connection string *is* the address. Same
   * fallback again — this one never threw, it handed a `string` field the value
   * `undefined`, which reaches an MCP receipt as the word "undefined".
   */
  endpoint(config) {
    return config.url || config.driverId
  },
}
