/**
 * Where the chat panel's four halves are joined (PLAN sections 3 and 6).
 *
 * The ACP host, the `chat.*` command handlers and the context builder were each
 * written against an interface rather than against one another, which is what
 * kept them independently testable. This module supplies the three
 * implementations that close the loop, and it is the **only** place that knows
 * all of them at once:
 *
 *   - `createChatStateApplier` — the ACP host's control-plane write-back;
 *   - `createContextSource`    — how an attachment descriptor reaches real data;
 *   - `createAcpChatRuntime`   — how a `ChatEffect` becomes an agent call.
 *
 * It lives beside `index.ts` rather than inside `acp/` on purpose: `acp/` must
 * not import the WorkspaceStore, the Command Bus or the ConnectionManager, or it
 * could no longer be exercised without an Electron app and a database. The
 * dependency arrow points this way and only this way.
 */

import type { WebContents } from 'electron'
import type {
  ChatAgentStatus,
  ChatDelta,
  ChatId,
  ChatPermissionMode,
  ChatSessionsListResult,
  ChatViewState,
  NotifyMessage,
  PeekError,
  ViewId,
  ViewState,
  Workspace,
  WorkspaceSnapshot,
} from '@peek/core'
import { toPeekError } from '@peek/core'
import type { Draft } from 'immer'
import type { AcpManager } from './acp'
import { profileById } from './acp'
import type { SessionIndex, SessionRoute } from './agent/session-index'
import type { EndpointManager } from './agent/endpoint/loop'
import type { ChatAgentStatePatch } from './acp'
import { resolveAttachments, type ContextSource, type TabularSlice } from './agent/context'
import type { ChatEffect, ChatRuntime } from './bus/handlers'
import { findChatView } from './bus/handlers'
import type { ConnectionManager } from './connections'
import type { ResultRowsBroker } from './result-rows'
import type { WorkspaceStore } from './store'

/* ================================================================== */
/* 1. Control plane: the agent's state write-back                      */
/* ================================================================== */

/**
 * Apply one `ChatAgentStatePatch` to the source of truth.
 *
 * ## Why this is a store write and not a Command
 *
 * `acp/index.ts` sketches this as `dispatch('chat.agentState', …)`. There is no
 * such command, and adding one would be the wrong shape: these patches are
 * **events from a subprocess reporting what already happened**, not requests to
 * change something. peek already has a precedent for exactly that, and it is
 * `createResultEventSink` — driver-host events (schema arrived, rows progressed,
 * the result failed) write straight into the store under `source: 'system'`
 * rather than round-tripping through the bus. A streaming agent is the same
 * class of thing as a streaming result set.
 *
 * Keeping it out of the command table also keeps it out of `COMMAND_NAMES`,
 * which is what the MCP tool surface is derived from — so no agent can forge its
 * own status, permission mode or pending-permission record by calling a tool.
 * The only writer is the ACP host, in-process.
 *
 * `undefined` means "leave alone"; `null` on a nullable field means "clear it".
 */
