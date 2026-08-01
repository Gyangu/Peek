import {
  QDRANT_VECTOR_FIELD,
  peekErrorMsg,
  type CollectionRef,
  type NamespaceNode,
  type VectorCollectionRef,
} from '@peek/core'

/**
 * The qdrant namespace tree: **collection → (named vector | payload index)**.
 *
 * Only two levels, because that is all qdrant has. The second level is
 * informational — a named vector node and a payload-index node describe the
 * collection's structure and carry no `ref`, since neither is separately
 * browsable. The collection node itself carries a `VectorCollectionRef` and is
 * what a click opens as a table view.
 *
 * Everything below is one `GET /collections` plus one `GET /collections/{name}`
 * per expansion, both cheap and both cached by the session until a manual
 * refresh (PLAN section 8).
 */

/** Node ids: 'collection:docs' / 'vector:docs:title' / 'payloadIndex:docs:lang' */
export const collectionNodeId = {
  collection: (name: string): string => `collection:${name}`,
  vector: (collection: string, name: string): string => `vector:${collection}:${name}`,
  payloadIndex: (collection: string, field: string): string => `payloadIndex:${collection}:${field}`,
}

export type ParsedCollectionNodeId =
  | { kind: 'collection'; name: string }
  | { kind: 'vector'; collection: string; name: string }
  | { kind: 'payloadIndex'; collection: string; field: string }
  | { kind: 'unknown' }

/**
 * Collection names are restricted enough that ':' inside one is not a practical
 * concern, but a payload field name is arbitrary — so the *last* segment is
 * taken verbatim, exactly as in the redis codec.
 */
export function parseCollectionNodeId(id: string): ParsedCollectionNodeId {
  const first = id.indexOf(':')
  if (first < 0) return { kind: 'unknown' }
  const tag = id.slice(0, first)
  const rest = id.slice(first + 1)
  if (tag === 'collection') return rest.length > 0 ? { kind: 'collection', name: rest } : { kind: 'unknown' }

  const second = rest.indexOf(':')
  if (second < 0) return { kind: 'unknown' }
  const collection = rest.slice(0, second)
  const tail = rest.slice(second + 1)
  if (collection.length === 0 || tail.length === 0) return { kind: 'unknown' }
  if (tag === 'vector') return { kind: 'vector', collection, name: tail }
  if (tag === 'payloadIndex') return { kind: 'payloadIndex', collection, field: tail }
  return { kind: 'unknown' }
}

export interface CollectionsDeps {
  listCollections(): Promise<string[]>
  /** GET /collections/{name}: vector configuration, payload indexes, point count */
  describe(name: string): Promise<QdrantCollectionInfo>
}

export interface QdrantCollectionInfo {
  name: string
  pointsCount: number | null
  /**
   * Configured vectors. An unnamed (single-vector) collection reports one entry
   * whose `name` is '' — flattening that into "no name" here means the rest of
   * the driver has one case to handle instead of two.
   */
  vectors: { name: string; size: number; distance: string }[]
  /** Indexed payload keys, which is what `describeCollection` flattens into columns */
  payloadIndexes: { field: string; type: string }[]
}

/**
 * Point-count hint shown on a tree node.
 *
 * Deliberately an English literal, not a catalog message: this string is written
 * into NamespaceNode.detail, which MCP reads as well as the sidebar, and the MCP
 * surface stays English forever.
 */
export function formatPoints(n: number): string {
  if (n < 1000) return `${n} points`
  if (n < 1_000_000) return `~${(n / 1000).toFixed(1)}k points`
  return `~${(n / 1_000_000).toFixed(1)}M points`
}

/** '1024d · Cosine', or 'title: 768d · Cosine, body: 1024d · Dot' when the collection is multi-vector */
export function formatVectors(info: QdrantCollectionInfo): string {
  return info.vectors
    .map((v) => (v.name === '' ? `${v.size}d · ${v.distance}` : `${v.name}: ${v.size}d · ${v.distance}`))
    .join(', ')
}

/** The label of a vector in the tree; the unnamed vector borrows core's reserved field name */
function vectorLabel(name: string): string {
  return name === '' ? QDRANT_VECTOR_FIELD : name
}

