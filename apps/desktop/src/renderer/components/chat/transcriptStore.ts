import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import type { ChatDelta, ChatId, ChatMessage, ChatMessageId, ChatTranscript } from '@peek/core'
import { tryBridge } from '../../bridge'

/* ==================================================================
 * The transcript **mirror**.
 *
 * The source of truth is main's `ChatId`-keyed store; this holds a projection of
 * the append-only `ChatDelta`s it emits, exactly as `workspaceStore` holds a
 * projection of main's immer patches. No component writes here, and nothing in
 * this file invents a message.
 *
 * ## Why the transcript is not in Workspace at all
 *
 * Recorded in full at the top of `packages/core/src/chat.ts`. The short version:
 * `agent_message_chunk` arrives token by token, and routing that through the
 * Workspace patch pipeline would mean one immer diff and one IPC broadcast per
 * token, with the cost of *every unrelated command* growing as the conversation
 * does. Chat is data plane, like result rows, and takes the same kind of
 * dedicated channel.
 *
 * ## The shape is chosen so streaming does not re-render the list
 *
 * A slice is `{ order, byId }`, not `ChatMessage[]`:
 *
 * - `order` changes **only** when a message is added or removed, so the list
 *   component — which subscribes to `order` alone — does not re-render while
 *   text streams into an existing message;
 * - `byId[id]` gets a fresh object only for the message that actually changed,
 *   so exactly one memoized `MessageItem` re-renders per token batch.
 *
 * With a plain array, appending a token would replace the array and re-render
 * every row in the transcript. That is the difference between a chat that stays
 * smooth at a thousand messages and one that does not.
 *
 * ## Batching
 *
 * `chat.ts` asks main to coalesce deltas on a time/size budget before they cross
 * IPC. That is main's job and this file does not assume it was done: deltas are
 * queued here and flushed once per animation frame, with runs of `text.append`
 * for the same message merged into a single string concatenation. One token per
 * IPC message is then still only one React render per frame.
 * ================================================================== */

interface TranscriptSlice {
  /** Message ids in arrival order. Reference-stable across content-only updates. */
  order: ChatMessageId[]
  byId: Record<ChatMessageId, ChatMessage>
}

interface TranscriptState {
  chats: Record<ChatId, TranscriptSlice>
  /**
   * Whether preload actually exposes a chat channel. False means the panel is
   * running against a gap in the contract rather than against an empty
   * conversation, and the UI says so instead of showing a blank transcript.
   */
  channelReady: boolean
}

const EMPTY_SLICE: TranscriptSlice = { order: [], byId: {} }
const EMPTY_IDS: ChatMessageId[] = []

export const useTranscriptStore = create<TranscriptState>(() => ({
  chats: {},
  channelReady: false,
}))

const setState = useTranscriptStore.setState
const getState = useTranscriptStore.getState

/* ------------------------------------------------------------------ */
/* Applying deltas                                                     */
/* ------------------------------------------------------------------ */

/**
 * Apply a batch synchronously.
 *
 * Exported for tests and for whoever wires the IPC channel; normal traffic
 * should go through `enqueueChatDeltas` so it gets the per-frame coalescing.
 */
export function applyChatDeltas(deltas: readonly ChatDelta[]): void {
  if (deltas.length === 0) return
  const chats = { ...getState().chats }
  let touched = false

  for (const delta of deltas) {
    const before = chats[delta.chatId] ?? EMPTY_SLICE
    const after = applyOne(before, delta)
    if (after !== before) {
      chats[delta.chatId] = after
      touched = true
    }
  }

  if (touched) setState({ chats })
}

export function applyChatDelta(delta: ChatDelta): void {
  applyChatDeltas([delta])
}

function applyOne(slice: TranscriptSlice, delta: ChatDelta): TranscriptSlice {
  switch (delta.type) {
    case 'reset':
      return slice.order.length === 0 ? slice : { order: [], byId: {} }

    case 'message.start': {
      const { message } = delta
      // Idempotent by id: a renderer that re-syncs may see the same start twice,
      // and a duplicate must not double the message.
      if (slice.byId[message.id]) {
        return { order: slice.order, byId: { ...slice.byId, [message.id]: message } }
      }
      return {
        order: [...slice.order, message.id],
        byId: { ...slice.byId, [message.id]: message },
      }
    }

    case 'text.append':
      return patchMessage(slice, delta.messageId, (m) => appendToBlock(m, 'text', delta.text))

    case 'thought.append':
      return patchMessage(slice, delta.messageId, (m) => appendToBlock(m, 'thought', delta.text))

    case 'tool.upsert':
      return patchMessage(slice, delta.messageId, (m) => {
        const idx = m.blocks.findIndex(
          (b) => b.type === 'tool' && b.call.toolCallId === delta.call.toolCallId,
        )
        const blocks = [...m.blocks]
        if (idx === -1) blocks.push({ type: 'tool', call: delta.call })
        else blocks[idx] = { type: 'tool', call: delta.call }
        return { ...m, blocks }
      })

    case 'message.end':
      return patchMessage(slice, delta.messageId, (m) => ({
        ...m,
        complete: true,
        stopReason: delta.stopReason,
        ...(delta.error ? { error: delta.error } : {}),
      }))
  }
}

