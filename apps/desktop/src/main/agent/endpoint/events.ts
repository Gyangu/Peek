/**
 * `pi-agent-core` events → peek's `ChatDelta` + control-plane patch.
 *
 * The parallel to `acp/translate.ts`, for the other backend. Pure and
 * synchronous for the same reason: it is the only part of the streaming path
 * worth testing exhaustively, and it can only be tested exhaustively if it does
 * no I/O.
 *
 * ## What is different from the ACP side, and what is not
 *
 * **Not** different: the output. Both produce the same `ChatDelta` union, so the
 * renderer, the batcher and the transcript cannot tell which backend answered.
 * That is the whole point of splitting the backends at this line.
 *
 * Different, in ways that matter to the code below:
 *
 *  - **Tool calls arrive as three distinct events** (`tool_execution_start` /
 *    `_update` / `_end`), where ACP sends one `tool_call` plus a stream of
 *    `tool_call_update`s. `ChatDelta`'s `tool.upsert` is a *replacement* keyed by
 *    `toolCallId`, so this module keeps the record it last emitted and re-emits a
 *    whole one each time. `#calls` is that memory and the only state here.
 *  - **Arguments arrive whole.** `pi-ai` accumulates the model's streamed JSON and
 *    hands over parsed arguments, so none of ACP's partial-`rawInput` handling is
 *    needed. Copying it across would be work that protects against nothing.
 *  - **There is no replay.** `session/load` re-streams a whole transcript as live
 *    notifications, which is why the ACP translator has a replay mode. This
 *    backend restores history by reading its own file into `agent.state.messages`,
 *    so nothing is ever replayed through here.
 *
 * ## Untrusted input
 *
 * Everything here is model output, i.e. untrusted data. It is copied into
 * transcript text and never interpreted: no field selects a code path by value,
 * and text that reaches a Workspace field (the preview) is sanitised. Text inside
 * the transcript is left byte-exact, because it is Markdown the user asked for.
 */

import {
  newChatMessageId,
  type ChatDelta,
  type ChatId,
  type ChatMessageId,
  type ToolCallRecord,
  type ToolCallStatus,
} from '@peek/core'
import { sanitizeLine } from '../redact'
import type { ChatStateDelta } from '../../acp/translate'

export interface EndpointTranslation {
  deltas: ChatDelta[]
  state: ChatStateDelta
}

const EMPTY: EndpointTranslation = { deltas: [], state: {} }

/** How much of a message becomes the one-line preview in Workspace. */
const PREVIEW_CHARS = 200

/**
 * The shape this module consumes.
 *
 * Structural rather than imported from `pi-agent-core`: the loop feeds it
 * normalised events, so the translator can be exercised against literals in a
 * test without constructing an `Agent`. The loop is where the library's event
 * union is narrowed to this, and that narrowing is one `switch`.
 */
export type EndpointEvent =
  | { type: 'assistant_start' }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; output: unknown; isError: boolean }
  | { type: 'tool_blocked'; id: string; reason: string }
  | { type: 'turn_end'; stopReason: NonNullable<ChatMessageStop> }

type ChatMessageStop = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'

/**
 * One conversation's streaming state.
 *
 * Per chat, not per turn: `messageCount` and the open assistant message both have
 * to survive from one turn to the next.
 */
export class EndpointTranslator {
  readonly #chatId: ChatId

  /** The assistant message currently being written, if any. */
  #current: ChatMessageId | null = null

  /** Everything emitted for a tool call so far, so an update can replace it whole. */
  readonly #calls = new Map<string, ToolCallRecord>()

  #messageCount = 0

  /** Accumulated text of the open message, for the Workspace preview. */
  #preview = ''

  constructor(chatId: ChatId) {
    this.#chatId = chatId
  }

  /** A user turn peek recorded itself. Keeps `messageCount` honest. */
  countUserMessage(): void {
    this.#messageCount += 1
  }

  translate(event: EndpointEvent, now: number): EndpointTranslation {
    switch (event.type) {
      case 'assistant_start':
        return this.#startMessage(now)
      case 'text':
        return this.#append('text.append', event.text, now)
      case 'thinking':
        return this.#append('thought.append', event.text, now)
      case 'tool_start':
        return this.#toolStart(event, now)
      case 'tool_end':
        return this.#toolEnd(event, now)
      case 'tool_blocked':
        return this.#toolBlocked(event, now)
      case 'turn_end':
        return this.#finish(event.stopReason)
      default:
        return EMPTY
    }
  }

