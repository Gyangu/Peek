import type { PackageViewStateShape, ViewKindRegistration } from '@peek/core'
import { composeGraphQuery, graphTitle, readGraphState } from './graph'
import { graphViewKindMeta } from './manifest'

/* ==================================================================
 * The `graph` view kind — the kernel-facing half.
 *
 * Reached as `@peek/db-neo4j/view`. Like `/manifest` it deliberately never
 * touches `index.ts`, because this runs in **main**: `autoFetch` is called from
 * `handlers/shared.ts` while a Command is reducing, and a `neo4j-driver` import
 * on that path would put a Bolt client in the main-process chunk.
 *
 * The renderer holds the other half — the component that draws it — in
 * `apps/desktop/src/renderer/packages/`. A kind present in one registry and not
 * the other is a load-time refusal, not a blank panel.
 * ================================================================== */

/**
 * Read off the declaration rather than spelled again.
 *
 * The string is the discriminant both registries are keyed by and the one MCP
 * clients see as `packageKind`; a second copy of it here would be a copy that can
 * disagree with the manifest, and disagreement reads as a view kind that is
 * offered and then cannot be opened.
 */
export const GRAPH_VIEW_KIND = graphViewKindMeta.kind

export const graphViewKind: ViewKindRegistration = {
  kind: GRAPH_VIEW_KIND,

  /**
   * Neo4j only, and stated rather than inferred — in `./manifest`, because it is
   * the half main reads without forking this package's host.
   *
   * The capability set would not narrow it — `tabularQuery` is what every SQL
   * database advertises — and this list is what decides whether the connection
   * menu offers the view at all. A graph view offered on a redis connection is
   * an act that can only fail.
   */
  driverIds: graphViewKindMeta.driverIds,

  /**
   * English, always — `read_workspace` serializes this and a locale-dependent
   * string is not a stable API. Same contract as core's `describeView`.
   */
  describe(view: PackageViewStateShape): string {
    const s = readGraphState(view.state)
    const scope =
      s.focus !== undefined
        ? `around ${s.focus} to depth ${String(s.depth)}`
        : s.label === undefined
          ? 'across all labels'
          : `of :${s.label}`
    return `Neo4j graph ${scope}, up to ${String(s.limit)} nodes`
  },

  title(view: PackageViewStateShape): string {
    return graphTitle(readGraphState(view.state))
  },

  titleKey: 'view.kind.graph',

  /**
   * Always a fetch, never `null`.
   *
   * A graph view with no label and no focus is not an empty view — it is "show me
   * a sample of this database", which is the useful first thing to see. The
   * `null` return exists for kinds that genuinely have nothing to ask for, and
   * this is not one; saying so explicitly is the point of the field.
   */
  autoFetch(view: PackageViewStateShape) {
    const { text, params } = composeGraphQuery(readGraphState(view.state))
    return { capability: 'tabularQuery' as const, text, params }
  },

  /**
   * No `CollectionRef`.
   *
   * A graph is not one of the three shapes core models — it is not a relation, a
   * key pattern or a vector collection — and claiming one would switch on
   * collection-shaped affordances (the browse-style table, the collection context
   * actions) that address something this view is not looking at. `null` is the
   * honest answer and the reason the field is nullable.
   */
  collectionRef(): null {
    return null
  },
}
