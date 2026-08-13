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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import {
  applyChatDeltaToMessages,
  asChatId,
  type ChatDelta,
  type ChatId,
  type ChatMessage,
  type ChatPermissionMode,
  type NotifyMessage,
  type PeekError,
} from '@peek/core'
import { AcpManager } from '../manager'
import { AcpSnapshotStore } from '../snapshot-store'
import { claudeCodeProfile } from '../profiles'
import {
  DEFAULT_ACP_TIMEOUTS,
  DEFAULT_DELTA_BUDGET,
  DEFAULT_RESTART_POLICY,
  type AcpHostConfig,
  type ChatAgentStatePatch,
  type McpEndpointInfo,
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
  notifications: NotifyMessage[]
  chatId: ChatId
  status(): string | undefined
  /** The error the turn ended with, read off the transcript rather than the state. */
  endError(): PeekError | undefined
  /** The snapshot store this host was given, so a test can seed or inspect it. */
  snapshots: AcpSnapshotStore
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
  'STUB_DIE_ON_PROMPT_MS',
  'STUB_DIE_ONCE_FILE',
  'STUB_SILENT',
  'STUB_TALK_MS',
  'STUB_NO_HISTORY',
  'STUB_SESSIONS',
] as const

after(() => {
  for (const key of STUB_ENV_KEYS) delete process.env[key]
})

function harness(
  env: Record<string, string> = {},
  overrides: Partial<AcpHostConfig> = {},
  endpoint: McpEndpointInfo | null = null,
): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'peek-acp-mgr-'))
  dirs.push(cwd)
  for (const key of STUB_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v

  const deltas: ChatDelta[] = []
  const patches: ChatAgentStatePatch[] = []
  const notifications: NotifyMessage[] = []
  const snapshots = new AcpSnapshotStore(join(cwd, 'snapshots'))
  const manager = new AcpManager(
    {
      applyState: (patch) => {
        patches.push(patch)
        return Promise.resolve()
      },
      emitDeltas: (_chatId, batch) => {
        deltas.push(...batch)
      },
      notify: (message) => {
        notifications.push(message)
      },
      resolveMcpEndpoint: () => endpoint,
      snapshots,
    },
    {
      resolveCwd: () => cwd,
      profile: claudeCodeProfile,
      agentConfig: {},
      agentEntryPath: STUB,
      permissionMode: () => 'default',
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
    notifications,
    chatId: asChatId('chat_test'),
    snapshots,
    status: () => [...patches].reverse().find((p) => p.status !== undefined)?.status,
    endError: () =>
      [...deltas]
        .reverse()
        .find((d): d is Extract<ChatDelta, { type: 'message.end' }> => d.type === 'message.end')?.error,
  }
}

/** Every JSON-RPC method the stub recorded, in order. */
async function methodsIn(log: string): Promise<string[]> {
  const { readFileSync } = await import('node:fs')
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { method: string }).method)
}

/** The params of the first `method` call the stub recorded. */
async function paramsOf(log: string, method: string): Promise<Record<string, unknown> | undefined> {
  const { readFileSync } = await import('node:fs')
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> })
    .find((m) => m.method === method)?.params
}

/**
 * Every `method` call the stub recorded, in order.
 *
 * `paramsOf` above answers about the *first* one, which is enough for a question
 * about what one session was told. This one exists for the question "did the
 * second session get told something different from the first", which is what a
 * value read per session rather than per process means.
 */
async function allParamsOf(log: string, method: string): Promise<Record<string, unknown>[]> {
  const { readFileSync } = await import('node:fs')
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> })
    .filter((m) => m.method === method)
    .map((m) => m.params ?? {})
}

/** A scratch log path, unique per test. */
function logPath(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `peek-acp-${tag}-`))
  dirs.push(dir)
  return join(dir, 'calls.jsonl')
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

