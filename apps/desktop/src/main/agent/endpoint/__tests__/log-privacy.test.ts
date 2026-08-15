import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogRecord } from '@peek/core'
import { createLogger } from '@peek/core'
import { classifyAgentEvent } from '../events'

/**
 * The agent's diagnostics record **shapes, not contents**.
 *
 * This is the test in the whole feature whose failure has no symptom. Every
 * other guarantee here announces itself when it breaks — a log that stops
 * rotating fills the disk, a level that stops applying floods the panel. This
 * one breaks by working *too well*: the log gets more useful, nobody complains,
 * and `~/.peek/logs/peek.log` quietly becomes a verbatim transcript of every
 * conversation the user has ever had with the model.
 *
 * The rule it defends: `chat.send`'s prompt is already truncated to 500
 * characters before it reaches the audit (`redactCommandInput`, whose comment
 * calls the untruncated version "a multi-megabyte retention of whatever the user
 * typed"). A debug-level agent log that copied `text_delta` through would route
 * around that limit **token by token**, which is worse than never having had it.
 *
 * And it costs nothing: none of the four blind spots §3.7 of the design note
 * fixes needs content. Which event type went unrecognised, which tool call
 * lacked an id, which schema would not convert — all shape.
 */

function replayTurnIntoLog(): LogRecord[] {
  const records: LogRecord[] = []
  const log = createLogger({
    ns: 'agent',
    sink: (record) => records.push(record),
    minLevel: () => 'debug',
  }).with('chat_test')

  // A turn carrying the two things that must not be copied: what the model said,
  // and what it passed to a tool.
  const events: unknown[] = [
    { type: 'message_start', message: { role: 'user' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: SECRET_PROSE } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: SECRET_ARGS } },
    { type: 'tool_execution_start', toolName: 'run_query', args: { sql: SECRET_ARGS } },
    { type: 'tool_execution_end', result: { rows: [[SECRET_PROSE]] } },
    { type: 'turn_end' },
    { type: 'a_shape_from_the_future', payload: SECRET_PROSE },
  ]

  // Exactly what `EndpointManager.#onAgentEvent` does with an ignored outcome.
  for (const raw of events) {
    const outcome = classifyAgentEvent(raw)
    if (outcome.kind === 'ignored') log.log(outcome.level, `event ignored: ${outcome.reason}`)
  }
  return records
}

const SECRET_PROSE = 'the user asked about their salary of 123456'
const SECRET_ARGS = 'SELECT * FROM payroll WHERE name = \'alice\''

test('no conversation text or tool argument reaches a log record', () => {
  const records = replayTurnIntoLog()
  const rendered = JSON.stringify(records)

  assert.ok(!rendered.includes(SECRET_PROSE), 'assistant prose leaked into the log')
  assert.ok(!rendered.includes(SECRET_ARGS), 'a tool argument leaked into the log')
  assert.ok(!rendered.includes('payroll'), 'a table name from a query leaked into the log')
  assert.ok(!rendered.includes('123456'), 'a value from the conversation leaked into the log')
})

test('what is recorded is still enough to debug the turn', () => {
  // The other half of the same claim: withholding content would be worthless if
  // it also withheld the diagnosis. It does not — the type of the event peek
  // could not handle is the thing somebody greps for.
  const records = replayTurnIntoLog()
  const messages = records.map((r) => r.message)

  assert.ok(messages.some((m) => m.includes('unknown:a_shape_from_the_future')))
  assert.ok(messages.some((m) => m.includes('tool_execution_start without an id')))
  assert.ok(records.every((r) => r.tag === 'chat_test'), 'every record is attributable to its conversation')
})
