/**
 * The `chat.*` state machine, driven through the real Command Bus.
 *
 * The transcript is not in the Workspace, so what is asserted here is exactly what
 * the Workspace is supposed to hold: whether a turn is in flight, whether a human
 * is being asked something, what is staged for the next prompt, and which effects
 * the runtime was handed. A fake runtime records the effects rather than executing
 * them — that boundary is the whole contract between the bus and the ACP adapter.
 *
 * The paths that matter and are easy to get wrong:
 *   - cancelling mid-stream, and a late completion arriving afterwards;
 *   - refusing a permission answer that is for a question no longer being asked;
 *   - the agent process dying with a turn in flight;
 *   - two sends racing (which the synchronous reduce phase makes impossible).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CHAT_ATTACHMENTS,
  asChatMessageId,
  asViewId,
  createEmptyWorkspace,
  asPanelId,
  peekError,
  type ChatViewState,
  type CommandResultFor,
  type PendingPermission,
  type ViewId,
} from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { CommandBus } from '../command-bus'
import type { CommandDeps } from '../deps'
import { coreHandlers } from '../handlers'
import {
  createChatEventSink,
  createChatHandlers,
  watchChatViews,
  type ChatEffect,
  type ChatRuntime,
} from '../handlers/chat'
import { createSeqIdFactory } from '../ids'

/**
 * A runtime that records effects and has no catalogue.
 *
 * `supported: false` is what an agentless peek reports, and every test in this
 * file is agentless — the catalogue itself is exercised where a runtime that has
 * one is built.
 */
function recordingRuntime(into: ChatEffect[]): ChatRuntime {
  return {
    run: (effect) => void into.push(effect),
    listSessions: () => Promise.resolve({ sessions: [], supported: false, cwd: null }),
    restore: () => Promise.resolve(false),
  }
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  effects: ChatEffect[]
  sink: ReturnType<typeof createChatEventSink>
}

/**
 * Connections succeed and queries do nothing. Chat has no database side, so the
 * only reason a connection appears at all is that some attachment descriptors
 * point at one — the deps exist to let those tests build a target, not to be
 * exercised.
 */
const inertDeps: CommandDeps = {
  connections: {
    open: async () => ({ capabilities: ['tabularQuery', 'introspect'] }),
    close: async () => {},
  },
  results: {
    runQuery: async () => {},
    scanCollection: async () => {},
    vectorSearch: async () => {},
    cancel: async () => false,
  },
}

function harness(): Harness {
  const effects: ChatEffect[] = []
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({
    store,
    deps: inertDeps,
    ids: createSeqIdFactory(),
    now: () => 1_000,
  })
  bus.registerAll(coreHandlers)
  bus.registerAll(createChatHandlers(recordingRuntime(effects)))
  return { bus, store, effects, sink: createChatEventSink(store) }
}

async function openChat(h: Harness): Promise<ViewId> {
  const res = await h.bus.dispatch('view.open', { spec: { kind: 'chat' } }, 'ui')
  assert.equal(res.ok, true, 'opening a chat view should succeed with no connection at all')
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

function chatOf(h: Harness, viewId: ViewId): ChatViewState {
  const view = h.store.getState().views[viewId]
  assert.ok(view && view.kind === 'chat')
  return view
}

function pendingFor(toolName: string, requestId = 'req_1'): PendingPermission {
  return {
    requestId,
    toolCallId: 'toolu_1',
    toolName,
    inputPreview: '{"withLayoutTree":true}',
    options: [
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    askedAt: 1_000,
  }
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

test('a chat view opens with no connection, and starts in the mode that asks a person', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const chat = chatOf(h, viewId)

  assert.equal(chat.connId, undefined, 'a conversation is a peer of the connections, not a child of one')
  assert.equal(chat.agentSessionId, null)
  assert.equal(chat.agentStatus, 'idle')
  assert.equal(
    chat.permissionMode,
    'default',
    'peek must not inherit the agent’s own `auto` default, which lets a classifier decide',
  )
  assert.equal(chat.streamingMessageId, null)
  assert.deepEqual(chat.attachments, [])
})

test('the snapshot reports a conversation structurally, so MCP need not parse prose', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const summary = h.store.getSnapshot().views.find((v) => v.id === viewId)

  assert.ok(summary?.chat, 'a chat view carries a `chat` block in the snapshot')
  assert.equal(summary.chat.streaming, false)
  assert.equal(summary.chat.messageCount, 0)
  assert.equal(summary.connId, undefined, 'and no connection id it does not have')
})

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

test('chat.send marks the turn in flight and hands exactly one prompt to the runtime', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.send', { viewId, text: 'how many rows?' }, 'ui')

  assert.equal(res.ok, true)
  if (!res.ok) return
  const chat = chatOf(h, viewId)
  assert.equal(chat.streamingMessageId, res.data.messageId)
  assert.equal(chat.messageCount, 1)
  assert.equal(
    chat.agentStatus,
    'starting',
    'no session yet, so the first turn has to spawn one — reported honestly rather than as `streaming`',
  )
  assert.deepEqual(
    h.effects.map((e) => e.type),
    ['prompt'],
  )
})

