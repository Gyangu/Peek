import { z } from 'zod'
import type { InstalledPackages, InstalledTool, ToolMeta } from '@peek/core'
import { neo4jManifest } from '@peek/db-neo4j/manifest'
import { graphViewKindMeta } from '@peek/db-neo4j/manifest'
import { neo4jToolMeta } from '@peek/db-neo4j/mcp-tool-meta'
import { postgresManifest } from '@peek/db-postgres/manifest'
import { qdrantManifest } from '@peek/db-qdrant/manifest'
import { redisManifest } from '@peek/db-redis/manifest'
import { sqlManifests } from '@peek/db-sql/manifest'

/* ==================================================================
 * The five in-repo packages, installed the way a scan of
 * `~/.peek/packages/` would install them.
 *
 * **Not production code, and not a fallback.** `drivers/manifests.ts` used to
 * hold exactly this list as a module constant, and Phase C's whole point is that
 * it no longer does: main and the window fill the registry from what
 * `loadPackages` found on disk, so a build that forgot to install shows no
 * databases rather than a plausible-looking list that is a build behind. Putting
 * a list back into the app — even a defaulted one — would restore that failure
 * mode and hide it from the one place it is observable.
 *
 * A test, though, has no disk to read: `pnpm test` runs `node --test` over
 * TypeScript sources, with no `out/packages/` and no `~/.peek/`. So it stands in
 * for the loader by installing the same values the loader would have parsed —
 * these manifests are literally what `build-packages.mjs` serializes each
 * `peek-package.json` out of, which is what makes the substitution honest rather
 * than a second source of truth.
 *
 * ## The value, and the install, are two modules
 *
 * This one only declares the value. `./in-repo-registry` beside it imports and
 * installs it, and importing *that* is how most of the suite gets a registry —
 * see its own header. They are separate because one test needs the value
 * **without** the install: `mcp/__tests__/tool-descriptions.test.ts` is about
 * text assembled after the modules that produce it were loaded, and a
 * side-effecting import would put the registry in place too early for that
 * question to be asked at all.
 *
 * ## What is deliberately not reproduced
 *
 * The loader's own order. It sorts by directory name (neo4j, postgres, qdrant,
 * redis, sql); this keeps the order `DRIVER_MANIFESTS` had, because that order
 * is what the tests below were written against and reordering it here would
 * report as a failure of whatever else is being changed. Nothing asserts the
 * loader's order, and the one place order is visible to anyone —
 * `list_connections`' capability table — states no promise about it.
 * ================================================================== */

/** Which package ships which driver, as the built package directories are named. */
const PACKAGE_OF: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  mysql: 'sql',
  sqlite: 'sql',
  redis: 'redis',
  qdrant: 'qdrant',
  neo4j: 'neo4j',
}

/**
 * One `defineToolMeta` declaration as the loader would have parsed it off disk.
 *
 * The same conversion `build-packages.mjs`'s `serializeTool` does, for the same
 * reason the manifests above are the packages' own: a hand-written JSON Schema
 * here would be a second answer to "what is `expand_node`'s input", and the one
 * that matters — main's — reads the *converted* value. `z.toJSONSchema` is what
 * puts the two on the same footing.
 */
function asInstalled(meta: ToolMeta, packageId: string): InstalledTool {
  const base = {
    packageId,
    name: meta.name,
    description: meta.description,
    inputSchema: z.toJSONSchema(meta.inputSchema) as Record<string, unknown>,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.annotations === undefined ? {} : { annotations: meta.annotations }),
  }
  return meta.kind === 'read'
    ? { ...base, kind: 'read' }
    : { ...base, kind: 'command', hasRenderer: meta.hasRenderer }
}

export const IN_REPO_PACKAGES: InstalledPackages = {
  drivers: [postgresManifest, ...sqlManifests, redisManifest, qdrantManifest, neo4jManifest].map(
    (manifest) => ({ packageId: PACKAGE_OF[manifest.driverId] ?? manifest.driverId, manifest }),
  ),
  viewKinds: [{ ...graphViewKindMeta, packageId: 'neo4j' }],
  // No longer empty, and that is §4duodevicies: `main/mcp/package-tools.ts` maps
  // this list rather than a compiled-in constant, so a suite that installed a
  // registry with no tools in it would be asserting against a peek whose
  // fourteenth tool does not exist.
  tools: neo4jToolMeta.map((meta) => asInstalled(meta, 'neo4j')),
}
