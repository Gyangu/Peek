import { MessageChannelMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'
import { IPC, type ConnId, type ResultPortMessage } from '@peek/core'
import type { DriverHostProcess } from './host-process'

/**
 * The direct data-plane link (PLAN section 3's performance-critical path).
 *
 * ```
 * driver host ──MessagePort──► renderer      // chunk data; never passes through main
 *      ▲                                     // main only ever performs the handover
 *      └── main (control plane: connect / query.run / cancel)
 * ```
 *
 * Implementation notes:
 * - Both ends of a `MessageChannelMain` are `MessagePortMain`s: port1 goes to the
 *   driver host via `utilityProcess.postMessage(msg, [port1])`, port2 goes to the
 *   renderer via `webContents.postMessage(channel, msg, [port2])`, and preload
 *   picks up a standard `MessagePort` from `event.ports[0]` on the renderer side.
 * - Once transferred, main's reference is neutered, so main **cannot** intercept
 *   a data frame even in principle. That is the physical guarantee behind
 *   "no double serialization hop for large data".
 * - The renderer may not exist yet (a connection can open before the window is
 *   ready), so port2 is parked here and delivered the moment the renderer attaches.
 * - A renderer reload (refresh / HMR) invalidates the old port2, at which point a
 *   **brand new channel** must be opened and both ends handed over again.
 */
export class DataPlaneLink {
  /** The end that has been created but not yet given to the renderer */
  private pendingPort: MessagePortMain | null = null
  /** Whether it has already been delivered (if so, main no longer holds a usable port) */
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
   * Open a new channel and hand the host end over immediately.
   * With the port in hand the host can start emitting chunks; while the renderer
   * is not attached yet, messages simply queue up in the port.
   */
  open(): void {
    if (this.closed) return
    // Drop any undelivered port first, so none leaks
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
   * Deliver the renderer end.
   * If it was already delivered (a renderer reload), a fresh channel is opened
   * automatically and that one is delivered instead.
   * @returns whether delivery succeeded
   */
  deliver(wc: WebContents, pid?: number): boolean {
    if (this.closed) return false
    if (wc.isDestroyed()) return false

    if (this.pendingPort === null) {
      if (!this.delivered) return false
      // Renderer reload: the old port died with the old document, so make a new one
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

  /** Idempotent release */
  close(): void {
    this.closed = true
    this.pendingPort?.close()
    this.pendingPort = null
  }
}