test('a second send while a turn is running is refused, and changes nothing', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const first = await h.bus.dispatch('chat.send', { viewId, text: 'one' }, 'ui')
  assert.equal(first.ok, true)

  const revBefore = h.store.rev
  const second = await h.bus.dispatch('chat.send', { viewId, text: 'two' }, 'ui')

  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.error.code, 'CONFLICT')
  assert.equal(h.store.rev, revBefore, 'a refused send bumps no revision')
  assert.equal(chatOf(h, viewId).messageCount, 1)
  assert.equal(h.effects.length, 1, 'and reaches the agent exactly once')
})

test('two sends dispatched concurrently: the reduce phase is a critical section, so one wins', async () => {
  const h = harness()
  const viewId = await openChat(h)

  // Fired without awaiting in between — the real interleaving an embedded agent
  // and a user typing can produce. The state phase is a synchronous immer
  // `produce`, so the two cannot both observe an idle conversation.
  const [a, b] = await Promise.all([
    h.bus.dispatch('chat.send', { viewId, text: 'A' }, 'ui'),
    h.bus.dispatch('chat.send', { viewId, text: 'B' }, 'agent'),
  ])

  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exactly one send is accepted')
  const loser = a.ok ? b : a
  assert.equal(loser.ok, false)
  if (loser.ok) return
  assert.equal(loser.error.code, 'CONFLICT')
  assert.equal(chatOf(h, viewId).messageCount, 1)
})

test('a send is refused while a person is being asked for permission', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  h.sink.onPermissionRequested(chatOf(h, viewId).chatId, pendingFor('mcp__peek__open_view'))

  const res = await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  assert.equal(res.ok, true)
  // Cancelling clears the prompt, so a following send is accepted again — that is
  // the pairing being checked, not the refusal on its own.
  const again = await h.bus.dispatch('chat.send', { viewId, text: 'go again' }, 'ui')
  assert.equal(again.ok, true)
})

test('an empty prompt with no attachments is rejected by the schema, before any handler runs', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.send', { viewId, text: '   ' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
})

test('chat.send on a view that is not a conversation says so, rather than "not found"', async () => {
  const h = harness()
  const conn = await h.bus.dispatch(
    'conn.open',
    { config: { driverId: 'sqlite', file: '/tmp/x.db' } },
    'ui',
  )
  assert.equal(conn.ok, true)
  if (!conn.ok) return
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'query', connId: conn.data.connId } },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const res = await h.bus.dispatch('chat.send', { viewId: opened.data.viewId, text: 'hi' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.match(res.error.message, /not a conversation/)
})

/* ------------------------------------------------------------------ */
/* Cancelling mid-stream                                               */
/* ------------------------------------------------------------------ */

test('cancelling mid-stream releases the composer and tells the runtime which turn to stop', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const sent = await h.bus.dispatch('chat.send', { viewId, text: 'long one' }, 'ui')
  assert.equal(sent.ok, true)
  if (!sent.ok) return

  const res = await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.cancelled, true)
  assert.equal(res.data.messageId, sent.data.messageId)
  assert.equal(chatOf(h, viewId).streamingMessageId, null)
  assert.deepEqual(
    h.effects.map((e) => e.type),
    ['prompt', 'cancel'],
  )
})

