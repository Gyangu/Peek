/**
 * Tests for the endpoint backend's event translation.
 *
 * The property that matters most is not any single delta — it is that this
 * backend's output is **indistinguishable in shape** from the ACP backend's. The
 * renderer, the batcher and the transcript were written against `ChatDelta` and
 * know nothing about which backend answered; the moment that stops being true,
 * a conversation starts looking different depending on who answered it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId, type ChatDelta, type ToolCallRecord } from '@peek/core'
import { classifyAgentEvent, EndpointTranslator } from '../events'

const CHAT = asChatId('chat_test')
const T0 = 1_700_000_000_000

function drain(t: EndpointTranslator, events: Parameters<EndpointTranslator['translate']>[0][]): ChatDelta[] {
  return events.flatMap((event, i) => t.translate(event, T0 + i).deltas)
}

test('a plain answer streams as message.start → text.append → message.end', () => {
  const t = new EndpointTranslator(CHAT)
  const deltas = drain(t, [
    { type: 'assistant_start' },
    { type: 'text', text: 'Four ' },
    { type: 'text', text: 'tables.' },
    { type: 'turn_end', stopReason: 'end_turn' },
  ])

  assert.deepEqual(deltas.map((d) => d.type), ['message.start', 'text.append', 'text.append', 'message.end'])
  // Text arrives raw, in fragments: the renderer re-parses Markdown from the
  // accumulated string, so a delta must never carry structure.
  const appends = deltas.filter((d) => d.type === 'text.append')
  assert.deepEqual(appends.map((d) => (d as { text: string }).text), ['Four ', 'tables.'])
  // Every delta after the first addresses the message the first one opened.
  const id = (deltas[0] as { message: { id: string } }).message.id
  for (const delta of deltas.slice(1)) assert.equal((delta as { messageId: string }).messageId, id)
})

test('text before any start event opens a message rather than being dropped', () => {
  // Losing the first sentence of an answer to a bookkeeping rule helps nobody.
  const t = new EndpointTranslator(CHAT)
  const deltas = drain(t, [{ type: 'text', text: 'Hello' }])
  assert.deepEqual(deltas.map((d) => d.type), ['message.start', 'text.append'])
})

test('a tool call starts pending and is replaced whole on completion', () => {
  const t = new EndpointTranslator(CHAT)
  const deltas = drain(t, [
    { type: 'assistant_start' },
    { type: 'tool_start', id: 'call_1', name: 'mcp__peek__read_workspace', args: { detail: 'full' } },
    { type: 'tool_end', id: 'call_1', output: { views: 2 }, isError: false },
  ])

  const upserts = deltas.filter((d) => d.type === 'tool.upsert').map((d) => (d as { call: ToolCallRecord }).call)
  assert.equal(upserts.length, 2)
  // `pending`, not `in_progress`: the gate runs between these two events, and a
  // row claiming the tool is already running would be lying to the person
  // deciding whether it may.
  assert.equal(upserts[0]?.status, 'pending')
  assert.deepEqual(upserts[0]?.rawInput, { detail: 'full' })
  assert.equal(upserts[1]?.status, 'completed')
  // `tool.upsert` replaces wholesale, so the second record has to carry
  // everything the first one established. Losing `rawInput` here would blank the
  // arguments in the UI the moment a call finished.
  assert.deepEqual(upserts[1]?.rawInput, { detail: 'full' })
  assert.equal(upserts[1]?.title, 'mcp__peek__read_workspace')
  assert.deepEqual(upserts[1]?.rawOutput, { views: 2 })
})

test('a refused tool call is shown as failed, with the reason, not dropped', () => {
  const t = new EndpointTranslator(CHAT)
  const deltas = drain(t, [
    { type: 'assistant_start' },
    { type: 'tool_start', id: 'call_1', name: 'mcp__peek__view_open', args: {} },
    { type: 'tool_blocked', id: 'call_1', reason: 'The user declined this tool call.' },
  ])
  const last = deltas.at(-1) as { call: ToolCallRecord }
  assert.equal(last.call.status, 'failed')
  // A silently dropped row would leave the model's next sentence — "I checked
  // and…" — with nothing on screen to explain it.
  assert.equal(last.call.rawOutput, 'The user declined this tool call.')
})

test('an error ends the turn as a closed message rather than leaving it open', () => {
  const t = new EndpointTranslator(CHAT)
  drain(t, [{ type: 'assistant_start' }, { type: 'text', text: 'Working' }])
  const out = t.finishTurn('error')
  assert.deepEqual(out.deltas.map((d) => d.type), ['message.end'])
  assert.equal((out.deltas[0] as { stopReason: string }).stopReason, 'error')
  // A transcript left mid-answer reads as a hung agent forever.
  assert.equal(out.state.streamingMessageId, null)
})

test('finishing twice is a no-op, so every exit path may settle the turn', () => {
  const t = new EndpointTranslator(CHAT)
  drain(t, [{ type: 'assistant_start' }])
  assert.equal(t.finishTurn('cancelled').deltas.length, 1)
  assert.equal(t.finishTurn('cancelled').deltas.length, 0)
})

test('the preview follows prose and never thinking', () => {
  const t = new EndpointTranslator(CHAT)
  t.translate({ type: 'assistant_start' }, T0)
  const thought = t.translate({ type: 'thinking', text: 'let me consider' }, T0)
  assert.equal(thought.state.lastMessagePreview, undefined)
  const spoken = t.translate({ type: 'text', text: 'Four tables.' }, T0)
  assert.equal(spoken.state.lastMessagePreview, 'Four tables.')
})

test('message counting spans turns and includes the user’s own messages', () => {
  const t = new EndpointTranslator(CHAT)
  t.appendUserMessage('hi', T0)
  const first = t.translate({ type: 'assistant_start' }, T0)
  assert.equal(first.state.messageCount, 2)
  t.translate({ type: 'turn_end', stopReason: 'end_turn' }, T0)
  t.appendUserMessage('hi', T0)
  const second = t.translate({ type: 'assistant_start' }, T0)
  assert.equal(second.state.messageCount, 4)
})

test('reset clears the transcript and the counters together', () => {
  const t = new EndpointTranslator(CHAT)
  t.appendUserMessage('hi', T0)
  drain(t, [{ type: 'assistant_start' }, { type: 'text', text: 'gone' }])
  const out = t.reset()
  assert.deepEqual(out.deltas, [{ type: 'reset', chatId: CHAT }])
  assert.equal(out.state.messageCount, 0)
  assert.equal(out.state.lastMessagePreview, '')
  // And the next message starts from one, not from where it left off.
  assert.equal(t.translate({ type: 'assistant_start' }, T0).state.messageCount, 1)
})

/* ================================================================== */
/* The seam: `pi-agent-core`'s vocabulary → peek's                     */
/* ================================================================== */

