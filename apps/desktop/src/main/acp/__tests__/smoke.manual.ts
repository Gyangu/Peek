/**
 * Manual end-to-end check of the ACP host against a **real** agent.
 *
 * Not part of `pnpm test` — the filename deliberately does not match
 * `*.test.ts`, because this spawns a child process, talks to the network and
 * spends real tokens against whatever Claude Code login exists on the machine.
 * It is here rather than in a scratch directory because it is the only thing
 * that exercises `manager.ts` end to end, and because the numbers it prints
 * (deltas per batch) are the evidence for the coalescing budget.
 *
 * Run from `apps/desktop`:
 *
 * ```
 * node --import ./src/main/bus/__tests__/ts-resolve.hooks.mjs \
 *      src/main/acp/__tests__/smoke.manual.ts
 * ```
 *
 * What a pass looks like: a `ready` line naming the agent, a user message
 * accepted, `agent` message start, streamed text, `message.end end_turn`, and a
 * deltas-per-batch ratio above 1 (proof that coalescing did something).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asChatId, type AttachmentId, type ChatDelta } from '@peek/core'
import { AcpManager, defaultAcpConfig } from '../manager'
import type { ChatAgentStatePatch, McpEndpointInfo } from '../types'

const CHAT = asChatId('chat_smoke')

/** Read the live endpoint if a peek instance is running; null is a valid answer. */
function endpoint(): McpEndpointInfo | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(homedir(), '.peek', 'mcp.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const url = (raw as Record<string, unknown>)['url']
    const token = (raw as Record<string, unknown>)['token']
    if (typeof url !== 'string' || typeof token !== 'string') return null
    return { url, token }
  } catch {
    return null
  }
}

const states: ChatAgentStatePatch[] = []
let batches = 0
let deltaCount = 0
let text = ''

const manager = new AcpManager(
  {
    applyState: async (patch: ChatAgentStatePatch) => {
      states.push(patch)
      const { chatId: _chatId, ...rest } = patch
      console.log('[state]', JSON.stringify(rest))
      // Stand in for the user clicking a button, so the permission path is
      // exercised rather than timing out. AUTO=reject flips the answer.
      const pending = patch.pendingPermission
      if (pending) {
        const wanted = process.env['SMOKE_ANSWER'] === 'reject' ? 'reject_once' : 'allow_once'
        const option = pending.options.find((o) => o.kind === wanted) ?? pending.options[0]
        if (option) {
          console.log('[permission]', pending.toolName, '→', option.optionId)
          setTimeout(() => {
            console.log('[permission] accepted =', manager.respondPermission(pending.requestId, option.optionId))
          }, 10)
        }
      }
    },
    emitDeltas: (_chatId, batch: readonly ChatDelta[]) => {
      batches += 1
      deltaCount += batch.length
      for (const delta of batch) {
        if (delta.type === 'text.append') text += delta.text
        else if (delta.type === 'tool.upsert') console.log('[tool]', delta.call.title, delta.call.status)
        else if (delta.type === 'message.start') console.log('[msg.start]', delta.message.role)
        else if (delta.type === 'message.end') console.log('[msg.end]', delta.stopReason)
      }
    },
    notify: (message) => {
      console.log('[notify]', message.level, message.message, message.detail ?? '')
    },
    resolveMcpEndpoint: endpoint,
  },
  defaultAcpConfig(),
)

manager.events.on('ready', (event) => {
  console.log('[ready]', event.agentName, event.agentVersion, 'pid', event.pid)
})
manager.events.on('exit', (event) => {
  console.log('[exit]', JSON.stringify(event))
})

async function main(): Promise<void> {
  console.log('[mcp]', endpoint() ? 'endpoint found — the loop is closed' : 'no endpoint — chat only')

  const prompt =
    process.argv[2] ?? 'Which city in the attached table has the highest revenue? Answer in one short sentence.'
  const { messageId } = await manager.send({
    chatId: CHAT,
    text: prompt,
    attachments: [
      {
        attachmentId: 'att_demo' as AttachmentId,
        uri: 'peek://result/res_demo/rows',
        mimeType: 'text/markdown',
        text: '| city | revenue |\n|---|---|\n| Osaka | 4120 |\n| Lisbon | 9987 |\n',
      },
    ],
  })
  console.log('[accepted]', messageId)

  // SMOKE_KILL=1 exercises the crash path: SIGKILL the agent mid-turn and watch
  // the streaming message close as interrupted, the state go to error, and the
  // restart policy bring a new process up.
  if (process.env['SMOKE_KILL'] === '1') {
    setTimeout(() => {
      const pid = manager.pid
      console.log('[kill] SIGKILL', pid)
      if (pid) process.kill(pid, 'SIGKILL')
    }, 4_000)
  }

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const last = states[states.length - 1]
    if (last && (last.status === 'ready' || last.status === 'error')) break
  }

  console.log('--- result ---')
  console.log('batches:', batches, 'deltas:', deltaCount)
  console.log('deltas per batch:', (deltaCount / Math.max(batches, 1)).toFixed(2))
  console.log('text:', JSON.stringify(text.slice(0, 400)))

  await manager.dispose()
  console.log('--- disposed ---')
}

void main().then(
  () => {
    process.exit(0)
  },
  (error: unknown) => {
    console.error('SMOKE FAILED', error)
    process.exit(1)
  },
)
