import { unavailableConfigHandlers } from '../../config/handlers'
import { createChatHandlers, createUnavailableChatRuntime } from './chat'
import { connHandlers } from './conn'
import { layoutHandlers } from './layout'
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
export { connHandlers } from './conn'
export { layoutHandlers } from './layout'
export { queryHandlers } from './query'
export { stateHandlers } from './state'
export { viewHandlers } from './view'
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
 */
export const coreHandlers = {
  ...connHandlers,
  ...viewHandlers,
  ...queryHandlers,
  ...layoutHandlers,
  ...createChatHandlers(createUnavailableChatRuntime()),
  ...unavailableConfigHandlers,
  ...stateHandlers,
} satisfies Required<CommandHandlerMap>
