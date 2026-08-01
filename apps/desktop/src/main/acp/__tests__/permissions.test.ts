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
