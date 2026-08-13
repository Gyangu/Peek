/**
 * The endpoint backend's conversation lifecycle: identity, storage, detach.
 *
 * Everything here runs without a network and without a turn. That is possible
 * because `buildEndpointModel` only assembles objects — nothing reaches the
 * endpoint until `prompt` — and it is what lets the properties that used to be
 * missing entirely be pinned down cheaply:
 *
 *  - a conversation **has an id** and a route, so the catalogue is not empty;
 *  - closing a view **detaches**; it used to drop the `Agent` and with it the
 *    whole conversation, which made closing a tab a silent permanent delete;
 *  - a resumed conversation comes back with its transcript *and* the model's own
 *    memory, which are two different things (see `thread-store.ts`).
 *
 * The streaming half is covered by `events.test.ts` against the translator,
 * where it can be exercised without a model at all.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChatAgentStatePatch } from '../../../acp/types'
import type { ChatDelta, ChatId, ChatMessage, ChatMessageId, NotifyMessage } from '@peek/core'
import { DEFAULT_DELTA_BUDGET } from '../../types'
import { SessionIndex } from '../../session-index'
import { EndpointManager } from '../loop'
import { buildEndpointModel } from '../provider'
import { EndpointThreadStore } from '../thread-store'

const CHAT = 'chat_1' as ChatId

interface Harness {
  manager: EndpointManager
  index: SessionIndex
  threads: EndpointThreadStore
  deltas: ChatDelta[]
  patches: ChatAgentStatePatch[]
  notices: NotifyMessage[]
}

function build(dir: string, apiKey: string | null, baseUrl = 'http://localhost:1/v1'): Harness {
  const index = SessionIndex.at(dir)
  const threads = new EndpointThreadStore(join(dir, 'endpoint'))
  const deltas: ChatDelta[] = []
  const patches: ChatAgentStatePatch[] = []
  const notices: NotifyMessage[] = []
  const manager = new EndpointManager(
    {
      applyState: (patch) => {
        patches.push(patch)
        return Promise.resolve()
      },
      emitDeltas: (_chatId, batch) => void deltas.push(...batch),
      notify: (message) => void notices.push(message),
      tools: [],
      toolContext: {} as never,
      threads,
      sessionIndex: index,
    },
    {
      settings: { baseUrl, model: 'test-model', api: 'openai-completions' } as never,
      apiKey,
      permissionMode: () => 'default',
      batch: DEFAULT_DELTA_BUDGET,
      source: 'agent',
    },
  )
  return { manager, index, threads, deltas, patches, notices }
}

function withManager<T>(fn: (h: Harness) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'peek-endpoint-'))
  try {
    return fn(build(dir, null))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withManagerAsync(
  fn: (h: Harness) => Promise<void>,
  opts: { apiKey?: string | null; baseUrl?: string } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'peek-endpoint-'))
  try {
    await fn(build(dir, opts.apiKey ?? null, opts.baseUrl))
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

const STORED: ChatMessage[] = [message('m1', 'user', 'how many tables?'), message('m2', 'agent', 'Four.')]

test('opening a conversation records a route, so the catalogue is not empty', () => {
  withManager(({ manager, index }) => {
    manager.openChat(CHAT, 'sess_1')
    const route = index.lookup('sess_1')
    // Recorded at bringup rather than at the first message: a conversation the
    // user opens and abandons is still one the catalogue has to name.
    assert.equal(route?.backend, 'endpoint')
    assert.equal(route?.agentId, 'test-model')
  })
})

test('a resumed conversation is replayed to the window as whole messages', () => {
  withManager(({ manager, threads, deltas, patches }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')

    // One `message.start` per stored message and nothing else: that delta
    // carries a whole `ChatMessage`, so a finished conversation needs no appends
    // and the restore path adds no second format to `ChatDelta`.
    assert.deepEqual(
      deltas.map((d) => d.type),
      ['message.start', 'message.start'],
    )
    assert.deepEqual(
      deltas.flatMap((d) => (d.type === 'message.start' ? [d.message.id] : [])),
      ['m1', 'm2'],
    )
    // The Workspace row has to agree with what is on screen, or the count says
    // "1 message" under a transcript visibly holding two.
    assert.equal(patches.find((p) => p.messageCount !== undefined)?.messageCount, 2)
  })
})

test('a resumed conversation restores the model’s memory, not only the screen', () => {
  withManager(({ manager, threads }) => {
    const remembered = [{ role: 'user', content: 'how many tables?' }] as never
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: remembered, modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')

    // Restoring only the transcript would show the history and then answer the
    // next question as if none of it had happened. These are two different
    // things and both have to come back.
    assert.equal(manager.readStored('sess_1')?.length, 2)
    assert.deepEqual(threads.read('sess_1')?.messages, remembered)
  })
})

test('a conversation whose file is unreadable opens empty rather than broken', () => {
  withManager(({ manager, deltas }) => {
    // The route is still valid and the next turn will work; the model just has
    // nothing to remember. Throwing here would take the panel down over a file
    // the user cannot do anything about.
    manager.openChat(CHAT, 'sess_missing')
    assert.deepEqual(deltas, [])
  })
})

test('closing a view detaches: the conversation is still on disk afterwards', () => {
  withManager(({ manager, threads }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')
    manager.closeChat(CHAT)

    // This is the bug this whole file exists for: `closeChat` used to delete the
    // session map entry and let the `Agent` — the entire conversation — be
    // collected. Closing a chat tab was an unannounced permanent delete.
    assert.equal(threads.read('sess_1')?.transcript.length, 2)
  })
})

test('reopening after a close brings the same conversation back', () => {
  withManager(({ manager, threads, deltas }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')
    manager.closeChat(CHAT)
    deltas.length = 0
    manager.openChat(CHAT, 'sess_1')

    assert.equal(deltas.filter((d) => d.type === 'message.start').length, 2)
  })
})

test('opening the same conversation twice does not stack it on itself', () => {
  withManager(({ manager, threads, deltas }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')
    const after = deltas.length
    manager.openChat(CHAT, 'sess_1')
    assert.equal(deltas.length, after)
  })
})

test('restore re-sends what main is holding, led by a reset', () => {
  withManager(({ manager, threads, deltas }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')
    deltas.length = 0

    assert.equal(manager.restore(CHAT), true)
    // The reset is what makes this safe to call twice: `message.start` is
    // idempotent by id, but only against messages the mirror already has.
    assert.deepEqual(
      deltas.map((d) => d.type),
      ['reset', 'message.start', 'message.start'],
    )

    deltas.length = 0
    assert.equal(manager.restore(CHAT), true)
    assert.deepEqual(
      deltas.map((d) => d.type),
      ['reset', 'message.start', 'message.start'],
    )
  })
})

test('restoring a conversation that is not mounted answers false', () => {
  withManager(({ manager }) => {
    // Not an error: the caller falls back to the stored copy rather than showing
    // an empty conversation as if it were the real state.
    assert.equal(manager.restore('chat_nothing' as ChatId), false)
  })
})

test('deleting takes the body first and then the route', () => {
  withManager(({ manager, threads, index }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    index.record({ sessionId: 'sess_1', backend: 'endpoint', agentId: 'test-model' })

    assert.equal(manager.deleteSession('sess_1'), true)
    assert.equal(threads.read('sess_1'), null)
    assert.equal(index.lookup('sess_1'), null)
  })
})

test('deleting a conversation somebody is reading is refused', () => {
  withManager(({ manager, threads, index }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')

    // The command layer already refuses this as a CONFLICT. Reaching here means
    // that check moved or was bypassed, and destroying what somebody is reading
    // is the one outcome worth being defensive about twice.
    assert.equal(manager.deleteSession('sess_1'), false)
    assert.equal(threads.read('sess_1')?.transcript.length, 2)
    assert.equal(index.lookup('sess_1')?.backend, 'endpoint')
  })
})

/* ================================================================== */
/* Getting a request out, and getting a failure back                   */
/* ================================================================== */