/**
 * Replace one message, leaving `order` and every other message's reference
 * untouched. A delta naming a message that does not exist is dropped: it means
 * the mirror is behind, and inventing a placeholder would put text on screen
 * that main never sent.
 */
function patchMessage(
  slice: TranscriptSlice,
  id: ChatMessageId,
  fn: (m: ChatMessage) => ChatMessage,
): TranscriptSlice {
  const current = slice.byId[id]
  if (!current) return slice
  const next = fn(current)
  if (next === current) return slice
  return { order: slice.order, byId: { ...slice.byId, [id]: next } }
}

/** Append to the trailing block of `kind`, opening one when the last block is something else. */
function appendToBlock(m: ChatMessage, kind: 'text' | 'thought', text: string): ChatMessage {
  if (text === '') return m
  const blocks = [...m.blocks]
  const last = blocks[blocks.length - 1]
  if (last && last.type === kind) {
    blocks[blocks.length - 1] = { type: kind, text: last.text + text }
  } else {
    blocks.push({ type: kind, text })
  }
  return { ...m, blocks }
}

/* ------------------------------------------------------------------ */
/* Full sync                                                           */
/* ------------------------------------------------------------------ */

/** Install a whole transcript, replacing whatever the mirror held. */
export function setChatTranscript(transcript: ChatTranscript): void {
  const byId: Record<ChatMessageId, ChatMessage> = {}
  const order: ChatMessageId[] = []
  for (const m of transcript.messages) {
    if (!byId[m.id]) order.push(m.id)
    byId[m.id] = m
  }
  setState((s) => ({ chats: { ...s.chats, [transcript.chatId]: { order, byId } } }))
}

/** Drop a conversation's mirror; for a chat view that is closing. */
export function forgetChat(chatId: ChatId): void {
  setState((s) => {
    if (!s.chats[chatId]) return s
    const chats = { ...s.chats }
    delete chats[chatId]
    return { chats }
  })
}

/* ------------------------------------------------------------------ */
/* Queue + per-frame flush                                             */
/* ------------------------------------------------------------------ */

let queue: ChatDelta[] = []
let scheduled = 0

/**
 * Hard ceiling on how long a delta waits, for the case where the window is
 * hidden and `requestAnimationFrame` never fires. Without it a background panel
 * would look frozen and then dump the whole turn at once on focus.
 */
const FLUSH_TIMEOUT_MS = 100

/** How many queued deltas force an immediate flush regardless of the frame clock. */
const FLUSH_MAX_QUEUED = 512

export function enqueueChatDeltas(deltas: readonly ChatDelta[]): void {
  if (deltas.length === 0) return
  for (const d of deltas) queue.push(d)
  if (queue.length >= FLUSH_MAX_QUEUED) {
    flushChatDeltas()
    return
  }
  scheduleFlush()
}

export function enqueueChatDelta(delta: ChatDelta): void {
  enqueueChatDeltas([delta])
}

function scheduleFlush(): void {
  if (scheduled !== 0) return
  if (typeof requestAnimationFrame === 'function') {
    const raf = requestAnimationFrame(() => {
      scheduled = 0
      flushChatDeltas()
    })
    // A hidden window never paints, so back the frame with a timer as well; the
    // first of the two to fire clears the other.
    const timer = setTimeout(() => {
      cancelAnimationFrame(raf)
      scheduled = 0
      flushChatDeltas()
    }, FLUSH_TIMEOUT_MS)
    scheduled = timer as unknown as number
    return
  }
  scheduled = setTimeout(() => {
    scheduled = 0
    flushChatDeltas()
  }, 0) as unknown as number
}

export function flushChatDeltas(): void {
  if (scheduled !== 0) {
    clearTimeout(scheduled)
    scheduled = 0
  }
  if (queue.length === 0) return
  const batch = coalesce(queue)
  queue = []
  applyChatDeltas(batch)
}

/**
 * Merge consecutive appends to the same message.
 *
 * A hundred single-token `text.append`s become one, so the flush clones the
 * message's block array once instead of a hundred times. Order is preserved and
 * nothing else is touched — merging is only legal between *adjacent* deltas of
 * the same type for the same message, which is exactly the streaming case.
 */
