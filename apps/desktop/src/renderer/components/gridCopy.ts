/**
 * Getting values out of the grid.
 *
 * This was missing outright, and its absence was the single largest hole in the
 * product: `body { user-select: none }`, no `⌘C` handler, no clipboard call
 * anywhere in the renderer. The only way to get a value out was to double-click
 * it — and `isExpandable` only opens the modal for strings over 80 characters or
 * with a newline in them, so **a UUID, a timestamp, a number or any short string
 * could not be copied at all**. For a database client that is the first thing a
 * person tries.
 *
 * Two shapes, because there are two questions:
 *
 *  - one cell → the value on its own, raw. No quoting, no header. What is on the
 *    clipboard is exactly what was in the database, which is what makes it
 *    pasteable into a query, a ticket or a terminal.
 *  - a set of rows → TSV with a header line, which is what spreadsheets expect.
 *
 * ## Truncation is reported, never hidden
 *
 * A large value travels in a chunk as a 4KB preview (`TruncatedValue`), and the
 * rest only exists behind `valuePeek`. Copying gives back the preview, because
 * that is what the renderer has — but the caller is told how many cells were
 * partial so it can say so. Silently putting a truncated value on the clipboard
 * is how someone ends up pasting half a JSON document into a bug report and
 * wondering why it will not parse.
 */

import type { ColumnDef } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { isPendingCell } from '../state/resultCache'
import { fullValueText } from '../util/format'
import type { CellRange } from './cellRange'

export interface GridCopySource {
  columns: readonly ColumnDef[]
  /** The cell reader — `resultCache.getCell` with the result id already bound. */
  read: (row: number, col: number) => unknown
}

export interface CopyPlan {
  /** What goes on the clipboard. */
  text: string
  /** How many of the copied cells were previews rather than whole values. */
  truncated: number
  /**
   * How many of the copied cells had not arrived from the stream yet.
   *
   * The same honesty rule truncation follows, for the other way a cell can be
   * incomplete: a rectangle dragged across rows the stream has not reached yet
   * copies placeholders, and the caller says so rather than letting someone
   * paste a block of `···` into a ticket.
   */
  pending: number
}

/**
 * One cell's value, verbatim.
 *
 * Deliberately not TSV-escaped: a single value is not a table, and wrapping
 * `a"b` in quotes would corrupt the very thing the user asked for. Escaping is a
 * property of the *container*, and there is no container here.
 */
export function copyCellPlan(src: GridCopySource, row: number, col: number): CopyPlan {
  const value = src.read(row, col)
  return {
    text: fullValueText(value),
    truncated: isTruncatedValue(value) ? 1 : 0,
    pending: isPendingCell(value) ? 1 : 0,
  }
}

/**
 * A set of rows as TSV, header first.
 *
 * Row order follows the indexes given, not the order they were clicked in — a
 * selection built by ⌘-clicking around the grid still pastes in table order,
 * which is what makes the header line meaningful.
 */
export function copyRowsPlan(src: GridCopySource, rows: readonly number[]): CopyPlan {
  const ordered = [...rows].sort((a, b) => a - b)
  const lines: string[] = [src.columns.map((c) => tsvField(c.name)).join('\t')]
  let truncated = 0
  let pending = 0

  for (const row of ordered) {
    const cells: string[] = []
    for (let col = 0; col < src.columns.length; col += 1) {
      const value = src.read(row, col)
      if (isTruncatedValue(value)) truncated += 1
      if (isPendingCell(value)) pending += 1
      cells.push(tsvField(fullValueText(value)))
    }
    lines.push(cells.join('\t'))
  }
  return { text: lines.join('\n'), truncated, pending }
}

/**
 * A rectangle of cells as TSV, header first.
 *
 * The header line carries **only the selected columns**, in grid order. That is
 * what makes the block paste correctly: a header naming every column in the
 * result set, above rows that hold three of them, is a table that lies about
 * itself. A rectangle is a table in its own right — the columns it does not
 * cover are simply not part of it.
 *
 * A 1×1 rectangle still goes through here with its header, unlike `copyCellPlan`,
 * which gives back the bare value. The two are reached by different gestures:
 * `⌘C` on a focused cell means "this value", a dragged rectangle means "this
 * block", and it stays a block even when the drag covered one cell.
 */
export function copyRangePlan(src: GridCopySource, range: CellRange): CopyPlan {
  const c0 = Math.max(0, range.c0)
  const c1 = Math.min(src.columns.length - 1, range.c1)
  if (c1 < c0) return { text: '', truncated: 0, pending: 0 }

  const head: string[] = []
  for (let col = c0; col <= c1; col += 1) head.push(tsvField(src.columns[col]?.name ?? ''))
  const lines: string[] = [head.join('\t')]
  let truncated = 0
  let pending = 0

  for (let row = range.r0; row <= range.r1; row += 1) {
    const cells: string[] = []
    for (let col = c0; col <= c1; col += 1) {
      const value = src.read(row, col)
      if (isTruncatedValue(value)) truncated += 1
      if (isPendingCell(value)) pending += 1
      cells.push(tsvField(fullValueText(value)))
    }
    lines.push(cells.join('\t'))
  }
  return { text: lines.join('\n'), truncated, pending }
}

/**
 * One field of a tab-separated block.
 *
 * A tab or a newline inside a value would otherwise invent a column or a row,
 * which is the classic way a pasted export silently gains rows nobody typed.
 * The quoting rule is the CSV one (RFC 4180, with tab as the delimiter) because
 * that is what Excel, Numbers and Sheets all parse on paste.
 */
export function tsvField(text: string): string {
  if (!/[\t\n\r"]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}