test('cancelling an idle conversation is a no-op, not a failure', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.cancelled, false)
  assert.equal(res.data.messageId, null)
  assert.equal(h.effects.length, 0, 'and nothing is asked of the agent')
})

test('a second stop press while the agent is still starting is not swallowed', async () => {
  // `chat.cancel` clears `streamingMessageId` itself, so a guard that reads only
  // that field made every press after the first a silent no-op — precisely while
  // the agent was still coming up and the *first* cancel had nothing to cancel
  // yet. `agentStatus` is what still says a turn is in flight.
  const h = harness()
  const viewId = await openChat(h)
  const sent = await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  assert.equal(sent.ok, true)
  assert.equal(chatOf(h, viewId).agentStatus, 'starting')

  const first = await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.data.cancelled, true)

  // The status only leaves `starting` when the host reports it, so a user
  // pressing stop again in that window must still reach the agent.
  h.sink.onStatus(chatOf(h, viewId).chatId, 'starting')
  const second = await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.data.cancelled, true)
  assert.deepEqual(
    h.effects.map((e) => e.type),
    ['prompt', 'cancel', 'cancel'],
  )
})

test('a turn that ends after it was cancelled does not disturb the next one', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const first = await h.bus.dispatch('chat.send', { viewId, text: 'one' }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return
  const chatId = chatOf(h, viewId).chatId

  await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  const second = await h.bus.dispatch('chat.send', { viewId, text: 'two' }, 'ui')
  assert.equal(second.ok, true)
  if (!second.ok) return

  // ACP resolves a cancelled prompt normally, with stopReason "cancelled" — so
  // this notification arrives *after* the next turn has already started.
  h.sink.onTurnEnded(chatId, { messageId: first.data.messageId, stopReason: 'cancelled' })

  assert.equal(
    chatOf(h, viewId).streamingMessageId,
    second.data.messageId,
    'the stale completion must not clear the turn that is actually running',
  )
})

/* ------------------------------------------------------------------ */
/* Permission                                                          */
/* ------------------------------------------------------------------ */

test('answering a permission prompt clears it, resumes the turn, and reports what it unblocked', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'open the table' }, 'ui')
  const chatId = chatOf(h, viewId).chatId
  h.sink.onPermissionRequested(chatId, pendingFor('mcp__peek__open_view'))
  assert.equal(chatOf(h, viewId).agentStatus, 'awaiting-permission')

  const res = await h.bus.dispatch(
    'chat.respondPermission',
    { viewId, requestId: 'req_1', optionId: 'allow' },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.toolName, 'mcp__peek__open_view')
  assert.equal(chatOf(h, viewId).pendingPermission, undefined)
  assert.equal(chatOf(h, viewId).agentStatus, 'streaming')
  assert.deepEqual(h.effects.at(-1), {
    type: 'permission',
    chatId,
    requestId: 'req_1',
    optionId: 'allow',
  })
})

test("peek's own chat panel cannot answer a permission prompt — not even its own", async () => {
  /*
   * The scope leak this closes: a human puts conversation A into `dontAsk`, which
   * stops A's agent being asked before its `mcp__peek__*` calls. Nothing then
   * stopped that agent from calling `control_chat answer_permission` against
   * conversation **B** and approving whatever B was blocked on. The human
   * authorised "stop asking me about A"; the reach was the whole window.
   *
   * `source: 'agent'` is what makes this expressible at all. It is a documented
   * member of `CommandSource` that, until the embedded panel got its own MCP
   * credential, no request ever carried — the enum described an isolation that
   * did not exist.
   *
   * See design/2026-08-02-agent-source-and-permission-scope.md.
   */
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'do the thing' }, 'ui')
  h.sink.onPermissionRequested(chatOf(h, viewId).chatId, pendingFor('mcp__peek__run_query'))

  const res = await h.bus.dispatch('chat.respondPermission', { viewId, optionId: 'allow' }, 'agent')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')

  // Refused, and the prompt is still standing — a rejected answer must not be
  // mistaken for an answer.
  assert.notEqual(chatOf(h, viewId).pendingPermission, undefined)
  assert.equal(chatOf(h, viewId).agentStatus, 'awaiting-permission')
  assert.notEqual(h.effects.at(-1)?.type, 'permission')
})

