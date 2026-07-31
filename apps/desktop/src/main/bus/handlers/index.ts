import { connHandlers } from './conn'
import { layoutHandlers } from './layout'
import { queryHandlers } from './query'
import { stateHandlers } from './state'
import { viewHandlers } from './view'
import type { CommandHandlerMap } from '../types'

export { connHandlers } from './conn'
export { layoutHandlers } from './layout'
export { queryHandlers } from './query'
export { stateHandlers } from './state'
export { viewHandlers } from './view'
export * from './shared'

/**
 * Handlers for all 12 commands.
 * `satisfies Required<CommandHandlerMap>` makes a missing implementation a
 * compile error.
 */
export const coreHandlers = {
  ...connHandlers,
  ...viewHandlers,
  ...queryHandlers,
  ...layoutHandlers,
  ...stateHandlers,
} satisfies Required<CommandHandlerMap>
