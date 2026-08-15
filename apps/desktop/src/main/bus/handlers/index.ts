import { unavailableConfigHandlers } from '../../config/handlers'
import { unavailablePackageHandlers } from '../../packages/commands'
import { createAppHandlers, unavailableAppHandlers } from './app'
import { createAskHandlers, unavailableAskHandlers } from './ask'
import { createChatHandlers, createUnavailableChatRuntime } from './chat'
import { connHandlers } from './conn'
import { layoutHandlers } from './layout'
import { unavailableLogHandlers } from './log'
import { queryHandlers } from './query'
import { stateHandlers } from './state'
import { viewHandlers } from './view'
import type { CommandHandlerMap } from '../types'

export {
  buildChatViewState,
  createChatEventSink,
  createChatHandlers,
  createUnavailableChatRuntime,
  findChatView,
  isChatView,
  listChatViews,
  requireChatView,
  stageChatAttachments,
  watchChatViews,
  type ChatEffect,
  type ChatEventSink,
  type ChatRuntime,
  type ChatTurnEnd,
} from './chat'
export { createAppHandlers, unavailableAppHandlers } from './app'
export { createAskHandlers, unavailableAskHandlers, DEFAULT_QUESTION_TIMEOUT_MS, type AskHandlerOptions } from './ask'
export { connHandlers } from './conn'
export { layoutHandlers } from './layout'
export { createLogHandlers, unavailableLogHandlers, type LogHandlerOptions } from './log'
export { queryHandlers } from './query'
export { stateHandlers } from './state'
export {
  createUnavailablePackageViews,
  createViewHandlers,
  viewHandlers,
  type PackageViewQuestion,
  type PackageViewSource,
  type ViewHandlerMap,
} from './view'
export * from './shared'

/**
 * Handlers for every command.
 * `satisfies Required<CommandHandlerMap>` makes a missing implementation a
 * compile error.
 *
 * The `chat.*` entries are built against `createUnavailableChatRuntime`, the exact
 * analogue of `createUnavailableDeps`: the pure state machine works — a
 * conversation opens, attachments stage, a send is accepted and refuses a second
 * one — while nothing reaches an agent. main replaces them during assembly with
 * `bus.registerAll(createChatHandlers(acpRuntime))`, which overwrites these
 * entries by name.
 *
 * `unavailableConfigHandlers` is there for the same reason and is replaced the
 * same way, by `bus.registerAll(createConfigHandlers({ book, mcp }))` — until
 * then the connection book reads as empty and the MCP endpoint as not listening,
 * both of which are true of a process that has assembled neither.
 * `unavailablePackageHandlers` is the third of the same kind,
 * `unavailableAppHandlers` the fourth (before a window exists there is nothing
 * to notify anyone through, and `app.notify` says so in its result rather than
 * failing), and `unavailableLogHandlers` the fifth — a bus with no logging
 * system attached reads as an empty log, which is what it is.
 */
export const coreHandlers = {
  ...connHandlers,
  ...viewHandlers,
  ...queryHandlers,
  ...layoutHandlers,
  ...createChatHandlers(createUnavailableChatRuntime()),
  ...unavailableConfigHandlers,
  ...unavailablePackageHandlers,
  ...stateHandlers,
  ...unavailableLogHandlers,
  ...unavailableAppHandlers,
  ...unavailableAskHandlers,
} satisfies Required<CommandHandlerMap>
