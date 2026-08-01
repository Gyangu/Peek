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

  /* ---- Degraded states --------------------------------------------- */
  'chat.gap.title': 'The chat panel is not connected yet',
  'chat.gap.detail':
    'The renderer has no channel to the agent: preload exposes no chat delta stream, so nothing can arrive here. The panel stays visible so the wiring can be finished against it.',
  'chat.gap.command':
    'The Command Bus has no “{name}” command yet, so this action cannot be sent. Nothing was changed.',
  'chat.error.title': 'The agent reported an error',
} as const

export type ChatMessages = typeof chat
