/**
 * Tests for the route index.
 *
 * Two properties carry the weight here, and both are about failure rather than
 * about the happy path:
 *
 *  - a corrupt or unknown-version index degrades to "no routes" instead of
 *    throwing, because it is a convenience over data held authoritatively
 *    elsewhere and must never be able to take the chat panel down;
 *  - it stores a *route* and never a transcript, which is what keeps
 *    `2026-08-02-chat-session-management.md`'s "no persistence layer" rule
 *    intact. See `docs/design/2026-08-03-pluggable-agent-backends.md` §3.5.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SESSION_INDEX_FILE, SessionIndex } from '../session-index'

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'peek-sessions-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a route survives a round trip through the file', () => {
  withDir((dir) => {
    const index = SessionIndex.at(dir)
    index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'claude-code' })

    // A second instance reads what the first wrote: this is what makes the
    // catalogue survive a restart, which is the only reason the file exists.
    const reopened = SessionIndex.at(dir)
    const route = reopened.lookup('sess_a')
    assert.equal(route?.backend, 'acp')
    assert.equal(route?.agentId, 'claude-code')
    assert.equal(reopened.lookup('sess_missing'), null)
  })
})

test('recording twice keeps the first timestamp', () => {
  withDir((dir) => {
    const index = SessionIndex.at(dir)
    const first = index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'claude-code', createdAt: 1000 })
    // Bringing a session up again after an agent restart must not restamp it and
    // reshuffle the list under the user.
    const second = index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'codex', createdAt: 2000 })
    assert.equal(second.createdAt, first.createdAt)
    assert.equal(second.agentId, 'claude-code', 'the original owner stands')
  })
})

test('the list is newest first, across backends', () => {
  withDir((dir) => {
    const index = SessionIndex.at(dir)
    index.record({ sessionId: 'old', backend: 'acp', agentId: 'claude-code', createdAt: 100 })
    index.record({ sessionId: 'new', backend: 'endpoint', agentId: 'qwen3-coder', createdAt: 300 })
    index.record({ sessionId: 'mid', backend: 'acp', agentId: 'codex', createdAt: 200 })
    // Mixed on purpose: one list, ordered by when the user started the
    // conversation, not grouped by who answered it.
    assert.deepEqual(index.list().map((r) => r.sessionId), ['new', 'mid', 'old'])
  })
})

test('remove drops the route and reports whether there was one', () => {
  withDir((dir) => {
    const index = SessionIndex.at(dir)
    index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'claude-code' })
    assert.equal(index.remove('sess_a'), true)
    assert.equal(index.remove('sess_a'), false)
    assert.equal(SessionIndex.at(dir).lookup('sess_a'), null)
  })
})

test('a corrupt file reads as empty rather than throwing', () => {
  withDir((dir) => {
    writeFileSync(join(dir, SESSION_INDEX_FILE), '{not json at all', 'utf8')
    const index = SessionIndex.at(dir)
    // The transcripts are still where their backends left them. Losing the labels
    // is a cosmetic regression; throwing here would be a chat panel that will not
    // open because of a file nothing authoritative depends on.
    assert.deepEqual(index.list(), [])
    // And it recovers: a fresh record rewrites the file.
    index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'claude-code' })
    assert.equal(SessionIndex.at(dir).lookup('sess_a')?.agentId, 'claude-code')
  })
})

test('an index from a future version is not guessed at', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, SESSION_INDEX_FILE),
      JSON.stringify({ version: 99, routes: { sess_a: { backend: 'acp', agentId: 'claude-code' } } }),
      'utf8',
    )
    // Reading a shape peek does not know could route a conversation to the wrong
    // backend, which loses it. Starting empty only costs labels.
    assert.deepEqual(SessionIndex.at(dir).list(), [])
  })
})

test('malformed entries are dropped, not repaired, and do not take their neighbours with them', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, SESSION_INDEX_FILE),
      JSON.stringify({
        version: 1,
        routes: {
          good: { sessionId: 'good', backend: 'acp', agentId: 'claude-code', createdAt: 5 },
          no_backend: { sessionId: 'no_backend', agentId: 'claude-code' },
          bad_backend: { sessionId: 'bad_backend', backend: 'telepathy', agentId: 'x' },
          no_agent: { sessionId: 'no_agent', backend: 'acp' },
          not_an_object: 7,
        },
      }),
      'utf8',
    )
    assert.deepEqual(SessionIndex.at(dir).list().map((r) => r.sessionId), ['good'])
  })
})

test('the file holds routes and nothing that could be mistaken for a transcript', () => {
  withDir((dir) => {
    const index = SessionIndex.at(dir)
    index.record({ sessionId: 'sess_a', backend: 'acp', agentId: 'claude-code' })
    const raw = JSON.parse(readFileSync(join(dir, SESSION_INDEX_FILE), 'utf8')) as {
      routes: Record<string, Record<string, unknown>>
    }
    // The rule this pins down: peek stores where to ask, never what was said. A
    // field added here later that carries conversation content would make this a
    // second history — see the note at the top of `session-index.ts`.
    assert.deepEqual(Object.keys(raw.routes['sess_a'] ?? {}).sort(), [
      'agentId',
      'backend',
      'createdAt',
      'sessionId',
    ])
  })
})
