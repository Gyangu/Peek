/**
 * `peek://` URIs — the stable name of one attachment.
 *
 * Every attachment carries a URI, and it is **an identifier, not an address**.
 * The agent runs in its own process and has no route back into peek: it cannot
 * dereference `peek://…`, peek declares `fs.readTextFile: false`, and the scheme
 * is not a file. So the URI exists to do three smaller jobs, all of which matter:
 *
 * 1. **De-duplication.** ACP embeds each attachment as a `resource` block with a
 *    URI. Two identical URIs in one prompt tell the agent it is being shown the
 *    same thing twice, and let peek drop the duplicate before it costs tokens.
 * 2. **Provenance in the transcript.** When the model says "row 4 of the result",
 *    the URI is what says *which* result — the model can quote it back and a
 *    human can follow it to the view it came from.
 * 3. **A hook for a future fetch path.** `resource_link` (see `blocks.ts`) needs
 *    a URI the host can later resolve. Minting them consistently now means that
 *    path is a change of transport, not a change of contract.
 *
 * The shapes are deliberately hierarchical and readable, `scheme://kind/id/part`:
 *
 *   peek://result/res_ab12/rows?i=3,4,9   specific rows of a result set
 *   peek://result/res_ab12/rows           a whole (capped) result set
 *   peek://result/res_ab12/cell/4/email   one cell
 *   peek://schema/conn_x9/public.orders   a collection's structure
 *   peek://view/view_q7/query             the text in a query editor
 *   peek://workspace                      the layout and view summaries
 *
 * **No credential ever reaches these.** A URI is built from ids and object names
 * only; connection configs never appear, which is why `schema` addresses a
 * `ConnId` rather than anything resembling a DSN.
 */

import type { CollectionRef, ConnId, ResultId, ViewId } from '@peek/core'
import { collectionRefLabel } from '@peek/core'

export const PEEK_URI_SCHEME = 'peek:' as const

/**
 * Row indexes listed in a URI, past which they are summarised instead.
 *
 * A URI is meant to be read, quoted and compared. Two hundred comma-separated
 * integers in one defeats all three, and the row list is already stated
 * precisely in the document body — so past this many the URI degrades to a count
 * and stays legible.
 */
const MAX_URI_ROW_INDEXES = 12

function encodeSegment(raw: string): string {
  // encodeURIComponent leaves `.` alone, which keeps `public.orders` readable,
  // and escapes `/` and `?`, which is what actually matters for parsing.
  return encodeURIComponent(raw)
}

export function resultRowsUri(resultId: ResultId, rowIndexes?: readonly number[]): string {
  const base = `peek://result/${encodeSegment(resultId)}/rows`
  if (!rowIndexes || rowIndexes.length === 0) return base
  if (rowIndexes.length > MAX_URI_ROW_INDEXES) return `${base}?n=${rowIndexes.length}`
  return `${base}?i=${rowIndexes.join(',')}`
}

export function resultCellUri(resultId: ResultId, rowIndex: number, column: string): string {
  return `peek://result/${encodeSegment(resultId)}/cell/${rowIndex}/${encodeSegment(column)}`
}

export function schemaUri(connId: ConnId, ref: CollectionRef): string {
  return `peek://schema/${encodeSegment(connId)}/${encodeSegment(collectionRefLabel(ref))}`
}

export function queryUri(viewId: ViewId): string {
  return `peek://view/${encodeSegment(viewId)}/query`
}

export function workspaceUri(): string {
  return 'peek://workspace'
}
