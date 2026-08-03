/* ==================================================================
 * The `graph` view's state, and the Cypher it turns into.
 *
 * **Pure**: `@peek/core` types only, no `neo4j-driver`. This module runs in the
 * main process, reached through `@peek/driver-neo4j/view`, because that is where
 * a view's `autoFetch` is planned. It is also the reason the self-drawn frame is
 * not a statement-composition surface: the frame can patch `label` / `focus` /
 * `depth` / `limit` and nothing else, and *this* file — trusted package code —
 * is what decides what those become.
 * ================================================================== */

/** How the graph view is currently pointed at the database. */
export interface GraphViewState {
  /** Start from every node carrying this label. Absent means every node. */
  label?: string
  /** Expand around one node, addressed by `elementId()`. Wins over `label`. */
  focus?: string
  /** Hops to follow out of `focus`. Ignored without one. */
  depth: number
  /** Node ceiling. The edges around them are bounded separately, see below. */
  limit: number
}

/**
 * Depth is **inlined into the statement**, so it is clamped rather than trusted.
 *
 * Cypher does not accept a parameter inside a variable-length pattern
 * (`[*1..$d]` is a syntax error), so the number becomes text. Everything else in
 * a composed statement here is a bound parameter; this is the one value that
 * cannot be, which is exactly why it is forced through `Math` and a hard ceiling
 * instead of being interpolated as it arrived.
 *
 * The ceiling is also a real one, not defensive decoration: an unbounded
 * `[*1..]` on a well-connected graph traverses most of the database, and at 4
 * hops the answer is already a hairball nobody can read.
 */
export const MAX_DEPTH = 3
export const DEFAULT_DEPTH = 1

/**
 * Node ceiling, and the reason a self-drawn view does not need chunked streaming.
 *
 * A force-directed layout stops being a picture and starts being a smudge in the
 * low hundreds — Neo4j Browser caps its own canvas at 300 for the same reason.
 * So this view's result is small by construction, which is what lets the host
 * send one bounded snapshot over the port instead of tee-ing every `ChunkFrame`.
 */
export const MAX_NODES = 500
export const DEFAULT_NODES = 100

/**
 * Edges are capped separately, at a multiple of the node cap.
 *
 * One row per (node, incident edge) means a single hub node can produce
 * thousands of rows on its own; without a second ceiling the node budget would
 * be spent by one node's neighbourhood and the rest of the graph would never
 * appear.
 */
const EDGE_ROWS_PER_NODE = 8

export interface ComposedQuery {
  text: string
  /** Positional, in the order `$p1`, `$p2`, … appear. See `Neo4jSession.query`. */
  params: readonly unknown[]
}

/**
 * Read a plugin view's opaque state into this view's shape.
 *
 * Every field is re-derived rather than trusted: `state` is a
 * `Record<string, unknown>` that the kernel stores verbatim and never inspects,
 * and it can arrive from a restored workspace, from an MCP client, or from the
 * plugin's own frame. This function is the one boundary where it becomes typed,
 * the same role `keyValueReadOptions` plays for a `KeyValueWindow`.
 */
export function readGraphState(state: Readonly<Record<string, unknown>>): GraphViewState {
  const str = (key: string): string | undefined => {
    const v = state[key]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const v = state[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(v)))
  }
  return {
    ...(str('label') === undefined ? {} : { label: str('label') as string }),
    ...(str('focus') === undefined ? {} : { focus: str('focus') as string }),
    depth: int('depth', DEFAULT_DEPTH, 1, MAX_DEPTH),
    limit: int('limit', DEFAULT_NODES, 1, MAX_NODES),
  }
}

/**
 * Quote a label for use in a pattern.
 *
 * A label cannot be a parameter in Cypher — `(n:$x)` does not parse — so it is
 * the second value that has to be interpolated. Backtick quoting is Cypher's own
 * escape for identifiers, and doubling an internal backtick is how a backtick
 * survives inside one. Without the doubling, a label containing a backtick would
 * close the quote early and the rest of it would be read as Cypher.
 *
 * Neo4j labels genuinely can contain almost anything when created through the
 * driver's parameterized `CALL apoc.create` or a literal backtick form, so this
 * is a real case rather than a hypothetical.
 */
export function quoteLabel(label: string): string {
  return `\`${label.replace(/`/g, '``')}\``
}

/**
 * The statement this state asks for.
 *
 * Three shapes, all returning the same two columns — an anchor node and a path —
 * so the frame's harvester has one thing to understand rather than three:
 *
 * - **focus**: the anchor is matched by `elementId`, and the path is
 *   `OPTIONAL` so an isolated node still comes back as a node rather than as
 *   zero rows. `RETURN n` on its own would be the same query minus the point.
 * - **label** / **everything**: nodes are limited *first* (`WITH n LIMIT`) and
 *   expanded after. Limiting at the end instead would let one hub node's edges
 *   consume the whole budget, and the view would show one node's neighbourhood
 *   claiming to be a sample of the graph.
 */
export function composeGraphQuery(state: GraphViewState): ComposedQuery {
  const edgeRows = state.limit * EDGE_ROWS_PER_NODE

  if (state.focus !== undefined) {
    const depth = Math.min(MAX_DEPTH, Math.max(1, Math.trunc(state.depth)))
    return {
      text: [
        'MATCH (n) WHERE elementId(n) = $p1',
        `OPTIONAL MATCH p = (n)-[*1..${String(depth)}]-()`,
        'RETURN n, p',
        'LIMIT $p2',
      ].join('\n'),
      params: [state.focus, edgeRows],
    }
  }

  const pattern = state.label === undefined ? '(n)' : `(n:${quoteLabel(state.label)})`
  return {
    text: [
      `MATCH ${pattern}`,
      'WITH n LIMIT $p1',
      'OPTIONAL MATCH p = (n)-[]-()',
      'RETURN n, p',
      'LIMIT $p2',
    ].join('\n'),
    params: [state.limit, edgeRows],
  }
}

/** The tab title: what the view is pointed at, not what it is. */
export function graphTitle(state: GraphViewState): string {
  if (state.focus !== undefined) return `Graph ${state.focus}`
  return state.label === undefined ? 'Graph' : `Graph ${state.label}`
}
