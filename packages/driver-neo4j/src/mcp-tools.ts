import { z } from 'zod'
import {
  asViewId,
  defineToolSpec,
  peekError,
  type ToolSpec,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'
import { MAX_DEPTH } from './graph'
import { GRAPH_VIEW_KIND } from './view'

/* ==================================================================
 * The MCP tools this package contributes.
 *
 * Reached as `@peek/driver-neo4j/mcp-tools`, and like `/manifest` and `/view` it
 * never touches `index.ts`: this loads in **main**, beside the tool registry, and
 * an import that reached `./driver` would put a Bolt client in the main-process
 * chunk.
 *
 * ## Why a package tool exists at all
 *
 * Not because the Command Bus needed a new verb — all 32 are kernel-generic and
 * this one lands on `view.update` like any other (design §2.3bis(c)). It exists
 * because the *mapping* is Neo4j knowledge: that a graph is expanded by writing
 * an `elementId()` string into a state key called `focus`, that depth is capped
 * at three because four hops is a hairball, that the anchor node and the label
 * filter are mutually exclusive. None of that is something the kernel should
 * know, and a model driving peek through the generic path would have to guess
 * all three.
 *
 * ## What it is not allowed to be
 *
 * A statement-composition surface. `expand_node` writes `focus` and `depth` and
 * nothing else; `graph.ts` — package code, running in main, in this same
 * process — is what turns those into Cypher. That is the same boundary the
 * self-drawn frame sits behind (`graph.ts` header), and for the same reason: the
 * caller here is a model, which is exactly as untrusted as the frame.
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

function findView(snap: WorkspaceSnapshot, viewId: string): ViewSummary | undefined {
  return snap.views.find((v) => String(v.id) === viewId)
}

/**
 * Expand a graph view around one node.
 *
 * The refusals are the interesting part. `view.update` would reject a plugin
 * patch aimed at a table view on its own, but it would reject it as a kind
 * mismatch — a message about discriminated unions, addressed to nobody. Checking
 * here means the answer names the view's actual kind, which is the one fact a
 * model needs to pick a different `viewId` and get it right on the second try.
 */
const expandNode = defineToolSpec({
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
  toCommands(input, ctx) {
    const view = findView(ctx.getSnapshot(), input.viewId)
    if (view === undefined) {
      throw peekError('NOT_FOUND', `No view ${input.viewId}. Call read_workspace for the open views.`)
    }
    if (view.kind !== 'plugin' || view.pluginKind !== GRAPH_VIEW_KIND) {
      throw peekError(
        'BAD_REQUEST',
        `View ${input.viewId} is a ${view.pluginKind ?? view.kind} view, not a graph view. ` +
          'expand_node only acts on a Neo4j graph view; open one with ' +
          'open_view {"kind":"plugin","pluginKind":"graph","connId":"…"}.',
      )
    }
    return [
      {
        name: 'view.update',
        input: {
          viewId: asViewId(input.viewId),
          patch: {
            kind: 'plugin',
            state: {
              focus: input.nodeId,
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              // `focus` wins over `label` inside `composeGraphQuery`, so leaving a
              // stale label behind would change nothing about the result — and
              // would make the view's own title and describe keep naming a filter
              // that is no longer being applied. `null` is how a plugin patch
              // clears a key (`ViewPatchSchema`).
              label: null,
            },
          },
        },
      },
    ]
  },
  render(_outcomes, input, ctx) {
    const view = findView(ctx.getSnapshot(), input.viewId)
    return {
      text:
        `Graph view ${input.viewId} now expands ${input.nodeId}` +
        `${input.depth === undefined ? '' : ` to depth ${String(input.depth)}`}.\n\n` +
        `${view?.describe ?? 'The view is no longer open.'}\n\n` +
        'The rows are in the UI; the view draws them as a node-link diagram.',
    }
  },
})

export const neo4jMcpTools: readonly ToolSpec[] = [expandNode]
