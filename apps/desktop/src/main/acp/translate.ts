/**
 * ACP `SessionUpdate` → peek `ChatDelta` + control-plane patch.
 *
 * Pure, synchronous and free of I/O: it owns the per-session transcript
 * bookkeeping and nothing else, which is what makes the streaming path testable
 * against recorded notification shapes instead of against a live agent.
 *
 * ## What the agent sends, and what has to be defended against
 *
 * Every shape below came out of real captures, and each one has a trap in it:
 *
 *  - `content` on a chunk is a **single `ContentBlock`, not an array**, and it
 *    arrives in fragments of one character to a few dozen. The renderer must
 *    re-parse Markdown from the accumulated string, never per fragment, which is
 *    why deltas carry raw text and no structure.
 *  - `tool_call` always arrives `status: "pending"` with `rawInput: {}`, and the
 *    arguments stream in through later `tool_call_update`s. Each update is a
 *    **whole replacement of `rawInput`, not a merge**.
 *  - a `tool_call_update` frequently omits `title` and `kind`. Records are merged
 *    by `toolCallId` onto what is already known; replacing wholesale loses the
 *    title and leaves an unlabelled row in the UI.
 *  - `rawOutput` can be an **array** (an MCP tool's content blocks). It is typed
 *    `unknown` end to end, and the older ACP SDK typing it as a record is exactly
 *    what made completion notifications vanish.
 *  - `agent_thought_chunk` is implemented and almost never seen: current models
 *    default thinking to omitted and stream signature-only blocks. The path
 *    exists; no layout depends on it arriving.
 *
 * ## Untrusted input
 *
 * Everything here is agent output, i.e. untrusted data. It is copied into
 * transcript text and never interpreted: no field selects a code path by value
 * beyond a fixed enum check, and text that reaches a Workspace field (the
 * preview) is sanitised. Text inside the transcript is left byte-exact, because
 * it is Markdown the user asked for and the renderer displays it as content.
 */

import {
  newChatMessageId,
  type ChatAttachmentReceipt,
  type ChatDelta,
  type ChatId,
  type ChatMessage,
  type ChatMessageId,
  type ChatUsage,
  type PeekError,
  type ToolCallContent,
  type ToolCallKind,
  type ToolCallRecord,
  type ToolCallStatus,
} from '@peek/core'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { sanitizeLine } from './errors'
import type { ChatAgentStatePatch } from './types'

/** Control-plane fields a translation may move. `chatId` is added by the caller. */
export type ChatStateDelta = Omit<ChatAgentStatePatch, 'chatId'>

export interface TranslationOutput {
  deltas: ChatDelta[]
  state: ChatStateDelta
  /** Set when the update is one peek knowingly does not render. Diagnostics only. */
  ignored?: string
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolCallKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
])

const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolCallStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed',
])

const PREVIEW_LEN = 200

function toToolKind(raw: unknown): ToolCallKind {
  return typeof raw === 'string' && TOOL_KINDS.has(raw) ? (raw as ToolCallKind) : 'other'
}

function toToolStatus(raw: unknown, fallback: ToolCallStatus): ToolCallStatus {
  return typeof raw === 'string' && TOOL_STATUSES.has(raw) ? (raw as ToolCallStatus) : fallback
}

function isTerminal(status: ToolCallStatus): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * Flatten one ACP content block down to the text peek renders.
 *
 * Images and audio are acknowledged with a placeholder rather than dropped: a
 * silent omission makes a reply look truncated, and the fact that the agent sent
 * a picture is itself information.
 */
function contentBlockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const record = block as Record<string, unknown>
  const type = record['type']
  if (type === 'text') return typeof record['text'] === 'string' ? record['text'] : ''
  if (type === 'image') return '[image]'
  if (type === 'audio') return '[audio]'
  if (type === 'resource_link') {
    const name = typeof record['name'] === 'string' ? record['name'] : 'resource'
    return `[${name}]`
  }
  if (type === 'resource') {
    const resource = record['resource']
    if (typeof resource === 'object' && resource !== null) {
      const text = (resource as Record<string, unknown>)['text']
      if (typeof text === 'string') return text
    }
    return '[resource]'
  }
  return ''
}

/** ACP `ToolCallContent[]` → the two shapes peek's contract renders. */
function toToolContent(raw: unknown): ToolCallContent[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCallContent[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (record['type'] === 'content') {
      const text = contentBlockText(record['content'])
      if (text) out.push({ type: 'text', text })
      continue
    }
    if (record['type'] === 'diff') {
      const path = typeof record['path'] === 'string' ? record['path'] : ''
      const newText = typeof record['newText'] === 'string' ? record['newText'] : ''
      const oldRaw = record['oldText']
      out.push({ type: 'diff', path, oldText: typeof oldRaw === 'string' ? oldRaw : null, newText })
      continue
    }
    if (record['type'] === 'terminal') {
      const id = typeof record['terminalId'] === 'string' ? record['terminalId'] : 'terminal'
      // peek declares no terminal capability, so this should never arrive. If it
      // does, say so instead of rendering an empty tool row.
      out.push({ type: 'text', text: `[terminal ${id} — not supported in peek]` })
    }
  }
  return out
}

