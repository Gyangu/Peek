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
  classifyConnectError,
  classifyExecError,
  crashedError,
  notFoundConn,
  notReadyConn,
  timeoutError,
  unsupported,
} from './classify'
/**
 * The timeout budget, and the read/write surface a settings UI needs.
 *
 * Assembly note for whoever owns main/index.ts and the settings layer: peek's
 * timeouts are **not** constructor arguments any more. Persisted settings are
 * applied by calling `setTimeoutSettings(patch)` once at startup (and again on
 * every edit); `getTimeoutSettings()` is what a settings form should render.
 * Nothing has to be threaded through `new ConnectionManager(...)`.
 */
export {
  DEFAULT_EXECUTION_TIMEOUTS,
  DEFAULT_TIMEOUTS,
  clearConnectionTimeouts,
  getConnectionTimeouts,
  getTimeoutSettings,
  resetTimeoutSettings,
  resolveExecutionTimeout,
  setConnectionTimeouts,
  setTimeoutSettings,
  subscribeTimeoutSettings,
  type ExecutionKind,
  type ExecutionTimeouts,
  type TimeoutSettings,
  type Timeouts,
} from './timeouts'
export { ResultDeadlines, type DeadlineTimerApi } from './deadline'
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
