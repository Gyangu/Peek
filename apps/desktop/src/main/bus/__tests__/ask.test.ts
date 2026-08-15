/**
 * `ask` — the agent asking a person, driven through the real Command Bus.
 *
 * Two things are being pinned, and they fail in different ways:
 *
 * **The broker**, which is bookkeeping: a question that is queued must not be
 * charged for time it was never shown, an answer must settle exactly once, and
 * nothing may be left suspended when the thing it was blocking goes away. Its
 * failures are hangs and leaks — a `chat.ask` that never returns, a prompt the
 * user can click with nothing happening.
 *
 * **The rule about who may answer**, which is policy. `chat.answer` refuses
 * `source: 'agent'` unconditionally, because an agent answering its own question
 * fabricates a person's judgement rather than merely leaking an authorisation.
 * That one has a reverse case beside it — `ui` and `mcp` must still work, or the
 * check would be untestable in the direction that matters.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import { asPanelId, createEmptyWorkspace, type ChatId, type ChatViewState, type ViewId } from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { QuestionBroker, watchQuestions } from '../../agent/questions'
import { CommandBus } from '../command-bus'
import type { CommandDeps } from '../deps'
import { coreHandlers } from '../handlers'
import { createAskHandlers } from '../handlers/ask'
import { createChatEventSink, createChatHandlers, type ChatEffect, type ChatRuntime } from '../handlers/chat'
import { createSeqIdFactory } from '../ids'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const inertDeps: CommandDeps = {
  connections: { open: async () => ({ capabilities: [] }), close: async () => {} },
  results: {
    runQuery: async () => {},
    scanCollection: async () => {},
    vectorSearch: async () => {},
    cancel: async () => false,
  },
}

function recordingRuntime(into: ChatEffect[]): ChatRuntime {
  return {
    run: (effect) => void into.push(effect),
    listSessions: () => Promise.resolve({ sessions: [], supported: false, cwd: null }),
    restore: () => Promise.resolve(false),
  }
}

function harness(timeoutMs = 300_000) {
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps: inertDeps, ids: createSeqIdFactory(), now: () => 1_000 })
  const effects: ChatEffect[] = []
  const sink = createChatEventSink(store)
  const broker = new QuestionBroker({
    onActive: (chatId, pending) => {
      sink.onQuestionActive(chatId, pending)
    },
    now: () => 1_000,
  })
  bus.registerAll(coreHandlers)
  bus.registerAll(createChatHandlers(recordingRuntime(effects)))
  bus.registerAll(createAskHandlers({ broker, timeoutMs }))
  const stopWatching = watchQuestions(store, broker)
  return { store, bus, broker, effects, stopWatching }
}

async function openChat(h: ReturnType<typeof harness>): Promise<ViewId> {
  const res = await h.bus.dispatch('view.open', { spec: { kind: 'chat' } }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.viewId
}

function chatOf(h: ReturnType<typeof harness>, viewId: ViewId): ChatViewState {
  const view = h.store.getState().views[viewId]
  assert.ok(view && view.kind === 'chat')
  return view
}

const TWO_OPTIONS = [
  { optionId: 'day', label: 'By day' },
  { optionId: 'week', label: 'By week' },
]

/** Let the suspended `chat.ask` and the store subscription settle. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/* ------------------------------------------------------------------ */
/* The question reaching the window                                    */
/* ------------------------------------------------------------------ */

test('asking puts the question in the Workspace and stops the conversation on it', async () => {
  const h = harness()
  const viewId = await openChat(h)

  const asking = h.bus.dispatch(
    'chat.ask',
    { viewId, question: 'Aggregate by day or by week?', header: 'Aggregation', options: TWO_OPTIONS },
    'agent',
  )
  await tick()

  const view = chatOf(h, viewId)
  assert.equal(view.agentStatus, 'awaiting-answer')
  assert.equal(view.pendingQuestion?.question, 'Aggregate by day or by week?')
  assert.equal(view.pendingQuestion?.header, 'Aggregation')
  assert.equal(view.pendingQuestion?.multiSelect, false)

  // Still hanging: nobody has answered.
  const requestId = view.pendingQuestion?.requestId
  assert.ok(requestId)
  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['week'], requestId }, 'ui')

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.equal(res.data.answered, true)
  // The label travels with the id, so the agent can read the answer without
  // holding its own question in context.
  assert.deepEqual(res.data.selected, [{ optionId: 'week', label: 'By week' }])
  h.stopWatching()
})

test('answering clears the prompt and hands the conversation back', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await asking

  const view = chatOf(h, viewId)
  assert.equal(view.pendingQuestion, undefined)
  assert.notEqual(view.agentStatus, 'awaiting-answer')
  h.stopWatching()
})