export function createChatStateApplier(
  store: WorkspaceStore,
  announce?: TurnAnnouncer,
): (patch: ChatAgentStatePatch) => Promise<void> {
  return (patch) => {
    // Read before writing: a patch for a conversation whose view has been closed
    // costs no rev bump and no patch broadcast. Notifications keep arriving until
    // the agent process actually stops, and churning the renderer for a view that
    // no longer exists is pure waste.
    const before = findChatView(store.getState(), patch.chatId)
    if (before === undefined) return Promise.resolve()
    const previousStatus = before.agentStatus

    store.apply(
      (draft) => {
        const view = findChatDraft(draft, patch.chatId)
        if (!view) return

        if (patch.status !== undefined) view.agentStatus = patch.status
        if (patch.agentSessionId !== undefined) view.agentSessionId = patch.agentSessionId
        if (patch.permissionMode !== undefined) view.permissionMode = patch.permissionMode
        if (patch.streamingMessageId !== undefined) view.streamingMessageId = patch.streamingMessageId
        if (patch.messageCount !== undefined) view.messageCount = patch.messageCount
        if (patch.lastMessagePreview !== undefined) view.lastMessagePreview = patch.lastMessagePreview
        if (patch.usage !== undefined) view.usage = patch.usage
        // Absent rather than `false`, so a view that never showed a picture does
        // not carry a field saying it is not showing one.
        if (patch.showingSnapshot !== undefined) {
          if (patch.showingSnapshot) view.showingSnapshot = true
          else delete view.showingSnapshot
        }
        if (patch.pendingPermission !== undefined) {
          if (patch.pendingPermission === null) delete view.pendingPermission
          else view.pendingPermission = patch.pendingPermission as Draft<typeof patch.pendingPermission>
        }
        // A turn that reaches a resting state has nothing left to report as broken.
        if (patch.status !== undefined && patch.status !== 'error') delete view.error
      },
      { source: 'system' },
    )

    // After the write, and from the store rather than from the patch: what the
    // user should be told about is the conversation's state, and the patch is
    // only the part of it that changed. A `status` that arrives without a
    // `lastMessagePreview` still has one, from the delta that landed before it.
    if (announce !== undefined && patch.status !== undefined) {
      const after = findChatView(store.getState(), patch.chatId)
      const notice = after === undefined ? null : turnNotice(previousStatus, after)
      if (notice !== null) announce(notice)
    }

    return Promise.resolve()
  }
}

/* ------------------------------------------------------------------ */
/* "It is your turn now"                                               */
/* ------------------------------------------------------------------ */

/**
 * A turn that has stopped needing the agent and started needing the user.
 *
 * Three kinds, because there are three ways a person's attention becomes the
 * thing the conversation is waiting on, and they read differently on a lock
 * screen: the agent answered; the agent is blocked on a permission; the agent
 * asked a question and is holding a tool call open until it gets an answer.
 */
export interface TurnNotice {
  viewId: ViewId
  /** The tab title, when the conversation has one. */
  label?: string
  kind: 'replied' | 'permission' | 'question'
  /** First ~200 chars of the reply, for `kind: 'replied'`. */
  preview?: string
  /** The tool waiting for a decision, for `kind: 'permission'`. */
  toolName?: string
  /** What was asked, for `kind: 'question'`. */
  question?: string
}

export type TurnAnnouncer = (notice: TurnNotice) => void

/** Statuses that mean the agent is working, i.e. that nothing is expected of the user. */
const BUSY: ReadonlySet<ChatAgentStatus> = new Set<ChatAgentStatus>(['starting', 'streaming'])
/** Statuses that mean the turn is over. */
const RESTING: ReadonlySet<ChatAgentStatus> = new Set<ChatAgentStatus>(['idle', 'ready'])

/**
 * Decide whether this state change is worth interrupting someone for.
 *
 * **A transition, not a state.** `ready` on its own says nothing — a panel sits
 * in it for as long as nobody types. What is worth a notification is the
 * *moment* it stopped being the agent's turn, and that moment is exactly one
 * patch wide.
 *
 * Which is also why `loading → ready` is not it. Opening a stored conversation
 * replays its history through this same applier (see `ChatAgentStatus`), and it
 * ends in `ready` having answered nothing: a user who clicked a session in the
 * rail does not need to be told their click worked.
 *
 * `error` is left out too. A failed turn already surfaces in the panel and in
 * the error centre, and "the agent crashed" is not news the way "the agent is
 * waiting for you" is. That is a judgement, and reversing it means adding one
 * line here.
 *
 * Exported for its own test: the whole feature's noise budget is this function.
 */
export function turnNotice(previous: ChatAgentStatus, view: ChatViewState): TurnNotice | null {
  if (!BUSY.has(previous)) return null
  const base = {
    viewId: view.id,
    ...(view.title === undefined || view.title.trim() === '' ? {} : { label: view.title.trim() }),
  }
  if (RESTING.has(view.agentStatus)) {
    return {
      ...base,
      kind: 'replied',
      ...(view.lastMessagePreview === undefined ? {} : { preview: view.lastMessagePreview }),
    }
  }
  if (view.agentStatus === 'awaiting-permission') {
    return {
      ...base,
      kind: 'permission',
      ...(view.pendingPermission === undefined ? {} : { toolName: view.pendingPermission.toolName }),
    }
  }
  // The third "your turn", and the one with a clock on it: an unanswered
  // question expires after five minutes and the agent then carries on without
  // it. Being told late about a finished turn costs nothing; being told late
  // about this costs the answer.
  if (view.agentStatus === 'awaiting-answer') {
    return {
      ...base,
      kind: 'question',
      ...(view.pendingQuestion === undefined ? {} : { question: view.pendingQuestion.question }),
    }
  }
  return null
}

