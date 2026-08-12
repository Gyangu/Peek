import { truncatedValue, type LogicalType } from '@peek/core'
import neo4j from 'neo4j-driver'

/* ==================================================================
 * Bolt values → cells a chunk can carry.
 *
 * Everything that leaves this driver crosses a `structuredClone` boundary twice
 * (driver host → main → window), so **class instances cannot survive**. A
 * `Node` posted as-is arrives as a shapeless object with its methods gone and
 * its `Integer`s turned into `{low, high}` — which renders as `[object Object]`
 * and reads as data loss. Every Bolt type therefore becomes a plain JSON value
 * here, on purpose and in one place.
 *
 * The graph shapes (node / relationship / path) keep a `_peek` tag, because the
 * `graph` view's frame has to be able to tell "this cell is a node" from "this
 * cell is a map that happens to have a `labels` key". A tag is the only thing
 * that survives the clone and answers that.
 * ================================================================== */

/** The tag every graph shape carries; the frame's harvester dispatches on it. */
export const PEEK_TAG = '_peek' as const

export interface GraphNodeCell {
  _peek: 'node'
  /** `elementId()`, which is what `composeGraphQuery` matches on to expand a node. */
  id: string
  labels: string[]
  properties: Record<string, unknown>
}

export interface GraphRelCell {
  _peek: 'rel'
  id: string
  type: string
  /** `elementId()` of the endpoints, so an edge can be drawn without its nodes being present. */
  start: string
  end: string
  properties: Record<string, unknown>
}

export interface GraphPathCell {
  _peek: 'path'
  segments: { start: GraphNodeCell; relationship: GraphRelCell; end: GraphNodeCell }[]
}

export type GraphCell = GraphNodeCell | GraphRelCell | GraphPathCell

/**
 * Preview ceiling for a single property value.
 *
 * A node can carry a megabyte of text in one property, and a graph frame holds
 * hundreds of nodes; without a ceiling one verbose node makes the whole snapshot
 * too big to post. Truncation here is the `TruncatedValue` the rest of peek
 * already understands, so it renders as a preview with a size rather than as a
 * silently shortened string.
 */
const MAX_PROPERTY_CHARS = 4096

/**
 * A Neo4j `Integer` is a 64-bit pair, and JavaScript's number is not.
 *
 * `toNumber()` on a value past 2^53 returns a wrong number **without saying so**,
 * which is the failure this function exists to avoid: past the safe range the
 * value becomes its decimal string, which is lossless and displays identically.
 * Below it, a real number, because that is what sorts and formats correctly in
 * the grid.
 */
export function fromNeo4jInteger(value: { toNumber(): number; toString(): string }): number | string {
  const asString = value.toString()
  const asNumber = Number(asString)
  return Number.isSafeInteger(asNumber) ? asNumber : asString
}

function nodeCell(node: { elementId: string; labels: string[]; properties: Record<string, unknown> }): GraphNodeCell {
  return {
    _peek: 'node',
    id: node.elementId,
    labels: [...node.labels],
    properties: propertyBag(node.properties),
  }
}

function relCell(rel: {
  elementId: string
  type: string
  startNodeElementId: string
  endNodeElementId: string
  properties: Record<string, unknown>
}): GraphRelCell {
  return {
    _peek: 'rel',
    id: rel.elementId,
    type: rel.type,
    start: rel.startNodeElementId,
    end: rel.endNodeElementId,
    properties: propertyBag(rel.properties),
  }
}

function propertyBag(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) out[key] = toCell(value)
  return out
}

/**
 * One Bolt value → one cell.
 *
 * Ordered by how the type is recognised, not by how common it is: the `is*`
 * guards come from `neo4j-driver` itself, so a client upgrade that adds a type
 * keeps working (it falls through to the JSON-ish tail) rather than breaking.
 */
export function toCell(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()

  if (neo4j.isInt(value)) return fromNeo4jInteger(value)
  if (neo4j.isNode(value)) return nodeCell(value)
  if (neo4j.isRelationship(value)) return relCell(value)
  if (neo4j.isUnboundRelationship(value)) {
    // No endpoints on the wire — it arrived inside a path, where the segment
    // supplies them. On its own there is nothing to draw an edge between, so it
    // degrades to its properties rather than to a half-built `rel` cell that the
    // harvester would try to connect to nodes that do not exist.
    return { type: value.type, properties: propertyBag(value.properties) }
  }
  if (neo4j.isPath(value)) {
    return {
      _peek: 'path',
      segments: value.segments.map((seg) => ({
        start: nodeCell(seg.start),
        relationship: relCell(seg.relationship),
        end: nodeCell(seg.end),
      })),
    } satisfies GraphPathCell
  }

  // Temporals and points all have faithful `toString()`s (ISO-8601 for the
  // temporals, `Point{srid=…}` for points) and no useful structure once the class
  // is gone, so the string *is* the value rather than a lossy rendering of it.
  if (
    neo4j.isDate(value)
    || neo4j.isDateTime(value)
    || neo4j.isLocalDateTime(value)
    || neo4j.isTime(value)
    || neo4j.isLocalTime(value)
    || neo4j.isDuration(value)
    || neo4j.isPoint(value)
  ) {
    return value.toString()
  }

  if (value instanceof Uint8Array) {
    return truncatedValue(Buffer.from(value.subarray(0, 512)).toString('base64'), 'base64', {
      byteLength: value.byteLength,
    })
  }

  if (Array.isArray(value)) return value.map(toCell)
  if (typeof value === 'object') return propertyBag(value as Record<string, unknown>)
  return String(value)
}

/**
 * The cell as it goes into a chunk, with the long-value ceiling applied.
 *
 * Separate from `toCell` because the recursion inside a node's properties must
 * *not* truncate the node itself — only its leaves. Applying the ceiling at the
 * top level once is what keeps a 300-node graph postable while leaving each
 * node's own shape intact.
 */
export function toChunkCell(value: unknown): unknown {
  const cell = toCell(value)
  if (typeof cell === 'string' && cell.length > MAX_PROPERTY_CHARS) {
    return truncatedValue(cell.slice(0, MAX_PROPERTY_CHARS), 'utf8', {
      byteLength: Buffer.byteLength(cell, 'utf8'),
    })
  }
  return cell
}

/**
 * The logical type for a column, guessed from the first non-null value.
 *
 * A guess, and unavoidably so: Cypher has no result metadata to read a type off.
 * The chunk protocol pins `schema` to frame 0, so this is decided once from the
 * first row and then holds for the whole result — which is why the fallback is
 * `unknown` rather than `string`. A column that starts null and turns into
 * numbers is displayed as unknown, not mislabelled.
 */
export function logicalTypeOf(value: unknown): LogicalType {
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) return 'array'
  return 'json'
}
