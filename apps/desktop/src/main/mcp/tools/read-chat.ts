/**
 * read_chat — the state of the conversations open in this window.
 *
 * ## Why a tool of its own, when read_workspace already lists chat views
 *
 * `read_workspace` reports a chat the way it reports every view: one line of
 * `describe`, plus (since chat views arrived) a `chat` block. That is the right
 * amount for "what is on screen", and it is buried under every other view in the
 * window. A caller about to act on a conversation is asking a narrow question and
 * should not have to page through a layout tree to answer it.
 *
 * The one piece of information that is *only* obtainable here or from
 * `read_workspace`'s `chat` block is the permission options: their `optionId`
 * strings are not the same as their `kind`s (`allow` versus `allow_once`), so an
 * answer composed from the English description is rejected.
 *
 * ## What is deliberately absent: the messages
 *
 * There is no transcript here, and that is a contract rather than an omission. The
 * conversation body lives in main's `ChatId`-keyed transcript store and never
 * enters the Workspace, because a snapshot that echoed the whole conversation back
 * would feed a model its own output at increasing cost on every call (see
 * `core/chat.ts`). This tool reports the metadata the Workspace holds and stops
 * there. What was said is on the user's screen, which is the point of peek.
 */

import { z } from 'zod'
import { ViewIdSchema, type ChatViewSummary, type ViewSummary } from '@peek/core'
import { defineReadTool } from '../executor'
import { toJson } from '../summary'
import { panelPlacement } from '../ui-effects'

const InputSchema = z.object({
  viewId: ViewIdSchema.optional().describe(
    'Report only this conversation. Omitted means every conversation open in the window.',
  ),
})

interface ChatBrief {
  viewId: string
  title: string
  describe: string
  panelId: string | null
  /** Where that pane is, in words — "the right pane". */
  panelPlacement: string
  /** Whether a person can actually see this conversation, or it is behind another tab. */
  visible: boolean
  chat: ChatViewSummary
}

function briefLine(c: ChatBrief): string {
  const bits = [
    `${c.viewId} "${c.title}"`,
    `in ${c.panelPlacement}${c.visible ? '' : ' (behind another tab)'}`,
    `${c.chat.agentStatus}`,
    `${String(c.chat.messageCount)} message(s)`,
    `mode ${c.chat.permissionMode}`,
  ]
  if (c.chat.streaming) bits.push('a turn is running — send_chat would be refused')
  if (c.chat.attachments.length > 0) {
    bits.push(`${String(c.chat.attachments.length)} attachment(s) staged`)
  }
  const p = c.chat.pendingPermission
  if (p) {
    bits.push(
      `BLOCKED: waiting for a person to approve ${p.toolName} — ` +
        `answer with control_chat {action:"answer_permission", requestId:"${p.requestId}", optionId:"<one of ${p.options
          .map((o) => o.optionId)
          .join('|')}>"}`,
    )
  }
  return `- ${bits.join(' · ')}`
}

export default defineReadTool({
  kind: 'read',
  name: 'read_chat',
  title: 'Read the conversations',
  description:
    'Report the conversations (chat views) open in this peek window: which pane each sits in, ' +
    'whether it is visible, whether a turn is already running, what context is staged for the next ' +
    'turn, and whether it is blocked waiting for the user to approve a tool call. ' +
    'Call it before send_chat (a conversation already running a turn refuses another) and before ' +
    'control_chat with answer_permission (which needs an exact optionId, and those are not the same ' +
    'strings as the option kinds). ' +
    'It never returns the messages themselves — the conversation is on the user’s screen, not in this reply.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  read(input, ctx) {
    const snap = ctx.getSnapshot()
    const chats = snap.views.filter(
      (v: ViewSummary) =>
        v.kind === 'chat' && v.chat !== undefined && (input.viewId === undefined || v.id === input.viewId),
    )

    if (chats.length === 0) {
      return {
        text:
          input.viewId === undefined
            ? 'No conversation is open in this window. send_chat without a viewId opens one and sends ' +
              'the first turn in a single call; open_view with {"spec":{"kind":"chat"}} opens an empty one.'
            : `View ${String(input.viewId)} is not an open conversation. Open views are: ` +
              `${snap.views.map((v) => `${String(v.id)} (${v.kind})`).join(', ') || '(none)'}`,
        data: { chats: [] },
      }
    }

    const briefs: ChatBrief[] = chats.map((v) => ({
      viewId: String(v.id),
      title: v.title,
      describe: v.describe,
      panelId: v.panelId === null ? null : String(v.panelId),
      panelPlacement:
        v.panelId === null ? 'no pane (open but unplaced)' : panelPlacement(snap.layout, v.panelId),
      visible: v.visible,
      // Non-null by construction: the filter above kept only views carrying it.
      chat: v.chat as ChatViewSummary,
    }))

    return {
      text: `${String(briefs.length)} conversation(s):\n${briefs.map(briefLine).join('\n')}`,
      data: { chats: briefs },
    }
  },
})
