/**
 * cancel_query — stop a result set that is still running (maps onto query.cancel).
 *
 * ## Why this tool exists
 *
 * Everything else in `tools/` could *start* work; nothing could stop it. A model
 * that asked for a hundred million rows, or a scan of a keyspace it misjudged the
 * size of, had exactly two ways out: wait for the deadline, or ask the human at
 * the keyboard to press Cancel. That is not a gap in the model's judgement, it is
 * a missing verb — `query.cancel` has been a registered Command since M1 and no
 * tool mapped onto it.
 *
 * ## What cancelling costs
 *
 * Drivers that declare the `cancel` capability stop cooperatively and the
 * connection survives. Drivers that do not (qdrant today) are stopped the only way
 * PLAN section 3 allows: **the driver process is killed**, which takes the
 * connection down with it. The description says so plainly, because a model that
 * cannot see that cost will reach for cancel where waiting would have been
 * cheaper. `list_connections` reports each connection's capabilities, so the cost
 * is knowable before the call.
 */

import { z } from 'zod'
import { ResultIdSchema, ViewIdSchema, commandSchemas } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = commandSchemas['query.cancel'].safeExtend({
  resultId: ResultIdSchema.optional().describe(
    'The result set to stop, as returned by run_query or open_view and listed by read_workspace.',
  ),
  viewId: ViewIdSchema.optional().describe(
      'Stop whatever result set this view is currently running. Use it when you know the pane but ' +
        'not the result id; exactly one of resultId or viewId is required.',
    ),
})

/* ================================================================== */
/* 2. Result shape                                                      */
/* ================================================================== */

const CancelResultShape = z.object({
  resultId: ResultIdSchema,
  cancelled: z.boolean(),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'cancel_query',
  title: 'Stop a running query',
  description:
    'Stop a query, collection scan or vector search that is still running, identified by resultId or ' +
    'by the viewId of the pane running it. ' +
    'The rows already loaded stay valid and remain visible in the UI — cancelling is not a failure and ' +
    'discards nothing that arrived. ' +
    'A result set that had already finished, failed or been cancelled reports cancelled=false and is ' +
    'left alone. ' +
    'Cost: connections whose capabilities include "cancel" stop cooperatively and stay usable; on a ' +
    'connection without it peek has no choice but to kill the driver process, which drops that ' +
    'connection (every other connection is unaffected, and the connection can be reopened). ' +
    'Check capabilities with list_connections when that matters.',
  // Nothing is created or destroyed and the rows already fetched survive, but the
  // call does terminate work the user may be watching — and on a driver without the
  // capability it takes the connection with it, which is the definition of destructive.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: InputSchema,
  toCommands(input) {
    return [{ name: 'query.cancel', input }]
  },
  render(outcomes) {
    const parsed = CancelResultShape.safeParse(outcomeData(outcomes, 'query.cancel'))
    if (!parsed.success) {
      return { text: `query.cancel ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const { resultId, cancelled } = parsed.data
    // `cancelled: false` is an honest answer, not an error: the caller asked for a
    // state ("this is not running") that already held. Reporting it as a failure
    // would push a model into retrying something that has nothing left to stop.
    const text = cancelled
      ? `Cancelled ${resultId}. The rows already loaded remain valid and are still shown in the UI; ` +
        'the rest was not fetched.'
      : `${resultId} was not running, so nothing was cancelled. It had already finished, failed or been ` +
        'stopped — read_workspace reports its final status.'
    return { text, data: parsed.data }
  },
})