/**
 * A `TurnNotice` as something to read on a lock screen.
 *
 * Separate from `turnNotice` so that "is this worth saying" and "how is it said"
 * can be read, and changed, apart. English for the reason given atop
 * `notifications.ts`: main has no language.
 */
export function describeTurnNotice(notice: TurnNotice): { message: string; detail?: string } {
  const subject = notice.label === undefined ? 'The agent' : `${notice.label}: the agent`
  if (notice.kind === 'question') {
    return {
      message: `${subject} is asking you something`,
      // The question itself, because it is short by construction (300 chars in
      // the schema) and because a banner saying only "it asked something" makes
      // the person open the window to find out whether it was worth opening.
      ...(notice.question === undefined ? {} : { detail: notice.question }),
    }
  }
  if (notice.kind === 'permission') {
    return {
      message: `${subject} needs your decision`,
      detail:
        notice.toolName === undefined
          ? 'A tool call is waiting for permission.'
          : `${notice.toolName} is waiting for permission.`,
    }
  }
  return {
    message: `${subject} has replied`,
    ...(notice.preview === undefined ? {} : { detail: notice.preview }),
  }
}

function findChatDraft(draft: Draft<Workspace>, chatId: ChatId): Draft<ChatViewState> | undefined {
  for (const view of Object.values(draft.views)) {
    if (view.kind === 'chat' && view.chatId === chatId) return view
  }
  return undefined
}

/* ================================================================== */
/* 2. Context: descriptors → real data                                 */
/* ================================================================== */

export interface ContextSourceDeps {
  store: WorkspaceStore
  connections: ConnectionManager
  rows: ResultRowsBroker
}

/**
 * The port `acp/context` reads through.
 *
 * Two of the four members are synchronous map lookups into main's own state; the
 * other two leave the process, and each leaves it by the route that data already
 * travels. Rows are the interesting case: PLAN section 3 has result chunks going
 * from the driver host to the renderer over a MessagePort, so **main never holds
 * them** — the one process that has to serialise "the rows the user selected" is
 * the one process without them. `ResultRowsBroker` is the existing answer (MCP's
 * `run_query` already samples rows this way) and it is reused here rather than
 * duplicated.
 */
export function createContextSource(deps: ContextSourceDeps): ContextSource {
  const { store, connections, rows } = deps

  return {
    async readResultRows(req): Promise<TabularSlice> {
      const offset = req.offset ?? 0
      // The broker reads from the head of the cache and has no offset of its own,
      // so a windowed read becomes "take offset+limit, drop the head". Callers are
      // already bounded by `MAX_ROW_SPAN` in resolve.ts, which is what stops this
      // from hauling an entire result set through IPC to serialise ten rows.
      const slice = await rows.read({
        resultId: req.resultId,
        limit: offset + req.limit,
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      })
      const windowed = offset > 0 ? slice.rows.slice(offset) : slice.rows
      return {
        columns: slice.columns,
        rows: windowed,
        totalRows: slice.totalRows,
        truncated: slice.truncated,
      }
    },

    describeCollection(req) {
      return connections.describeCollection(req.connId, req.ref)
    },

    peekValue(req) {
      return connections.peekValue(req.connId, req.ref)
    },

    readView(viewId: ViewId): ViewState | null {
      return store.getState().views[viewId] ?? null
    },

    getSnapshot(): WorkspaceSnapshot {
      // Already redacted by `snapshotWorkspace` — the same object `read_workspace`
      // returns. A `workspace` attachment therefore cannot carry a password into
      // a prompt, and that is enforced by the type rather than by care here.
      return store.getSnapshot()
    },
  }
}

