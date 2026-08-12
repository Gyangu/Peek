import {
  SCAN_COUNT_HINT,
  peekErrorMsg,
  type CollectionRef,
  type KeyPatternRef,
  type NamespaceNode,
} from '@peek/core'

/**
 * The redis namespace tree: **db → key prefix → key**.
 *
 * ## Why prefix nodes are an approximation, and must say so
 *
 * Redis has no schema. The only structure a keyspace has is the convention of
 * colon-delimited prefixes (`user:42:sessions`), and the only way to discover
 * those is to look at the keys — which on a 50-million-key database means a
 * SCAN that never finishes.
 *
 * So a prefix level is built from a **bounded sample**: SCAN a few pages, split
 * each key on the delimiter, group by the first segment. That is honest and
 * fast, but it is a sample, and the UI has to be told: a prefix node's `detail`
 * carries `~n keys (sampled)`, never a bare count that reads as a fact.
 * `PREFIX_SAMPLE_KEYS` is the ceiling; past it, sampling stops and the node set
 * is what it is.
 *
 * Expanding a prefix node does **not** re-sample. It opens a table view scoped
 * to `prefix:*`, which is a real, complete, cursor-driven scan. The tree is for
 * orientation; the scan is for truth.
 */

/** Default delimiter for prefix grouping; redis convention, not a rule of the database */
export const KEY_DELIMITER = ':'

/**
 * Escape the glob metacharacters SCAN's MATCH understands.
 *
 * A prefix is a literal fragment of a key, and keys are arbitrary byte strings —
 * a key named `report[2024]:*` is legal. Interpolating it into MATCH unescaped
 * turns it into a pattern, and the node then lists keys that are not under it.
 * Redis's glob accepts a backslash escape for every metacharacter, so escaping is
 * both possible and cheap.
 */
export function globEscape(literal: string): string {
  return literal.replace(/[\\*?[\]^]/g, (ch) => `\\${ch}`)
}

/** Ceiling on the keys sampled to derive one level of prefix nodes */
export const PREFIX_SAMPLE_KEYS = 2_000

/** Prefix groups shown at one level; past this the tail is folded into an "others" node */
export const MAX_PREFIX_NODES = 200

/* ------------------------------------------------------------------ */
/* Node id encoding                                                    */
/* ------------------------------------------------------------------ */

/**
 * Node ids look like 'db:0' / 'prefix:0:user' / 'key:0:user:42'.
 *
 * A key may contain absolutely any byte, ':' very much included, so the last
 * segment is **not** escaped: it is everything after the third separator, taken
 * verbatim. Only the fixed-width leading segments are parsed. Escaping the key
 * instead would mean a lossy round trip the first time someone stores a key
 * containing the escape character.
 */
export const keyspaceNodeId = {
  database: (db: number): string => `db:${db}`,
  prefix: (db: number, prefix: string): string => `prefix:${db}:${prefix}`,
  key: (db: number, key: string): string => `key:${db}:${key}`,
}

export type ParsedKeyspaceNodeId =
  | { kind: 'database'; db: number }
  | { kind: 'prefix'; db: number; prefix: string }
  | { kind: 'key'; db: number; key: string }
  | { kind: 'unknown' }

export function parseKeyspaceNodeId(id: string): ParsedKeyspaceNodeId {
  const first = id.indexOf(':')
  if (first < 0) return { kind: 'unknown' }
  const tag = id.slice(0, first)
  const rest = id.slice(first + 1)

  if (tag === 'db') {
    const db = Number(rest)
    return Number.isInteger(db) && db >= 0 ? { kind: 'database', db } : { kind: 'unknown' }
  }
  const second = rest.indexOf(':')
  if (second < 0) return { kind: 'unknown' }
  const db = Number(rest.slice(0, second))
  if (!Number.isInteger(db) || db < 0) return { kind: 'unknown' }
  const tail = rest.slice(second + 1)
  if (tag === 'prefix') return { kind: 'prefix', db, prefix: tail }
  if (tag === 'key') return { kind: 'key', db, key: tail }
  return { kind: 'unknown' }
}

/**
 * Split a key into its first prefix segment and the remainder.
 * `user:42:sessions` → `{ head: 'user', rest: '42:sessions' }`;
 * a key with no delimiter has no head, and belongs at the level it was found.
 */
