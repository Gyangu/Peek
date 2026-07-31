/**
 * driver host 进程入口（Electron utilityProcess 的 entry，PLAN 第 3 节）。
 *
 * 一个连接 = 一个 utilityProcess = 一条数据面 MessagePort：
 * 查询卡死或驱动崩溃只影响这一条连接，主窗口毫发无伤；杀进程即强制取消。
 *
 * 这里刻意只做一件事——把驱动实现装进 host runtime。
 * 控制面协议（HostInbound / HostOutbound）与数据面打帧全在驱动包的 host-runtime.ts 里，
 * 那边不 import electron，所以可以脱离 Electron 单测。
 *
 * 加驱动（M3 redis / M4 qdrant / M5 mysql·sqlite）：
 * 打包产物只有这一个 driver-host.js（见 electron.vite.config.ts 的 main.rollupOptions.input），
 * 由 host runtime 按 `connect` 参数里的 config.driverId 分发，所以在这里多 import 一个驱动包即可，
 * main 侧只需在 connections/registry.ts 里加一行。
 */
import { startDriverHost } from '@peek/driver-postgres'

// 驱动包在检测到 process.parentPort 时会自启动，这里再显式调一次（幂等），
// 避免将来 tree-shaking 把"仅副作用"的 import 优化掉。
startDriverHost()