test('the starting mode is read when a conversation starts, not when the host was assembled', async () => {
  /*
   * The bug: `permissionMode` was a value taken off `settings.json` once during
   * assembly, so "new conversations start in …" only reached conversations
   * started after the *next* launch — while the restart notice in the panel
   * belonged to the backend picker and said nothing about this. It is a thunk
   * now, and this is the assertion that it is read per session rather than per
   * process. The old shape could not fail this test; it could not express it.
   *
   * Observed on the wire, like the sandbox above: what the agent was actually
   * told, not what the object holding the setting contained.
   */
  const log = logPath('mode')
  let mode: ChatPermissionMode = 'default'
  const h = harness({ STUB_PROMPT_MS: '50', STUB_LOG: log }, { permissionMode: () => mode })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'first', attachments: [] })
    await sleep(400)

    // What changing the setting does. No restart, no reassembly, nothing pushed.
    mode = 'plan'

    await h.manager.send({ chatId: asChatId('chat_second'), text: 'second', attachments: [] })
    await sleep(400)

    const sent = (await allParamsOf(log, 'session/set_mode')).map((p) => p['modeId'])
    assert.deepEqual(
      sent,
      ['default', 'plan'],
      'each session must be created in the mode set at the time it started; the agent was told ' +
        JSON.stringify(sent),
    )
  } finally {
    await h.manager.dispose()
  }
})

