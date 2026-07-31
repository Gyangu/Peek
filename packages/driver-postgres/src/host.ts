/**
 * driver host 进程入口（Electron utilityProcess 的 entry）。
 *
 * utilityProcess 是纯 node 环境（无 DOM、无 electron 渲染 API），
 * 与 main 的通道是 `process.parentPort`（MessagePortMain）。
 * 这里只做三件事：找到 parentPort、接上 DriverHost、把进程级异常转成 log 事件。
 *
 * 真正的协议实现全在 host-runtime.ts，那边不碰任何 electron 专有对象，
 * 所以可以在 node:test 里用普通 MessageChannel 完整跑通。
 */
import { createDriverHost, type HostChannelLike } from './host-runtime'

/** 从 process 上结构化地取出 parentPort，不用 any */
function getParentPort(): HostChannelLike | null {
  const candidate = (process as unknown as Record<string, unknown>)['parentPort']
  if (typeof candidate !== 'object' || candidate === null) return null
  const obj = candidate as Record<string, unknown>
  if (typeof obj['postMessage'] !== 'function' || typeof obj['on'] !== 'function') return null
  return candidate as unknown as HostChannelLike
}

let started = false

/**
 * 接上 parentPort 开始服务。幂等：
 * 模块被 import 时会自动调一次，entry 再显式调也不会重复注册。
 */
export function startDriverHost(): void {
  if (started) return
  started = true
  const parentPort = getParentPort()
  if (!parentPort) {
    throw new Error('driver host 必须运行在 Electron utilityProcess 里（缺少 process.parentPort）')
  }

  const host = createDriverHost(parentPort, {
    onShutdown: () => {
      // 让事件循环把最后一条响应发出去再退出
      setTimeout(() => process.exit(0), 0)
    },
  })

  process.on('uncaughtException', (err: Error) => {
    host.log('error', `driver host 未捕获异常: ${err.message}`, err.stack)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    host.log('error', `driver host 未处理的 Promise 拒绝: ${msg}`)
  })

  host.announceReady(process.pid)
}

// 作为 utilityProcess entry 被直接执行时自启动；被当模块 import 时不做任何事。
if (getParentPort() !== null) {
  startDriverHost()
}
