import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  DRIVER_CAPABILITIES,
  newResultId,
  type Capability,
  type CollectionRef,
  type ConnId,
  type ConnStatus,
  type ResultId,
} from '@peek/core'

/* ==================================================================
 * A deadline expiring must not tear the connection down.
 *
 * ## The behaviour this file pins
 *
 * `startResult` now arms a default whole-fetch deadline for every request, so a
 * fetch that names no `timeoutMs` still gets one. The expiry path used to reach
 * for `ConnectionManager.cancel()`, and that is where it went wrong:
 * `cancel()` escalates to `killForCancel` whenever the driver declares no
 * `cancel` capability — it force-kills the driver process, deletes the
 * connection, moves its status to `error`, and fails **every other in-flight
 * result on that connection** as CONNECTION_LOST.
 *
 * qdrant is the concrete victim: the one driver in `DRIVER_CAPABILITIES`
 * without `cancel`, carrying default budgets of 120s (scan) and 60s (vector
 * search) that no UI yet exposes. Either budget expiring disconnected a user who
 * had pressed nothing.
 *
 * What makes it indefensible rather than merely aggressive: the renderer already
 * refuses to offer that escalation to a *person*. `views/ResultControls.tsx`
 * disables Cancel for a driver without the capability and explains that peek's
 * only remaining lever is killing the driver process, which is not a thing to do
 * to someone by surprise. A silent default timeout doing it unprompted is more
 * of a surprise, not less.
 *
 * ## Why the stubs
 *
 * `stopExpiredResult` lives in `connections/manager.ts`, which reaches Electron
 * through `host-process` (`utilityProcess`) and `port-broker`
 * (`MessageChannelMain`). Neither is reachable from the function under test, so
 * both are redirected to the stubs in `connections/__tests__/`. Nothing else is
 * faked: the assertions below run against the shipping implementation.
 *
 * `manager.ts` itself imports Electron for types only, so the stubs are the only
 * thing standing between it and the test runner. There used to be a second
 * obstacle — `host-process` declared its fields as TypeScript parameter
 * properties, the one construct that emits code, which node's strip-only type
 * stripping rejects with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import time. That
 * has been rewritten as explicit assignment, so the failure a future test meets
 * here is now an honest "Electron is not available in this process" rather than a
 * syntax error pointing at a file it never asked for.
 * ================================================================== */

// Must run before manager.ts is resolved; see the module's own note.
import '../../connections/__tests__/install-stubs'
import { stubHost } from '../../connections/__tests__/stub-host-process'

const { ConnectionManager, stopExpiredResult } = await import('../../connections/manager')
type StopOutcome = Awaited<ReturnType<typeof stopExpiredResult>>

const CANCELLABLE: Capability[] = ['introspect', 'tabularQuery', 'collectionScan', 'cancel']

interface Recorder {
  asked: ResultId[]
  warnings: string[]
}

function target(
  overrides: { hostAlive?: boolean; capabilities?: readonly Capability[]; askDriver?: () => Promise<unknown> },
  rec: Recorder,
): Parameters<typeof stopExpiredResult>[0] {
  return {
    hostAlive: overrides.hostAlive ?? true,
    capabilities: overrides.capabilities ?? CANCELLABLE,
    askDriver: async (id: ResultId): Promise<unknown> => {
      rec.asked.push(id)
      if (overrides.askDriver) return overrides.askDriver()
      return undefined
    },
    warn: (message: string): void => {
      rec.warnings.push(message)
    },
  }
}

function recorder(): Recorder {
  return { asked: [], warnings: [] }
}