test('setting the mode on a conversation with no session yet moves the dropdown and sends nothing', async () => {
  /*
   * The contract `session.open` leans on for the *other* half of the same bug.
   * A new conversation creates no session until somebody types, so the dropdown
   * used to show `buildChatViewState`'s placeholder — "ask me every time" — until
   * the first message, whatever the user had just set. The chat host now calls
   * this the moment the view appears.
   *
   * Both halves are asserted because both can regress on their own: a version
   * that spawned an agent to record the mode would cost every user who opens a
   * panel and never types, and one that recorded nothing would leave the
   * dropdown lying exactly as before.
   */
  const log = logPath('mode-idle')
  const h = harness({ STUB_LOG: log }, { permissionMode: () => 'plan' })
  try {
    await h.manager.setPermissionMode(h.chatId, 'plan')
    await sleep(200)
    assert.equal(
      [...h.patches].reverse().find((p) => p.permissionMode !== undefined)?.permissionMode,
      'plan',
      'the window was never told what mode the conversation is in',
    )
    assert.ok(!existsSync(log), 'an agent was started for a conversation nobody has typed in yet')
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

/* ==================================================================
 * The three things the ACP spike measured against a real agent, and
 * that survived only as prose in the code they justify.
 *
 * Each one is a failure mode nobody would guess from the protocol: it
 * was found by running the thing and watching. A comment recording
 * that is worth having; it is not worth as much as a test that goes
 * red when the guard it justifies is removed, which is what these are.
 * ================================================================== */

test('spike 1: a turn that goes silent is cut off, not left to retry for minutes', async () => {
  // Measured against the real agent with an unreachable model endpoint: the
  // agent retried internally for ~175 seconds, put **nothing** on the wire the
  // whole time, and the panel showed a spinner throughout. No protocol error is
  // ever emitted for this — the request simply stays open — so `promptIdleMs`
  // is the only thing standing between the user and a three-minute stare.
  //
  // The stub reproduces exactly that shape: `session/prompt` accepted, total
  // silence, and a reply that would eventually arrive long after anyone cares.
  const log = logPath('silent')
  const h = harness(
    { STUB_SILENT: '1', STUB_PROMPT_MS: '30000', STUB_LOG: log },
    { timeouts: { ...DEFAULT_ACP_TIMEOUTS, promptIdleMs: 400 } },
  )
  try {
    await h.manager.send({ chatId: h.chatId, text: 'anything', attachments: [] })
    await sleep(1_800)

    assert.equal(h.status(), 'error', 'the silent turn was never cut off')

    // Surfaced as a toast, and it has to be: a turn that never produced a single
    // chunk has no agent message for the transcript to attach the error to, so
    // this is the *only* place the user is told what happened. Without it the
    // panel went from a spinner to a red status with no sentence anywhere.
    const toast = h.notifications.find((n) => n.level === 'error')
    assert.ok(toast, `the stalled turn was killed in silence; notifications: ${JSON.stringify(h.notifications)}`)
    assert.match(toast.message, /400 ms/, 'the message must name the budget that was applied')

    // And the agent was actually told to stop, rather than peek merely giving up
    // on it locally while the turn kept running and kept costing.
    assert.ok((await methodsIn(log)).includes('session/cancel'), 'the stalled turn was never cancelled')
  } finally {
    await h.manager.dispose()
  }
})

test('spike 1b: a turn that keeps talking still has an end — promptMaxMs', async () => {
  // The other half, and the one `promptIdleMs` cannot see. Every session update
  // resets the idle clock, so an agent looping — re-reading, re-planning,
  // retrying — looks exactly like one making progress and, with `promptMaxMs` at
  // its old default of `0`, ran until the user closed the window.
  //
  // The stub chatters every 60ms, well inside the 400ms idle budget, so only the
  // absolute ceiling can stop this.
  const h = harness(
    { STUB_TALK_MS: '60', STUB_PROMPT_MS: '30000' },
    { timeouts: { ...DEFAULT_ACP_TIMEOUTS, promptIdleMs: 400, promptMaxMs: 900 } },
  )
  try {
    await h.manager.send({ chatId: h.chatId, text: 'loop forever', attachments: [] })
    await sleep(2_500)
    assert.equal(h.status(), 'error', 'a turn with no silence in it ran unbounded')
    const error = h.endError()
    assert.equal(error?.code, 'TIMEOUT')
    // Named distinctly from the idle watchdog: "The reply" means it went quiet,
    // "The turn" means it did not. Reporting the wrong one sends whoever reads
    // the toast looking at the wrong thing.
    assert.match(error?.message ?? '', /^The turn /, 'the ceiling and the idle watchdog must be distinguishable')
    assert.match(error?.message ?? '', /900 ms/, 'the configured budget, not the remainder after a pause')
  } finally {
    await h.manager.dispose()
  }
})

test('spike 1c: promptMaxMs is agent time — a human deciding does not spend it', async () => {
  // The contradiction that `promptIdleMs` already had to be taught once, in its
  // own terms: `permissionMs` is 5 minutes by default and `promptMaxMs` is 30,
  // so a turn asking for six approvals could burn its entire absolute budget on
  // dialogs and be killed for something the agent never did.
  //
  // Here the ceiling is 700ms of agent time and the human takes 1.5 seconds. The
  // turn must survive, because the agent spent almost none of it.
  const h = harness(
    { STUB_ASK_PERMISSION: '1', STUB_PROMPT_MS: '100' },
    { timeouts: { ...DEFAULT_ACP_TIMEOUTS, promptIdleMs: 5_000, promptMaxMs: 700, permissionMs: 30_000 } },
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
    assert.notEqual(h.status(), 'error', 'the absolute ceiling ran against a person reading a dialog')
    assert.equal(h.manager.respondPermission(requestId, 'allow'), true, 'the request expired under the ceiling')
    await sleep(1_000)
    assert.equal(h.status(), 'ready')
  } finally {
    await h.manager.dispose()
  }
})

test('spike 2: an agent that dies mid-request is reported as a crash, not as a mystery', async () => {
  // What the SDK rejects with when the process disappears under an in-flight
  // `prompt()` is `new Error("ACP connection closed")` — no JSON-RPC code, no
  // `data`, nothing structured. And it is not even a fixed string: the same
  // `close(error)` path is fed whatever the stream reader threw, so an EPIPE or
  // an ECONNRESET arrives here just as bare.
  //
  // Classification therefore used to hang on a four-entry substring list. This
  // asserts the outcome the user sees, so the *how* can be replaced (it now
  // is — `agentAlive` is a structural check) without weakening the promise.
  const h = harness({ STUB_PROMPT_MS: '30000', STUB_DIE_ON_PROMPT_MS: '250' })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'die on me', attachments: [] })
    await sleep(1_500)

    const error = h.endError()
    assert.ok(error, 'the turn never ended')
    assert.equal(error.code, 'DRIVER_CRASHED', `a crash was reported as ${error.code}`)
    assert.equal(error.retryable, true, 'the panel restarts the agent, so this is retryable')
    assert.ok(error.detail, 'the user must be told the conversation survives')
  } finally {
    await h.manager.dispose()
  }
})

