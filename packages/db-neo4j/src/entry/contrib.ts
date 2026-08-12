import type { PackageDisplayEntry, ToolSpec, ViewKindRegistration } from '@peek/core'
import { neo4jDisplay } from '../display'
import { neo4jMcpTools } from '../mcp-tools'
import { graphViewKind } from '../view'

/**
 * `entry.contrib` — the only package that contributes all three today.
 *
 * The three named exports are `PackageHostRuntimeOptions`, so the module
 * namespace is the value the runtime takes and `loadContrib` needs no adapter
 * (design 2026-08-07 §2.4).
 *
 * What arrives here is the *code* half of each contribution and only that half:
 * `graphViewKind` carries `autoFetch` / `describe` / `title` / `collectionRef`,
 * `neo4jMcpTools` carries `toCommands` / `render`. Their declarative halves —
 * the kind string, the tool's name and input schema — are read from
 * `peek-package.json` in main, which is what lets `tools/list` be answered
 * without forking this process at all (§2.4bis(d)).
 *
 * Three client-free subpaths and never `../driver` or the package index: see the
 * header of `db-postgres/src/entry/contrib.ts` for the rule and for what
 * checks it. `../view` and `../mcp-tools` both reach `../graph`, which composes
 * Cypher as strings and opens nothing — that is the distinction the package host
 * exists to hold, and `subpath-purity.test.ts` follows those relative imports to
 * keep it.
 */
export const displays: readonly PackageDisplayEntry[] = [
  { driverId: 'neo4j', display: neo4jDisplay },
]

export const viewKinds: readonly ViewKindRegistration[] = [graphViewKind]

export const tools: readonly ToolSpec[] = neo4jMcpTools
