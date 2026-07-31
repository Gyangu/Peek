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
import { fail } from '../failure'
import type { CommandHandlerMap } from '../types'
import { openView } from './shared'

/**
 * conn.* 的纯状态部分。真正的建连/断连是副作用，
 * 这里只登记意图（ctx.plan），由 effects.ts 通过注入的 ConnectionService 执行。
 */
export const connHandlers = {
  'conn.open': {
    reduce(draft, input, ctx) {
      const connId = input.connId ?? ctx.ids.conn()
      const existing = draft.connections[connId]

      const conn: ConnectionState = {
        id: connId,
        driverId: input.config.driverId,
        // 注意：label 必须从**脱敏后**的 config 推。core 的 defaultConnectionLabel
        // 在没有 database/host 时会直接返回 url，而 url 里带着明文口令 ——
        // label 是要广播给 renderer 和 MCP 的，从原始 config 推就等于把口令送出去。
        label: defaultConnectionLabel(redactConnectionConfig(input.config)),
        // 明文配置只留在 main 的真源里；出 main 的一切都走 redact（见 store/sanitize.ts）
        config: input.config,
        status: 'connecting',
        // 连上之前先按驱动预判能力，ready 后由 driver host 回填实际能力集
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
        // 树视图先开着；连上之后由 renderer 拉第一层（introspect 不是 Command）
        result.treeViewId = openView(draft, { kind: 'tree', connId }, ctx, {}).viewId
      }
      return result
    },

    // 建连是异步的，返回值里的 status / capabilities 以副作用跑完后的真源为准
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
      if (!draft.connections[input.connId]) fail('NOT_FOUND', `连接 ${input.connId} 不存在`)

      const closeViews = input.closeViews !== false
      const { closedViewIds, abortedResultIds } = removeConnection(draft, input.connId, closeViews)

      // 关连接 = 回收 driver host 进程，在跑的结果集自然终止；这里只是 best-effort 通知
      for (const resultId of abortedResultIds) {
        ctx.plan({ type: 'cancel', connId: input.connId, resultId, soft: true })
      }
      ctx.plan({ type: 'disconnect', connId: input.connId, soft: true })

      const result: ConnCloseResult = { connId: input.connId, closedViewIds }
      return result
    },
  },
} satisfies CommandHandlerMap

/** sqlite 没有 connectTimeoutMs 字段，按 driverId 收窄着取 */
function connectTimeoutOf(config: ConnectionConfig): number | undefined {
  return 'connectTimeoutMs' in config ? config.connectTimeoutMs : undefined
}
