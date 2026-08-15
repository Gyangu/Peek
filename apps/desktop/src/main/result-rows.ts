import { randomUUID } from 'node:crypto'
import type { IpcMain, WebContents } from 'electron'
import {
  IPC,
  peekError,
  peekErrorMsg,
  type ResultId,
  type ResultRowsReplyMessage,
  type ResultRowsRequestMessage,
} from '@peek/core'
import type { ResultRowsSlice } from './mcp'

/**
 * Result-set sampling (main ← renderer).
 *
 * PLAN section 3: data-plane chunks go from the driver host **straight to the
 * renderer** over a MessagePort, so main holds ResultMeta and not a single row.
 * But MCP's run_query owes the AI a few sample rows, so main has to ask the
 * renderer — whose columnar cache happens to have exactly that.
 *
 * This channel is for **sampling only** (20 rows by default, with the ceiling set
 * by the caller). It is not a back door for hauling result sets back into main:
 * the full data lives in the renderer cache and nowhere else.
 */
export interface ResultRowsBroker {
  read(req: { resultId: ResultId; limit: number; timeoutMs?: number }): Promise<ResultRowsSlice>
  dispose(): void
}

export interface ResultRowsBrokerOptions {
  ipcMain: IpcMain
  /** The renderers available to ask; with no window, sampling fails outright */
  renderers: () => readonly WebContents[]
  /** Per-sample timeout, so a busy renderer or a missing handler cannot hang the call forever */
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
          peekErrorMsg('INTERNAL', 'error.result.sampleNoWindow', undefined, {
            detail: 'Row data exists only in the renderer result cache (chunks bypass main).',
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
            peekErrorMsg('TIMEOUT', 'error.result.sampleTimedOut', undefined, {
              detail:
                'The window may not have attached the sampling channel yet, or the result ' +
                'set may have been evicted from its cache.',
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
        entry?.reject(peekErrorMsg('CANCELLED', 'error.result.sampleChannelClosed'))
      }
    },
  }
}

/** A renderer reply is untrusted data too: validate field by field before use. */
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
    return { requestId, ok: false, error: peekErrorMsg('INTERNAL', 'error.result.sampleFailed') }
  }
  const err = error as Record<string, unknown>
  return {
    requestId,
    ok: false,
    // The renderer's own message is passed through verbatim (driver-style text,
    // never translated); only the fallback comes from the catalog.
    error:
      typeof err['message'] === 'string'
        ? peekError('INTERNAL', err['message'])
        : peekErrorMsg('INTERNAL', 'error.result.sampleFailed'),
  }
}
