/**
 * The loop, end to end: a tool call goes through the real Command Bus, changes the
 * real Workspace, and comes back describing what the user can now see.
 *
 * Unlike `layout-tools.test.ts`, this harness does **not** fake the dispatch. The
 * whole point of what is asserted here is that the receipt is derived from the
 * window rather than declared by the tool, and a fake bus would let a wrong
 * receipt pass. So: one `WorkspaceStore`, one `CommandBus` with the real handlers,
 * and a `ToolContext` pointed at both.
 *
 * Three things are under test:
 *   1. every write tool reports what changed on screen, in prose and in a payload
 *      a client can turn into a button;
 *   2. the chat tools let something outside peek drive the conversation inside it,
 *      and refuse the cases that would be incoherent;
 *   3. an id that went stale while the caller was thinking fails cleanly and
 *      leaves the window intact.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asPanelId,
  collectPanels,
  createEmptyWorkspace,
  type ChatId,
  type PendingPermission,
  type ViewId,
  type WorkspaceSnapshot,
} from '@peek/core'
import { assertPanelInvariants } from '../../bus/__tests__/panel-invariants'
import { CommandBus } from '../../bus/command-bus'
import type { CommandDeps } from '../../bus/deps'
import { coreHandlers } from '../../bus/handlers'
import { createChatEventSink, createChatHandlers, type ChatEffect } from '../../bus/handlers/chat'
import { createSeqIdFactory } from '../../bus/ids'
import { WorkspaceStore } from '../../store/workspace-store'
import openViewTool from '../tools/open-view'
import moveViewTool from '../tools/move-view'
import activateViewTool from '../tools/activate-view'
import sendChatTool from '../tools/send-chat'
import controlChatTool from '../tools/control-chat'
import readChatTool from '../tools/read-chat'
import { UI_EFFECTS_HEADING, diffUiEffects, panelPlacement } from '../ui-effects'
import type { PeekTool, ToolContext, ToolOutput } from '../types'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const inertDeps: CommandDeps = {
  connections: {
    open: async () => ({ capabilities: ['tabularQuery', 'introspect', 'collectionScan'] }),
    close: async () => {},
  },
  results: {
    runQuery: async () => {},
    scanCollection: async () => {},
    vectorSearch: async () => {},
    cancel: async () => false,
  },
}

interface Harness {
  bus: CommandBus
  store: WorkspaceStore
  ctx: ToolContext
  effects: ChatEffect[]
  sink: ReturnType<typeof createChatEventSink>
}

function harness(): Harness {
  const effects: ChatEffect[] = []
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps: inertDeps, ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  bus.registerAll(
    createChatHandlers({
      run: (e) => void effects.push(e),
      // No agent in this harness, so no catalogue — the same answer peek gives
      // before the ACP host is assembled.
      listSessions: () => Promise.resolve({ sessions: [], supported: false, cwd: null }),
    }),
  )

  const ctx: ToolContext = {
    /*
     * `'mcp'`: an MCP client outside peek, which is what every request in the
     * process actually was until the embedded panel got its own credential.
     *
     * This said `'agent'` — written to the *intent* recorded in `CommandSource`'s
     * comment rather than to what the wiring produced, and so it asserted a path
     * production never took. Now that `source` is real and
     * `chat.respondPermission` refuses `'agent'`, keeping it would have made this
     * file test a caller that is forbidden from doing what the file checks.
     * `agentCtx()` below covers that caller deliberately.
     */
    source: 'mcp',
    dispatch: (name, input, source) => bus.dispatch(name, input, source),
    getSnapshot: () => store.getSnapshot(),
    logger: { log: () => {} },
    now: () => 1_000,
    sleep: async () => {},
  }
  return { bus, store, ctx, effects, sink: createChatEventSink(store) }
}

/** The same harness, seen as peek's own embedded chat panel. */
function asAgent(h: Harness): Harness {
  return { ...h, ctx: { ...h.ctx, source: 'agent' } }
}

function run(tool: PeekTool, input: unknown, h: Harness): Promise<ToolOutput> {
  return tool.run(input, h.ctx)
}

