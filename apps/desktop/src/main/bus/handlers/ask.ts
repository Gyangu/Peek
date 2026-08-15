/**
 * `chat.ask` and `chat.answer` — the agent asking, and the person answering.
 *
 * ## Both are `read` handlers, and neither writes the Workspace
 *
 * That looks wrong at first for a pair whose whole job is to put a prompt on
 * screen and take it away again. The write happens — through
 * `QuestionBroker.onActive` → `ChatEventSink.onQuestionActive`, which is the
 * event path `pendingPermission` already travels. `chat-host.ts` argues the
 * general case: a broker reporting *what is on screen now* is stating a fact,
 * not requesting a change, and peek routes those straight into the store rather
 * than through the bus.
 *
 * The alternative — `chat.answer` reducing the field away itself — would give
 * one fact two writers. With a queue, "the answered one goes" and "the next one
 * appears" are a single event, and only the broker knows there is a next one.
 *
 * ## One of them suspends
 *
 * `chat.ask` does not resolve until a person answers, the question times out, or
 * something cancels it. This is the only command in peek that waits on a human,
 * and it is safe for a reason that does not generalise: what it suspends is the
 * agent's own tool call. The bus does not serialise across commands, so
 * everything else — the user's clicks, their queries, another conversation —
 * runs while it hangs. See `docs/design/2026-08-15-agent-asks-a-question.md` §2.3.
 */

import type { ChatAnswerResult, ChatAskResult, ChatViewState, Workspace } from '@peek/core'
import type { QuestionBroker } from '../../agent/questions'
import { failMsg } from '../failure'
import type { CommandHandlerMap } from '../types'

