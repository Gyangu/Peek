/**
 * Tests for the endpoint backend's conversation store.
 *
 * This is the one place in peek that holds a transcript, so what is checked here
 * is mostly what happens when it *cannot*. A chat panel that opens an empty
 * conversation is recoverable; one that refuses to open because a file is
 * unreadable is not, and every read path below has to prefer the first.
 *
 * The other property under test is the two-list shape: a stored conversation
 * carries what the window shows **and** what the model remembers, because
 * neither can be derived from the other. See
 * `docs/design/2026-08-03-chat-history-ownership.md` §3.3.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatMessage, ChatMessageId } from '@peek/core'
import { ENDPOINT_THREAD_DIR, EndpointThreadStore } from '../thread-store'

function withStore<T>(fn: (store: EndpointThreadStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'peek-threads-'))
  try {
    return fn(new EndpointThreadStore(join(dir, ENDPOINT_THREAD_DIR)), join(dir, ENDPOINT_THREAD_DIR))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
  id: id as ChatMessageId,
  role,
  blocks: [{ type: 'text', text }],
  createdAt: 1_000,
  complete: true,
  stopReason: 'end_turn',
})

test('a conversation survives a round trip with both of its halves', () => {
  withStore((store) => {
    const transcript: ChatMessage[] = [
      message('m1', 'user', 'how many tables?'),
      {
        ...message('m2', 'agent', 'Four.'),
        blocks: [
          { type: 'text', text: 'Four.' },
          {
            type: 'tool',
            call: {
              toolCallId: 'call_1',
              title: 'mcp__peek__read_workspace',
              kind: 'other',
              status: 'completed',
              rawInput: {},
              rawOutput: { ok: true },
              content: [{ type: 'text', text: 'four tables' }],
              startedAt: 1_001,
              endedAt: 1_002,
            },
          },
        ],
      },
    ]
    assert.ok(
      store.write({
        sessionId: 'sess_1',
        transcript,
        messages: [{ role: 'user', content: 'how many tables?' }] as never,
        modelId: 'gpt-x',
        updatedAt: 5,
      }),
    )

    const back = store.read('sess_1')
    // The tool call is the interesting part: its title, status and rendered
    // content are exactly what a model-message-only store would have lost.
    assert.deepEqual(back?.transcript, transcript)
    assert.equal(back?.messages.length, 1)
    assert.equal(back?.modelId, 'gpt-x')
    assert.equal(back?.updatedAt, 5)
  })
})

test('a conversation nobody stored reads as absent, not as an error', () => {
  withStore((store) => {
    assert.equal(store.read('sess_missing'), null)
  })
})

test('a corrupt file degrades to absent rather than taking the panel down', () => {
  withStore((store, dir) => {
    store.write({ sessionId: 'sess_1', transcript: [], messages: [], modelId: 'm', updatedAt: 1 })
    writeFileSync(store.path('sess_1'), '{ this is not json', 'utf8')
    assert.equal(store.read('sess_1'), null)
    // The file is left alone: peek does not repair what it cannot parse, and a
    // user with a backup should still find their bytes where they were.
    assert.ok(existsSync(join(dir, 'sess_1.json')))
  })
})

test('a version peek does not know is declined rather than guessed at', () => {
  withStore((store) => {
    store.write({ sessionId: 'sess_1', transcript: [], messages: [], modelId: 'm', updatedAt: 1 })
    writeFileSync(
      store.path('sess_1'),
      JSON.stringify({ version: 99, transcript: [message('m1', 'user', 'hi')], messages: [] }),
      'utf8',
    )
    assert.equal(store.read('sess_1'), null)
  })
})

test('a file missing either half is declined, because half a conversation is not one', () => {
  withStore((store) => {
    store.write({ sessionId: 'sess_1', transcript: [], messages: [], modelId: 'm', updatedAt: 1 })
    writeFileSync(store.path('sess_1'), JSON.stringify({ version: 1, transcript: [] }), 'utf8')
    assert.equal(store.read('sess_1'), null)
  })
})

test('writing twice replaces, and leaves no temp file behind', () => {
  withStore((store, dir) => {
    store.write({ sessionId: 'sess_1', transcript: [message('m1', 'user', 'first')], messages: [], modelId: 'm', updatedAt: 1 })
    store.write({ sessionId: 'sess_1', transcript: [message('m1', 'user', 'second')], messages: [], modelId: 'm', updatedAt: 2 })

    assert.equal(store.read('sess_1')?.transcript[0]?.blocks[0]?.type === 'text'
      ? (store.read('sess_1')?.transcript[0]?.blocks[0] as { text: string }).text
      : null, 'second')
    // temp + rename is what makes a crash mid-write survivable; a leftover
    // `.tmp` would mean the rename half of that never happened.
    assert.deepEqual(readdirSync(dir), ['sess_1.json'])
  })
})

test('remove deletes the body, and says so even when there was none', () => {
  withStore((store) => {
    store.write({ sessionId: 'sess_1', transcript: [], messages: [], modelId: 'm', updatedAt: 1 })
    assert.equal(store.remove('sess_1'), true)
    assert.equal(store.read('sess_1'), null)
    // Already gone is the same outcome the caller wanted, so it is not a failure
    // — the caller uses `false` to decide whether to keep the route, and keeping
    // a route for a file that does not exist is the ghost row to avoid.
    assert.equal(store.remove('sess_1'), true)
  })
})

test('a session id that is not one cannot be turned into a path', () => {
  withStore((store) => {
    // Ids come from `randomUUID` and never from outside this process. The check
    // is here because this path is joined and then *written to*: a traversal
    // would be a write anywhere on disk, which is not a failure mode worth
    // leaving to an assumption.
    assert.throws(() => store.path('../../etc/passwd'))
    assert.throws(() => store.path('a/b'))
    assert.throws(() => store.path(''))
    assert.equal(store.read('../../etc/passwd'), null)
  })
})
