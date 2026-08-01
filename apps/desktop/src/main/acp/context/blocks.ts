/**
 * Resolved attachments → ACP `ContentBlock`s.
 *
 * The last step before `prompt()`. Three rules, each of them measured or read off
 * the wire rather than assumed:
 *
 * 1. **Embedded, not linked.** `resource_link` cannot be dereferenced by an agent
 *    in another process (see `store.ts`), so every attachment is an embedded
 *    `resource`. The `ContentBlock` shape is the one the spike verified against
 *    the live agent: `{ type: 'resource', resource: { uri, mimeType, text } }`.
 * 2. **Check `promptCapabilities.embeddedContext` first.** It is `true` on
 *    `claude-agent-acp` 0.64.0, but it is advertised for a reason. When it is
 *    absent the attachment degrades to a `text` block rather than being dropped —
 *    the content still reaches the model, it just costs the block's framing.
 * 3. **Large attachments hand off to MCP.** Past a threshold the prompt carries
 *    the head of the document plus an instruction naming the URI and the tool
 *    that serves the rest. The alternative — inlining everything — spends the
 *    user's context window on data the model may not need, and the alternative to
 *    *that* — a bare link — reaches an agent that cannot follow it.
 */

import type { ResolvedAttachment } from './resolve'
import { estimateTokens } from './budget'

/**
 * The subset of ACP's `ContentBlock` peek emits.
 *
 * Declared structurally instead of imported from `@agentclientprotocol/sdk`: this
 * module is pure and unit-tested, and pulling the SDK in to name three object
 * shapes would make every test load a protocol implementation to check string
 * formatting. The shapes are verified against the live agent, and the ACP host
 * passes them straight into `prompt()`, where the SDK's own types check them.
 */
export type PeekContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'resource'
      resource: { uri: string; mimeType: string; text: string }
    }

export interface BlockOptions {
  /**
   * `agentCapabilities.promptCapabilities.embeddedContext` from `initialize`.
   * When false, attachments become plain text blocks.
   */
  embeddedContext: boolean
  /**
   * Past this many estimated tokens an attachment is sent as a head plus a
   * fetch instruction instead of in full.
   *
   * Default 3,000 — roughly 200 rows of ordinary CSV. Below it, inlining is
   * cheaper than the round trip the model would otherwise make; above it, the
   * model should get to decide.
   */
  inlineTokenLimit?: number
  /**
   * Name of the MCP tool that serves `store.ts`, as the agent sees it —
   * `mcp__<serverName>__<toolName>`. Omitted means no such tool is registered,
   * and large attachments are inlined in full rather than pointing at something
   * that does not exist.
   */
  fetchToolName?: string
}

const DEFAULT_INLINE_TOKEN_LIMIT = 3_000

/**
 * How much of an over-limit document to inline before the hand-off note.
 *
 * A head, not nothing: the model needs enough to know whether fetching the rest
 * is worth a tool call, and a header plus the first rows answers most questions
 * outright. The value is in characters because that is what a document is
 * measured in here; ~3 characters per token makes this ≈2,600 tokens.
 */
const HEAD_CHARS = 8_000

/**
 * Turn one resolved attachment into a block, and say what should be staged in the
 * attachment store.
 *
 * Returns the store entry alongside the block rather than writing to the store
 * itself, so this function stays pure and the ACP host keeps a single place where
 * staging happens.
 */
export function toContentBlock(
  attachment: ResolvedAttachment,
  options: BlockOptions,
): { block: PeekContentBlock; store?: { uri: string; mimeType: string; text: string } } {
  const limit = options.inlineTokenLimit ?? DEFAULT_INLINE_TOKEN_LIMIT
  const oversized =
    attachment.estimatedTokens > limit
    && options.fetchToolName !== undefined
    && attachment.error === undefined

  const text = oversized ? withFetchInstruction(attachment, options.fetchToolName ?? '') : attachment.text

  const block: PeekContentBlock = options.embeddedContext
    ? { type: 'resource', resource: { uri: attachment.uri, mimeType: attachment.mimeType, text } }
    : // Without embedded context the URI has to travel in the prose, or the model
      // cannot name what it is being asked about.
      { type: 'text', text: `<<attachment ${attachment.uri}>>\n${text}` }

  // Always stage the full document, oversized or not: the model may call the
  // fetch tool for an attachment that fitted inline, and answering "not found"
  // for something it was just shown is the kind of inconsistency that makes a
  // model stop trusting a tool.
  return {
    block,
    store: { uri: attachment.uri, mimeType: attachment.mimeType, text: attachment.text },
  }
}

/**
 * The head of a document plus the instruction for getting the rest.
 *
 * The cut is on a line boundary, and the note states the character offset to
 * resume from — a model told "there is more" without being told *where* will
 * re-fetch from zero.
 */
function withFetchInstruction(attachment: ResolvedAttachment, toolName: string): string {
  const head = cutOnLine(attachment.text, HEAD_CHARS)
  const remaining = attachment.text.length - head.length
  return (
    `${head}\n\n`
    + `> **Truncated for the prompt.** This is the first ${head.length.toLocaleString('en-US')} of `
    + `${attachment.text.length.toLocaleString('en-US')} characters `
    + `(~${estimateTokens(attachment.text).toLocaleString('en-US')} tokens in full). `
    + `The remaining ${remaining.toLocaleString('en-US')} characters are available on demand: call `
    + `\`${toolName}\` with uri="${attachment.uri}" and offset=${head.length}. `
    + 'Fetch it only if the head does not answer the question.'
  )
}

function cutOnLine(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const nl = slice.lastIndexOf('\n')
  // Only honour the line boundary if it does not throw away most of the head.
  return nl > max * 0.5 ? slice.slice(0, nl) : slice
}

/**
 * Build the full prompt: the user's own text, then one block per attachment.
 *
 * Attachments come **after** the user's message. Instruction-then-evidence is how
 * the same content was verified to work in the spike, and it keeps the thing the
 * user actually typed from being buried under 8,000 characters of CSV.
 */
export function buildPromptBlocks(
  userText: string,
  attachments: readonly ResolvedAttachment[],
  options: BlockOptions,
): { blocks: PeekContentBlock[]; store: { uri: string; mimeType: string; text: string }[] } {
  const blocks: PeekContentBlock[] = []
  const store: { uri: string; mimeType: string; text: string }[] = []
  if (userText.length > 0) blocks.push({ type: 'text', text: userText })
  for (const a of attachments) {
    const built = toContentBlock(a, options)
    blocks.push(built.block)
    if (built.store) store.push(built.store)
  }
  return { blocks, store }
}
