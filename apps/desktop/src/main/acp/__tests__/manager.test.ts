/**
 * `AcpManager` against a stub agent.
 *
 * Everything else in this directory is unit-tested against pure functions, which
 * left the one thing that actually goes wrong untested: **ordering**. A turn's
 * life spans an agent spawn, a handshake, a `session/new` and an attachment
 * resolution the caller does the awaiting for, and the bugs live in the gaps
 * between those awaits — a stop press that lands in one of them, a permission
 * dialog that outlives a watchdog. None of that is reachable without a real
 * child process and a real ACP connection, so this file brings up both against
 * `stub-agent.mjs` (no model, no network, no database).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { asChatId, type ChatDelta, type ChatId } from '@peek/core'
import { AcpManager } from '../manager'
import {
  DEFAULT_ACP_TIMEOUTS,
  DEFAULT_DELTA_BUDGET,
  DEFAULT_RESTART_POLICY,
  type AcpHostConfig,
  type ChatAgentStatePatch,
} from '../types'

const STUB = fileURLToPath(new URL('./stub-agent.mjs', import.meta.url))
const dirs: string[] = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  manager: AcpManager
  deltas: ChatDelta[]
  patches: ChatAgentStatePatch[]
  chatId: ChatId
  status(): string | undefined
}

/**
 * Every knob `stub-agent.mjs` reads.
 *
 * The stub is configured through the environment and the environment is shared
 * by the whole file, so `harness` **replaces** the whole set rather than adding
 * to it. Merely setting the keys a test asks for leaves the previous test's
 * settings in place: a test that wanted a slow `session/new` silently gave the
 * next one a slow `session/new` too, and a test that wanted a crashing agent
 * would give every test after it a crashing agent. Either way the failure lands
 * on an innocent test and reads as a flake.
 */
const STUB_ENV_KEYS = [
  'STUB_NEW_SESSION_DELAY_MS',
  'STUB_PROMPT_MS',
  'STUB_ASK_PERMISSION',
  'STUB_CHATTER_MS',
  'STUB_LOG',
  'STUB_DIE_AFTER_MS',
  'STUB_DIE_ONCE_FILE',
] as const

after(() => {
  for (const key of STUB_ENV_KEYS) delete process.env[key]
})

function harness(env: Record<string, string> = {}, overrides: Partial<AcpHostConfig> = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'peek-acp-mgr-'))
  dirs.push(cwd)
  for (const key of STUB_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v

  const deltas: ChatDelta[] = []
  const patches: ChatAgentStatePatch[] = []
  const manager = new AcpManager(
    {
      applyState: (patch) => {
        patches.push(patch)
        return Promise.resolve()
      },
      emitDeltas: (_chatId, batch) => {
        deltas.push(...batch)
      },
      notify: () => {
        /* toasts are not what this file is about */
      },
      resolveMcpEndpoint: () => null,
    },
    {
      resolveCwd: () => cwd,
      agentEntryPath: STUB,
      permissionMode: 'default',
      timeouts: DEFAULT_ACP_TIMEOUTS,
      batch: DEFAULT_DELTA_BUDGET,
      restart: DEFAULT_RESTART_POLICY,
      verbose: false,
      ...overrides,
    },
  )
  return {
    manager,
    deltas,
    patches,
    chatId: asChatId('chat_test'),
    status: () => [...patches].reverse().find((p) => p.status !== undefined)?.status,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ================================================================== */

test('a plain turn reaches the stub and streams back', async () => {
  const h = harness({ STUB_PROMPT_MS: '150' })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'hello', attachments: [] })
    await sleep(900)
    const text = h.deltas
      .filter((d): d is Extract<ChatDelta, { type: 'text.append' }> => d.type === 'text.append')
      .map((d) => d.text)
      .join('')
    assert.equal(text, 'stub reply')
    assert.equal(h.status(), 'ready')
  } finally {
    await h.manager.dispose()
  }
})

