/**
 * The pure state implementation of `chat.*`, plus the two seams the ACP adapter
 * plugs into.
 *
 * ## Concurrency: what is and is not serialised
 *
 * `CommandBus.dispatch` is `async` and **does not serialise across commands**. It
 * awaits the effect phase, and a second dispatch that arrives during that await
 * runs its own state phase immediately. So the following really can happen:
 *
 *     A.reduce  →  A.effects (await)  →  B.reduce  →  B.effects  →  A.finalize
 *
 * What *is* atomic is the state phase itself. `#runStateStage` calls
 * `store.applyWith`, which is a synchronous immer `produce`; nothing inside a
 * reducer awaits, so no other command can observe or interleave with a partially
 * applied one. Two consequences, and every guard in this file is built on them:
 *
 * 1. **A check-and-set performed entirely inside one `reduce` is race-free.**
 *    That is why `chat.send` decides "is a turn already running?" and writes
 *    `streamingMessageId` in the same reducer. Two concurrent sends cannot both
 *    see an idle conversation, so the second is refused with CONFLICT — and this
 *    is also, incidentally, what stops the embedded agent from prompting the
 *    conversation it is itself running inside, since it can only reach `chat.send`
 *    from within a turn and inside a turn the conversation is busy.
 * 2. **Anything decided across an await is a race and must be re-checked.** A
 *    multi-command MCP tool (`open_view` then `run_query`) awaits between the two,
 *    and the user may close the view in the gap. Those sequences fail cleanly with
 *    NOT_FOUND on the second command rather than corrupting the tree, because the
 *    second command re-resolves its target from the draft. Nothing here relies on
 *    a lookup that was done before an await.
 *
 * The same reasoning covers "the AI opens a view while the user closes the panel":
 * `view.open` and `view.close` each land whole, in some order, and both the
 * receipt the tool returns and the patch the renderer applies are taken from the
 * state *after* the command — never from what the caller assumed.
 *
 * ## Effects: fire-and-forget, deliberately
 *
 * Chat effects do **not** go through `EffectIntent` / `runIntents`, and that is
 * not a shortcut. `runIntents` awaits each intent, so an ACP `prompt()` registered
 * as one would keep the whole `chat.send` command pending for the entire turn —
 * minutes, in the failure cases, since a broken endpoint retries for ~3 minutes
 * before rejecting. Worse, peek's MCP server runs in this same process: the agent
 * calls back into main *during* the turn, so a command that blocks until the turn
 * ends is a deadlock waiting for a slow enough tool call.
 *
 * So a reducer records what it wants done and `finalize` hands it to the runtime
 * without awaiting. Ordering is still guaranteed where it matters: `finalize` runs
 * after the state has landed, so the runtime never sees an effect for a state
 * change that has not been committed (or, if the reducer threw, one that was
 * rolled back).
 *
 * ## Write-back
 *
 * Streaming updates come the other way, through `ChatEventSink` — the direct
 * mirror of `createResultEventSink`, which is how driver-host events already write
 * into the store. A Command per streamed token would put the whole transcript
 * through immer's patch generator, which is precisely the cost `core/chat.ts`
 * exists to avoid.
 */

import type { Draft } from 'immer'
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_ROWS,
  collectionRefLabel,
  type AttachmentId,
  type ChatAgentStatus,
  type ChatAttachResult,
  type ChatAttachment,
  type ChatAttachmentSpec,
  type ChatCancelResult,
  type ChatClearResult,
  type ChatDetachResult,
  type ChatId,
  type ChatMessageId,
  type ChatPermissionMode,
  type ChatRespondPermissionResult,
  type ChatSendResult,
  type ChatSessionsDeleteResult,
  type ChatSessionsListResult,
  type ChatSetModeResult,
  type ChatUsage,
  type ChatViewState,
  type PeekError,
  type PendingPermission,
  type PendingQuestion,
  type ViewId,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { plain, type WorkspaceStore } from '../../store/workspace-store'
import { failMsg } from '../failure'
import type { CommandHandlerMap, ReduceCtx } from '../types'

/* ================================================================== */
/* 0. Constants                                                        */
/* ================================================================== */

/**
 * How much of a message is kept in `ChatViewState.lastMessagePreview`.
 *
 * A hard ceiling, not a hint. This field is in the Workspace, so it is in every
 * patch broadcast and in every `read_workspace` reply; the whole point of keeping
 * the transcript out of the Workspace is undone if the preview is allowed to grow.
 */
const PREVIEW_CHARS = 200

/** Default row cap for a `result` attachment when the caller does not say. */
const DEFAULT_ATTACHMENT_ROWS = 100

/**
 * Modes a non-`ui` caller may not select, because each one removes the human from
 * the loop. Handing these to a model on request would make the permission prompt
 * decorative — and the prompt is the only reason it is safe to let an agent drive
 * the window at all.
 */
const HUMAN_ONLY_MODES: ReadonlySet<ChatPermissionMode> = new Set(['dontAsk', 'bypassPermissions'])

/* ================================================================== */
/* 1. The runtime seam (implemented by the ACP adapter)                */
/* ================================================================== */

/**
 * One thing the Command Bus wants the agent to do.
 *
 * Plain data, for the same reason `EffectIntent` is: it is read off an immer draft
 * and has to outlive `produce`, so everything here has already been through
 * `plain()`.
 */
