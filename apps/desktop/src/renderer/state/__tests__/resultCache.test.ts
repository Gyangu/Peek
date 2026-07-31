import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  VALUE_PREVIEW_BYTES,
  asConnId,
  asResultId,
  peekError,
  truncatedValue,
  type ChunkFrame,
  type ColumnDef,
  type ResultId,
} from '@peek/core'

/* ==================================================================
 * BLOCKER 2 / MAJOR / MINOR 的回归网。
 *
 * resultCache 是纯 TS 模块（不是 React 状态），只依赖 requestAnimationFrame 与
 * MessagePort 两个 DOM 面。这里给它们最小替身，就能在 node:test 里
 * 逐帧驱动整条 ack 背压链路。
 * ================================================================== */

/* ---- DOM 替身：必须在 import resultCache 之前装好 ---- */
const rafQueue: (() => void)[] = []
;(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number })
  .requestAnimationFrame = (cb: () => void): number => {
    rafQueue.push(cb)
    return rafQueue.length
  }
function flushRaf(): void {
  const q = rafQueue.splice(0, rafQueue.length)
  for (const cb of q) cb()
}

interface Posted {
  t: string
  seq?: number
  resultId?: string
}

/** 假的数据面端口：记录 renderer 回给 host 的 ack / cancel */
class FakePort {
  readonly posted: Posted[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  started = false

  postMessage(msg: unknown): void {
    this.posted.push(msg as Posted)
  }

  start(): void {
    this.started = true
  }

  close(): void {}

  /** 模拟 host 发一条数据面消息过来 */
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }

  acks(): number[] {
    return this.posted.filter((m) => m.t === 'ack').map((m) => m.seq ?? -1)
  }
}

const cache = await import('../resultCache')

const SCHEMA: ColumnDef[] = [
  { name: 'i', logical: 'number', nativeType: 'int4' },
  { name: 'label', logical: 'string', nativeType: 'text' },
]

let seqCounter = 0

function frame(resultId: ResultId, rows: number, opts: { first?: boolean; done?: boolean } = {}): ChunkFrame {
  const seq = seqCounter++
  const ints: number[] = []
  const labels: string[] = []
  for (let i = 0; i < rows; i += 1) {
    ints.push(i)
    labels.push('x')
  }
  return {
    resultId,
    seq,
    ...(opts.first ? { schema: SCHEMA } : {}),
    cols: [ints, labels],
    rowCount: rows,
    ...(opts.done ? { done: { rows, elapsedMs: 5 } } : {}),
  }
}

interface Rig {
  port: FakePort
  id: ResultId
  /** 推 n 个 1000 行的 chunk 进来 */
  push(n: number): void
}

function rig(): Rig {
  const connId = asConnId(`conn_${Math.random().toString(36).slice(2)}`)
  const id = asResultId(`res_${Math.random().toString(36).slice(2)}`)
  const port = new FakePort()
  seqCounter = 0
  cache.attachResultPort(connId, port as unknown as MessagePort)
  return {
    port,
    id,
    push(n: number): void {
      for (let k = 0; k < n; k += 1) {
        port.deliver({ t: 'chunk', frame: frame(id, 1000, { first: seqCounter === 0 }) })
      }
      flushRaf()
    },
  }
}

beforeEach(() => {
  rafQueue.length = 0
})

/** 把 Date.now 整体往前拨 ms 跑一段（模拟"视口上报停了这么久"），跑完复位 */
function withClockSkew<T>(ms: number, fn: () => T): T {
  const real = Date.now
  Date.now = (): number => real.call(Date) + ms
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

/* ================================================================== */

describe('MINOR —— 背压行为与 React 渲染时序解耦', () => {
  it('结果集一建立就有确定的默认视口，不必等表格渲染出来', () => {
    const r = rig()
    // 从未调用过 setViewport：旧实现此时 viewport===null，行数规则被整段跳过
    r.push(250) // 25 万行，超过 AHEAD_ROWS=20 万
    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.rowCount, 250_000)
    // 默认视口 {0,0,atBottom:false} ⇒ 前方 25 万行没人看 ⇒ 必须压住
    assert.ok(r.port.acks().length < 250, `应当在半路压住 ack，实际全放行了 ${r.port.acks().length} 次`)
    const held = r.port.acks().length
    assert.ok(held > 0 && held < 250, `压在中途而不是一开始就死锁（实际 ack ${held} 次）`)
    cache.dropResult(r.id)
  })

  it('压住的位置只由行数决定，可预测：正好在越过 AHEAD_ROWS 的那一帧', () => {
    const r = rig()
    r.push(250)
    const acks = r.port.acks()
    const lastAck = acks[acks.length - 1]
    // AHEAD_ROWS = 200_000，每帧 1000 行 ⇒ 第 201 帧（seq=200）落地后 rowCount=201000
    // 此时 201000 - 0 > 200000 成立，从这一帧开始 hold
    assert.equal(lastAck, 199, `应当停在 seq=199（20 万行整），实际 ${lastAck}`)
    cache.dropResult(r.id)
  })
})

