/**
 * Tests for cancel_query, and for the timeout knob run_query now advertises.
 *
 * Same boundary as the other tool tests: a fake dispatch records what the tool
 * decided to send. What `query.cancel` then does to the workspace belongs to the
 * handler and is covered by bus/__tests__/cancel-and-timeout.test.ts.
 *
 * The gap this closes is worth restating: until M6 the tool registry could start
 * a hundred-million-row query and had no verb at all for stopping one. Everything
 * below is about that verb existing, mapping to the Command that already existed,
 * and describing its cost truthfully.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asConnId,
  asPanelId,
  asResultId,
  asSplitId,
  asViewId,
  commandOk,
  peekError,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type CommandResultFor,
  type LayoutNode,
  type WorkspaceSnapshot,
} from '@peek/core'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import cancelQuery from '../tools/cancel'
import runQuery from '../tools/run-query'
import type { CommandDispatch, ToolContext, ToolOutput } from '../types'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Dispatched {
  name: CommandName
  input: unknown
}

const LAYOUT: LayoutNode = {
  type: 'split',
  id: asSplitId('split_1'),
  dir: 'row',
  ratio: [1],
  children: [
    { type: 'panel', id: asPanelId('panel_a'), viewIds: [asViewId('view_1')], activeViewId: asViewId('view_1') },
  ],
}

function snapshot(): WorkspaceSnapshot {
  return {
    rev: 3,
    layout: LAYOUT,
    focusedPanel: asPanelId('panel_a'),
    connections: [
      {
        id: asConnId('conn_1'),
        driverId: 'postgres',
        label: 'local',
        status: 'ready',
        capabilities: ['tabularQuery', 'cancel'],
        config: { driverId: 'postgres', url: 'postgresql://app@localhost:5432/demo' },
      },
    ],
    views: [
      {
        id: asViewId('view_1'),
        kind: 'query',
        connId: asConnId('conn_1'),
        title: 'view_1',
        status: 'loading',
        describe: 'Query select 1',
        panelId: asPanelId('panel_a'),
        tabIndex: 0,
        visible: true,
      },
    ],
    results: [],
  }
}

interface Harness {
  ctx: ToolContext
  sent: Dispatched[]
}

function harness(reply: (cmd: Dispatched) => CommandResult<unknown>): Harness {
  const sent: Dispatched[] = []
  const dispatch: CommandDispatch = async <K extends CommandName>(
    name: K,
    input: CommandInput<K>,
  ): Promise<CommandResultFor<K>> => {
    const cmd: Dispatched = { name, input }
    sent.push(cmd)
    return reply(cmd) as CommandResultFor<K>
  }
  const ctx: ToolContext = {
    dispatch,
    getSnapshot: snapshot,
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }
  return { ctx, sent }
}

function ok(data: unknown): CommandResult<unknown> {
  return commandOk('cmd_1', 4, data)
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

test('cancel_query is registered — an AI that can start work can now stop it', () => {
  // The registry collects tools with `import.meta.glob('./tools/*.ts')`, which is
  // a build-time Vite construct and cannot be called from node:test. The directory
  // listing is exactly what that glob expands to, so checking the file is there —
  // and that it default-exports a usable PeekTool — proves the same thing without
  // pulling a bundler into the test.
  const toolsDir = fileURLToPath(new URL('../tools/', import.meta.url))
  const files = readdirSync(toolsDir)
  assert.ok(files.includes('cancel.ts'), `cancel.ts missing from ${files.join(', ')}`)
  // The pairing is the point: run_query without cancel_query is the M6 complaint.
  assert.ok(files.includes('run-query.ts'))

  assert.equal(cancelQuery.name, 'cancel_query')
  assert.equal(typeof cancelQuery.run, 'function')
  assert.equal(cancelQuery.readOnly, false)
})

test('it is a thin shell: one Command, the input passed through unaltered', async () => {
  const h = harness(() => ok({ resultId: 'res_9', cancelled: true }))
  await cancelQuery.run({ resultId: 'res_9' }, h.ctx)
  assert.deepEqual(h.sent, [{ name: 'query.cancel', input: { resultId: 'res_9' } }])
})

test('a viewId is forwarded just as faithfully', async () => {
  const h = harness(() => ok({ resultId: 'res_9', cancelled: true }))
  await cancelQuery.run({ viewId: 'view_1' }, h.ctx)
  assert.deepEqual(h.sent, [{ name: 'query.cancel', input: { viewId: 'view_1' } }])
})

/* ------------------------------------------------------------------ */
/* Receipts                                                            */
/* ------------------------------------------------------------------ */

