import type { ColumnDef, ResultRowsRequestMessage } from '@peek/core'
import { tryBridge } from '../bridge'
import { attachResultPort, getCell, getResultSnapshot, isPendingCell, pruneResults } from './resultCache'
import { startWorkspaceSync, useWorkspaceStore } from './workspaceStore'

/**
 * All of the renderer's wiring, run once at module load.
 *
 * Deliberately not inside a React effect: StrictMode invokes effects twice, and
 * both the MessagePort intake and the patch subscription must be singletons.
 */

let started = false

/** How often the result cache is swept. */
const PRUNE_INTERVAL_MS = 15_000

export function startRenderer(): void {
  if (started) return
  started = true

  startWorkspaceSync()

  const bridge = tryBridge()
  if (bridge) {
    // Data plane: one MessagePort per connection. Chunks come straight from the
    // driver host and never pass through main.
    bridge.onResultPort((msg, port) => {
      attachResultPort(msg.connId, port)
    })

    // main holds no row data (chunks bypass it), so when MCP's run_query wants
    // sample rows it has to ask us
    bridge.onResultRowsRequest?.(handleRowsRequest)
  }

  // Release what main has already forgotten, so memory does not only ever grow
  const prune = (): void => {
    const ws = useWorkspaceStore.getState().workspace
    if (!ws) return
    pruneResults(new Set(Object.keys(ws.results)))
  }
  useWorkspaceStore.subscribe(prune)
  setInterval(prune, PRUNE_INTERVAL_MS)
}

/* ==================================================================== */
/* Result sampling (answering main's RESULT_ROWS_REQUEST)                 */
/* ==================================================================== */

/** Hard ceiling on rows handed out at once, so an AI context cannot be flooded.
 *  main applies its own limit on top of this. */
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
        // Rows the LRU already evicted become null: the sentinel Symbol cannot
        // survive structured clone and would break the send outright
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
        // English literal: this text crosses into main and is read by MCP.
        message: error instanceof Error ? error.message : 'Sampling failed',
      },
    })
  }
}

/**
 * IPC goes through structured clone, where a function, a Symbol or an object with
 * methods makes `send` throw outright. Cells should only ever hold JSON values
 * and TruncatedValue, so this is purely a last line of defence.
 */
function toTransferable(value: unknown): unknown {
  const t = typeof value
  if (t === 'function' || t === 'symbol') return String(value)
  if (t === 'bigint') return String(value)
  return value
}
