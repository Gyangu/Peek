/** The five view kinds: table, query, tree, inspector, vector. */
export const views = {
  /* ---- Controls shared by every result view (table / query / vector) --
   * One set of words, because the three views do the same two things: stop the
   * request, and explain a hole the cache made. `driverId` is an identifier and
   * is never translated. */
  'result.cancel': 'Cancel',
  'result.cancelTitle': 'Stop this request; the rows already loaded stay',
  /* Not "unavailable" — this driver will never be able to stop a request, and a
   * word that suggests waiting helps would be worse than saying nothing. */
  'result.cancelUnsupported': 'Cannot cancel',
  /* One string literal, not a `+` concatenation: TypeScript widens a concatenation
   * to `string`, and the catalog's parameter typing is derived from the literal —
   * a joined message with a {placeholder} in it stops type-checking its own params. */
  'result.cancelUnsupportedTitle':
    'The {driverId} driver cannot stop a request once it has started. Peek’s only remaining option is to kill the driver process, which closes this connection — so that is not offered as a button. Close the connection to stop it, or wait for the request timeout.',
  'result.cacheGap': 'Rows dropped from the cache.',
  'result.cacheGapDetail':
    'These rows were evicted to stay within the memory budget. They cannot be fetched back on their ' +
    'own — the cursor they came from is closed — so re-running the request is the way to see them again.',
  'result.cacheGapRefetch': 'Run again',

  /* ---- Auto-refresh ------------------------------------------------
   * The button shows the interval rather than only being lit: "is it on" and
   * "how fast" are both live questions, and the second cannot be recovered by
   * looking at the grid. The units are appended to a number by `formatInterval`,
   * so they are suffixes, not words. */
  'autoRefresh.off': 'Off',
  'autoRefresh.unitS': 's',
  'autoRefresh.unitMin': ' min',
  'autoRefresh.unitH': ' h',
  'autoRefresh.menuLabel': 'Auto-refresh interval',
  'autoRefresh.title': 'Auto-refresh: fetch this view again on a timer',
  'autoRefresh.onTitle':
    'Auto-refreshing every {interval}. The first fetch is one interval away — press Refresh for one now.',
  'autoRefresh.stoppedPaged':
    'Auto-refresh switched off: this collection pages forward with a cursor, and a refresh restarts the scan from the first page.',
  'autoRefresh.stoppedError': 'Auto-refresh switched off after three failed attempts in a row.',

  /* ---- Table view -------------------------------------------------- */
  'table.refresh': 'Refresh',
  'table.refreshTitle': 'Fetch again',
  'table.refreshCursorTitle': 'Fetch again from the first page',
  'table.prevPage': 'Previous page',
  'table.nextPage': 'Next page',
  'table.cursorPaged': 'Cursor-paged',
  'table.cursorPagedTitle':
    'This collection is walked with a continuation cursor: pages go forward only, and Refresh starts over',
  'table.noMorePages': 'No more pages',
  'table.sortUnsupported': 'This collection cannot be sorted by the server',
  'table.pageSizeTitle': 'Rows per page',
  'table.pageSize': '{n} rows/page',
  'table.filters': { one: '{count} filter', other: '{count} filters' },
  'table.waitingForScan': 'Waiting for main to start the scan…',

  /* ---- Query view -------------------------------------------------- */
  'query.run': 'Run',
  'query.runHint': '⌘⏎ to run',
  'query.empty': 'Write a statement and run it',

  /* ---- Tree view --------------------------------------------------- */
  'tree.loading': 'Loading…',
  'tree.connecting': 'Connecting…',
  'tree.notReady': 'The connection is not ready',
  'tree.empty': 'Nothing here',
  'tree.refresh': 'Refresh',
  /* Neutral wording: the leaf may be a table, a collection or a single key. */
  'tree.openHint': 'Double-click to open',
  'tree.vectorSearch': 'Search',
  'tree.vectorSearchTitle': 'Open a vector search on this collection',
  'tree.loadFailed': 'Load failed: {error}',
  /* The two things a "…" row can mean. They are separate keys because only one
   * of them has a number, and the wording of the other must never acquire one:
   * a driver reaches `tree.elision.unknown` precisely when it stopped reading
   * before the level ended, so any figure it could offer would be a count of
   * what it happened to see, printed where the reader would take it for a count
   * of what is left. */
  /* Not a plural: "more" does not inflect, and one/other spelled identically
   * reads as an oversight rather than a decision. */
  'tree.elision.more': '{count} more, not shown',
  'tree.elision.unknown': 'More here than this tree read — open this level as a table to see everything',
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
  'inspector.keyValueUnavailable': 'This connection cannot read keys',
  'inspector.reload': 'Read again',
  'inspector.nextWindow': 'More elements',
  'inspector.window': '{shown} of {total} shown',
  'inspector.windowEmpty': 'This window is empty',
  'inspector.keyMissing': 'The key does not exist (it may have expired)',
  'inspector.ttlNone': 'never expires',
  'inspector.fetchElement': 'Fetch this element',
  'inspector.elementTruncated': 'cut short ({bytes})',

  /* Column headings of the typed value table; which pair appears depends on the shape. */
  'inspector.col.field': 'Field',
  'inspector.col.value': 'Value',
  'inspector.col.index': 'Index',
  'inspector.col.member': 'Member',
  'inspector.col.score': 'Score',
  'inspector.col.entry': 'Entry',

  /* Labels of the read-only key/value grid. `key`, `db`, `collection` and
   * `point` are addressing identifiers and stay untranslated in the component. */
  'inspector.field.type': 'Type',
  /* The driver-independent bucketing the UI switches on (KeyValueShape). */
  'inspector.field.shape': 'Shape',
  'inspector.field.ttl': 'TTL',
  'inspector.field.elements': 'Elements',
  'inspector.field.encoding': 'Storage encoding',
  'inspector.field.memory': 'Memory',
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
  'vector.run': 'Search',
  'vector.queryVector': 'Query vector, {dim} dims',
  'vector.textQuery': 'Text query',
  /* The only query entry point a human can operate — "find points like this one". */
  'vector.pointId': 'Like point',
  'vector.pointIdTitle': 'Search for the nearest neighbours of this point id',
  'vector.vectorName': 'Vector',
  'vector.vectorNameDefault': 'default',
  'vector.vectorNameTitle':
    'Which named vector to search. Leave blank for the collection’s default (unnamed) vector.',
  'vector.topKTitle': 'How many matches to return',
  'vector.minScore': 'Min score',
  'vector.minScoreTitle':
    'Drop matches scoring below this. The collection’s distance metric decides whether that means near or far.',
  'vector.filters': { one: '{count} filter', other: '{count} filters' },
  'vector.empty': 'No matches',
  'vector.needQuery': 'Enter a point id and press Search',
  'vector.unavailable': 'This connection cannot search vectors',
} as const

export type ViewsMessages = typeof views