export type ChatEffect =
  /**
   * A conversation appeared; bring an agent session up for it.
   *
   * Lazily is fine — **unless `resumeSessionId` is set**, in which case the view
   * was opened to read an existing conversation and the runtime has to fetch it
   * now. See `design/2026-08-02-chat-session-management.md` §2.4.
   *
   * It used to carry a `permissionMode` too, copied off the view. **Neither
   * backend ever read it**, and what it carried was `buildChatViewState`'s
   * placeholder rather than the user's setting — so a field that looked like the
   * channel by which "new conversations start in …" reached a session was
   * neither the channel nor the value. Removed rather than wired up: the
   * runtimes read the setting themselves at the moment they need it. See
   * `design/2026-08-13-permission-mode-takes-effect.md`.
   */
  | {
      type: 'session.open'
      chatId: ChatId
      viewId: ViewId
      resumeSessionId?: string
    }
  /** The conversation is gone (view closed, connection closed, layout rewritten). Tear the session down. */
  | { type: 'session.close'; chatId: ChatId }
  | {
      type: 'prompt'
      chatId: ChatId
      /** The user turn already appended to the transcript; the reply streams under its own id. */
      messageId: ChatMessageId
      text: string
      /** Descriptors, unresolved. The runtime materialises them at send time — see `AttachmentPayload`. */
      attachments: ChatAttachment[]
    }
  /** Stop the turn. `messageId` is null when the conversation was idle and this is a defensive stop. */
  | { type: 'cancel'; chatId: ChatId; messageId: ChatMessageId | null }
  | { type: 'permission'; chatId: ChatId; requestId: string; optionId: string }
  | { type: 'setMode'; chatId: ChatId; mode: ChatPermissionMode }
  /** Drop the transcript and start the agent session over. */
  | { type: 'clear'; chatId: ChatId }
  /**
   * Delete a stored conversation for good.
   *
   * The only effect in this union that destroys something outside peek, and the
   * only one whose target is a session id rather than a `ChatId` — by the time it
   * runs there is no conversation left in the window to name.
   */
  | { type: 'sessions.delete'; sessionId: string }

/**
 * What the bus needs from the ACP adapter.
 *
 * `run` carries every **side effect**, as one union, so adding an effect is a
 * variant the compiler will make the adapter handle rather than a method it can
 * quietly not implement.
 *
 * **`run` must return promptly and must not reject.** The bus never awaits it (see
 * the header note on deadlock); a rejection would surface as an unhandled promise
 * rejection rather than as anything a user could act on. Report failures through
 * `ChatEventSink.onAgentError` instead, where they land on the conversation the
 * user is looking at.
 *
 * `listSessions` is the one thing that is **not** an effect, and it is separate
 * for the reason effects exist at all: it has an answer. Effects are
 * fire-and-forget precisely because nothing waits on them, and a catalogue nobody
 * can read is not a catalogue. It is awaited by a read-only command, so unlike
 * `run` it may reject — the caller is a dialog with somewhere to put the error.
 */
export interface ChatRuntime {
  run(effect: ChatEffect): void | Promise<void>
  listSessions(): Promise<ChatSessionsListResult>
  /**
   * Re-deliver one conversation to the window, for a mirror that started empty.
   *
   * Not a `ChatEffect`, and deliberately not: effects are planned by a reducer
   * as part of a Command that changed something. This changes nothing — it asks
   * for a repeat of what was already sent — and it answers, which effects never
   * do. It is the transcript's `STATE_SNAPSHOT`, not a command.
   *
   * `false` means main has nothing for that conversation, which is an answer and
   * not a failure: the window then shows an empty conversation because that is
   * what it is.
   */
  restore(chatId: ChatId): Promise<boolean>
}

/**
 * The stand-in used until the ACP adapter is wired up — the exact analogue of
 * `createUnavailableDeps`.
 *
 * It **succeeds silently** rather than throwing, because a chat effect is
 * fire-and-forget: throwing here could only produce an unhandled rejection, and
 * the state phase has already committed. A conversation on this runtime accepts
 * messages and never answers, which is a legible failure; `agentStatus` stays at
 * `starting` and the UI can say so.
 */
export function createUnavailableChatRuntime(): ChatRuntime {
  return {
    run: () => {
      // No agent process exists yet. Deliberately silent: see above.
    },
    // `supported: false` rather than a rejection, and it is the honest answer:
    // with no agent there is no catalogue, which is the same thing the dialog
    // says for an agent that keeps no history. Both render one sentence.
    listSessions: () => Promise.resolve({ sessions: [], supported: false, cwd: null }),
    // Nothing was ever sent, so there is nothing to re-send.
    restore: () => Promise.resolve(false),
  }
}

/* ================================================================== */
/* 2. Lookups                                                          */
/* ================================================================== */

/**
 * Narrow a view to a chat, failing with something more useful than "not found".
 *
 * The lookup is repeated here rather than reused from `shared.ts` to keep the
 * import one-directional: `shared.ts` needs `buildChatViewState` and
 * `stageChatAttachments` from this module, and a cycle between the two would work
 * by accident of hoisting rather than by design.
 */
export function requireChatView(draft: Draft<Workspace>, viewId: ViewId): Draft<ChatViewState> {
  const view = draft.views[viewId]
  if (!view) failMsg('NOT_FOUND', 'error.view.notFound', { viewId })
  if (view.kind !== 'chat') {
    failMsg('BAD_REQUEST', 'error.chat.notChatView', { viewId, kind: view.kind })
  }
  return view
}