test('a stop pressed while the session is still coming up is honoured, not swallowed', async () => {
  // The regression: `cancel()` returned false whenever there was no
  // `agentSessionId` yet, so the whole spawn + handshake + `session/new` window
  // was a dead zone — the user's stop did nothing and the turn they abandoned
  // was sent to the model anyway, where it could still drive the window through
  // `mcp__peek__*`. The stub delays `session/new` to make that window wide.
  const log = join(mkdtempSync(join(tmpdir(), 'peek-acp-log-')), 'calls.jsonl')
  const h = harness({ STUB_NEW_SESSION_DELAY_MS: '1200', STUB_PROMPT_MS: '200', STUB_LOG: log })
  try {
    // Exactly what `createAcpChatRuntime` does, in its order: mark the turn
    // synchronously, *then* await attachment resolution, *then* call `send`.
    // The stop lands inside that await — which is why clearing the flag inside
    // `send()` could never work: `send` runs after the cancel, not before it.
    h.manager.beginTurn(h.chatId)
    const sending = (async () => {
      await sleep(120) // stands in for `resolveAttachments`
      return h.manager.send({ chatId: h.chatId, text: 'do not send me', attachments: [] })
    })()

    await sleep(40)
    assert.equal(await h.manager.cancel(h.chatId), true, 'cancel must report that it took the intent')

    await sending
    await sleep(1800)

    const { readFileSync } = await import('node:fs')
    const methods = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { method: string }).method)
    assert.ok(methods.includes('session/new'), 'the session still comes up')
    assert.ok(!methods.includes('session/prompt'), `the cancelled turn must never be sent; agent saw ${methods.join(', ')}`)

    // The user's own message is still recorded — they typed it — and the turn is
    // closed as cancelled rather than left spinning.
    assert.ok(h.deltas.some((d) => d.type === 'message.start'))
    assert.equal(h.status(), 'ready')
  } finally {
    await h.manager.dispose()
  }
})

test('beginTurn clears a stale cancel, so the next message is not eaten by the last stop', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'peek-acp-log2-')), 'calls.jsonl')
  const h = harness({ STUB_PROMPT_MS: '150', STUB_LOG: log })
  try {
    // A stop with nothing running arms the flag; it must not survive into the
    // turn the user sends afterwards.
    await h.manager.cancel(h.chatId)
    h.manager.beginTurn(h.chatId)
    await h.manager.send({ chatId: h.chatId, text: 'this one is real', attachments: [] })
    await sleep(900)

    const { readFileSync } = await import('node:fs')
    const methods = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { method: string }).method)
    assert.ok(methods.includes('session/prompt'), 'the following turn must go through')
  } finally {
    await h.manager.dispose()
  }
})

test('a human reading a permission dialog is not treated as a stalled turn', async () => {
  // The contradiction this closes: `promptIdleMs` (90s by default) was reset
  // only by session updates, and an agent blocked on `requestPermission` sends
  // none — so taking longer than the idle budget to decide killed the turn and
  // reported it as `acpTimeout('The reply', …)`, making the 5-minute permission
  // budget unreachable. Here the idle budget is 400ms and the human takes 1.5s.
  const log = join(mkdtempSync(join(tmpdir(), 'peek-acp-log4-')), 'calls.jsonl')
  const h = harness(
    { STUB_ASK_PERMISSION: '1', STUB_PROMPT_MS: '100', STUB_LOG: log },
    { timeouts: { ...DEFAULT_ACP_TIMEOUTS, promptIdleMs: 400, permissionMs: 30_000 } },
  )
  try {
    await h.manager.send({ chatId: h.chatId, text: 'ask me something', attachments: [] })

    // Wait for the prompt to be published, then sit on it well past the idle
    // budget before answering — the thing a real person does.
    let requestId: string | undefined
    for (let i = 0; i < 60 && requestId === undefined; i += 1) {
      await sleep(50)
      requestId = [...h.patches].reverse().find((p) => p.pendingPermission)?.pendingPermission?.requestId
    }
    assert.ok(requestId, 'no permission prompt was ever published')

    await sleep(1_500)
    assert.notEqual(h.status(), 'error', 'the turn was killed while a human was reading the dialog')

    assert.equal(h.manager.respondPermission(requestId, 'allow'), true, 'the request expired under the watchdog')
    await sleep(1_200)

    const { readFileSync } = await import('node:fs')
    const answered = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { method: string; params?: unknown })
      .find((m) => m.method === 'permission/answered')
    assert.ok(answered, 'the agent never received the late answer')
    assert.deepEqual(answered.params, { outcome: { outcome: 'selected', optionId: 'allow' } })
    assert.equal(h.status(), 'ready', 'the turn should finish normally after a slow answer')
  } finally {
    await h.manager.dispose()
  }
})

