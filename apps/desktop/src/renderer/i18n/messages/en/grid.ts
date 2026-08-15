/**
 * Data grid, its scrollbar, the value modal and the status bar.
 *
 * Note the `{ count, rows }` pattern on row counts. `count` picks the plural
 * category; `rows` carries the *already formatted* number (`formatCount()` groups
 * thousands). `t()` never formats numbers on its own — see `formatTemplate` in
 * core — so the caller stays in charge of how a million rows is spelled.
 */
export const grid = {
  /* ---- Grid body --------------------------------------------------- */
  'grid.notRun': 'Not run yet',
  'grid.running': 'Running…',
  'grid.noRows': '0 rows',
  'grid.scrollbarLabel': 'Table vertical scroll',
  'grid.columnTitle': '{name} · {type}',
  'grid.columnTitlePk': '{name} · {type} · primary key',

  /* ---- Result footer ----------------------------------------------- */
  'grid.rows': { one: '{rows} row', other: '{rows} rows' },
  'grid.status.running': 'Receiving…',
  'grid.status.done': 'Done',
  'grid.status.paused': 'Paused',
  'grid.status.error': 'Failed',
  'grid.status.idle': 'Idle',
  'grid.paused': 'Paused · data is valid, re-run to continue',
  'grid.pausedTitle':
    '{reason}. The rows already loaded are complete and valid; re-run the query to keep fetching.',
  'grid.truncated': 'Truncated',

  /* ---- Copying out ------------------------------------------------- */
  'grid.copy.cell': 'Copy value',
  'grid.copy.cellTitle': 'The whole value, exactly as stored — not the preview the row shows',
  'grid.copy.rows': { one: 'Copy {count} row', other: 'Copy {count} rows' },
  'grid.copy.rowsTitle': 'Tab-separated with a header line: paste straight into a spreadsheet',
  'grid.copy.cells': { one: 'Copy {count} cell', other: 'Copy {count} cells' },
  'grid.copy.cellsTitle': 'The selected block as tab-separated text, with a header for its columns',
  'grid.copy.cellDone': 'Value copied.',
  'grid.copy.rowsDone': { one: 'Copied {count} row.', other: 'Copied {count} rows.' },
  'grid.copy.cellsDone': { one: 'Copied {count} cell.', other: 'Copied {count} cells.' },
  /* The other way a copied cell can be incomplete: the row it sits in has not
     arrived from the stream yet, so a placeholder was copied in its place. */
  'grid.copy.notLoaded': {
    one: '{count} cell had not loaded yet.',
    other: '{count} cells had not loaded yet.',
  },
  /* Said out loud rather than left to be discovered when the paste will not
     parse: a large value only exists in this window as its first 4KB. */
  'grid.copy.previewOnly': {
    one: '{count} value was too large to hold in full, so its preview was copied.',
    other: '{count} values were too large to hold in full, so their previews were copied.',
  },
  'grid.copy.failed': 'The clipboard refused the copy.',
  'grid.truncatedTitle': 'Hit the maxRows ceiling; there is more data behind it',
  'grid.evicted': { one: '{count} chunk evicted', other: '{count} chunks evicted' },
  'grid.evictedTitle':
    'Over the 200MB cache budget, so distant chunks were evicted LRU-first; scrolling back shows placeholders until they are re-fetched',

  /* ---- Value modal ------------------------------------------------- */
  'value.subtitle': '{type} · row {row}',
  'value.fetchFull': 'Fetch full value',
  'value.fetching': 'Fetching…',
  'value.fetchFullTitle': 'Fetch the whole value through valuePeek',
  'value.peekUnavailable': 'This preload build exposes no valuePeek channel',
  'value.fetchFailed': 'Could not fetch the full value',
  'value.previewOnly': 'Showing the first 4KB only',
  'value.previewHint': ', click “Fetch full value” for the whole thing.',
  'value.previewNoPeek': '; this preload build exposes no valuePeek channel, so the rest is unreachable.',
  'value.base64': '(base64, {size})',
  'value.base64Partial': '(base64, {size}, incomplete)',

  /* ---- Status bar -------------------------------------------------- */
  'status.connected': '{ready}/{total} connected',
  'status.rows': { one: '{rows} row', other: '{rows} rows' },
  'status.receiving': 'receiving',
  'status.inflight': { one: '{count} command in flight', other: '{count} commands in flight' },
  'status.cache': 'Cache {size} / {pct}%',
  'status.cacheTitle': 'Renderer result cache (200MB budget, LRU eviction)',
  'status.resync': { one: '{count} resync', other: '{count} resyncs' },
  'status.resyncTitle': 'Times the mirror realigned after a gap in patch revisions',
  'status.preloadMissing': 'preload not ready',
  'status.revTitle': 'Workspace revision',
} as const

export type GridMessages = typeof grid