/** Five minutes, the same budget `permissionMs` gives a person to read and decide. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 300_000

export interface AskHandlerOptions {
  broker: QuestionBroker
  timeoutMs?: number
}

export function createAskHandlers(options: AskHandlerOptions) {
  const { broker, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS } = options

  return {
    'chat.ask': {
      async read(state, input): Promise<ChatAskResult> {
        const view = requireChat(state, input.viewId)

        // Rejected before anything is shown: two options carrying one id would
        // make an answer ambiguous, and the ambiguity would only surface at the
        // moment somebody clicked.
        const ids = new Set(input.options.map((option) => option.optionId))
        if (ids.size !== input.options.length) {
          failMsg('BAD_REQUEST', 'error.chat.askDuplicateOption')
        }

        const ticket = broker.open({
          chatId: view.chatId,
          question: input.question,
          ...(input.header === undefined ? {} : { header: input.header }),
          options: input.options.map((option) => ({
            optionId: option.optionId,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          multiSelect: input.multiSelect ?? false,
          timeoutMs,
        })

        const outcome = await ticket.outcome
        // Read after the wait, never before: the conversation moved on while this
        // was suspended, and a receipt reporting the status it had five minutes
        // ago would be describing a window nobody is looking at any more.
        const after = state.views[input.viewId]
        const base = {
          chatId: view.chatId,
          viewId: view.id,
          agentStatus: after !== undefined && after.kind === 'chat' ? after.agentStatus : view.agentStatus,
          requestId: ticket.pending.requestId,
        }

        if (outcome.kind === 'unanswered') {
          return {
            ...base,
            answered: false,
            selected: [],
            // 'view-gone' and 'turn-cancelled' both read as "cancelled" to the
            // caller: the distinction is about peek's bookkeeping, and what the
            // agent can act on is only whether an answer exists.
            reason: outcome.reason === 'timeout' ? 'timeout' : 'cancelled',
          }
        }

        // Labels are echoed with the ids so the agent does not have to hold its
        // own question in context to read the answer — the tool result stands
        // alone, which matters most for the model that has just spent five
        // minutes waiting.
        const byId = new Map(input.options.map((option) => [option.optionId, option.label]))
        return {
          ...base,
          answered: true,
          selected: outcome.optionIds.map((optionId) => ({
            optionId,
            label: byId.get(optionId) ?? optionId,
          })),
          ...(outcome.other === undefined ? {} : { other: outcome.other }),
        }
      },
    },

    'chat.answer': {
      read: (state, input, ctx): ChatAnswerResult => {
        /*
         * The third place `source` decides an outcome on this bus, and the one
         * with the shortest argument.
         *
         * `chat.respondPermission` refuses an agent because letting it approve
         * its own tool calls leaks an *authorisation*. Refusing it here prevents
         * something worse: an agent answering its own question manufactures a
         * **judgement**. The user is later shown a decision that reads as
         * theirs — "you said weekly" — when nobody ever looked at it, and every
         * step the model takes afterwards rests on an answer it wrote itself.
         *
         * Unconditional, not "only for a foreign viewId", for the reason §2.3 of
         * the source-scope design gives: every embedded panel shares one
         * credential, so "its own question" is not a question main can answer.
         *
         * An external operator (`source: 'mcp'`) may answer, as with a
         * permission prompt — a client holding the main token already has full
         * control of this window (PLAN §7).
         */
        if (ctx.source === 'agent') {
          failMsg('BAD_REQUEST', 'error.chat.answerNotAnswerableByAgent')
        }

        const view = requireChat(state, input.viewId)
        const pending = view.pendingQuestion
        if (!pending) failMsg('CONFLICT', 'error.chat.noPendingQuestion')

        // The stale-answer race, refused rather than resolved — the same guard
        // `chat.respondPermission` carries, and the same race: a turn can ask a
        // second question while the first is still being read.
        if (input.requestId !== undefined && input.requestId !== pending.requestId) {
          failMsg('CONFLICT', 'error.chat.questionStale', {
            requestId: input.requestId,
            actual: pending.requestId,
          })
        }

        // The broker re-checks everything (unknown id, several ids for a
        // single-select, an empty answer) and refuses rather than settling
        // wrongly. `false` here means the prompt is still standing.
        const accepted = broker.resolve(pending.requestId, input.optionIds, input.other)
        if (!accepted) {
          failMsg('BAD_REQUEST', 'error.chat.answerRejected', {
            options: pending.options.map((option) => option.optionId).join(', '),
          })
        }

        return {
          chatId: view.chatId,
          viewId: view.id,
          agentStatus: view.agentStatus,
          requestId: pending.requestId,
          answered: true,
        }
      },
    },
  } satisfies CommandHandlerMap
}

/**
 * The read-only twin of `requireChatView`, which takes an immer draft.
 *
 * Both of these handlers read the source of truth rather than a draft, because
 * neither reduces — see the header.
 */
function requireChat(state: Workspace, viewId: ChatViewState['id']): ChatViewState {
  const view = state.views[viewId]
  if (!view) failMsg('NOT_FOUND', 'error.view.notFound', { viewId })
  if (view.kind !== 'chat') {
    failMsg('BAD_REQUEST', 'error.chat.notChatView', { viewId, kind: view.kind })
  }
  return view
}

/**
 * The stand-in before a broker exists.
 *
 * `chat.ask` reports that nobody answered rather than hanging forever, which is
 * the honest answer for a process with no window to ask in — and, unlike a
 * throw, it is an outcome the agent already knows how to handle.
 */
export const unavailableAskHandlers = {
  'chat.ask': {
    read: (state, input): ChatAskResult => {
      const view = requireChat(state, input.viewId)
      return {
        chatId: view.chatId,
        viewId: view.id,
        agentStatus: view.agentStatus,
        requestId: '',
        answered: false,
        selected: [],
        reason: 'cancelled',
      }
    },
  },
  'chat.answer': {
    read: (state, input): ChatAnswerResult => {
      const view = requireChat(state, input.viewId)
      return {
        chatId: view.chatId,
        viewId: view.id,
        agentStatus: view.agentStatus,
        requestId: input.requestId ?? '',
        answered: false,
      }
    },
  },
} satisfies CommandHandlerMap
