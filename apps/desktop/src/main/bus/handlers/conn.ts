import {
  DRIVER_CAPABILITIES,
  defaultConnectionLabel,
  redactConnectionConfig,
  type ConnCloseResult,
  type ConnOpenResult,
  type ConnectionConfig,
  type ConnectionState,
} from '@peek/core'
import { putConnection, removeConnection } from '../../store/mutations'
import { failMsg } from '../failure'
import type { CommandHandlerMap } from '../types'
import { openView } from './shared'

/**
 * The pure state part of conn.*. Actually connecting and disconnecting are side
 * effects: this file only registers intents (ctx.plan), which effects.ts runs
 * through the injected ConnectionService.
 */
export const connHandlers = {
  'conn.open': {
    reduce(draft, input, ctx) {
      const connId = input.connId ?? ctx.ids.conn()
      const existing = draft.connections[connId]

      const conn: ConnectionState = {
        id: connId,
        driverId: input.config.driverId,
        // The label must be derived from the **redacted** config. core's
        // defaultConnectionLabel falls back to the url when there is no
        // database/host, and the url carries a cleartext password — since the
        // label is broadcast to the renderer and to MCP, deriving it from the
        // raw config would ship the password along with it.
        label: defaultConnectionLabel(redactConnectionConfig(input.config)),
        // The cleartext config lives only in main's source of truth; everything
        // leaving main goes through redaction (see store/sanitize.ts).
        config: input.config,
        status: 'connecting',
        // Predict capabilities from the driver until we are connected; the
        // driver host fills in the real set once the connection is ready.
        capabilities: existing?.capabilities ?? [...DRIVER_CAPABILITIES[input.config.driverId]],
      }
      putConnection(draft, conn)

      const timeoutMs = connectTimeoutOf(input.config)
      ctx.plan({
        type: 'connect',
        connId,
        config: input.config,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })

      const result: ConnOpenResult = {
        connId,
        status: 'connecting',
        capabilities: conn.capabilities,
      }
      if (input.openTree) {
        // Open the tree view right away; once connected the renderer fetches the
        // first level (introspect is not a Command).
        result.treeViewId = openView(draft, { kind: 'tree', connId }, ctx, {}).viewId
      }
      return result
    },

    // Connecting is asynchronous, so status / capabilities in the result come
    // from the source of truth after the effects have run.
    finalize(data, state) {
      const conn = state.connections[data.connId]
      if (!conn) return data
      return {
        ...data,
        status: conn.status,
        capabilities: conn.capabilities,
        ...(conn.serverInfo ? { serverInfo: conn.serverInfo } : {}),
      }
    },
  },

  'conn.close': {
    reduce(draft, input, ctx) {
      if (!draft.connections[input.connId]) {
        failMsg('NOT_FOUND', 'error.conn.notFound', { connId: input.connId })
      }

      const closeViews = input.closeViews !== false
      const { closedViewIds, abortedResultIds } = removeConnection(draft, input.connId, closeViews)

      // Closing a connection reclaims the driver host process, so any running
      // result set dies with it; these cancels are only a best-effort courtesy.
      for (const resultId of abortedResultIds) {
        ctx.plan({ type: 'cancel', connId: input.connId, resultId, soft: true })
      }
      ctx.plan({ type: 'disconnect', connId: input.connId, soft: true })

      const result: ConnCloseResult = { connId: input.connId, closedViewIds }
      return result
    },
  },
} satisfies CommandHandlerMap

/** sqlite configs have no connectTimeoutMs field, so narrow before reading it. */
function connectTimeoutOf(config: ConnectionConfig): number | undefined {
  return 'connectTimeoutMs' in config ? config.connectTimeoutMs : undefined
}
