/** Sidebar, the connect dialog, the MCP settings panel, and the first-run guide. */
export const sidebar = {
  'sidebar.connections': 'Connections',
  'sidebar.newConnection': 'New connection',
  'sidebar.settings': 'MCP endpoint settings',
  'sidebar.empty': 'No connections yet',
  'sidebar.emptyHint': 'Use ＋ in the top right to add one',

  /* Tooltip on a row; the key glyph marks an entry whose password is in the vault. */
  'sidebar.secretStored': 'Password saved in the system keychain',
  'sidebar.connectHint': 'Double-click to connect',
  'sidebar.noKeychain':
    'The system keychain is unavailable, so passwords are not being saved. peek never writes a credential to disk unprotected.',

  /* Actions on the selected connection. Which of these appear depends on whether
     the row has a live connection — see the note on ConnectionRowItem. */
  'sidebar.action.connect': 'Connect',
  'sidebar.action.tree': 'Object tree',
  'sidebar.action.query': 'Query',
  'sidebar.action.disconnect': 'Disconnect',
  'sidebar.action.edit': 'Edit',
  'sidebar.action.remove': 'Remove',
  'sidebar.action.removeConfirm': 'Remove for good?',
  /* Shown instead of the query action on a driver with no tabularQuery capability. */
  'sidebar.action.noQuery': 'No query language',
  'sidebar.action.noQueryTitle': '{driverId} has no statement interface; browse it through the object tree',

  /* Second line of a row, drawn only while it has something to report. */
  'sidebar.status.connecting': 'Connecting…',
  'sidebar.status.error': 'Connection failed',

  'connect.title': 'New connection',
  'connect.editTitle': 'Edit connection',
  'connect.driver': 'Driver',
  'connect.capabilities': 'Capabilities: {list}',
  'connect.label': 'Display name',
  'connect.labelPlaceholder': 'Leave empty to generate one',
  'connect.privacyNote':
    'Passwords in the connection string never leave the main process; the config sent back to the window is always redacted.',
  'connect.savedSecretInUse': 'The saved password will be used. Type in the password box to override it.',
  'connect.savedSecretNotUsed':
    'This no longer matches the connection the password was saved for, so it will not be sent. Enter it again.',
  'connect.cancel': 'Cancel',
  'connect.submit': 'Connect',
  'connect.connecting': 'Connecting…',
  /* The rejected field, quoted verbatim next to the form. */
  'connect.invalid': 'That is not a valid connection: {issue}',

  /* How the connection is spelled — a URL, or one field per part. */
  'connect.mode': 'Enter as',
  'connect.mode.url': 'Connection string',
  'connect.mode.fields': 'Fields',

  /* Field labels. Which of these appear depends on the driver — see connectForm.ts. */
  'connect.field.url': 'Connection string',
  'connect.field.host': 'Host',
  'connect.field.port': 'Port',
  'connect.field.database': 'Database',
  'connect.field.user': 'User',
  'connect.field.username': 'User',
  'connect.field.password': 'Password',
  'connect.field.ssl': 'Use TLS',
  'connect.field.tls': 'Use TLS',
  /* redis numbers its logical databases; the index is chosen per client, not per URL. */
  'connect.field.db': 'Database index',
  'connect.field.file': 'Database file',
  'connect.field.readOnly': 'Open read-only',
  'connect.field.qdrantUrl': 'Server address',
  'connect.field.apiKey': 'API key',

  /* ---------------- MCP endpoint settings ---------------- */
  'mcp.title': 'MCP endpoint',
  'mcp.close': 'Close',
  'mcp.done': 'Done',
  'mcp.state': 'Status',
  'mcp.stateListening': 'Listening',
  'mcp.stateDown': 'Not running — no AI client can reach this window',
  'mcp.stateRestarting': 'Restarting…',
  'mcp.stateUnknown': 'Checking…',
  'mcp.endpoint': 'Address',
  'mcp.token': 'Token',
  'mcp.reveal': 'Reveal',
  'mcp.hide': 'Hide',
  'mcp.copyToken': 'Copy token',
  'mcp.copyCommand': 'Copy the claude mcp add command',
  'mcp.commandCopied': 'Command copied. Paste it into a terminal to register this window.',
  'mcp.tokenCopied': 'Token copied.',
  'mcp.copyFailed': 'The clipboard is unavailable; select the text and copy it manually.',
  'mcp.noCommandYet': 'There is no command to copy until the endpoint is listening.',
  'mcp.port': 'Port',
  'mcp.applyPort': 'Apply port',
  'mcp.portInvalid': 'A port is a whole number between 1 and 65535.',
  'mcp.portUnchanged': 'That is already the port in use.',
  'mcp.portApplied': 'Port saved. It is used on every launch from now on.',
  'mcp.portFallback':
    'Port {preferred} was busy, so the endpoint is on {actual}. Copy the command again, or free that port and reapply.',
  'mcp.rotateToken': 'Rotate token',
  'mcp.rotateWarning':
    'Rotating the token, or moving the port, invalidates every AI client already registered — re-run the command above in each of them.',
  'mcp.tokenRotated': 'A new token is live. The previous one is refused from now on; re-register your clients.',
  'mcp.reregisterRequired': 'The endpoint moved. Re-register your AI clients with the command above.',

  /* ---------------- First run ---------------- */
  'firstRun.title': 'Nothing is connected yet',
  'firstRun.subtitle': 'peek is a database viewer that an AI can drive. Three things you can do from here.',
  'firstRun.connectTitle': 'Open a database',
  'firstRun.connectBody': 'PostgreSQL, MySQL, SQLite, Redis or Qdrant. Read-only, always.',
  'firstRun.connectAction': 'New connection',
  'firstRun.mcpTitle': 'Let an AI client drive this window',
  'firstRun.mcpBody':
    'An MCP server is already listening on the loopback address. Register it once and your assistant can open views, run queries and rearrange the layout — through the same commands the buttons here use.',
  'firstRun.mcpAction': 'Copy the registration command',
  'firstRun.mcpCopied': 'Copied — paste it into a terminal',
  'firstRun.mcpSettings': 'Endpoint settings',
  'firstRun.mcpDown': 'The endpoint is not listening; open the settings to see why.',
  'firstRun.chatTitle': 'Or use the chat panel built in',
  'firstRun.chatBody': 'The same assistant, in a panel, already pointed at this window.',
  'firstRun.chatAction': 'Open chat',
} as const

export type SidebarMessages = typeof sidebar