test('an operator outside peek still answers prompts; that is what control_chat is for', async () => {
  // The refusal above is deliberately narrow. PLAN §7 makes "an external client
  // can watch and drive the embedded one" a feature, and `control_chat`'s own
  // description says answering is for an operator driving peek from outside. A
  // blanket "non-ui may not answer" would have deleted that.
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'do the thing' }, 'ui')
  h.sink.onPermissionRequested(chatOf(h, viewId).chatId, pendingFor('mcp__peek__run_query'))

  const res = await h.bus.dispatch('chat.respondPermission', { viewId, optionId: 'allow' }, 'mcp')
  assert.equal(res.ok, true)
  assert.equal(chatOf(h, viewId).pendingPermission, undefined)
})

test('rejecting is an ordinary answer: the option is passed through, nothing is special-cased', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'delete everything' }, 'ui')
  h.sink.onPermissionRequested(chatOf(h, viewId).chatId, pendingFor('mcp__peek__run_query'))

  const res = await h.bus.dispatch('chat.respondPermission', { viewId, optionId: 'reject' }, 'ui')
  assert.equal(res.ok, true)
  const last = h.effects.at(-1)
  assert.equal(last?.type === 'permission' && last.optionId, 'reject')
  assert.equal(
    chatOf(h, viewId).streamingMessageId !== null,
    true,
    'a refusal ends the tool call, not the turn — the agent still has to say something about it',
  )
})

test('an answer aimed at a request that has been replaced is refused, not applied to the new one', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  const chatId = chatOf(h, viewId).chatId

  h.sink.onPermissionRequested(chatId, pendingFor('mcp__peek__open_view', 'req_1'))
  // The user is still reading the first prompt when the turn raises a second.
  h.sink.onPermissionRequested(chatId, pendingFor('mcp__peek__run_query', 'req_2'))

  const stale = await h.bus.dispatch(
    'chat.respondPermission',
    { viewId, requestId: 'req_1', optionId: 'allow_always' },
    'ui',
  )
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.equal(stale.error.code, 'CONFLICT')
  assert.equal(
    chatOf(h, viewId).pendingPermission?.requestId,
    'req_2',
    'the question actually being asked is still up',
  )
})

test('an unknown option is refused with the list of options that would have worked', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  h.sink.onPermissionRequested(chatOf(h, viewId).chatId, pendingFor('mcp__peek__open_view'))

  // `allow_once` is the option's *kind*, not its id — the exact confusion this
  // check exists to catch.
  const res = await h.bus.dispatch('chat.respondPermission', { viewId, optionId: 'allow_once' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'BAD_REQUEST')
  assert.match(res.error.message, /allow_always, allow, reject/)
})

test('answering when nothing is being asked is a CONFLICT, and reaches no agent', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.respondPermission', { viewId, optionId: 'allow' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONFLICT')
  assert.equal(h.effects.length, 0)
})

test('a late resolution for a superseded request does not dismiss the prompt on screen', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  const chatId = chatOf(h, viewId).chatId
  h.sink.onPermissionRequested(chatId, pendingFor('a', 'req_1'))
  h.sink.onPermissionRequested(chatId, pendingFor('b', 'req_2'))

  h.sink.onPermissionResolved(chatId, 'req_1')
  assert.equal(chatOf(h, viewId).pendingPermission?.requestId, 'req_2')

  h.sink.onPermissionResolved(chatId, 'req_2')
  assert.equal(chatOf(h, viewId).pendingPermission, undefined)
})

/* ------------------------------------------------------------------ */
/* The agent dying                                                     */
/* ------------------------------------------------------------------ */

test('an agent crash mid-turn releases the composer and surfaces the error on the conversation', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  const chatId = chatOf(h, viewId).chatId
  h.sink.onPermissionRequested(chatId, pendingFor('mcp__peek__open_view'))

  h.sink.onAgentError(chatId, peekError('INTERNAL', 'ACP connection closed'))

  const chat = chatOf(h, viewId)
  assert.equal(chat.agentStatus, 'error')
  assert.equal(chat.streamingMessageId, null, 'the user must be able to type again')
  assert.equal(chat.pendingPermission, undefined, 'and must not be left staring at a dead question')
  assert.equal(chat.error?.message, 'ACP connection closed')
})

