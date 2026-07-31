import { randomUUID } from 'node:crypto'
import type { IpcMain, WebContents } from 'electron'
import {
  IPC,
  peekError,
  type ResultId,
  type ResultRowsReplyMessage,
  type ResultRowsRequestMessage,
} from '@peek/core'
import type { ResultRowsSlice } from './mcp'

/**
 * 结果集取样（main ← renderer）。
 *
 * PLAN 第 3 节：数据面 chunk 由 driver host 经 MessagePort **直发 renderer**，
 * main 只有 ResultMeta，手里没有一行数据。而 MCP 的 run_query 要给 AI 回几行样本，
 * 所以只能反向问 renderer 要——它的列式缓存里正好有。
 *
 * 这条通道只用于**取样**（默认 20 行，上限由调用方控制），
 * 绝不是"把结果集搬回 main"的后门：全量数据永远只在 renderer 缓存里。
 */
export interface ResultRowsBroker {
  read(req: { resultId: ResultId; limit: number; timeoutMs?: number }): Promise<ResultRowsSlice>
  dispose(): void
}

export interface ResultRowsBrokerOptions {
  ipcMain: IpcMain
  /** 当前可问的 renderer；没有窗口时取样直接失败 */
  renderers: () => readonly WebContents[]
  /** 单次取样超时（renderer 忙或没装 handler 时不能一直挂着） */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3000

interface Pending {
  resolve(slice: ResultRowsSlice): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
}

export function createResultRowsBroker(options: ResultRowsBrokerOptions): ResultRowsBroker {
  const { ipcMain, renderers } = options
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pending = new Map<string, Pending>()

  const settle = (requestId: string): Pending | null => {
    const entry = pending.get(requestId)
    if (!entry) return null
    pending.delete(requestId)
    clearTimeout(entry.timer)
    return entry
  }

  const listener = (_event: unknown, raw: unknown): void => {
    const reply = readReply(raw)
    if (!reply) return
    const entry = settle(reply.requestId)
    if (!entry) return
    if (reply.ok) {
      entry.resolve({
        columns: reply.columns,
        rows: reply.rows,
        totalRows: reply.totalRows,
        truncated: reply.truncated,
      })
    } else {
      entry.reject(reply.error)
    }
  }

  ipcMain.on(IPC.RESULT_ROWS_REPLY, listener)

  return {
    read(req) {
      const target = renderers().find((wc) => !wc.isDestroyed())
      if (!target) {
        return Promise.reject(
          peekError('INTERNAL', '没有可用的界面窗口，无法取样结果集', {
            detail: '行数据只存在于 renderer 的结果缓存里（chunk 不经过 main）。',
          }),
        )
      }

      const requestId = randomUUID()
      const message: ResultRowsRequestMessage = {
        requestId,
        resultId: req.resultId,
        limit: req.limit,
      }

      return new Promise<ResultRowsSlice>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(
            peekError('TIMEOUT', '向界面取样结果集超时', {
              detail: '界面可能还没接上取样通道，或结果集已被缓存淘汰。',
              retryable: true,
            }),
          )
        }, req.timeoutMs ?? defaultTimeout)
        pending.set(requestId, { resolve, reject, timer })
        target.send(IPC.RESULT_ROWS_REQUEST, message)
      })
    },

    dispose() {
      ipcMain.off(IPC.RESULT_ROWS_REPLY, listener)
      for (const [id] of [...pending]) {
        const entry = settle(id)
        entry?.reject(peekError('CANCELLED', '取样通道已关闭'))
      }
    },
  }
}

/** renderer 的应答同样是不可信数据，逐字段校验后再用 */
function readReply(raw: unknown): ResultRowsReplyMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const requestId = rec['requestId']
  if (typeof requestId !== 'string') return null

  if (rec['ok'] === true) {
    const columns = rec['columns']
    const rows = rec['rows']
    if (!Array.isArray(columns) || !Array.isArray(rows)) return null
    return {
      requestId,
      ok: true,
      columns: columns as ResultRowsSlice['columns'],
      rows: rows as unknown[][],
      totalRows: typeof rec['totalRows'] === 'number' ? rec['totalRows'] : rows.length,
      truncated: rec['truncated'] === true,
    }
  }

  const error = rec['error']
  if (typeof error !== 'object' || error === null) {
    return { requestId, ok: false, error: peekError('INTERNAL', '界面取样失败') }
  }
  const err = error as Record<string, unknown>
  return {
    requestId,
    ok: false,
    error: peekError(
      'INTERNAL',
      typeof err['message'] === 'string' ? err['message'] : '界面取样失败',
    ),
  }
}
