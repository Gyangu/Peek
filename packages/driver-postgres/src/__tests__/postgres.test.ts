import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  isPeekError,
  isTruncatedValue,
  newResultId,
  type ChunkFrame,
  type Cursor,
  type PostgresConnectionConfig,
} from '@peek/core'
import { PostgresSession } from '../session'
import { nodeId } from '../introspect'

/**
 * 真实库联调：postgresql://postgres@localhost:5432/postgres
 * 覆盖 introspect / collectionScan / tabularQuery 流式分帧 / 大值截断 + valuePeek /
 * cancel / 超时。
 */

const TEST_URL = process.env['PEEK_TEST_PG_URL'] ?? 'postgresql://postgres@localhost:5432/postgres'

const CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: TEST_URL,
  applicationName: 'peek-test',
}

/** 把一个游标抽干，收集所有帧 */
async function drain(cursor: Cursor): Promise<ChunkFrame[]> {
  const frames: ChunkFrame[] = []
  for (;;) {
    const frame = await cursor.next()
    if (frame === null) break
    frames.push(frame)
    if (frame.done) break
  }
  return frames
}

/** 校验帧序列本身是否合法（seq 连续、schema 只在首帧、末帧带 done） */
function assertFrameProtocol(frames: ChunkFrame[]): void {
  assert.ok(frames.length > 0, '至少要有一帧')
  frames.forEach((f, i) => {
    assert.equal(f.seq, i, 'seq 必须从 0 连续递增')
    if (i === 0) assert.ok(f.schema, '首帧必须带 schema')
    else assert.equal(f.schema, undefined, '非首帧不得重复 schema')
    const cols = f.cols
    assert.equal(cols.length, frames[0]?.schema?.length, 'cols 数必须等于列数')
    for (const col of cols) assert.equal(col.length, f.rowCount, '每列长度必须等于 rowCount')
  })
  const last = frames[frames.length - 1]
  assert.ok(last?.done, '末帧必须带 done')
  for (const f of frames.slice(0, -1)) assert.equal(f.done, undefined, '只有末帧能带 done')
}