/**
 * `classifyAgentEvent` is the contract these tests exist for.
 *
 * It used to be a four-case switch with `default: return` inside `EndpointManager`,
 * which is where an endpoint failure went to die — see
 * `docs/design/2026-08-04-endpoint-keyless-and-stream-errors.md`. Every case
 * below is written against a shape `pi-agent-core` actually emits, so "peek
 * ignores this on purpose" and "peek silently lost this" stop being the same
 * observation.
 */

const assistantEnd = (stopReason: string, errorMessage?: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
})

test('an endpoint failure arrives as a finished assistant message, and is caught', () => {
  // The shape `pi-ai` produces: the exception is written into the message rather
  // than rejecting the stream, and `pi-agent-core` returns it normally. This is
  // the *only* form the failure takes — `AgentEvent` has no `error` member — and
  // dropping it is what turned a broken endpoint into an empty assistant bubble.
  const out = classifyAgentEvent(assistantEnd('error', 'No API key for provider: peek-endpoint'))
  assert.deepEqual(out, { kind: 'failed', message: 'No API key for provider: peek-endpoint' })
})

test('a failure with no message still fails rather than passing as an answer', () => {
  assert.deepEqual(classifyAgentEvent(assistantEnd('error')), { kind: 'failed', message: '' })
})