test('a stray update after the permission request does not restart the human clock', async () => {
  // The half of the watchdog fix that the silent stub could never catch.
  //
  // `#onRequestPermission` disarms the idle timer before awaiting the human, but
  // `#onSessionUpdate` re-arms it on *every* notification, and the real agent is
  // not silent while blocked: it keeps emitting `usage_update` and further
  // `tool_call_update`s. Measured in the running app against the real agent, with
  // the dialog on screen and nobody touching it, the turn died at exactly
  // `promptIdleMs` — "The reply did not finish within 90000 ms" — which is the
  // very failure the disarm was added to prevent.
  //
  // Here the idle budget is 400ms, the agent chatters every 150ms, and the human
  // takes 1.5s.
  const log = join(mkdtempSync(join(tmpdir(), 'peek-acp-log5-')), 'calls.jsonl')
  const h = harness(
    { STUB_ASK_PERMISSION: '1', STUB_CHATTER_MS: '150', STUB_PROMPT_MS: '100', STUB_LOG: log },
    { timeouts: { ...DEFAULT_ACP_TIMEOUTS, promptIdleMs: 400, permissionMs: 30_000 } },
  )
  try {
    await h.manager.send({ chatId: h.chatId, text: 'ask me something', attachments: [] })

    let requestId: string | undefined
    for (let i = 0; i < 60 && requestId === undefined; i += 1) {
      await sleep(50)
      requestId = [...h.patches].reverse().find((p) => p.pendingPermission)?.pendingPermission?.requestId
    }
    assert.ok(requestId, 'no permission prompt was ever published')

    await sleep(1_500)
    assert.notEqual(
      h.status(),
      'error',
      'a notification arriving after the request re-armed the idle watchdog behind the dialog',
    )
    assert.equal(h.manager.respondPermission(requestId, 'allow'), true, 'the request expired under the watchdog')
    await sleep(1_200)
    assert.equal(h.status(), 'ready')
  } finally {
    await h.manager.dispose()
  }
})

test('`session/new` carries the sandbox to the agent', async () => {
  // The security boundary, observed on the wire rather than in the object that
  // is supposed to reach it.
  const log = join(mkdtempSync(join(tmpdir(), 'peek-acp-log3-')), 'calls.jsonl')
  const h = harness({ STUB_PROMPT_MS: '50', STUB_LOG: log })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'hi', attachments: [] })
    await sleep(700)
    const { readFileSync } = await import('node:fs')
    const line = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'session/new')
    assert.ok(line, 'session/new was never sent')
    const meta = line.params?.['_meta'] as { claudeCode?: { options?: Record<string, unknown> } } | undefined
    const options = meta?.claudeCode?.options
    assert.ok(options, '_meta.claudeCode.options never reached the agent')
    assert.deepEqual(options['settingSources'], [])
    assert.deepEqual(options['tools'], [])
    assert.ok((options['disallowedTools'] as string[]).includes('Bash'))
  } finally {
    await h.manager.dispose()
  }
})

test('a crash and its restart leave no child process behind', async () => {
  // The leak this guards: `#ensureAgent` used to clear its cached handshake
  // unconditionally on failure, so a slow rejection from an agent that had
  // already died could clear the slot belonging to the *live* replacement. The
  // next send then ran `#startAgent` again, overwrote `#process`, and left the
  // middle child referenced by nothing — beyond `dispose()`'s reach, alive until
  // the OS reclaimed it.
  //
  // Asserting on the symptom rather than the mechanism: whatever the host does
  // internally, every process it ever started must be dead once it is disposed,
  // and it must never hold two at once.
  const dir = mkdtempSync(join(tmpdir(), 'peek-acp-crash-'))
  dirs.push(dir)
  const h = harness({
    STUB_PROMPT_MS: '80',
    STUB_DIE_AFTER_MS: '350',
    STUB_DIE_ONCE_FILE: join(dir, 'crashed.token'),
  })

  const started: number[] = []
  h.manager.events.on('ready', ({ pid }) => {
    if (pid !== undefined) started.push(pid)
  })

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  try {
    await h.manager.send({ chatId: h.chatId, text: 'hi', attachments: [] })
    // Through the crash (350ms), the restart backoff, and the new handshake,
    // sampling for an overlap the whole way.
    let maxConcurrent = 0
    for (let i = 0; i < 40; i += 1) {
      await sleep(100)
      maxConcurrent = Math.max(maxConcurrent, started.filter(alive).length)
      if (started.length >= 2) break
    }

    assert.ok(started.length >= 2, `the host never restarted; it reported ${started.length} agent(s)`)
    assert.equal(maxConcurrent, 1, `two agent processes were alive at once (pids ${started.join(', ')})`)
  } finally {
    await h.manager.dispose()
  }

  // `dispose()` only reaps the process it is holding, so a stranded child shows
  // up here and nowhere else.
  await sleep(400)
  const survivors = started.filter(alive)
  assert.deepEqual(survivors, [], `dispose() left ${survivors.length} orphaned agent process(es)`)
})