describe('a request that outlives its deadline', () => {
  it('leaves a driver without the cancel capability entirely alone', async () => {
    const rec = recorder()
    const resultId = newResultId()

    const outcome: StopOutcome = await stopExpiredResult(
      target({ capabilities: ['introspect', 'collectionScan', 'vectorSearch', 'valuePeek'] }, rec),
      resultId,
    )

    // The regression: this path used to run ConnectionManager.cancel(), which for
    // a driver with no cancel capability means killForCancel — process killed,
    // connection dropped, every other in-flight result on it failed.
    assert.equal(outcome, 'left-alone')
    assert.deepEqual(rec.asked, [], 'there is nothing to ask a driver that cannot be asked')
    assert.deepEqual(rec.warnings, [], 'nothing went wrong, so nothing is reported')
  })

  it('covers qdrant specifically, read from the real capability table', async () => {
    // Pinned against core rather than a literal: if qdrant ever gains `cancel`
    // this test keeps describing the driver that actually lacks it.
    const withoutCancel = Object.entries(DRIVER_CAPABILITIES)
      .filter(([, caps]) => !caps.includes('cancel'))
      .map(([driverId]) => driverId)
    assert.deepEqual(withoutCancel, ['qdrant'], 'qdrant is the driver this protects')

    const rec = recorder()
    const outcome = await stopExpiredResult(
      target({ capabilities: DRIVER_CAPABILITIES.qdrant }, rec),
      newResultId(),
    )
    assert.equal(outcome, 'left-alone')
    assert.deepEqual(rec.asked, [])
  })

  it('asks a cooperative driver to wind the cursor down', async () => {
    const rec = recorder()
    const resultId = newResultId()

    const outcome = await stopExpiredResult(target({}, rec), resultId)

    assert.equal(outcome, 'asked')
    assert.deepEqual(rec.asked, [resultId], 'the polite lever is used where it exists')
    assert.deepEqual(rec.warnings, [])
  })

  it('does not ask a host that is already gone', async () => {
    const rec = recorder()
    const outcome = await stopExpiredResult(target({ hostAlive: false }, rec), newResultId())

    assert.equal(outcome, 'left-alone')
    assert.deepEqual(rec.asked, [], 'a dead host has no RPC to answer it')
  })

  it('a cancel RPC that fails reports it and still does not escalate', async () => {
    const rec = recorder()
    const resultId = newResultId()

    const outcome = await stopExpiredResult(
      target({ askDriver: () => Promise.reject(new Error('the host did not answer')) }, rec),
      resultId,
    )

    // A host that will not answer its cancel RPC is a connection worth closing,
    // but that is the user's call — and the request they were waiting on has
    // already been settled as TIMEOUT by the caller.
    assert.equal(outcome, 'ask-failed')
    assert.deepEqual(rec.asked, [resultId])
    assert.equal(rec.warnings.length, 1)
    assert.match(rec.warnings[0] ?? '', /left open/, 'the connection is reported as surviving')
  })

  it('never has a lever that could kill the process in the first place', () => {
    // The structural half of the fix: `DeadlineStopTarget` hands the expiry path
    // exactly one capability-gated RPC and a logger. There is no route from it
    // back to `killForCancel`, so the escalation cannot be reintroduced by
    // someone reaching for the method that was already there.
    const rec = recorder()
    const keys = Object.keys(target({}, rec)).sort()
    assert.deepEqual(keys, ['askDriver', 'capabilities', 'hostAlive', 'warn'])
  })
})

/* ==================================================================
 * The same guarantee, through the real ConnectionManager.
 *
 * The suite above pins the helper's contract. This one pins the wiring, which
 * is where the bug actually lived: `armDeadline` reaching for `this.cancel(...)`
 * is what turned an expired budget into a dropped connection. Driving it end to
 * end is what catches a future edit that routes the expiry back through
 * `cancel()` while leaving `stopExpiredResult` untouched and green.
 *
 * Measured against the pre-fix wiring on this exact harness: `conns` no longer
 * held the connection, the second in-flight scan had been failed
 * CONNECTION_LOST, and status had gone `connecting → ready → error`.
 * ================================================================== */

const SCAN_REF: CollectionRef = { kind: 'vectorCollection', collection: 'docs' }

/** The driver-host bundle only has to *exist* — the stub above is what actually runs. */
function makeHostDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-deadline-'))
  writeFileSync(join(dir, 'driver-host.js'), '// replaced by the module stub\n')
  return dir
}

const HOST_DIRS: string[] = []
after(() => {
  for (const dir of HOST_DIRS) rmSync(dir, { recursive: true, force: true })
})

interface ManagerHarness {
  manager: InstanceType<typeof ConnectionManager>
  connId: ConnId
  /**
   * Hand back the deadline armed by the most recent request.
   *
   * Taken as a snapshot rather than fired in place: the interesting scenario has
   * a second request arming its own deadline afterwards, and "expire the latest"
   * would trip the wrong one.
   */
  takeArmed(): () => void
  forceKills(): number
  cancelCalls(): ResultId[]
  /** True once the manager has dropped the connection (killForCancel deletes it). */
  connectionGone(): boolean
  errors: { resultId: ResultId; code: string }[]
  statuses: ConnStatus[]
}

