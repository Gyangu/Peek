import { z } from 'zod'

/**
 * Branded types.
 *
 * All of them come from zod's `.brand()`, which keeps the schema and the TS type
 * from a single source — the validator *is* the type, so there is no second
 * declaration to drift out of sync.
 *
 * Two ways to turn a bare string into a branded one:
 *   1. Through the schema: `ConnIdSchema.parse(raw)` — mandatory for external input.
 *   2. Through a constructor: `asConnId(raw)` / `newConnId()` — for values already
 *      known to be safe internally.
 */

export const ConnIdSchema = z.string().min(1).brand<'ConnId'>()
export type ConnId = z.infer<typeof ConnIdSchema>

export const ViewIdSchema = z.string().min(1).brand<'ViewId'>()
export type ViewId = z.infer<typeof ViewIdSchema>

export const PanelIdSchema = z.string().min(1).brand<'PanelId'>()
export type PanelId = z.infer<typeof PanelIdSchema>

/** Id of a split node in the tiled layout tree; layout.setRatio addresses splits by it */
export const SplitIdSchema = z.string().min(1).brand<'SplitId'>()
export type SplitId = z.infer<typeof SplitIdSchema>

/** Id of one query's or scan's result set; every chunk in the stream is attributed by it */
export const ResultIdSchema = z.string().min(1).brand<'ResultId'>()
export type ResultId = z.infer<typeof ResultIdSchema>

/**
 * Id of one chat conversation.
 *
 * Deliberately **peek's own id, not the agent's `sessionId`**. The two have
 * different lifetimes: a chat view exists before any agent process has been
 * spawned (so there is no agent session yet), it survives the agent crashing and
 * being respawned, and — once the agent supports resume — one peek conversation
 * may map onto a succession of agent sessions. `ChatViewState.agentSessionId`
 * holds the current agent-side id, and it is nullable for exactly this reason.
 */
export const ChatIdSchema = z.string().min(1).brand<'ChatId'>()
export type ChatId = z.infer<typeof ChatIdSchema>

/** Id of one message inside a conversation (a user turn, or one agent turn). */
export const ChatMessageIdSchema = z.string().min(1).brand<'ChatMessageId'>()
export type ChatMessageId = z.infer<typeof ChatMessageIdSchema>

/** Id of one context attachment staged on a chat view. */
export const AttachmentIdSchema = z.string().min(1).brand<'AttachmentId'>()
export type AttachmentId = z.infer<typeof AttachmentIdSchema>

/* ------------------------------------------------------------------ */
/* Assertion constructors: only for strings already known to be safe    */
/* ------------------------------------------------------------------ */

export const asConnId = (raw: string): ConnId => raw as ConnId
export const asViewId = (raw: string): ViewId => raw as ViewId
export const asPanelId = (raw: string): PanelId => raw as PanelId
export const asSplitId = (raw: string): SplitId => raw as SplitId
export const asResultId = (raw: string): ResultId => raw as ResultId
export const asChatId = (raw: string): ChatId => raw as ChatId
export const asChatMessageId = (raw: string): ChatMessageId => raw as ChatMessageId
export const asAttachmentId = (raw: string): AttachmentId => raw as AttachmentId

/* ------------------------------------------------------------------ */
/* Id generation                                                       */
/* ------------------------------------------------------------------ */

let seq = 0

/**
 * Generate a short, prefixed id. A per-process monotonic counter plus a timestamp
 * plus a random tail, which keeps ids from colliding across processes (main and
 * the driver hosts) too.
 *
 * `crypto.randomUUID` is deliberately avoided: the renderer is not guaranteed to
 * be a secure context under `file://`.
 */
export function makeId(prefix: string): string {
  seq += 1
  const t = Date.now().toString(36)
  const n = seq.toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${t}${n}${r}`
}

export const newConnId = (): ConnId => asConnId(makeId('conn'))
export const newViewId = (): ViewId => asViewId(makeId('view'))
export const newPanelId = (): PanelId => asPanelId(makeId('panel'))
export const newSplitId = (): SplitId => asSplitId(makeId('split'))
export const newResultId = (): ResultId => asResultId(makeId('res'))
export const newChatId = (): ChatId => asChatId(makeId('chat'))
export const newChatMessageId = (): ChatMessageId => asChatMessageId(makeId('msg'))
export const newAttachmentId = (): AttachmentId => asAttachmentId(makeId('att'))
/** Command envelope id — a plain string, deliberately not branded */
export const newCommandId = (): string => makeId('cmd')
