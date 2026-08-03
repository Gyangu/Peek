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
import { EndpointTranslator } from '../events'

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
  t.countUserMessage()
  const first = t.translate({ type: 'assistant_start' }, T0)
  assert.equal(first.state.messageCount, 2)
  t.translate({ type: 'turn_end', stopReason: 'end_turn' }, T0)
  t.countUserMessage()
  const second = t.translate({ type: 'assistant_start' }, T0)
  assert.equal(second.state.messageCount, 4)
})

test('reset clears the transcript and the counters together', () => {
  const t = new EndpointTranslator(CHAT)
  t.countUserMessage()
  drain(t, [{ type: 'assistant_start' }, { type: 'text', text: 'gone' }])
  const out = t.reset()
  assert.deepEqual(out.deltas, [{ type: 'reset', chatId: CHAT }])
  assert.equal(out.state.messageCount, 0)
  assert.equal(out.state.lastMessagePreview, '')
  // And the next message starts from one, not from where it left off.
  assert.equal(t.translate({ type: 'assistant_start' }, T0).state.messageCount, 1)
})
