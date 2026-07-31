import { MessageChannelMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'
import { IPC, type ConnId, type ResultPortMessage } from '@peek/core'
import type { DriverHostProcess } from './host-process'

/**
 * 数据面直连（PLAN 第 3 节的性能关键路径）。
 *
 * ```
 * driver host ──MessagePort──► renderer      // chunk 数据，绝不经过 main
 *      ▲                                     // main 只做"端口移交"这一次动作
 *      └── main（控制面：connect / query.run / cancel）
 * ```
 *
 * 实现要点：
 * - `MessageChannelMain` 的两端都是 `MessagePortMain`：
 *   port1 通过 `utilityProcess.postMessage(msg, [port1])` 移交给 driver host，
 *   port2 通过 `webContents.postMessage(channel, msg, [port2])` 移交给 renderer，
 *   renderer 侧在 preload 里从 `event.ports[0]` 拿到标准 `MessagePort`。
 * - 移交之后 main 侧的引用即被 neuter，**不可能**再截获数据帧，
 *   这正是"避免大数据双跳序列化"的物理保证。
 * - renderer 可能还没起来（建连早于窗口 ready），port2 先寄存在这里；
 *   renderer 一旦 attach 就立刻交付。
 * - renderer 重新加载（刷新 / 热更）会让旧 port2 失效，此时必须**换一条新通道**，
 *   两端重新移交。
 */
export class DataPlaneLink {
  /** 已建好但还没交给 renderer 的那一端 */
  private pendingPort: MessagePortMain | null = null
  /** 是否已经交付过 renderer（交付过就说明 main 手里没有可用端口了） */
  private delivered = false
  private closed = false

  constructor(
    readonly connId: ConnId,
    private readonly host: DriverHostProcess,
  ) {}

  get isDelivered(): boolean {
    return this.delivered
  }

  /**
   * 新建一条通道并把 host 那一端立刻移交过去。
   * host 拿到端口就可以开始吐 chunk（renderer 还没接上时消息在端口里排队）。
   */
  open(): void {
    if (this.closed) return
    // 旧的没交出去就先丢掉，避免端口泄漏
    this.pendingPort?.close()
    this.pendingPort = null

    const { port1, port2 } = new MessageChannelMain()
    try {
      this.host.attachPort(port1)
    } catch (err) {
      port1.close()
      port2.close()
      throw err
    }
    this.pendingPort = port2
    this.delivered = false
  }

  /**
   * 把 renderer 那一端交付出去。
   * 已经交付过（renderer 重载）时会自动重开一条新通道再交付。
   * @returns 是否成功交付
   */
  deliver(wc: WebContents, pid?: number): boolean {
    if (this.closed) return false
    if (wc.isDestroyed()) return false

    if (this.pendingPort === null) {
      if (!this.delivered) return false
      // renderer 重载：旧端口已随旧文档销毁，换一条新的
      this.open()
    }
    const port = this.pendingPort
    if (port === null) return false

    const msg: ResultPortMessage = {
      connId: this.connId,
      ...(pid === undefined ? {} : { pid }),
    }
    wc.postMessage(IPC.RESULT_PORT, msg, [port])
    this.pendingPort = null
    this.delivered = true
    return true
  }

  /** 幂等释放 */
  close(): void {
    this.closed = true
    this.pendingPort?.close()
    this.pendingPort = null
  }
}
