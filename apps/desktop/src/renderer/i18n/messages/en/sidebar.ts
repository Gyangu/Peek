/** Sidebar and the connect dialog. */
export const sidebar = {
  'sidebar.connections': 'Connections',
  'sidebar.newConnection': 'New connection',
  'sidebar.empty': 'No connections yet',
  'sidebar.emptyHint': 'Use ＋ in the top right to add one',

  /* Actions on the selected connection. */
  'sidebar.action.tree': 'Object tree',
  'sidebar.action.query': 'Query',
  'sidebar.action.disconnect': 'Disconnect',
  /* Shown instead of the query action on a driver with no tabularQuery capability. */
  'sidebar.action.noQuery': 'No query language',
  'sidebar.action.noQueryTitle': '{driverId} has no statement interface; browse it through the object tree',

  /* Connection status line, shown when there is no server info to show instead. */
  'sidebar.status.idle': 'Not connected',
  'sidebar.status.connecting': 'Connecting…',
  'sidebar.status.ready': 'Connected',
  'sidebar.status.error': 'Connection failed',

  'connect.title': 'New connection',
  'connect.driver': 'Driver',
  'connect.capabilities': 'Capabilities: {list}',
  'connect.label': 'Display name',
  'connect.labelPlaceholder': 'Leave empty to generate one',
  'connect.privacyNote':
    'Passwords in the connection string never leave the main process; the config sent back to the window is always redacted.',
  'connect.cancel': 'Cancel',
  'connect.submit': 'Connect',
  'connect.connecting': 'Connecting…',
  /* zod's own rejection, quoted verbatim next to the form. */
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
} as const

export type SidebarMessages = typeof sidebar