test('a keyless endpoint resolves auth it can actually send', async () => {
  // `pi-ai` refuses to build a request with neither an api key nor an auth
  // header, so `{ auth: {} }` — "this endpoint needs no credentials" — meant the
  // vLLM/Ollama case `provider.ts` is written for could not send at all.
  const settings = { baseUrl: 'http://localhost:1/v1', model: 'm', api: 'openai-completions' } as never
  const keyless = buildEndpointModel(settings, null)
  const resolved = await keyless.models.getProvider('peek-endpoint')?.auth.apiKey?.resolve({ ctx: {} as never })
  assert.equal(resolved?.auth.apiKey, undefined)
  assert.match(String(resolved?.auth.headers?.['authorization']), /^Bearer /)

  // With a key there is no sentinel header: the key is the credential, and
  // sending both would be sending a fake one alongside the real one.
  const keyed = buildEndpointModel(settings, 'sk-real')
  const withKey = await keyed.models.getProvider('peek-endpoint')?.auth.apiKey?.resolve({ ctx: {} as never })
  assert.equal(withKey?.auth.apiKey, 'sk-real')
  assert.equal(withKey?.auth.headers, undefined)
})

test('a turn the endpoint cannot answer ends as an error, not an empty bubble', async () => {
  // The bug this whole branch exists for. `pi-ai` writes the failure into the
  // assistant message instead of rejecting, `pi-agent-core` returns it normally,
  // and `prompt()` resolved — so the turn used to settle as a blank answer with
  // nothing in the log. Nothing listens on port 1, so the failure here is real.
  await withManagerAsync(async ({ manager, patches, notices, threads }) => {
    manager.openChat(CHAT, 'sess_1')
    manager.send({ chatId: CHAT, text: 'how many tables?', attachments: [] })

    await until(() => patches.some((p) => p.status === 'error'))

    // Not `idle`: the conversation is in a state the user has to do something
    // about, and the status bar is where that shows.
    assert.equal(patches.filter((p) => p.status !== undefined).at(-1)?.status, 'error')
    // And it is said out loud. "The model answered with silence" was the whole
    // symptom; a toast is the difference between a bug and a diagnosis.
    assert.equal(notices.at(-1)?.level, 'error')
    assert.match(String(notices.at(-1)?.message), /endpoint/i)

    // A failed turn is still a turn that happened: the user's own message
    // survives it.
    const stored = threads.read('sess_1')?.transcript ?? []
    assert.equal(stored[0]?.role, 'user')
    assert.equal(stored.at(-1)?.stopReason, 'error')
  })
})

