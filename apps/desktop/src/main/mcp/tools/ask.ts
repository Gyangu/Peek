/**
 * ask — put a question to the user and wait for the answer (maps onto chat.ask).
 *
 * ## The one tool that stops
 *
 * Every other tool in `tools/` returns as soon as peek has done the thing. This
 * one returns when **a person has read something and clicked**, or when five
 * minutes have passed and nobody did. That is the whole feature: an agent at a
 * fork in the road can now find out which way to go instead of guessing, and it
 * can do so *inside the turn it is already in* rather than by ending its turn
 * with a question and starting a fresh one over the reply.
 *
 * For an agent running outside peek — a Claude Code in a terminal — it is the
 * only way to reach the person sitting in front of the window at all.
 *
 * ## Why the description spends its length on restraint
 *
 * peek does not decide when to ask; the model does, from prose. And the failure
 * mode here is worse than `notify`'s: a notification that was not worth sending
 * costs a glance, while a question that was not worth asking **stops the work**
 * and makes the person answer for it. So the description's job is to name the
 * two shapes that deserve an interruption, and the several that do not.
 */

import { z } from 'zod'
import { commandSchemas, ViewIdSchema, type ViewId, type ViewOpenResult } from '@peek/core'
import { defineCommandTool, dispatchCommand, outcomeData } from '../executor'
import { toolFail } from '../layout-check'
import { toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = commandSchemas['chat.ask'].omit({ viewId: true }).extend({
  question: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'The question, as one line. Ask about the decision, not about your progress: ' +
        '"Aggregate by day or by week?" rather than "Shall I continue?"',
    ),
  header: z
    .string()
    .min(1)
    .max(24)
    .optional()
    .describe('A 3–12 character category chip shown beside the question, e.g. "Aggregation".'),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1).max(64).describe('Your own id for this answer; it comes back verbatim.'),
        label: z.string().min(1).max(120).describe('What the button says. A few words.'),
        description: z
          .string()
          .max(400)
          .optional()
          .describe('What this choice means or costs — the part that makes the choice decidable.'),
      }),
    )
    .min(2)
    .max(4)
    .describe(
      'Two to four answers. peek always adds an "Other" box of its own, so you never have to ' +
        'include an escape hatch — and should not pretend your list is exhaustive when it is not.',
    ),
  multiSelect: z
    .boolean()
    .optional()
    .describe('Let the user choose more than one. Defaults to single choice.'),
  viewId: ViewIdSchema.optional().describe(
    'Which conversation to ask in. Omit it and a conversation is opened for the question — which ' +
      'is what an external client with no chat panel open wants.',
  ),
})

/* ================================================================== */
/* 2. Result shape                                                      */
/* ================================================================== */

const AskResultShape = z.object({
  viewId: z.string(),
  requestId: z.string(),
  answered: z.boolean(),
  selected: z.array(z.object({ optionId: z.string(), label: z.string() })),
  other: z.string().optional(),
  reason: z.enum(['timeout', 'cancelled']).optional(),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'ask',
  title: 'Ask the user a question',
  description:
    'Put a question to the user with two to four answers and WAIT for their reply. ' +
    'The question appears in a chat panel; peek always adds an "Other" box so they can answer in ' +
    'their own words. The reply comes back to you as this tool result, so you keep working in the ' +
    'same turn instead of ending it with a question. ' +
    'Ask when you are at a fork where both ways are defensible and choosing wrong means redoing the ' +
    'work, or when only the user can know the answer ("which of these is the production database?"). ' +
    'Do NOT ask what you can find out yourself — read_workspace and introspect are right there. ' +
    'Do NOT ask for permission to start, do NOT confirm out of politeness, and do NOT break one ' +
    'decision into a string of small questions: each one stops the work and makes a person pay ' +
    'attention. ' +
    'This call blocks until somebody answers or five minutes pass; an unanswered question comes back ' +
    'with answered=false, and the right response to that is to pick a reasonable default, say which ' +
    'one you picked and why, and carry on — not to ask again. ' +
    'If you are unsure whether something is worth asking, it is usually better to choose, act, and ' +
    'state the assumption you made.',
  // Not read-only: it puts a prompt in the window and takes over a person's
  // attention. Not idempotent: asking twice interrupts twice. openWorld because
  // the answer comes from outside peek entirely.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: InputSchema,
  async toCommands(input, ctx) {
    if (input.viewId !== undefined) {
      const snap = ctx.getSnapshot()
      const view = snap.views.find((v) => v.id === input.viewId)
      if (view === undefined || view.kind !== 'chat') {
        const chats = snap.views.filter((v) => v.kind === 'chat').map((v) => String(v.id))
        toolFail(
          view === undefined ? 'NOT_FOUND' : 'BAD_REQUEST',
          `ask: ${String(input.viewId)} is not an open conversation. ` +
            `Conversations in this window: ${chats.join(', ') || '(none) — omit viewId to open one'}`,
        )
      }
      return [{ name: 'chat.ask', input: { ...input, viewId: input.viewId } }]
    }

    // Dispatched here rather than returned as a first command, for the reason
    // `send_chat` gives at the same point: `chat.ask` needs the view id that
    // `view.open` mints, and the executor builds its whole command list before
    // dispatching any of it.
    const opened = await dispatchCommand(ctx, {
      name: 'view.open',
      input: { spec: { kind: 'chat' } },
    })
    if (!opened.ok) {
      toolFail(
        opened.error.code,
        `ask could not open a conversation: ${opened.error.message}`,
        opened.error.detail,
      )
    }
    const viewId = (opened.data as ViewOpenResult).viewId as ViewId
    return [{ name: 'chat.ask', input: { ...input, viewId } }]
  },
  render(outcomes) {
    const parsed = AskResultShape.safeParse(outcomeData(outcomes, 'chat.ask'))
    if (!parsed.success) {
      return { text: `chat.ask ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const result = parsed.data

    if (!result.answered) {
      // Says what to do next, because the failure mode this guards against is a
      // model that re-asks — which interrupts a person who has already shown
      // they are not there.
      const why =
        result.reason === 'timeout'
          ? 'Nobody answered within five minutes.'
          : 'The question was cancelled before it could be answered.'
      return {
        text:
          `${why} Do not ask it again. Choose the option you would have recommended, say plainly ` +
          'which one you chose and why, and continue — or stop and explain what you need if no ' +
          'choice is defensible without them.',
        data: result,
      }
    }

    const chosen = result.selected.map((s) => `"${s.label}" (${s.optionId})`).join(', ')
    const parts: string[] = []
    if (chosen !== '') parts.push(`The user chose ${chosen}.`)
    if (result.other !== undefined) {
      parts.push(
        result.selected.length === 0
          ? `The user did not pick any of your options and answered in their own words: "${result.other}"`
          : `They also wrote: "${result.other}"`,
      )
    }
    return { text: parts.join(' '), data: result }
  },
})
