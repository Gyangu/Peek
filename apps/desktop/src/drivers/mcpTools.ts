import type { ToolSpec } from '@peek/core'
import { neo4jMcpTools } from '@peek/driver-neo4j/mcp-tools'

/* ==================================================================
 * Every MCP tool a driver package contributes.
 *
 * The third sibling of `manifests.ts` and `viewKinds.ts` — read the first of
 * those headers for why this file is in neither `main/` nor `renderer/`, and why
 * the list lives in the app rather than in core. Both arguments apply verbatim.
 * The subpath rule applies verbatim too: `@peek/driver-neo4j` reaches
 * `neo4j-driver`; `@peek/driver-neo4j/mcp-tools` reaches `@peek/core` and `zod`
 * and stops. These load in **main**, so going through `index.ts` would put a Bolt
 * client in the main-process chunk.
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
 * `set_layout` into `driver-postgres` would be asserting that arranging panes is
 * a property of PostgreSQL.
 *
 * ## Phase C
 *
 * This array is static and compiled in, which is the whole point of Phase B.
 * Phase C replaces it with a scan of `~/.peek/plugins/` and changes nothing else
 * — `collectTools()` already treats it as an opaque list, and
 * `verify-chat-security.mjs` already asks "does every tool on the wire come from
 * a registered source" rather than "from this repository".
 * ================================================================== */

/**
 * Order is not meaningful; the registry sorts nothing and the MCP SDK is asked
 * to register each by name. It is, however, the order a duplicate name would be
 * reported in, so keeping it stable keeps that message stable.
 */
export const DRIVER_TOOL_SPECS: readonly ToolSpec[] = [...neo4jMcpTools]

/** The names packages contribute, for diagnostics and for the tests that assert this list is reachable. */
export function driverToolNames(): string[] {
  return DRIVER_TOOL_SPECS.map((spec) => spec.name)
}
