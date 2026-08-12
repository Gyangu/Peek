import {
  hostPort,
  redactUrlCredentials,
  urlParts,
  type DriverDisplay,
  type PostgresConnectionConfig,
} from '@peek/core'

/**
 * What a PostgreSQL connection is *called* — the sidebar row, its tooltip, and
 * the one line an MCP reader gets.
 *
 * ## Why this is a file and not three more manifest fields
 *
 * It was going to be three templates in the manifest, and translating six
 * databases into a template language is what killed that: `hostPort` drops the
 * port *along with* a missing host, which needs grouping, and no template syntax
 * short of a programming language expresses it. The premise was the mistake —
 * the renderer needs the three **strings**, not the code that makes them, and a
 * connection's config never changes once it is open, so they are computed once
 * in the package host when the connection opens and stored alongside it. The
 * long version is `DriverDisplay`'s header in core; what matters here is the
 * consequence: expressiveness is unlimited, so the behaviour below is the old
 * `endpointSummary` / `defaultConnectionLabel` / `connectionDetail` **verbatim**,
 * and "did the move break anything" is answerable by comparing output.
 *
 * `identity` and `redact` did not come with them and stayed declarative in the
 * manifest, because who-is-who and what-gets-erased are the kernel's to decide.
 *
 * ## Same import rule as `./manifest`
 *
 * Only `@peek/core` and `zod`. This module is reached as
 * `@peek/db-postgres/display`, another subpath that bypasses `index.ts` and
 * therefore `./driver` and therefore `pg`; a relative import to a neighbour here
 * would pull the client back in through the side door. The guard is
 * `subpath-purity.test.ts` rather than `manifest-purity.test.ts` — same rule,
 * and it follows relative imports instead of banning them.
 */
export const postgresDisplay: DriverDisplay<PostgresConnectionConfig> = {
  /**
   * The name goes into a 240px row that truncates at the end, so it carries the
   * part that **tells two connections apart** — which for PostgreSQL is the
   * database, not the address: two databases on one server would otherwise both
   * read `postgresql://user@localhost:543…`. The address is the fallback for a
   * config that never names a database, and the full text is not lost, it moves
   * to `detail`.
   *
   * No branch returns a URL, which is why nothing here has to be scrubbed.
   */
  label(config) {
    const parts = urlParts(config.url)
    return (
      config.database ??
      parts?.database ??
      hostPort(config.host ?? parts?.host, config.port ?? parts?.port) ??
      config.driverId
    )
  },

  /**
   * The long form: what `label` had to leave out, for the row's tooltip. A URL
   * is shown as given rather than reassembled, because the user typed it and
   * would not recognise a normalized version of it — but scrubbed, since this
   * string reaches the renderer and MCP and a URL carries a plaintext password.
   *
   * Assembled from fields, each fragment vanishes whole when its field is
   * absent: `user@` and `/database` are not worth printing as empty punctuation.
   */
  detail(config) {
    if (config.url !== undefined) return redactUrlCredentials(config.url)
    const at = hostPort(config.host, config.port) ?? ''
    const user = config.user === undefined ? '' : `${config.user}@`
    const db = config.database === undefined ? '' : `/${config.database}`
    return `${config.driverId}://${user}${at}${db}`
  },

  /**
   * One line of address for a model, which is why the defaults are spelled out
   * rather than omitted: `localhost:5432` is what the driver will actually
   * connect to, and a reader that has to know libpq's defaults to work that out
   * is a reader that will guess wrong.
   */
  endpoint(config) {
    if (config.url) return config.url
    return `${config.host ?? 'localhost'}:${config.port ?? 5432}/${config.database ?? ''}`
  },
}
