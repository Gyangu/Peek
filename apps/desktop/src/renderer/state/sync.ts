import type { ColumnDef, ConnId, ConnStatus, ResultRowsRequestMessage } from '@peek/core'
import { tryBridge } from '../bridge'
import { invalidateConnection, refetchConnection } from './namespaceStore'
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

  useWorkspaceStore.subscribe(syncNamespaceCache)
}

/* ==================================================================== */
/* Namespace cache ↔ connection lifecycle                                 */
/* ==================================================================== */

/**
 * What each connection's status was last time we looked, so a subscription that
 * fires on every patch can tell an actual transition from noise.
 */
const lastStatus = new Map<ConnId, ConnStatus>()

/**
 * Keep the namespace tree's cache in step with the connections behind it.
 *
 * The tree is opened by `conn.open` *while the handshake is still running*
 * (handlers/conn.ts), so its first level parks in `waiting` and only this
 * subscription can set it going. Two transitions matter:
 *
 * - **into `ready`** — the data source just became usable, as a first connect or
 *   as a reconnect. Refetch every level cached under it: on a first connect that
 *   is the parked root level, on a reconnect it is the previous session's stale
 *   nodes.
 * - **gone from the mirror** — `conn.close` dropped it, so its levels are dead
 *   weight. This is `pruneResults`' counterpart for the tree.
 *
 * A connection that fails keeps its cached tree deliberately: dropping it leaves
 * `TreeLevel` with nothing to render and no reason to re-run, so the tree would
 * silently vanish. The sidebar already reports the failure, and a reconnect goes
 * through the `ready` branch above.
 *
 * Exported for the regression net in `__tests__/namespace-cache.test.ts` —
 * `startRenderer` is the only production caller, via the subscription above.
 */
export function syncNamespaceCache(): void {
  const conns = useWorkspaceStore.getState().workspace?.connections
  if (!conns) return

  for (const connId of [...lastStatus.keys()]) {
    if (conns[connId] !== undefined) continue
    lastStatus.delete(connId)
    invalidateConnection(connId)
  }

  for (const [id, conn] of Object.entries(conns)) {
    const connId = id as ConnId
    const prev = lastStatus.get(connId)
    if (prev === conn.status) continue
    lastStatus.set(connId, conn.status)
    if (conn.status === 'ready') refetchConnection(connId)
  }
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