/* ================================================================== */
/* 3. Effects → agent calls                                            */
/* ================================================================== */

export interface ChatRuntimeDeps {
  manager: AcpManager
  source: ContextSource
  notify(message: NotifyMessage): void
  /** Report a failure back onto the conversation the user is looking at. */
  onError(chatId: ChatId, error: PeekError): void
  /** Routes conversations to their backend, and names the agent on each row. Optional; see `AcpHostDeps.sessionIndex`. */
  sessionIndex?: SessionIndex
  /**
   * The mode a conversation opening right now starts in.
   *
   * The same thunk the backend itself holds, so the mode a new view *shows* and
   * the mode its session is eventually created in are one answer read twice
   * rather than two answers that agree by luck. See `session.open`.
   */
  startingMode: () => ChatPermissionMode
}

/**
 * How a route reads on a session row.
 *
 * ACP conversations are named by their profile; endpoint conversations by the
 * model they were started with, which is the closest thing that backend has to
 * an agent identity. `profileById` is asked rather than the raw id so the row
 * says "Claude Code", not "claude-code".
 */
function agentDisplayName(route: SessionRoute): string {
  return route.backend === 'acp' ? profileById(route.agentId).displayName : route.agentId
}

/**
 * Say why a conversation would not load, when the honest answer is "it is gone".
 *
 * peek keeps no copy of an ACP transcript — the agent owns it — and agents
 * delete their own history on their own schedule. Claude Code's
 * `cleanupPeriodDays` defaults to 30 days, so a conversation from last month is
 * *expected* to be unloadable, and forwarding the agent's raw protocol error for
 * it tells the user nothing they can act on.
 *
 * Asking the catalogue is what separates the two cases. A session id the agent
 * still lists but cannot load is a real failure and the original error is the
 * useful one; a session id it no longer lists has been cleaned up, and that is
 * worth a sentence naming the mechanism rather than the symptom.
 *
 * The catalogue lookup can itself fail — the agent may be the thing that is
 * broken — and then the original error stands. Never a *worse* message than the
 * one that came in.
 *
 * The row does not need removing from the sessions rail: that list is read from
 * `session/list`, so a conversation the agent has forgotten is already absent
 * from the next read.
 */
async function explainLoadFailure(manager: AcpManager, sessionId: string, raw: unknown): Promise<PeekError> {
  const original = toPeekError(raw)
  try {
    const catalogue = await manager.listSessions()
    if (!catalogue.supported) return original
    if (catalogue.sessions.some((s) => s.sessionId === sessionId)) return original
  } catch {
    return original
  }
  return {
    code: 'NOT_FOUND',
    message: 'This conversation’s history is gone.',
    detail:
      'The agent deleted it — Claude Code removes stored conversations after 30 days by default ' +
      '(`cleanupPeriodDays` in ~/.claude/settings.json). peek does not keep its own copy of an ' +
      'agent’s history, so there is nothing to restore. You can start a new conversation.',
    retryable: false,
  }
}

/**
 * Turn the `ChatEffect`s a reducer planned into calls on the ACP host.
 *
 * **Nothing here is awaited by the bus, and nothing here may reject.** The state
 * phase has already committed by the time an effect arrives, so a rejection could
 * only surface as an unhandled promise rejection — invisible to the user and
 * useless to a developer. Every failure path therefore ends at `onError`, which
 * puts the error on the conversation where somebody will actually see it.
 *
 * The `prompt` case is the one with real work in it: attachments arrive as
 * descriptors and have to be materialised before they can be sent, which means
 * awaiting the renderer's result cache. That await happens **here, before
 * `manager.send`**, and never inside an ACP request handler — main's event loop
 * is on the critical path of the agent's own MCP calls back into peek, and
 * blocking it during a turn is the one deadlock this design has to avoid.
 */
