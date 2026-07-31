/**
 * connect — establish a database connection (maps onto conn.open).
 *
 * A thin shell: the inputSchema reuses the Command's own schema, and the mapping is a single
 * command.
 */

import { z } from 'zod'
import { commandSchemas } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { briefConnection, renderPanelBrief, toJson } from '../summary'

const InputSchema = commandSchemas['conn.open']

/** Only these fields of the conn.open result are read; a loose schema narrows it without `any`. */
const ConnOpenResultShape = z.object({
  connId: z.string(),
  treeViewId: z.string().optional(),
})

export default defineCommandTool({
  kind: 'command',
  name: 'connect',
  title: 'Connect to a database',
  description:
    'Open a database connection and register it in peek. The shape of `config` depends on driverId: ' +
    'postgres/mysql accept a url on its own (postgresql://user@host:5432/db); ' +
    'sqlite takes `file`; redis takes `url`, or host/port/db; qdrant takes `url` (plus optional apiKey). ' +
    'Passing openTree=true also opens a namespace tree view in the UI. ' +
    'Returns the connId and the capabilities the connection actually has.',
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