/**
 * Find a conversation by its `ChatId`.
 *
 * The runtime holds `ChatId`s (it never sees view ids), and the Workspace is keyed
 * by `ViewId`, so every write-back starts here. A linear scan is right: a window
 * holds at most `MAX_LAYOUT_PANELS * MAX_PANEL_TABS` views, and an index would be
 * a second source of truth to keep consistent for no measurable gain.
 */
export function findChatView(ws: Workspace, chatId: ChatId): ChatViewState | undefined {
  for (const view of Object.values(ws.views)) {
    if (view.kind === 'chat' && view.chatId === chatId) return view
  }
  return undefined
}

function findChatDraft(draft: Draft<Workspace>, chatId: ChatId): Draft<ChatViewState> | undefined {
  for (const view of Object.values(draft.views)) {
    if (view.kind === 'chat' && view.chatId === chatId) return view
  }
  return undefined
}

/** Every conversation currently open, in `views` order. */
export function listChatViews(ws: Workspace): ChatViewState[] {
  return Object.values(ws.views).filter((v): v is ChatViewState => v.kind === 'chat')
}

/* ================================================================== */
/* 3. Effect staging                                                   */
/* ================================================================== */

/**
 * Effects planned by a reducer, awaiting `finalize`.
 *
 * Keyed by the `ReduceCtx`, which the bus creates fresh per dispatch and drops
 * afterwards — so a `WeakMap` needs no pruning and cannot leak when a reducer
 * throws between planning and finalizing. (It also cannot mix two concurrent
 * dispatches of the same command, which a `commandId`-keyed `Map` would only
 * manage by being cleaned up correctly on every failure path.)
 */
const staged = new WeakMap<ReduceCtx, ChatEffect[]>()

function planChat(ctx: ReduceCtx, effect: ChatEffect): void {
  const list = staged.get(ctx)
  if (list) list.push(effect)
  else staged.set(ctx, [effect])
}

function flushChat(ctx: ReduceCtx, runtime: ChatRuntime): void {
  const list = staged.get(ctx)
  if (!list) return
  staged.delete(ctx)
  for (const effect of list) {
    try {
      // Never awaited: the state has landed, and a turn takes as long as it takes.
      // See the header note — awaiting here is the deadlock.
      void Promise.resolve(runtime.run(effect)).catch((err: unknown) => {
        console.error('[peek/chat] runtime effect failed', effect.type, err)
      })
    } catch (err) {
      console.error('[peek/chat] runtime effect threw synchronously', effect.type, err)
    }
  }
}

/* ================================================================== */
/* 4. Attachments                                                      */
/* ================================================================== */

/**
 * Turn a caller's descriptor into a staged one, checking that what it points at
 * still exists.
 *
 * The check is the point. A descriptor is resolved into actual data only at send
 * time, so an unvalidated one fails minutes later inside the ACP adapter, where
 * the only honest thing it can do is tell the model "that attachment was broken".
 * Rejecting it here means the *human* who clicked "attach this result" is told
 * immediately, and a model gets a repairable error instead of a poisoned turn.
 */
function resolveAttachment(
  draft: Draft<Workspace>,
  spec: ChatAttachmentSpec,
  id: AttachmentId,
): ChatAttachment {
  switch (spec.kind) {
    case 'rows':
    case 'result':
    case 'cell':
    case 'cells': {
      const view = draft.views[spec.viewId]
      if (!view) failMsg('NOT_FOUND', 'error.chat.attachViewMissing', { viewId: spec.viewId })
      const meta = draft.results[spec.resultId]
      if (!meta) failMsg('NOT_FOUND', 'error.chat.attachResultMissing', { resultId: spec.resultId })
      // A result belongs to exactly one view. Catching the mismatch here is worth
      // a line: a model that pairs the right result with the wrong view would
      // otherwise get data that looks plausible and is from somewhere else.
      if (meta.viewId !== spec.viewId) {
        failMsg('BAD_REQUEST', 'error.chat.attachResultMismatch', {
          resultId: spec.resultId,
          viewId: spec.viewId,
        })
      }
      if (spec.kind === 'rows') {
        return {
          id,
          label: spec.label ?? `${String(spec.rowIndexes.length)} selected row(s)`,
          kind: 'rows',
          viewId: spec.viewId,
          resultId: spec.resultId,
          rowIndexes: [...spec.rowIndexes],
        }
      }
      if (spec.kind === 'result') {
        const maxRows = Math.min(spec.maxRows ?? DEFAULT_ATTACHMENT_ROWS, MAX_CHAT_ATTACHMENT_ROWS)
        return {
          id,
          label: spec.label ?? `Result of ${String(spec.viewId)} (up to ${String(maxRows)} rows)`,
          kind: 'result',
          viewId: spec.viewId,
          resultId: spec.resultId,
          maxRows,
        }
      }
      if (spec.kind === 'cell') {
        return {
          id,
          label: spec.label ?? `Cell ${spec.column}[${String(spec.rowIndex)}]`,
          kind: 'cell',
          viewId: spec.viewId,
          resultId: spec.resultId,
          rowIndex: spec.rowIndex,
          column: spec.column,
        }
      }
      // The row span is clamped rather than rejected, matching what the grid
      // already showed the user when it offered the attachment.
      const r1 = Math.min(spec.r1, spec.r0 + MAX_CHAT_ATTACHMENT_ROWS - 1)
      return {
        id,
        label: spec.label ?? `${String(spec.columns.length)} column(s) × ${String(r1 - spec.r0 + 1)} row(s)`,
        kind: 'cells',
        viewId: spec.viewId,
        resultId: spec.resultId,
        r0: spec.r0,
        r1,
        columns: [...spec.columns],
      }
    }

    case 'schema': {
      if (!draft.connections[spec.connId]) {
        failMsg('NOT_FOUND', 'error.chat.attachConnMissing', { connId: spec.connId })
      }
      const ref = plain(spec.ref)
      return {
        id,
        label: spec.label ?? `Schema of ${collectionRefLabel(ref)}`,
        kind: 'schema',
        connId: spec.connId,
        ref,
      }
    }

    case 'query': {
      const view = draft.views[spec.viewId]
      if (!view) failMsg('NOT_FOUND', 'error.chat.attachViewMissing', { viewId: spec.viewId })
      if (view.kind !== 'query') {
        failMsg('BAD_REQUEST', 'error.chat.attachNotQueryView', {
          viewId: spec.viewId,
          kind: view.kind,
        })
      }
      return { id, label: spec.label ?? 'Current statement', kind: 'query', viewId: spec.viewId }
    }

    case 'workspace':
      return { id, label: spec.label ?? 'What is on screen', kind: 'workspace' }
  }
}