test('spike 3: no MCP endpoint means a loud warning, because session/new will not complain', async () => {
  // `session/new` does **not** fail when an MCP server is unreachable — it drops
  // the server and carries on. Measured: a session created against a dead
  // endpoint produced a Claude that could talk but could not see the window, with
  // nothing anywhere saying why, and the symptom read as the model being unable
  // to follow instructions. The pre-check in `#openAgentSession` exists only to
  // turn that silence into a sentence.
  const log = logPath('nomcp')
  const h = harness({ STUB_PROMPT_MS: '80', STUB_LOG: log }, {}, null)
  try {
    await h.manager.send({ chatId: h.chatId, text: 'hi', attachments: [] })
    await sleep(900)

    const warning = h.notifications.find((n) => n.level === 'warn' && /cannot see this window/i.test(n.message))
    assert.ok(warning, `no warning was raised; notifications were ${JSON.stringify(h.notifications)}`)
    assert.match(String(warning.detail), /MCP/, 'the detail has to name what is missing')

    // And peek did not quietly pass an empty descriptor off as a working one.
    const params = await paramsOf(log, 'session/new')
    assert.deepEqual(params?.['mcpServers'], [], 'a session with no endpoint must carry no MCP server')
  } finally {
    await h.manager.dispose()
  }
})

test('spike 3b: a live endpoint reaches session/new as a bearer descriptor, and never a log', async () => {
  const log = logPath('mcp')
  const TOKEN = 'peek-test-bearer-token-0123456789abcdef'
  const h = harness({ STUB_PROMPT_MS: '80', STUB_LOG: log }, {}, { url: 'http://127.0.0.1:7332/mcp', token: TOKEN })

  const logLines: string[] = []
  h.manager.events.on('log', (e) => {
    logLines.push(`${e.message} ${e.detail ?? ''}`)
  })

  try {
    await h.manager.send({ chatId: h.chatId, text: 'hi', attachments: [] })
    await sleep(900)

    const params = await paramsOf(log, 'session/new')
    const servers = params?.['mcpServers'] as { name: string; url: string; headers: { name: string; value: string }[] }[]
    assert.equal(servers.length, 1, 'the closed loop needs exactly peek’s own server')
    assert.equal(servers[0]?.name, 'peek')
    // `headers` is an array of {name, value}, not an object — getting this wrong
    // is silent: the agent takes the session and every tool call 401s.
    assert.deepEqual(servers[0]?.headers, [{ name: 'Authorization', value: `Bearer ${TOKEN}` }])

    assert.ok(
      !h.notifications.some((n) => /cannot see this window/i.test(n.message)),
      'a working endpoint must not be reported as missing',
    )

    // The token is a credential. It goes to the agent and nowhere else — not to
    // a toast, not to a diagnostic log line, not into a transcript delta.
    const everythingElse = JSON.stringify({
      notifications: h.notifications,
      deltas: h.deltas,
      patches: h.patches,
      logLines,
    })
    assert.ok(!everythingElse.includes(TOKEN), 'the MCP bearer token leaked out of the session descriptor')
  } finally {
    await h.manager.dispose()
  }
})

/* ================================================================== */
/* The session catalogue                                               */
/* ================================================================== */

test('a chat opened onto an existing session loads it instead of creating one', async () => {
  const log = logPath('load')
  const h = harness({ STUB_LOG: log })
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')

    const methods = await methodsIn(log)
    assert.ok(methods.includes('session/load'), 'resuming must go through session/load')
    assert.ok(!methods.includes('session/new'), 'and must not also create a fresh session')

    const params = await paramsOf(log, 'session/load')
    assert.equal(params?.['sessionId'], 'stub-session-old')

    // Deltas are batched on a time budget before they cross IPC, so the replay
    // is in the batcher rather than in `h.deltas` the instant the load returns.
    await sleep(300)

    // The replay arrives while `session/load` is still open, so it only reaches
    // the transcript if the reverse index was populated *before* the call. This
    // assertion is the regression test for that ordering.
    const text = h.deltas
      .filter((d): d is Extract<ChatDelta, { type: 'text.append' }> => d.type === 'text.append')
      .map((d) => d.text)
      .join('')
    assert.equal(
      text,
      'what did I ask?replayed history',
      'history replayed during the load must land in the transcript',
    )
    assert.equal(h.status(), 'ready')
  } finally {
    await h.manager.dispose()
  }
})

