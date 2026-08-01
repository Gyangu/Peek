/*
 * A minimal ACP agent, for testing the host without a model or a network.
 *
 * Speaks just enough of the protocol for `AcpManager` to reach a live session:
 * `initialize`, `session/new`, `session/set_mode`, `session/prompt`,
 * `session/cancel`. A prompt streams one chunk and then sits there until it is
 * cancelled or the configured delay elapses, which is what lets a test drive the
 * turn's timing precisely.
 *
 * Configured entirely through the environment, because it is spawned by the code
 * under test and there is nowhere else to put knobs:
 *   STUB_NEW_SESSION_DELAY_MS  wait this long before answering `session/new`
 *                              (the window a stop press has to survive)
 *   STUB_PROMPT_MS             how long a turn runs before ending on its own
 *   STUB_ASK_PERMISSION        ask the client to approve a tool call, and block
 *                              on the answer — sending nothing meanwhile, which
 *                              is exactly what makes a waiting human look idle
 *   STUB_LOG                   append one line per received method to this file,
 *                              so a test can assert on what the agent was asked
 *   STUB_CHATTER_MS            while blocked on a permission answer, emit a
 *                              session update this often — what the real agent
 *                              does, and what must not reset the idle watchdog
 *   STUB_DIE_AFTER_MS          hard-exit this long after start-up, standing in
 *                              for an agent that crashes. Only the *first* child
 *                              does it (`STUB_DIE_ONCE_FILE` is the token), so
 *                              the host's restart can be observed settling
 *                              instead of looping forever
 *   STUB_DIE_ONCE_FILE         path used as the "already crashed once" token
 *   STUB_DIE_ON_PROMPT_MS      hard-exit this long after `session/prompt` is
 *                              received, so the crash lands with a request
 *                              genuinely in flight instead of wherever a
 *                              start-up timer happened to fall. Honours
 *                              `STUB_DIE_ONCE_FILE` the same way
 *   STUB_TALK_MS               emit a session update this often for the whole
 *                              turn — an agent that is never silent, which is
 *                              the one thing `promptIdleMs` cannot catch and
 *                              the only way to reach `promptMaxMs`. Distinct
 *                              from STUB_CHATTER_MS, which is one late update
 *                              behind a permission dialog
 *   STUB_SILENT                accept `session/prompt` and then send **nothing**
 *                              — no chunk, no tool call, no usage update. What
 *                              an agent looks like while it retries an
 *                              unreachable model endpoint, and the only thing
 *                              the idle watchdog can be tested against
 *   STUB_NO_HISTORY            do not advertise `loadSession` or any of
 *                              `sessionCapabilities` — an ACP agent that keeps
 *                              no transcripts. The degraded path the session
 *                              catalogue has to render as a sentence rather
 *                              than as an empty list
 *   STUB_SESSIONS              comma-separated ids `session/list` reports, each
 *                              with a title derived from the id. Empty (the
 *                              default) is a catalogue with nothing in it
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NEW_SESSION_DELAY = Number(process.env.STUB_NEW_SESSION_DELAY_MS ?? '0')
const PROMPT_MS = Number(process.env.STUB_PROMPT_MS ?? '400')
const LOG = process.env.STUB_LOG
const SILENT = process.env.STUB_SILENT === '1'
const NO_HISTORY = process.env.STUB_NO_HISTORY === '1'
const SESSIONS = (process.env.STUB_SESSIONS ?? '').split(',').filter(Boolean)

const DIE_AFTER = Number(process.env.STUB_DIE_AFTER_MS ?? '0')
const DIE_ON_PROMPT = Number(process.env.STUB_DIE_ON_PROMPT_MS ?? '0')
const DIE_ONCE_FILE = process.env.STUB_DIE_ONCE_FILE

/** Exit without a word. Not a thrown error: the point is a process simply gone. */
function dieLater(ms) {
  if (ms <= 0) return
  if (DIE_ONCE_FILE && existsSync(DIE_ONCE_FILE)) return
  setTimeout(() => {
    if (DIE_ONCE_FILE) {
      try {
        writeFileSync(DIE_ONCE_FILE, 'crashed')
      } catch {
        /* the test will notice a second crash */
      }
    }
    process.exit(9)
  }, ms).unref?.()
}

dieLater(DIE_AFTER)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

function record(method, params) {
  if (!LOG) return
  try {
    appendFileSync(LOG, `${JSON.stringify({ method, params })}\n`)
  } catch {
    /* the test will notice a missing line */
  }
}

let sessionCounter = 0
let nextRequestId = 1_000
const inflight = new Map()
const clientReplies = new Map()

