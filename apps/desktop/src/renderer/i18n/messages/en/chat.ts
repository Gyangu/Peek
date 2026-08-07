/**
 * The chat panel: transcript, composer, tool calls and the permission dialog.
 *
 * Rule that does not bend: strings an *agent* reads (tool names on the wire, MCP
 * arguments, ACP option ids) are never translated. Only what a *human* reads is
 * in here.
 */
export const chat = {
  /* ---- Shell ------------------------------------------------------- */
  'chat.title': 'Chat',
  'chat.newSession': 'Waiting for the agent…',
  'chat.session': 'Session',
  'chat.noSession': 'no session',
  'chat.clear': 'Clear',
  'chat.clearTitle': 'Discard this conversation and start over',
  'chat.usage': '{used} / {size} tokens',
  'chat.usageTitle': 'Context window used',

  /* ---- Agent status ------------------------------------------------ */
  'chat.status.idle': 'Idle',
  'chat.status.starting': 'Starting the agent…',
  'chat.status.authenticating': 'Signing in…',
  'chat.status.loading': 'Loading the conversation…',
  'chat.status.ready': 'Ready',
  'chat.status.streaming': 'Replying…',
  'chat.status.awaiting-permission': 'Waiting for you',
  'chat.status.error': 'Error',

  /* ---- Permission mode --------------------------------------------- */
  'chat.mode.label': 'Permissions',
  'chat.mode.auto': 'Automatic',
  'chat.mode.default': 'Ask every time',
  'chat.mode.acceptEdits': 'Accept edits',
  'chat.mode.plan': 'Plan only',
  'chat.mode.dontAsk': 'Never ask',
  'chat.mode.bypassPermissions': 'Bypass all checks',
  'chat.mode.title': 'Who approves the tools the agent wants to run',

  /* ---- Transcript -------------------------------------------------- */
  'chat.empty.title': 'Ask about the data you are looking at',
  'chat.empty.hint':
    'Claude can read this workspace and open views, run queries and rearrange the layout for you.',
  /*
   * Shown while a conversation opened from the rail is being fetched. It exists
   * because the empty state above used to stand in for it: a conversation with
   * an hour of history in it would render "Ask about the data you are looking
   * at" for the second and a half the load takes, which reads as *this is gone*
   * rather than *this is coming*. See
   * `design/2026-08-06-opening-a-stored-conversation.md` §1.2.
   *
   * The title line is the conversation's own when the rail passed one through,
   * and this generic line when it did not — never a guess.
   */
  'chat.loading.title': 'Reading this conversation',
  'chat.loading.hint':
    'The agent keeps the history and is restoring it. Opening a conversation for the first time takes a moment.',

  /* ---- The stored snapshot ------------------------------------------ */
  /*
   * Said while peek's own picture of a conversation stands in for the agent's
   * copy. Both lines say "what peek last saw" rather than "this conversation",
   * and that is not modesty: peek only ever saw the turns it was open for, so a
   * conversation continued elsewhere is genuinely not what is on screen.
   */
  'chat.snapshot.loading': 'This is what peek last saw. The agent’s own copy is on its way.',
  'chat.snapshot.failed.title': 'This is peek’s snapshot, not a live conversation',
  'chat.snapshot.failed.detail':
    'The agent could not load this conversation, so what you see is what peek last showed — which may also be out of date. Sending a message here is not possible: the agent would not have this history behind it.',
  'chat.snapshot.retry': 'Try again',
  'chat.snapshot.composer': 'This conversation could not be loaded',
  'chat.role.user': 'You',
  'chat.role.agent': 'Claude',
  'chat.writing': 'Writing…',
  'chat.stop.cancelled': 'Stopped',
  'chat.stop.max_tokens': 'Cut off at the token limit',
  'chat.stop.max_turn_requests': 'Cut off at the request limit',
  'chat.stop.refusal': 'Declined',
  'chat.stop.error': 'Interrupted',
  'chat.jumpToLatest': 'Jump to the latest',

  /* ---- Thinking ---------------------------------------------------- */
  'chat.thought': 'Thought',
  'chat.thought.show': 'Show reasoning',
  'chat.thought.hide': 'Hide reasoning',

  /* ---- Tool calls -------------------------------------------------- */
  'chat.tool.status.pending': 'Queued',
  'chat.tool.status.in_progress': 'Running',
  'chat.tool.status.completed': 'Done',
  'chat.tool.status.failed': 'Failed',
  'chat.tool.actedOnWindow': 'Changed this window',
  'chat.tool.readWindow': 'Read this window',
  'chat.tool.lookup': 'Looked up a tool',
  'chat.tool.via': 'via {server}',
  'chat.tool.outside': 'Outside peek',
  'chat.tool.outsideTitle':
    'Not one of peek’s tools. Whatever this did happened outside this window, so nothing here can account for it.',
  'chat.tool.arguments': 'Arguments',
  'chat.tool.result': 'Result',
  'chat.tool.noResult': 'No result',
  'chat.tool.expand': 'Show details',
  'chat.tool.collapse': 'Hide details',
  'chat.tool.elapsed': '{ms} ms',

  /* Human names for peek's own MCP tools. These label what the agent did to the
     window, so they are phrased as actions, not as identifiers. */
  'chat.tool.peek.open_view': 'Opened a view',
  'chat.tool.peek.activate_view': 'Switched to a view',
  'chat.tool.peek.move_view': 'Moved a view',
  'chat.tool.peek.set_layout': 'Rearranged the layout',
  'chat.tool.peek.run_query': 'Ran a query',
  'chat.tool.peek.connect': 'Opened a connection',
  'chat.tool.peek.read_workspace': 'Read the workspace',
  'chat.tool.peek.introspect': 'Inspected the schema',
  'chat.tool.peek.list_connections': 'Listed the connections',

  /* ---- Code blocks ------------------------------------------------- */
  'chat.code.copy': 'Copy',
  'chat.code.copied': 'Copied',

  /* ---- Plan -------------------------------------------------------- */
  'chat.plan.title': 'Plan',
  'chat.plan.progress': '{done}/{total}',
  'chat.plan.status.pending': 'To do',
  'chat.plan.status.in_progress': 'In progress',
  'chat.plan.status.completed': 'Done',

  /* ---- Composer ---------------------------------------------------- */
  'chat.composer.placeholder': 'Ask about this data…',
  'chat.composer.send': 'Send',
  'chat.composer.stop': 'Stop',
  'chat.composer.stopTitle': 'Cancel the turn in flight',
  /* Key notation, identical in every language — see the note in QueryView. */
  'chat.composer.hint': '⏎ send · ⇧⏎ newline',
  'chat.composer.busy': 'Claude is still replying',
  'chat.composer.notReady': 'The agent is not ready yet',

  /* ---- Recovering from a crash -------------------------------------- */
  /* The composer stays usable in the error state on purpose: sending is what
     reconnects. These two say so, rather than leaving the user to guess. */
  'chat.retry.hint': 'The agent stopped. Send another message and it will be started again — this conversation is kept.',
  'chat.retry.placeholder': 'Send a message to reconnect…',

  /* ---- Context attachments ----------------------------------------- */
  'chat.attach.label': 'Context',
  'chat.attach.add': 'Add context',
  'chat.attach.addTitle': 'Attach what you are looking at to the next message',
  'chat.attach.remove': 'Remove',
  'chat.attach.empty': 'Nothing attached',
  'chat.attach.count': { one: '{count} attachment', other: '{count} attachments' },
  'chat.attach.kind.rows': 'Rows',
  'chat.attach.kind.result': 'Result',
  'chat.attach.kind.cell': 'Cell',
  'chat.attach.kind.schema': 'Schema',
  'chat.attach.kind.query': 'Query',
  'chat.attach.kind.workspace': 'Workspace',
  'chat.attach.option.workspace': 'This workspace',
  'chat.attach.option.workspaceHint': 'Layout, open views and connections',
  'chat.attach.option.result': 'Result of {view}',
  'chat.attach.option.query': 'SQL of {view}',
  'chat.attach.noCandidates': 'Nothing here to attach yet',
  'chat.attach.sentWith': 'Sent with this message',

  /* ---- Permission prompt ------------------------------------------- */
  'chat.permission.title': 'Claude wants to run a tool',
  'chat.permission.titlePeek': 'Claude wants to change this window',
  'chat.permission.titlePeekRead': 'Claude wants to read this window',
  'chat.permission.tool': 'Tool',
  'chat.permission.arguments': 'Arguments',
  'chat.permission.kind.allow_once': 'Allow once',
  'chat.permission.kind.allow_always': 'Always allow',
  'chat.permission.kind.reject_once': 'Reject',
  'chat.permission.kind.reject_always': 'Always reject',
  'chat.permission.waiting': 'The conversation is paused until you decide.',
  'chat.permission.label': 'Tool permission request',
  'chat.md.linkCopied': 'Link copied.',
  'chat.md.linkCopyFailed': 'The clipboard refused the copy.',
  /* Spelled out because it is the only option here that changes anything beyond
     this one call, and nothing in a four-button row says so on its own. */
  'chat.permission.alwaysNote':
    '“Always allow” covers this tool for the rest of the conversation — you will not be asked about it again.',
  'chat.mode.confirmTitle': 'This takes you out of the loop',
  'chat.mode.confirmBody':
    '“{mode}” lets the agent run tools — including ones that change this window and read the data in it — without asking you first. It stays in effect until you change it back.',
  'chat.mode.confirmAccept': 'Switch anyway',
  'chat.mode.confirmCancel': 'Keep asking me',

  /* ---- Degraded states --------------------------------------------- */
  'chat.gap.title': 'The chat panel is not connected yet',
  'chat.gap.detail':
    'The renderer has no channel to the agent: preload exposes no chat delta stream, so nothing can arrive here. The panel stays visible so the wiring can be finished against it.',
  'chat.gap.command':
    'The Command Bus has no “{name}” command yet, so this action cannot be sent. Nothing was changed.',
  'chat.error.title': 'The agent reported an error',

  /* ---- The session catalogue --------------------------------------- */
  'chat.sessions.title': 'Conversations',
  'chat.sessions.railToggleTitle': 'Show or hide the conversation list',
  'chat.sessions.collapse': 'Collapse the conversation list',
  'chat.sessions.expand': 'Show the conversation list',
  'chat.sessions.new': 'New conversation',
  'chat.sessions.loading': 'Reading the conversation list…',
  'chat.sessions.empty': 'No conversations yet.',
  'chat.sessions.emptyHint': 'Start one and it will show up here, even after peek restarts.',
  /* Not an empty list: the agent in use keeps no history at all, which is a
   * different sentence and has to read like one. */
  'chat.sessions.unsupported': 'This agent keeps no conversation history.',
  'chat.sessions.unsupportedHint':
    'Reopening past conversations needs an agent that advertises session history; this one does not, so nothing is stored to list.',
  'chat.sessions.untitled': 'Untitled conversation',
  'chat.sessions.open': 'Open',
  'chat.sessions.openTitle': 'Reopen this conversation and keep it open',
  'chat.sessions.rowHint': 'Click to peek, double-click to keep',
  'chat.sessions.inUse': 'Already open',
  'chat.sessions.inUseTitle': 'This conversation is open in a panel already',
  'chat.sessions.reveal': 'Show it',
  'chat.sessions.revealTitle': 'Jump to the panel this conversation is already open in',
  'chat.sessions.delete': 'Delete',
  'chat.sessions.deleteConfirm': 'Delete for good',
  'chat.sessions.deleteCancel': 'Keep',
  'chat.sessions.deleteTitle': 'Delete this conversation from disk',
  'chat.sessions.refresh': 'Refresh',
  'chat.sessions.failed': 'Could not read the conversation list',
} as const

export type ChatMessages = typeof chat