/**
 * Whether two descriptors name the same thing.
 *
 * Used to make `chat.attach` idempotent: clicking "add this to the chat" twice is
 * a slip, not a request for two copies, and an agent that re-attaches after a
 * failed send should not accumulate duplicates. Ignores `id` and `label`, which
 * are decoration over the identity.
 */
function sameAttachment(a: ChatAttachment, b: ChatAttachment): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'rows': {
      const other = b as Extract<ChatAttachment, { kind: 'rows' }>
      return (
        a.viewId === other.viewId &&
        a.resultId === other.resultId &&
        a.rowIndexes.length === other.rowIndexes.length &&
        a.rowIndexes.every((n, i) => n === other.rowIndexes[i])
      )
    }
    case 'result': {
      const other = b as Extract<ChatAttachment, { kind: 'result' }>
      return a.viewId === other.viewId && a.resultId === other.resultId && a.maxRows === other.maxRows
    }
    case 'cell': {
      const other = b as Extract<ChatAttachment, { kind: 'cell' }>
      return (
        a.viewId === other.viewId &&
        a.resultId === other.resultId &&
        a.rowIndex === other.rowIndex &&
        a.column === other.column
      )
    }
    case 'cells': {
      const other = b as Extract<ChatAttachment, { kind: 'cells' }>
      return (
        a.viewId === other.viewId &&
        a.resultId === other.resultId &&
        a.r0 === other.r0 &&
        a.r1 === other.r1 &&
        a.columns.length === other.columns.length &&
        a.columns.every((c, i) => c === other.columns[i])
      )
    }
    case 'schema': {
      const other = b as Extract<ChatAttachment, { kind: 'schema' }>
      return a.connId === other.connId && collectionRefLabel(a.ref) === collectionRefLabel(other.ref)
    }
    case 'query': {
      const other = b as Extract<ChatAttachment, { kind: 'query' }>
      return a.viewId === other.viewId
    }
    case 'workspace':
      return true
  }
}

/**
 * Stage a batch of descriptors on a conversation, skipping duplicates.
 *
 * Exported because `view.open` can carry attachments on a `chat` spec — "open a
 * conversation about these rows" is one gesture, and making the caller follow the
 * open with a separate `chat.attach` would let the two land either side of an
 * await.
 */
export function stageChatAttachments(
  draft: Draft<Workspace>,
  view: Draft<ChatViewState>,
  specs: readonly ChatAttachmentSpec[],
  ctx: ReduceCtx,
): AttachmentId[] {
  const ids: AttachmentId[] = []
  for (const spec of specs) {
    const candidate = resolveAttachment(draft, spec, ctx.ids.attachment())
    const existing = plain(view.attachments).find((a) => sameAttachment(a, candidate))
    if (existing) {
      ids.push(existing.id)
      continue
    }
    if (view.attachments.length >= MAX_CHAT_ATTACHMENTS) {
      failMsg('CONFLICT', 'error.chat.tooManyAttachments', { max: MAX_CHAT_ATTACHMENTS })
    }
    view.attachments.push(candidate as Draft<ChatAttachment>)
    ids.push(candidate.id)
  }
  return ids
}

/* ================================================================== */
/* 5. Small state helpers                                              */
/* ================================================================== */

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

/**
 * What a conversation's status is when nothing is happening.
 *
 * `ready` means "an agent session exists and is waiting"; `idle` means "there is
 * no session yet". Keeping them apart is what lets the UI distinguish a first
 * message (which will take a second to spawn a process) from a follow-up.
 */
function restingStatus(view: { agentSessionId: string | null }): ChatAgentStatus {
  return view.agentSessionId === null ? 'idle' : 'ready'
}

function baseResult(view: Draft<ChatViewState>): {
  viewId: ViewId
  chatId: ChatId
  agentStatus: ChatAgentStatus
} {
  return { viewId: view.id, chatId: view.chatId, agentStatus: view.agentStatus }
}

/* ================================================================== */
/* 6. Handlers                                                         */
/* ================================================================== */

/**
 * The `chat.*` slice of the handler map, with every key **required** — so that
 * `coreHandlers` can keep proving `satisfies Required<CommandHandlerMap>`, and
 * adding a chat command without implementing it stays a compile error.
 */
export type ChatHandlerMap = Required<
  Pick<
    CommandHandlerMap,
    | 'chat.send'
    | 'chat.cancel'
    | 'chat.clear'
    | 'chat.attach'
    | 'chat.detach'
    | 'chat.respondPermission'
    | 'chat.setMode'
    | 'chat.sessions.list'
    | 'chat.sessions.delete'
  >
