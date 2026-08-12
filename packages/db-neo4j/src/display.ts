import {
  hostPort,
  redactUrlCredentials,
  urlParts,
  type DriverDisplay,
  type Neo4jConnectionConfig,
} from '@peek/core'

/**
 * How a Neo4j connection is *called* — the three strings, and nothing else.
 *
 * They arrive here from two different files, and neither was where they
 * belonged. `endpoint` was `neo4jManifest.endpointSummary`, which forced a
 * function onto a shape that has to survive being read off disk as JSON;
 * `label` and `detail` were the `case 'neo4j':` arms of two `switch`es in core's
 * `capability.ts`, which forced the kernel to know that Bolt listens on 7687 and
 * that a Neo4j connection is told apart by its database. Both are the package's
 * facts about its own database.
 *
 * **Carried over verbatim.** The three bodies below are the old ones, moved: a
 * difference in output is a bug in the move, not an improvement, and that is the
 * whole acceptance criterion for this file. It is also why the code is code —
 * see `DriverDisplay`, where the interpolation-template plan died on `detail`
 * (`hostPort` drops the port *along with* a missing host, which needs grouping)
 * and on the realisation that the window needs the strings, not the code that
 * makes them.
 *
 * Reached as `@peek/db-neo4j/display`, under the same import rule as
 * `manifest.ts`: `@peek/core` and `zod`, never anything that reaches
 * `neo4j-driver`. The rule holds here for a *different* reason than it does
 * there — this module runs in the package host, not the window — so the honest
 * statement is that it is cheap insurance against the day the two files' fates
 * are confused, not a load-bearing chunk-size guarantee.
 */
export const neo4jDisplay: DriverDisplay<Neo4jConnectionConfig> = {
  label(config) {
    // The database name comes first for the same reason it does on postgres:
    // two connections to one server differ by database, and a 240px row that
    // truncates at the end would cut off exactly that.
    const parts = urlParts(config.url)
    return (
      config.database ?? hostPort(config.host ?? parts?.host, config.port ?? parts?.port) ?? config.driverId
    )
  },

  detail(config) {
    // Redacted again rather than trusted: this branch always scrubbed the URL
    // itself, and `redactUrlCredentials` over an already-redacted string is a
    // no-op, so keeping the call costs nothing and keeps the guarantee local.
    if (config.url !== undefined) return redactUrlCredentials(config.url)
    // `?? ''` is not dead: a host that is the empty string skips `?? 'localhost'`
    // — which only answers null and undefined — and `hostPort` refuses it.
    const at = hostPort(config.host ?? 'localhost', config.port ?? 7687) ?? ''
    const user = config.user === undefined ? '' : `${config.user}@`
    const db = config.database === undefined ? '' : `/${config.database}`
    // `bolt://` and not `neo4j://`: with no URL there is no routing to speak of,
    // so this spells the single server the host and port actually name.
    return `bolt://${user}${at}${db}`
  },

  endpoint(config) {
    const at = config.url ?? `bolt://${config.host ?? 'localhost'}:${String(config.port ?? 7687)}`
    return config.database === undefined ? at : `${at}/${config.database}`
  },
}