test('the loading state is reported while a conversation is being replayed', async () => {
  const h = harness()
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    const statuses = h.patches.map((p) => p.status).filter(Boolean)
    assert.ok(
      statuses.includes('loading'),
      'a resumed conversation reports `loading`, never `starting` — the composer says different things',
    )
    assert.ok(!statuses.includes('starting'))
  } finally {
    await h.manager.dispose()
  }
})

test('a first prompt on a fresh chat still creates a session rather than loading one', async () => {
  const log = logPath('new')
  const h = harness({ STUB_PROMPT_MS: '50', STUB_LOG: log })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'hello', attachments: [] })
    await sleep(400)
    const methods = await methodsIn(log)
    assert.ok(methods.includes('session/new'))
    assert.ok(!methods.includes('session/load'))
  } finally {
    await h.manager.dispose()
  }
})

test('reopening the same conversation on a chat that already has it does not replay twice', async () => {
  const log = logPath('load-twice')
  const h = harness({ STUB_LOG: log })
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    await h.manager.openChat(h.chatId, 'stub-session-old')
    const loads = (await methodsIn(log)).filter((m) => m === 'session/load')
    assert.equal(loads.length, 1, 'a second open of the same session is a no-op, not a second transcript')
  } finally {
    await h.manager.dispose()
  }
})

test('reloadChat replays a conversation the window lost, where openChat would not', async () => {
  const log = logPath('reload')
  const h = harness({ STUB_LOG: log })
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    await sleep(300)
    h.deltas.length = 0

    // The renderer reloaded: main still holds the session, so `openChat`'s
    // "already up on the right session" short-circuit returns immediately and
    // nothing is replayed. That guard is right — it stops a tab opened twice
    // from stacking a conversation on itself — so this is a separate door.
    assert.equal(await h.manager.reloadChat(h.chatId), true)
    await sleep(300)

    const loads = (await methodsIn(log)).filter((m) => m === 'session/load')
    assert.equal(loads.length, 2, 'a reload has to actually ask the agent again')

    // The reset comes first, so a mirror that is *not* empty is cleared rather
    // than doubled. Without it a second restore stacks the conversation.
    assert.equal(h.deltas[0]?.type, 'reset')

    // And the replay is not doubled onto the old translator state. This is the
    // half that regresses silently: the translator is stateful (open message,
    // tool-call table, message count), and replaying onto a used one continues
    // the old numbering and mis-addresses every delta.
    const text = h.deltas
      .filter((d): d is Extract<ChatDelta, { type: 'text.append' }> => d.type === 'text.append')
      .map((d) => d.text)
      .join('')
    assert.equal(text, 'what did I ask?replayed history')
  } finally {
    await h.manager.dispose()
  }
})

test('reloading a chat that has no session answers false and sends nothing', async () => {
  const log = logPath('reload-empty')
  const h = harness({ STUB_LOG: log })
  try {
    // Not an error: the window then shows an empty conversation, which is what
    // it is. Bringing a session up here would spawn an agent for a panel nobody
    // has typed into, which is exactly what lazy bringup exists to avoid.
    assert.equal(await h.manager.reloadChat(h.chatId), false)
    assert.deepEqual(h.deltas, [])
    // The stub writes its call log on startup, so an absent file is the proof:
    // no agent process was spawned at all.
    assert.ok(!existsSync(log), 'a reload with nothing to reload must not start an agent')
  } finally {
    await h.manager.dispose()
  }
})