>

/**
 * Build the `chat.*` handlers against one runtime.
 *
 * A factory rather than a plain object because the runtime is injected at
 * assembly time, exactly as `CommandDeps` is — the bus must not import the ACP
 * adapter, or the handlers stop being unit-testable without spawning a real
 * agent process.
 */
export function createChatHandlers(runtime: ChatRuntime): ChatHandlerMap {
  /** Every chat handler finalizes the same way: hand the staged effects over, untouched. */
  const finalize = <T>(data: T, _state: Workspace, ctx: ReduceCtx): T => {
    flushChat(ctx, runtime)
    return data
  }

  return {
    'chat.send': {
      reduce(draft, input, ctx): ChatSendResult {
        const view = requireChatView(draft, input.viewId)

        // The whole concurrency argument in one place: this check and the write
        // below are in the same synchronous reducer, so two sends cannot both
        // pass it. See the header note.
        if (view.streamingMessageId !== null) failMsg('CONFLICT', 'error.chat.busy')
        if (view.pendingPermission) failMsg('CONFLICT', 'error.chat.awaitingPermission')

        // Inline attachments are staged first so they go through exactly the same
        // existence checks as the ones the user pinned earlier, and so a bad one
        // aborts the send before any state has been written.
        if (input.attachments && input.attachments.length > 0) {
          stageChatAttachments(draft, view, input.attachments, ctx)
        }

        // Sending into a conversation is the strongest "I am using this" there
        // is, so a provisional view stops being provisional here rather than
        // waiting for an explicit promote — nobody should have to remember to
        // pin a chat they have already typed into. See `ViewBase.provisional`.
        if (view.provisional === true) delete view.provisional

        const attachments = plain(view.attachments)
        const messageId = ctx.ids.chatMessage()
        const text = input.text

        view.streamingMessageId = messageId
        // `starting` while there is no session yet: the first turn has to spawn a
        // process, and reporting that honestly is the difference between "slow"
        // and "broken" to whoever is watching the panel.
        view.agentStatus = view.agentSessionId === null ? 'starting' : 'streaming'
        view.messageCount += 1
        view.lastMessagePreview = preview(text)
        // Staged context is consumed by the turn it was staged for. Leaving it
        // pinned would silently re-send the same rows on every following message.
        view.attachments = []

        planChat(ctx, { type: 'prompt', chatId: view.chatId, messageId, text, attachments })
        return { ...baseResult(view), messageId, attachments }
      },
      finalize,
    },

    'chat.cancel': {
      reduce(draft, input, ctx): ChatCancelResult {
        const view = requireChatView(draft, input.viewId)
        const messageId = view.streamingMessageId
        // "Something is waiting on a person" — a permission prompt or a question
        // the agent asked. Either one makes this a real cancel rather than a
        // no-op, and the question case is not hypothetical: a conversation
        // suspended on `chat.ask` has no `streamingMessageId` and is not in a
        // busy status, so without this half the stop button would report
        // "nothing to stop" at precisely the moment the user most wants out.
        const wasPending = view.pendingPermission !== undefined || view.pendingQuestion !== undefined
        // A turn can be live with no `streamingMessageId` on it: this reducer
        // clears the field, so the *second* press of a stop button would
        // otherwise be swallowed while the first cancel was still travelling —
        // and during agent startup the first one has nothing to cancel yet.
        // `agentStatus` is what still says a turn is in flight.
        const busy = view.agentStatus === 'starting' || view.agentStatus === 'streaming'

        if (messageId === null && !wasPending && !busy) {
          // Nothing to stop. A no-op, reported as one — the same contract
          // `query.cancel` has.
          return { ...baseResult(view), cancelled: false, messageId: null }
        }

        view.streamingMessageId = null
        // The turn is being abandoned, so the question it was blocked on is moot.
        // Leaving the prompt up would strand the UI on a decision that can no
        // longer have an effect.
        delete view.pendingPermission
        // Same for a question the agent asked: the tool call waiting on it is
        // being cancelled with the turn. `watchQuestions` sees the field go and
        // settles the broker entry, which is what stops the suspended `chat.ask`
        // from hanging until its five-minute timeout.
        delete view.pendingQuestion
        view.agentStatus = restingStatus(view)

        planChat(ctx, { type: 'cancel', chatId: view.chatId, messageId })
        return { ...baseResult(view), cancelled: true, messageId }
      },
      finalize,
    },

    'chat.clear': {
      reduce(draft, input, ctx): ChatClearResult {
        const view = requireChatView(draft, input.viewId)
        const clearedMessages = view.messageCount
        const streaming = view.streamingMessageId

        // "Start over" is pressed exactly when the current turn has gone wrong, so
        // it stops the turn rather than refusing until the user stops it himself.
        if (streaming !== null) {
          planChat(ctx, { type: 'cancel', chatId: view.chatId, messageId: streaming })
        }

        view.streamingMessageId = null
        delete view.pendingPermission
        delete view.pendingQuestion
        delete view.lastMessagePreview
        delete view.usage
        view.messageCount = 0
        view.attachments = []
        view.agentStatus = restingStatus(view)

        planChat(ctx, { type: 'clear', chatId: view.chatId })
        return { ...baseResult(view), clearedMessages, cancelledTurn: streaming !== null }
      },
      finalize,
    },

    'chat.attach': {
      reduce(draft, input, ctx): ChatAttachResult {
        const view = requireChatView(draft, input.viewId)
        const attachmentIds = stageChatAttachments(draft, view, input.attachments, ctx)
        // No effect: staging changes nothing the agent can see. Descriptors are
        // materialised at send time, which is the whole reason they are descriptors.
        return { ...baseResult(view), attachmentIds, attachments: plain(view.attachments) }
      },
    },

    'chat.detach': {
      reduce(draft, input): ChatDetachResult {
        const view = requireChatView(draft, input.viewId)
        const staged = plain(view.attachments)

        if (input.attachmentIds === undefined) {
          view.attachments = []
          return {
            ...baseResult(view),
            removedIds: staged.map((a) => a.id),
            attachments: [],
          }
        }

        // Naming an attachment that is not staged is an error, not a no-op: the
        // caller believes it is holding a live id, and silently succeeding would
        // let it keep believing that.
        const wanted = new Set<string>(input.attachmentIds)
        for (const id of input.attachmentIds) {
          if (!staged.some((a) => a.id === id)) {
            failMsg('NOT_FOUND', 'error.chat.attachmentNotStaged', { attachmentId: id })
          }
        }
        view.attachments = staged.filter((a) => !wanted.has(a.id)) as Draft<ChatAttachment[]>
        return {
          ...baseResult(view),
          removedIds: staged.filter((a) => wanted.has(a.id)).map((a) => a.id),
          attachments: plain(view.attachments),
        }
      },
    },

    'chat.respondPermission': {
      reduce(draft, input, ctx): ChatRespondPermissionResult {
        /*
         * The second place `source` decides an outcome, and the reason it had to
         * become a real value rather than a comment.
         *
         * `control_chat answer_permission` exists for an operator driving peek
         * from outside — its own tool description says so, and adds that if a
         * person is sitting at the window the prompt is already in front of them
         * and is theirs to answer. peek's *own* embedded panel is neither of
         * those, so it has no legitimate use for this at all.
         *
         * What made it reachable: once a human puts one conversation into
         * `dontAsk` or `bypassPermissions`, that panel's agent stops being asked
         * before its `mcp__peek__*` calls — and nothing here looked at who was
         * calling. It could then answer the prompt a *different* conversation was
         * blocked on. The human authorised "stop asking me about **this**
         * conversation"; the effect reached the whole window.
         *
         * Refused unconditionally rather than only for a foreign viewId: all
         * embedded panels share one credential, so "its own" is not a question
         * main can answer — and a rule that does not depend on state is a rule
         * that cannot be manoeuvred into a state where it lapses.
         *
         * See design/2026-08-02-agent-source-and-permission-scope.md §2.3.
         */
        if (ctx.source === 'agent') {
          failMsg('BAD_REQUEST', 'error.chat.permissionNotAnswerableByAgent')
        }

        const view = requireChatView(draft, input.viewId)
        const pending = plain(view.pendingPermission)
        if (!pending) failMsg('CONFLICT', 'error.chat.noPendingPermission')

        // The stale-answer race, refused rather than resolved: a turn can raise a
        // second permission request while a human is still reading the first, and
        // an unqualified answer would then approve whatever is being asked *now*.
        if (input.requestId !== undefined && input.requestId !== pending.requestId) {
          failMsg('CONFLICT', 'error.chat.permissionStale', {
            requestId: input.requestId,
            actual: pending.requestId,
          })
        }

        if (!pending.options.some((o) => o.optionId === input.optionId)) {
          failMsg('BAD_REQUEST', 'error.chat.permissionOptionUnknown', {
            optionId: input.optionId,
            options: pending.options.map((o) => o.optionId).join(', '),
          })
        }

        delete view.pendingPermission
        // Answering resumes the turn it blocked — unless the turn is already gone,
        // in which case the answer is harmless and the conversation is simply idle.
        view.agentStatus = view.streamingMessageId === null ? restingStatus(view) : 'streaming'

        planChat(ctx, {
          type: 'permission',
          chatId: view.chatId,
          requestId: pending.requestId,
          optionId: input.optionId,
        })
        return {
          ...baseResult(view),
          requestId: pending.requestId,
          optionId: input.optionId,
          toolName: pending.toolName,
        }
      },
      finalize,
    },

    'chat.setMode': {
      reduce(draft, input, ctx): ChatSetModeResult {
        const view = requireChatView(draft, input.viewId)

        // The one place `source` changes an outcome, and it is a rule about who
        // may ask rather than a second code path: a model must not be able to
        // switch off the prompt that lets a human veto it.
        if (ctx.source !== 'ui' && HUMAN_ONLY_MODES.has(input.mode)) {
          failMsg('BAD_REQUEST', 'error.chat.modeNotAllowed', {
            mode: input.mode,
            source: ctx.source,
          })
        }

        const previousMode = view.permissionMode
        view.permissionMode = input.mode
        // Cleared even when the mode is unchanged: someone just decided on it
        // for this conversation, and that is what the flag reports.
        view.permissionModeInherited = false
        if (previousMode !== input.mode) {
          planChat(ctx, { type: 'setMode', chatId: view.chatId, mode: input.mode })
        }
        return { ...baseResult(view), mode: input.mode, previousMode }
      },
      finalize,
    },

    /**
     * The catalogue. A `read`, so no rev bump and no patch broadcast — the list
     * belongs to the agent and is never mirrored into the Workspace.
     *
     * It is also the one command in peek whose read stage does I/O, which is why
     * `CommandReader` may return a promise at all; the note there explains why the
     * same licence is not extended to reducers.
     */
    'chat.sessions.list': {
      read: (): Promise<ChatSessionsListResult> => runtime.listSessions(),
    },

    /**
     * Delete a stored conversation.
     *
     * A `reduce` despite changing nothing in the Workspace, because the guard it
     * has to make is a question about Workspace state — is anybody reading this
     * conversation right now? — and asking that inside the synchronous state
     * phase is what makes the answer trustworthy. A `read` would have to look at
     * a snapshot and could be overtaken by a view opening underneath it.
     */
    'chat.sessions.delete': {
      reduce(draft, input, ctx): ChatSessionsDeleteResult {
        const open = Object.values(draft.views).find(
          (view) => view.kind === 'chat' && view.resumeSessionId === input.sessionId,
        )
        if (open) {
          failMsg('CONFLICT', 'error.chat.sessionOpen', {
            sessionId: input.sessionId,
            viewId: open.id,
          })
        }
        planChat(ctx, { type: 'sessions.delete', sessionId: input.sessionId })
        return { sessionId: input.sessionId }
      },
      finalize,
    },
  }
}