describe('视口暂存表：视图先于首帧挂载，也不能留垃圾', () => {
  it('一帧都没到过的结果集被回收后，暂存的视口不会跟着遗留', () => {
    const connId = asConnId('conn_ghost')
    const ghost = asResultId('res_ghost')
    const port = new FakePort()
    cache.attachResultPort(connId, port as unknown as MessagePort)

    // 视图挂载即上报视口，此时结果集连 entry 都还没有 ⇒ 进暂存表
    cache.setViewport(ghost, 0, 26, true)
    // 视图被关掉；main 的 results 里从来没有过它
    cache.dropResult(ghost)
    cache.pruneResults(new Set())

    // 万一同一个 id 后来真的来了帧，绝不能捡起那份过期的 atBottom 视口
    // （否则行数背压会被一条早就作废的记录悄悄关掉）
    seqCounter = 0
    for (let seq = 0; seq < 250; seq += 1) {
      port.deliver({ t: 'chunk', frame: frame(ghost, 1000, { first: seq === 0 }) })
    }
    flushRaf()
    assert.ok(
      port.acks().length < 250,
      `暂存视口已失效，必须回到默认视口的行数规则（实际放行 ${port.acks().length}/250）`,
    )
    cache.dropResult(ghost)
  })
})

describe('BLOCKER 2 —— 视口推进释放 ack', () => {
  it('视口往前走，被压住的 ack 立刻放行', () => {
    const r = rig()
    r.push(250)
    const before = r.port.acks().length
    // 用户滚到 10 万行处
    cache.setViewport(r.id, 100_000, 100_026, false)
    assert.ok(r.port.acks().length > before, '视口前移必须放行 ack')
    cache.dropResult(r.id)
  })

  it('视口贴到可滚动末端时不再按行数压 ack —— 「视口推不动」不能把流饿死', () => {
    const r = rig()
    r.push(250)
    assert.ok(r.port.acks().length < 250, '前提：此刻确实被压住了')

    // 表格已经滚到最后一行，物理上推不动了。
    // 注意 end 仍然远远落后于 rowCount（视口只有 27 行），
    // 单看 `rowCount - end > AHEAD_ROWS` 这条规则依然成立 —— 必须靠 atBottom 兜底。
    cache.setViewport(r.id, 0, 26, true)
    const released = r.port.acks().length
    assert.ok(released > 0)

    // 继续推流：atBottom 期间一路放行，不再中途卡死
    r.push(50)
    const acks = r.port.acks()
    assert.equal(acks[acks.length - 1], 299, '最后一帧也被 ack')
    assert.equal(acks.filter((s) => s >= 250).length, 50, 'atBottom 期间每一帧都被 ack')
    cache.dropResult(r.id)
  })

  it('字节水位那道闸在 4KB 截断约束下也够得着 —— 宽行撑爆受保护集', () => {
    /*
     * 这条测试刻意按**端到端真实存在的形态**构造，不再用一格 15,000 字符的
     * 假数据（驱动侧单格超 VALUE_PREVIEW_BYTES=4KB 一律截断成预览，那种值到不了 renderer）：
     *   - 每格都是 TruncatedValue，preview 正好 4KB —— 驱动能产出的最大单格；
     *   - 40 列（宽表，jsonb / text 多的库很常见）⇒ 40 × (4096×2+96) ≈ 324KB/行；
     *   - 每 chunk 3 行 ≈ 974KB，落在 PLAN 的 chunk 目标区间 256KB–1MB 内。
     * 于是 ~190 个 chunk 就把视口保护范围（±3000 行，这里全部 720 行都在里面）
     * 顶到 ACK_HOLD_BYTES=180MB 之上，enforceBudget 一个字节都淘汰不掉，
     * 字节闸必须独立把 ack 压住。
     *
     * 反过来也说明它的适用面很窄：窄表几千行连零头都够不到，
     * "视口不再推进"只能靠行数闸 + atBottom 保鲜期管，不能指望字节闸兜底。
     */
    const connId = asConnId('conn_bytes')
    const id = asResultId('res_bytes')
    const port = new FakePort()
    cache.attachResultPort(connId, port as unknown as MessagePort)
    cache.setViewport(id, 0, 26, true) // atBottom：行数规则已被关掉

    const wide: ColumnDef[] = []
    for (let c = 0; c < 40; c += 1) wide.push({ name: `t${c}`, logical: 'string', nativeType: 'text' })
    // 驱动能发出的最大单格：预览正好截到 VALUE_PREVIEW_BYTES
    const cell = truncatedValue('z'.repeat(VALUE_PREVIEW_BYTES), 'utf8', { byteLength: 9_000_000 })
    const col = [cell, cell, cell]
    const cols = wide.map(() => col)

    const CHUNKS = 240
    for (let seq = 0; seq < CHUNKS; seq += 1) {
      port.deliver({
        t: 'chunk',
        frame: {
          resultId: id,
          seq,
          ...(seq === 0 ? { schema: wide } : {}),
          cols,
          rowCount: 3,
        } satisfies ChunkFrame,
      })
    }
    flushRaf()
    const acked = port.acks().length
    assert.ok(acked > 0, '一开始（远未到水位）必须放行')
    assert.ok(
      acked < CHUNKS,
      `受保护集超过 180MB 之后字节水位必须独立压住 ack（实际放行 ${acked}/${CHUNKS}）`,
    )
    // 压住的位置可预测：180MB / 每 chunk ~974KB ≈ 190 帧上下
    assert.ok(acked > 150 && acked < 230, `压在水位处而不是别的地方（实际 ${acked}）`)
    cache.dropResult(id)
  })
})

