/**
 * list_connections — read-only tool: list every current connection and its capabilities.
 * Reads main's Workspace Store directly, bypassing the Command Bus.
 */

import { z } from 'zod'
import { DRIVER_MANIFESTS, driverCapabilities } from '../../../drivers/manifests'
import { defineReadTool } from '../executor'
import { briefConnection, toJson } from '../summary'

/**
 * The example in the empty state, taken from whichever driver is listed first
 * rather than hard-coded as postgres.
 *
 * It used to be a literal, which made the answer to "there is nothing here yet"
 * quietly assert that PostgreSQL is the database peek is for. Same fix, and same
 * reason, as the `connect` tool's description — see the comment there.
 */
const FIRST_EXAMPLE = DRIVER_MANIFESTS[0]?.mcpConnectExample ?? ''

const InputSchema = z.object({
  /** Only list connections in this status. */
  status: z.enum(['idle', 'connecting', 'ready', 'error']).optional(),
})

export default defineReadTool({
  kind: 'read',
  name: 'list_connections',
  title: 'List connections',
  description:
    'List the database connections peek currently holds: connId, label, driver, status, actual ' +
    'capability set, and the redacted connection target. ' +
    'Call this first to get an id for the tools that need a connId (introspect / open_view / run_query). ' +
    'The response also carries driverCapabilities, the per-driver table of capabilities expected before connecting.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  read(input, ctx) {
    const snap = ctx.getSnapshot()
    const conns = snap.connections
      .filter((c) => input.status === undefined || c.status === input.status)
      .map(briefConnection)

    const head =
      conns.length === 0
        ? `There are no connections yet. Create one with the connect tool, e.g. {"config":${FIRST_EXAMPLE}}. The connect tool's description carries an example for every driver.`
        : `${conns.length} connection(s) (workspace rev=${snap.rev}):`

    return {
      text: `${head}\n\n${toJson({ connections: conns, driverCapabilities: driverCapabilities() })}`,
      data: conns,
    }
  },
})
