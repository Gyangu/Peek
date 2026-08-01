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
  ChatDelta,
  ChatId,
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
import type { ChatAgentStatePatch } from './acp'
import { resolveAttachments, type ContextSource, type TabularSlice } from './acp/context'
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
): (patch: ChatAgentStatePatch) => Promise<void> {
  return (patch) => {
    // Read before writing: a patch for a conversation whose view has been closed
    // costs no rev bump and no patch broadcast. Notifications keep arriving until
    // the agent process actually stops, and churning the renderer for a view that
    // no longer exists is pure waste.
    if (findChatView(store.getState(), patch.chatId) === undefined) return Promise.resolve()

    store.apply((draft) => {
      const view = findChatDraft(draft, patch.chatId)
      if (!view) return

      if (patch.status !== undefined) view.agentStatus = patch.status
      if (patch.agentSessionId !== undefined) view.agentSessionId = patch.agentSessionId
      if (patch.permissionMode !== undefined) view.permissionMode = patch.permissionMode
      if (patch.streamingMessageId !== undefined) view.streamingMessageId = patch.streamingMessageId
      if (patch.messageCount !== undefined) view.messageCount = patch.messageCount
      if (patch.lastMessagePreview !== undefined) view.lastMessagePreview = patch.lastMessagePreview
      if (patch.usage !== undefined) view.usage = patch.usage
      if (patch.pendingPermission !== undefined) {
        if (patch.pendingPermission === null) delete view.pendingPermission
        else view.pendingPermission = patch.pendingPermission as Draft<typeof patch.pendingPermission>
      }
      // A turn that reaches a resting state has nothing left to report as broken.
      if (patch.status !== undefined && patch.status !== 'error') delete view.error
    }, { source: 'system' })

    return Promise.resolve()
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
  const { manager, source, notify, onError } = deps

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
            void manager.openChat(effect.chatId, effect.resumeSessionId).catch((raw: unknown) => {
              fail(effect.chatId, raw, 'loading the conversation failed')
            })
          }
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

    listSessions() {
      return manager.listSessions().then((result) => ({
        sessions: result.sessions.map((session) => ({
          sessionId: session.sessionId,
          cwd: session.cwd,
          // `null` and absent mean the same thing here and only one of them is
          // representable in `ChatSessionInfo`, so the optionals are normalised
          // at the boundary rather than in every reader.
          ...(session.title == null ? {} : { title: session.title }),
          ...(session.updatedAt == null ? {} : { updatedAt: session.updatedAt }),
        })),
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
