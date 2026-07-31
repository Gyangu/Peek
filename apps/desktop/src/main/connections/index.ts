/**
 * The Connection Manager (PLAN section 3, the process model).
 *
 * Usage (for whoever assembles main):
 *
 * ```ts
 * import { ConnectionManager } from './connections'
 *
 * const connections = new ConnectionManager()
 *
 * // 1) Bind the renderer once the window is ready — the data-plane port rides on this
 * win.webContents.on('did-finish-load', () => connections.attachRenderer(win.webContents))
 * win.on('closed', () => connections.detachRenderer())
 *
 * // 2) Wire the events into the Command Bus / notification layer
 * connections.events.on('status', ({ connId, status, error }) => bus.applyConnStatus(connId, status, error))
 * connections.events.on('result.schema', (e) => bus.fillResultSchema(e.resultId, e.schema))
 * connections.events.on('result.done', (e) => bus.finishResult(e.resultId, e.info))
 * connections.events.on('result.error', (e) => bus.failResult(e.resultId, e.error))
 * connections.events.on('crashed', (e) => notify('error', `driver crashed: ${e.error.message}`))
 *
 * // 3) Inject it into the Command Bus as the side-effect interface
 * const bus = createCommandBus({ connections })
 *
 * // 4) Reap everything before the app quits
 * app.on('before-quit', () => { void connections.disposeAll() })
 * ```
 */

export { ConnectionManager } from './manager'
export { DriverHostProcess } from './host-process'
export { DataPlaneLink } from './port-broker'
export { TypedEmitter } from './emitter'
export {
  DRIVER_REGISTRY,
  lookupDriver,
  registeredDriverIds,
  type DriverRegistration,
} from './registry'
export {
  DEFAULT_TIMEOUTS,
  classifyConnectError,
  classifyExecError,
  crashedError,
  notFoundConn,
  notReadyConn,
  timeoutError,
  unsupported,
  type Timeouts,
} from './classify'
export type {
  CancelOutcome,
  ConnectOptions,
  ConnectOutcome,
  ConnectionEffects,
  ConnectionEventMap,
  ConnectionManagerOptions,
  ConnectionRuntime,
  ResultDoneInfo,
  StartResultOutcome,
} from './types'