  /**
   * Close the open message from outside the event stream.
   *
   * Used when a turn ends without one — a stream that threw, a cancel, a loop
   * that stopped on its own limit. A transcript left mid-answer reads as a hung
   * agent forever, so every exit path settles it.
   */
  finishTurn(stopReason: NonNullable<ChatMessageStop>): EndpointTranslation {
    return this.#finish(stopReason)
  }

  /** Forget everything. Mirrors `chat.clear`. */
  reset(): EndpointTranslation {
    this.#current = null
    this.#calls.clear()
    this.#messageCount = 0
    this.#preview = ''
    return {
      deltas: [{ type: 'reset', chatId: this.#chatId }],
      state: { messageCount: 0, streamingMessageId: null, lastMessagePreview: '' },
    }
  }

  #startMessage(now: number): EndpointTranslation {
    if (this.#current) return EMPTY
    const id = newChatMessageId()
    this.#current = id
    this.#preview = ''
    this.#messageCount += 1
    return {
      deltas: [
        {
          type: 'message.start',
          chatId: this.#chatId,
          message: { id, role: 'agent', blocks: [], createdAt: now, complete: false },
        },
      ],
      state: { streamingMessageId: id, messageCount: this.#messageCount },
    }
  }

  /**
   * Text or thinking.
   *
   * Opens a message if one is not already open. A model that streams text before
   * any start event is not a protocol violation worth dropping content over — the
   * transcript is what the user reads, and losing the first sentence of an answer
   * to a bookkeeping rule helps nobody.
   */
  #append(type: 'text.append' | 'thought.append', text: string, now: number): EndpointTranslation {
    if (!text) return EMPTY
    const opened = this.#current ? EMPTY : this.#startMessage(now)
    const messageId = this.#current
    if (!messageId) return EMPTY
    // Only prose feeds the preview: a thinking block is not what the row in the
    // sessions rail should be summarising.
    if (type === 'text.append' && this.#preview.length < PREVIEW_CHARS) {
      this.#preview = (this.#preview + text).slice(0, PREVIEW_CHARS)
    }
    return {
      deltas: [...opened.deltas, { type, chatId: this.#chatId, messageId, text }],
      state: {
        ...opened.state,
        ...(type === 'text.append' ? { lastMessagePreview: sanitizeLine(this.#preview, PREVIEW_CHARS) } : {}),
      },
    }
  }

  #toolStart(event: { id: string; name: string; args: unknown }, now: number): EndpointTranslation {
    const opened = this.#current ? EMPTY : this.#startMessage(now)
    const messageId = this.#current
    if (!messageId) return EMPTY
    const record: ToolCallRecord = {
      toolCallId: event.id,
      title: event.name,
      kind: 'other',
      // `pending`, not `in_progress`: the permission gate runs between this event
      // and execution, so what the user sees while deciding must not claim the
      // tool is already running.
      status: 'pending',
      rawInput: event.args,
      content: [],
      startedAt: now,
    }
    this.#calls.set(event.id, record)
    return {
      deltas: [...opened.deltas, { type: 'tool.upsert', chatId: this.#chatId, messageId, call: record }],
      state: opened.state,
    }
  }

  #toolEnd(event: { id: string; output: unknown; isError: boolean }, now: number): EndpointTranslation {
    return this.#settleTool(event.id, event.isError ? 'failed' : 'completed', now, { rawOutput: event.output })
  }

  /**
   * A tool the user refused.
   *
   * `failed` with the reason as output, deliberately: the row has to show that
   * something was asked for and did not happen. A silently dropped call would
   * leave the model's next sentence — "I checked and…" — unexplained.
   */
  #toolBlocked(event: { id: string; reason: string }, now: number): EndpointTranslation {
    return this.#settleTool(event.id, 'failed', now, { rawOutput: event.reason })
  }

  #settleTool(
    id: string,
    status: ToolCallStatus,
    now: number,
    extra: Partial<ToolCallRecord>,
  ): EndpointTranslation {
    const messageId = this.#current
    const existing = this.#calls.get(id)
    if (!messageId || !existing) return EMPTY
    // Replacement, not a merge: `tool.upsert` replaces wholesale, so the record
    // handed over has to carry everything already known about the call.
    const record: ToolCallRecord = { ...existing, ...extra, status, endedAt: now }
    this.#calls.set(id, record)
    return {
      deltas: [{ type: 'tool.upsert', chatId: this.#chatId, messageId, call: record }],
      state: {},
    }
  }

  #finish(stopReason: NonNullable<ChatMessageStop>): EndpointTranslation {
    const messageId = this.#current
    if (!messageId) return { deltas: [], state: { streamingMessageId: null } }
    this.#current = null
    this.#calls.clear()
    return {
      deltas: [{ type: 'message.end', chatId: this.#chatId, messageId, stopReason }],
      state: { streamingMessageId: null },
    }
  }
}