describe('BLOCKER 2 续 —— atBottom 是会失效的信号，不是只进不出的闩', () => {
  it('新鲜的 atBottom 才放行；上报中断超过保鲜期，行数闸重新接管', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true) // 视口贴在末端
    r.push(250) // 25 万行：atBottom 新鲜 ⇒ 一路放行
    assert.equal(r.port.acks().length, 250, '前提：新鲜的 atBottom 确实关掉了行数闸')

    // 表格卸载 / rAF 被 backgroundThrottling 掐掉 / 主线程卡死：上报就此停了。
    // 旧实现里 viewport 冻结在 atBottom:true，这条流会全速扫完整张表。
    withClockSkew(10_000, () => {
      r.push(50)
    })
    assert.equal(
      r.port.acks().length,
      250,
      `上报停了 10 秒之后一帧都不该再放行（实际 ${r.port.acks().length}）`,
    )

    // 消费者回来了（窗口重新可见 / 用户滚动）：被压住的 ack 立刻放行，流可以继续
    cache.setViewport(r.id, 0, 26, true)
    const acks = r.port.acks()
    assert.equal(acks[acks.length - 1], 299, '恢复上报后必须补上最后一个被压住的 seq')
    cache.dropResult(r.id)
  })

  it('位置没变的重复上报也要续保鲜期（不能因为"值没变"就早退）', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true)
    r.push(250)
    // 10 秒后又报了一次**一模一样**的视口：值没变，但消费者确实还活着
    withClockSkew(10_000, () => {
      cache.setViewport(r.id, 0, 26, true)
    })
    withClockSkew(11_000, () => {
      r.push(20)
    })
    assert.equal(r.port.acks().length, 270, '距最近一次上报只过了 1 秒，仍在保鲜期内')
    cache.dropResult(r.id)
  })

  it('显式撤销 atBottom（DataGrid 卸载时补的那条）当场恢复行数闸，不必等保鲜期', () => {
    const r = rig()
    cache.setViewport(r.id, 0, 26, true)
    r.push(250)
    assert.equal(r.port.acks().length, 250)

    cache.setViewport(r.id, 0, 26, false) // ← DataGrid 卸载 / 换结果集时的那一条
    r.push(50)
    assert.equal(r.port.acks().length, 250, '撤销之后一帧都不该再放行')
    cache.dropResult(r.id)
  })
})

describe('MAJOR —— paused 是终态，不是错误', () => {
  it('收到 t:paused：状态变 paused，已落地的行一行不丢，error 保持为空', () => {
    const r = rig()
    r.push(10)
    const rowsBefore = cache.getResultSnapshot(r.id).rowCount

    r.port.deliver({
      t: 'paused',
      resultId: r.id,
      paused: {
        rows: rowsBefore,
        elapsedMs: 1234,
        reason: 'idleAck',
        message: '结果流已暂停：60 秒没有新的消费确认，已释放服务端游标与连接',
        resumable: true,
      },
    })
    flushRaf()

    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.status, 'paused')
    assert.equal(snap.error, null, 'paused 绝不能顺手塞一个 error 进去')
    assert.equal(snap.rowCount, rowsBefore, '已加载的行必须原样保留')
    assert.equal(snap.paused?.resumable, true)
    assert.equal(snap.paused?.rows, rowsBefore)
    // 数据仍然可读
    assert.equal(cache.getCell(r.id, 5, 0), 5)
    assert.equal(cache.isRowLoaded(r.id, 9999), true)
    cache.dropResult(r.id)
  })

  it('真错误仍然落到 error，两条路径不混流', () => {
    const r = rig()
    r.push(2)
    r.port.deliver({
      t: 'error',
      resultId: r.id,
      error: peekError('QUERY_FAILED', 'relation "nope" does not exist'),
    })
    flushRaf()
    const snap = cache.getResultSnapshot(r.id)
    assert.equal(snap.status, 'error')
    assert.equal(snap.paused, null)
    assert.equal(snap.error?.code, 'QUERY_FAILED')
    cache.dropResult(r.id)
  })

  it('已经 paused 之后再来的 done/paused 不会把状态改回去', () => {
    const r = rig()
    r.push(2)
    const pause = {
      rows: 2000,
      elapsedMs: 1,
      reason: 'idleAck' as const,
      message: 'x',
      resumable: true as const,
    }
    r.port.deliver({ t: 'paused', resultId: r.id, paused: pause })
    r.port.deliver({ t: 'paused', resultId: r.id, paused: { ...pause, rows: 99 } })
    flushRaf()
    assert.equal(cache.getResultSnapshot(r.id).paused?.rows, 2000, '第一次暂停说了算')
    cache.dropResult(r.id)
  })
})
