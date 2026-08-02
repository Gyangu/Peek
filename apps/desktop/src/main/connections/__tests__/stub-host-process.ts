import type { Capability, ConnId, HostMethod, HostParams, HostResult, ResultId } from '@peek/core'
import type { DriverHostProcess as RealDriverHostProcess, HostProcessHooks, SpawnOptions } from '../host-process'

/**
 * A driver host that never leaves the test process.
 *
 * `ConnectionManager` reaches Electron only through this module and
 * `port-broker`, so replacing the two is what makes the shipping manager
 * loadable under `node --test`. Everything else about it stays real.
 *
 * This used to be a JavaScript source string injected by a `load` hook, which
 * meant `tsc` saw a block of text. The consequence was not hypothetical: a stub
 * whose `call()` returned whatever it liked would keep agreeing with a
 * `HostRpcMap` that had moved on, and the suite would stay green while
 * production read `undefined`. PLAN §9.1 records this repo losing a day to
 * exactly that shape — a stub self-consistent with the code it was standing in
 * for.
 *
 * Design record: docs/design/2026-08-02-connection-manager-stubs.md
 */

/**
 * Everything `manager.ts` touches on a driver host — seven members, counted
 * rather than guessed.
 *
 * Declared here rather than in production code on purpose (see the design
 * record §3). Both the stub and the real class are asserted against it below, so
 * a signature that drifts breaks the build instead of the illusion.
 */
export interface HostSurface {
  readonly alive: boolean
  readonly pid: number | undefined
  spawn(opts: SpawnOptions): Promise<void>
  call<M extends HostMethod>(method: M, params: HostParams<M>, timeoutMs?: number): Promise<HostResult<M>>
  forceKill(): boolean
  waitExit(ms: number): Promise<boolean>
  shutdown(opts: { disconnectMs: number; shutdownMs: number; exitMs: number }): Promise<void>
}

/** What a stubbed connection answers `connect` with. Set before `manager.connect()`. */
export interface StubHostConfig {
  capabilities: readonly Capability[]
}

const config: StubHostConfig = { capabilities: [] }

/** What each stubbed host was asked to do, keyed by connection. */
export interface StubHostRecord {
  forceKills: number
  cancelCalls: ResultId[]
}

const records = new Map<string, StubHostRecord>()

export const stubHost = {
  /** Replaces the `globalThis.__peekStubCaps` channel the string stub had to use. */
  configure(next: StubHostConfig): void {
    config.capabilities = [...next.capabilities]
    records.clear()
  },
  recordOf(connId: ConnId): StubHostRecord | undefined {
    return records.get(String(connId))
  },
}

export class DriverHostProcess implements HostSurface {
  readonly connId: ConnId
  readonly hooks: HostProcessHooks
  alive = true
  pid: number | undefined = 4242

  constructor(connId: ConnId, hooks: HostProcessHooks) {
    this.connId = connId
    this.hooks = hooks
    records.set(String(connId), { forceKills: 0, cancelCalls: [] })
  }

  async spawn(_opts: SpawnOptions): Promise<void> {}

  /**
   * Typed against `HostRpcMap`, which is the whole point of this file: a result
   * shape that no longer matches the contract is a compile error here rather
   * than a green test.
   */
  async call<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    switch (method) {
      case 'connect': {
        const result: HostResult<'connect'> = {
          capabilities: [...config.capabilities],
          serverInfo: { version: 'stub', flavor: 'stub' },
        }
        return result as HostResult<M>
      }
      case 'collection.scan':
      case 'query.run':
      case 'vector.search': {
        const { resultId } = params as HostParams<'collection.scan'>
        const result: HostResult<'collection.scan'> = { resultId }
        return result as HostResult<M>
      }
      case 'cancel': {
        const { resultId } = params as HostParams<'cancel'>
        this.record().cancelCalls.push(resultId)
        const result: HostResult<'cancel'> = { cancelled: true }
        return result as HostResult<M>
      }
      case 'disconnect':
      case 'shutdown': {
        const result: HostResult<'shutdown'> = { closed: true }
        return result as HostResult<M>
      }
      case 'ping': {
        const result: HostResult<'ping'> = { ok: true, rttMs: 0 }
        return result as HostResult<M>
      }
      default:
        throw new Error(`stub driver host has no answer for ${method}`)
    }
  }

  forceKill(): boolean {
    this.record().forceKills += 1
    this.alive = false
    return true
  }

  async waitExit(_ms: number): Promise<boolean> {
    return true
  }

  async shutdown(_opts: { disconnectMs: number; shutdownMs: number; exitMs: number }): Promise<void> {
    this.alive = false
  }

  private record(): StubHostRecord {
    const existing = records.get(String(this.connId))
    if (existing) return existing
    const fresh: StubHostRecord = { forceKills: 0, cancelCalls: [] }
    records.set(String(this.connId), fresh)
    return fresh
  }
}

/**
 * The real class must satisfy the same surface.
 *
 * Only this direction is checkable: `DriverHostProcess` has `private` fields, and
 * TypeScript refuses to assign one class to another across those. Assigning it to
 * an interface of public members is fine, and catches the case that matters —
 * the real signature moving while the stub keeps answering the old one.
 */
const _realConformsToSurface: HostSurface = null as unknown as RealDriverHostProcess
void _realConformsToSurface
