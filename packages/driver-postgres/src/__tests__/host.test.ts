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

/**
 * driver host 协议端到端：用一对内存假端口模拟 main ↔ host ↔ renderer，
 * 验证控制面 RPC、数据面 chunk 直发、ack 窗口背压、取消。
 * 完全不 import electron —— utilityProcess 里能跑的东西，这里就能跑。
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

const CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: TEST_URL,
  applicationName: 'peek-host-test',
}

/** 假的 main ↔ host 控制通道 */
class FakeChannel implements HostChannelLike {
  readonly outbound: HostOutbound[] = []
  private readonly listeners: ((e: { data: unknown; ports?: readonly HostPortLike[] }) => void)[] = []

  postMessage(message: unknown): void {
    this.outbound.push(message as HostOutbound)
  }

  on(_event: 'message', listener: (e: { data: unknown; ports?: readonly HostPortLike[] }) => void): void {
    this.listeners.push(listener)
  }

  /** 模拟 main 发消息给 host */
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

/** 假的 host → renderer 数据面端口 */
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

  /** 模拟 renderer 回 ack / cancel */
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

/** 在指定通道上发一条 RPC 并等它的响应 */
async function callOn<M extends HostRequest['method']>(
  ch: FakeChannel,
  method: M,
  params: Extract<HostRequest, { method: M }>['params'],
): Promise<HostResponse> {
  ridSeq += 1
  const myRid = ridSeq
  ch.send({ kind: 'req', rid: myRid, method, params } as HostRequest)
  await waitFor(() => ch.responses().some((r) => r.rid === myRid), `RPC ${method} 的响应`)
  const res = ch.responses().find((r) => r.rid === myRid)
  assert.ok(res)
  return res
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 稳定一小会儿，用来断言"不该再来更多帧了" */
async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('driver host 协议', () => {
  let channel: FakeChannel
  let host: DriverHost
  let port: FakePort

  /**
   * 发一条 RPC 并等它的响应。
   * 这里不复用 callOn：M 还是类型变量时 `Extract<HostRequest, {method: M}>['params']`
   * 无法安全地转交给另一个泛型函数（TS 会把它摊成所有 params 的交集）。
   */
  async function call<M extends HostRequest['method']>(
    method: M,
    params: Extract<HostRequest, { method: M }>['params'],
  ): Promise<HostResponse> {
    ridSeq += 1
    const myRid = ridSeq
    channel.send({ kind: 'req', rid: myRid, method, params } as HostRequest)
    await waitFor(
      () => channel.responses().some((r) => r.rid === myRid),
      `RPC ${method} 的响应`,
    )
    const res = channel.responses().find((r) => r.rid === myRid)
    assert.ok(res)
    return res
  }

  /**
   * 表的真实行数。测试库是活库（其它进程会往里写），行数断言只能以 count(*) 为基准。
   * 走 query.run + 数据面读回，顺便证明这条链路本身是通的。
   */
  async function rowCountOf(table: string): Promise<number> {
    const resultId = newResultId()
    await call('query.run', { resultId, text: `SELECT count(*)::int4 AS n FROM ${table}` })
    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      'count 查询收尾',
    )
    const frame = port.chunks().find((f) => f.resultId === resultId)
    const n = frame?.cols[0]?.[0]
    assert.equal(typeof n, 'number', 'count(*) 必须回一个数字')
    return n as number
  }

  before(async () => {
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
  })

  it('ready 事件与 connect 响应带回能力集', () => {
    const ready = channel.events().find((e) => e.type === 'ready')
    assert.ok(ready)
    const statuses = channel.events().filter((e) => e.type === 'status').map((e) => e.status)
    assert.deepEqual(statuses, ['connecting', 'ready'])

    const connectRes = channel.responses().find((r) => r.method === 'connect')
    assert.ok(connectRes?.ok)
    const result = connectRes.result as HostResult<'connect'>
    assert.deepEqual([...result.capabilities].sort(), [
      'cancel', 'collectionScan', 'introspect', 'tabularQuery', 'valuePeek',
    ])
    assert.equal(result.serverInfo?.flavor, 'PostgreSQL')
    assert.equal(port.started, true, 'attachPort 后必须 start()')
  })

  it('introspect.children 走 RPC 返回 3 张表', async () => {
    const res = await call('introspect.children', { parentId: 'schema:public' })
    assert.ok(res.ok)
    const result = res.result as HostResult<'introspect.children'>
    assert.deepEqual(result.nodes.map((n) => n.name).sort(), ['account', 'harness', 'document'])
  })

  it('collection.scan 的结果只走 MessagePort，不走控制面', async () => {
    const expected = await rowCountOf('public.harness')
    const resultId = newResultId()
    const before = port.received.length
    const res = await call('collection.scan', {
      resultId,
      ref: { kind: 'relation', schema: 'public', name: 'harness' },
    })
    assert.ok(res.ok)
    const result = res.result as HostResult<'collection.scan'>
    assert.equal(result.resultId, resultId)
    // 控制面响应里没有任何行数据
    assert.deepEqual(Object.keys(result), ['resultId'])

    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      'result.done 事件',
    )
    const frames = port.chunks().slice(before)
    const mine = frames.filter((f) => f.resultId === resultId)
    assert.equal(mine.length, 1)
    assert.equal(mine[0]?.rowCount, expected)
    assert.ok(mine[0]?.done)
    assert.ok(mine[0]?.schema, '首帧带 schema')

    const schemaEvt = channel.events().find((e) => e.type === 'result.schema' && e.resultId === resultId)
    assert.ok(schemaEvt, 'main 侧应该收到 result.schema 用来填 ResultMeta')
  })

  it('ack 窗口生效：未确认帧达到 ACK_WINDOW 就停发', async () => {
    const resultId = newResultId()
    const res = await call('query.run', {
      resultId,
      text: 'SELECT i FROM generate_series(1, 200) AS i',
      chunkRows: 1,
    })
    assert.ok(res.ok)

    const mine = (): ChunkFrame[] => port.chunks().filter((f) => f.resultId === resultId)
    await waitFor(() => mine().length >= ACK_WINDOW, `前 ${ACK_WINDOW} 帧`)
    await settle()
    assert.equal(mine().length, ACK_WINDOW, `没有 ack 时最多只能发 ${ACK_WINDOW} 帧`)

    // 确认到 seq=1，窗口腾出 2 个位置
    port.send({ t: 'ack', resultId, seq: 1 })
    await waitFor(() => mine().length >= ACK_WINDOW + 2, '窗口推进后的新帧')
    await settle()
    assert.equal(mine().length, ACK_WINDOW + 2, '窗口只放行了腾出来的名额')

    // 收尾：一路 ack 到底，确认能正常 done
    let guard = 0
    while (!channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId)) {
      const last = mine().length - 1
      port.send({ t: 'ack', resultId, seq: last })
      await settle(20)
      guard += 1
      if (guard > 400) throw new Error('ack 推进异常，结果集没能收尾')
    }
    const done = channel.events().find((e) => e.type === 'result.done' && e.resultId === resultId)
    assert.equal(done?.type === 'result.done' ? done.rows : -1, 200)
  })

