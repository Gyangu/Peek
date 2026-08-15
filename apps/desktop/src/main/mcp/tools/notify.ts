/**
 * notify — reach the user when they are not looking at peek (maps onto app.notify).
 *
 * ## Why this tool exists
 *
 * The other thirteen tools all act on the window: they open views, run queries,
 * move panes, read state, drive the chat. Every one of them assumes someone is
 * watching. That assumption is exactly wrong in the case it matters most — an
 * agent working through something long, while the person who asked for it has
 * gone to do something else. peek's answer used to be to paint the result into a
 * panel and fall silent.
 *
 * This is the only tool whose subject is the person rather than the workspace,
 * and it is the only one peek cannot undo. That shapes the description below
 * more than anything else does: what a model most needs from it is not "how do I
 * call this" but **"when should I not"**.
 *
 * ## The description is the design
 *
 * peek does not decide when to notify — the model does, from prose. So the
 * description spends its length on the judgement rather than the mechanics: the
 * three shapes of "the user would want to know", the one shape that will get the
 * feature switched off, and the fact that a notification is an interruption of
 * whatever else that person is doing right now. A tool that notified on every
 * turn would be muted within a day, and a muted tool cannot deliver the one
 * message that mattered.
 */

import { z } from 'zod'
import { commandSchemas, ViewIdSchema } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = commandSchemas['app.notify'].safeExtend({
  message: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'One line, and the only line the user is guaranteed to read — a system banner shows the title ' +
        'and may cut everything else. Say what happened, not that something happened: ' +
        '"Backfill finished: 41,882 rows" rather than "Task complete".',
    ),
  detail: z
    .string()
    .max(2000)
    .optional()
    .describe('A second line with the part that does not fit above. Optional, and often unnecessary.'),
  level: z
    .enum(['info', 'warn', 'error'])
    .optional()
    .describe(
      'Colours the in-app toast; defaults to info. Use warn or error only when the user has to act — ' +
        'a red toast for good news costs you the one they should have looked at.',
    ),
  focusViewId: ViewIdSchema.optional().describe(
    'A view to bring forward when the user clicks the notification, as listed by read_workspace. ' +
      'Pass it when there is one obvious place to land — the pane holding what you are reporting on. ' +
      'Left out, the click just brings peek to the front.',
  ),
})

/* ================================================================== */
/* 2. Result shape                                                      */
/* ================================================================== */

const NotifyResultShape = z.object({
  system: z.boolean(),
  toast: z.boolean(),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'notify',
  title: 'Tell the user something',
  description:
    'Send the user a message that reaches them even when peek is not the window they are looking at. ' +
    'When peek is in the background this becomes a real system notification; when peek is in front it ' +
    'is an in-app toast instead, because a banner would cover the window they are already reading. ' +
    'Clicking the notification brings peek forward (and the view named by focusViewId, if you pass one). ' +
    'Use it when something the user was waiting for is done, when you have found something that needs ' +
    'a decision only they can make, or when you are handing control back after working for a while. ' +
    'Do NOT use it to acknowledge messages, to announce that you are starting, or once per reply — ' +
    'this interrupts whatever else that person is doing right now, and a tool that interrupts for ' +
    'everything gets switched off, taking the one message that mattered with it. ' +
    'If in doubt, say it in the conversation instead: they will read it when they come back. ' +
    'The result reports where the message actually went, so you can tell "they were elsewhere and have ' +
    'been called" from "they were looking at peek and have already seen it".',
  // Not read-only: it changes the user's attention, which is the one thing here
  // peek cannot roll back. Not idempotent either — sending it twice interrupts
  // twice, and a model that believed otherwise would retry.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: InputSchema,
  toCommands(input) {
    return [{ name: 'app.notify', input }]
  },
  render(outcomes, input) {
    const parsed = NotifyResultShape.safeParse(outcomeData(outcomes, 'app.notify'))
    if (!parsed.success) {
      return { text: `app.notify ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const { system, toast } = parsed.data
    // Each branch says what the user's state was, not just what peek did with the
    // message — that is the half a model can act on. In particular "delivered
    // nowhere" is reported as a settled preference, so nobody retries it.
    const text = system
      ? `Notified: "${input.message}" was raised as a system notification, because peek was not the ` +
        'window in front. Clicking it brings peek forward. A toast is also waiting in the app.'
      : toast
        ? `Shown in the app: "${input.message}". The user is looking at peek right now, so no system ` +
          'notification was raised — they can already see it. Nothing further is needed.'
        : `Not delivered: "${input.message}" reached neither a banner nor the app. System notifications ` +
          "are switched off in this user's settings and no window was available. Say it in the " +
          'conversation instead; do not retry.'
    return { text, data: parsed.data }
  },
})