export function coalesce(deltas: readonly ChatDelta[]): ChatDelta[] {
  const out: ChatDelta[] = []
  for (const delta of deltas) {
    const prev = out[out.length - 1]
    if (
      prev &&
      (delta.type === 'text.append' || delta.type === 'thought.append') &&
      prev.type === delta.type &&
      prev.chatId === delta.chatId &&
      prev.messageId === delta.messageId
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + delta.text }
      continue
    }
    out.push(delta)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Bridge wiring                                                       */
/* ------------------------------------------------------------------ */

/**
 * The two halves of the transcript channel, probed at runtime in the same style
 * as `bridgeExtras` in `bridge.ts` — if preload implements them the panel is
 * live, and if it does not the panel renders a plain statement that it is not
 * connected rather than an empty conversation that looks working.
 *
 * `onChatDelta` takes an **array** so main can batch, which is what `chat.ts`
 * asks it to do.
 *
 * `restoreChat` is the way back from a reload. The delta stream is append-only
 * and nobody repeats it, so a mirror that starts empty stays empty while main
 * sits on a perfectly good conversation — the tab, title and message count come
 * back through `STATE_SNAPSHOT` and the messages do not. This asks for one
 * re-send; the messages arrive over `onChatDelta` like any others, so there is
 * no second format and no second code path applying it.
 */
export interface ChatBridgeChannel {
  onChatDelta(handler: (deltas: ChatDelta | ChatDelta[]) => void): () => void
  restoreChat(chatId: ChatId): Promise<boolean>
}

function channel(): Partial<ChatBridgeChannel> | null {
  const b = tryBridge()
  if (!b) return null
  return b as unknown as Partial<ChatBridgeChannel>
}

let started = false

/**
 * Subscribe to the delta stream. Called once at module scope by `index.ts` — not
 * from an effect, because StrictMode would subscribe twice.
 */
export function startChatSync(): void {
  if (started) return
  started = true
  const ch = channel()
  const on = ch?.onChatDelta
  if (typeof on !== 'function') return
  on.call(ch, (payload) => {
    enqueueChatDeltas(Array.isArray(payload) ? payload : [payload])
  })
  setState({ channelReady: true })
}

/**
 * Conversations already asked for, so a remount does not ask twice.
 *
 * Keyed by `ChatId`, which dies with the view, so this cannot grow without
 * bound in a session. It is deliberately **not** cleared when a request answers
 * `false`: "main has nothing" is a settled answer, and re-asking on every
 * render would turn an empty conversation into a request loop.
 */
const requested = new Set<ChatId>()

/**
 * Ask main to re-send one conversation, once.
 *
 * Called when a chat view mounts with an empty mirror — the reload case. A
 * conversation that is empty because nobody has spoken yet also lands here,
 * costs one round trip, and gets `false`; that is cheaper than any way of
 * telling the two apart from this side.
 */
export async function restoreChat(chatId: ChatId): Promise<boolean> {
  if (requested.has(chatId)) return false
  requested.add(chatId)
  return ask(chatId)
}

/**
 * Ask again, on purpose.
 *
 * The button under a snapshot that could not be replaced. It goes around the
 * once-per-conversation guard above, and that is the entire difference between
 * the two functions: the guard exists to keep an *automatic* request from
 * looping, and a person pressing a button is not a loop. Nothing else about a
 * retry differs — same channel, same reply, same deltas.
 */
export async function retryLoad(chatId: ChatId): Promise<boolean> {
  requested.add(chatId)
  return ask(chatId)
}

async function ask(chatId: ChatId): Promise<boolean> {
  const ch = channel()
  const request = ch?.restoreChat
  if (typeof request !== 'function') return false
  try {
    return await request.call(ch, chatId)
  } catch {
    // Main answers `false` on every failure it can see; this is the transport
    // itself failing. Either way the panel shows what it has.
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

/**
 * The message ids of a conversation.
 *
 * The reference only changes when a message is added or removed — that is the
 * whole reason for the `{ order, byId }` split — so the list component is not
 * re-rendered by streaming text.
 */
export function useChatMessageIds(chatId: ChatId): ChatMessageId[] {
  return useTranscriptStore((s) => s.chats[chatId]?.order ?? EMPTY_IDS)
}

/** One message. Only this subscriber re-renders when that message changes. */
export function useChatMessage(chatId: ChatId, messageId: ChatMessageId): ChatMessage | null {
  return useTranscriptStore((s) => s.chats[chatId]?.byId[messageId] ?? null)
}

export function useChatChannelReady(): boolean {
  return useTranscriptStore((s) => s.channelReady)
}

/** Non-hook read, for event handlers. */
export function readChatMessages(chatId: ChatId): ChatMessage[] {
  const slice = getState().chats[chatId]
  if (!slice) return []
  return slice.order.map((id) => slice.byId[id]).filter((m): m is ChatMessage => m !== undefined)
}

/**
 * Subscribe to *any* change in one conversation, without re-rendering.
 *
 * The scroll-follow logic needs to know that content grew, but re-rendering the
 * list for it would undo the point of the store's shape. This is an imperative
 * subscription instead: the callback runs, scrolls, and React never hears of it.
 */
export function subscribeChat(chatId: ChatId, cb: () => void): () => void {
  let previous = getState().chats[chatId]
  return useTranscriptStore.subscribe((s) => {
    const next = s.chats[chatId]
    if (next === previous) return
    previous = next
    cb()
  })
}

/** React-friendly count of messages, for the empty state. */
export function useChatMessageCount(chatId: ChatId): number {
  const subscribe = useTranscriptStore.subscribe
  const get = (): number => getState().chats[chatId]?.order.length ?? 0
  return useSyncExternalStore(subscribe, get, get)
}
