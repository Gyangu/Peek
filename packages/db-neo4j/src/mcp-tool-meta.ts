import { z } from 'zod'
import { defineToolMeta, type ToolMeta } from '@peek/core'
import { MAX_DEPTH } from './limits'

/* ==================================================================
 * What this package's MCP tools are, without what they do.
 *
 * Reached as `@peek/db-neo4j/mcp-tool-meta`, and it is the half **main**
 * loads. `/mcp-tools` beside it is the other half — the mappings — and only the
 * package host loads that. Why a `ToolMeta` exists at all is in core; why the
 * two halves are two *files* rather than two exports of one is the part worth
 * repeating here, because one file would look tidier and would silently undo
 * the whole thing: a bundler assigns whole modules to chunks, so the mapping
 * would ride into main's chunk on the declaration's back, and nothing would
 * fail — main would simply be running package code again.
 *
 * `MAX_DEPTH` comes from `./limits` for exactly that reason. It used to live in
 * `graph.ts`, and reaching for it there would drag Cypher composition into main
 * to state a number in a schema.
 *
 * The rest of the argument — what a package tool is, and what it is not allowed
 * to be — is in `mcp-tools.ts`, where the mapping that makes the point lives.
 * ================================================================== */

const ExpandNodeInput = z.object({
  /** A `graph` view that is already open — from `read_workspace`, where it reports `kind: "graph"`. */
  viewId: z.string().min(1),
  /**
   * `elementId()` of the node to expand.
   *
   * Neo4j's own opaque handle, e.g. `4:9f1e…:12`. It is what `peek`'s graph rows
   * carry as a node's id, and what the frame sends back when a user
   * double-clicks one, so a model that read the result set already has it.
   */
  nodeId: z.string().min(1),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
})

/** Expand a graph view around one node; `mcp-tools.ts` holds the mapping. */
export const expandNodeMeta = defineToolMeta({
  kind: 'command',
  name: 'expand_node',
  title: 'Expand a Neo4j graph node',
  description:
    'Re-centre an open Neo4j graph view on one node and pull in its neighbours. ' +
    'Takes the viewId of a view that read_workspace reports as kind "graph", and the ' +
    `elementId() of a node in it. depth is how many hops to follow (1-${String(MAX_DEPTH)}, default 1). ` +
    'This replaces what the view is looking at rather than adding to it: the anchor node ' +
    'and its neighbourhood become the whole picture, and any label filter stops applying. ' +
    'The view re-runs its query and the user watches it redraw.',
  inputSchema: ExpandNodeInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  // The receipt quotes the view's own `describe`, which only the mapping can
  // read; `toolFromMeta` refuses the pair if this and the renderer disagree.
  hasRenderer: true,
})

/** Every tool this package declares, for whoever is listing them. */
export const neo4jToolMeta: readonly ToolMeta[] = [expandNodeMeta]