export function createAcpChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  const { manager, source, notify, onError, sessionIndex, startingMode } = deps

  const fail = (chatId: ChatId, raw: unknown, what: string): void => {
    const error = toPeekError(raw)
    console.error('[peek/chat]', what, error.message)
    onError(chatId, error)
  }

  return {
    run(effect: ChatEffect): void {
      switch (effect.type) {
        case 'session.open':
          // Sessions are created lazily on the first prompt: spawning an agent
          // process the moment a panel opens would cost every user who opens one
          // and never types. `watchChatViews` still reports the open so the
          // runtime could pre-warm; deliberately, it does not.
          //
          // A view opened onto an existing conversation is the exception, and the
          // only one. It has something to show before anybody types, and waiting
          // for a prompt would leave the user looking at the empty state of a
          // chat they picked precisely because it has history in it.
          if (effect.resumeSessionId !== undefined) {
            const sessionId = effect.resumeSessionId
            void manager.openChat(effect.chatId, sessionId).catch((raw: unknown) => {
              void explainLoadFailure(manager, sessionId, raw).then((error) => {
                console.error('[peek/chat] loading the conversation failed', error.message)
                onError(effect.chatId, error)
              })
            })
            return
          }
          /*
           * A new conversation, so nothing is live and this only moves what the
           * dropdown says. It is still worth doing: the session that will carry
           * this mode is not created until somebody types, and until then the
           * view showed `buildChatViewState`'s placeholder — so a user who had
           * just set "new conversations start in plan" opened one and read
           * "ask me every time". If `setSessionMode` later failed, that is what
           * it went on reading.
           *
           * Read from the same thunk the backend will read, rather than passed
           * down from the view: `watchChatViews` carried a `permissionMode` on
           * this effect for exactly this purpose and neither backend ever read
           * it, so what it carried was the placeholder anyway.
           */
          void manager.setPermissionMode(effect.chatId, startingMode()).catch((raw: unknown) => {
            fail(effect.chatId, raw, 'setting the starting permission mode failed')
          })
          return

        case 'session.close':
          manager.closeChat(effect.chatId)
          return

        case 'prompt': {
          // Synchronous, before the await below. Effects are flushed in reducer
          // order, so this is the only place that can tell the host "a new turn
          // starts here" *ahead* of a stop the user presses while attachments are
          // still being resolved. Doing it inside `manager.send` instead put it
          // after the await, where it wiped the cancel it was supposed to honour.
          manager.beginTurn(effect.chatId)
          void (async () => {
            try {
              const resolved = await resolveAttachments(effect.attachments, { source })
              // `resolveAttachments` never rejects: a descriptor that cannot be
              // resolved becomes a payload that says so, in English, to the model.
              // Failing loudly to the user as well would be wrong — the turn is
              // still worth sending — but a silent gap would not be, which is why
              // the text carries the explanation.
              await manager.send({
                chatId: effect.chatId,
                text: effect.text,
                attachments: resolved,
                ...(effect.attachments.length > 0 ? { descriptors: effect.attachments } : {}),
              })
            } catch (raw) {
              fail(effect.chatId, raw, 'prompt failed')
            }
          })()
          return
        }

        case 'cancel':
          void manager.cancel(effect.chatId).catch((raw: unknown) => {
            // A cancel that fails is not worth an error banner: the turn is being
            // abandoned either way and the state phase has already released the UI.
            console.warn('[peek/chat] cancel failed', toPeekError(raw).message)
          })
          return

        case 'permission': {
          const delivered = manager.respondPermission(effect.requestId, effect.optionId)
          if (!delivered) {
            // Expired, cancelled, or the agent died holding it. From the user's
            // side clicking a button that has already lapsed is not a failure, so
            // this is a note rather than an error.
            notify({
              level: 'info',
              message: 'That permission request had already expired.',
              detail: 'The conversation moved on before the answer arrived; nothing was granted.',
            })
          }
          return
        }

        case 'setMode':
          void manager.setPermissionMode(effect.chatId, effect.mode).catch((raw: unknown) => {
            fail(effect.chatId, raw, 'permission mode change failed')
          })
          return

        case 'clear':
          manager.clear(effect.chatId)
          return

        case 'sessions.delete':
          // No `onError` to reach: by the time this runs the conversation is not
          // in the window, so there is no transcript to put an error banner on.
          // A notification is the only honest destination — and the list the user
          // is still looking at will show the conversation again on its next read,
          // which is itself the report that nothing was deleted.
          void manager.deleteSession(effect.sessionId).catch((raw: unknown) => {
            const error = toPeekError(raw)
            console.error('[peek/chat] deleting the conversation failed', error.message)
            notify({
              level: 'error',
              message: 'Could not delete that conversation.',
              detail: error.message,
            })
          })
          return
      }
    },

    /**
     * Ask the agent to replay it. peek keeps no copy of an ACP transcript, so
     * there is nothing here to hand back — the history belongs to the agent and
     * the agent is where it is fetched from, exactly as when the conversation
     * was first opened.
     */
    restore(chatId: ChatId): Promise<boolean> {
      return manager.reloadChat(chatId).catch((raw: unknown) => {
        // A replay that fails is not worth an error banner: the conversation is
        // intact in the agent and on the next open it will load normally. What
        // the window shows meanwhile is an empty transcript, which `false` is
        // the caller's cue to explain.
        console.warn('[peek/chat] restoring the conversation failed', toPeekError(raw).message)
        return false
      })
    },

    /**
     * The conversation catalogue, with each row attributed to its agent.
     *
     * The rows still come from the backend that wrote them — peek keeps no
     * transcripts. What the index adds is the label: which agent a conversation
     * belongs to, which peek is the only party in a position to know once more
     * than one backend can write history. See
     * `docs/design/2026-08-03-pluggable-agent-backends.md` §3.5.
     */
    listSessions() {
      return manager.listSessions().then((result) => ({
        sessions: result.sessions.map((session) => {
          const route = sessionIndex?.lookup(session.sessionId) ?? null
          return {
            sessionId: session.sessionId,
            cwd: session.cwd,
            // `null` and absent mean the same thing here and only one of them is
            // representable in `ChatSessionInfo`, so the optionals are normalised
            // at the boundary rather than in every reader.
            ...(session.title == null ? {} : { title: session.title }),
            ...(session.updatedAt == null ? {} : { updatedAt: session.updatedAt }),
            // Absent for conversations created before the index existed. A row
            // that cannot name its agent is still a row the user can open.
            ...(route ? { agent: agentDisplayName(route) } : {}),
          }
        }),
        supported: result.supported,
        cwd: result.cwd,
      }))
    },
  }
}

