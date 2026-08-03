/**
 * Chat contract: the conversation between the user and an ACP agent
 * (Claude Code, via `@agentclientprotocol/claude-agent-acp`).
 *
 * ## The one structural decision in this file: the transcript is NOT in Workspace
 *
 * `Workspace` is main's source of truth, and every committed Command diffs it with
 * immer and broadcasts the resulting JSON patches to the renderer. That machinery
 * is sized for *control-plane* state — a layout tree, a handful of view
 * descriptors — and PLAN section 3 is explicit that the data plane must not go
 * through it.
 *
 * A chat transcript is data plane, and aggressively so:
 *
 * - `agent_message_chunk` notifications arrive token-by-token. A real turn is
 *   tens to hundreds of them per second. Putting the text in Workspace means one
 *   `rev` bump, one immer diff and one IPC broadcast **per token**.
 * - immer's patch generation walks the draft. A transcript grows without bound,
 *   so the cost of every unrelated Command — opening a table, dragging a split —
 *   grows with how much the user has chatted.
 * - `WorkspaceSnapshot` is what `read_workspace` returns to the AI. If the
 *   transcript were in it, every MCP call would echo the whole conversation back
 *   into the model's context, which is both expensive and circular.
 * - Tool results (`ToolCallRecord.content`) can be arbitrarily large; a single
 *   `read_workspace` reply is already multiple kilobytes.
 *
 * So chat follows **exactly the precedent result sets already set** in this
 * codebase: `ResultMeta` (small, in Workspace, patch-broadcast, MCP-visible)
 * alongside row data that streams over a dedicated channel and never enters
 * main's store. Here that is `ChatViewState` (metadata) alongside
 * `ChatTranscript` (the messages), and the split is drawn at the same place for
 * the same reason.
 *
 * ### What this does *not* relax
 *
 * The renderer still never invents state. Sending a message, cancelling a turn,
 * answering a permission prompt and staging an attachment are all Commands
 * (`chat.*`), dispatched to main like everything else. Main owns the ACP
 * connection, owns the transcript, and emits append-only `ChatDelta` events
 * toward the renderer. The renderer's transcript is a projection of those
 * deltas — a mirror, exactly as its Workspace store is a mirror of main's. What
 * changes is the *transport* for one payload, not who is allowed to decide
 * things.
 *
 * ### Where the transcript actually lives
 *
 * Main, in a `ChatId`-keyed store held next to the Workspace but not inside it.
 * It is the source of truth; the renderer holds a mirror; persistence (if any)
 * is a separate concern and this contract does not assume it.
 *
 * ### Coalescing
 *
 * `ChatDelta`s are appended per ACP notification, but the emitter is expected to
 * **batch on a time/size budget** before crossing IPC — the same discipline the
 * chunk protocol uses. One IPC message per token is the failure mode this whole
 * design exists to avoid, and moving the transcript out of Workspace does not by
 * itself prevent it.
 */

import type { CollectionRef } from './capability'
import type { PeekError } from './errors'
import type { AttachmentId, ChatId, ChatMessageId, ConnId, ResultId, ViewId } from './ids'

/* ================================================================== */
/* 1. Transcript                                                       */
/* ================================================================== */

export type ChatRole = 'user' | 'agent'

/**
 * Lifecycle of one tool call, mirroring ACP's `ToolCallStatus`.
 *
 * `pending` is the state a `tool_call` notification arrives in; the terminal
 * three come from `tool_call_update`. Note that a permission prompt happens
 * *between* `pending` and `in_progress`, and is not itself a status — see
 * `ChatViewState.pendingPermission`.
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * ACP's `ToolKind`, verbatim, so the UI can pick an icon without a translation
 * table. `other` is what every MCP tool arrives as, peek's own included.
 */
export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

