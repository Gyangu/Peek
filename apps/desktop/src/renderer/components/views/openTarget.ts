import type { Capability, ConnId, NamespaceNode, ViewOpenSpec } from '@peek/core'

/* ==================================================================
 * "The user opened this tree node" → which view that means.
 *
 * A pure function, deliberately, because it is the one place where the
 * capability model meets a double-click and it has to be pinned down: a table
 * and a redis key are both leaves of the same tree, and opening the second one
 * as a table would show a one-row scan of the key's *metadata* — the key's name,
 * type and TTL — with no way to reach the value the user actually clicked.
 *
 * The rule is capability-first, not driver-first. Nothing here names redis or
 * qdrant; a future store that reports `keyValue` gets the inspector for free,
 * and a driver that loses the capability degrades to the scan rather than
 * opening a view that cannot fetch.
 * ================================================================== */

/**
 * Metadata a keyValue driver attaches to a leaf node so that it can be addressed
 * as a value rather than as a collection.
 *
 * `NamespaceNode.meta` is typed `Record<string, unknown>` on purpose — it is the
 * driver's own dialect and core does not interpret it — so this reader treats
 * every field as untrusted and returns null rather than guessing.
 */
interface KeyNodeMeta {
  key: string
  db?: number
}

function readKeyMeta(node: NamespaceNode): KeyNodeMeta | null {
  const meta = node.meta
  if (!meta) return null
  const key = meta['key']
  if (typeof key !== 'string' || key === '') return null
  const db = meta['db']
  return { key, ...(typeof db === 'number' && Number.isInteger(db) && db >= 0 ? { db } : {}) }
}

/**
 * The view to open for a node, or null when the node is a container that only
 * expands (a schema, a key prefix, a database).
 *
 * Order matters: a keyValue driver marks its key leaves with a `ref` as well —
 * a single-key SCAN pattern, which is a legitimate thing to browse — so the
 * value reading has to be tried first or every key would open as a scan.
 */
export function openSpecForNode(
  connId: ConnId,
  node: NamespaceNode,
  capabilities: readonly Capability[],
): ViewOpenSpec | null {
  if (node.kind === 'key' && capabilities.includes('keyValue')) {
    const meta = readKeyMeta(node)
    if (meta) {
      return {
        kind: 'inspector',
        connId,
        ref: { kind: 'redisValue', key: meta.key, ...(meta.db === undefined ? {} : { db: meta.db }) },
        title: node.name,
      }
    }
    // A key without usable metadata falls through to the scan below: showing the
    // row is worth more than refusing to open anything.
  }
  if (node.ref) {
    return { kind: 'table', connId, ref: node.ref, title: node.name }
  }
  return null
}

/**
 * Whether a node opens a *vector search* rather than a scan — the "more like
 * this" entry point, which needs a query point and therefore cannot be the
 * result of a plain double-click.
 */
export function canVectorSearchNode(node: NamespaceNode, capabilities: readonly Capability[]): boolean {
  return node.ref?.kind === 'vectorCollection' && capabilities.includes('vectorSearch')
}