test('a successful cancel says the loaded rows survive — it is not a failure', async () => {
  const h = harness(() => ok({ resultId: asResultId('res_9'), cancelled: true }))
  const out: ToolOutput = await cancelQuery.run({ resultId: 'res_9' }, h.ctx)
  assert.notEqual(out.isError, true, 'cancelling on purpose must never read as an error')
  assert.match(out.text, /res_9/)
  assert.match(out.text, /remain valid/i)
})

test('cancelling something that already finished is reported as such, not as an error to retry', async () => {
  const h = harness(() => ok({ resultId: asResultId('res_9'), cancelled: false }))
  const out = await cancelQuery.run({ resultId: 'res_9' }, h.ctx)
  assert.notEqual(out.isError, true)
  assert.match(out.text, /was not running/i)
  const data = out.data as { cancelled: boolean }
  assert.equal(data.cancelled, false)
})

test('a refused command surfaces as a tool error rather than a cheerful receipt', async () => {
  const h = harness(() => ({
    ok: false as const,
    commandId: 'cmd_1',
    error: peekError('NOT_FOUND', 'result res_nope is unknown'),
  }))
  const out = await cancelQuery.run({ resultId: 'res_nope' }, h.ctx)
  assert.equal(out.isError, true)
  assert.match(out.text, /NOT_FOUND/)
})

test('neither resultId nor viewId is rejected before it can reach the bus', async () => {
  const h = harness(() => ok({}))
  const out = await cancelQuery.run({}, h.ctx)
  assert.equal(out.isError, true)
  assert.deepEqual(h.sent, [], 'the Command Bus is never bothered with an unaddressable cancel')
})

/* ------------------------------------------------------------------ */
/* The description carries the cost                                    */
/* ------------------------------------------------------------------ */

test('the description states the price of cancelling on a driver without the capability', () => {
  // A model that cannot see this reaches for cancel where waiting was cheaper.
  assert.match(cancelQuery.description, /kill the driver process/i)
  assert.match(cancelQuery.description, /cancel/i)
  assert.match(cancelQuery.description, /list_connections/)
})

/* ------------------------------------------------------------------ */
/* run_query's timeout knob                                            */
/* ------------------------------------------------------------------ */

test('run_query forwards timeoutMs to query.run, and does not confuse it with waitMs', async () => {
  const h = harness((cmd) =>
    cmd.name === 'query.run' ? ok({ resultId: asResultId('res_1'), viewId: asViewId('view_1') }) : ok({}),
  )
  await runQuery.run(
    { connId: 'conn_1', text: 'select 1', timeoutMs: 5_000, waitMs: 0, previewRows: 0 },
    h.ctx,
  )
  const sent = h.sent[0]
  assert.equal(sent.name, 'query.run')
  const input = sent.input as Record<string, unknown>
  assert.equal(input['timeoutMs'], 5_000)
  // waitMs bounds how long the *tool call* watches; it must never travel to the bus.
  assert.equal('waitMs' in input, false)
  assert.equal('previewRows' in input, false)
})

test('run_query documents the deadline and points at cancel_query', () => {
  const schema = runQuery.inputSchema as unknown as { shape?: Record<string, { description?: string }> }
  const described = schema.shape?.['timeoutMs']?.description ?? ''
  assert.match(described, /TIMEOUT/, 'a model has to know what the failure looks like')
  assert.match(described, /waitMs/, 'the two are easy to confuse; the schema says which is which')
  assert.match(described, /cancel_query/)
  assert.match(runQuery.description, /timeoutMs/)
})
