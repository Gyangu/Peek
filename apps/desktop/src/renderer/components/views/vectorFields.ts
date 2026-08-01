import type { NamespaceNode } from '@peek/core'

/* ==================================================================
 * The non-visual half of the vector search view.
 *
 * Two problems live here, both of them about turning what a human can type into
 * what `VectorSearchRequest` accepts:
 *
 *   - a **point id** is `string | number` in the contract, and the difference is
 *     not cosmetic: a store whose ids are integers rejects `"42"`, and one whose
 *     ids are UUIDs rejects the number. The text box cannot tell them apart, so
 *     the rule has to be written down once;
 *   - a **named vector** has to be chosen before a multi-vector collection can be
 *     searched at all, and the only place the names exist in the renderer is the
 *     namespace tree the user may or may not have expanded.
 *
 * Pure, so both rules can be pinned down without a DOM.
 * ================================================================== */

/**
 * A point id as the driver wants it, or null when the box is empty.
 *
 * Digits become a number, everything else stays a string. That is a guess, but
 * it is the guess that matches how the stores actually assign ids (a bare
 * integer or a UUID, never a decimal-looking string), and it is made in one
 * place instead of in the component and again in a future MCP tool.
 *
 * Leading zeros and oversized values deliberately stay strings: `007` and a
 * value past `Number.MAX_SAFE_INTEGER` do not survive the round trip through a
 * JS number, and quietly changing the id is worse than sending it verbatim.
 */
export function parsePointId(raw: string): string | number | null {
  const text = raw.trim()
  if (text === '') return null
  if (!/^\d+$/.test(text)) return text
  if (text.length > 1 && text.startsWith('0')) return text
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : text
}

/** A positive integer from a text box, or null when it is blank or nonsense. */
export function parsePositiveInt(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * A score threshold, or null for "no threshold".
 *
 * Zero and negatives are legitimate: a dot-product metric scores freely on both
 * sides of zero, so only a blank box means "do not filter".
 */
export function parseScore(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * The tree node standing for a vector collection, found by what it points at
 * rather than by its id.
 *
 * Node ids are the driver's own path spelling (`collection:products`) and the
 * renderer must not learn to write them — `ref` is the part of the contract that
 * is driver-independent, so the lookup goes through it.
 */
export function findCollectionNodeId(
  nodes: readonly NamespaceNode[],
  collection: string,
): string | null {
  for (const node of nodes) {
    if (node.ref?.kind === 'vectorCollection' && node.ref.collection === collection) return node.id
  }
  return null
}

/**
 * Named vectors declared by the children of a collection node.
 *
 * `meta` is the driver's own dialect and core does not interpret it, so every
 * field is treated as untrusted here: anything that is not a non-empty string is
 * skipped rather than guessed at. An empty result is not an error — it means the
 * tree has not been expanded, or the collection has a single unnamed vector — so
 * the caller offers these as suggestions and never as the only allowed answer.
 */
export function namedVectorsOf(nodes: readonly NamespaceNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    const name = node.meta?.['vectorName']
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}
