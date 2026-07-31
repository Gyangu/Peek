import { CommandBus, type CommandBusOptions } from './command-bus'
import { coreHandlers } from './handlers'

export * from './types'
export * from './ids'
export * from './intents'
export * from './deps'
export * from './failure'
export * from './layout-ops'
export * from './command-log'
export * from './command-bus'
export * from './effects'
export { coreHandlers } from './handlers'

// 注意：ipc-main.ts **不**在这里导出 —— 它引用 electron 的类型，
// 单测（node:test）里不需要也不该把 Electron 拖进来，请按需单独 import。

/**
 * 装配一条已经注册好全部 12 条命令的 Command Bus。
 * main/index.ts 只需要提供 store 和真实的副作用依赖。
 */
export function createCommandBus(options: CommandBusOptions): CommandBus {
  const bus = new CommandBus(options)
  bus.registerAll(coreHandlers)
  return bus
}