async function managerOn(capabilities: readonly Capability[]): Promise<ManagerHarness> {
  const hostDir = makeHostDir()
  HOST_DIRS.push(hostDir)
  stubHost.configure({ capabilities })

  let armed: (() => void) | null = null
  const manager = new ConnectionManager({
    hostDir,
    forwardStdio: false,
    timers: {
      set: (cb) => {
        armed = cb
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clear: () => {},
    },
  })

  const errors: { resultId: ResultId; code: string }[] = []
  const statuses: ConnStatus[] = []
  manager.events.on('result.error', (e) => errors.push({ resultId: e.resultId, code: e.error.code }))
  manager.events.on('status', (e) => statuses.push(e.status))

  const out = await manager.connect({ driverId: 'qdrant', url: 'http://localhost:6333' })
  // Reading the private table is the only way to ask "is the connection still
  // there?" — killForCancel deletes the entry, which is precisely the damage.
  // What the *stub* recorded comes from the stub module instead, which the
  // manager and this file resolve to the same instance of.
  const conns = (manager as unknown as { conns: Map<ConnId, unknown> }).conns

  return {
    manager,
    connId: out.connId,
    takeArmed: () => {
      const fire: (() => void) | null = armed
      assert.ok(fire, 'a deadline must have been armed for the request')
      armed = null
      return fire
    },
    forceKills: () => stubHost.recordOf(out.connId)?.forceKills ?? -1,
    cancelCalls: () => stubHost.recordOf(out.connId)?.cancelCalls ?? [],
    connectionGone: () => !conns.has(out.connId),
    errors,
    statuses,
  }
}

describe('the deadline path through ConnectionManager', () => {
  it('does not kill the driver process for a driver that cannot be cancelled', async () => {
    const h = await managerOn(DRIVER_CAPABILITIES.qdrant)
    const doomed = newResultId()
    const bystander = newResultId()

    await h.manager.scan(h.connId, { resultId: doomed, ref: SCAN_REF, chunkRows: 100 })
    const expireDoomed = h.takeArmed()
    await h.manager.scan(h.connId, { resultId: bystander, ref: SCAN_REF, chunkRows: 100 })
    expireDoomed()
    await tick()

    assert.equal(h.connectionGone(), false, 'the connection the user is still using survives')
    assert.equal(h.forceKills(), 0, 'the driver process is not killed')
    assert.deepEqual(h.statuses, ['connecting', 'ready'], 'status never went to error')

    // Exactly one result settled, with the reason that actually applies.
    assert.deepEqual(h.errors, [{ resultId: doomed, code: 'TIMEOUT' }])
    assert.ok(
      !h.errors.some((e) => e.resultId === bystander),
      'the other in-flight scan is untouched — it had its own budget and had not spent it',
    )

    await h.manager.disposeAll()
  })

  it('asks a cooperative driver, and still reports TIMEOUT rather than CANCELLED', async () => {
    const h = await managerOn(['introspect', 'collectionScan', 'valuePeek', 'cancel'])
    const doomed = newResultId()

    await h.manager.scan(h.connId, { resultId: doomed, ref: SCAN_REF, chunkRows: 100 })
    h.takeArmed()()
    await tick()

    assert.deepEqual(h.cancelCalls(), [doomed], 'the polite lever is used where the driver offers one')
    assert.equal(h.forceKills(), 0)
    assert.equal(h.connectionGone(), false)
    // The user configured a deadline; naming their own timeout "cancelled" would
    // leave the budget they set with no trace anywhere.
    assert.deepEqual(h.errors, [{ resultId: doomed, code: 'TIMEOUT' }])

    await h.manager.disposeAll()
  })

  it('an explicit force cancel still kills — the escalation is not gone, only unhooked from the clock', async () => {
    const h = await managerOn(DRIVER_CAPABILITIES.qdrant)
    const resultId = newResultId()
    await h.manager.scan(h.connId, { resultId, ref: SCAN_REF, chunkRows: 100 })

    const killsBefore = h.forceKills()
    const outcome = await h.manager.cancel(h.connId, resultId, { force: true })

    assert.equal(outcome.killed, true, 'a person asking for it is a different thing from a timer doing it')
    assert.equal(killsBefore, 0)
    assert.equal(h.connectionGone(), true)

    await h.manager.disposeAll()
  })
})

/** Let the expiry callback's floating promise settle before asserting on it. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}