test('a crash leaves the conversation usable: the next send starts a fresh session', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const chatId = chatOf(h, viewId).chatId
  h.sink.onSessionReady(chatId, 'sess_1')
  await h.bus.dispatch('chat.send', { viewId, text: 'go' }, 'ui')
  h.sink.onAgentError(chatId, peekError('DRIVER_CRASHED', 'agent exited'))
  h.sink.onSessionClosed(chatId)

  assert.equal(chatOf(h, viewId).agentSessionId, null)
  const res = await h.bus.dispatch('chat.send', { viewId, text: 'again' }, 'ui')
  assert.equal(res.ok, true, 'a dead agent must not permanently wedge the conversation')
  assert.equal(chatOf(h, viewId).agentStatus, 'starting')
})

test('stream events for a conversation that has been closed are dropped without a revision bump', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const chatId = chatOf(h, viewId).chatId
  await h.bus.dispatch('view.close', { viewId }, 'ui')

  const revBefore = h.store.rev
  h.sink.onMessageAppended(chatId, asChatMessageId('msg_x'), 'a reply nobody is watching')
  h.sink.onTurnEnded(chatId, { messageId: asChatMessageId('msg_x'), stopReason: 'end_turn' })
  assert.equal(h.store.rev, revBefore, 'a stream that outlives its view must not churn the renderer')
})

/* ------------------------------------------------------------------ */
/* Clearing                                                            */
/* ------------------------------------------------------------------ */

test('clearing a running conversation stops the turn instead of refusing', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.send', { viewId, text: 'one' }, 'ui')
  h.sink.onMessageAppended(chatOf(h, viewId).chatId, asChatMessageId('msg_reply'), 'a reply')

  const res = await h.bus.dispatch('chat.clear', { viewId }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.clearedMessages, 2)
  assert.equal(res.data.cancelledTurn, true)
  assert.deepEqual(
    h.effects.map((e) => e.type),
    ['prompt', 'cancel', 'clear'],
    'the cancel must reach the agent before the clear',
  )

  const chat = chatOf(h, viewId)
  assert.equal(chat.messageCount, 0)
  assert.equal(chat.streamingMessageId, null)
  assert.equal(chat.lastMessagePreview, undefined)
})

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

test('attaching the workspace is always resolvable, and is consumed by the turn it was staged for', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const attached = await h.bus.dispatch(
    'chat.attach',
    { viewId, attachments: [{ kind: 'workspace' }] },
    'ui',
  )
  assert.equal(attached.ok, true)
  if (!attached.ok) return
  assert.equal(attached.data.attachments.length, 1)

  const sent = await h.bus.dispatch('chat.send', { viewId, text: 'what am I looking at?' }, 'ui')
  assert.equal(sent.ok, true)
  if (!sent.ok) return
  assert.equal(sent.data.attachments.length, 1, 'the staged descriptor travels with the turn')
  assert.deepEqual(chatOf(h, viewId).attachments, [], 'and is not silently re-sent on the next one')
})

test('attaching the same thing twice stages it once and returns the id it already had', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const first = await h.bus.dispatch('chat.attach', { viewId, attachments: [{ kind: 'workspace' }] }, 'ui')
  const second = await h.bus.dispatch('chat.attach', { viewId, attachments: [{ kind: 'workspace' }] }, 'ui')
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return
  assert.deepEqual(second.data.attachmentIds, first.data.attachmentIds)
  assert.equal(chatOf(h, viewId).attachments.length, 1)
})

test('a descriptor pointing at something that is gone is refused at attach time, not at send time', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch(
    'chat.attach',
    {
      viewId,
      attachments: [{ kind: 'query', viewId: asViewId('view_ghost') }],
    },
    'ui',
  )
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'NOT_FOUND')
})

test('a bad attachment inside chat.send aborts the whole turn, leaving no half-sent state', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch(
    'chat.send',
    { viewId, text: 'look', attachments: [{ kind: 'query', viewId: asViewId('view_ghost') }] },
    'ui',
  )
  assert.equal(res.ok, false)
  const chat = chatOf(h, viewId)
  assert.equal(chat.streamingMessageId, null)
  assert.equal(chat.messageCount, 0)
  assert.equal(h.effects.length, 0, 'and nothing reaches the agent')
})