/* ================================================================== */
/* 4. Delta fan-out                                                    */
/* ================================================================== */

/**
 * The data-plane half of `AcpHostDeps`, kept here so `index.ts` reads as assembly.
 *
 * Deltas are already batched and coalesced by the ACP host's `DeltaBatcher`; this
 * only fans them out to whatever renderers exist right now.
 */
export function createDeltaEmitter(
  renderers: () => readonly WebContents[],
  send: (targets: readonly WebContents[], chatId: ChatId, deltas: readonly ChatDelta[]) => void,
): (chatId: ChatId, deltas: readonly ChatDelta[]) => void {
  return (chatId, deltas) => {
    try {
      send(renderers(), chatId, deltas)
    } catch (error) {
      // A destroyed window mid-flush must not take down the ACP notification
      // handler that called us.
      console.warn('[peek/chat] delta fan-out failed', error)
    }
  }
}

/* ================================================================== */
/* 4. The endpoint backend's runtime                                   */
/* ================================================================== */

export interface EndpointRuntimeDeps {
  manager: EndpointManager
  source: ContextSource
  notify(message: NotifyMessage): void
  onError(chatId: ChatId, error: PeekError): void
  sessionIndex?: SessionIndex
  /** Names the model on each session row, since this backend has no agent to name. */
  modelId: string
  /** As `ChatRuntimeDeps.startingMode`. */
  startingMode: () => ChatPermissionMode
}

/**
 * The same `ChatEffect`s, against the in-process loop.
 *
 * A sibling of `createAcpChatRuntime` rather than a branch inside it. The two
 * differ in almost every line that touches the backend — this one has no agent
 * process to bring up, nothing to resume from a protocol, and no `session/delete`
 * to forward — and a single function with a backend-shaped hole in it would have
 * been harder to read than two that each say what they do.
 *
 * What they share is upstream of both: the effects, the deltas, the permission
 * prompts and the attachment resolution are identical, which is why the reducer,
 * the renderer and the command handlers need to know nothing about this split.
 */