/* ================================================================== */
/* 7. Write-back: main's own event path                                */
/* ================================================================== */

/** A streamed usage report, or the absence of one. */
export interface ChatTurnEnd {
  messageId: ChatMessageId
  /** ACP's `StopReason`, plus `error` for a turn that never reached one. */
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'
  /** First line of the agent's reply, for the tab title and `describeView`. */
  preview?: string
  error?: PeekError
}

/**
 * The one place ACP stream events write back into the source of truth — the exact
 * counterpart of `createResultEventSink`.
 *
 * Every method is **keyed by `ChatId` and tolerant of a missing conversation**.
 * That is not defensiveness for its own sake: the user can close a chat view
 * mid-turn, and the agent's notifications keep arriving until the process
 * actually stops. Silently dropping them is correct — the conversation the event
 * describes no longer exists.
 *
 * Everything here is `source: 'system'`, so the command log distinguishes "the
 * agent said something" from "someone asked for something".
 */
export interface ChatEventSink {
  /** `session/new` returned. */
  onSessionReady(chatId: ChatId, agentSessionId: string): void
  onStatus(chatId: ChatId, status: ChatAgentStatus): void
  /** The agent asked a human to approve a tool call. */
  onPermissionRequested(chatId: ChatId, pending: PendingPermission): void
  /** The request was withdrawn or answered elsewhere (the agent gave up, the session died). */
  onPermissionResolved(chatId: ChatId, requestId: string): void
  /**
   * The agent asked the user a question and is waiting on it (the `ask` tool).
   *
   * `null` means "no longer waiting" — answered, timed out, or cancelled. One
   * method for both directions, unlike the permission pair above, because
   * `QuestionBroker.onActive` is itself one callback that reports *what this
   * chat should be showing now*: with a queue, "the previous one was answered"
   * and "here is the next one" are the same event, and splitting them into two
   * sink calls would put the two halves of one fact in different places.
   */
  onQuestionActive(chatId: ChatId, pending: PendingQuestion | null): void
  /** A message was appended to the transcript; the Workspace keeps only the count and a preview. */
  onMessageAppended(chatId: ChatId, messageId: ChatMessageId, previewText: string): void
  onTurnEnded(chatId: ChatId, end: ChatTurnEnd): void
  onUsage(chatId: ChatId, usage: ChatUsage): void
  /** The agent process died, or a turn failed outside the protocol. */
  onAgentError(chatId: ChatId, error: PeekError): void
  /** The session is gone; a following turn has to bring a new one up. */
  onSessionClosed(chatId: ChatId): void
}