test('staging is capped, and the cap is enforced per conversation', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const conn = await h.bus.dispatch(
    'conn.open',
    { config: { driverId: 'sqlite', file: '/tmp/x.db' } },
    'ui',
  )
  assert.equal(conn.ok, true)
  if (!conn.ok) return

  // Distinct schema refs, so nothing is deduplicated away before the cap is hit.
  // (Distinct *views* would hit the per-panel tab cap first and prove the wrong
  // limit.)
  for (let i = 0; i <= MAX_CHAT_ATTACHMENTS; i += 1) {
    // Annotated because the loop variable feeds a discriminated-union literal and
    // TS otherwise reports the binding as circularly inferred.
    const res: CommandResultFor<'chat.attach'> = await h.bus.dispatch(
      'chat.attach',
      {
        viewId,
        attachments: [
          {
            kind: 'schema',
            connId: conn.data.connId,
            ref: { kind: 'relation', schema: 'public', name: `t${String(i)}` },
          },
        ],
      },
      'ui',
    )
    if (i < MAX_CHAT_ATTACHMENTS) {
      assert.equal(res.ok, true, `attachment ${String(i)} should fit`)
    } else {
      assert.equal(res.ok, false)
      if (res.ok) return
      assert.equal(res.error.code, 'CONFLICT')
    }
  }
  assert.equal(chatOf(h, viewId).attachments.length, MAX_CHAT_ATTACHMENTS)
})

test('detaching by id removes only what was named; an unknown id is an error', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const attached = await h.bus.dispatch('chat.attach', { viewId, attachments: [{ kind: 'workspace' }] }, 'ui')
  assert.equal(attached.ok, true)
  if (!attached.ok) return

  const bogus = await h.bus.dispatch(
    'chat.detach',
    { viewId, attachmentIds: [attached.data.attachmentIds[0], 'att_ghost'] },
    'ui',
  )
  assert.equal(bogus.ok, false)
  assert.equal(chatOf(h, viewId).attachments.length, 1, 'and the valid half is not removed either')

  const all = await h.bus.dispatch('chat.detach', { viewId }, 'ui')
  assert.equal(all.ok, true)
  assert.deepEqual(chatOf(h, viewId).attachments, [])
})

/* ------------------------------------------------------------------ */
/* Permission mode policy                                              */
/* ------------------------------------------------------------------ */

test('a model cannot switch off the human gate; the person at the keyboard can', async () => {
  const h = harness()
  const viewId = await openChat(h)

  for (const source of ['mcp', 'agent'] as const) {
    const res = await h.bus.dispatch('chat.setMode', { viewId, mode: 'bypassPermissions' }, source)
    assert.equal(res.ok, false, `${source} must not be able to remove the prompt`)
    if (res.ok) return
    assert.equal(res.error.code, 'BAD_REQUEST')
    assert.equal(chatOf(h, viewId).permissionMode, 'default')
  }

  const byHand = await h.bus.dispatch('chat.setMode', { viewId, mode: 'bypassPermissions' }, 'ui')
  assert.equal(byHand.ok, true)
  assert.equal(chatOf(h, viewId).permissionMode, 'bypassPermissions')
})

test('a model may still choose a stricter mode, and the change reaches the agent once', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.setMode', { viewId, mode: 'plan' }, 'agent')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.previousMode, 'default')

  const again = await h.bus.dispatch('chat.setMode', { viewId, mode: 'plan' }, 'agent')
  assert.equal(again.ok, true)
  assert.equal(
    h.effects.filter((e) => e.type === 'setMode').length,
    1,
    'setting the mode it is already in tells the agent nothing new',
  )
})

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test('watchChatViews opens a session when a conversation appears and closes it when it goes', async () => {
  const h = harness()
  const seen: ChatEffect[] = []
  const stop = watchChatViews(h.store, recordingRuntime(seen))

  const viewId = await openChat(h)
  const chatId = chatOf(h, viewId).chatId
  assert.deepEqual(
    seen.map((e) => e.type),
    ['session.open'],
  )

  await h.bus.dispatch('view.close', { viewId }, 'ui')
  assert.deepEqual(
    seen.map((e) => e.type),
    ['session.open', 'session.close'],
  )
  const closed = seen[1]
  assert.ok(closed?.type === 'session.close')
  assert.equal(closed.chatId, chatId)
  stop()
})

