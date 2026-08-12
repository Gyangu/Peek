import type { InstalledTool } from '@peek/core'
import { definePackageContribution, type PackageContribution } from './contribution'
import { installedTools } from './installed'

/* ==================================================================
 * MCP tools, as one of the kinds of thing a package contributes.
 *
 * The third sibling of `manifests.ts` and `viewKinds.ts` — read the first of
 * those headers for why this file is in neither `main/` nor `renderer/`. It is
 * the only one of the three that is a descriptor and nothing else, because both
 * of the tables it used to hold have gone.
 *
 * ## What was here, and where each half went
 *
 * `PACKAGE_TOOL_META` — the declarations, tagged with the package that runs
 * each name — was what main registered on the MCP server, and that was the bug
 * §4duodevicies fixed: a compile-time constant cannot describe what is
 * installed, so uninstalling neo4j left `expand_node` in `tools/list` across a
 * fresh session and across a restart (§4sedecies(b), acceptance 13). A tool's
 * whole declaration is a key of `peek-package.json` now, `installedTools()` in
 * `drivers/installed.ts` is the loader's reading of it, and
 * `main/mcp/package-tools.ts` builds its stand-ins from that.
 *
 * `mcpToolSpecs.ts` beside it — the mappings, reached through
 * `@peek/db-neo4j/mcp-tools` — was the package host's half, sliced by package id
 * out of one compiled-in array. §4quaterdecies took it: `main/packages/entry.ts`
 * `import()`s the package's own `contrib.mjs`, so the host is handed its
 * mappings rather than filtering everyone's, and a package this build never
 * compiled anything for is no longer a package that cannot be loaded.
 *
 * ## The pairing between them is checked over the artifacts now
 *
 * A name declared on one side and forgotten on the other still fails silently in
 * both directions — a declaration with no mapping lists fine and fails only when
 * a model calls it, a mapping with no declaration is never reachable — so the
 * question survived the tables. `build-packages.mjs` asks it of the two files
 * that ship: the built `contrib.mjs`'s `tools` export against the `tools` key it
 * just wrote into that package's `peek-package.json`, per package, at build
 * time. Deleting a mapping now changes bytes and fails the build, which is the
 * property the two arrays could not have.
 *
 * ## What a package tool is, and what it is not
 *
 * It is not a new verb. All 32 Command names are kernel-generic and none of them
 * belongs to a database (`core/commands.ts`, and design §2.3bis(c)); a package
 * tool is the same thin shell over the same bus that the kernel's thirteen are,
 * differing only in that it knows something about one database that the kernel
 * has no business knowing — that a `graph` view is expanded by writing an
 * `elementId` into `focus`, say.
 *
 * So the shape here mirrors view kinds exactly. The kernel keeps its own
 * thirteen tools in `main/mcp/tools/`, a package contributes the fourteenth, and
 * neither list is the other's subset. Anyone reading design §2.6ter as "the
 * thirteen should move into packages" should read §2.4bis(a) first: moving
 * `set_layout` into `db-postgres` would be asserting that arranging panes is
 * a property of PostgreSQL.
 * ================================================================== */

/**
 * The gate for the `tools` half of the registry.
 *
 * The gate is an identity, and which list it is an identity *over* is the whole
 * content of this descriptor: `compiled()` is `installedTools()`, the loader's
 * reading of `~/.peek/packages/`, and there is no second list left for it to
 * disagree with. That is the same statement `manifests.ts` makes — the
 * declaration *is* the live list, there is nothing an uninstall can leave
 * behind — and the guard is what keeps it from being a comment nobody rechecks.
 *
 * An identity over a *compiled-in* table is the thing this must not become. It
 * would look like the stricter answer and be a false one: a package peek never
 * compiled anything for is listed by main and would be missing here, so the
 * descriptor would claim peek offers fewer tools than it does.
 */
export const toolContribution: PackageContribution<InstalledTool> = definePackageContribution({
  declaredIn: 'tools',
  what: 'MCP tool',
  declaredKeys: () => installedTools().map((tool) => tool.name),
  compiled: () => installedTools(),
  keyOf: (tool) => tool.name,
})
