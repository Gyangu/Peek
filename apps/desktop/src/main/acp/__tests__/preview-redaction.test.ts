/**
 * The permission prompt must not publish a password.
 *
 * ## The hole these tests close
 *
 * `previewInput` used to `JSON.stringify` the agent's raw tool arguments and show
 * the result. That string is not local: it becomes
 * `PendingPermission.inputPreview`, which is Workspace state — `summarizeChat`
 * carries it into the outward snapshot `read_workspace` returns to any MCP caller
 * holding the bearer token, and the same field is broadcast to the renderer, for
 * as long as the prompt stands (up to `permissionMs`).
 *
 * The scenario is not hypothetical: peek's own MCP instructions teach an agent to
 * call `connect` with a DSN, so the very first permission prompt of a session is
 * the one that carries `postgresql://user:password@host/db`. The same field is
 * already scrubbed on the way to the command log (`redactCommandInput`, which
 * says in as many words that a `conn.open` password never reaches disk), so this
 * path was a hole in an otherwise closed surface.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId } from '@peek/core'
import type { PermissionOption as AcpPermissionOption } from '@agentclientprotocol/sdk'
import { previewInput, redactToolInput } from '../errors'
import { PermissionBroker } from '../../agent/permissions'

const PASSWORD = 'SuperSecret123'

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

test('a connect config loses its password and its DSN credentials', () => {
  const preview = previewInput({
    config: {
      driverId: 'postgres',
      url: `postgresql://admin:${PASSWORD}@prod-db:5432/app`,
      password: PASSWORD,
    },
  })
  assert.ok(!preview.includes(PASSWORD), `the password leaked: ${preview}`)
  // Redacted, not blanked: the user is being asked to approve a connection and
  // still has to be able to see which server it goes to.
  assert.ok(preview.includes('prod-db'), preview)
  assert.ok(preview.includes('admin'), preview)
  assert.ok(preview.includes('***'), preview)
})

test('the DSN observed in a real session is masked', () => {
  // Verbatim from the security run: this is what stood in the permission prompt.
  const preview = previewInput({
    config: { driverId: 'mysql', url: 'mysql://root:peektest@127.0.0.1:3307/peek_test' },
  })
  assert.ok(!preview.includes('peektest'), preview)
  assert.ok(preview.includes('mysql://root:***@127.0.0.1:3307/peek_test'), preview)
})

test('a qdrant api key never reaches the prompt', () => {
  const preview = previewInput({
    config: { driverId: 'qdrant', url: 'http://localhost:6333', apiKey: 'qk_live_abc123' },
  })
  assert.ok(!preview.includes('qk_live_abc123'), preview)
  assert.ok(preview.includes('localhost:6333'), preview)
})

test('secret-looking argument names are masked for tools peek knows nothing about', () => {
  for (const key of ['password', 'token', 'apiKey', 'api_key', 'secret', 'authorization', 'clientSecret']) {
    const preview = previewInput({ [key]: 'hunter2-value' })
    assert.ok(!preview.includes('hunter2-value'), `${key} leaked: ${preview}`)
  }
})

test('a credential nested anywhere in the payload is still masked', () => {
  const preview = previewInput({
    command: 'psql',
    env: { steps: [{ connection: { url: `postgres://svc:${PASSWORD}@10.0.0.4/warehouse` } }] },
  })
  assert.ok(!preview.includes(PASSWORD), preview)
  assert.ok(preview.includes('10.0.0.4'), preview)
})

test('a DSN in a plain-string argument is masked too', () => {
  const preview = previewInput(`mysql -h db --uri mysql://root:${PASSWORD}@db:3306/app`)
  assert.ok(!preview.includes(PASSWORD), preview)
})

test('over-masking is avoided: an ordinary argument is shown as it is', () => {
  const preview = previewInput({
    viewId: 'view_3',
    sort: [{ column: 'created_at', dir: 'desc' }],
    withLayoutTree: true,
  })
  assert.ok(preview.includes('created_at'), preview)
  assert.ok(!preview.includes('***'), preview)
})

test('redaction does not resurrect the unbounded-preview problem', () => {
  const preview = previewInput({ rows: 'r'.repeat(10_000) }, 50)
  assert.ok(preview.length <= 51)
})

test('a payload JSON cannot serialise still produces a preview rather than a throw', () => {
  const cyclic: Record<string, unknown> = { password: PASSWORD }
  cyclic['self'] = cyclic
  const preview = previewInput(cyclic)
  assert.ok(!preview.includes(PASSWORD), preview)
  assert.ok(preview.includes('[circular]'), preview)
})

test('a deeply nested payload is truncated rather than walked forever', () => {
  let deep: Record<string, unknown> = { password: PASSWORD }
  for (let i = 0; i < 40; i += 1) deep = { nested: deep }
  const preview = previewInput(deep, 2_000)
  assert.ok(!preview.includes(PASSWORD), preview)
})

test('a non-object argument is passed through untouched', () => {
  assert.equal(redactToolInput(42), 42)
  assert.equal(redactToolInput(null), null)
  assert.equal(previewInput(undefined), '')
})

test('the pending permission the Workspace publishes carries no cleartext password', async () => {
  const broker = new PermissionBroker()
  const ticket = broker.open({
    chatId: asChatId('chat_sec'),
    toolCallId: 'toolu_1',
    toolName: 'mcp__peek__connect',
    rawInput: {
      config: {
        driverId: 'postgres',
        url: `postgresql://admin:${PASSWORD}@prod-db:5432/app`,
        password: PASSWORD,
      },
      openTree: true,
    },
    options: OPTIONS,
    timeoutMs: 10_000,
  })
  // The whole record, because every field of it is broadcast and snapshotted.
  assert.ok(!JSON.stringify(ticket.pending).includes(PASSWORD))
  assert.ok(ticket.pending.inputPreview.includes('***'))
  broker.cancel(ticket.pending.requestId, 'shutdown')
  await ticket.decision
})