export function createChatEventSink(store: WorkspaceStore): ChatEventSink {
  const meta = { source: 'system' as const }

  const edit = (chatId: ChatId, fn: (view: Draft<ChatViewState>) => void): void => {
    // Read before writing so a notification for a closed conversation costs no
    // rev bump and no patch broadcast. A stream that keeps arriving after the
    // view is gone would otherwise churn the renderer for nothing.
    if (findChatView(store.getState(), chatId) === undefined) return
    store.apply((draft) => {
      const view = findChatDraft(draft, chatId)
      if (view) fn(view)
    }, meta)
  }

  return {
    onSessionReady(chatId, agentSessionId) {
      edit(chatId, (view) => {
        view.agentSessionId = agentSessionId
        // A session coming up mid-turn keeps the turn: `chat.send` set
        // `starting` precisely because it knew a process had to be spawned.
        if (view.agentStatus === 'starting' && view.streamingMessageId === null) {
          view.agentStatus = 'ready'
        } else if (view.agentStatus === 'starting') {
          view.agentStatus = 'streaming'
        }
      })
    },

    onStatus(chatId, status) {
      edit(chatId, (view) => {
        view.agentStatus = status
      })
    },

    onPermissionRequested(chatId, pending) {
      edit(chatId, (view) => {
        view.pendingPermission = pending as Draft<PendingPermission>
        view.agentStatus = 'awaiting-permission'
      })
    },

    onPermissionResolved(chatId, requestId) {
      edit(chatId, (view) => {
        // Guarded by id: a late resolution for a request that has already been
        // replaced must not dismiss the prompt the user is currently reading.
        if (view.pendingPermission?.requestId !== requestId) return
        delete view.pendingPermission
        view.agentStatus = view.streamingMessageId === null ? restingStatus(view) : 'streaming'
      })
    },

    onQuestionActive(chatId, pending) {
      edit(chatId, (view) => {
        if (pending === null) {
          delete view.pendingQuestion
          // Same restoration as a resolved permission: the turn this was
          // blocking resumes, unless it is already gone — in which case the
          // conversation is simply idle and the answer was harmless.
          if (view.agentStatus === 'awaiting-answer') {
            view.agentStatus = view.streamingMessageId === null ? restingStatus(view) : 'streaming'
          }
          return
        }
        view.pendingQuestion = pending as Draft<PendingQuestion>
        view.agentStatus = 'awaiting-answer'
      })
    },

    onMessageAppended(chatId, _messageId, previewText) {
      edit(chatId, (view) => {
        view.messageCount += 1
        view.lastMessagePreview = preview(previewText)
      })
    },

    onTurnEnded(chatId, end) {
      edit(chatId, (view) => {
        // Only the turn that is actually in flight may end it. Without this, a
        // late `end` for a turn the user already cancelled would clear the
        // *next* turn's streaming state.
        if (view.streamingMessageId !== null && view.streamingMessageId !== end.messageId) return
        view.streamingMessageId = null
        if (end.preview !== undefined) view.lastMessagePreview = preview(end.preview)
        if (end.stopReason === 'error') {
          view.agentStatus = 'error'
          if (end.error) view.error = end.error
        } else {
          view.agentStatus = restingStatus(view)
          delete view.error
        }
      })
    },

    onUsage(chatId, usage) {
      edit(chatId, (view) => {
        view.usage = usage
      })
    },

    onAgentError(chatId, error) {
      edit(chatId, (view) => {
        view.agentStatus = 'error'
        view.error = error
        // The text already streamed stays in the transcript and stays valid; what
        // ends is the turn. Clearing this is what re-enables the composer.
        view.streamingMessageId = null
        delete view.pendingPermission
      })
    },

    onSessionClosed(chatId) {
      edit(chatId, (view) => {
        view.agentSessionId = null
        view.streamingMessageId = null
        delete view.pendingPermission
        if (view.agentStatus !== 'error') view.agentStatus = 'idle'
      })
    },
  }
}

