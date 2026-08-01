/**
 * Tests for the ACP → transcript translation.
 *
 * The notification shapes below are the ones a real agent sends, not invented
 * ones, and each test pins a behaviour that a plausible-looking implementation
 * gets wrong: chunks are single blocks rather than arrays, tool updates are
 * partial and must merge, `rawOutput` is frequently an array, and unknown update
 * kinds must be survivable.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId, type ChatDelta } from '@peek/core'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { TranscriptTranslator } from '../translate'

const CHAT = asChatId('chat_test')

function translator(): TranscriptTranslator {
  let tick = 1_000
  return new TranscriptTranslator(CHAT, () => tick++)
}

function textChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId === undefined ? {} : { messageId }),
  } as SessionUpdate
}

function appended(deltas: readonly ChatDelta[]): string {
  return deltas
    .filter((delta): delta is Extract<ChatDelta, { type: 'text.append' }> => delta.type === 'text.append')
    .map((delta) => delta.text)
    .join('')
}

test('the first agent chunk opens a message and later chunks reuse it', () => {
  const t = translator()

  const first = t.handle(textChunk('Hello'))
  assert.equal(first.deltas.length, 2)
  assert.equal(first.deltas[0]?.type, 'message.start')
  assert.equal(first.deltas[1]?.type, 'text.append')
  assert.equal(first.state.messageCount, 1)
  assert.ok(first.state.streamingMessageId)

  const second = t.handle(textChunk(' world'))
  assert.equal(second.deltas.length, 1)
  assert.equal(second.deltas[0]?.type, 'text.append')
  // No message opened, so no control-plane movement to report.
  assert.deepEqual(second.state, {})
  assert.equal(appended(second.deltas), ' world')
})

test('a new agent messageId starts a new message and closes the previous one', () => {
  const t = translator()
  t.handle(textChunk('first', 'm1'))
  const out = t.handle(textChunk('second', 'm2'))

  assert.equal(out.deltas[0]?.type, 'message.end')
  assert.equal(out.deltas[1]?.type, 'message.start')
  assert.equal(out.state.messageCount, 2)
})

test('thought chunks land in their own delta type', () => {
  const t = translator()
  const out = t.handle({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  } as SessionUpdate)
  const kinds = out.deltas.map((delta) => delta.type)
  assert.deepEqual(kinds, ['message.start', 'thought.append'])
})

test('a tool_call_update merges onto the record instead of replacing it', () => {
  const t = translator()
  t.handle(textChunk('working'))

  t.handle({
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_1',
    title: 'mcp__peek__read_workspace',
    kind: 'other',
    status: 'pending',
    content: [],
    rawInput: {},
  } as SessionUpdate)

  // The real second notification carries neither title nor kind.
  const out = t.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'panel_1 [focused]' } }],
    rawOutput: [{ type: 'tool_reference', tool_name: 'mcp__peek__read_workspace' }],
  } as SessionUpdate)

  const upsert = out.deltas[0]
  assert.equal(upsert?.type, 'tool.upsert')
  if (upsert?.type !== 'tool.upsert') throw new Error('unreachable')
  assert.equal(upsert.call.title, 'mcp__peek__read_workspace', 'the title survives a partial update')
  assert.equal(upsert.call.kind, 'other')
  assert.equal(upsert.call.status, 'completed')
  assert.ok(upsert.call.endedAt)
  assert.deepEqual(upsert.call.content, [{ type: 'text', text: 'panel_1 [focused]' }])
  // An MCP tool returns an array here. Typing it as a record is what made an
  // older SDK drop completion notifications entirely.
  assert.ok(Array.isArray(upsert.call.rawOutput))
})

test('rawInput is replaced wholesale, matching how the agent streams arguments', () => {
  const t = translator()
  t.handle(textChunk('go'))
  t.handle({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'T', status: 'pending', rawInput: {} } as SessionUpdate)

  t.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'x', rawInput: { query: 'sel' } } as SessionUpdate)
  const out = t.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'x',
    rawInput: { query: 'select:mcp__peek__read_workspace', max_results: 1 },
  } as SessionUpdate)

  const upsert = out.deltas[0]
  if (upsert?.type !== 'tool.upsert') throw new Error('expected a tool.upsert')
  assert.deepEqual(upsert.call.rawInput, { query: 'select:mcp__peek__read_workspace', max_results: 1 })
})

test('an unknown tool kind degrades to other rather than being trusted', () => {
  const t = translator()
  t.handle(textChunk('go'))
  const out = t.handle({
    sessionUpdate: 'tool_call',
    toolCallId: 'y',
    title: 'T',
    kind: 'definitely_not_a_kind',
    status: 'pending',
  } as unknown as SessionUpdate)
  const upsert = out.deltas.find((delta) => delta.type === 'tool.upsert')
  if (upsert?.type !== 'tool.upsert') throw new Error('expected a tool.upsert')
  assert.equal(upsert.call.kind, 'other')
})

test('unrecognised update kinds are reported, not thrown', () => {
  const t = translator()
  const out = t.handle({ sessionUpdate: 'available_commands_update', availableCommands: [] } as SessionUpdate)
  assert.deepEqual(out.deltas, [])
  assert.equal(out.ignored, 'available_commands_update')
})

test('usage updates move state without touching the transcript', () => {
  const t = translator()
  const out = t.handle({ sessionUpdate: 'usage_update', used: 27_678, size: 1_000_000 } as SessionUpdate)
  assert.deepEqual(out.deltas, [])
  assert.deepEqual(out.state.usage, { used: 27_678, size: 1_000_000 })
})

test('finishTurn closes the open message and clears the streaming marker', () => {
  const t = translator()
  t.handle(textChunk('partial answer'))
  const out = t.finishTurn('cancelled')

  const end = out.deltas[0]
  assert.equal(end?.type, 'message.end')
  if (end?.type !== 'message.end') throw new Error('unreachable')
  assert.equal(end.stopReason, 'cancelled')
  assert.equal(out.state.streamingMessageId, null)
  assert.equal(out.state.lastMessagePreview, 'partial answer')
  assert.equal(t.streamingMessageId, null)
})

test('finishTurn with no open message is a no-op beyond clearing the marker', () => {
  const t = translator()
  const out = t.finishTurn('end_turn')
  assert.deepEqual(out.deltas, [])
  assert.equal(out.state.streamingMessageId, null)
})

test('a tool update arriving after the turn ended is dropped, not resurrected', () => {
  const t = translator()
  t.handle(textChunk('go'))
  t.finishTurn('cancelled')
  const out = t.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed' } as SessionUpdate)
  assert.deepEqual(out.deltas, [])
  assert.ok(out.ignored)
})

test('a user message opens and closes in one output and counts once', () => {
  const t = translator()
  const out = t.appendUserMessage('show me the users table', undefined)
  assert.deepEqual(
    out.deltas.map((delta) => delta.type),
    ['message.start', 'message.end'],
  )
  assert.equal(out.state.messageCount, 1)
  assert.equal(t.messageCount, 1)
})

test('reset clears the transcript and the counters', () => {
  const t = translator()
  t.appendUserMessage('hi', undefined)
  t.handle(textChunk('hello'))
  const out = t.reset()
  assert.deepEqual(out.deltas, [{ type: 'reset', chatId: CHAT }])
  assert.equal(t.messageCount, 0)
  assert.equal(t.streamingMessageId, null)
})

test('non-text content blocks are acknowledged rather than silently dropped', () => {
  const t = translator()
  const out = t.handle({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'x', mimeType: 'image/png' },
  } as SessionUpdate)
  assert.equal(appended(out.deltas), '[image]')
})