test('a conversation swept away by a whole-tree rewrite is torn down too, with no per-command hook', async () => {
  const h = harness()
  const seen: ChatEffect[] = []
  const stop = watchChatViews(h.store, recordingRuntime(seen))
  await openChat(h)

  // `unplaced: 'close'` is the default, and it closes views nobody named — the
  // exact route a hook bolted onto `view.close` would miss.
  const res = await h.bus.dispatch('layout.setLayout', { tree: { type: 'panel' } }, 'agent')
  assert.equal(res.ok, true)
  assert.deepEqual(
    seen.map((e) => e.type),
    ['session.open', 'session.close'],
  )
  stop()
})

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/* ------------------------------------------------------------------ */

test('the command log tells the embedded assistant apart from a stranger and from the user', async () => {
  const h = harness()
  const viewId = await openChat(h)
  await h.bus.dispatch('chat.setMode', { viewId, mode: 'plan' }, 'ui')
  await h.bus.dispatch('chat.setMode', { viewId, mode: 'auto' }, 'agent')
  await h.bus.dispatch('chat.setMode', { viewId, mode: 'default' }, 'mcp')

  assert.deepEqual(
    h.bus.log.entries().filter((e) => e.name === 'chat.setMode').map((e) => e.source),
    ['ui', 'agent', 'mcp'],
  )
})

/* ------------------------------------------------------------------ */
/* The session catalogue                                               */
/* ------------------------------------------------------------------ */

test('a chat opened onto an existing session says so, and starts at `loading`', async () => {
  const h = harness()
  const res = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'chat', resumeSessionId: 'sess-a' } },
    'ui',
  )
  assert.equal(res.ok, true)
  if (!res.ok) return

  const chat = chatOf(h, res.data.viewId)
  assert.equal(chat.resumeSessionId, 'sess-a')
  assert.equal(
    chat.agentStatus,
    'loading',
    'the very first render must not look like an empty conversation the user has to type into',
  )
  assert.equal(chat.agentSessionId, null, 'what the user asked for is not yet what the agent confirmed')
})

test('the runtime is told which conversation to resume, not merely that one opened', async () => {
  const h = harness()
  const seen: ChatEffect[] = []
  const stop = watchChatViews(h.store, recordingRuntime(seen))

  await h.bus.dispatch('view.open', { spec: { kind: 'chat', resumeSessionId: 'sess-a' } }, 'ui')
  const opened = seen[0]
  assert.ok(opened?.type === 'session.open')
  assert.equal(opened.resumeSessionId, 'sess-a')
  stop()
})

test('an ordinary new conversation carries no session to resume', async () => {
  const h = harness()
  const seen: ChatEffect[] = []
  const stop = watchChatViews(h.store, recordingRuntime(seen))

  await openChat(h)
  const opened = seen[0]
  assert.ok(opened?.type === 'session.open')
  assert.equal(opened.resumeSessionId, undefined, 'which is what keeps the session lazy for everyone else')
  stop()
})

test('deleting a conversation hands the agent the id and closes nothing in the window', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.sessions.delete', { sessionId: 'sess-a' }, 'ui')

  assert.equal(res.ok, true)
  assert.deepEqual(
    h.effects.filter((e) => e.type === 'sessions.delete'),
    [{ type: 'sessions.delete', sessionId: 'sess-a' }],
  )
  // A delete is not a layout operation. The unrelated conversation the user had
  // open stays open, which is the whole reason the command refuses rather than
  // closes when the target *is* open.
  assert.ok(h.store.getState().views[viewId], 'an unrelated chat view is untouched')
})

