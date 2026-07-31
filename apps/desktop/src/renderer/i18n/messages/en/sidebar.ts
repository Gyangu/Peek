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

  /* Per-driver label for the primary connection field. */
  'connect.field.postgres': 'Connection string',
  'connect.field.mysql': 'Connection string',
  'connect.field.sqlite': 'File path',
  'connect.field.redis': 'Connection string',
  'connect.field.qdrant': 'Server address',
} as const

export type SidebarMessages = typeof sidebar
