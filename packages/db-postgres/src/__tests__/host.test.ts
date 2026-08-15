import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  ACK_WINDOW,
  isPeekError,
  newConnId,
  newResultId,
  type ChunkFrame,
  type HostEvent,
  type HostInbound,
  type HostOutbound,
  type HostRequest,
  type HostResponse,
  type HostResult,
  type PostgresConnectionConfig,
  type ResultId,
  type ResultStreamAck,
  type ResultStreamMessage,
} from '@peek/core'
import { DriverHost, type HostChannelLike, type HostPortLike } from '../host-runtime'
import { createFixture, FIXTURE_TABLES } from './fixture'

/**
 * End-to-end driver host protocol: a pair of in-memory fake ports stands in for
 * main ↔ host ↔ renderer, covering control-plane RPC, chunks delivered straight
 * over the data plane, ack-window backpressure and cancellation.
 * Nothing from electron is imported — whatever runs inside a utilityProcess runs
 * here.
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

/** Its own schema, distinct from postgres.test.ts's: node runs the two files in parallel processes. */
const SCHEMA = 'peek_test_host'

const CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: TEST_URL,
  applicationName: 'peek-host-test',
}

/** Fake main ↔ host control channel */
class FakeChannel implements HostChannelLike {
  readonly outbound: HostOutbound[] = []
  private readonly listeners: ((e: { data: unknown; ports?: readonly HostPortLike[] }) => void)[] = []

  postMessage(message: unknown): void {
    this.outbound.push(message as HostOutbound)
  }

  on(_event: 'message', listener: (e: { data: unknown; ports?: readonly HostPortLike[] }) => void): void {
    this.listeners.push(listener)
  }

  /** Simulate main sending a message to the host */
  send(data: HostInbound, ports?: readonly HostPortLike[]): void {
    for (const l of this.listeners) l(ports ? { data, ports } : { data })
  }

  responses(): HostResponse[] {
    return this.outbound.filter((m): m is HostResponse => m.kind === 'res')
  }

  events(): HostEvent[] {
    return this.outbound.filter((m): m is HostEvent => m.kind === 'evt')
  }
}

/** Fake host → renderer data-plane port */
class FakePort implements HostPortLike {
  readonly received: ResultStreamMessage[] = []
  private readonly listeners: ((e: { data: unknown }) => void)[] = []
  started = false

  postMessage(message: unknown): void {
    this.received.push(message as ResultStreamMessage)
  }

  on(_event: 'message', listener: (e: { data: unknown }) => void): void {
    this.listeners.push(listener)
  }

  start(): void {
    this.started = true
  }

  /** Simulate the renderer replying with ack / cancel */
  send(msg: ResultStreamAck): void {
    for (const l of this.listeners) l({ data: msg })
  }

  chunks(): ChunkFrame[] {
    return this.received
      .filter((m): m is Extract<ResultStreamMessage, { t: 'chunk' }> => m.t === 'chunk')
      .map((m) => m.frame)
  }
}

let ridSeq = 0

