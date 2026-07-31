/**
 * Driver host process entry (the entry point of an Electron utilityProcess).
 *
 * utilityProcess is a plain node environment (no DOM, no electron renderer APIs),
 * and its channel to main is `process.parentPort` (a MessagePortMain). This file
 * does exactly three things: find parentPort, wire up a DriverHost, and turn
 * process-level exceptions into log events.
 *
 * The protocol itself lives entirely in host-runtime.ts, which touches no
 * electron-specific object and can therefore be exercised end to end in
 * node:test with an ordinary MessageChannel.
 */
import { createDriverHost, type HostChannelLike } from './host-runtime'

/** Pull parentPort off `process` structurally, without reaching for `any` */
function getParentPort(): HostChannelLike | null {
  const candidate = (process as unknown as Record<string, unknown>)['parentPort']
  if (typeof candidate !== 'object' || candidate === null) return null
  const obj = candidate as Record<string, unknown>
  if (typeof obj['postMessage'] !== 'function' || typeof obj['on'] !== 'function') return null
  return candidate as unknown as HostChannelLike
}

let started = false

/**
 * Attach to parentPort and start serving. Idempotent: importing this module
 * already calls it once, so an entry file calling it explicitly registers nothing
 * twice.
 */
export function startDriverHost(): void {
  if (started) return
  started = true
  const parentPort = getParentPort()
  if (!parentPort) {
    throw new Error('The driver host must run inside an Electron utilityProcess (process.parentPort is missing)')
  }

  const host = createDriverHost(parentPort, {
    onShutdown: () => {
      // Let the event loop flush the final response before exiting
      setTimeout(() => process.exit(0), 0)
    },
  })

  process.on('uncaughtException', (err: Error) => {
    host.log('error', `Uncaught exception in the driver host: ${err.message}`, err.stack)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    host.log('error', `Unhandled promise rejection in the driver host: ${msg}`)
  })

  host.announceReady(process.pid)
}

// Self-starts when executed directly as a utilityProcess entry; importing it as a
// module does nothing.
if (getParentPort() !== null) {
  startDriverHost()
}
