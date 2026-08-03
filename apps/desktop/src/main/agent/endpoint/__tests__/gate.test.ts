/**
 * The permission gate, on the endpoint backend.
 *
 * This is the file that pins down the chat panel's central promise for this
 * backend: **a tool call the user did not approve does not run.** `pi-agent-core`
 * expresses that as `beforeToolCall` returning `{ block: true }`, so what is
 * being checked here is the exact vocabulary the loop hands back to the library —
 * `undefined` means go ahead, and anything else means stop.
 *
 * The refusals are checked separately because they differ in *why* nobody
 * approved: the user said no, the turn was cancelled underneath the question, or
 * nobody answered at all. All three have to reach the same place, and only one of
 * them involves the user doing anything.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId, type PendingPermission } from '@peek/core'
import { PermissionBroker } from '../../permissions'
import { PERMISSION_OPTIONS, requestToolPermission } from '../gate'

const CHAT = asChatId('chat_gate')

interface Harness {
  broker: PermissionBroker
  announced: (PendingPermission | null)[]
  latest: () => PendingPermission | null
  ask: (mode?: 'default' | 'bypassPermissions') => Promise<{ block: true; reason: string } | undefined>
}

function harness(timeoutMs = 60_000): Harness {
  const announced: (PendingPermission | null)[] = []
  // The broker announces, not the gate: with tools running in parallel a request
  // may have to queue behind one the user is still reading.
  const broker = new PermissionBroker({
    onActive: (_chatId, pending) => {
      announced.push(pending)
    },
  })
  return {
    broker,
    announced,
    latest: () => {
      for (let i = announced.length - 1; i >= 0; i -= 1) {
        const value = announced[i]
        if (value) return value
      }
      return null
    },
    ask: (mode = 'default') =>
      requestToolPermission(
        { chatId: CHAT, toolCallId: 'call_1', toolName: 'mcp__peek__view_open', args: { ref: 'public.t' }, mode },
        { broker, timeoutMs },
      ),
  }
}

test('the prompt reaches the window before anything is awaited', async () => {
  const h = harness()
  const decision = h.ask()

  // Synchronously after the call, with no await in between: a prompt announced
  // later than its own answer is a prompt the user can be shown after it has
  // already been consumed.
  const prompt = h.latest()
  assert.ok(prompt, 'the window is told what is being asked')
  assert.equal(prompt.toolName, 'mcp__peek__view_open')

  h.broker.resolve(prompt.requestId, 'allow')
  await decision
})

test('an approval returns undefined — the library’s "go ahead"', async () => {
  const h = harness()
  const decision = h.ask()
  h.broker.resolve(h.latest()!.requestId, 'allow')
  assert.equal(await decision, undefined)
  // And the prompt does not outlive the answer.
  assert.equal(h.announced.at(-1), null)
})

test('an explicit refusal blocks, and says who refused', async () => {
  const h = harness()
  const decision = h.ask()
  h.broker.resolve(h.latest()!.requestId, 'reject')

  const result = await decision
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /declined/i)
  assert.equal(h.announced.at(-1), null)
})

test('a cancelled turn blocks the pending call', async () => {
  const h = harness()
  const decision = h.ask()
  assert.ok(h.latest())

  h.broker.cancelAll(CHAT, 'turn-cancelled')
  const result = await decision
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /cancelled/i)
})

test('nobody answering blocks too — an absent user is not a consenting user', async () => {
  // The whole reason the broker's timeout answers `cancelled` rather than
  // `allow`: a laptop left unattended must not be able to grant anything.
  const h = harness(10)
  const result = await h.ask()
  assert.equal(result?.block, true)
  assert.match(result?.reason ?? '', /in time/i)
})

test('shutdown blocks every pending call', async () => {
  const h = harness()
  const decision = h.ask()
  assert.ok(h.latest())

  h.broker.cancelAll(null, 'shutdown')
  const result = await decision
  assert.equal(result?.block, true)
})

test('bypassPermissions raises no prompt at all', async () => {
  const h = harness()
  // Allowed because it is a mode the user chose in front of a dialog that says
  // what it means — not something a tool call can talk its way into.
  assert.equal(await h.ask('bypassPermissions'), undefined)
  assert.deepEqual(h.announced, [], 'nothing was ever asked')
})

test('the options offered are allow-once and reject, and nothing standing', () => {
  // `allow_always` is deliberately absent: a standing grant is a permission mode,
  // not something to acquire by clicking quickly through a prompt.
  assert.deepEqual(
    PERMISSION_OPTIONS.map((o) => o.kind).sort(),
    ['allow_once', 'reject_once'],
  )
})

test('an answer that was never offered is refused by the broker', async () => {
  const h = harness()
  const decision = h.ask()
  const prompt = h.latest()!

  // The gate hands the broker exactly the ids it offered; anything else — a
  // renderer bug, a replayed message, a forged id — must not settle the request.
  assert.equal(h.broker.resolve(prompt.requestId, 'allow_always'), false)
  assert.equal(h.broker.resolve(prompt.requestId, 'allow'), true)
  assert.equal(await decision, undefined)
})