  it('renderer 从数据面发 cancel，长查询立刻被打断', async () => {
    const resultId = newResultId()
    const res = await call('query.run', { resultId, text: 'SELECT pg_sleep(30)' })
    assert.ok(res.ok)
    await settle(200)
    port.send({ t: 'cancel', resultId })

    await waitFor(
      () => channel.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      'result.error 事件',
      6000,
    )
    const evt = channel.events().find((e) => e.type === 'result.error' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.error' && evt.error.code === 'CANCELLED')
    const errMsg = port.received.find((m) => m.t === 'error' && m.resultId === resultId)
    assert.ok(errMsg?.t === 'error' && isPeekError(errMsg.error))
  })

  it('不支持的能力返回 UNSUPPORTED_CAPABILITY 而不是崩溃', async () => {
    const res = await call('vector.search', { resultId: newResultId(), collection: 'x', topK: 1 })
    assert.equal(res.ok, false)
    assert.ok(!res.ok && res.error.code === 'UNSUPPORTED_CAPABILITY')

    const kv = await call('keyvalue.get', { ref: { kind: 'redisValue', key: 'a' } })
    assert.ok(!kv.ok && kv.error.code === 'UNSUPPORTED_CAPABILITY')
  })

  it('value.peek 走 RPC 取回全量大值', async () => {
    const resultId: ResultId = newResultId()
    await call('query.run', { resultId, text: `SELECT repeat('m', 9000) AS big` })
    await waitFor(
      () => channel.events().some((e) => e.type === 'result.done' && e.resultId === resultId),
      '大值查询收尾',
    )
    const res = await call('value.peek', { ref: { kind: 'resultCell', resultId, row: 0, col: 0 } })
    assert.ok(res.ok)
    const result = res.result as HostResult<'value.peek'>
    assert.equal(result.value.data.length, 9000)
    assert.equal(result.value.eof, true)
  })

  it('数据面端口还没到就发起查询：cancel 能把泵叫醒，不留卡死的游标', async () => {
    // 这条路径是作者显式支持的（"端口还没到就等着，绝不丢帧"），
    // 但等待必须可打断，否则取消叫不醒泵，游标会一直占着连接和只读事务。
    const lonely = new FakeChannel()
    const lonelyHost = new DriverHost(lonely)
    const connected = await callOn(lonely, 'connect', { connId: newConnId(), config: CONFIG })
    assert.ok(connected.ok)

    const resultId = newResultId()
    // **不** attachPort，直接查
    const started = await callOn(lonely, 'query.run', { resultId, text: 'SELECT 1 AS a' })
    assert.ok(started.ok)
    await settle(100)
    assert.equal(
      lonely.events().some((e) => e.type === 'result.done' || e.type === 'result.error'),
      false,
      '没有数据面端口时不该产帧',
    )

    const cancelled = await callOn(lonely, 'cancel', { resultId })
    assert.ok(cancelled.ok)
    assert.deepEqual(cancelled.result, { cancelled: true })

    await waitFor(
      () => lonely.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      '取消后控制面必须收到 result.error（否则 main 侧永远停在 running）',
      3000,
    )
    const evt = lonely.events().find((e) => e.type === 'result.error' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.error' && evt.error.code === 'CANCELLED')
    await lonelyHost.dispose()
  })

  it('背压暂停超过空闲上限：主动收摊并报 paused（不是 error）', async () => {
    // 压住 ack 不放行，泵停在 waitWindow；超过 idleAckMs 就必须关游标、还连接，
    // 而不是无限期持有服务端资源（PLAN 第 8 节）。
    //
    // **收摊的结局必须是 paused**。早先这里 reject 一个 TIMEOUT PeekError，
    // 于是"按设计暂停"和真 SQL 错误挤在同一个 error 分支里，
    // AI 通过 MCP 拿到回执时分不清「查询挂了」和「只是停下来了、数据是好的」。
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

    await waitFor(() => idlePort.chunks().length >= ACK_WINDOW, `前 ${ACK_WINDOW} 帧`)
    await waitFor(
      () => idle.events().some((e) => e.type === 'result.paused' && e.resultId === resultId),
      '空闲超时后的 result.paused',
      3000,
    )

    // 控制面：paused 事件带够 main 迁移状态机所需的一切
    const evt = idle.events().find((e) => e.type === 'result.paused' && e.resultId === resultId)
    assert.ok(evt?.type === 'result.paused')
    assert.equal(evt.paused.reason, 'idleAck')
    assert.equal(evt.paused.resumable, true)
    assert.equal(evt.paused.rows, ACK_WINDOW, '已发出的行数如实汇报')
    assert.ok(evt.paused.elapsedMs >= 0)

    // 绝不能同时再报一条 error —— 那正是本轮要拆掉的混流
    assert.equal(
      idle.events().some((e) => e.type === 'result.error' && e.resultId === resultId),
      false,
      '暂停不得走 error 分支',
    )
    assert.equal(
      idlePort.received.some((m) => m.t === 'error' && m.resultId === resultId),
      false,
      '数据面也不得收到 error',
    )

    // 数据面：一条 paused 消息，renderer 据此把状态改成"已暂停"而不是红色错误
    const pausedMsg = idlePort.received.find((m) => m.t === 'paused' && m.resultId === resultId)
    assert.ok(pausedMsg?.t === 'paused' && pausedMsg.paused.resumable === true)

    assert.equal(idlePort.chunks().length, ACK_WINDOW, '收摊前不会偷偷多发帧')
    await idleHost.dispose()
  })

  it('暂停之后游标已释放：再补 ack 也不会又吐帧出来', async () => {
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
    assert.equal(idlePort.chunks().length, framesAtPause, '暂停是终态，迟到的 ack 不复活它')
    await idleHost.dispose()
  })

  it('未连接时的请求返回 CONFLICT，不留悬挂 Promise', async () => {
    const lonely = new FakeChannel()
    const lonelyHost = new DriverHost(lonely)
    lonely.send({ kind: 'req', rid: 1, method: 'introspect.children', params: { parentId: null } })
    await waitFor(() => lonely.responses().length > 0, '未连接时的响应')
    const res = lonely.responses()[0]
    assert.ok(res && !res.ok && res.error.code === 'CONFLICT')
    await lonelyHost.dispose()
  })
})