/**
 * Per-session transcript bookkeeping.
 *
 * One instance per chat. It owns the message ids peek assigns (the agent's own
 * `messageId` is advisory and often absent), the running message count, and the
 * accumulating tool-call records.
 */
export class TranscriptTranslator {
  #currentMessageId: ChatMessageId | null = null
  /** The agent's `messageId` for the open message; a change means a new message. */
  #currentAcpMessageId: string | null = null
  #currentText = ''
  #messageCount = 0
  #tools = new Map<string, ToolCallRecord>()

  readonly chatId: ChatId
  readonly #now: () => number

  constructor(chatId: ChatId, now: () => number = Date.now) {
    this.chatId = chatId
    this.#now = now
  }

  get streamingMessageId(): ChatMessageId | null {
    return this.#currentMessageId
  }

  get messageCount(): number {
    return this.#messageCount
  }

  /** Drop everything. Mirrors the `reset` delta a cleared conversation emits. */
  reset(): TranslationOutput {
    this.#currentMessageId = null
    this.#currentAcpMessageId = null
    this.#currentText = ''
    this.#messageCount = 0
    this.#tools.clear()
    return {
      deltas: [{ type: 'reset', chatId: this.chatId }],
      state: { streamingMessageId: null, messageCount: 0 },
    }
  }

  /**
   * Record the user's turn.
   *
   * The user message is complete the instant it is created, so it opens and
   * closes in one output. Attachments are recorded as descriptors for re-display;
   * their materialised Markdown goes to the agent and is not duplicated into the
   * transcript, which would double the memory for no gain in what is shown.
   *
   * `receipts` is the exception to that, and a small one: only what was *left
   * out*, so the transcript can tell the user "first 100 of 12,345 rows" instead
   * of leaving them to assume they sent everything.
   */
  appendUserMessage(
    text: string,
    attachments: ChatMessage['attachments'],
    receipts?: readonly ChatAttachmentReceipt[],
  ): TranslationOutput {
    const id = newChatMessageId()
    const message: ChatMessage = {
      id,
      role: 'user',
      blocks: text ? [{ type: 'text', text }] : [],
      createdAt: this.#now(),
      complete: true,
      stopReason: 'end_turn',
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(receipts && receipts.length > 0 ? { attachmentReceipts: [...receipts] } : {}),
    }
    this.#messageCount += 1
    return {
      deltas: [
        { type: 'message.start', chatId: this.chatId, message },
        { type: 'message.end', chatId: this.chatId, messageId: id, stopReason: 'end_turn' },
      ],
      state: {
        messageCount: this.#messageCount,
        lastMessagePreview: sanitizeLine(text, PREVIEW_LEN),
      },
    }
  }