/** One tool invocation, accumulated across the `tool_call` / `tool_call_update` pair. */
export interface ToolCallRecord {
  /** ACP's `toolCallId`; opaque, agent-assigned, unique within a session. */
  toolCallId: string
  /** Human-readable label the agent supplies (e.g. `mcp__peek__read_workspace`). */
  title: string
  kind: ToolCallKind
  status: ToolCallStatus
  /**
   * The tool's arguments. Arrives **incrementally**: the first `tool_call` carries
   * `{}` and later updates fill it in as the model streams its JSON, so a renderer
   * must treat every update as a replacement rather than a merge.
   */
  rawInput?: unknown
  /**
   * The tool's result. Deliberately `unknown` and not `Record<string, unknown>`:
   * an MCP tool returns an **array** of content blocks, and typing this as a
   * record is precisely the bug that makes older ACP client SDKs drop the
   * completion notification (see the spike notes on `@zed-industries/…@0.4.5`).
   */
  rawOutput?: unknown
  /** Rendered content the agent offers for display, if any. */
  content: ToolCallContent[]
  startedAt: number
  endedAt?: number
}

/** Display content attached to a tool call. Only the shapes peek renders. */
export type ToolCallContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }

/**
 * A block within one message.
 *
 * `thought` is kept separate from `text` so the UI can collapse it. Note that
 * current models default thinking to "omitted" and stream signature-only blocks
 * with empty text, so `thought` blocks are **rare in practice** — implement the
 * path, but do not build the layout around it always being there.
 */
export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; call: ToolCallRecord }

export interface ChatMessage {
  id: ChatMessageId
  role: ChatRole
  blocks: ChatBlock[]
  createdAt: number
  /** False while the turn is still streaming. */
  complete: boolean
  /**
   * Why the agent stopped, on the last message of a turn. ACP's `StopReason`,
   * plus `error` for a turn that never reached one.
   */
  stopReason?: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'
  /** Attachments the user staged on this turn, kept for re-display. */
  attachments?: ChatAttachment[]
  /**
   * What each of those attachments actually delivered, keyed by `attachmentId`.
   *
   * Separate from `attachments` because the two are written at different times:
   * the descriptors are known when the user stages them, the outcome only after
   * `resolveAttachments` has run. See `ChatAttachmentReceipt`.
   */
  attachmentReceipts?: ChatAttachmentReceipt[]
  error?: PeekError
}

export interface ChatTranscript {
  chatId: ChatId
  messages: ChatMessage[]
}

/* ================================================================== */
/* 2. Deltas (main → renderer; append-only)                            */
/* ================================================================== */

/**
 * The only way the transcript changes. Append-only and idempotent-by-id, so a
 * renderer that reconnects can ask for a full transcript and then resume
 * applying deltas without reconciliation logic.
 */
export type ChatDelta =
  | { type: 'message.start'; chatId: ChatId; message: ChatMessage }
  /** Append text to the last `text` block of `messageId`, opening one if needed. */
  | { type: 'text.append'; chatId: ChatId; messageId: ChatMessageId; text: string }
  | { type: 'thought.append'; chatId: ChatId; messageId: ChatMessageId; text: string }
  /** Insert or replace a tool call by `toolCallId`; replacement is wholesale. */
  | { type: 'tool.upsert'; chatId: ChatId; messageId: ChatMessageId; call: ToolCallRecord }
  | {
      type: 'message.end'
      chatId: ChatId
      messageId: ChatMessageId
      stopReason: NonNullable<ChatMessage['stopReason']>
      error?: PeekError
    }
  /** Everything before this point is gone (a cleared conversation). */
  | { type: 'reset'; chatId: ChatId }

/* ------------------------------------------------------------------ */
/* 2b. The projection, as a flat list                                  */
/* ------------------------------------------------------------------ */