test('closing a chat detaches it and never deletes or closes the agent’s session', async () => {
  const log = logPath('detach')
  const h = harness({ STUB_LOG: log })
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    h.manager.closeChat(h.chatId)
    await sleep(100)

    // The promise the session list depends on: a conversation the user closed is
    // still on disk, still listable, still openable. See `closeChat`.
    const methods = await methodsIn(log)
    assert.ok(!methods.includes('session/close'), 'closing a view must not close the agent session')
    assert.ok(!methods.includes('session/delete'), 'and must certainly not delete it')
  } finally {
    await h.manager.dispose()
  }
})

test('the catalogue lists what the agent reports, filtered to peek’s own workdir', async () => {
  const h = harness({ STUB_SESSIONS: 'sess-a,sess-b' })
  try {
    const result = await h.manager.listSessions()
    assert.equal(result.supported, true)
    assert.deepEqual(
      result.sessions.map((s) => s.sessionId),
      ['sess-a', 'sess-b'],
    )
    assert.equal(result.sessions[0]?.title, 'title of sess-a')
    assert.equal(result.cwd, result.sessions[0]?.cwd, 'the filter is the chat workdir, and it is reported')
  } finally {
    await h.manager.dispose()
  }
})

test('an agent that keeps no history answers `supported: false` rather than failing', async () => {
  const log = logPath('nohistory')
  const h = harness({ STUB_NO_HISTORY: '1', STUB_LOG: log })
  try {
    const result = await h.manager.listSessions()
    assert.equal(result.supported, false)
    assert.deepEqual(result.sessions, [])
    // Not merely an empty answer: the request is never made, because the agent
    // said it cannot answer it.
    assert.ok(!(await methodsIn(log)).includes('session/list'))
  } finally {
    await h.manager.dispose()
  }
})

test('loading against an agent with no history is refused before anything is sent', async () => {
  const log = logPath('noload')
  const h = harness({ STUB_NO_HISTORY: '1', STUB_LOG: log })
  try {
    await assert.rejects(
      () => h.manager.openChat(h.chatId, 'sess-a'),
      (raw: unknown) => (raw as PeekError).code === 'UNSUPPORTED_CAPABILITY',
    )
    assert.ok(!(await methodsIn(log)).includes('session/load'))
    assert.equal(h.status(), 'error')
  } finally {
    await h.manager.dispose()
  }
})

test('deleting a conversation reaches the agent', async () => {
  const log = logPath('delete')
  const h = harness({ STUB_LOG: log })
  try {
    await h.manager.deleteSession('sess-a')
    const params = await paramsOf(log, 'session/delete')
    assert.equal(params?.['sessionId'], 'sess-a')
  } finally {
    await h.manager.dispose()
  }
})

test('a replayed conversation keeps the user’s own turns, so it is not a monologue', async () => {
  // The regression, found by running this against the real agent rather than the
  // stub: `user_message_chunk` was dropped unconditionally, on the reasoning that
  // peek records the user's message itself when `chat.send` runs. True for a live
  // turn, false for a replay — nobody ran `chat.send` in this process, possibly
  // not on this day. What came back was Claude answering questions that were not
  // there.
  const h = harness()
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    await sleep(300)

    const starts = h.deltas.filter(
      (d): d is Extract<ChatDelta, { type: 'message.start' }> => d.type === 'message.start',
    )
    assert.deepEqual(
      starts.map((d) => d.message.role),
      ['user', 'agent'],
      'both sides of the stored conversation must come back, in order',
    )
    // A speaker change opens a new message even with no `messageId` to go by —
    // otherwise the whole exchange concatenates into one bubble.
    assert.equal(
      h.deltas.filter((d) => d.type === 'message.end').length,
      2,
      'and each of them is closed, so the restored transcript does not look mid-answer',
    )
  } finally {
    await h.manager.dispose()
  }
})

