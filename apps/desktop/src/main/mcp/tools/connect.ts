/**
 * connect — establish a database connection (maps onto conn.open).
 *
 * A thin shell: the inputSchema reuses the Command's own schema, and the mapping is a single
 * command.
 */

import { z } from 'zod'
import { commandSchemas } from '@peek/core'
import { driverManifests } from '../../../drivers/manifests'
import { defineCommandTool, outcomeData } from '../executor'
import { briefConnection, renderPanelBrief, toJson } from '../summary'

const InputSchema = commandSchemas['conn.open']

/**
 * One `connect` argument per driver, from the packages themselves.
 *
 * This description used to spell the shapes out by hand — "postgres/mysql accept
 * a url on its own; sqlite takes `file`; redis takes `url`, or host/port/db" —
 * and by the time neo4j arrived it was a list of five databases out of six, with
 * nothing to catch that. A model reading it would conclude neo4j was not
 * connectable.
 *
 * `instructions.ts` already fixed this exact bug for the MCP preamble in
 * 2026-08-02 and this call site was missed. Same source, same reason: a database
 * arrives here documented, or it does not arrive here at all.
 *
 * A function, and read through a getter below, because the manifests come off
 * disk now: this module is evaluated by the eager glob in `mcp/registry.ts`
 * while main is still loading, and a constant here would be the empty list that
 * was installed at that moment. `executor.ts`'s `baseFields` has the mechanism.
 */
function connectExamples(): string {
  return driverManifests().map((m) => `${m.displayName} ${m.mcpConnectExample}`).join('; ')
}

/** Only these fields of the conn.open result are read; a loose schema narrows it without `any`. */
const ConnOpenResultShape = z.object({
  connId: z.string(),
  treeViewId: z.string().optional(),
})

export default defineCommandTool({
  kind: 'command',
  name: 'connect',
  title: 'Connect to a database',
  get description() {
    return (
      'Open a database connection and register it in peek. The shape of `config` depends on driverId — ' +
      `a minimal example for each: ${connectExamples()}. ` +
      'Passing openTree=true also opens a namespace tree view in the UI. ' +
      'Returns the connId and the capabilities the connection actually has.'
    )
  },
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  toCommands(input) {
    return [{ name: 'conn.open', input }]
  },
  render(outcomes, _input, ctx) {
    const parsed = ConnOpenResultShape.safeParse(outcomeData(outcomes, 'conn.open'))
    const snap = ctx.getSnapshot()
    if (!parsed.success) {
      return { text: `The connect command ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const conn = snap.connections.find((c) => String(c.id) === parsed.data.connId)
    const brief = conn ? briefConnection(conn) : null
    const treeNote = parsed.data.treeViewId ? `\nOpened namespace tree view ${parsed.data.treeViewId} automatically.` : ''
    return {
      text:
        `Connection ${parsed.data.connId} is ${brief?.status ?? 'unknown'}.${treeNote}\n\n` +
        `${toJson(brief ?? { connId: parsed.data.connId })}\n\nCurrent panels:\n${renderPanelBrief(snap)}`,
      data: brief,
    }
  },
})
