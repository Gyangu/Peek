/**
 * send_chat — put a turn into a conversation inside this peek window
 * (maps onto `chat.send`, opening the conversation first when there is none).
 *
 * ## What this is for
 *
 * peek's chat panel is an ordinary view driven by ordinary Commands, so it is
 * reachable from MCP like the layout is. The interesting consequence is a
 * hand-off: an agent outside peek can hand a task to the assistant *inside* it —
 * the one that is already looking at the user's window and can rearrange it — and
 * the human watching sees the whole exchange arrive in a panel rather than being
 * told about it afterwards.
 *
 * ## The reply is not in the receipt, and cannot be
 *
 * This tool returns as soon as the turn has been accepted. It does **not** wait
 * for the assistant to answer, for two reasons and the second one is decisive:
 *
 * 1. a turn takes as long as it takes, and a tool call that blocks for minutes is
 *    a tool call that times out somewhere else;
 * 2. the assistant answers by calling back into *this* MCP server. A caller that
 *    blocked here while holding the request open would be waiting on a reply that
 *    is waiting on it. The transcript deliberately does not live in the Workspace
 *    either (see `core/chat.ts`), so there is no cheap read-back to offer instead.
 *
 * The answer appears on the user's screen. `read_chat` reports when the turn has
 * finished; what it said is for the person watching.
 */

import { z } from 'zod'
import {
  ChatAttachmentSpecSchema,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_PROMPT_CHARS,
  PanelIdSchema,
  ViewIdSchema,
  type ViewOpenResult,
  type ViewId,
} from '@peek/core'
import { defineCommandTool, dispatchCommand, outcomeData } from '../executor'
import { toolFail } from '../layout-check'
import { toJson } from '../summary'
import { panelPlacement } from '../ui-effects'

const InputSchema = z.object({
  viewId: ViewIdSchema.optional().describe(
    'The conversation to send into, as read_chat / read_workspace report it. ' +
      'Omitted opens a new conversation and sends this as its first turn.',
  ),
  text: z
    .string()
    .min(1)
    .max(MAX_CHAT_PROMPT_CHARS)
    .describe('The message. Written to the conversation as a user turn, exactly as given.'),
  attachments: z
    .array(ChatAttachmentSpecSchema)
    .max(MAX_CHAT_ATTACHMENTS)
    .optional()
    .describe(
      'Context to hand over with this turn: selected rows, a whole result, one cell, a table schema, ' +
        'the statement in a query view, or the layout itself ({"kind":"workspace"}). ' +
        'These are references, resolved to live data at the moment the turn is sent — so attaching ' +
        '"the result of this query" and then re-running the query hands over the new rows, not the old.',
    ),
  panelId: PanelIdSchema.optional().describe(
    'Which pane a newly opened conversation lands in. Ignored when viewId is given.',
  ),
  title: z.string().min(1).max(120).optional().describe('Tab title for a newly opened conversation.'),
})

/**
 * The fields of `ChatSendResult` this receipt reads back, re-declared as a schema
 * rather than asserted — the same pattern the layout tools use. Branded ids arrive
 * over the bus as plain strings, and parsing is what makes reading them safe
 * without a cast.
 */
const SendResultShape = z.object({
  viewId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  agentStatus: z.string(),
  attachments: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })),
})

export default defineCommandTool({
  kind: 'command',
  name: 'send_chat',
  title: 'Message the assistant in the window',
  description:
    'Send a message to a conversation panel inside this peek window. Without a viewId it opens a new ' +
    'conversation and sends this as its first turn; with one it continues that conversation. ' +
    'The assistant on the other end drives the same UI you do, so this is the way to hand it a task ' +
    '("open the orders table beside this query and tell me what changed") rather than doing it yourself. ' +
    'The reply is NOT returned here — it streams into the panel on the user’s screen. This call returns ' +
    'once the turn has been accepted. ' +
    'A conversation that is already running a turn refuses with CONFLICT; call read_chat first if unsure. ' +
    'If you are the assistant embedded in this window, that refusal is what you will get for your own ' +
    'conversation, by construction — you are inside its turn.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async toCommands(input, ctx) {
    if (input.viewId !== undefined) {
      const snap = ctx.getSnapshot()
      const view = snap.views.find((v) => v.id === input.viewId)
      if (view === undefined || view.kind !== 'chat') {
        const chats = snap.views.filter((v) => v.kind === 'chat').map((v) => String(v.id))
        toolFail(
          view === undefined ? 'NOT_FOUND' : 'BAD_REQUEST',
          `send_chat: ${String(input.viewId)} is not an open conversation. ` +
            `Conversations in this window: ${chats.join(', ') || '(none) — omit viewId to open one'}`,
        )
      }
      return [
        {
          name: 'chat.send',
          input: {
            viewId: input.viewId,
            text: input.text,
            ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          },
        },
      ]
    }

    /*
     * Opening is dispatched here rather than returned as a first Command because
     * `chat.send` needs the view id that `view.open` mints, and the executor
     * builds its whole command list before dispatching any of it. Doing it inside
     * `toCommands` is why that hook is async and receives `ctx`.
     *
     * The window diff the executor reports is taken *before* this runs, so the new
     * conversation still shows up in "What changed on screen" — the receipt does
     * not lose the panel that appeared.
     */
    const opened = await dispatchCommand(ctx, {
      name: 'view.open',
      input: {
        spec: {
          kind: 'chat',
          ...(input.title === undefined ? {} : { title: input.title }),
        },
        ...(input.panelId === undefined ? {} : { panelId: input.panelId }),
      },
    })
    if (!opened.ok) {
      toolFail(
        opened.error.code,
        `send_chat could not open a conversation: ${opened.error.message}`,
        opened.error.detail,
      )
    }
    const viewId = (opened.data as ViewOpenResult).viewId as ViewId
    return [
      {
        name: 'chat.send',
        input: {
          viewId,
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        },
      },
    ]
  },
  render(outcomes, _input, ctx) {
    const parsed = SendResultShape.safeParse(outcomeData(outcomes, 'chat.send'))
    if (!parsed.success) {
      return { text: `chat.send ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const sent = parsed.data
    const snap = ctx.getSnapshot()
    const view = snap.views.find((v) => String(v.id) === sent.viewId)
    const place =
      view === undefined || view.panelId === null ? 'a pane' : panelPlacement(snap.layout, view.panelId)
    const attached =
      sent.attachments.length === 0
        ? 'no attachments'
        : `${String(sent.attachments.length)} attachment(s): ${sent.attachments.map((a) => a.label).join(', ')}`

    return {
      text:
        `Sent to conversation ${sent.viewId} in ${place} (message ${sent.messageId}, ${attached}).\n` +
        `The conversation is now "${sent.agentStatus}". The reply streams into that panel on the user's ` +
        'screen and is not returned here; read_chat reports when the turn has finished.',
      data: sent,
    }
  },
})