async function connect(h: Harness): Promise<string> {
  const res = await h.bus.dispatch('conn.open', { config: { driverId: 'sqlite', file: '/tmp/x.db' } }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

function pending(requestId = 'req_1'): PendingPermission {
  return {
    requestId,
    toolCallId: 'toolu_1',
    toolName: 'mcp__peek__open_view',
    inputPreview: '{"spec":{"kind":"table"}}',
    options: [
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    askedAt: 1_000,
  }
}

/* ------------------------------------------------------------------ */
/* 1. Every write tool reports what the user can now see               */
/* ------------------------------------------------------------------ */

test('open_view’s receipt names the pane the view landed in, and offers a way back to it', async () => {
  const h = harness()
  const connId = await connect(h)
  const out = await run(
    openViewTool,
    { spec: { kind: 'query', connId, text: 'select 1', title: 'orders' }, waitMs: 0 },
    h,
  )

  assert.match(out.text, new RegExp(UI_EFFECTS_HEADING))
  assert.ok(out.uiEffects, 'a tool that changed the window must report the change structurally')
  const opened = out.uiEffects.find((e) => e.kind === 'view.opened')
  assert.ok(opened)
  assert.equal(opened.panelPlacement, 'the only pane')
  assert.match(opened.summary, /Opened query view "orders" in the only pane/)
  assert.equal(
    opened.focus?.command,
    'view.activate',
    'the payload carries a ready-made Command, so a renderer needs no lookup table of its own',
  )
  assert.equal(opened.focus.viewId, opened.viewId)
})

test('a tool that changed nothing says so, rather than staying silent about it', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  // Activating the tab that is already showing is an identity transform, by design.
  const out = await run(activateViewTool, { viewId: opened.data.viewId }, h)
  assert.match(out.text, /nothing \(the window is unchanged\)/)
  assert.equal(out.uiEffects, undefined)
})

test('panes are named the way a person would point at them', async () => {
  const h = harness()
  const connId = await connect(h)
  const first = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId, title: 'left' } }, 'ui')
  assert.equal(first.ok, true)
  if (!first.ok) return

  const out = await run(
    openViewTool,
    { spec: { kind: 'query', connId, title: 'right' }, waitMs: 0 },
    h,
  )
  // Same panel so far — it is a tab, not a pane.
  assert.match(out.text, /the only pane/)

  const split = await h.bus.dispatch(
    'layout.split',
    { panelId: first.data.panelId, dir: 'row' },
    'ui',
  )
  assert.equal(split.ok, true)
  if (!split.ok) return

  const snap = h.store.getSnapshot()
  const panels = collectPanels(snap.layout)
  assert.equal(panelPlacement(snap.layout, panels[0].id), 'the left pane')
  assert.equal(panelPlacement(snap.layout, panels[1].id), 'the right pane')
})

test('the diff catches consequences no tool announced — views a layout rewrite swept away', async () => {
  const h = harness()
  const connId = await connect(h)
  const before = h.store.getSnapshot()
  await h.bus.dispatch('view.open', { spec: { kind: 'query', connId, title: 'doomed' } }, 'ui')
  const mid = h.store.getSnapshot()
  // The default unplaced policy closes what the tree left out; nothing names it.
  await h.bus.dispatch('layout.setLayout', { tree: { type: 'panel' } }, 'agent')
  const after = h.store.getSnapshot()

  assert.equal(diffUiEffects(before, mid).filter((e) => e.kind === 'view.opened').length, 1)
  const closed = diffUiEffects(mid, after).filter((e) => e.kind === 'view.closed')
  assert.equal(closed.length, 1)
  assert.match(closed[0].summary, /Closed query view "doomed"/)
  assert.equal(closed[0].focus, undefined, 'there is nothing left to jump to, so no button is offered')
})

test('an unchanged revision produces no diff at all, without walking the views', () => {
  const h = harness()
  const snap: WorkspaceSnapshot = h.store.getSnapshot()
  assert.deepEqual(diffUiEffects(snap, snap), [])
})

/* ------------------------------------------------------------------ */
/* 2. Driving the conversation from outside                            */
/* ------------------------------------------------------------------ */

test('send_chat with no viewId opens a conversation and sends the first turn in one call', async () => {
  const h = harness()
  const out = await run(sendChatTool, { text: 'compare these two tables', title: 'review' }, h)

  assert.equal(out.isError, undefined)
  const chats = h.store.getSnapshot().views.filter((v) => v.kind === 'chat')
  assert.equal(chats.length, 1)
  assert.equal(chats[0].chat?.streaming, true)
  assert.equal(chats[0].chat?.messageCount, 1)
  assert.deepEqual(
    h.effects.map((e) => e.type),
    ['prompt'],
  )
  assert.match(out.text, /reply streams into that panel/)
  // The conversation it opened is part of what changed on screen, even though the
  // open happened inside `toCommands` rather than as a listed Command.
  assert.ok(out.uiEffects?.some((e) => e.kind === 'view.opened'))
})