/**
 * Fold one delta into a `ChatMessage[]`.
 *
 * ## Why this exists when the renderer already has one
 *
 * The renderer's transcript store applies the same rules to a `{ order, byId }`
 * pair, and that shape is load-bearing there: it is what stops a streamed token
 * from re-rendering every row in the list. Main has no such problem and a very
 * different need — it persists the endpoint backend's transcript, and a file
 * wants a list, not an index.
 *
 * So the two projections are kept in the shapes their jobs call for, and the
 * risk that comes with that — two implementations of one rule, drifting — is
 * closed by a test that runs both over the same delta sequence and asserts they
 * agree (`renderer/components/chat/__tests__/chat.test.ts`). Sharing one
 * implementation would have meant giving one of the two callers the wrong data
 * structure, which is a worse trade than a locked-down duplicate.
 *
 * Pure and non-mutating: returns `messages` itself when nothing changed, so a
 * caller can use reference equality to decide whether to write to disk.
 */
export function applyChatDeltaToMessages(
  messages: readonly ChatMessage[],
  delta: ChatDelta,
): ChatMessage[] {
  switch (delta.type) {
    case 'reset':
      return messages.length === 0 ? (messages as ChatMessage[]) : []

    case 'message.start': {
      // Idempotent by id, exactly as the renderer's mirror is: a replay that
      // re-announces a message must replace it, never double it.
      const at = messages.findIndex((m) => m.id === delta.message.id)
      if (at === -1) return [...messages, delta.message]
      const next = [...messages]
      next[at] = delta.message
      return next
    }

    case 'text.append':
      return patch(messages, delta.messageId, (m) => appendBlock(m, 'text', delta.text))

    case 'thought.append':
      return patch(messages, delta.messageId, (m) => appendBlock(m, 'thought', delta.text))

    case 'tool.upsert':
      return patch(messages, delta.messageId, (m) => {
        const at = m.blocks.findIndex(
          (b) => b.type === 'tool' && b.call.toolCallId === delta.call.toolCallId,
        )
        const blocks = [...m.blocks]
        if (at === -1) blocks.push({ type: 'tool', call: delta.call })
        else blocks[at] = { type: 'tool', call: delta.call }
        return { ...m, blocks }
      })

    case 'message.end':
      return patch(messages, delta.messageId, (m) => ({
        ...m,
        complete: true,
        stopReason: delta.stopReason,
        ...(delta.error ? { error: delta.error } : {}),
      }))
  }
}

/**
 * Replace one message. A delta naming a message that is not here is dropped
 * rather than invented — the same rule the renderer's mirror follows, and for
 * the same reason: a placeholder would put text on screen nobody sent.
 */
function patch(
  messages: readonly ChatMessage[],
  id: ChatMessageId,
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === id)
  if (at === -1) return messages as ChatMessage[]
  const current = messages[at] as ChatMessage
  const next = fn(current)
  if (next === current) return messages as ChatMessage[]
  const out = [...messages]
  out[at] = next
  return out
}

/** Append to the trailing block of `kind`, opening one when the last is something else. */
function appendBlock(m: ChatMessage, kind: 'text' | 'thought', text: string): ChatMessage {
  if (text === '') return m
  const blocks = [...m.blocks]
  const last = blocks[blocks.length - 1]
  if (last && last.type === kind) blocks[blocks.length - 1] = { type: kind, text: last.text + text }
  else blocks.push({ type: kind, text })
  return { ...m, blocks }
}

/**
 * A stored transcript, back on the wire.
 *
 * One `message.start` per message and nothing else: that delta carries a whole
 * `ChatMessage`, so a finished conversation needs no appends to rebuild — the
 * blocks are already in it. This is what lets a restored conversation and a live
 * one arrive through the same channel, and it is why the restore path adds no
 * second format to `ChatDelta`.
 */
export function transcriptToDeltas(chatId: ChatId, messages: readonly ChatMessage[]): ChatDelta[] {
  return messages.map((message) => ({ type: 'message.start' as const, chatId, message }))
}

/* ================================================================== */
/* 3. Context attachments — "add what I am looking at"                 */
/* ================================================================== */

