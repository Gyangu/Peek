/**
 * Tests for the ACP backend's snapshot store.
 *
 * Two things are under test, and they are not the same thing.
 *
 * The first is the failure posture, which is the endpoint thread store's and is
 * checked the same way: every unreadable file has to degrade to "no snapshot"
 * rather than throw, because a conversation that opens a moment slower is a
 * conversation that opened, and one that refuses to open is not. A snapshot is
 * an optimisation, so it is never allowed to be the reason something breaks.
 *
 * The second is the *shape*, and it is this store's own: a snapshot carries the
 * transcript and nothing else. No model context, no field for one. That absence
 * is what keeps `2026-08-03-chat-history-ownership.md` §3.1 intact while peek
 * stores a picture of a conversation it does not own — the file cannot answer
 * "what does the model remember", so it cannot be a second answer to it. See
 * `2026-08-06-opening-a-stored-conversation.md` §2.2 and §3.1.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatMessage, ChatMessageId } from '@peek/core'
import { ACP_SNAPSHOT_DIR, AcpSnapshotStore } from '../snapshot-store'

function withStore<T>(fn: (store: AcpSnapshotStore, dir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'peek-snapshots-'))
  const dir = join(root, ACP_SNAPSHOT_DIR)
  try {
    return fn(new AcpSnapshotStore(dir), dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function transcript(): ChatMessage[] {
  return [
    {
      id: 'm1' as ChatMessageId,
      role: 'user',
      blocks: [{ type: 'text', text: 'which orders are stuck?' }],
      complete: true,
      createdAt: 1,
    },
    {
      id: 'm2' as ChatMessageId,
      role: 'agent',
      blocks: [
        { type: 'thought', text: 'check the status column' },
        {
          type: 'tool',
          call: {
            toolCallId: 't1',
            title: 'Ran a query',
            kind: 'execute',
            status: 'completed',
            startedAt: 2,
            content: [{ type: 'text', text: '3 rows' }],
          },
        },
        { type: 'text', text: 'Three of them.' },
      ],
      complete: true,
      stopReason: 'end_turn',
      createdAt: 2,
    },
  ]
}

test('a snapshot survives a round trip, tool calls and all', () => {
  withStore((store) => {
    const messages = transcript()
    assert.equal(store.write(SESSION, messages, 1234), true)
    const back = store.read(SESSION)
    assert.equal(back?.sessionId, SESSION)
    assert.equal(back?.updatedAt, 1234)
    // Deep equality, not a length check: the blocks a tool call carries — its
    // title, kind, status and content — are exactly what a transcript rebuilt
    // from model messages would lose, and drawing a snapshot without them would
    // show a different conversation than the one the user had.
    assert.deepEqual(back?.transcript, messages)
  })
})

// The structural half of §3.1. If this ever fails, the file has grown the
// ability to answer a question it is not allowed to answer.
test('a snapshot on disk carries the transcript and nothing that could pass for model context', () => {
  withStore((store, dir) => {
    store.write(SESSION, transcript(), 1)
    const raw = JSON.parse(readFileSync(join(dir, `${SESSION}.json`), 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(raw).sort(), ['sessionId', 'transcript', 'updatedAt', 'version'])
    assert.equal('messages' in raw, false)
  })
})

test('a conversation nobody has a picture of reads as absent, not as an error', () => {
  withStore((store) => {
    assert.equal(store.read(SESSION), null)
  })
})

test('a corrupt file degrades to absent rather than taking the panel down', () => {
  withStore((store, dir) => {
    store.write(SESSION, transcript(), 1)
    writeFileSync(join(dir, `${SESSION}.json`), '{"version":1,"transcript":[', 'utf8')
    assert.equal(store.read(SESSION), null)
    // And is left exactly as it was found. Repairing a file in place would
    // destroy the evidence of whatever wrote it badly.
    assert.equal(readFileSync(join(dir, `${SESSION}.json`), 'utf8'), '{"version":1,"transcript":[')
  })
})

test('a version peek does not know is declined rather than guessed at', () => {
  withStore((store, dir) => {
    store.write(SESSION, transcript(), 1)
    writeFileSync(
      join(dir, `${SESSION}.json`),
      JSON.stringify({ version: 2, sessionId: SESSION, transcript: [] }),
      'utf8',
    )
    assert.equal(store.read(SESSION), null)
  })
})

test('writing twice replaces, and leaves no temp file behind', () => {
  withStore((store, dir) => {
    store.write(SESSION, transcript(), 1)
    store.write(SESSION, transcript().slice(0, 1), 2)
    assert.equal(store.read(SESSION)?.transcript.length, 1)
    assert.deepEqual(readdirSync(dir), [`${SESSION}.json`])
  })
})

// An empty transcript is not a picture of anything, and a stale file left under
// one would redraw, on the next open, a conversation the user just cleared.
test('storing an empty transcript deletes the picture instead of writing an empty one', () => {
  withStore((store, dir) => {
    store.write(SESSION, transcript(), 1)
    assert.equal(existsSync(join(dir, `${SESSION}.json`)), true)
    assert.equal(store.write(SESSION, [], 2), true)
    assert.equal(existsSync(join(dir, `${SESSION}.json`)), false)
    assert.equal(store.read(SESSION), null)
  })
})

test('remove deletes the picture, and says so even when there was none', () => {
  withStore((store) => {
    store.write(SESSION, transcript(), 1)
    assert.equal(store.remove(SESSION), true)
    assert.equal(store.read(SESSION), null)
    assert.equal(store.remove(SESSION), true)
  })
})

// Session ids come from the agent here, not from peek's own `randomUUID` — one
// step further from peek's control than the endpoint store's, which makes this
// check matter more rather than less. The path is joined to a directory and
// then written to.
test('a session id that is not one cannot be turned into a path', () => {
  withStore((store) => {
    assert.throws(() => store.path('../../etc/passwd'))
    assert.throws(() => store.path('a/b'))
    assert.throws(() => store.path(''))
    assert.throws(() => store.write('../escape', transcript(), 1))
  })
})
