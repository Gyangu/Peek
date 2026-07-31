import { snapshotWorkspace, type StateReadResult, type WorkspaceSnapshot } from '@peek/core'
import { fail } from '../failure'
import type { CommandHandlerMap } from '../types'

/**
 * state.read：只读命令。
 * 不 bump rev、不广播 patch，MCP 的 read_workspace 直接走它读 main 的真源
 * （零 renderer 往返，PLAN 第 3 节）。返回的快照已由 snapshotWorkspace 脱敏。
 */
export const stateHandlers = {
  'state.read': {
    read(state, input) {
      const full = snapshotWorkspace(state)
      const include = new Set(input.include ?? ['layout', 'views', 'connections', 'results'])

      let views = include.has('views') ? full.views : []
      if (input.viewId !== undefined) {
        const one = full.views.find((v) => v.id === input.viewId)
        if (!one) fail('NOT_FOUND', `视图 ${input.viewId} 不存在`)
        views = [one]
      }

      const snapshot: WorkspaceSnapshot = {
        rev: full.rev,
        // layout 体量只跟面板数相关（个位数），恒返回：AI 少一次往返就少一次误判
        layout: full.layout,
        focusedPanel: full.focusedPanel,
        connections: include.has('connections') ? full.connections : [],
        views,
        results: include.has('results') ? full.results : [],
      }
      const result: StateReadResult = { snapshot }
      return result
    },
  },
} satisfies CommandHandlerMap
