/**
 * What peek answers when an agent asks for a capability it declared false.
 *
 * `manager.ts` declares `fs.readTextFile: false`, `fs.writeTextFile: false` and
 * `terminal: false` in the handshake. For a long time it backed that up by
 * simply *not implementing* the corresponding `Client` methods, on the theory
 * that an unimplemented optional method answers "method not found".
 *
 * It does not. The SDK's `legacyClientApp` registers a handler for
 * `fs/read_text_file`, `fs/write_text_file` and all five `terminal/*` methods
 * whether or not the client implements them, and calls the implementation with
 * `?.` — so an absent method produced `{"result":null}` or `{"result":{}}`, a
 * *success*. Nothing was actually read, written or spawned, so confidentiality
 * held; what broke is honesty and observability. An agent that ignores
 * `clientCapabilities` was told its write had landed and would go on to tell the
 * user about a file that does not exist, and the attempt appeared in no log.
 *
 * None of that is visible from inside `AcpManager`: the answer is produced by
 * the SDK's dispatcher and only exists on the wire. So this file drives a real
 * child process (`probe-agent.mjs`) that asks for everything and writes down the
 * raw JSON-RPC answers.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { asChatId, type ChatDelta, type NotifyMessage } from '@peek/core'
import { AcpManager } from '../manager'
import { claudeCodeProfile } from '../profiles'
import {
  DEFAULT_ACP_TIMEOUTS,
  DEFAULT_DELTA_BUDGET,
  DEFAULT_RESTART_POLICY,
  type AcpEventMap,
  type ChatAgentStatePatch,
} from '../types'

const PROBE_AGENT = fileURLToPath(new URL('./probe-agent.mjs', import.meta.url))
const dirs: string[] = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  delete process.env['PROBE_LOG']
})

const JSONRPC_METHOD_NOT_FOUND = -32601

/** One line of `probe-agent.mjs`'s log: the raw answer to one request. */
interface ProbeAnswer {
  probe: string
  code: number | null
  hasError: boolean
  result: unknown
  timedOut: boolean
}

interface ProbeRun {
  answers: ProbeAnswer[]
  /** `clientCapabilities` exactly as it arrived on the wire. */
  clientCapabilities: unknown
  logs: AcpEventMap['log'][]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run one turn against the probe agent and return everything it recorded.
 *
 * The turn itself is uninteresting — it exists only because `session/prompt` is
 * when the agent starts asking. Spawning a child process is expensive enough
 * that every test in this file shares one run; nothing here mutates the result.
 */
async function runProbes(): Promise<ProbeRun> {
  const dir = mkdtempSync(join(tmpdir(), 'peek-acp-probe-'))
  dirs.push(dir)
  const logFile = join(dir, 'probes.jsonl')
  process.env['PROBE_LOG'] = logFile

  const logs: AcpEventMap['log'][] = []
  const patches: ChatAgentStatePatch[] = []
  const deltas: ChatDelta[] = []
  const notifications: NotifyMessage[] = []
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
      resolveMcpEndpoint: () => null,
    },
    {
      resolveCwd: () => dir,
      profile: claudeCodeProfile,
      agentConfig: {},
      agentEntryPath: PROBE_AGENT,
      permissionMode: () => 'default',
      timeouts: DEFAULT_ACP_TIMEOUTS,
      batch: DEFAULT_DELTA_BUDGET,
      restart: DEFAULT_RESTART_POLICY,
      verbose: false,
    },
  )
  manager.events.on('log', (event) => {
    logs.push(event)
  })

  try {
    await manager.send({ chatId: asChatId('chat_probe'), text: 'go', attachments: [] })
    // The agent walks its probe list one request at a time and every answer is
    // immediate, so this is generous rather than tight.
    await sleep(3_000)
  } finally {
    await manager.dispose()
  }

  const lines = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)

  const answers = lines.filter(
    (e): e is ProbeAnswer & Record<string, unknown> => typeof e['probe'] === 'string',
  )
  const handshake = lines.find((e) => e['got'] === 'initialize')
  return {
    answers: answers.map((a) => ({
      probe: a.probe,
      code: a.code,
      hasError: a.hasError,
      result: a.result,
      timedOut: a.timedOut,
    })),
    clientCapabilities: handshake?.['clientCapabilities'],
    logs,
  }
}

/**
 * Every optional `Client` method the SDK wires up unconditionally. This list is
 * the one that matters: it is exactly the set for which "not implemented" was
 * silently answering success.
 */
const MUST_REFUSE = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
] as const

let run: ProbeRun

before(async () => {
  run = await runProbes()
  assert.ok(run.answers.length > 0, 'the probe agent recorded nothing; it never reached session/prompt')
})

test('every capability declared false answers an error, not a result', () => {
  for (const method of MUST_REFUSE) {
    const answer = run.answers.find((a) => a.probe === method)
    assert.ok(answer, `the probe agent never asked for ${method}`)
    assert.equal(answer.timedOut, false, `${method} was never answered at all`)
    // The regression this file exists for: `{"result":null}` / `{"result":{}}`.
    // A result of any shape means peek said yes to something it promised to
    // refuse, which is worse than saying no — the agent then reports work that
    // never happened.
    assert.equal(
      answer.hasError,
      true,
      `${method} answered a success (${JSON.stringify(answer.result)}); ` +
        'a capability declared false must answer an error',
    )
    assert.equal(
      answer.code,
      JSONRPC_METHOD_NOT_FOUND,
      `${method} must answer -32601, the same refusal an unknown method gets`,
    )
  }
})

test('an unknown method and an undeclared optional one refuse the same way', () => {
  // The baseline. If this ever stopped being -32601 the assertions above would
  // be measuring the SDK's mood rather than peek's boundary.
  const unknown = run.answers.find((a) => a.probe === 'client/unknown_method')
  assert.ok(unknown, 'the control probe is missing')
  assert.equal(unknown.code, JSONRPC_METHOD_NOT_FOUND)

  // `elicitation/create` is the one optional method the SDK registers *only*
  // when the client implements it, so peek refuses it for free — and that is
  // exactly why it must stay off the client object. It is the control that shows
  // the difference between "the SDK routes this" and "the SDK does not".
  const elicitation = run.answers.find((a) => a.probe === 'elicitation/create')
  assert.ok(elicitation, 'the elicitation probe is missing')
  assert.equal(elicitation.code, JSONRPC_METHOD_NOT_FOUND)
})

test('a refused call is logged, because a silent refusal is unobservable', () => {
  const warnings = run.logs.filter((e) => e.level === 'warn').map((e) => e.message)
  for (const method of MUST_REFUSE) {
    assert.ok(
      warnings.some((m) => m.includes(method)),
      `${method} was refused without a warning; the whole point is that somebody can see it. ` +
        `Warnings seen: ${warnings.join(' | ')}`,
    )
  }
})

test('peek still declares the capabilities it refuses', () => {
  // The two halves have to agree. Refusing every terminal method while
  // declaring `terminal: true` would be a different bug with the same symptom,
  // and this file would not notice.
  assert.deepEqual(run.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  })
})
