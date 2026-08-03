/**
 * Tests for the delta coalescing budget.
 *
 * The two properties that matter are in tension and both are asserted here:
 * traffic must collapse (consecutive token appends become one delta), and
 * structural deltas must not be delayed behind it (a tool row appearing while
 * prose is buffered flushes immediately, in order).
 *
 * Timers are injected, so nothing here sleeps.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asChatId, asChatMessageId, type ChatDelta } from '@peek/core'
import { DeltaBatcher, type BatcherTimers } from '../batcher'
import type { DeltaBatchBudget } from '../types'

const CHAT = asChatId('chat_batch')
const MSG = asChatMessageId('msg_1')
const OTHER = asChatMessageId('msg_2')

const BUDGET: DeltaBatchBudget = { intervalMs: 50, maxChars: 20, maxDeltas: 4 }

interface Harness {
  batcher: DeltaBatcher
  batches: ChatDelta[][]
  tick: () => void
  armed: () => boolean
}

function harness(budget: DeltaBatchBudget = BUDGET): Harness {
  const batches: ChatDelta[][] = []
  let pending: (() => void) | null = null
  const timers: BatcherTimers = {
    setTimer: (fn) => {
      pending = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      pending = null
    },
  }
  const batcher = new DeltaBatcher(
    CHAT,
    budget,
    (_chatId, deltas) => {
      batches.push([...deltas])
    },
    timers,
  )
  return {
    batcher,
    batches,
    tick: () => {
      const fn = pending
      pending = null
      fn?.()
    },
    armed: () => pending !== null,
  }
}

function append(text: string, messageId = MSG): ChatDelta {
  return { type: 'text.append', chatId: CHAT, messageId, text }
}

test('consecutive appends to one message merge into a single delta', () => {
  const h = harness()
  h.batcher.push(append('He'))
  h.batcher.push(append('llo'))
  h.batcher.push(append(' there'))
  assert.equal(h.batches.length, 0, 'nothing has left yet')

  h.tick()
  assert.equal(h.batches.length, 1)
  assert.equal(h.batches[0]?.length, 1, 'three chunks became one delta')
  const only = h.batches[0]?.[0]
  if (only?.type !== 'text.append') throw new Error('expected a text.append')
  assert.equal(only.text, 'Hello there')
})

test('appends for different messages stay separate', () => {
  const h = harness()
  h.batcher.push(append('a'))
  h.batcher.push(append('b', OTHER))
  h.tick()
  assert.equal(h.batches[0]?.length, 2)
})

function tool(status: 'pending' | 'in_progress' | 'completed', rawInput?: unknown, id = 't1'): ChatDelta {
  return {
    type: 'tool.upsert',
    chatId: CHAT,
    messageId: MSG,
    call: {
      toolCallId: id,
      title: 'mcp__peek__read_workspace',
      kind: 'other',
      status,
      content: [],
      startedAt: 1,
      ...(rawInput === undefined ? {} : { rawInput }),
    },
  }
}

test('a structural delta flushes immediately, carrying buffered prose in order', () => {
  const h = harness()
  h.batcher.push(append('thinking about it'))
  h.batcher.push(tool('pending'))

  assert.equal(h.batches.length, 1, 'the tool call did not wait for the timer')
  assert.deepEqual(
    h.batches[0]?.map((delta) => delta.type),
    ['text.append', 'tool.upsert'],
    'ordering is preserved across the flush',
  )
  assert.equal(h.armed(), false, 'the pending timer was cleared')
})

test('argument-streaming updates for an announced tool coalesce to the latest', () => {
  const h = harness()
  h.batcher.push(tool('pending', {}))
  assert.equal(h.batches.length, 1, 'the row appears at once')

  h.batcher.push(tool('in_progress', { query: 'sel' }))
  h.batcher.push(tool('in_progress', { query: 'select:x' }))
  h.batcher.push(tool('in_progress', { query: 'select:x', max_results: 1 }))
  assert.equal(h.batches.length, 1, 'the intermediate arguments are buffered')

  h.tick()
  assert.equal(h.batches.length, 2)
  assert.equal(h.batches[1]?.length, 1, 'three updates collapsed into one')
  const last = h.batches[1]?.[0]
  if (last?.type !== 'tool.upsert') throw new Error('expected a tool.upsert')
  assert.deepEqual(last.call.rawInput, { query: 'select:x', max_results: 1 })
})

test('a completed tool call flushes at once rather than waiting', () => {
  const h = harness()
  h.batcher.push(tool('pending'))
  h.batcher.push(tool('in_progress', { a: 1 }))
  h.batcher.push(tool('completed', { a: 1 }))
  assert.equal(h.batches.length, 2, 'the resolution did not sit in the buffer')
  const finalBatch = h.batches[1]
  assert.equal(finalBatch?.length, 1, 'the superseded in_progress update was replaced, not sent')
  const only = finalBatch?.[0]
  if (only?.type !== 'tool.upsert') throw new Error('expected a tool.upsert')
  assert.equal(only.call.status, 'completed')
})

test('two different tool calls both get their own immediate row', () => {
  const h = harness()
  h.batcher.push(tool('pending', {}, 'a'))
  h.batcher.push(tool('pending', {}, 'b'))
  assert.equal(h.batches.length, 2)
})

test('a queued tool update keeps its position relative to prose', () => {
  const h = harness()
  h.batcher.push(tool('pending', {}, 'a'))
  h.batcher.push(tool('in_progress', { v: 1 }, 'a'))
  h.batcher.push(append('meanwhile'))
  h.batcher.push(tool('in_progress', { v: 2 }, 'a'))
  h.tick()

  assert.deepEqual(
    h.batches[1]?.map((delta) => delta.type),
    ['tool.upsert', 'text.append'],
    'the replacement stayed where the first queued update was',
  )
})

test('the character budget forces a flush before the timer', () => {
  const h = harness()
  h.batcher.push(append('0123456789'))
  assert.equal(h.batches.length, 0)
  h.batcher.push(append('0123456789'))
  assert.equal(h.batches.length, 1, 'twenty characters hit maxChars')
})

test('the delta-count budget forces a flush before the timer', () => {
  const h = harness()
  // Alternating messages defeat merging, so each push adds a delta.
  h.batcher.push(append('a', MSG))
  h.batcher.push(append('b', OTHER))
  h.batcher.push(append('c', MSG))
  assert.equal(h.batches.length, 0)
  h.batcher.push(append('d', OTHER))
  assert.equal(h.batches.length, 1, 'four deltas hit maxDeltas')
})

test('flush on an empty buffer sends nothing', () => {
  const h = harness()
  h.batcher.flush()
  assert.equal(h.batches.length, 0)
})

test('dispose flushes what is queued and then ignores further pushes', () => {
  const h = harness()
  h.batcher.push(append('tail'))
  h.batcher.dispose()
  assert.equal(h.batches.length, 1)
  h.batcher.push(append('after'))
  assert.equal(h.batches.length, 1)
})

test('a throwing sink does not take the batcher down', () => {
  const timers: BatcherTimers = {
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  }
  const batcher = new DeltaBatcher(
    CHAT,
    BUDGET,
    () => {
      throw new Error('the renderer went away')
    },
    timers,
  )
  assert.doesNotThrow(() => {
    batcher.push({ type: 'reset', chatId: CHAT })
  })
  assert.equal(batcher.pendingCount, 0, 'the batch is still consumed')
})