test('a free-text answer comes back as words, with no option chosen', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  await h.bus.dispatch('chat.answer', { viewId, optionIds: [], other: 'by hour, actually' }, 'ui')

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.deepEqual(res.data.selected, [])
  assert.equal(res.data.other, 'by hour, actually')
  h.stopWatching()
})

test('an option and a caveat travel together', async () => {
  // "The second one, but only for the EU rows" is one answer, not two, and
  // forcing a choice between them would throw half of it away.
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  await h.bus.dispatch(
    'chat.answer',
    { viewId, optionIds: ['week'], other: 'but only for the EU rows' },
    'ui',
  )

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.deepEqual(res.data.selected, [{ optionId: 'week', label: 'By week' }])
  assert.equal(res.data.other, 'but only for the EU rows')
  h.stopWatching()
})

/* ------------------------------------------------------------------ */
/* Who may answer                                                      */
/* ------------------------------------------------------------------ */

test('an agent cannot answer a question — not even one asked in its own panel', async () => {
  /*
   * The policy check, and the strictest of the three on this bus. Refused
   * unconditionally rather than only for a foreign viewId: every embedded panel
   * shares one credential, so "its own question" is not a question main can
   * answer. See 2026-08-02-agent-source-and-permission-scope.md §2.3bis.
   */
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  const refused = await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'agent')
  assert.equal(refused.ok, false)
  if (refused.ok) throw new Error('unreachable')
  assert.equal(refused.error.code, 'BAD_REQUEST')

  // And the prompt is still standing, which is the half that matters: a refused
  // answer must not have consumed the question.
  assert.equal(chatOf(h, viewId).pendingQuestion?.question, 'Which?')

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await asking
  h.stopWatching()
})

test('an external operator may answer, exactly as with a permission prompt', async () => {
  // The reverse case. A client holding the main token already has full control
  // of this window (PLAN §7); refusing it here would buy nothing and would break
  // driving peek from outside.
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  const answered = await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'mcp')
  assert.equal(answered.ok, true)

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.deepEqual(res.data.selected, [{ optionId: 'day', label: 'By day' }])
  h.stopWatching()
})

/* ------------------------------------------------------------------ */
/* Answers that are not answers                                        */
/* ------------------------------------------------------------------ */

test('an option that was never offered is refused, and the prompt stays up', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  const refused = await h.bus.dispatch('chat.answer', { viewId, optionIds: ['month'] }, 'ui')
  assert.equal(refused.ok, false)
  assert.ok(chatOf(h, viewId).pendingQuestion)

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await asking
  h.stopWatching()
})

test('a single-choice question refuses two answers', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  const refused = await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day', 'week'] }, 'ui')
  assert.equal(refused.ok, false)

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await asking
  h.stopWatching()
})

test('a multi-select question takes both', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch(
    'chat.ask',
    { viewId, question: 'Which?', options: TWO_OPTIONS, multiSelect: true },
    'agent',
  )
  await tick()
  assert.equal(chatOf(h, viewId).pendingQuestion?.multiSelect, true)

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day', 'week'] }, 'ui')

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.equal(res.data.selected.length, 2)
  h.stopWatching()
})

test('an answer for a question that is no longer the one being asked is refused', async () => {
  // The stale-answer race, the same one `chat.respondPermission` guards: a turn
  // can ask a second question while the first is still being read.
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  const stale = await h.bus.dispatch(
    'chat.answer',
    { viewId, optionIds: ['day'], requestId: 'ask_nope' },
    'ui',
  )
  assert.equal(stale.ok, false)
  if (stale.ok) throw new Error('unreachable')
  assert.equal(stale.error.code, 'CONFLICT')

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await asking
  h.stopWatching()
})

test('answering a conversation that was not asked anything is refused', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  assert.equal(res.ok, false)
  if (res.ok) throw new Error('unreachable')
  assert.equal(res.error.code, 'CONFLICT')
  h.stopWatching()
})

test('two answers with one id are refused before anything is shown', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const res = await h.bus.dispatch(
    'chat.ask',
    {
      viewId,
      question: 'Which?',
      options: [
        { optionId: 'a', label: 'One' },
        { optionId: 'a', label: 'Two' },
      ],
    },
    'agent',
  )
  assert.equal(res.ok, false)
  assert.equal(chatOf(h, viewId).pendingQuestion, undefined)
  h.stopWatching()
})

/* ------------------------------------------------------------------ */
/* Nothing is left hanging                                             */
/* ------------------------------------------------------------------ */

