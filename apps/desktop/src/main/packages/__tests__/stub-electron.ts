import { EventEmitter } from 'node:events'

/* ==================================================================
 * Electron, replaced — and nothing else.
 *
 * `packages/host-process.ts` reaches the outside world through exactly two
 * imports from `electron`, `app` and `utilityProcess`, and those two are the
 * only reason the package host wrapper and `PackageHostRegistry` cannot be
 * loaded by `node --test`. Standing in for them keeps **the shipping wrapper and
 * the shipping registry** under test: the fork policy, the lazy map, the rid
 * bookkeeping and the deadlines are all real here.
 *
 * ## Why this stubs Electron rather than peek's own module
 *
 * `connections/__tests__/stub-host-process.ts` replaces peek's own process
 * wrapper, and pays for it with a `HostSurface` interface asserted against the
 * real class — because a stub of your own protocol can drift from the protocol
 * and keep the suite green (PLAN §9.1). That risk is absent here in both
 * directions: the RPC shapes are not faked at all (the real
 * `PackageHostProcess` builds and parses every envelope), and the contract this
 * file does fake is Electron's, which peek does not own and cannot drift from
 * on its own. What it must get right is only the handful of members
 * `host-process.ts` touches, and a member added there without one here fails
 * loudly — an undefined function call, not a quiet disagreement.
 *
 * ## The one timing rule
 *
 * `'spawn'` is emitted on a microtask, never synchronously from `fork()`.
 * `PackageHostProcess.spawn()` wires its listeners *before* it creates the
 * promise that holds `startResolve`, so a synchronous `'spawn'` would be
 * observed by a `settleStart` that has nothing to resolve — the process would
 * come up and the caller would wait for it forever.
 * ================================================================== */

/** What `PackageHostProcess.spawn()` passes to `utilityProcess.fork`. */
export interface StubForkOptions {
  serviceName?: string
  stdio?: string
  env?: Record<string, string>
}

export interface ForkRecord {
  entryPath: string
  args: readonly string[]
  serviceName: string | undefined
  /** The child's whole environment — acceptance item 29 reads this. */
  env: Readonly<Record<string, string>>
  child: FakeUtilityProcess
}

/** Distinguishes "answer with `undefined`" from "never answer at all". */
const SILENT = Symbol('no answer')
type Answer = unknown | typeof SILENT

const forks: ForkRecord[] = []
let answer: Answer = SILENT
let nextPid = 4000

export class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined
  readonly sent: unknown[] = []
  /** `forwardStdio` is honoured by the wrapper with `?.`; nothing here produces output. */
  readonly stdout = null
  readonly stderr = null
  private dead = false

  constructor() {
    super()
    const pid = nextPid++
    queueMicrotask(() => {
      if (this.dead) return
      this.pid = pid
      this.emit('spawn')
    })
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
    if (answer === SILENT) return
    const rid = numberField(message, 'rid')
    const method = stringField(message, 'method')
    if (rid === null || method === null) return
    const result = answer
    queueMicrotask(() => {
      if (this.dead) return
      this.emit('message', { kind: 'res', rid, method, ok: true, result })
    })
  }

  kill(): boolean {
    if (this.dead) return false
    this.dead = true
    queueMicrotask(() => {
      this.emit('exit', 0)
    })
    return true
  }
}

function numberField(value: unknown, field: string): number | null {
  if (typeof value !== 'object' || value === null || !(field in value)) return null
  const found: unknown = Reflect.get(value, field)
  return typeof found === 'number' ? found : null
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null || !(field in value)) return null
  const found: unknown = Reflect.get(value, field)
  return typeof found === 'string' ? found : null
}

/* ------------------------------------------------------------------ */
/* The `electron` module's two members                                 */
/* ------------------------------------------------------------------ */

export const app = {
  isReady(): boolean {
    return true
  },
  async whenReady(): Promise<void> {},
}

export const utilityProcess = {
  fork(entryPath: string, args: readonly string[], options: StubForkOptions): FakeUtilityProcess {
    const child = new FakeUtilityProcess()
    forks.push({
      entryPath,
      args: [...args],
      serviceName: options.serviceName,
      env: { ...options.env },
      child,
    })
    return child
  },
}

/* ------------------------------------------------------------------ */
/* Test control                                                        */
/* ------------------------------------------------------------------ */

export const stubElectron = {
  /** Every fork this process has performed, in order. Acceptance item 31 counts these. */
  get forks(): readonly ForkRecord[] {
    return forks
  },

  /** Answer every request with this result. Until called, hosts stay silent and calls time out. */
  answerWith(result: unknown): void {
    answer = result
  },

  reset(): void {
    forks.length = 0
    answer = SILENT
  },
}