/** Send a request *to* the client and wait for its answer. */
function ask(method, params) {
  const id = ++nextRequestId
  return new Promise((resolve) => {
    clientReplies.set(id, resolve)
    write({ jsonrpc: '2.0', id, method, params })
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  void handle(msg)
})

async function handle(msg) {
  const { id, method, params } = msg
  // An answer to something the stub asked, not a request.
  if (method === undefined && id !== undefined && clientReplies.has(id)) {
    clientReplies.get(id)(msg.result ?? msg.error)
    clientReplies.delete(id)
    return
  }
  record(method, params)

  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          promptCapabilities: { image: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          // Both halves together, as the real adapter advertises them: a
          // catalogue you cannot open is not a catalogue, and the host checks
          // for exactly that pair.
          ...(NO_HISTORY ? {} : { loadSession: true, sessionCapabilities: { list: {}, delete: {} } }),
        },
        agentInfo: { name: 'stub-agent', title: 'Stub', version: '0.0.0' },
        authMethods: [],
      },
    })
    return
  }

  if (method === 'session/new') {
    if (NEW_SESSION_DELAY > 0) await sleep(NEW_SESSION_DELAY)
    const sessionId = `stub-session-${++sessionCounter}`
    write({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        modes: {
          currentModeId: 'auto',
          availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'default', name: 'Manual' }],
        },
      },
    })
    return
  }

  if (method === 'session/load') {
    // The ordering the real adapter has: replay the history **while the request
    // is still open**, then answer. A client that only registers the session id
    // from the response would have nowhere to put any of these.
    //
    // The user's own turn is replayed too, because the real agent replays it —
    // a stored conversation contains both halves and the client is the only
    // thing that can tell a replayed echo from a live one.
    for (const [sessionUpdate, text] of [
      ['user_message_chunk', 'what did I ask?'],
      ['agent_message_chunk', 'replayed history'],
    ]) {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate, content: { type: 'text', text } } },
      })
    }
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'session/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        sessions: SESSIONS.map((sessionId) => ({
          sessionId,
          cwd: params?.cwd ?? '/nowhere',
          title: `title of ${sessionId}`,
          updatedAt: '2026-08-01T12:00:00.000Z',
        })),
      },
    })
    return
  }

  if (method === 'session/delete') {
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'session/set_mode') {
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId
    dieLater(DIE_ON_PROMPT)
    // STUB_SILENT holds the request open and puts nothing on the wire, which is
    // what a real agent retrying an unreachable model endpoint looks like from
    // the client side. Everything below it would break the silence.
    if (!SILENT) {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stub reply' } },
        },
      })
    }

    if (!SILENT && process.env.STUB_ASK_PERMISSION === '1') {
      const toolCallId = `stub-tool-${sessionId}`
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'mcp__peek__read_workspace',
            kind: 'other',
            status: 'pending',
            content: [],
            rawInput: {},
          },
        },
      })
      // What goes on the wire just *after* the request is the whole question.
      //
      // With STUB_CHATTER_MS unset the stub is silent from here, which is the
      // simple case and the one the sibling test covers. The real agent is not
      // silent: a `tool_call_update` (and `usage_update`) lands moments after it
      // asks, and then it goes quiet for as long as the human takes. One late
      // notification is enough — it re-arms the idle watchdog that
      // `#onRequestPermission` had just disarmed, and the fresh full-length timer
      // then expires against a person reading a dialog. Measured in the running
      // app: "The reply did not finish within 90000 ms", dialog still on screen.
      const chatter = Number(process.env.STUB_CHATTER_MS ?? '0')
      const chatterTimer = chatter > 0
        ? setTimeout(() => {
          write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1234, size: 1_000_000 } },
          })
        }, chatter)
        : null
      const outcome = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId, title: 'mcp__peek__read_workspace', kind: 'other', content: [], rawInput: {} },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      })
      if (chatterTimer) clearTimeout(chatterTimer)
      record('permission/answered', outcome)
    }

    // A turn that never goes quiet. Every one of these resets the client's idle
    // watchdog, which is the point: only an absolute ceiling can end this turn.
    const talk = Number(process.env.STUB_TALK_MS ?? '0')
    const talkTimer =
      !SILENT && talk > 0
        ? setInterval(() => {
          write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1234, size: 1_000_000 } },
          })
        }, talk)
        : null

    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('end_turn'), PROMPT_MS)
      inflight.set(sessionId, () => {
        clearTimeout(timer)
        resolve('cancelled')
      })
    })
    const stopReason = await done
    if (talkTimer) clearInterval(talkTimer)
    inflight.delete(sessionId)
    write({ jsonrpc: '2.0', id, result: { stopReason } })
    return
  }

  if (method === 'session/cancel') {
    inflight.get(params.sessionId)?.()
    return
  }

  if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `stub: ${String(method)}` } })
  }
}
