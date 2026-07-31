/**
 * 连接管理器（PLAN 第 3 节进程模型）。
 *
 * 用法（集成 agent 在 main 里）：
 *
 * ```ts
 * import { ConnectionManager } from './connections'
 *
 * const connections = new ConnectionManager()
 *
 * // 1) 窗口就绪后绑定 renderer——数据面端口靠它移交
 * win.webContents.on('did-finish-load', () => connections.attachRenderer(win.webContents))
 * win.on('closed', () => connections.detachRenderer())
 *
 * // 2) 事件接进 Command Bus / 通知层
 * connections.events.on('status', ({ connId, status, error }) => bus.applyConnStatus(connId, status, error))
 * connections.events.on('result.schema', (e) => bus.fillResultSchema(e.resultId, e.schema))
 * connections.events.on('result.done', (e) => bus.finishResult(e.resultId, e.info))
 * connections.events.on('result.error', (e) => bus.failResult(e.resultId, e.error))
 * connections.events.on('crashed', (e) => notify('error', `driver 崩溃：${e.error.message}`))
 *
 * // 3) 作为副作用接口注入 Command Bus
 * const bus = createCommandBus({ connections })
 *
 * // 4) app 退出前收干净
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
