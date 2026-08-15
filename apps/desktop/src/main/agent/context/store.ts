/**
 * The on-demand half of an attachment.
 *
 * ## Why `resource_link` is not the answer, and what is
 *
 * ACP offers two ways to attach content: `resource` (inline) and `resource_link`
 * (a URI the agent fetches). The obvious design for "large data" is a link — and
 * it does not work. The agent is a separate process; it has no route into peek's
 * memory, `peek://` is not a scheme anything can resolve, and peek deliberately
 * declares `fs.readTextFile: false`. A `resource_link` reaches the agent as a URI
 * it can only look at. The spike confirmed this: an embedded `resource` was read
 * correctly, a link would have been inert.
 *
 * But there *is* a channel from the agent back into peek, and it is already
 * proven end to end: **peek's own MCP server**. The agent calls
 * `mcp__peek__read_workspace` today over HTTP with a bearer token. A tool that
 * reads a staged attachment travels the exact same path.
 *
 * So "large data on demand" is implemented as:
 *
 * 1. the prompt carries an embedded `resource` with the **head** of the data plus
 *    an explicit instruction naming the URI and the tool to call for the rest;
 * 2. the full text sits here, addressed by that URI;
 * 3. an MCP tool reads it back a page at a time.
 *
 * This is strictly better than a link even if links did work: it is one
 * mechanism, it is the mechanism the closed loop already uses, and the model
 * decides whether the rest is worth fetching instead of paying for it up front.
 *
 * ## Why entries expire
 *
 * A staged attachment is resolved at send time and is interesting for exactly one
 * turn. Keeping every attachment a user ever sent would grow without bound in the
 * one process that must not — main. Entries are therefore capped in count and in
 * bytes, evicted oldest-first, and a URI whose entry is gone reads as "no longer
 * available" rather than as empty content.
 */

import { peekError, type PeekError } from '@peek/core'

export interface StoredAttachment {
  uri: string
  mimeType: string
  text: string
  storedAt: number
}

export interface AttachmentPage {
  uri: string
  mimeType: string
  /** The requested slice of `text`. */
  text: string
  /** Character offset this page starts at. */
  offset: number
  /** Total characters in the stored document. */
  totalChars: number
  /** More text follows this page. */
  hasMore: boolean
}

export interface AttachmentStoreOptions {
  /** Documents retained. Oldest are evicted first. */
  maxEntries?: number
  /** Total characters retained across all documents. */
  maxChars?: number
  /** Injectable for tests. */
  now?: () => number
}

export interface AttachmentStore {
  /** Stage a document under its URI. Re-staging the same URI replaces it. */
  put(entry: { uri: string; mimeType: string; text: string }): void
  /** Read a page. Returns a `PeekError` when the URI is unknown or has been evicted. */
  read(req: { uri: string; offset?: number; limit?: number }): AttachmentPage | PeekError
  /** Everything currently readable, newest first — for a "what can I fetch" tool listing. */
  list(): readonly Omit<StoredAttachment, 'text'>[]
  clear(): void
}

const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_MAX_CHARS = 8 * 1024 * 1024
/** Characters per `read` when the caller does not say. ~8k tokens of CSV. */
export const DEFAULT_PAGE_CHARS = 24_000

export function createAttachmentStore(options: AttachmentStoreOptions = {}): AttachmentStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const now = options.now ?? Date.now
  // Insertion order is eviction order, which a Map gives for free.
  const entries = new Map<string, StoredAttachment>()
  let totalChars = 0

  const evict = (): void => {
    for (const [uri, entry] of entries) {
      if (entries.size <= maxEntries && totalChars <= maxChars) return
      entries.delete(uri)
      totalChars -= entry.text.length
    }
  }

  return {
    put(entry) {
      const existing = entries.get(entry.uri)
      if (existing) {
        entries.delete(entry.uri)
        totalChars -= existing.text.length
      }
      entries.set(entry.uri, { ...entry, storedAt: now() })
      totalChars += entry.text.length
      evict()
    },

    read(req) {
      const entry = entries.get(req.uri)
      if (!entry) {
        return peekError(
          'NOT_FOUND',
          `No attachment is staged at ${req.uri}. It was never attached, or it has since been ` +
            'released — peek keeps only the most recent attachments. Ask the user to attach it again.',
        )
      }
      const offset = Math.max(0, Math.trunc(req.offset ?? 0))
      const limit = Math.max(1, Math.trunc(req.limit ?? DEFAULT_PAGE_CHARS))
      const text = entry.text.slice(offset, offset + limit)
      return {
        uri: entry.uri,
        mimeType: entry.mimeType,
        text,
        offset,
        totalChars: entry.text.length,
        hasMore: offset + text.length < entry.text.length,
      }
    },

    list() {
      return [...entries.values()]
        .sort((a, b) => b.storedAt - a.storedAt)
        .map(({ uri, mimeType, storedAt }) => ({ uri, mimeType, storedAt }))
    },

    clear() {
      entries.clear()
      totalChars = 0
    },
  }
}
