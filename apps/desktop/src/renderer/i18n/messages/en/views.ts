/** The five view kinds: table, query, tree, inspector, vector. */
export const views = {
  /* ---- Table view -------------------------------------------------- */
  'table.refresh': 'Refresh',
  'table.refreshTitle': 'Fetch again',
  'table.prevPage': 'Previous page',
  'table.nextPage': 'Next page',
  'table.pageSizeTitle': 'Rows per page',
  'table.pageSize': '{n} rows/page',
  'table.filters': { one: '{count} filter', other: '{count} filters' },
  'table.waitingForScan': 'Waiting for main to start the scan…',

  /* ---- Query view -------------------------------------------------- */
  'query.run': 'Run',
  'query.cancel': 'Cancel',
  'query.runHint': '⌘⏎ to run',
  'query.empty': 'Write a statement and run it',

  /* ---- Tree view --------------------------------------------------- */
  'tree.loading': 'Loading…',
  'tree.empty': 'Nothing here',
  'tree.refresh': 'Refresh',
  'tree.openHint': 'Double-click a table to open it',
  'tree.loadFailed': 'Load failed: {error}',
  'tree.unavailable': 'The namespace tree is unavailable.',
  'tree.unavailableDetail':
    'The Command Bus has no introspect command, and preload exposes no introspect extension channel, so the renderer cannot reach the child nodes.',
  'tree.browseWithSql': 'Browse objects with SQL instead',

  /* ---- Inspector --------------------------------------------------- */
  'inspector.empty': 'Nothing selected',
  'inspector.fetchFull': 'Fetch full value',
  'inspector.fetching': 'Reading…',
  'inspector.notFetched': '(not fetched yet)',
  'inspector.fetchFailed': 'Could not read the value',
  'inspector.peekUnavailable': 'preload exposes no valuePeek channel',

  /* Labels of the read-only key/value grid. `key`, `db`, `collection` and
   * `point` are addressing identifiers and stay untranslated in the component. */
  'inspector.field.type': 'Type',
  'inspector.field.ttl': 'TTL',
  'inspector.field.elements': 'Elements',
  'inspector.field.contentType': 'Content type',
  'inspector.field.bytesFetched': 'Bytes fetched',
  'inspector.field.bytesTotal': 'Bytes total',
  'inspector.field.result': 'Result set',
  'inspector.field.row': 'Row',
  'inspector.field.column': 'Column',
  'inspector.field.collection': 'Collection',
  'inspector.field.primaryKey': 'Primary key',
  'inspector.field.path': 'Path',
  'inspector.field.field': 'Field',

  /* ---- Vector view ------------------------------------------------- */
  'vector.notImplemented': 'Vector search is not implemented yet',
  'vector.queryVector': 'Query vector, {dim} dims',
  'vector.textQuery': 'Text query',
  'vector.plannedM4': 'Completed in M4',
} as const

export type ViewsMessages = typeof views
