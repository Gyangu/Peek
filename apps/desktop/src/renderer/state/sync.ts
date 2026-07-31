import type { ColumnDef, ResultRowsRequestMessage } from '@peek/core'
import { tryBridge } from '../bridge'
import { attachResultPort, getCell, getResultSnapshot, isPendingCell, pruneResults } from './resultCache'
import { startWorkspaceSync, useWorkspaceStore } from './workspaceStore'

/**
 * renderer 侧的全部接线，在模块加载阶段执行一次。
 * 刻意不放在 React effect 里：StrictMode 会双跑 effect，
 * 而 MessagePort 订阅、patch 订阅都必须是单例。
 */

let started = false

/** 结果集缓存的定期回收间隔 */
const PRUNE_INTERVAL_MS = 15_000

export function startRenderer(): void {
  if (started) return
  started = true

  startWorkspaceSync()

  const bridge = tryBridge()
  if (bridge) {
    // 数据面：每个连接一个 MessagePort，chunk 由 driver host 直发，不过 main
    bridge.onResultPort((msg, port) => {
      attachResultPort(msg.connId, port)
    })

    // main 手里没有行数据（chunk 不经过它），MCP 的 run_query 要样本行时反过来问我们
    bridge.onResultRowsRequest?.(handleRowsRequest)
  }

  // main 已经忘掉的结果集，renderer 缓存也放掉（内存不能只涨不落）
  const prune = (): void => {
    const ws = useWorkspaceStore.getState().workspace
    if (!ws) return
    pruneResults(new Set(Object.keys(ws.results)))
  }
  useWorkspaceStore.subscribe(prune)
  setInterval(prune, PRUNE_INTERVAL_MS)
}

/* ==================================================================== */
/* 结果集取样（应答 main 的 RESULT_ROWS_REQUEST）                          */
/* ==================================================================== */

/** 一次最多给出去多少行，防止 AI 端上下文被撑爆（main 侧还会再收一次 limit） */
const MAX_SAMPLE_ROWS = 200

function handleRowsRequest(msg: ResultRowsRequestMessage): void {
  const bridge = tryBridge()
  const reply = bridge?.replyResultRows
  if (!bridge || !reply) return

  try {
    const snap = getResultSnapshot(msg.resultId)
    const columns: ColumnDef[] = snap.schema ? [...snap.schema] : []
    const limit = Math.max(0, Math.min(msg.limit, MAX_SAMPLE_ROWS, snap.rowCount))

    const rows: unknown[][] = []
    for (let r = 0; r < limit; r += 1) {
      const row: unknown[] = new Array<unknown>(columns.length)
      for (let c = 0; c < columns.length; c += 1) {
        const cell = getCell(msg.resultId, r, c)
        // 已被 LRU 淘汰的行给 null，而不是把哨兵 Symbol 送过 IPC（不可结构化克隆）
        row[c] = isPendingCell(cell) ? null : toTransferable(cell)
      }
      rows.push(row)
    }

    reply.call(bridge, {
      requestId: msg.requestId,
      ok: true,
      columns,
      rows,
      totalRows: snap.rowCount,
      truncated: snap.rowCount > rows.length,
    })
  } catch (error) {
    reply.call(bridge, {
      requestId: msg.requestId,
      ok: false,
      error: {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : '取样失败',
      },
    })
  }
}

/**
 * IPC 走结构化克隆，函数 / Symbol / 带方法的对象都会让 send 直接抛。
 * 单元格里理论上只有 JSON 值和 TruncatedValue，这里只做最后一道兜底。
 */
function toTransferable(value: unknown): unknown {
  const t = typeof value
  if (t === 'function' || t === 'symbol') return String(value)
  if (t === 'bigint') return String(value)
  return value
}