/**
 * What the user pinned to the next prompt.
 *
 * These are **descriptors, never payloads**. Three reasons, in order of weight:
 *
 * 1. they live in `ChatViewState`, i.e. in Workspace, i.e. in every patch
 *    broadcast and every `read_workspace` reply. A thousand selected rows
 *    inlined here would reintroduce exactly the problem section 1 avoids;
 * 2. a descriptor stays **live**. The user attaches "the result of this query",
 *    edits the query, re-runs, and sends — and gets current data, because
 *    materialisation happens at send time, not at attach time;
 * 3. the underlying data can be *gone* by send time (the renderer's result cache
 *    is an LRU, PLAN section 8). A descriptor can fail to resolve and say so;
 *    an inlined blob would have silently captured a stale snapshot instead.
 *
 * Main resolves each descriptor into an ACP `ContentBlock` when the prompt is
 * sent — see `AttachmentPayload`.
 */
export type ChatAttachment = { id: AttachmentId; label: string } & (
  /** Specific rows the user selected in a grid. */
  | { kind: 'rows'; viewId: ViewId; resultId: ResultId; rowIndexes: number[] }
  /** A whole result set, capped. */
  | { kind: 'result'; viewId: ViewId; resultId: ResultId; maxRows: number }
  /** One cell — the case where a truncated preview is not enough. */
  | { kind: 'cell'; viewId: ViewId; resultId: ResultId; rowIndex: number; column: string }
  /** DDL / column list for a table, keyspace or collection. */
  | { kind: 'schema'; connId: ConnId; ref: CollectionRef }
  /** The SQL currently in a query editor. */
  | { kind: 'query'; viewId: ViewId }
  /** The layout and view summaries — "here is what I am looking at". */
  | { kind: 'workspace' }
)

export type ChatAttachmentKind = ChatAttachment['kind']

/**
 * A resolved attachment, ready to become an ACP `ContentBlock`.
 *
 * **Embedded, not linked.** ACP offers `resource_link` (a URI the agent fetches)
 * and `resource` (content inline). peek must use `resource`: the agent runs in
 * its own process with no route back into peek's result cache, and a
 * `peek://…` URI is not something it can dereference — peek declares
 * `fs.readTextFile: false`, and the scheme is not a file in any case. The agent
 * advertises `promptCapabilities.embeddedContext: true`, so check that flag and
 * fall back to plain text when it is absent.
 *
 * `text` is rendered as Markdown on purpose: it is what the model reads best,
 * and it keeps this contract independent of the driver that produced the data.
 */
export interface AttachmentPayload {
  attachmentId: AttachmentId
  /** Stable, human-meaningful, and unique per attachment, e.g. `peek://result/res_ab12/rows`. */
  uri: string
  mimeType: 'text/markdown'
  text: string
  /** Set when the descriptor could not be resolved (evicted cache, closed view, dropped connection). */
  error?: PeekError
}

/**
 * What was left out of a payload.
 *
 * Mirrors `TruncationNotice` in `main/acp/context/budget.ts`, and lives here
 * because it is the one part of that module's output that has to reach the
 * renderer. Everything else budgeting produces is for the model.
 */
export interface AttachmentTruncation {
  /** What the counts refer to, so a renderer can pick the right sentence. */
  unit: 'rows' | 'characters' | 'elements'
  included: number
  /** `null` when the total is genuinely unknown (a stream still running). */
  total: number | null
  reason: 'rowCap' | 'tokenBudget' | 'valueCap' | 'sourceTruncated' | 'promptBudget'
}

/**
 * What actually went out for one attachment, recorded on the turn that sent it.
 *
 * The reason this crosses back to the renderer at all is the rule stated at the
 * top of `budget.ts`: **never truncate silently**, and tell *both* audiences.
 * The model is told inside the document body. Without this the user was not told
 * at all — a person who believes they attached 12,345 rows will trust a sum
 * computed over the first 100 of them.
 *
 * A receipt, not a promise: it is written after resolution, so it never claims a
 * number nothing produced. Attachments that resolved whole get no entry.
 */
export interface ChatAttachmentReceipt {
  attachmentId: AttachmentId
  notice?: AttachmentTruncation
  /** The descriptor could not be resolved at send time; nothing of it was sent. */
  failed?: boolean
}

