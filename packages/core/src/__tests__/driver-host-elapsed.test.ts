import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACK_WINDOW } from '../chunk'
import type { ChunkFrame, ResultStreamAck, ResultStreamMessage } from '../chunk'
import type { Cursor, Driver, DriverSession } from '../capability'
import {
  DriverHostRuntime,
  type HostChannel,
  type HostChannelMessage,
  type HostDataPort,
} from '../driver-host'
import { asConnId, asResultId } from '../ids'
import type { ResultId } from '../ids'
import type { HostEvent, HostInbound, HostOutbound, HostRequest, HostResponse } from '../ipc'

/* ==================================================================
 * What a finished result says it cost (design 2026-08-25).
 *
 * `elapsedMs` is the query's own time, not the wall clock: the pump parks in two
 * places — waiting for the data-plane port, and waiting for an ack — and both are
 * waits on the reader rather than on the database. Those intervals are banked as
 * stall and subtracted before any duration leaves the pump.
 *
 * This is testable here, without a database, precisely because `driver-host.ts`
 * is driver-agnostic: a fixture cursor that reports a wall clock nobody can
 * mistake for a real query is a better subject than PostgreSQL, because the
 * number under test is arithmetic on two clocks and nothing else.
 * ================================================================== */

/** Long enough to dwarf the pump's own work, short enough to keep the suite quick. */
const PARK_MS = 300

class FakeChannel implements HostChannel {
  readonly outbound: HostOutbound[] = []
  private readonly listeners: ((e: HostChannelMessage) => void)[] = []

  postMessage(message: unknown): void {
    this.outbound.push(message as HostOutbound)
  }

  on(_event: 'message', listener: (e: HostChannelMessage) => void): void {
    this.listeners.push(listener)
  }

  send(data: HostInbound, ports?: readonly HostDataPort[]): void {
    for (const l of this.listeners) l(ports ? { data, ports } : { data })
  }

  responses(): HostResponse[] {
    return this.outbound.filter((m): m is HostResponse => m.kind === 'res')
  }

  events(): HostEvent[] {
    return this.outbound.filter((m): m is HostEvent => m.kind === 'evt')
  }
}

class FakePort implements HostDataPort {
  readonly received: ResultStreamMessage[] = []
  private readonly listeners: ((e: { data: unknown }) => void)[] = []

  postMessage(message: unknown): void {
    this.received.push(message as ResultStreamMessage)
  }

  on(_event: 'message', listener: (e: { data: unknown }) => void): void {
    this.listeners.push(listener)
  }

  /** The renderer replying ack / cancel */
  send(msg: ResultStreamAck): void {
    for (const l of this.listeners) l({ data: msg })
  }

  chunks(): ChunkFrame[] {
    return this.received
      .filter((m): m is Extract<ResultStreamMessage, { t: 'chunk' }> => m.t === 'chunk')
      .map((m) => m.frame)
  }
}

/**
 * A cursor that answers instantly and reports its own wall clock, exactly as
 * every shipped cursor does (`Date.now() - this.startedAt`, five implementations,
 * `db-sql/cursor.ts:222` and its four siblings).
 *
 * `fixedElapsedMs` overrides that clock, which is how the clamp gets driven: a
 * cursor reporting less time than the pump spent parked would otherwise produce a
 * negative duration.
 */
class FixtureCursor implements Cursor {
  readonly schema = null
  /** The wall clock this cursor reported on its done frame, for the test to compare against */
  reportedWallMs = -1

  readonly resultId: ResultId

  private seq = 0
  private readonly startedAt = Date.now()
  private readonly frames: number
  private readonly fixedElapsedMs: number | undefined

  constructor(resultId: ResultId, frames: number, fixedElapsedMs?: number) {
    this.resultId = resultId
    this.frames = frames
    this.fixedElapsedMs = fixedElapsedMs
  }

