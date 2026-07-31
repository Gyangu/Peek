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
 * 全部 12 条命令的 handler。
 * `satisfies Required<CommandHandlerMap>` 保证漏实现一条就编译不过。
 */
export const coreHandlers = {
  ...connHandlers,
  ...viewHandlers,
  ...queryHandlers,
  ...layoutHandlers,
  ...stateHandlers,
} satisfies Required<CommandHandlerMap>
