/**
 * open_view — open a view in the UI (maps onto view.open).
 *
 * The five view specs are fixed by core's ViewOpenSpec: table / query / inspector / tree / vector.
 * This is the path that makes "the AI says open the harness table on postgres" actually appear
 * on screen.
 */

import { z } from 'zod'
import { ResultIdSchema, commandSchemas } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { renderPanelBrief, toJson } from '../summary'
import { waitForResult } from '../wait'

const InputSchema = commandSchemas['view.open'].safeExtend({
  /** When opening the view also starts a fetch, how long to wait (ms) before replying (0 = do not wait). */
  waitMs: z.number().int().min(0).max(120_000).optional(),
})

const ViewOpenResultShape = z.object({
  viewId: z.string(),
  panelId: z.string(),
  kind: z.string(),
  resultId: ResultIdSchema.optional(),
})

export default defineCommandTool({
  kind: 'command',
  name: 'open_view',
  title: 'Open a view',
  description:
    'Open a view in the peek UI. spec.kind is one of five: ' +
    'table (browse a table/keyspace/collection; get the ref from introspect), ' +
    'query (SQL editor, optionally with text plus run=true to execute immediately), ' +
    'inspector (examine one large value), tree (namespace tree), vector (vector search). ' +
    'Without panelId the view opens in the currently focused panel — except when that panel is ' +
    'holding a conversation, in which case it goes to the nearest panel that is not, opening a ' +
    'column to the right if there is no such panel, and focus stays with the conversation. ' +
    'You are not opening things on top of the person you are talking to; the receipt names the ' +
    'pane it really landed in. ' +
    'By default it is added there as a new tab and shown, closing nothing — pass replace=true to ' +
    "close that panel's visible view and take its place in the tab bar, or index to choose where in " +
    'the tab bar it lands (0 is leftmost; omitted appends). ' +
    'To put it in a pane of its own instead, open it and then move_view it onto a panel edge. ' +
    'Name it with spec.title when you are about to open several views of the same kind in one panel: ' +
    'derived titles collide there (three query views all read "Query"), and you are the only one who ' +
    'knows what each was for. update_view retitles one later.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  toCommands(input) {
    const { waitMs: _waitMs, ...cmdInput } = input
    return [{ name: 'view.open', input: cmdInput }]
  },
  async render(outcomes, input, ctx) {
    const parsed = ViewOpenResultShape.safeParse(outcomeData(outcomes, 'view.open'))
    if (!parsed.success) {
      return { text: `view.open ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const { viewId, panelId, kind, resultId } = parsed.data

    let resultLine = ''
    if (resultId !== undefined) {
      const waitMs = input.waitMs ?? 3000
      const { meta, settled } =
        waitMs > 0 ? await waitForResult(ctx, resultId, waitMs) : { meta: null, settled: false }
      resultLine = meta
        ? `\nResult ${resultId}: ${meta.status} · ${meta.rows} rows` +
          `${meta.elapsedMs === undefined ? '' : ` · ${meta.elapsedMs}ms`}` +
          `${meta.error ? ` · ${meta.error.code}: ${meta.error.message}` : ''}`
        : `\nResult ${resultId}: still loading${settled ? '' : ` (waited ${waitMs}ms without reaching a settled status)`}`
    }

    const snap = ctx.getSnapshot()
    return {
      text:
        `Opened ${kind} view ${viewId} (panel ${panelId}).${resultLine}\n\n` +
        `Current panels:\n${renderPanelBrief(snap)}`,
      data: { viewId, panelId, kind, resultId },
    }
  },
})