  async next(): Promise<ChunkFrame | null> {
    if (this.seq >= this.frames) return null
    const frame: ChunkFrame = { resultId: this.resultId, seq: this.seq, cols: [[this.seq]], rowCount: 1 }
    this.seq += 1
    if (this.seq === this.frames) {
      this.reportedWallMs = this.fixedElapsedMs ?? Date.now() - this.startedAt
      frame.done = { rows: this.frames, elapsedMs: this.reportedWallMs }
    }
    return frame
  }

  async close(): Promise<void> {}
}

/** The last cursor the fixture driver handed out, so a test can read its clock back. */
let lastCursor: FixtureCursor | null = null

function fixtureDriver(frames: number, fixedElapsedMs?: number): Driver {
  const session: DriverSession = {
    driverId: 'fixture',
    capabilities: new Set(['tabularQuery']),
    close: async (): Promise<void> => {},
    query: async (req): Promise<Cursor> => {
      lastCursor = new FixtureCursor(req.resultId, frames, fixedElapsedMs)
      return lastCursor
    },
  }
  return {
    meta: { id: 'fixture', displayName: 'Fixture' },
    capabilities: new Set(['tabularQuery']),
    connect: async (): Promise<DriverSession> => session,
  }
}

let ridSeq = 0

async function call<M extends HostRequest['method']>(
  ch: FakeChannel,
  method: M,
  params: Extract<HostRequest, { method: M }>['params'],
): Promise<HostResponse> {
  ridSeq += 1
  const myRid = ridSeq
  ch.send({ kind: 'req', rid: myRid, method, params } as HostRequest)
  await waitFor(() => ch.responses().some((r) => r.rid === myRid), `the response to ${method}`)
  const res = ch.responses().find((r) => r.rid === myRid)
  assert.ok(res)
  return res
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The `done` carried by the control-plane event, which is what the workspace stores. */
function doneEvent(ch: FakeChannel, resultId: ResultId): Extract<HostEvent, { type: 'result.done' }> {
  const evt = ch.events().find((e) => e.type === 'result.done' && e.resultId === resultId)
  assert.ok(evt?.type === 'result.done', 'a result.done event')
  return evt
}

/** The `done` carried by the data-plane frame, which is what the grid displays. */
function doneFrame(port: FakePort): NonNullable<ChunkFrame['done']> {
  const frame = port.chunks().find((f) => f.done !== undefined)
  assert.ok(frame?.done, 'a frame carrying done')
  return frame.done
}

async function runQuery(ch: FakeChannel, resultId: ResultId): Promise<void> {
  const started = await call(ch, 'query.run', { resultId, text: 'SELECT 1' })
  assert.ok(started.ok)
}

describe('elapsedMs is the query time, not the wall clock', () => {
  it('does not charge the query for time spent waiting on the data-plane port', async () => {
    const ch = new FakeChannel()
    const host = new DriverHostRuntime(ch, { drivers: [fixtureDriver(3)] })
    const connected = await call(ch, 'connect', { connId: asConnId('c1'), config: { driverId: 'fixture' } })
    assert.ok(connected.ok)

    const resultId = asResultId('r-port')
    await runQuery(ch, resultId)

    // No port yet: the pump is parked in waitPort and the cursor's clock is running.
    await sleep(PARK_MS)
    const port = new FakePort()
    ch.send({ kind: 'attachPort', connId: asConnId('c1') }, [port])

    await waitFor(() => ch.events().some((e) => e.type === 'result.done'), 'result.done')

    assert.ok(
      lastCursor !== null && lastCursor.reportedWallMs >= PARK_MS,
      `the cursor's own clock must include the park (was ${String(lastCursor?.reportedWallMs)}ms)`,
    )
    const reported = doneEvent(ch, resultId).elapsedMs
    assert.ok(
      reported < PARK_MS / 2,
      `the reported time must exclude the ${String(PARK_MS)}ms park, but was ${String(reported)}ms`,
    )
    await host.dispose()
  })

  it('does not charge the query for time spent waiting on an ack, and both planes agree', async () => {
    // Both planes is the point: the status bar reads the control-plane event and
    // the grid reads the data-plane frame, so a correction applied to one and not
    // the other shows two different durations for one result.
    const ch = new FakeChannel()
    const frames = ACK_WINDOW + 2
    const host = new DriverHostRuntime(ch, { drivers: [fixtureDriver(frames)], idleAckMs: 5000 })
    const connected = await call(ch, 'connect', { connId: asConnId('c1'), config: { driverId: 'fixture' } })
    assert.ok(connected.ok)

    const port = new FakePort()
    ch.send({ kind: 'attachPort', connId: asConnId('c1') }, [port])
    const resultId = asResultId('r-ack')
    await runQuery(ch, resultId)

    // Withhold acks: the pump parks once ACK_WINDOW frames are outstanding.
    await waitFor(() => port.chunks().length >= ACK_WINDOW, `the first ${String(ACK_WINDOW)} frames`)
    await sleep(PARK_MS)
    port.send({ t: 'ack', resultId, seq: frames - 1 })

    await waitFor(() => ch.events().some((e) => e.type === 'result.done'), 'result.done')

    assert.ok(
      lastCursor !== null && lastCursor.reportedWallMs >= PARK_MS,
      `the cursor's own clock must include the park (was ${String(lastCursor?.reportedWallMs)}ms)`,
    )
    const fromEvent = doneEvent(ch, resultId).elapsedMs
    const fromFrame = doneFrame(port).elapsedMs
    assert.equal(fromEvent, fromFrame, 'the control plane and the data plane must report one number')
    assert.ok(
      fromEvent < PARK_MS / 2,
      `the reported time must exclude the ${String(PARK_MS)}ms park, but was ${String(fromEvent)}ms`,
    )
    await host.dispose()
  })

  it('never reports a negative duration', async () => {
    // A cursor claiming 0ms while the pump sat parked for PARK_MS is the shape
    // any clock adjustment would take: the subtraction goes past zero.
    const ch = new FakeChannel()
    const host = new DriverHostRuntime(ch, { drivers: [fixtureDriver(3, 0)] })
    const connected = await call(ch, 'connect', { connId: asConnId('c1'), config: { driverId: 'fixture' } })
    assert.ok(connected.ok)

    const resultId = asResultId('r-clamp')
    await runQuery(ch, resultId)
    await sleep(PARK_MS)
    const port = new FakePort()
    ch.send({ kind: 'attachPort', connId: asConnId('c1') }, [port])

    await waitFor(() => ch.events().some((e) => e.type === 'result.done'), 'result.done')
    assert.equal(doneEvent(ch, resultId).elapsedMs, 0)
    assert.equal(doneFrame(port).elapsedMs, 0)
    await host.dispose()
  })

  it('a pause reports the time spent producing rows, not the idle ceiling', async () => {
    // A pause fires *because* idleAckMs elapsed with no ack, so that entire
    // timeout is stall. Reporting it back as elapsed time restates a constant.
    const ch = new FakeChannel()
    const idleAckMs = 400
    const host = new DriverHostRuntime(ch, { drivers: [fixtureDriver(ACK_WINDOW + 5)], idleAckMs })
    const connected = await call(ch, 'connect', { connId: asConnId('c1'), config: { driverId: 'fixture' } })
    assert.ok(connected.ok)

    const port = new FakePort()
    ch.send({ kind: 'attachPort', connId: asConnId('c1') }, [port])
    const resultId = asResultId('r-pause')
    await runQuery(ch, resultId)

    await waitFor(
      () => ch.events().some((e) => e.type === 'result.paused' && e.resultId === resultId),
      'result.paused',
      5000,
    )
    const evt = ch.events().find((e) => e.type === 'result.paused' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.paused')
    assert.ok(evt.paused.elapsedMs >= 0, 'never negative')
    assert.ok(
      evt.paused.elapsedMs < idleAckMs / 2,
      `the idle ceiling must not be reported as elapsed time, but was ${String(evt.paused.elapsedMs)}ms`,
    )
    await host.dispose()
  })
})