/* ================================================================== */
/* 4. Agent-side status                                                */
/* ================================================================== */

/**
 * What the chat is doing, as far as the user is concerned.
 *
 * `authenticating` deserves a note: the agent reuses whatever Claude Code login
 * already exists on the machine, so the common path never visits this state. It
 * exists because `initialize` advertises `authMethods` and a fresh machine has
 * to go somewhere.
 *
 * `loading` is the one state that is **not** about a turn. A view opened onto an
 * existing session replays that session's history first, and the replay arrives
 * as ordinary `session/update` notifications — the same shape a live turn uses.
 * Without a state of its own the panel would be indistinguishable from one that
 * is generating: the composer would lock and a stop button would appear over a
 * conversation with no turn to stop. It sits beside `starting` rather than
 * beside `streaming` for exactly that reason.
 */
export type ChatAgentStatus =
  | 'idle'
  | 'starting'
  | 'authenticating'
  /** Replaying an existing session's history into a freshly opened view. */
  | 'loading'
  | 'ready'
  | 'streaming'
  | 'awaiting-permission'
  | 'error'

/**
 * A permission request the agent is blocked on.
 *
 * This one **does** belong in Workspace, unlike the transcript. It is small, it
 * is modal, and it is the single most important thing about the window while it
 * is set — the AI reading `read_workspace` and the human looking at the screen
 * both need to know the conversation is waiting on a human decision.
 */
export interface PendingPermission {
  /** Correlates the eventual `chat.respondPermission` back to the blocked ACP request. */
  requestId: string
  toolCallId: string
  toolName: string
  /** Short, already-truncated rendering of the arguments — never the full input. */
  inputPreview: string
  options: PermissionOption[]
  askedAt: number
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** Token budget the agent reports; `size` is the context window. */
export interface ChatUsage {
  used: number
  size: number
}

/**
 * Permission modes the agent offers. peek is a database viewer, so the default
 * should be a *restrictive* one — this list exists to be presented, not to be
 * silently defaulted to its most permissive member.
 */
export const CHAT_PERMISSION_MODES = [
  'auto',
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const
export type ChatPermissionMode = (typeof CHAT_PERMISSION_MODES)[number]

/* ================================================================== */
/* 5. The session catalogue                                            */
/* ================================================================== */

/**
 * One past conversation, as the **agent** describes it.
 *
 * ## peek is not the owner of this record
 *
 * Everything else in this file describes state peek holds. This one does not:
 * the rows come from the agent's `session/list`, which reads the transcripts it
 * wrote under its own working directory. peek keeps no copy, which is the whole
 * point — a second history would be a second answer to "what does the model
 * remember", and only one of the two would be right.
 *
 * That has a consequence worth stating rather than discovering: an agent that
 * does not advertise `loadSession` has no catalogue, and the honest rendering of
 * that is an explanation, not an empty list.
 */
export interface ChatSessionInfo {
  /** The agent's session id. This is the identity of a conversation across views and restarts. */
  sessionId: string
  /** The agent's working directory the session belongs to; peek's is always the chat workdir. */
  cwd: string
  /**
   * The agent's own title — a user `/rename` if there was one, otherwise the
   * summary it generated.
   *
   * **Untrusted.** It is derived from conversation content, which can include
   * whatever a database cell contained, so it is rendered through the same path
   * as any other untrusted string and never as markup.
   */
  title?: string
  /** ISO 8601, from the agent. Used for ordering and for a relative timestamp. */
  updatedAt?: string
  /**
   * Which agent owns this conversation, as a name to show on the row.
   *
   * Absent when peek has no route recorded for the session — an older
   * conversation, or a catalogue read with no index behind it. A row without it
   * is still openable; it just cannot say who wrote it.
   *
   * peek's, not the agent's: a conversation is fixed to the backend it was
   * created on (histories are not portable between them), so the list mixes
   * agents and the row has to say which one it is.
   */
  agent?: string
}
