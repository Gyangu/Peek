/**
 * Tests for the permission gate.
 *
 * Every assertion here is about safety rather than convenience: an unanswered
 * prompt must decline rather than allow, an option peek never offered must not
 * be forwarded to the agent, and every exit path must settle the promise the
 * agent is blocked on exactly once.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId } from '@peek/core'
import type { PermissionOption as AcpPermissionOption } from '@agentclientprotocol/sdk'
import { PermissionBroker, toPermissionOptions } from '../permissions'

const CHAT = asChatId('chat_perm')

/** The exact options a real `session/request_permission` carries. */
const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow_always', name: 'Always Allow all mcp__peek__read_workspace', kind: 'allow_always' },
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

function open(broker: PermissionBroker, timeoutMs = 10_000) {
  return broker.open({
    chatId: CHAT,
    toolCallId: 'toolu_1',
    toolName: 'mcp__peek__read_workspace',
    rawInput: { withLayoutTree: true },
    options: OPTIONS,
    timeoutMs,
  })
}

test('optionId and kind are carried separately, because they differ', () => {
  const options = toPermissionOptions(OPTIONS)
  const allowOnce = options.find((option) => option.kind === 'allow_once')
  assert.equal(allowOnce?.optionId, 'allow', 'the id is "allow" while the kind is "allow_once"')
})

test('an unrecognised option kind is presented as a rejection, never as an allow', () => {
  const options = toPermissionOptions([
    { optionId: 'weird', name: 'Weird', kind: 'something_new' as AcpPermissionOption['kind'] },
  ])
  assert.equal(options[0]?.kind, 'reject_once')
})

test('resolving with an offered option settles as selected', async () => {
  const broker = new PermissionBroker()
  const ticket = open(broker)
  assert.equal(broker.resolve(ticket.pending.requestId, 'allow'), true)
  assert.deepEqual(await ticket.decision, { kind: 'selected', optionId: 'allow' })
  assert.equal(broker.pendingCount, 0)
})

test('an option that was never offered is refused and leaves the prompt standing', async () => {
  const broker = new PermissionBroker()
  const ticket = open(broker)
  assert.equal(broker.resolve(ticket.pending.requestId, 'bypassPermissions'), false)
  assert.equal(broker.pendingCount, 1, 'the request is still outstanding')

  broker.resolve(ticket.pending.requestId, 'reject')
  assert.deepEqual(await ticket.decision, { kind: 'selected', optionId: 'reject' })
})

test('an unanswered prompt times out as cancelled, not as allowed', async () => {
  const broker = new PermissionBroker()
  const ticket = open(broker, 1)
  const decision = await ticket.decision
  assert.deepEqual(decision, { kind: 'cancelled', reason: 'timeout' })
})

test('a second answer after settlement is a no-op', async () => {
  const broker = new PermissionBroker()
  const ticket = open(broker)
  broker.resolve(ticket.pending.requestId, 'allow')
  assert.equal(broker.resolve(ticket.pending.requestId, 'reject'), false)
  assert.deepEqual(await ticket.decision, { kind: 'selected', optionId: 'allow' })
})

test('cancelAll settles every outstanding prompt for the chat', async () => {
  const broker = new PermissionBroker()
  const first = open(broker)
  const second = open(broker)
  assert.equal(broker.cancelAll(CHAT, 'agent-gone'), 2)
  assert.deepEqual(await first.decision, { kind: 'cancelled', reason: 'agent-gone' })
  assert.deepEqual(await second.decision, { kind: 'cancelled', reason: 'agent-gone' })
  assert.equal(broker.pendingCount, 0)
})

test('cancelAll for a different chat leaves this one alone', () => {
  const broker = new PermissionBroker()
  open(broker)
  assert.equal(broker.cancelAll(asChatId('chat_other'), 'shutdown'), 0)
  assert.equal(broker.pendingCount, 1)
})

test('the published prompt truncates the arguments instead of inlining them', () => {
  const broker = new PermissionBroker()
  const ticket = broker.open({
    chatId: CHAT,
    toolCallId: 't',
    toolName: 'x',
    rawInput: { blob: 'y'.repeat(5_000) },
    options: OPTIONS,
    timeoutMs: 1_000,
  })
  assert.ok(ticket.pending.inputPreview.length <= 301, 'the preview is bounded')
  broker.cancelAll(null, 'shutdown')
})

test('request ids are unique across prompts', () => {
  const broker = new PermissionBroker()
  const ids = new Set([open(broker).pending.requestId, open(broker).pending.requestId])
  assert.equal(ids.size, 2)
  broker.cancelAll(null, 'shutdown')
})

/* ================================================================== */
/* The queue: one prompt at a time, per chat                           */
/* ================================================================== */

/*
 * These cover a bug that shipped: an agent asked for three tools at once, each
 * `open()` overwrote `pendingPermission`, and the user could only ever see and
 * answer the last one. The first two became unanswerable — no control on screen
 * referred to them — so the turn sat there until a five-minute timeout while the
 * panel still said "streaming".
 *
 * See `docs/design/2026-08-03-concurrent-permission-prompts.md`.
 */

