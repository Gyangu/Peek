/**
 * Context building: turning what the user is looking at into what the model reads.
 *
 * This is the capability that separates peek's chat panel from a general-purpose
 * chat client — the model is not being told about the data, it is being handed
 * it, in the form measurements showed it reads most accurately (`serialize.ts`),
 * within a budget it is told about when it binds (`budget.ts`).
 *
 * Typical use from the ACP host, at send time:
 *
 * ```ts
 * const resolved = await resolveAttachments(view.attachments, { source })
 * const { blocks, store: staged } = buildPromptBlocks(userText, resolved, {
 *   embeddedContext: caps.promptCapabilities?.embeddedContext === true,
 *   fetchToolName: 'mcp__peek__read_attachment',
 * })
 * for (const entry of staged) store.put(entry)
 * await conn.prompt({ sessionId, prompt: blocks })
 * ```
 */

export {
  DEFAULT_CONTEXT_BUDGET,
  clampValue,
  describeTruncation,
  estimateTokens,
  planRowFit,
  type ContextBudget,
  type RowFitPlan,
  type TruncationNotice,
  type TruncationReason,
} from './budget'

export {
  CSV_CONVENTION,
  NULL_SENTINEL,
  TRUNCATION_MARK,
  columnLegend,
  csvField,
  csvHeader,
  renderCsv,
  renderDocument,
  renderSchema,
  summarizeVector,
  type DocumentParts,
  type TabularBody,
} from './serialize'

export {
  buildAttachmentReceipts,
  defaultAttachmentLabel,
  resolveAttachment,
  resolveAttachments,
  summarizeIndexes,
  type AttachmentOutcome,
  type ResolveOptions,
  type ResolvedAttachment,
} from './resolve'

export { buildPromptBlocks, toContentBlock, type BlockOptions, type PeekContentBlock } from './blocks'

export {
  DEFAULT_PAGE_CHARS,
  createAttachmentStore,
  type AttachmentPage,
  type AttachmentStore,
  type AttachmentStoreOptions,
  type StoredAttachment,
} from './store'

export { PEEK_URI_SCHEME, queryUri, resultCellUri, resultRowsUri, schemaUri, workspaceUri } from './uri'

export type { ContextSource, ReadResultRowsRequest, TabularSlice } from './types'