/* ================================================================== */
/* 8. Lifecycle: conversations appearing and disappearing              */
/* ================================================================== */

/**
 * Keep the runtime's set of agent sessions in step with the set of chat views.
 *
 * Deliberately a **store subscription rather than a hook in `view.close`**. A chat
 * view can vanish through at least four routes — `view.close`, `layout.close`,
 * `layout.setLayout` with `unplaced: 'close'`, and (once a chat can be bound to a
 * connection) `conn.close` — and a handler-side hook would have to be added to
 * each of them and kept there. Watching the state answers "which conversations
 * exist" once, for every route, including ones added later.
 *
 * Returns an unsubscribe function; call it during shutdown.
 */
export function watchChatViews(store: WorkspaceStore, runtime: ChatRuntime): () => void {
  const known = new Map<ChatId, ViewId>()

  const sync = (ws: Workspace): void => {
    const live = new Map<ChatId, ChatViewState>()
    for (const view of listChatViews(ws)) live.set(view.chatId, view)

    for (const [chatId, view] of live) {
      if (known.has(chatId)) continue
      known.set(chatId, view.id)
      void runtime.run({
        type: 'session.open',
        chatId,
        viewId: view.id,
        ...(view.resumeSessionId === undefined ? {} : { resumeSessionId: view.resumeSessionId }),
      })
    }
    for (const chatId of [...known.keys()]) {
      if (live.has(chatId)) continue
      known.delete(chatId)
      void runtime.run({ type: 'session.close', chatId })
    }
  }

  sync(store.getState())
  return store.subscribe((_change, state) => {
    sync(state)
  })
}

/**
 * Build the `ChatViewState` a freshly opened chat view starts in.
 *
 * Lives here rather than in `shared.ts`'s `buildViewState` because everything it
 * decides is chat policy: that a new conversation has no agent session yet, and
 * that it starts in `default` (ask a human) rather than in the agent's own default
 * of `auto` (a classifier decides). The agent's default is a reasonable one for a
 * coding session in a terminal and an indefensible one for something wired
 * directly into the window a person is reading.
 */
export function buildChatViewState(
  id: ViewId,
  chatId: ChatId,
  spec: {
    connId?: ChatViewState['connId']
    permissionMode?: ChatPermissionMode
    title?: string
    resumeSessionId?: string
  },
): ChatViewState {
  const resuming = spec.resumeSessionId !== undefined
  return {
    id,
    kind: 'chat',
    status: 'idle',
    chatId,
    agentSessionId: null,
    // A resumed conversation starts at `loading`, not `idle`, and it is set here
    // rather than left for the runtime to patch: the view is rendered the instant
    // this object lands, and one frame of "no messages yet" under a conversation
    // the user just picked from a list reads as an empty chat, not a loading one.
    agentStatus: resuming ? 'loading' : 'idle',
    permissionMode: spec.permissionMode ?? 'default',
    // `spec.permissionMode` only ever comes from the user's settings — the panel
    // sets a mode through `chat.setMode`, never by building a view. So its
    // presence *is* the inheritance, and there is nothing else to consult.
    permissionModeInherited: spec.permissionMode !== undefined,
    streamingMessageId: null,
    messageCount: 0,
    attachments: [],
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.connId === undefined ? {} : { connId: spec.connId }),
    ...(spec.resumeSessionId === undefined ? {} : { resumeSessionId: spec.resumeSessionId }),
  }
}

/** Narrow a `ViewState` to a chat without repeating the discriminant test everywhere. */
export function isChatView(view: ViewState): view is ChatViewState {
  return view.kind === 'chat'
}