test('cancelling the turn settles the question instead of stranding it', async () => {
  // Without the reconciliation in `watchQuestions`, this `chat.ask` would hang
  // for five minutes after the user pressed stop — a tool call outliving the
  // turn that made it.
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  await h.bus.dispatch('chat.cancel', { viewId }, 'ui')
  await tick()

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.equal(res.data.answered, false)
  assert.equal(res.data.reason, 'cancelled')
  assert.equal(chatOf(h, viewId).pendingQuestion, undefined)
  h.stopWatching()
})

test('closing the conversation settles the question', async () => {
  const h = harness()
  const viewId = await openChat(h)
  const asking = h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  await tick()

  await h.bus.dispatch('view.close', { viewId }, 'ui')
  await tick()

  const res = await asking
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.equal(res.data.answered, false)
  h.stopWatching()
})

test('nobody answering comes back as a timeout, not as an error', async () => {
  // `answered: false` is a first-class outcome. An errored tool call invites a
  // retry, and re-asking a question nobody was there to answer is exactly wrong.
  const h = harness(5)
  const viewId = await openChat(h)

  const res = await h.bus.dispatch('chat.ask', { viewId, question: 'Which?', options: TWO_OPTIONS }, 'agent')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  assert.equal(res.data.answered, false)
  assert.equal(res.data.reason, 'timeout')
  assert.equal(chatOf(h, viewId).pendingQuestion, undefined)
  h.stopWatching()
})

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

test('a second question waits its turn rather than overwriting the first', async () => {
  const h = harness()
  const viewId = await openChat(h)

  const first = h.bus.dispatch('chat.ask', { viewId, question: 'First?', options: TWO_OPTIONS }, 'agent')
  const second = h.bus.dispatch('chat.ask', { viewId, question: 'Second?', options: TWO_OPTIONS }, 'agent')
  await tick()

  assert.equal(chatOf(h, viewId).pendingQuestion?.question, 'First?')

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['day'] }, 'ui')
  await first
  await tick()

  // Answering promotes the next one rather than clearing the field: that
  // distinction is what `2026-08-03-concurrent-permission-prompts.md` is about.
  assert.equal(chatOf(h, viewId).pendingQuestion?.question, 'Second?')

  await h.bus.dispatch('chat.answer', { viewId, optionIds: ['week'] }, 'ui')
  const res = await second
  assert.equal(res.ok, true)
  h.stopWatching()
})

test('a queued question is not charged for time it was never shown', () => {
  // The broker on its own: the clock starts on display, so the second entry has
  // no timer while it waits.
  let now = 1_000
  const shown: (string | null)[] = []
  const broker = new QuestionBroker({
    onActive: (_chatId, pending) => shown.push(pending?.question ?? null),
    now: () => now,
  })
  const chatId = 'chat_1' as ChatId
  const base = { chatId, options: TWO_OPTIONS, multiSelect: false, timeoutMs: 10_000 }

  const first = broker.open({ ...base, question: 'First?' })
  now = 9_000
  broker.open({ ...base, question: 'Second?' })

  assert.deepEqual(shown, ['First?'])
  assert.equal(broker.activeFor(chatId)?.question, 'First?')

  broker.resolve(first.pending.requestId, ['day'])
  assert.deepEqual(shown, ['First?', 'Second?'])
  assert.equal(broker.pendingCount, 1)
})

test('a settled question cannot be settled twice', async () => {
  const broker = new QuestionBroker({ onActive: () => undefined })
  const ticket = broker.open({
    chatId: 'chat_1' as ChatId,
    question: 'Which?',
    options: TWO_OPTIONS,
    multiSelect: false,
    timeoutMs: 10_000,
  })

  assert.equal(broker.resolve(ticket.pending.requestId, ['day']), true)
  assert.equal(broker.resolve(ticket.pending.requestId, ['week']), false)
  assert.equal(broker.cancel(ticket.pending.requestId, 'shutdown'), false)

  const outcome = await ticket.outcome
  assert.deepEqual(outcome, { kind: 'answered', optionIds: ['day'] })
  assert.equal(broker.pendingCount, 0)
})

test('shutdown settles everything outstanding', async () => {
  const broker = new QuestionBroker({ onActive: () => undefined })
  const base = { options: TWO_OPTIONS, multiSelect: false, timeoutMs: 10_000 }
  const a = broker.open({ ...base, chatId: 'chat_1' as ChatId, question: 'A?' })
  const b = broker.open({ ...base, chatId: 'chat_2' as ChatId, question: 'B?' })

  assert.equal(broker.cancelAll(null, 'shutdown'), 2)
  assert.deepEqual(await a.outcome, { kind: 'unanswered', reason: 'shutdown' })
  assert.deepEqual(await b.outcome, { kind: 'unanswered', reason: 'shutdown' })
  assert.equal(broker.pendingCount, 0)
})