export function createEndpointChatRuntime(deps: EndpointRuntimeDeps): ChatRuntime {
  const { manager, source, notify, onError, sessionIndex, modelId, startingMode } = deps

  const fail = (chatId: ChatId, raw: unknown, what: string): void => {
    const error = toPeekError(raw)
    console.error('[peek/chat]', what, error.message)
    onError(chatId, error)
  }

  return {
    run(effect: ChatEffect): void {
      switch (effect.type) {
        case 'session.open':
          // Same policy as the ACP backend, for the same reason: a new
          // conversation costs nothing until somebody types, but one opened onto
          // existing history has something to show before that and must not make
          // the user speak first to see it. The difference is where the history
          // comes from — a file peek wrote, not a protocol.
          if (effect.resumeSessionId !== undefined) {
            try {
              manager.openChat(effect.chatId, effect.resumeSessionId)
            } catch (raw) {
              fail(effect.chatId, raw, 'loading the conversation failed')
            }
            return
          }
          // As the ACP backend: put the mode the next session will be created in
          // on the dropdown now, rather than after the first message.
          manager.setPermissionMode(effect.chatId, startingMode())
          return

        case 'session.close':
          manager.closeChat(effect.chatId)
          return

        case 'prompt': {
          void (async () => {
            try {
              const resolved = await resolveAttachments(effect.attachments, { source })
              manager.send({
                chatId: effect.chatId,
                text: effect.text,
                attachments: resolved,
                ...(effect.attachments.length > 0 ? { descriptors: effect.attachments } : {}),
              })
            } catch (raw) {
              fail(effect.chatId, raw, 'prompt failed')
            }
          })()
          return
        }

        case 'cancel':
          manager.cancel(effect.chatId)
          return

        case 'permission': {
          const delivered = manager.respondPermission(effect.requestId, effect.optionId)
          if (!delivered) {
            notify({
              level: 'info',
              message: 'That permission request had already expired.',
              detail: 'The conversation moved on before the answer arrived; nothing was granted.',
            })
          }
          return
        }

        case 'setMode':
          manager.setPermissionMode(effect.chatId, effect.mode)
          return

        case 'clear':
          manager.clear(effect.chatId)
          return

        case 'sessions.delete':
          // The route is peek's own record, and so is the body. Both go, body
          // first — the manager owns that ordering because it owns the store.
          if (!manager.deleteSession(effect.sessionId)) {
            notify({
              level: 'info',
              message: 'That conversation was already gone.',
            })
          }
          return
      }
    },

    /**
     * Re-send from the live projection, which this backend has and the ACP one
     * does not. No disk read: `restore` re-emits what main is already holding,
     * and that is at least as current as the last save.
     */
    restore(chatId: ChatId): Promise<boolean> {
      return Promise.resolve(manager.restore(chatId))
    },

    /**
     * The catalogue, entirely from peek's own index.
     *
     * `supported: true` unconditionally: unlike an ACP agent, this backend cannot
     * fail to advertise history — peek keeps it, so it always exists. `cwd` is
     * null because there is no working directory to report; nothing outside this
     * process wrote these conversations.
     */
    listSessions(): Promise<ChatSessionsListResult> {
      const routes = sessionIndex?.list() ?? []
      return Promise.resolve({
        sessions: routes
          .filter((route) => route.backend === 'endpoint')
          .map((route) => ({
            sessionId: route.sessionId,
            cwd: '',
            agent: route.agentId || modelId,
            // Both come from peek's own index rather than from an agent, which
            // is the whole reason `SessionRoute` carries them. `updatedAt` is
            // ISO on the wire because that is what the ACP rows deliver and the
            // rail formats one shape, not two.
            ...(route.title === undefined ? {} : { title: route.title }),
            ...(route.updatedAt === undefined ? {} : { updatedAt: new Date(route.updatedAt).toISOString() }),
          })),
        supported: true,
        cwd: null,
      })
    },
  }
}