interface QueueHarness {
  broker: PermissionBroker
  /** Every `onActive` call, in order. */
  active: (string | null)[]
  ask: (toolCallId: string, chatId?: ReturnType<typeof asChatId>, timeoutMs?: number) => ReturnType<PermissionBroker['open']>
}

function queued(): QueueHarness {
  const active: (string | null)[] = []
  const broker = new PermissionBroker({
    onActive: (_chatId, pending) => {
      active.push(pending?.toolCallId ?? null)
    },
  })
  return {
    broker,
    active,
    ask: (toolCallId, chatId = CHAT, timeoutMs = 10_000) =>
      broker.open({
        chatId,
        toolCallId,
        toolName: `mcp__peek__${toolCallId}`,
        rawInput: {},
        options: OPTIONS,
        timeoutMs,
      }),
  }
}

test('three parallel requests announce only the first', () => {
  const h = queued()
  h.ask('a')
  h.ask('b')
  h.ask('c')
  // The bug was that b and c each overwrote what was on screen. Now they wait.
  assert.deepEqual(h.active, ['a'])
  assert.equal(h.broker.activeFor(CHAT)?.toolCallId, 'a')
  assert.equal(h.broker.pendingCount, 3)
})

test('answering one promotes the next rather than clearing the prompt', async () => {
  const h = queued()
  const first = h.ask('a')
  h.ask('b')

  h.broker.resolve(first.pending.requestId, 'allow')
  await first.decision

  // The direct inverse of the bug: `pendingPermission` is *replaced*, not nulled.
  assert.deepEqual(h.active, ['a', 'b'])
  assert.equal(h.broker.activeFor(CHAT)?.toolCallId, 'b')
})

test('null comes only when the queue is genuinely empty', async () => {
  const h = queued()
  const a = h.ask('a')
  const b = h.ask('b')

  h.broker.resolve(a.pending.requestId, 'allow')
  await a.decision
  h.broker.resolve(b.pending.requestId, 'reject')
  await b.decision

  assert.deepEqual(h.active, ['a', 'b', null])
  assert.equal(h.broker.activeFor(CHAT), null)
  assert.equal(h.broker.pendingCount, 0)
})

test('a queued request is not timed until it is shown', async () => {
  // The trap this design has to avoid: `timeoutMs` is the budget for a person to
  // read and decide. If it ran while queued, the third request could expire
  // before anyone saw it — declining a tool call because the user failed to
  // answer a question they were never asked.
  const h = queued()
  const a = h.ask('a', CHAT, 40)
  const b = h.ask('b', CHAT, 40)

  await new Promise((resolve) => setTimeout(resolve, 80))
  // `a` was on screen and has timed out; `b` was queued, so its clock had not
  // started — and it is only now becoming visible.
  assert.equal((await a.decision).kind, 'cancelled')
  assert.equal(h.broker.activeFor(CHAT)?.toolCallId, 'b')

  // And it gets its full budget from here.
  h.broker.resolve(b.pending.requestId, 'allow')
  assert.deepEqual(await b.decision, { kind: 'selected', optionId: 'allow' })
})

test('cancelAll clears the active one and the queued ones together', async () => {
  const h = queued()
  const a = h.ask('a')
  const b = h.ask('b')
  const c = h.ask('c')

  assert.equal(h.broker.cancelAll(CHAT, 'turn-cancelled'), 3)
  for (const ticket of [a, b, c]) {
    assert.equal((await ticket.decision).kind, 'cancelled')
  }
  // Exactly one announcement, and it dismisses the dialog. Walking the queue
  // would have flashed each doomed prompt on screen on its way past.
  assert.deepEqual(h.active, ['a', null])
  assert.equal(h.broker.pendingCount, 0)
})

test('cancelling a queued request leaves the active one alone', async () => {
  const h = queued()
  const a = h.ask('a')
  const b = h.ask('b')

  assert.equal(h.broker.cancel(b.pending.requestId, 'user'), true)
  assert.equal((await b.decision).kind, 'cancelled')
  // `a` is untouched and still the one on screen.
  assert.deepEqual(h.active, ['a'])
  assert.equal(h.broker.activeFor(CHAT)?.toolCallId, 'a')

  h.broker.resolve(a.pending.requestId, 'allow')
  await a.decision
  assert.deepEqual(h.active, ['a', null])
})

test('queues are per chat and do not block each other', () => {
  const h = queued()
  const other = asChatId('chat_other')
  h.ask('a')
  h.ask('b')
  h.ask('x', other)

  // Two conversations, two prompts, neither waiting on the other.
  assert.deepEqual(h.active, ['a', 'x'])
  assert.equal(h.broker.activeFor(CHAT)?.toolCallId, 'a')
  assert.equal(h.broker.activeFor(other)?.toolCallId, 'x')
})
