import type { WebContents } from 'electron'
import type { ConnId } from '@peek/core'
import type { DataPlaneLink as RealDataPlaneLink } from '../port-broker'
import type { DriverHostProcess } from './stub-host-process'

/**
 * The data-plane half of the electron stubs.
 *
 * `port-broker` reaches `MessageChannelMain`, which does not exist outside
 * Electron, so importing `manager.ts` in `node:test` fails on this module alone.
 * Nothing here needs to work: the suites that use it are about the control
 * plane, and a result chunk never passes through main in the first place.
 *
 * Design record: docs/design/2026-08-02-connection-manager-stubs.md
 */

/** Everything `manager.ts` touches on a link — three members. */
export interface LinkSurface {
  open(): void
  deliver(wc: WebContents, pid?: number): boolean
  close(): void
}

export class DataPlaneLink implements LinkSurface {
  readonly connId: ConnId

  constructor(connId: ConnId, _host: DriverHostProcess) {
    this.connId = connId
  }

  open(): void {}

  /** False: no renderer is attached, which is the honest answer in a test process. */
  deliver(_wc: WebContents, _pid?: number): boolean {
    return false
  }

  close(): void {}
}

/** See the note on the same assertion in stub-host-process.ts. */
const _realConformsToSurface: LinkSurface = null as unknown as RealDataPlaneLink
void _realConformsToSurface