test('a live turn still records the user’s message once, not twice', async () => {
  // The other half of the same decision. peek appends the user's turn itself when
  // the command runs, so the agent's echo of it during a live turn must stay
  // dropped — a replay-shaped fix that forgot this would double every message the
  // user sends.
  const h = harness({ STUB_PROMPT_MS: '50' })
  try {
    await h.manager.send({ chatId: h.chatId, text: 'only once please', attachments: [] })
    await sleep(500)

    const userMessages = h.deltas.filter(
      (d): d is Extract<ChatDelta, { type: 'message.start' }> =>
        d.type === 'message.start' && d.message.role === 'user',
    )
    assert.equal(userMessages.length, 1, 'exactly one user bubble per turn the user actually took')
  } finally {
    await h.manager.dispose()
  }
})

/* ================================================================== */
/* The stored snapshot                                                 */
/* ================================================================== */

/** Fold a delta run the way the renderer's mirror does, for comparing projections. */
function project(deltas: readonly ChatDelta[]): ChatMessage[] {
  let messages: ChatMessage[] = []
  for (const delta of deltas) messages = applyChatDeltaToMessages(messages, delta)
  return messages
}

// `design/2026-08-06-opening-a-stored-conversation.md` §4.1. What is stored has
// to be *what the window was shown* — not approximately, exactly. The two are
// built by the same function from the same delta run, and this is what keeps
// them that way: if `#emit` ever folds the batcher's merged output instead of
// its input, or writes at a moment when the two disagree, this fails.
test('what is written to a snapshot is exactly what the window was shown', async () => {
  const h = harness()
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    await sleep(400)

    const stored = h.snapshots.read('stub-session-old')
    assert.ok(stored, 'a replayed conversation should leave a snapshot behind')
    assert.deepEqual(stored.transcript, project(h.deltas))
    assert.ok(stored.transcript.length > 0)
  } finally {
    await h.manager.dispose()
  }
})

// §2.3. The snapshot goes up first and the agent's copy replaces it — the whole
// point of the feature — and the ordering is what makes it safe. A `reset` has
// to separate the two, or the replay lands *underneath* the picture and the
// user reads the conversation twice.
test('a stored snapshot is drawn first and then replaced by the agent’s own copy', async () => {
  const h = harness()
  try {
    // A picture of an earlier visit to this conversation, as `#saveSnapshot`
    // would have left it.
    h.snapshots.write(
      'stub-session-old',
      [
        {
          id: 'snap_1' as ChatMessage['id'],
          role: 'agent',
          blocks: [{ type: 'text', text: 'from the snapshot' }],
          complete: true,
          createdAt: 1,
        },
      ],
      1,
    )

    // Deliberately not awaited yet. `openChat` draws the snapshot **before** its
    // first await, so the picture is on screen in the same tick the user
    // clicked — awaiting here would measure the state after the load finished
    // and prove nothing about the wait it exists to remove.
    const opening = h.manager.openChat(h.chatId, 'stub-session-old')

    const drawn = project(h.deltas)
    assert.equal(drawn.length, 1, 'the picture should be on screen before anything is awaited')
    assert.equal(drawn[0]?.blocks[0]?.type === 'text' && drawn[0].blocks[0].text, 'from the snapshot')

    await opening
    await sleep(400)
    assert.equal(h.patches.some((p) => p.showingSnapshot === true), true)

    // And afterwards it is gone, replaced rather than appended to. The stub's
    // replay is the only text left.
    const finished = project(h.deltas)
    const text = finished
      .flatMap((m) => m.blocks)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    assert.equal(text.includes('from the snapshot'), false, 'the picture must not survive the replay')
    assert.equal(text, 'what did I ask?replayed history')
    assert.equal([...h.patches].reverse().find((p) => p.showingSnapshot !== undefined)?.showingSnapshot, false)
  } finally {
    await h.manager.dispose()
  }
})

// §2.6. A snapshot that outlives the conversation it pictures is the one way
// this store could show a user something that exists nowhere else.
test('deleting a conversation deletes the picture of it too', async () => {
  const h = harness()
  try {
    await h.manager.openChat(h.chatId, 'stub-session-old')
    await sleep(400)
    assert.ok(h.snapshots.read('stub-session-old'))

    h.manager.closeChat(h.chatId)
    await h.manager.deleteSession('stub-session-old')
    assert.equal(h.snapshots.read('stub-session-old'), null)
  } finally {
    await h.manager.dispose()
  }
})