test('an aborted stream is an abort, not a failure', () => {
  // `cancel()` has normally settled the turn already; reporting an error on a
  // conversation the user deliberately stopped would be its own bug.
  assert.deepEqual(classifyAgentEvent(assistantEnd('aborted')), { kind: 'aborted' })
})

test('a normally finished assistant message does not end the turn here', () => {
  // Deliberate: tool calls stream *after* their message ends, so closing on
  // `message_end` would drop the tool rows into a second bubble.
  assert.equal(classifyAgentEvent(assistantEnd('stop')).kind, 'ignored')
})

test('only the assistant’s message_start opens a bubble', () => {
  // `agent-loop` emits message_start/message_end for the user's prompt, for
  // steering messages and for every tool result too. Opening on all of them was
  // harmless only because the translator ignores a second open; reading a tool
  // result's `stopReason` would not have been.
  assert.deepEqual(classifyAgentEvent({ type: 'message_start', message: { role: 'assistant' } }), {
    kind: 'event',
    event: { type: 'assistant_start' },
  })
  for (const role of ['user', 'toolResult']) {
    assert.equal(classifyAgentEvent({ type: 'message_start', message: { role } }).kind, 'ignored')
  }
})

test('a tool result’s message_end is ignored, not read for a stop reason', () => {
  const out = classifyAgentEvent({ type: 'message_end', message: { role: 'toolResult', isError: true } })
  assert.equal(out.kind, 'ignored')
})

test('text and thinking deltas are forwarded, other stream events are not', () => {
  const update = (type: string, delta?: string) => ({ type: 'message_update', assistantMessageEvent: { type, delta } })
  assert.deepEqual(classifyAgentEvent(update('text_delta', 'Four')), {
    kind: 'event',
    event: { type: 'text', text: 'Four' },
  })
  assert.deepEqual(classifyAgentEvent(update('thinking_delta', 'hm')), {
    kind: 'event',
    event: { type: 'thinking', text: 'hm' },
  })
  // Arguments arrive whole on `tool_execution_start`, so partial tool-call JSON
  // is nothing peek has to reassemble.
  assert.equal(classifyAgentEvent(update('toolcall_delta', '{"a')).kind, 'ignored')
  assert.equal(classifyAgentEvent(update('text_start')).kind, 'ignored')
})

test('tool execution events carry through with their ids intact', () => {
  assert.deepEqual(
    classifyAgentEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read_workspace', args: { a: 1 } }),
    { kind: 'event', event: { type: 'tool_start', id: 'c1', name: 'read_workspace', args: { a: 1 } } },
  )
  assert.deepEqual(
    classifyAgentEvent({ type: 'tool_execution_end', toolCallId: 'c1', result: { ok: true }, isError: false }),
    { kind: 'event', event: { type: 'tool_end', id: 'c1', output: { ok: true }, isError: false } },
  )
  // Without an id there is no row to address, so there is nothing to emit.
  assert.equal(classifyAgentEvent({ type: 'tool_execution_end', result: 1 }).kind, 'ignored')
})

test('every other member of the union is named, not defaulted', () => {
  // `turn_end` in particular repeats the failed message that `message_end`
  // already reported — honouring both would report one failure twice.
  for (const type of ['agent_start', 'agent_end', 'turn_start', 'turn_end', 'tool_execution_update']) {
    assert.deepEqual(classifyAgentEvent({ type }), { kind: 'ignored', reason: type })
  }
})

test('a shape peek has never seen is reported, never thrown', () => {
  // This runs inside a subscriber callback, so whether an exception would be
  // caught at all is the library's business rather than peek's.
  for (const raw of [{ type: 'brand_new_event' }, {}, null, 42, 'nonsense', undefined]) {
    assert.equal(classifyAgentEvent(raw).kind, 'ignored')
  }
})