  /**
   * Translate one notification.
   *
   * Never throws: a shape peek does not know is reported through `ignored`, not
   * raised. An agent is free to add update kinds, and an unrecognised one must
   * not take down a conversation that is otherwise working.
   */
  handle(update: SessionUpdate): TranslationOutput {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#appendChunk('text.append', contentBlockText(update.content), update.messageId ?? null)
      case 'agent_thought_chunk':
        return this.#appendChunk('thought.append', contentBlockText(update.content), update.messageId ?? null)
      case 'user_message_chunk':
        // The agent echoing the user's own turn back. peek already recorded it
        // when the command ran; replaying it would duplicate the bubble.
        return { deltas: [], state: {}, ignored: 'user_message_chunk' }
      case 'tool_call':
        return this.#toolCall(update)
      case 'tool_call_update':
        return this.#toolCallUpdate(update)
      case 'usage_update':
        return { deltas: [], state: { usage: toUsage(update) } }
      case 'current_mode_update':
        return { deltas: [], state: {}, ignored: 'current_mode_update' }
      default:
        // plan / plan_update / plan_removed / available_commands_update /
        // config_option_update / session_info_update. peek's chat contract has no
        // field for any of them yet; they are named here so adding one is a
        // matter of filling in a branch rather than discovering the notification
        // exists.
        return { deltas: [], state: {}, ignored: update.sessionUpdate }
    }
  }

  /**
   * Close the open agent message.
   *
   * Called when `prompt()` settles — on success, on cancellation and on failure
   * alike. Text that already streamed stays in the transcript and the message is
   * marked interrupted, because a partial answer is still an answer and deleting
   * it would destroy the only trace of what the agent was doing when it died.
   */
  finishTurn(stopReason: NonNullable<ChatMessage['stopReason']>, error?: PeekError): TranslationOutput {
    const messageId = this.#currentMessageId
    if (!messageId) return { deltas: [], state: { streamingMessageId: null } }
    const preview = sanitizeLine(this.#currentText, PREVIEW_LEN)
    this.#currentMessageId = null
    this.#currentAcpMessageId = null
    this.#currentText = ''
    this.#tools.clear()
    return {
      deltas: [
        {
          type: 'message.end',
          chatId: this.chatId,
          messageId,
          stopReason,
          ...(error === undefined ? {} : { error }),
        },
      ],
      state: {
        streamingMessageId: null,
        ...(preview ? { lastMessagePreview: preview } : {}),
      },
    }
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Open an agent message if none is open, or if the agent moved to a new
   * `messageId`.
   *
   * The second case is why the agent's id is tracked at all: within one turn the
   * agent may emit several distinct messages, and collapsing them into one bubble
   * would merge separate answers.
   */
  #ensureMessage(acpMessageId: string | null): ChatDelta[] {
    const sameMessage =
      this.#currentMessageId !== null && (acpMessageId === null || acpMessageId === this.#currentAcpMessageId)
    if (sameMessage) return []

    const deltas: ChatDelta[] = []
    if (this.#currentMessageId !== null) {
      deltas.push({
        type: 'message.end',
        chatId: this.chatId,
        messageId: this.#currentMessageId,
        stopReason: 'end_turn',
      })
    }
    const id = newChatMessageId()
    this.#currentMessageId = id
    this.#currentAcpMessageId = acpMessageId
    this.#currentText = ''
    this.#messageCount += 1
    deltas.push({
      type: 'message.start',
      chatId: this.chatId,
      message: { id, role: 'agent', blocks: [], createdAt: this.#now(), complete: false },
    })
    return deltas
  }

  #appendChunk(type: 'text.append' | 'thought.append', text: string, acpMessageId: string | null): TranslationOutput {
    if (!text) return { deltas: [], state: {} }
    const deltas = this.#ensureMessage(acpMessageId)
    const messageId = this.#currentMessageId
    if (!messageId) return { deltas: [], state: {} }
    if (type === 'text.append') this.#currentText += text
    deltas.push({ type, chatId: this.chatId, messageId, text })
    return {
      deltas,
      state: this.#openedMessageState(deltas),
    }
  }

  #toolCall(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): TranslationOutput {
    const deltas = this.#ensureMessage(null)
    const messageId = this.#currentMessageId
    if (!messageId) return { deltas: [], state: {} }

    const status = toToolStatus(update.status, 'pending')
    const record: ToolCallRecord = {
      toolCallId: update.toolCallId,
      title: update.title || update.toolCallId,
      kind: toToolKind(update.kind),
      status,
      content: toToolContent(update.content),
      startedAt: this.#now(),
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
      ...(isTerminal(status) ? { endedAt: this.#now() } : {}),
    }
    this.#tools.set(record.toolCallId, record)
    deltas.push({ type: 'tool.upsert', chatId: this.chatId, messageId, call: { ...record } })
    return { deltas, state: this.#openedMessageState(deltas) }
  }

  /**
   * Merge an incremental update onto the record we already hold.
   *
   * Fields absent from the update keep their previous value — `title` and `kind`
   * routinely go missing after the first notification — while `rawInput` and
   * `rawOutput` are replaced outright, because the agent streams them as
   * successive complete snapshots rather than as patches.
   */
  #toolCallUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>): TranslationOutput {
    const messageId = this.#currentMessageId
    if (!messageId) {
      // An update for a call whose message is already closed (a late completion
      // after cancellation). Nothing to attach it to; drop it rather than opening
      // a stray empty bubble.
      return { deltas: [], state: {}, ignored: 'tool_call_update after turn end' }
    }

    const previous = this.#tools.get(update.toolCallId)
    const status = toToolStatus(update.status, previous?.status ?? 'in_progress')
    const content = update.content === undefined ? (previous?.content ?? []) : toToolContent(update.content)
    const record: ToolCallRecord = {
      toolCallId: update.toolCallId,
      title: update.title ?? previous?.title ?? update.toolCallId,
      kind: update.kind === undefined ? (previous?.kind ?? 'other') : toToolKind(update.kind),
      status,
      content,
      startedAt: previous?.startedAt ?? this.#now(),
      ...(update.rawInput !== undefined
        ? { rawInput: update.rawInput }
        : previous?.rawInput !== undefined
          ? { rawInput: previous.rawInput }
          : {}),
      ...(update.rawOutput !== undefined
        ? { rawOutput: update.rawOutput }
        : previous?.rawOutput !== undefined
          ? { rawOutput: previous.rawOutput }
          : {}),
      ...(isTerminal(status) ? { endedAt: previous?.endedAt ?? this.#now() } : {}),
    }
    this.#tools.set(record.toolCallId, record)
    return {
      deltas: [{ type: 'tool.upsert', chatId: this.chatId, messageId, call: { ...record } }],
      state: {},
    }
  }

  /** Report `streamingMessageId` / `messageCount` only when a message actually opened. */
  #openedMessageState(deltas: readonly ChatDelta[]): ChatStateDelta {
    const opened = deltas.some((delta) => delta.type === 'message.start')
    if (!opened) return {}
    return { streamingMessageId: this.#currentMessageId, messageCount: this.#messageCount }
  }
}

function toUsage(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>): ChatUsage {
  return {
    used: Number.isFinite(update.used) ? update.used : 0,
    size: Number.isFinite(update.size) ? update.size : 0,
  }
}
