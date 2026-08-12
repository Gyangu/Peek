import { snapshotWorkspace, type StateReadResult, type WorkspaceSnapshot } from '@peek/core'
import { redactRulesFor } from '../../../drivers/manifests'
import { failMsg } from '../failure'
import type { CommandHandlerMap } from '../types'

/**
 * state.read: a read-only command.
 * It bumps no rev and broadcasts no patches. MCP's read_workspace goes straight
 * through it to main's source of truth, with zero renderer round trips (PLAN
 * section 3). The snapshot it returns has already been redacted by
 * snapshotWorkspace.
 */
export const stateHandlers = {
  'state.read': {
    read(state, input) {
      const full = snapshotWorkspace(state, redactRulesFor)
      const include = new Set(input.include ?? ['layout', 'views', 'connections', 'results'])

      let views = include.has('views') ? full.views : []
      if (input.viewId !== undefined) {
        const one = full.views.find((v) => v.id === input.viewId)
        if (!one) failMsg('NOT_FOUND', 'error.view.notFound', { viewId: input.viewId })
        views = [one]
      }

      const snapshot: WorkspaceSnapshot = {
        rev: full.rev,
        // The layout is only as large as the panel count (single digits), so it
        // is always included: one fewer round trip is one fewer chance for the
        // AI to guess wrong.
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
