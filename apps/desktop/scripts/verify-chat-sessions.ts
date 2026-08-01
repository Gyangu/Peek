/**
 * The session catalogue, against the **real** `claude-agent-acp`.
 *
 * ## Why this exists alongside `manager.test.ts`
 *
 * That suite drives a stub agent, which proves the protocol *shape*: that a
 * resume goes through `session/load`, that a replay reaches the transcript, that
 * closing a view sends nothing. What it cannot prove is what the real agent
 * actually does — and the difference was not academic. The stub replayed only an
 * `agent_message_chunk`, so it agreed with a translator that dropped every
 * `user_message_chunk`; the real agent replays both, and running this script is
 * how the resulting monologue was found. The stub now replays both too.
 *
 * The rule that follows: **a change to the ACP layer is not verified until this
 * has been run against the real agent.** The unit tests can only ever agree with
 * the fixture they were written beside.
 *
 * ## Usage
 *
 *     node --import ./src/main/bus/__tests__/ts-resolve.hooks.mjs scripts/verify-chat-sessions.ts
 *     … --session <id-prefix>    load a particular conversation instead of the newest
 *
 * **Costs no tokens.** `session/list` is a directory read and `session/load` is a
 * replay; no prompt is ever sent. It reads the user's real chat workdir
 * (`~/.peek/chat`) and does not write to it — no session is created or deleted.
 *
 * Deleting is deliberately **not** exercised here: the only conversations
 * available to delete would be the user's own. `manager.test.ts` covers that path
 * against the stub, where the transcript is disposable.
 *
 * Exit code 0 = every check passed.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { asChatId, type ChatDelta } from '@peek/core'
import { AcpManager } from '../src/main/acp/manager'
import {
  DEFAULT_ACP_TIMEOUTS,
  DEFAULT_DELTA_BUDGET,
  DEFAULT_RESTART_POLICY,
  type ChatAgentStatePatch,
} from '../src/main/acp/types'

const CHAT_WORKDIR = join(homedir(), '.peek', 'chat')

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
    notify: (message) => {
      console.log(`  [notify:${message.level}] ${message.message}`)
    },
    resolveMcpEndpoint: () => null,
  },
  {
    resolveCwd: () => CHAT_WORKDIR,
    permissionMode: 'default',
    timeouts: DEFAULT_ACP_TIMEOUTS,
    batch: DEFAULT_DELTA_BUDGET,
    restart: DEFAULT_RESTART_POLICY,
    verbose: false,
  },
)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  console.log(`\ncwd: ${CHAT_WORKDIR}\n`)

  console.log('1. The catalogue')
  const listed = await manager.listSessions()
  check('the real agent advertises session history', listed.supported)
  check('the catalogue is not empty', listed.sessions.length > 0, `${listed.sessions.length} conversations`)
  check('it is filtered to peek’s own chat workdir', listed.cwd === CHAT_WORKDIR, String(listed.cwd))
  check(
    'every row belongs to that workdir',
    listed.sessions.every((s) => s.cwd === CHAT_WORKDIR),
  )
  for (const s of listed.sessions.slice(0, 5)) {
    console.log(`      ${s.updatedAt ?? '—'}  ${s.sessionId.slice(0, 8)}  ${s.title ?? '(untitled)'}`)
  }
  if (listed.sessions.length > 5) console.log(`      … and ${listed.sessions.length - 5} more`)

  // `--session <prefix>` picks one by id prefix; otherwise the most recent.
  const wanted = process.argv[process.argv.indexOf('--session') + 1]
  const newest =
    process.argv.includes('--session')
      ? listed.sessions.find((s) => s.sessionId.startsWith(wanted ?? ''))
      : [...listed.sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
  if (!newest) throw new Error('no session to load; nothing further can be checked')

  console.log(`\n2. Loading ${newest.sessionId.slice(0, 8)} (${newest.title ?? 'untitled'})`)
  const chatId = asChatId('chat_verify')
  const startedAt = Date.now()
  await manager.openChat(chatId, newest.sessionId)
  await sleep(1500)

  const statuses = patches.map((p) => p.status).filter(Boolean)
  check('the panel reported `loading`, not `starting`', statuses.includes('loading'), statuses.join(' → '))
  check('and settled at `ready`', statuses.at(-1) === 'ready')

  const messageStarts = deltas.filter((d) => d.type === 'message.start').length
  const text = deltas
    .filter((d): d is Extract<ChatDelta, { type: 'text.append' }> => d.type === 'text.append')
    .map((d) => d.text)
    .join('')
  check('history was replayed into the transcript', messageStarts > 0, `${messageStarts} messages`)
  check('and it carries real text', text.length > 0, `${text.length} chars in ${Date.now() - startedAt}ms`)

  const roles = deltas
    .filter((d): d is Extract<ChatDelta, { type: 'message.start' }> => d.type === 'message.start')
    .map((d) => d.message.role)
  check('both sides of the conversation are present', new Set(roles).size === 2, roles.join(','))
  const opened = deltas.filter((d) => d.type === 'message.start').length
  const closed = deltas.filter((d) => d.type === 'message.end').length
  check('every replayed message was closed', opened === closed, `${opened} opened / ${closed} closed`)
  const tools = deltas.filter((d) => d.type === 'tool.upsert').length
  console.log(`      ${tools} tool call(s) replayed`)
  console.log(`\n  first 200 chars of the replay:\n  ${JSON.stringify(text.slice(0, 200))}`)

  console.log('\n3. Closing the view detaches, and leaves the conversation on disk')
  manager.closeChat(chatId)
  await sleep(300)
  const after = await manager.listSessions()
  check(
    'the conversation is still in the catalogue after its view closed',
    after.sessions.some((s) => s.sessionId === newest.sessionId),
  )
} catch (raw) {
  failures += 1
  console.error('\n  UNCAUGHT:', raw)
} finally {
  await manager.dispose()
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
