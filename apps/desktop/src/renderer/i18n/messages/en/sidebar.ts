/** Sidebar, the connect dialog, and the first-run guide. (The settings dialog
 *  has its own domain file; the MCP keys moved there with the panel.) */
export const sidebar = {
  'sidebar.connections': 'Connections',
  'sidebar.newConnection': 'New connection',
  /* The two states of one button: it stays at the same pixel either way. */
  'sidebar.collapse': 'Collapse the connection list',
  'sidebar.expand': 'Show the connection list',
  'sidebar.empty': 'No connections yet',
  'sidebar.emptyHint': 'Add one from the top right',

  /* Tooltip on a row; the key glyph marks an entry whose password is in the vault. */
  'sidebar.secretStored': 'Password saved in the system keychain',
  'sidebar.connectHint': 'Double-click to connect',
  'sidebar.noKeychain':
    'The system keychain is unavailable, so passwords are not being saved. Peek never writes a credential to disk unprotected.',

  /* Actions on the selected connection. Which of these appear depends on whether
     the row has a live connection — see the note on ConnectionRowItem. */
  'sidebar.action.connect': 'Connect',
  'sidebar.action.tree': 'Object tree',
  'sidebar.action.query': 'Query',
  'sidebar.action.disconnect': 'Disconnect',
  'sidebar.action.edit': 'Edit',
  'sidebar.action.remove': 'Remove',
  'sidebar.action.removeConfirm': 'Remove for good',
  /* Occupies the position the Remove button was in, so the second click of an
     accidental double-click lands here. See the baseline design doc §2.5. */
  'sidebar.action.removeCancel': 'Keep',
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

  /* ---------------- When the package is not there ----------------
     Both states arrived with design 2026-08-11: a database package can be
     uninstalled, so "which databases exist" is a fact about the disk and can be
     none. The driver id is not translated — it is the identifier the picker, the
     settings table and the MCP receipts all spell. */
  'connect.noPackages':
    'No database packages are installed, so there is nothing to connect to. Settings → Databases installs one, or restores the ones Peek ships with.',
  'connect.driverGone':
    'No installed database package provides "{driverId}", so this connection cannot be opened until that package is installed again under Settings → Databases.',

  /* ---------------- First run ---------------- */
  'firstRun.title': 'Nothing is connected yet',
  'firstRun.subtitle': 'Peek is a database viewer that an AI can drive. Three things you can do from here.',
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