/** Send one RPC on the given channel and await its response */
async function callOn<M extends HostRequest['method']>(
  ch: FakeChannel,
  method: M,
  params: Extract<HostRequest, { method: M }>['params'],
): Promise<HostResponse> {
  ridSeq += 1
  const myRid = ridSeq
  ch.send({ kind: 'req', rid: myRid, method, params } as HostRequest)
  await waitFor(() => ch.responses().some((r) => r.rid === myRid), `the response to RPC ${method}`)
  const res = ch.responses().find((r) => r.rid === myRid)
  assert.ok(res)
  return res
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Settle briefly, so "no further frames should arrive" can be asserted */
async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('driver host protocol', () => {
  let channel: FakeChannel
  let host: DriverHost
  let port: FakePort
  let dropFixture: () => Promise<void>

  /**
   * Send one RPC and await its response.
   * This deliberately does not delegate to callOn: while M is still a type
   * variable, `Extract<HostRequest, {method: M}>['params']` cannot be handed
   * safely to another generic function (TS collapses it to the intersection of
   * every params type).
   */
  async function call<M extends HostRequest['method']>(
    method: M,
    params: Extract<HostRequest, { method: M }>['params'],
  ): Promise<HostResponse> {
    ridSeq += 1
    const myRid = ridSeq
    channel.send({ kind: 'req', rid: myRid, method, params } as HostRequest)
    await waitFor(() => channel.responses().some((r) => r.rid === myRid), `the response to RPC ${method}`)
    const res = channel.responses().find((r) => r.rid === myRid)
    assert.ok(res)
    return res
  }

  /**
   * The table's real row count. The fixture fixes it, but going through
   * query.run and reading the result back off the data plane is the point:
   * it proves that path works before the scan assertion relies on it.
   */
  async function rowCountOf(table: string): Promise<number> {
    const resultId = newResultId()
    await call('query.run', { resultId, text: `SELECT count(*)::int4 AS n FROM ${table}` })
    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      'the count query to finish',
    )
    const frame = port.chunks().find((f) => f.resultId === resultId)
    const n = frame?.cols[0]?.[0]
    assert.equal(typeof n, 'number', 'count(*) must come back as a number')
    return n as number
  }

  before(async () => {
    dropFixture = await createFixture(TEST_URL, SCHEMA)
    channel = new FakeChannel()
    host = new DriverHost(channel)
    port = new FakePort()
    host.announceReady(process.pid)

    const res = await call('connect', { connId: newConnId(), config: CONFIG })
    assert.equal(res.ok, true)
    channel.send({ kind: 'attachPort', connId: newConnId() }, [port])
  })

  after(async () => {
    await host.dispose()
    await dropFixture?.()
  })

  it('emits ready and returns the capability set with the connect response', () => {
    const ready = channel.events().find((e) => e.type === 'ready')
    assert.ok(ready)
    const statuses = channel
      .events()
      .filter((e) => e.type === 'status')
      .map((e) => e.status)
    assert.deepEqual(statuses, ['connecting', 'ready'])

    const connectRes = channel.responses().find((r) => r.method === 'connect')
    assert.ok(connectRes?.ok)
    const result = connectRes.result as HostResult<'connect'>
    assert.deepEqual([...result.capabilities].sort(), [
      'cancel',
      'collectionScan',
      'introspect',
      'tabularQuery',
      'valuePeek',
    ])
    assert.equal(result.serverInfo?.flavor, 'PostgreSQL')
    assert.equal(port.started, true, 'attachPort must be followed by start()')
  })

  it('introspect.children returns the 3 tables over RPC', async () => {
    // The node id is spelled out rather than built with `nodeId.schema()`: this
    // suite is about the wire protocol, and deriving the id from the same helper
    // the driver uses would stop testing that the documented format is accepted.
    const res = await call('introspect.children', { parentId: `schema:${SCHEMA}` })
    assert.ok(res.ok)
    const result = res.result as HostResult<'introspect.children'>
    assert.deepEqual(result.nodes.map((n) => n.name).sort(), [...FIXTURE_TABLES])
  })

  it('collection.scan results travel only over the MessagePort, never the control plane', async () => {
    const expected = await rowCountOf(`${SCHEMA}.item`)
    const resultId = newResultId()
    const before = port.received.length
    const res = await call('collection.scan', {
      resultId,
      ref: { kind: 'relation', schema: SCHEMA, name: 'item' },
    })
    assert.ok(res.ok)
    const result = res.result as HostResult<'collection.scan'>
    assert.equal(result.resultId, resultId)
    // Not a single row of data in the control-plane response
    assert.deepEqual(Object.keys(result), ['resultId'])

    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      'the result.done event',
    )
    const frames = port.chunks().slice(before)
    const mine = frames.filter((f) => f.resultId === resultId)
    assert.equal(mine.length, 1)
    assert.equal(mine[0]?.rowCount, expected)
    assert.ok(mine[0]?.done)
    assert.ok(mine[0]?.schema, 'the first frame carries the schema')

    const schemaEvt = channel.events().find((e) => e.type === 'result.schema' && e.resultId === resultId)
    assert.ok(schemaEvt, 'main must receive result.schema to populate ResultMeta')
  })

  it('the ack window holds: sending stops once ACK_WINDOW frames are unacknowledged', async () => {
    const resultId = newResultId()
    const res = await call('query.run', {
      resultId,
      text: 'SELECT i FROM generate_series(1, 200) AS i',
      chunkRows: 1,
    })
    assert.ok(res.ok)

    const mine = (): ChunkFrame[] => port.chunks().filter((f) => f.resultId === resultId)
    await waitFor(() => mine().length >= ACK_WINDOW, `the first ${ACK_WINDOW} frames`)
    await settle()
    assert.equal(mine().length, ACK_WINDOW, `without an ack at most ${ACK_WINDOW} frames may be sent`)

    // Acking through seq=1 frees two slots in the window
    port.send({ t: 'ack', resultId, seq: 1 })
    await waitFor(() => mine().length >= ACK_WINDOW + 2, 'the new frames released by the advanced window')
    await settle()
    assert.equal(mine().length, ACK_WINDOW + 2, 'the window released exactly the slots that were freed')

    // Wrap up: ack all the way through and confirm it reaches done
    let guard = 0
    while (!channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId)) {
      const last = mine().length - 1
      port.send({ t: 'ack', resultId, seq: last })
      await settle(20)
      guard += 1
      if (guard > 400) throw new Error('ack progress stalled; the result set never finished')
    }
    const done = channel.events().find((e) => e.type === 'result.done' && e.resultId === resultId)
    assert.equal(done?.type === 'result.done' ? done.rows : -1, 200)
  })

  it('a cancel from the renderer over the data plane interrupts a long query at once', async () => {
    const resultId = newResultId()
    const res = await call('query.run', { resultId, text: 'SELECT pg_sleep(30)' })
    assert.ok(res.ok)
    await settle(200)
    port.send({ t: 'cancel', resultId })

    await waitFor(
      () => channel.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      'the result.error event',
      6000,
    )
    const evt = channel.events().find((e) => e.type === 'result.error' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.error' && evt.error.code === 'CANCELLED')
    const errMsg = port.received.find((m) => m.t === 'error' && m.resultId === resultId)
    assert.ok(errMsg?.t === 'error' && isPeekError(errMsg.error))
  })

  it('an unsupported capability answers UNSUPPORTED_CAPABILITY instead of crashing', async () => {
    const res = await call('vector.search', { resultId: newResultId(), collection: 'x', topK: 1 })
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.error.code === 'UNSUPPORTED_CAPABILITY')

    const kv = await call('keyvalue.get', { ref: { kind: 'redisValue', key: 'a' } })
    assert.ok(!kv.ok && kv.error.code === 'UNSUPPORTED_CAPABILITY')
  })

  it('value.peek fetches a large value in full over RPC', async () => {
    const resultId: ResultId = newResultId()
    await call('query.run', { resultId, text: `SELECT repeat('m', 9000) AS big` })
    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      'the large-value query to finish',
    )
    const res = await call('value.peek', { ref: { kind: 'resultCell', resultId, row: 0, col: 0 } })
    assert.ok(res.ok)
    const result = res.result as HostResult<'value.peek'>
    assert.equal(result.value.data.length, 9000)
    assert.equal(result.value.eof, true)
  })

  it('a query issued before the data-plane port arrives: cancel wakes the pump, leaving no wedged cursor', async () => {
    // This path is supported on purpose ("wait for the port rather than drop
    // frames"), but the wait has to be interruptible: otherwise cancellation
    // cannot wake the pump and the cursor keeps its connection and read-only
    // transaction forever.
    const lonely = new FakeChannel()
    const lonelyHost = new DriverHost(lonely)
    const connected = await callOn(lonely, 'connect', { connId: newConnId(), config: CONFIG })
    assert.ok(connected.ok)

    const resultId = newResultId()
    // Deliberately **no** attachPort — query straight away
    const started = await callOn(lonely, 'query.run', { resultId, text: 'SELECT 1 AS a' })
    assert.ok(started.ok)
    await settle(100)
    assert.equal(
      lonely.events().some((e) => e.type === 'result.done' || e.type === 'result.error'),
      false,
      'no frames may be produced while there is no data-plane port',
    )

    const cancelled = await callOn(lonely, 'cancel', { resultId })
    assert.ok(cancelled.ok)
    assert.deepEqual(cancelled.result, { cancelled: true })

    await waitFor(
      () => lonely.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      'after a cancel the control plane must receive result.error (otherwise main sits at running forever)',
      3000,
    )
    const evt = lonely.events().find((e) => e.type === 'result.error' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.error' && evt.error.code === 'CANCELLED')
    await lonelyHost.dispose()
  })

  it('a backpressure pause past the idle ceiling packs up and reports paused (not error)', async () => {
    // Withhold every ack so the pump parks in waitWindow; past idleAckMs it must
    // close the cursor and return the connection rather than hold server-side
    // resources indefinitely (PLAN section 8).
    //
    // **Packing up has to end in paused.** This used to reject with a TIMEOUT
    // PeekError, which put a by-design pause in the same error branch as a real
    // SQL failure, leaving an AI reading the MCP receipt unable to tell "the
    // query broke" from "it merely stopped, and the rows are good".
    const idle = new FakeChannel()
    const idleHost = new DriverHost(idle, { idleAckMs: 300 })
    const idlePort = new FakePort()
    const connected = await callOn(idle, 'connect', { connId: newConnId(), config: CONFIG })
    assert.ok(connected.ok)
    idle.send({ kind: 'attachPort', connId: newConnId() }, [idlePort])

    const resultId = newResultId()
    const started = await callOn(idle, 'query.run', {
      resultId,
      text: 'SELECT i FROM generate_series(1, 5000) AS i',
      chunkRows: 1,
    })
    assert.ok(started.ok)

    await waitFor(() => idlePort.chunks().length >= ACK_WINDOW, `the first ${ACK_WINDOW} frames`)
    await waitFor(
      () => idle.events().some((e) => e.type === 'result.paused' && e.resultId === resultId),
      'result.paused after the idle timeout',
      3000,
    )

    // Control plane: the paused event carries everything main needs to move its
    // state machine
    const evt = idle.events().find((e) => e.type === 'result.paused' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.paused')
    assert.equal(evt.paused.reason, 'idleAck')
    assert.equal(evt.paused.resumable, true)
    assert.equal(evt.paused.rows, ACK_WINDOW, 'the rows already delivered are reported truthfully')
    assert.ok(evt.paused.elapsedMs >= 0)

    // No error may be reported alongside it — that conflation is exactly what
    // this behaviour exists to prevent
    assert.equal(
      idle.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      false,
      'a pause must not take the error branch',
    )
    assert.equal(
      idlePort.received.some((m) => m.t === 'error' && m.resultId === resultId),
      false,
      'the data plane must not receive an error either',
    )

    // Data plane: one paused message, which is how the renderer shows "paused"
    // instead of a red error
    const pausedMsg = idlePort.received.find((m) => m.t === 'paused' && m.resultId === resultId)
    assert.ok(pausedMsg?.t === 'paused' && pausedMsg.paused.resumable === true)

    assert.equal(idlePort.chunks().length, ACK_WINDOW, 'no extra frames sneak out before packing up')
    await idleHost.dispose()
  })

  it('once paused the cursor is released: a late ack produces no further frames', async () => {
    const idle = new FakeChannel()
    const idleHost = new DriverHost(idle, { idleAckMs: 200 })
    const idlePort = new FakePort()
    const connected = await callOn(idle, 'connect', { connId: newConnId(), config: CONFIG })
    assert.ok(connected.ok)
    idle.send({ kind: 'attachPort', connId: newConnId() }, [idlePort])

    const resultId = newResultId()
    await callOn(idle, 'query.run', {
      resultId,
      text: 'SELECT i FROM generate_series(1, 5000) AS i',
      chunkRows: 1,
    })
    await waitFor(
      () => idle.events().some((e) => e.type === 'result.paused' && e.resultId === resultId),
      'result.paused',
      3000,
    )
    const framesAtPause = idlePort.chunks().length

    idlePort.send({ t: 'ack', resultId, seq: framesAtPause - 1 })
    await settle(300)
    assert.equal(idlePort.chunks().length, framesAtPause, 'paused is terminal; a late ack does not revive it')
    await idleHost.dispose()
  })

  it('a request made before connecting answers CONFLICT, leaving no dangling promise', async () => {
    const lonely = new FakeChannel()
    const lonelyHost = new DriverHost(lonely)
    lonely.send({ kind: 'req', rid: 1, method: 'introspect.children', params: { parentId: null } })
    await waitFor(() => lonely.responses().length > 0, 'the response while not connected')
    const res = lonely.responses()[0]
    assert.ok(res && !res.ok && res.error.code === 'CONFLICT')
    await lonelyHost.dispose()
  })
})
