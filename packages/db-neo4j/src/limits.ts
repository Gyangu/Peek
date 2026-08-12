/* ==================================================================
 * The ceilings the graph view and its tool share.
 *
 * Its own module because its two readers sit on opposite sides of a process
 * boundary. `graph.ts` clamps with it while composing Cypher and runs in the
 * package host; `mcp-tool-meta.ts` states it in `expand_node`'s input schema and
 * is read by main, which must not load a line of Cypher composition to describe
 * a tool. One constant, reachable from both, and neither pulls the other in.
 * ================================================================== */

/**
 * Depth is **inlined into the statement**, so it is clamped rather than trusted.
 *
 * Cypher does not accept a parameter inside a variable-length pattern
 * (`[*1..$d]` is a syntax error), so the number becomes text. Everything else in
 * a composed statement in `graph.ts` is a bound parameter; this is the one value
 * that cannot be, which is exactly why it is forced through `Math` and a hard
 * ceiling instead of being interpolated as it arrived.
 *
 * The ceiling is also a real one, not defensive decoration: an unbounded
 * `[*1..]` on a well-connected graph traverses most of the database, and at 4
 * hops the answer is already a hairball nobody can read.
 */
export const MAX_DEPTH = 3