export function splitKeyPrefix(
  key: string,
  delimiter: string = KEY_DELIMITER,
  base = '',
): { head: string; rest: string } | null {
  const tail = base.length > 0 ? key.slice(base.length) : key
  const at = tail.indexOf(delimiter)
  if (at < 0) return null
  return { head: tail.slice(0, at), rest: tail.slice(at + delimiter.length) }
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

export interface KeyspaceDeps {
  /** SCAN one page; returns the next cursor ('0' when the iteration completed) */
  scanPage(db: number, cursor: string, match: string, count: number): Promise<{
    cursor: string
    keys: string[]
  }>
  /** Key count per logical database, from INFO keyspace */
  keyCounts(): Promise<ReadonlyMap<number, number>>
  /** How many logical databases the server exposes (CONFIG GET databases, default 16) */
  databaseCount(): Promise<number>
  /**
   * TYPE for a bounded set of keys, pipelined; a key that vanished mid-listing is
   * simply absent from the map rather than failing the level.
   */
  keyTypes?(db: number, keys: readonly string[]): Promise<ReadonlyMap<string, string>>
  /** The db the connection itself is attached to; always shown at the root, even when empty */
  defaultDb?: number
}

/** One level's sample, before it is turned into nodes */
interface PrefixSample {
  /** first segment below `base` → how many sampled keys fell under it */
  groups: Map<string, number>
  /** keys that have no further delimiter below `base` */
  leaves: string[]
  /** The SCAN did not reach the end, so every count is a lower bound on a sample */
  partial: boolean
}

/** Dimmed right-hand text on a tree node. English on purpose: MCP reads `detail` too. */
function formatKeyCount(n: number, partial: boolean): string {
  const unit = n === 1 ? 'key' : 'keys'
  return partial ? `~${n} ${unit} (sampled)` : `${n} ${unit}`
}

export class RedisKeyspace {
  private readonly deps: KeyspaceDeps

  constructor(deps: KeyspaceDeps) {
    this.deps = deps
  }

  /**
   * One level of the tree.
   *
   * - `null`     → one node per logical database that holds keys (plus db0 always,
   *               so a fresh empty server still shows something to click)
   * - `db:N`     → the prefix groups sampled from that database
   * - `prefix:…` → deeper prefix groups, plus the keys that stop at this level
   * - `key:…`    → a leaf, always `[]`
   *
   * Every node whose `ref` is set can be opened as a table view; for redis that
   * ref is a `KeyPatternRef` with the pattern that node stands for.
   */
  async listChildren(parentId: string | null): Promise<NamespaceNode[]> {
    if (parentId === null) return this.databaseNodes()
    const parsed = parseKeyspaceNodeId(parentId)
    switch (parsed.kind) {
      case 'database':
        return this.levelNodes(parsed.db, '')
      case 'prefix':
        return this.levelNodes(parsed.db, parsed.prefix + KEY_DELIMITER)
      case 'key':
        // A key is a leaf: its contents come from getValue, not from the tree
        return []
      case 'unknown':
        throw peekErrorMsg('BAD_REQUEST', 'error.introspect.unknownNodeId', { nodeId: parentId })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Root: logical databases                                           */
  /* ---------------------------------------------------------------- */

  private async databaseNodes(): Promise<NamespaceNode[]> {
    const [counts, total] = await Promise.all([
      this.deps.keyCounts(),
      this.deps.databaseCount(),
    ])
    const defaultDb = this.deps.defaultDb ?? 0
    // Empty databases are noise on a 16-database server; the ones worth a node are
    // the ones holding keys, plus the one this connection is actually attached to.
    const shown = new Set<number>([defaultDb, ...counts.keys()])
    return [...shown]
      .filter((db) => db >= 0 && (db < total || db === defaultDb))
      .sort((a, b) => a - b)
      .map((db) => {
        const count = counts.get(db) ?? 0
        return {
          id: keyspaceNodeId.database(db),
          name: `db${db}`,
          kind: 'keyspace' as const,
          hasChildren: count > 0,
          ref: { kind: 'keyPattern', pattern: '*', db } satisfies KeyPatternRef,
          detail: formatKeyCount(count, false),
          meta: { db },
        }
      })
  }

  /* ---------------------------------------------------------------- */
  /* One prefix level                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Sample `base*` and group the keys one segment deeper.
   *
   * `base` is '' at the database level and 'user:' under `prefix:0:user`. The
   * SCAN stops at PREFIX_SAMPLE_KEYS, which is what makes this bounded on a
   * keyspace no one would dare walk in full.
   */
  private async sampleLevel(db: number, base: string): Promise<PrefixSample> {
    const match = base.length > 0 ? `${globEscape(base)}*` : '*'
    const groups = new Map<string, number>()
    const leaves: string[] = []
    let cursor = '0'
    let scanned = 0
    do {
      const page = await this.deps.scanPage(db, cursor, match, SCAN_COUNT_HINT)
      cursor = page.cursor
      for (const key of page.keys) {
        scanned += 1
        const split = splitKeyPrefix(key, KEY_DELIMITER, base)
        if (split === null) {
          // No further delimiter: the key itself lives at this level
          if (leaves.length <= MAX_PREFIX_NODES) leaves.push(key)
        } else {
          groups.set(split.head, (groups.get(split.head) ?? 0) + 1)
        }
      }
    } while (cursor !== '0' && scanned < PREFIX_SAMPLE_KEYS)
    return { groups, leaves, partial: cursor !== '0' }
  }

  private async levelNodes(db: number, base: string): Promise<NamespaceNode[]> {
    const sample = await this.sampleLevel(db, base)
    const nodes: NamespaceNode[] = []

    const heads = [...sample.groups.keys()].sort()
    const shownHeads = heads.slice(0, MAX_PREFIX_NODES)
    for (const head of shownHeads) {
      const prefix = base + head
      nodes.push({
        id: keyspaceNodeId.prefix(db, prefix),
        name: head,
        kind: 'keyPrefix',
        hasChildren: true,
        ref: {
          kind: 'keyPattern',
          pattern: `${globEscape(prefix + KEY_DELIMITER)}*`,
          db,
        } satisfies KeyPatternRef,
        detail: formatKeyCount(sample.groups.get(head) ?? 0, sample.partial),
        meta: { db, prefix },
      })
    }
    if (heads.length > shownHeads.length) {
      nodes.push(foldedNode(
        `${keyspaceNodeId.prefix(db, base)}#more-prefixes`,
        `${heads.length - shownHeads.length} more prefixes`,
      ))
    }

    const leafKeys = sample.leaves.slice(0, MAX_PREFIX_NODES)
    const types = await this.typesOf(db, leafKeys)
    for (const key of leafKeys) {
      const type = types.get(key)
      const node: NamespaceNode = {
        id: keyspaceNodeId.key(db, key),
        name: key.slice(base.length),
        kind: 'key',
        hasChildren: false,
        ref: { kind: 'keyPattern', pattern: globEscape(key), db } satisfies KeyPatternRef,
        meta: { db, key, ...(type === undefined ? {} : { type }) },
      }
      if (type !== undefined) node.detail = type
      nodes.push(node)
    }
    if (sample.leaves.length > leafKeys.length) {
      nodes.push(foldedNode(
        `${keyspaceNodeId.prefix(db, base)}#more-keys`,
        'more keys (open the prefix as a table to scan them all)',
      ))
    }

    return nodes
  }

  private async typesOf(db: number, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (keys.length === 0 || !this.deps.keyTypes) return new Map()
    try {
      return await this.deps.keyTypes(db, keys)
    } catch {
      // A missing type dims one line of the tree; it must not fail the level
      return new Map()
    }
  }

  /** The ref has to be a key pattern; the others belong to other drivers. */
  static requireKeyPattern(ref: CollectionRef): KeyPatternRef {
    if (ref.kind !== 'keyPattern') {
      throw peekErrorMsg('BAD_REQUEST', 'error.collection.kindUnsupported', {
        driverId: 'redis',
        kind: ref.kind,
      })
    }
    return ref
  }
}

/**
 * The tail of an over-long level.
 *
 * Deliberately has no `ref`: there is no single pattern that stands for "the
 * prefixes I did not show", and inventing one would open a table view whose
 * contents do not match its label.
 */
function foldedNode(id: string, detail: string): NamespaceNode {
  return { id, name: '…', kind: 'folder', hasChildren: false, detail }
}
