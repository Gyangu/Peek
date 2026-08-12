import type { DriverDisplay, DriverId } from '@peek/core'
import { neo4jDisplay } from '@peek/db-neo4j/display'
import { postgresDisplay } from '@peek/db-postgres/display'
import { qdrantDisplay } from '@peek/db-qdrant/display'
import { redisDisplay } from '@peek/db-redis/display'
import { sqlDisplays } from '@peek/db-sql/display'

/* ==================================================================
 * The five in-repo packages' displays, keyed the way a package host holds them
 * — the naming half of `./in-repo-packages`, and a fixture for the same reason.
 *
 * **This is a test file, and that is the change.** `DRIVER_DISPLAYS` lived in
 * `drivers/manifests.ts` until this round, as a total `Record<DriverId, …>` that
 * `main/packages/entry.ts` sliced per package. Phase C ended that: a host
 * `import()`s its own `contrib.mjs`, so the table had no reader left in either
 * bundle and was kept out of both only by tree-shaking — which is a property of
 * today's call graph, not a boundary. Deleting a row from it changed no shipped
 * byte and turned five test files red, which is a guard nobody can act on.
 *
 * ## What it stands in for, and what checks that
 *
 * Each of these objects is what its package's `src/entry/contrib.ts` exports and
 * therefore what `build-packages.mjs` compiles into `contrib.mjs` — the same
 * `@peek/db-x/display` module, reached through the same client-free subpath
 * (`main/packages/__tests__/subpath-purity.test.ts`). So a test indexing this
 * gets the shipped implementation with nothing in between, which is what the
 * files that ask "what does neo4j call this connection" need.
 *
 * The one step it cannot see is the wiring in each `contrib.ts` — a package
 * spreading its displays under the wrong key (`sqlDisplays` writing `postgres`
 * where it meant `mysql` still type-checks, because it collides with a key
 * something declares anyway). That is asked of the artifact instead:
 * `build-packages.mjs` compares the built `contrib.mjs`'s `displays` export
 * against the driver ids in the `peek-package.json` it just wrote, per package,
 * and fails the build. Restating it here would be a second answer, and the one
 * that shipped would not be the one under test.
 *
 * ## Total over the ids, not partial
 *
 * `driver-registry.test.ts` is what keeps the keys and the collected manifests
 * in step. A driver with no entry here is not a bug in peek — the host answers
 * `NOT_FOUND` and the connection opens unnamed — it is `display-fallback` and
 * `connection-label` quietly testing one database fewer, which is the failure
 * mode a fixture has and a shipped table does not.
 * ================================================================== */

export const DRIVER_DISPLAYS: Readonly<Record<DriverId, DriverDisplay>> = {
  postgres: postgresDisplay,
  // Spread rather than restated, exactly as `db-sql`'s own `contrib.ts` does it:
  // which dialects that package ships is that package's business.
  ...sqlDisplays,
  redis: redisDisplay,
  qdrant: qdrantDisplay,
  neo4j: neo4jDisplay,
}