export class QdrantCollections {
  private readonly deps: CollectionsDeps
  /** describeCollection cache, keyed by collection name (PLAN section 8: lazy tree + cache + manual invalidation) */
  private readonly describeCache = new Map<string, QdrantCollectionInfo>()

  constructor(deps: CollectionsDeps) {
    this.deps = deps
  }

  /**
   * Cached `GET /collections/{name}`.
   *
   * Both the tree and `describeCollection` need it, and a root expansion needs it
   * once per collection — without the cache, opening the sidebar and then a table
   * view would describe the same collection twice within a second.
   */
  async describeInfo(name: string, refresh = false): Promise<QdrantCollectionInfo> {
    if (!refresh) {
      const hit = this.describeCache.get(name)
      if (hit) return hit
    }
    const info = await this.deps.describe(name)
    this.describeCache.set(name, info)
    return info
  }

  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    if (parentId === null) return this.collectionNodes()
    const parsed = parseCollectionNodeId(parentId)
    switch (parsed.kind) {
      case 'collection':
        return this.structureNodes(parsed.name)
      case 'vector':
      case 'payloadIndex':
        // Leaves: they describe the collection, they are not browsable
        return []
      case 'unknown':
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
    }
  }

  private async collectionNodes(): Promise<NamespaceNode[]> {
    const names = await this.deps.listCollections()
    // Describing every collection up front is what puts the point count and the
    // vector geometry on the row. They are cheap `GET`s and they are cached, but
    // a collection can be dropped between the list and the describe — one
    // failure must not blank the whole tree, so the node degrades to name only.
    const settled = await Promise.allSettled(names.map((name) => this.describeInfo(name)))
    return names.map((name, i) => {
      const outcome = settled[i]
      const info = outcome !== undefined && outcome.status === 'fulfilled' ? outcome.value : null
      const ref: VectorCollectionRef = { kind: 'vectorCollection', collection: name }
      const node: NamespaceNode = {
        id: collectionNodeId.collection(name),
        name,
        kind: 'collection',
        hasChildren: info === null || info.vectors.length + info.payloadIndexes.length > 0,
        ref,
      }
      if (info === null) return node
      const bits: string[] = []
      if (info.pointsCount !== null) bits.push(formatPoints(info.pointsCount))
      const vectors = formatVectors(info)
      if (vectors.length > 0) bits.push(vectors)
      if (bits.length > 0) node.detail = bits.join(' · ')
      node.meta = {
        ...(info.pointsCount === null ? {} : { rowCountEstimate: info.pointsCount }),
        vectors: info.vectors,
        payloadIndexes: info.payloadIndexes.map((p) => p.field),
      }
      return node
    })
  }

  private async structureNodes(collection: string): Promise<NamespaceNode[]> {
    const info = await this.describeInfo(collection)
    const nodes: NamespaceNode[] = info.vectors.map((v) => ({
      id: collectionNodeId.vector(collection, vectorLabel(v.name)),
      name: vectorLabel(v.name),
      // A named vector is the closest qdrant has to a typed column of the collection
      kind: 'column' as const,
      hasChildren: false,
      detail: `${v.size}d · ${v.distance}`,
      meta: { vectorName: v.name, size: v.size, distance: v.distance },
    }))
    for (const p of info.payloadIndexes) {
      nodes.push({
        id: collectionNodeId.payloadIndex(collection, p.field),
        name: p.field,
        kind: 'index',
        hasChildren: false,
        detail: `payload index · ${p.type}`,
        meta: { payloadField: p.field, dataType: p.type },
      })
    }
    return nodes
  }

  /** Drop the cached collection descriptions on a manual refresh */
  invalidate(): void {
    this.describeCache.clear()
  }

  /** The ref has to be a vector collection; the others belong to other drivers. */
  static requireCollection(ref: CollectionRef): VectorCollectionRef {
    if (ref.kind !== 'vectorCollection') {
      throw peekErrorMsg('BAD_REQUEST', 'error.collection.kindUnsupported', {
        driverId: 'qdrant',
        kind: ref.kind,
      })
    }
    return ref
  }
}
