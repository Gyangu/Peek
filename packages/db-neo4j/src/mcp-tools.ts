import {
  asViewId,
  peekError,
  toolFromMeta,
  type ToolSpec,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'
import { expandNodeMeta } from './mcp-tool-meta'
import { GRAPH_VIEW_KIND } from './view'

/* ==================================================================
 * What this package's MCP tools do.
 *
 * Reached as `@peek/db-neo4j/mcp-tools`, and like `/manifest` and `/view` it
 * never touches `index.ts`. It loads in the **package host** — main holds only
 * `/mcp-tool-meta`, which is why `tools/list` costs no process — and an import
 * that reached `./driver` would put a Bolt client in that host's chunk, which
 * `subpath-purity.test.ts` refuses.
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
 * nothing else; `graph.ts` — package code, running in this same process — is
 * what turns those into Cypher. That is the same boundary the self-drawn frame
 * sits behind (`graph.ts` header), and for the same reason: the caller here is a
 * model, which is exactly as untrusted as the frame.
 * ================================================================== */

function findView(snap: WorkspaceSnapshot, viewId: string): ViewSummary | undefined {
  return snap.views.find((v) => String(v.id) === viewId)
}

/**
 * Expand a graph view around one node.
 *
 * The refusals are the interesting part. `view.update` would reject a package
 * patch aimed at a table view on its own, but it would reject it as a kind
 * mismatch — a message about discriminated unions, addressed to nobody. Checking
 * here means the answer names the view's actual kind, which is the one fact a
 * model needs to pick a different `viewId` and get it right on the second try.
 */
const expandNode = toolFromMeta(expandNodeMeta, {
  toCommands(input, ctx) {
    const view = findView(ctx.getSnapshot(), input.viewId)
    if (view === undefined) {
      throw peekError('NOT_FOUND', `No view ${input.viewId}. Call read_workspace for the open views.`)
    }
    if (view.kind !== 'package' || view.packageKind !== GRAPH_VIEW_KIND) {
      throw peekError(
        'BAD_REQUEST',
        `View ${input.viewId} is a ${view.packageKind ?? view.kind} view, not a graph view. ` +
          'expand_node only acts on a Neo4j graph view; open one with ' +
          'open_view {"kind":"package","packageKind":"graph","connId":"…"}.',
      )
    }
    return [
      {
        name: 'view.update',
        input: {
          viewId: asViewId(input.viewId),
          patch: {
            kind: 'package',
            state: {
              focus: input.nodeId,
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              // `focus` wins over `label` inside `composeGraphQuery`, so leaving a
              // stale label behind would change nothing about the result — and
              // would make the view's own title and describe keep naming a filter
              // that is no longer being applied. `null` is how a package patch
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