describe('driver-postgres 真实库联调', () => {
  let session: PostgresSession

  /**
   * 表的真实行数。测试库是一个活库（其它进程会往里写），
   * 所以行数断言不能写死数字，只能拿服务端自己的 count(*) 当基准。
   */
  async function rowCountOf(table: string): Promise<number> {
    const frames = await drain(
      await session.query({ resultId: newResultId(), text: `SELECT count(*)::int4 AS n FROM ${table}` }),
    )
    const n = frames[0]?.cols[0]?.[0]
    assert.equal(typeof n, 'number', 'count(*) 必须回一个数字')
    return n as number
  }

  before(async () => {
    session = await PostgresSession.connect(CONFIG)
  })

  after(async () => {
    await session?.close()
  })

  it('连上后能力集与 core 的 DRIVER_CAPABILITIES.postgres 一致', () => {
    assert.deepEqual(
      [...session.capabilities].sort(),
      ['cancel', 'collectionScan', 'introspect', 'tabularQuery', 'valuePeek'],
    )
    assert.equal(session.serverInfo.flavor, 'PostgreSQL')
    assert.match(session.serverInfo.version, /^\d+/)
  })

  /* -------------------- introspect：懒加载三层 -------------------- */

  it('根层只返回当前库，逐层懒加载', async () => {
    const roots = await session.listChildren(null)
    assert.equal(roots.length, 1)
    assert.equal(roots[0]?.kind, 'database')
    // 库名从 TEST_URL 推导——测试库可由 PEEK_TEST_PG_URL 覆盖，不能写死
    assert.equal(roots[0]?.name, new URL(TEST_URL).pathname.slice(1))
    assert.equal(roots[0]?.hasChildren, true)

    const schemas = await session.listChildren(roots[0]?.id ?? '')
    const names = schemas.map((s) => s.name)
    assert.ok(names.includes('public'), `schema 层应含 public，实际 ${names.join(',')}`)
    assert.equal(names[0], 'public', 'public 排最前')
    for (const s of schemas) assert.equal(s.kind, 'schema')
  })

  it('public schema 下正好 3 张表，且带可直接 open 的 ref', async () => {
    const tables = await session.listChildren(nodeId.schema('public'))
    assert.deepEqual(tables.map((t) => t.name).sort(), ['account', 'harness', 'document'])
    for (const t of tables) {
      assert.equal(t.kind, 'table')
      assert.equal(t.hasChildren, false, '表是叶子节点，列走 describeCollection')
      assert.deepEqual(t.ref, { kind: 'relation', schema: 'public', name: t.name })
    }
  })

  it('describeCollection 给出列定义与主键', async () => {
    const info = await session.describeCollection({
      kind: 'relation',
      schema: 'public',
      name: 'harness',
    })
    assert.deepEqual(info.columns.map((c) => c.name), ['id', 'account_id', 'created_at', 'name'])
    assert.deepEqual(info.primaryKey, ['id'])
    const createdAt = info.columns.find((c) => c.name === 'created_at')
    assert.equal(createdAt?.logical, 'timestamp')
    assert.equal(createdAt?.nativeType, 'timestamptz')
    assert.equal(info.columns.find((c) => c.name === 'id')?.primaryKey, true)
    assert.ok((info.indexes?.length ?? 0) >= 1)
  })

  it('非 relation 的 CollectionRef 被拒', async () => {
    await assert.rejects(
      () => session.describeCollection({ kind: 'keyPattern', pattern: '*' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* -------------------- collectionScan -------------------- */

  it('harness 表扫出的行数与 count(*) 一致，首帧 schema 带主键标记', async () => {
    const expected = await rowCountOf('public.harness')
    assert.ok(expected > 0, '测试库里 harness 不该是空表')
    const cursor = await session.scan({ resultId: newResultId(), ref: { kind: 'relation', schema: 'public', name: 'harness' } })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    const total = frames.reduce((n, f) => n + f.rowCount, 0)
    assert.equal(total, expected, '扫描必须把表里的行一行不多一行不少地吐出来')
    assert.equal(frames[frames.length - 1]?.done?.rows, expected)
    const schema = frames[0]?.schema ?? []
    assert.deepEqual(schema.map((c) => c.name), ['id', 'account_id', 'created_at', 'name'])
    assert.equal(schema.find((c) => c.name === 'id')?.primaryKey, true)
    assert.equal(schema.find((c) => c.name === 'created_at')?.nullable, false)
  })

  it('筛选走参数化，注入串只会被当成普通值', async () => {
    const cursor = await session.scan({
      resultId: newResultId(),
      ref: { kind: 'relation', schema: 'public', name: 'harness' },
      filter: [{ column: 'name', op: 'eq', value: "no-such-name'; DROP TABLE harness; --" }],
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames[frames.length - 1]?.done?.rows, 0, '空结果集也要发一帧带 done')
    assert.equal(frames[0]?.rowCount, 0)
    // 表还在：说明注入没生效
    const after = await session.describeCollection({ kind: 'relation', schema: 'public', name: 'harness' })
    assert.equal(after.columns.length, 4)
  })

  it('分页给出 nextCursor，可续拉下一页', async () => {
    const ref = { kind: 'relation', schema: 'public', name: 'harness' } as const
    const first = await drain(await session.scan({ resultId: newResultId(), ref, limit: 2, sort: [{ column: 'id', dir: 'asc' }] }))
    const done = first[first.length - 1]?.done
    assert.equal(done?.rows, 2)
    assert.equal(done?.nextCursor, '2')

    const second = await drain(await session.scan({
      resultId: newResultId(),
      ref,
      limit: 2,
      sort: [{ column: 'id', dir: 'asc' }],
      cursorToken: done?.nextCursor ?? '0',
    }))
    assert.equal(second[second.length - 1]?.done?.rows, 2)
    const firstIds = first.flatMap((f) => f.cols[0] ?? [])
    const secondIds = second.flatMap((f) => f.cols[0] ?? [])
    assert.equal(firstIds.length, 2)
    assert.notDeepEqual(firstIds, secondIds, '第二页必须是不同的行')
  })

  /* -------------------- tabularQuery：真流式 -------------------- */

  it('5000 行按 chunkRows 分成多帧流式返回', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: `SELECT i, repeat('a', 40) AS pad FROM generate_series(1, 5000) AS i`,
      chunkRows: 500,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames.length, 10, '5000 行 / 500 每帧 = 10 帧')
    for (const f of frames) assert.equal(f.rowCount, 500)
    assert.equal(frames[frames.length - 1]?.done?.rows, 5000)
    assert.equal(frames[0]?.schema?.[0]?.logical, 'number')
  })

  it('不指定 chunkRows 时按行宽自适应，同样是多帧', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: `SELECT i, repeat('b', 300) AS pad FROM generate_series(1, 4000) AS i`,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.ok(frames.length >= 2, `应该分帧，实际 ${frames.length} 帧`)
    assert.equal(frames.reduce((n, f) => n + f.rowCount, 0), 4000)
    // 自适应下每帧行数落在 core 的 500–2000 预算区间
    for (const f of frames.slice(0, -1)) {
      assert.ok(f.rowCount >= 500 && f.rowCount <= 2000, `帧行数 ${f.rowCount} 超出预算区间`)
    }
  })

  it('maxRows 截断时 done.truncated 为 true', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT i FROM generate_series(1, 1000) AS i',
      chunkRows: 100,
      maxRows: 250,
    })
    const frames = await drain(cursor)
    assertFrameProtocol(frames)
    assert.equal(frames[frames.length - 1]?.done?.rows, 250)
    assert.equal(frames[frames.length - 1]?.done?.truncated, true)
  })

  it('查询参数走 $n，不拼字符串', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT $1::int AS a, $2::text AS b',
      params: [42, "it's fine"],
    })
    const frames = await drain(cursor)
    assert.equal(frames[0]?.cols[0]?.[0], 42)
    assert.equal(frames[0]?.cols[1]?.[0], "it's fine")
  })

  it('不能建游标的语句退化成一次性查询，帧契约与服务端超时都还在', async () => {
    // DECLARE 只接受 SELECT / VALUES / TABLE，EXPLAIN 会失败并把事务打成 aborted；
    // 退化路径要重开事务，超时保险也必须跟着重上一遍
    const explained = await drain(await session.query({ resultId: newResultId(), text: 'EXPLAIN SELECT 1' }))
    assertFrameProtocol(explained)
    assert.ok((explained[explained.length - 1]?.done?.rows ?? 0) > 0, 'EXPLAIN 至少有一行计划')

    const shown = await drain(
      await session.query({ resultId: newResultId(), text: 'SHOW statement_timeout', timeoutMs: 4321 }),
    )
    assertFrameProtocol(shown)
    assert.equal(shown[0]?.cols[0]?.[0], '4321ms', '退化路径里 statement_timeout 仍然生效')
  })

  it('语法错误映射成 SYNTAX_ERROR 并带 position', async () => {
    await assert.rejects(
      () => session.query({ resultId: newResultId(), text: 'SELEC 1' }),
      (err: unknown) => {
        assert.ok(isPeekError(err))
        assert.equal(err.code, 'SYNTAX_ERROR')
        assert.equal(err.driverCode, '42601')
        assert.ok((err.position ?? 0) > 0)
        return true
      },
    )
  })

  it('表不存在映射成 NOT_FOUND', async () => {
    await assert.rejects(
      () => session.query({ resultId: newResultId(), text: 'SELECT * FROM no_such_table_xyz' }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND' && err.driverCode === '42P01',
    )
  })

  /* -------------------- 大值截断 + valuePeek -------------------- */

  it('超 4KB 的值只发预览，valuePeek 能取回全量', async () => {
    const resultId = newResultId()
    const cursor = await session.query({
      resultId,
      text: `SELECT repeat('z', 10000) AS big, 1 AS small`,
    })
    const frames = await drain(cursor)
    const cell = frames[0]?.cols[0]?.[0]
    assert.ok(isTruncatedValue(cell), '大值必须被标记成 TruncatedValue')
    assert.equal(cell.byteLength, 10000)
    assert.equal(cell.preview.length, 4096)
    assert.deepEqual(cell.ref, { kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(frames[0]?.schema?.[0]?.peekable, true)

    const full = await session.peekValue(cell.ref ?? { kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(full.encoding, 'utf8')
    assert.equal(full.data.length, 10000)
    assert.equal(full.totalBytes, 10000)
    assert.equal(full.eof, true)
  })

  it('valuePeek 支持字节区间，切片在服务端完成', async () => {
    const resultId = newResultId()
    await drain(await session.query({ resultId, text: `SELECT repeat('q', 20000) AS big` }))
    const ref = { kind: 'resultCell', resultId, row: 0, col: 0 } as const
    const part = await session.peekValue(ref, { offset: 100, length: 50 })
    assert.equal(part.data, 'q'.repeat(50))
    assert.equal(part.byteLength, 50)
    assert.equal(part.totalBytes, 20000)
    assert.equal(part.eof, false)
  })

  it('valuePeek 按主键回源关系表单元格', async () => {
    const idCursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT id, name FROM public.harness ORDER BY id LIMIT 1',
    })
    const frames = await drain(idCursor)
    const id = frames[0]?.cols[0]?.[0]
    const name = frames[0]?.cols[1]?.[0]
    assert.equal(typeof id, 'string')

    const peeked = await session.peekValue({
      kind: 'relationCell',
      collection: { kind: 'relation', schema: 'public', name: 'harness' },
      pk: { id },
      column: 'name',
    })
    assert.equal(peeked.data, name)
    assert.equal(peeked.eof, true)
  })

  it('bytea 走 base64', async () => {
    const resultId = newResultId()
    const frames = await drain(await session.query({
      resultId,
      text: `SELECT decode('48656c6c6f', 'hex') AS b`,
    }))
    assert.equal(frames[0]?.schema?.[0]?.logical, 'bytes')
    assert.equal(frames[0]?.cols[0]?.[0], Buffer.from('Hello').toString('base64'))
    const peeked = await session.peekValue({ kind: 'resultCell', resultId, row: 0, col: 0 })
    assert.equal(peeked.encoding, 'base64')
    assert.equal(Buffer.from(peeked.data, 'base64').toString('utf8'), 'Hello')
  })

  it('失效的 resultId 回源报 NOT_FOUND', async () => {
    await assert.rejects(
      () => session.peekValue({ kind: 'resultCell', resultId: newResultId(), row: 0, col: 0 }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  /* -------------------- cancel / timeout -------------------- */

  it('cancel 真的打断执行中的长查询', async () => {
    const resultId = newResultId()
    const cursor = await session.query({ resultId, text: 'SELECT pg_sleep(30)' })
    // 立刻接住 rejection：取消可能在 session.cancel() 还没返回时就打断 FETCH，
    // 裸着的 rejected promise 会被 node:test 记成 unhandled rejection
    const pending = cursor.next().then(
      () => null,
      (err: unknown) => err,
    )
    // 让 FETCH 真的发出去再取消
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    assert.equal(await session.cancel(resultId), true)
    const outcome = await pending
    assert.ok(
      isPeekError(outcome) && outcome.code === 'CANCELLED',
      `取消后 next() 必须以 CANCELLED 失败，实际是 ${JSON.stringify(outcome)}`,
    )
    assert.ok(Date.now() - t0 < 5000, '取消必须立刻生效，而不是等查询自然结束')
    assert.equal(await session.cancel(resultId), false, '重复取消返回 false 且不抛错')
  })

  it('timeoutMs 到点映射成 TIMEOUT', async () => {
    const cursor = await session.query({
      resultId: newResultId(),
      text: 'SELECT pg_sleep(30)',
      timeoutMs: 300,
    })
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.code === 'TIMEOUT',
    )
  })

  it('长查询被取消后连接仍可用', async () => {
    await session.ping()
    const frames = await drain(await session.query({ resultId: newResultId(), text: 'SELECT 1 AS ok' }))
    assert.equal(frames[0]?.cols[0]?.[0], 1)
  })
})

describe('建连失败分类', () => {
  it('库不存在 → CONNECTION_FAILED', async () => {
    await assert.rejects(
      () => PostgresSession.connect({
        driverId: 'postgres',
        url: 'postgresql://postgres@localhost:5432/no_such_db_xyz_peek',
        connectTimeoutMs: 3000,
      }),
      (err: unknown) => isPeekError(err) && err.code === 'CONNECTION_FAILED',
    )
  })

  it('端口不通 → CONNECTION_FAILED 且 retryable', async () => {
    await assert.rejects(
      () => PostgresSession.connect({
        driverId: 'postgres',
        url: 'postgresql://postgres@127.0.0.1:1/whatever',
        connectTimeoutMs: 2000,
      }),
      (err: unknown) => isPeekError(err) && err.code === 'CONNECTION_FAILED' && err.retryable === true,
    )
  })
})
