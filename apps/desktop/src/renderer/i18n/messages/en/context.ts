/**
 * "Add what I am looking at to the conversation" — the menu, the chips and the
 * disclosure that data leaves the machine.
 *
 * Note that none of this text ever reaches the model. Everything the agent reads
 * is built in main and is English forever (`serialize.ts`); these strings are for
 * the human, and are translated like any other UI surface.
 */
export const context = {
  /* ---- Menu entries ------------------------------------------------ */
  'context.menu.title': 'Add to chat',
  'context.menu.empty': 'Nothing here can be added to a chat',
  'context.menu.noChat': 'Open a chat panel first',
  'context.menu.noChatTitle': 'Attachments need somewhere to go: open a chat view, then try again.',

  'context.attach.rows': { one: 'Add {count} selected row', other: 'Add {count} selected rows' },
  'context.attach.rowsTitle': 'Send exactly the rows highlighted in the grid',
  'context.attach.result': 'Add this result (first {count} rows)',
  'context.attach.resultTitle':
    'Send the result set as it stands when the message is sent — edit the query and re-run first, and the new rows are what goes',
  'context.attach.cell': 'Add cell {column} (row {row})',
  'context.attach.cellTitle': 'Send the whole value, not the preview the grid shows',
  'context.attach.cells': 'Add these {columns} columns × {rows} rows',
  'context.attach.cellsCapped': 'Add the first {capped} rows of this block (of {rows})',
  'context.attach.cellsTitle': 'Send only the columns the selection covers, not the whole row',
  'context.attach.schema': 'Add structure of {name}',
  'context.attach.schemaTitle': 'Columns, types, primary key and indexes',
  'context.attach.query': 'Add the query text',
  'context.attach.queryTitle': 'Send whatever is in the editor when the message is sent',
  'context.attach.workspace': 'Add what is on screen',
  'context.attach.workspaceTitle':
    'The layout and a one-line description of every open view. Connection credentials are never included.',

  /* ---- Floating action --------------------------------------------- */
  'context.float.add': { one: 'Add {count} row to chat', other: 'Add {count} rows to chat' },
  'context.float.clear': 'Clear selection',
  'context.float.spanWarning':
    'These rows are {span} apart. Peek will not read that far to collect {count} of them — select rows closer together, or add the whole result.',

  /* ---- Chip names ---------------------------------------------------
   *
   * A chip is a noun: it answers "what will this message carry", not "what
   * happens if I click". That is why these are a separate group from
   * `context.attach.*` (menu entries) and `context.float.*` (the button) —
   * those two are imperative sentences, and one string cannot be both without
   * being bad at both. The chip already shows its kind in its own segment, so
   * nothing here repeats the word "rows" as a category.
   *
   * Three kinds are absent on purpose. A schema chip is `public.orders` and a
   * mention is `@public.orders`: an identifier, not prose, and translating it
   * would break the one thing it is for. The workspace chip reuses
   * `chat.attach.option.workspace` rather than saying the same thing twice.
   */
  'context.label.rows': { one: '{source} · {count} row', other: '{source} · {count} rows' },
  'context.label.result': '{source} · first {count} rows',
  'context.label.cell': '{source}.{column}[{row}]',
  'context.label.cells': '{source} · {columns} cols × {rows} rows',
  'context.label.query': '{source} · SQL',

  /* ---- @ mentions ---------------------------------------------------- */
  'context.mention.label': 'Add context',
  'context.mention.hint': 'Type to filter · ↑↓ to choose · ⏎ to confirm',
  'context.mention.empty': 'Nothing matches. Open a table or run a query, then @ it.',
  'context.mention.full': 'This message already carries {count} attachments, the most it can.',
  'context.mention.added': 'Added',

  /* ---- Attachment chips -------------------------------------------- */
  'context.chips.heading': { one: '{count} attachment', other: '{count} attachments' },
  'context.chips.remove': 'Remove {label}',
  'context.chips.pending': 'Will be collected when you send',
  'context.chips.truncatedRows': 'first {included} of {total} rows',
  'context.chips.truncatedRowsUnknown': 'first {included} rows',
  'context.chips.truncatedChars': 'first {included} of {total} characters',
  'context.chips.omitted': 'too large for this message',
  'context.chips.sourceIncomplete': 'the result itself is incomplete',
  'context.chips.failed': 'unavailable',

  /* ---- Disclosure -------------------------------------------------- */
  'context.consent.title': 'This data will be sent to Anthropic',
  'context.consent.body':
    'Adding rows, values, queries or table structures to the chat sends them to Anthropic’s API as part of your message, so that Claude can read them. They leave this machine.',
  'context.consent.scope':
    'Only what you attach is sent. Peek never includes connection credentials — no passwords, API keys, hosts or usernames.',
  'context.consent.production':
    'Treat this the way you would treat pasting the same rows into any external service. If the connection holds personal or regulated data, check that this is allowed before continuing.',
  'context.consent.once': 'You will only be asked this once.',
  'context.consent.accept': 'I understand — add it',
  'context.consent.cancel': 'Cancel',

  /* ---- Announcements ----------------------------------------------- */
  'context.added': 'Added {label} to the chat',
  'context.addFailed': 'Could not add {label} to the chat',
  'context.removed': 'Removed {label}',
} as const

export type ContextMessages = typeof context
