import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ColumnDef } from '@peek/core'
import { truncatedValue } from '@peek/core'
import { copyCellPlan, copyRowsPlan, tsvField, type GridCopySource } from '../gridCopy'

/* ==================================================================
 * Getting values out of the grid.
 *
 * The feature this covers did not exist: with `user-select: none` on the body,
 * no ⌘C handler and no clipboard call in the renderer, a value shorter than 80
 * characters — a UUID, a timestamp, an id — could not be copied out of peek at
 * all. So these tests are less about regression than about pinning the two
 * decisions that make the copy trustworthy: TSV that survives a paste, and
 * truncation that is reported rather than hidden.
 * ================================================================== */

function col(name: string): ColumnDef {
  return { name, logical: 'string', nativeType: 'text' }
}

/** A source backed by a literal table, indexed [row][col]. */
function sourceOf(names: readonly string[], cells: readonly (readonly unknown[])[]): GridCopySource {
  return {
    columns: names.map(col),
    read: (row, colIndex) => cells[row]?.[colIndex],
  }
}

describe('one cell', () => {
  test('is copied verbatim, with no quoting', () => {
    // A single value is not a table. Wrapping `say "hi"` in quotes to satisfy a
    // format that has no other fields would corrupt the thing being asked for.
    const src = sourceOf(['a'], [['say "hi"\tand\nbye']])
    assert.equal(copyCellPlan(src, 0, 0).text, 'say "hi"\tand\nbye')
  })

  test('reports when what it copied was only a preview', () => {
    const src = sourceOf(['doc'], [[truncatedValue('{"a":1', 'utf8', { byteLength: 40_000 })]])
    const plan = copyCellPlan(src, 0, 0)
    assert.equal(plan.truncated, 1)
    // The preview is still what goes on the clipboard — it is what this process
    // has — but the caller now knows to say so.
    assert.equal(plan.text, '{"a":1')
  })

  test('a null is copied as the same word the grid shows', () => {
    const src = sourceOf(['a'], [[null]])
    assert.equal(copyCellPlan(src, 0, 0).text, 'NULL')
    assert.equal(copyCellPlan(src, 0, 0).truncated, 0)
  })
})

describe('rows as TSV', () => {
  const src = sourceOf(
    ['id', 'name'],
    [
      [1, 'alpha'],
      [2, 'beta'],
      [3, 'gamma'],
    ],
  )

  test('leads with a header line', () => {
    const [header] = copyRowsPlan(src, [0]).text.split('\n')
    assert.equal(header, 'id\tname')
  })

  test('pastes in table order, not click order', () => {
    // A selection built by ⌘-clicking around the grid arrives in whatever order
    // the clicks happened. Pasting that under a header would be nonsense.
    const plan = copyRowsPlan(src, [2, 0, 1])
    assert.deepEqual(plan.text.split('\n'), ['id\tname', '1\talpha', '2\tbeta', '3\tgamma'])
  })

  test('a tab or a newline inside a value cannot invent a column or a row', () => {
    const nasty = sourceOf(['a', 'b'], [[`two\tfields?`, 'two\nrows?']])
    const lines = copyRowsPlan(nasty, [0]).text.split('\n')
    // Still exactly one header and one data record: the embedded newline lives
    // inside a quoted field, which is what every spreadsheet parses on paste.
    assert.equal(lines[0], 'a\tb')
    assert.equal(lines[1], '"two\tfields?"\t"two')
    assert.equal(lines[2], 'rows?"')
  })

  test('counts every truncated cell, not just the first', () => {
    const big = truncatedValue('head', 'utf8', { byteLength: 99_999 })
    const partial = sourceOf(
      ['a', 'b'],
      [
        [big, 'ok'],
        ['ok', big],
      ],
    )
    assert.equal(copyRowsPlan(partial, [0, 1]).truncated, 2)
  })

  test('an empty selection produces nothing but the header', () => {
    // The caller declines to copy at all in this case; this only pins that the
    // function itself does not throw or invent a row.
    assert.equal(copyRowsPlan(src, []).text, 'id\tname')
  })
})

describe('tsvField', () => {
  test('leaves ordinary text alone', () => {
    for (const plain of ['alpha', '42', '2026-08-02', 'a b c', 'ünïcode']) {
      assert.equal(tsvField(plain), plain)
    }
  })

  test('quotes and doubles quotes only when it has to', () => {
    assert.equal(tsvField('has "quotes"'), '"has ""quotes"""')
    assert.equal(tsvField('has\ttab'), '"has\ttab"')
    assert.equal(tsvField('has\nnewline'), '"has\nnewline"')
    assert.equal(tsvField('has\r\ncrlf'), '"has\r\ncrlf"')
  })
})
