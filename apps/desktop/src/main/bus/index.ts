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

// Note: ipc-main.ts is deliberately **not** re-exported here — it references
// Electron types, and the unit tests (node:test) neither need nor want Electron
// dragged in. Import it directly where it is actually required.

/**
 * Assemble a Command Bus with all 12 commands already registered.
 * main/index.ts only has to supply the store and the real side-effect deps.
 */
export function createCommandBus(options: CommandBusOptions): CommandBus {
  const bus = new CommandBus(options)
  bus.registerAll(coreHandlers)
  return bus
}
