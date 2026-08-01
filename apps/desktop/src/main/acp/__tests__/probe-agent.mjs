/*
 * An agent that ignores `clientCapabilities` and asks for everything anyway.
 *
 * `stub-agent.mjs` is a well-behaved agent, used to test the turn machinery.
 * This one exists for the opposite question: what does peek *answer* when an
 * agent asks for a capability the handshake declared false? That is not
 * observable from inside `AcpManager` — the answer is produced by the ACP SDK's
 * dispatcher and only exists on the wire — so the only way to assert on it is to
 * be the peer and read the raw JSON-RPC response.
 *
 * On `session/prompt` it fires one request per optional `Client` method, plus
 * two controls, and appends the raw answer of each to `PROBE_LOG` as one JSON
 * object per line:
 *
 *   { "probe": "fs/read_text_file", "code": -32601, "hasError": true, "result": … }
 *
 * `code` is null when the answer was a success, which is precisely the failure
 * this file was written to catch.
 *
 * Environment:
 *   PROBE_LOG   file to append the answers to (required, else it records nothing)
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.PROBE_LOG
if (LOG) writeFileSync(LOG, '')

const SESSION_ID = 'probe-session-1'

/** Timeout per probe. Long enough that a slow machine is not a false negative,
    short enough that a wedged client does not hang the whole test file. */
const PROBE_TIMEOUT_MS = 5_000

let nextId = 1_000
const pending = new Map()

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

function record(entry) {
  if (!LOG) return
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
  } catch {
    /* the test will notice a missing line */
  }
}

/** Send a request *to* the client and resolve with whatever comes back. */
function ask(method, params) {
  nextId += 1
  const id = nextId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => {
      if (pending.delete(id)) resolve({ timedOut: true })
    }, PROBE_TIMEOUT_MS).unref?.()
  })
}

/**
 * Everything the SDK's `legacyClientApp` wires up unconditionally, in the order
 * an agent would reach for it, followed by two controls:
 *
 *  - `elicitation/create` is registered by the SDK **only** when the client
 *    implements it, so it must refuse without peek doing anything;
 *  - `client/unknown_method` is the baseline: a method nobody has ever heard of,
 *    which is the shape a correct refusal has.
 */
const PROBES = [
  ['fs/read_text_file', { sessionId: SESSION_ID, path: '/etc/passwd' }],
  [
    'fs/write_text_file',
    { sessionId: SESSION_ID, path: '/tmp/peek-probe-should-not-exist.txt', content: 'owned' },
  ],
  ['terminal/create', { sessionId: SESSION_ID, command: 'sh', args: ['-c', 'id'] }],
  ['terminal/output', { sessionId: SESSION_ID, terminalId: 'probe-term-1' }],
  ['terminal/wait_for_exit', { sessionId: SESSION_ID, terminalId: 'probe-term-1' }],
  ['terminal/kill', { sessionId: SESSION_ID, terminalId: 'probe-term-1' }],
  ['terminal/release', { sessionId: SESSION_ID, terminalId: 'probe-term-1' }],
  ['elicitation/create', { sessionId: SESSION_ID, message: 'give me a secret' }],
  ['client/unknown_method', { sessionId: SESSION_ID }],
]

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // An answer to something this agent asked, not a request.
  if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id)
    pending.delete(msg.id)
    resolve({ error: msg.error, result: msg.result })
    return
  }

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentCapabilities: { promptCapabilities: { embeddedContext: true } },
        agentInfo: { name: 'probe-agent', version: '0.0.0' },
        authMethods: [],
      })
      record({ got: 'initialize', clientCapabilities: msg.params?.clientCapabilities })
      break

    case 'session/new':
      reply(msg.id, { sessionId: SESSION_ID })
      break

    case 'session/set_mode':
      reply(msg.id, {})
      break

    case 'session/prompt':
      void (async () => {
        for (const [method, params] of PROBES) {
          const answer = await ask(method, params)
          record({
            probe: method,
            code: answer.error?.code ?? null,
            hasError: answer.error !== undefined && answer.error !== null,
            result: answer.result ?? null,
            timedOut: answer.timedOut === true,
          })
        }
        reply(msg.id, { stopReason: 'end_turn' })
      })()
      break

    case 'session/cancel':
      break

    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
      }
  }
})