test('deleting a conversation somebody is reading is refused, and nothing is sent', async () => {
  const h = harness()
  await h.bus.dispatch('view.open', { spec: { kind: 'chat', resumeSessionId: 'sess-a' } }, 'ui')

  const res = await h.bus.dispatch('chat.sessions.delete', { sessionId: 'sess-a' }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.error.code, 'CONFLICT')
  assert.equal(
    h.effects.filter((e) => e.type === 'sessions.delete').length,
    0,
    'a refused delete must not reach the agent — the transcript is still being read',
  )
})

test('the catalogue is a read: it spends no revision and mirrors nothing', async () => {
  const h = harness()
  const revBefore = h.store.rev
  const res = await h.bus.dispatch('chat.sessions.list', {}, 'ui')

  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.data.supported, false, 'this harness has no agent, so there is no catalogue')
  assert.deepEqual(res.data.sessions, [])
  assert.equal(h.store.rev, revBefore)
})

/* ------------------------------------------------------------------ */
/* Provisional views                                                   */
/* ------------------------------------------------------------------ */

/**
 * The rule the session rail leans on: skimming costs one tab, not one per row.
 *
 * These live here rather than in `command-bus.test.ts` because the interesting
 * half of the rule is about chats — a conversation with a turn in flight must
 * not be closed to make room, since closing it cancels that turn.
 */
test('a provisional open takes the previous provisional view’s slot', async () => {
  const h = harness()
  const first = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'chat', resumeSessionId: 's1' }, provisional: true },
    'ui',
  )
  const second = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'chat', resumeSessionId: 's2' }, provisional: true },
    'ui',
  )
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  const state = h.store.getState()
  assert.equal(state.views[first.data.viewId], undefined, 'the skimmed conversation was let go')
  assert.equal(Object.keys(state.views).length, 1, 'skimming two rows leaves one tab')
  assert.equal(state.views[second.data.viewId]?.provisional, true)
})

test('an ordinary open is kept, and two of them are two tabs', async () => {
  const h = harness()
  const a = await openChat(h)
  const b = await openChat(h)

  const state = h.store.getState()
  assert.equal(Object.keys(state.views).length, 2, 'the old behaviour is untouched')
  assert.equal(state.views[a]?.provisional, undefined)
  assert.equal(state.views[b]?.provisional, undefined)
})

test('view.promote keeps a provisional view, and says whether it did anything', async () => {
  const h = harness()
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'chat' }, provisional: true }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  const first = await h.bus.dispatch('view.promote', { viewId }, 'ui')
  assert.equal(first.ok && first.data.promoted, true)
  assert.equal(h.store.getState().views[viewId]?.provisional, undefined)

  // Idempotent: promoting a kept view is not an error, it is already true.
  const again = await h.bus.dispatch('view.promote', { viewId }, 'ui')
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.data.promoted, false)

  // And a promoted view no longer lends its slot to the next skim.
  const next = await h.bus.dispatch('view.open', { spec: { kind: 'chat' }, provisional: true }, 'ui')
  assert.equal(next.ok, true)
  assert.equal(Object.keys(h.store.getState().views).length, 2)
})

test('sending a message keeps the conversation without anyone asking', async () => {
  const h = harness()
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'chat' }, provisional: true }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const sent = await h.bus.dispatch('chat.send', { viewId: opened.data.viewId, text: 'hi' }, 'ui')
  assert.equal(sent.ok, true)
  assert.equal(chatOf(h, opened.data.viewId).provisional, undefined)
})

test('a streaming conversation is promoted instead of replaced, so no turn is cancelled', async () => {
  const h = harness()
  const opened = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'chat', resumeSessionId: 's1' }, provisional: true },
    'ui',
  )
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  const viewId = opened.data.viewId

  // Put a turn in flight the way the agent would, then skim on to the next row.
  h.store.apply((draft) => {
    const view = draft.views[viewId]
    if (view?.kind === 'chat') view.streamingMessageId = asChatMessageId('msg_live')
  })
  const next = await h.bus.dispatch(
    'view.open',
    { spec: { kind: 'chat', resumeSessionId: 's2' }, provisional: true },
    'ui',
  )
  assert.equal(next.ok, true)

  const state = h.store.getState()
  assert.ok(state.views[viewId], 'the conversation that was talking is still open')
  assert.equal(state.views[viewId]?.provisional, undefined, 'and it stopped being provisional')
  assert.equal(Object.keys(state.views).length, 2)
})