test('send_chat refuses a conversation that is already running a turn — which is what stops self-prompting', async () => {
  const h = harness()
  await run(sendChatTool, { text: 'first' }, h)
  const viewId = h.store.getSnapshot().views.find((v) => v.kind === 'chat')?.id
  assert.ok(viewId)

  const out = await run(sendChatTool, { viewId, text: 'second' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /CONFLICT/)
  assert.equal(h.effects.length, 1)
})

test('send_chat on something that is not a conversation lists the ones that are', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const out = await run(sendChatTool, { viewId: opened.data.viewId, text: 'hi' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /is not an open conversation/)
  assert.match(out.text, /\(none\) — omit viewId to open one/)
})

test('attachments travel with the turn and are handed to the runtime unresolved', async () => {
  const h = harness()
  const out = await run(sendChatTool, { text: 'what am I looking at?', attachments: [{ kind: 'workspace' }] }, h)
  assert.equal(out.isError, undefined)
  const effect = h.effects[0]
  assert.equal(effect.type, 'prompt')
  if (effect.type !== 'prompt') return
  assert.equal(effect.attachments.length, 1)
  assert.equal(effect.attachments[0].kind, 'workspace')
  assert.match(out.text, /1 attachment\(s\)/)
})

/* ------------------------------------------------------------------ */
/* 3. Unblocking a conversation from outside                           */
/* ------------------------------------------------------------------ */

async function blockedChat(h: Harness): Promise<{ viewId: ViewId; chatId: ChatId }> {
  await run(sendChatTool, { text: 'open the orders table' }, h)
  const summary = h.store.getSnapshot().views.find((v) => v.kind === 'chat')
  assert.ok(summary?.chat)
  h.sink.onPermissionRequested(summary.chat.chatId, pending())
  return { viewId: summary.id, chatId: summary.chat.chatId }
}

test('read_chat surfaces the exact option ids, which cannot be guessed from the description', async () => {
  const h = harness()
  await blockedChat(h)
  const out = await run(readChatTool, {}, h)

  assert.match(out.text, /BLOCKED: waiting for a person to approve mcp__peek__open_view/)
  assert.match(out.text, /allow_always\|allow\|reject/)
  assert.match(out.text, /requestId:"req_1"/)
})

test('control_chat answer_permission without an optionId lists the choices instead of guessing one', async () => {
  const h = harness()
  const { viewId } = await blockedChat(h)
  const out = await run(controlChatTool, { viewId, action: 'answer_permission' }, h)

  assert.equal(out.isError, true)
  assert.match(out.text, /needs an optionId/)
  assert.match(out.text, /allow_always \(Always allow\)/)
  assert.match(out.text, /Pass requestId "req_1"/)
  assert.equal(h.effects.filter((e) => e.type === 'permission').length, 0)
})

test('control_chat answers the prompt, and defaults requestId to the one it just read', async () => {
  const h = harness()
  const { viewId, chatId } = await blockedChat(h)
  const out = await run(controlChatTool, { viewId, action: 'answer_permission', optionId: 'allow' }, h)

  assert.equal(out.isError, undefined)
  assert.deepEqual(h.effects.at(-1), { type: 'permission', chatId, requestId: 'req_1', optionId: 'allow' })
  assert.equal(h.store.getSnapshot().views.find((v) => v.id === viewId)?.chat?.pendingPermission, undefined)
})

test('control_chat answer_permission is refused when the caller is peek\'s own panel', async () => {
  /*
   * The tool-layer half of the boundary the bus enforces. Worth having both: this
   * is the reachable path — `control_chat` is a tool the embedded panel can see,
   * and once a human puts its conversation into `dontAsk` it stops being asked
   * before calling it.
   *
   * The refusal does not depend on which conversation is targeted. All embedded
   * panels share one credential, so "its own" is not a question main can answer,
   * and a rule that holds only for foreign viewIds is a rule with a state you can
   * manoeuvre into.
   *
   * See design/2026-08-02-agent-source-and-permission-scope.md §2.3.
   */
  const h = harness()
  const { viewId } = await blockedChat(h)

  const out = await run(controlChatTool, { viewId, action: 'answer_permission', optionId: 'allow' }, asAgent(h))
  assert.equal(out.isError, true)

  // Still blocked: a refused answer must not be mistaken for an answer.
  assert.notEqual(h.store.getSnapshot().views.find((v) => v.id === viewId)?.chat?.pendingPermission, undefined)
  assert.notEqual(h.effects.at(-1)?.type, 'permission')
})

test('control_chat answer_permission on a conversation that is not blocked refuses', async () => {
  const h = harness()
  await run(sendChatTool, { text: 'go' }, h)
  const viewId = h.store.getSnapshot().views.find((v) => v.kind === 'chat')?.id
  assert.ok(viewId)

  const out = await run(controlChatTool, { viewId, action: 'answer_permission', optionId: 'allow' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /not waiting for a permission decision/)
})

test('control_chat stop ends the turn; a stop with nothing running is not an error', async () => {
  const h = harness()
  await run(sendChatTool, { text: 'go' }, h)
  const viewId = h.store.getSnapshot().views.find((v) => v.kind === 'chat')?.id
  assert.ok(viewId)

  const stopped = await run(controlChatTool, { viewId, action: 'stop' }, h)
  assert.equal(stopped.isError, undefined)
  assert.equal(h.store.getSnapshot().views.find((v) => v.id === viewId)?.chat?.streaming, false)

  const again = await run(controlChatTool, { viewId, action: 'stop' }, h)
  assert.equal(again.isError, undefined)
})

test('control_chat cannot hand a model a mode that removes the human from the loop', async () => {
  const h = harness()
  await run(sendChatTool, { text: 'go' }, h)
  const viewId = h.store.getSnapshot().views.find((v) => v.kind === 'chat')?.id
  assert.ok(viewId)

  const out = await run(controlChatTool, { viewId, action: 'set_mode', mode: 'bypassPermissions' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /can only be chosen by the person at the keyboard/)
  assert.equal(
    h.store.getSnapshot().views.find((v) => v.id === viewId)?.chat?.permissionMode,
    'default',
  )
})

/* ------------------------------------------------------------------ */
/* 4. The user moving things while the agent works                     */
/* ------------------------------------------------------------------ */

test('a view id that went stale while the agent was thinking fails cleanly, leaving the window intact', async () => {
  const h = harness()
  const connId = await connect(h)
  const opened = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId } }, 'ui')
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  // What the agent read a moment ago. The user then closes the tab.
  const staleViewId = opened.data.viewId
  await h.bus.dispatch('view.close', { viewId: staleViewId }, 'ui')
  const before = h.store.getSnapshot()

  const out = await run(moveViewTool, { viewId: staleViewId, toPanelId: opened.data.panelId, zone: 'right' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /does not exist/)
  assert.equal(h.store.rev, before.rev, 'a refused tool call changes nothing')
  assertPanelInvariants(h.store.getState().layout, 'after a stale move')
})

test('the agent opening a view and the user closing another one interleave without corrupting the tree', async () => {
  const h = harness()
  const connId = await connect(h)
  const victim = await h.bus.dispatch('view.open', { spec: { kind: 'query', connId, title: 'victim' } }, 'ui')
  assert.equal(victim.ok, true)
  if (!victim.ok) return

  // Fired together on purpose: `dispatch` is async and does not serialise, so
  // this is the real interleaving. Each command's *state* phase is a synchronous
  // immer produce, so both land whole, in some order.
  const [openRes, closeRes] = await Promise.all([
    run(openViewTool, { spec: { kind: 'query', connId, title: 'from the agent' }, waitMs: 0 }, h),
    h.bus.dispatch('view.close', { viewId: victim.data.viewId }, 'ui'),
  ])

  assert.equal(openRes.isError, undefined)
  assert.equal(closeRes.ok, true)
  assertPanelInvariants(h.store.getState().layout, 'after a concurrent open and close')

  const views = h.store.getSnapshot().views
  assert.equal(views.length, 1)
  assert.equal(views[0].title, 'from the agent')
  assert.equal(views[0].visible, true, 'and what survived is actually on screen')
})

test('a conversation the user closes mid-turn tears its session down and stops churning the renderer', async () => {
  const h = harness()
  await run(sendChatTool, { text: 'a long one' }, h)
  const summary = h.store.getSnapshot().views.find((v) => v.kind === 'chat')
  assert.ok(summary?.chat)
  const chatId = summary.chat.chatId

  await h.bus.dispatch('view.close', { viewId: summary.id }, 'ui')
  const revAfterClose = h.store.rev

  // The agent has not noticed yet and keeps streaming.
  h.sink.onUsage(chatId, { used: 100, size: 1_000_000 })
  h.sink.onAgentError(chatId, { code: 'INTERNAL', message: 'ACP connection closed' })
  assert.equal(h.store.rev, revAfterClose)
})
