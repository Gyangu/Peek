/**
 * run_query — execute a free-form query (maps onto query.run).
 *
 * What the AI gets back is **the first N rows plus the total row count**; the full data stays in
 * the UI (PLAN section 8). Row data itself goes over a MessagePort straight to the renderer and
 * main never holds it, so the sample rows depend on the injected readResultRows. Without it the
 * tool degrades to returning result metadata only (status / row count / elapsed time).
 */

import { z } from 'zod'
import {
  MCP_DEFAULT_MAX_ROWS,
  ResultIdSchema,
  ViewIdSchema,
  commandSchemas,
  peekError,
} from '@peek/core'
import { defineCommandTool, errorOutput, outcomeData } from '../executor'
import { toJson } from '../summary'
import { renderRowsTable, waitForResult } from '../wait'
import type { ResultRowsSlice } from '../types'

/** How many rows the AI is shown by default. */
const DEFAULT_PREVIEW_ROWS = 20
/** Default time to wait for the query to reach a settled status. */
const DEFAULT_WAIT_MS = 30_000

const InputSchema = commandSchemas['query.run'].safeExtend({
  /** Max rows to show in the receipt (does not affect the UI, which receives everything). */
  previewRows: z.number().int().min(0).max(200).optional(),
  /** Max time (ms) to wait for a settled status; timing out does not mean the query failed — the UI keeps running it. */
  waitMs: z.number().int().min(0).max(120_000).optional(),
})

const QueryRunResultShape = z.object({
  resultId: ResultIdSchema,
  viewId: ViewIdSchema,
})

export default defineCommandTool({
  kind: 'command',
  name: 'run_query',
  title: 'Run a query',
  description:
    'Run a query statement (SQL or equivalent) on a connection and show the result in a peek query view. ' +
    'Passing connId + text opens a new query view; passing the viewId of an existing query view runs it there. ' +
    'The receipt carries only the first previewRows rows (20 by default) plus the total row count — ' +
    'the full result is available in the UI. ' +
    `Without maxRows the server caps the query at ${MCP_DEFAULT_MAX_ROWS} rows and marks it truncated; ` +
    'pass maxRows explicitly for more, and note that the stream enters paused (data still valid) ' +
    'when the viewport in the UI stops advancing.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  toCommands(input) {
    const { previewRows: _p, waitMs: _w, ...cmdInput } = input
    return [
      {
        name: 'query.run',
        // Server-side default cap: when no row count is requested, return the first
        // MCP_DEFAULT_MAX_ROWS rows and mark the result truncated. Otherwise a `select *`
        // against a large table inevitably lands in the backpressure-pause path, because a
        // headless caller has no real viewport advancing.
        input: { ...cmdInput, maxRows: cmdInput.maxRows ?? MCP_DEFAULT_MAX_ROWS },
      },
    ]
  },
  async render(outcomes, input, ctx) {
    const parsed = QueryRunResultShape.safeParse(outcomeData(outcomes, 'query.run'))
    if (!parsed.success) {
      return errorOutput(
        peekError('INTERNAL', 'The return value of query.run could not be parsed', { detail: toJson(outcomes) }),
      )
    }
    const { resultId, viewId } = parsed.data
    const waitMs = input.waitMs ?? DEFAULT_WAIT_MS
    const previewRows = input.previewRows ?? DEFAULT_PREVIEW_ROWS
    const maxRows = input.maxRows ?? MCP_DEFAULT_MAX_ROWS

    const { meta, settled } = await waitForResult(ctx, resultId, waitMs)

    const headBits = [`Query ran in view ${viewId}, result ${resultId}`]
    if (meta) {
      headBits.push(`status ${meta.status}`)
      headBits.push(`${meta.rows} rows`)
      if (meta.elapsedMs !== undefined) headBits.push(`${meta.elapsedMs}ms`)
      if (meta.truncated) {
        headBits.push(
          meta.status === 'paused'
            ? 'truncated (backpressure pause)'
            : `truncated at maxRows=${maxRows}`,
        )
      }
    } else {
      headBits.push('no result metadata yet')
    }
    if (!settled) headBits.push(`waited ${waitMs}ms without a settled status, the UI is still loading`)

    /* --- A real failure: the only branch that sets isError --- */
    if (meta?.status === 'error' && meta.error) {
      return {
        text: `${headBits.join(' · ')}\n\n[${meta.error.code}] ${meta.error.message}` +
          `${meta.error.detail ? `\n${meta.error.detail}` : ''}`,
        data: meta.error,
        isError: true,
      }
    }

    /*
     * paused and cancelled are **not** isError: nothing is wrong with the query, and every row
     * loaded so far is valid. This notice is the AI's only cue for telling "the query broke"
     * apart from "the query merely stopped" — do not soften the wording.
     */
    let notice = ''
    if (meta?.status === 'paused') {
      notice =
        `\n\n⏸ Paused (not a failure): ${meta.pausedReason ?? 'backpressure idle timeout'}. `
        + `The ${meta.rows} rows already loaded are complete, valid data you can use as they are; `
        + 'more rows remain unfetched. To continue, run the query again (optionally with a larger '
        + 'maxRows, or scroll the grid to the bottom in the UI first).'
    } else if (meta?.status === 'cancelled') {
      notice = '\n\n■ Cancelled (not a failure): the rows already loaded are valid; the remaining data was not fetched.'
    }

    let table = ''
    let slice: ResultRowsSlice | null = null
    if (previewRows > 0 && ctx.readResultRows && meta && meta.rows > 0) {
      try {
        slice = await ctx.readResultRows({ resultId, limit: previewRows })
        table = `\n\nFirst ${slice.rows.length} rows (of ${slice.totalRows}${slice.truncated ? ', truncated' : ''}):\n${renderRowsTable(slice)}`
      } catch (err) {
        ctx.logger.log('warn', 'readResultRows failed', err)
        table = '\n\n(Failed to sample rows; view the full result in the UI.)'
      }
    } else if (previewRows > 0 && !ctx.readResultRows) {
      table = '\n\n(readResultRows is not wired up: row data lives only in the UI cache, so only metadata is available here.)'
    }

    const columns = meta?.schema?.map((c) => `${c.name}:${c.logical}`).join(', ') ?? ''
    return {
      text: `${headBits.join(' · ')}${columns ? `\nColumns: ${columns}` : ''}${notice}${table}`,
      data: {
        resultId: String(resultId),
        viewId: String(viewId),
        status: meta?.status ?? 'running',
        rows: meta?.rows ?? 0,
        /** Whether the data can be trusted: false only for error; paused/cancelled are both true. */
        rowsUsable: meta?.status !== 'error',
        truncated: meta?.truncated === true,
        resumable: meta?.resumable === true,
        maxRows,
        preview: slice?.rows ?? [],
      },
    }
  },
})