test('an endpoint that wanted a key after all says so, instead of just "401"', async () => {
  // The cost of the sentinel `authorization` header: an endpoint that really
  // does want credentials now answers 401, where before `pi-ai` refused to send
  // and named the reason. peek knows the user left the key blank, so it can put
  // that reason back — and this is the assertion that keeps it honest.
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await withManagerAsync(
      async ({ manager, notices, patches }) => {
        manager.openChat(CHAT, 'sess_1')
        manager.send({ chatId: CHAT, text: 'hi', attachments: [] })
        await until(() => patches.some((p) => p.status === 'error'))

        const detail = String(notices.at(-1)?.detail)
        // The endpoint's own words come through — peek does not paraphrase an
        // upstream error into something the user cannot search for.
        assert.match(detail, /Incorrect API key provided/)
        assert.match(detail, /configured without an API key/)
      },
      { baseUrl: `http://127.0.0.1:${String(port)}/v1` },
    )
  } finally {
    server.close()
  }
})

test('an unreachable endpoint is not blamed on the missing key', async () => {
  // Nothing on port 1, so the failure is a refused socket. Appending "configured
  // without an API key" to every failure would be noise pointing at the wrong
  // thing; the hint is for auth-shaped errors only.
  await withManagerAsync(async ({ manager, notices, patches }) => {
    manager.openChat(CHAT, 'sess_1')
    manager.send({ chatId: CHAT, text: 'hi', attachments: [] })
    await until(() => patches.some((p) => p.status === 'error'))
    assert.doesNotMatch(String(notices.at(-1)?.detail), /configured without an API key/)
  })
})

async function until(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the turn to settle')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('clear empties the stored conversation instead of deleting the file', () => {
  withManager(({ manager, threads }) => {
    threads.write({ sessionId: 'sess_1', transcript: STORED, messages: [], modelId: 'test-model', updatedAt: 9 })
    manager.openChat(CHAT, 'sess_1')
    manager.clear(CHAT)

    // The conversation still exists — the user emptied it, they did not remove
    // it from the catalogue — so the file stays and is rewritten empty. Leaving
    // the old one would resurrect the whole thing on the next open.
    assert.deepEqual(threads.read('sess_1')?.transcript, [])
  })
})
