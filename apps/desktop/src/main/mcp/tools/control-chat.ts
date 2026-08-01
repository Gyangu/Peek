/**
 * control_chat — stop, empty, unblock or re-gate a conversation
 * (maps onto `chat.cancel` / `chat.clear` / `chat.respondPermission` /
 * `chat.setMode` / `chat.detach`).
 *
 * ## One tool, five verbs
 *
 * Five tools would have been the house style — `activate_view` exists precisely
 * because "show that tab" deserved its own name. These five do not, and the
 * difference is that they are all the *same* gesture applied to one conversation:
 * they take no arguments beyond which conversation and which choice, they never
 * combine, and a model choosing between them is choosing a word, not a shape. Five
 * near-identical schemas would cost five descriptions to read before the first
 * call.
 *
 * ## answer_permission is the one that matters
 *
 * When the assistant in the panel wants to call a tool, the conversation stops and
 * asks the person. That prompt is in the Workspace (small, modal, and the single
 * most important fact about the window while it is up) precisely so that a reader
 * of `read_workspace` — human or otherwise — can see the window is waiting on a
 * decision rather than being merely slow.
 *
 * This tool can answer it, and mostly should not. Answering on the user's behalf a
 * question that was asked *of* the user defeats the reason the prompt exists. It
 * is here for the operator case: a person driving peek through an editor, who is
 * as much "the user" as the one at the window. The description says so, and
 * `chat.setMode` refuses outright to hand a non-`ui` caller a mode that removes
 * the prompt altogether.
 */

import { z } from 'zod'
import {
  ChatPermissionModeSchema,
  ViewIdSchema,
  type ChatViewSummary,
  type Command,
  type ViewSummary,
} from '@peek/core'
import { defineCommandTool } from '../executor'
import { toolFail } from '../layout-check'
import { toJson } from '../summary'

const InputSchema = z.object({
  viewId: ViewIdSchema.describe('The conversation, as read_chat / read_workspace report it.'),
  action: z
    .enum(['stop', 'clear', 'answer_permission', 'set_mode', 'clear_attachments'])
    .describe(
      'stop — end the turn in flight (a no-op, not an error, when nothing is running). ' +
        'clear — empty the conversation and start over, stopping any turn on the way. ' +
        'answer_permission — approve or refuse the tool call the conversation is blocked on. ' +
        'set_mode — change how tool calls are gated. ' +
        'clear_attachments — unstage everything pinned for the next turn.',
    ),
  optionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'answer_permission only. One of pendingPermission.options[].optionId, exactly — note these are ' +
        'NOT the option "kind" values ("allow", not "allow_once"). Omit it to be shown the choices ' +
        'instead of answering.',
    ),
  requestId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'answer_permission only, and strongly recommended: the request you believe you are answering. ' +
        'With it, an answer that arrives after that prompt has been replaced by a different one is ' +
        'refused instead of silently approving whatever is being asked now.',
    ),
  mode: ChatPermissionModeSchema.optional().describe(
    'set_mode only. "default" asks a person about every tool call and is what peek starts in. ' +
      '"auto" lets the agent\'s own classifier decide. "plan" makes it propose rather than act. ' +
      '"dontAsk" and "bypassPermissions" remove the human gate and are refused for any caller that ' +
      'is not the person at the keyboard.',
  ),
})

type Input = z.infer<typeof InputSchema>

/** The conversation, or a failure that names the ones that do exist. */
function requireChat(
  views: readonly ViewSummary[],
  viewId: Input['viewId'],
): { view: ViewSummary; chat: ChatViewSummary } {
  const view = views.find((v) => v.id === viewId)
  if (view === undefined || view.kind !== 'chat' || view.chat === undefined) {
    const chats = views.filter((v) => v.kind === 'chat').map((v) => String(v.id))
    toolFail(
      view === undefined ? 'NOT_FOUND' : 'BAD_REQUEST',
      `control_chat: ${String(viewId)} is not an open conversation. ` +
        `Conversations in this window: ${chats.join(', ') || '(none)'}`,
    )
  }
  return { view, chat: view.chat }
}

export default defineCommandTool({
  kind: 'command',
  name: 'control_chat',
  title: 'Control a conversation',
  description:
    'Act on a conversation panel in this peek window without sending a message: stop the turn it is ' +
    'running, empty it, answer the permission prompt it is blocked on, change how its tool calls are ' +
    'gated, or unstage the context pinned to its next turn. ' +
    'read_chat reports which of these a given conversation currently needs. ' +
    'Answering a permission prompt is for an operator driving peek from outside; if a person is sitting ' +
    'at the window, the prompt is already in front of them and is theirs to answer.',
  inputSchema: InputSchema,
  // Destructive: `clear` throws away a conversation, and answering a permission
  // prompt authorises whatever it was gating. Not idempotent for the same reason —
  // a second `answer_permission` answers a different question.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  toCommands(input, ctx): Command[] {
    const snap = ctx.getSnapshot()
    const { chat } = requireChat(snap.views, input.viewId)

    switch (input.action) {
      case 'stop':
        return [{ name: 'chat.cancel', input: { viewId: input.viewId } }]

      case 'clear':
        return [{ name: 'chat.clear', input: { viewId: input.viewId } }]

      case 'clear_attachments':
        // No `attachmentIds` means "everything staged" — see `chat.detach`.
        return [{ name: 'chat.detach', input: { viewId: input.viewId } }]

      case 'set_mode':
        if (input.mode === undefined) {
          toolFail('BAD_REQUEST', 'control_chat set_mode needs a mode. The conversation is currently in ' +
            `"${chat.permissionMode}".`)
        }
        return [{ name: 'chat.setMode', input: { viewId: input.viewId, mode: input.mode } }]

      case 'answer_permission': {
        const pending = chat.pendingPermission
        if (pending === undefined) {
          toolFail(
            'CONFLICT',
            `control_chat: conversation ${String(input.viewId)} is not waiting for a permission decision ` +
              `(it is "${chat.agentStatus}"). Nothing to answer.`,
          )
        }
        // Listing the choices rather than guessing one: the option ids are
        // agent-assigned strings, and an invented one is rejected by the agent
        // after a round trip the user watches happen.
        if (input.optionId === undefined) {
          toolFail(
            'BAD_REQUEST',
            `control_chat answer_permission needs an optionId. ${pending.toolName} is waiting; ` +
              `the choices are: ${pending.options.map((o) => `${o.optionId} (${o.name})`).join(', ')}. ` +
              `Pass requestId "${pending.requestId}" alongside it.`,
            toJson(pending),
          )
        }
        return [
          {
            name: 'chat.respondPermission',
            input: {
              viewId: input.viewId,
              optionId: input.optionId,
              // Defaulted from what was read a moment ago rather than left out: an
              // unqualified answer is the one that can approve the wrong question.
              requestId: input.requestId ?? pending.requestId,
            },
          },
        ]
      }
    }
  },
})
