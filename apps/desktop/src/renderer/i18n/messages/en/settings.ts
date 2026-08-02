/**
 * The settings dialog: its shell, and all four sections.
 *
 * The `mcp.*` keys used to live in `sidebar.ts`, back when the endpoint panel
 * hung off the connection list. They moved here with the panel — see
 * `docs/design/2026-08-02-settings-panel.md`. The prefix stayed `mcp.` because
 * it names the subject, not the surface.
 */
export const settings = {
  /* ---------------- The shell ---------------- */
  'settings.open': 'Settings',
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.done': 'Done',
  'settings.sections': 'Settings sections',
  'settings.section.mcp': 'MCP endpoint',
  'settings.section.appearance': 'Appearance',
  'settings.section.timeouts': 'Queries & timeouts',
  'settings.section.about': 'About',

  /* ---------------- MCP endpoint ---------------- */
  'mcp.title': 'MCP endpoint',
  'mcp.intro': 'How an AI client reaches this window.',
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

  /* ---------------- Appearance ---------------- */
  'settings.language': 'Language',
  /* Language names are endonyms and never pass through t(); a picker written in
     a language you cannot read helps nobody. */
  'settings.languageHint': 'Applies immediately, and is remembered on this machine.',
  'settings.zoom': 'Interface size',
  /* Deliberately says "everything", because that is the difference between this
     and a font-size setting: row heights and hit targets scale with the text, so
     the layout keeps its proportions instead of turning into large type in
     small boxes. */
  'settings.zoomHint':
    'Scales the whole window — text, row heights and controls together. {keys} do the same.',

  /* ---------------- Queries & timeouts ---------------- */
  'settings.timeouts.intro':
    'How long a request may run before peek gives up on it. These apply when nothing asks for a specific deadline.',
  'settings.timeouts.query': 'Query',
  'settings.timeouts.scan': 'Collection scan',
  'settings.timeouts.vectorSearch': 'Vector search',
  'settings.timeouts.seconds': 'seconds',
  'settings.timeouts.zeroHint': 'Set a value to 0 to remove the deadline entirely.',
  'settings.timeouts.invalid': 'A timeout is a whole number of seconds between 0 and 3600.',
  'settings.timeouts.apply': 'Apply',
  'settings.timeouts.applied': 'Saved. These apply to requests started from now on.',
  'settings.timeouts.unchanged': 'Those are already the values in use.',
  'settings.timeouts.stageNote':
    'The driver-host protocol has its own internal timeouts. They protect peek from a stuck driver process rather than expressing a preference, so they are not shown here.',

  /* ---------------- About ---------------- */
  'settings.about.version': 'Version',
  'settings.about.configDir': 'Config folder',
  'settings.about.settingsFile': 'Settings',
  'settings.about.connectionsFile': 'Connections',
  'settings.about.mcpFile': 'MCP endpoint',
  'settings.about.pathsHint':
    'Everything peek writes lives in these files. PEEK_CONFIG_DIR moves them all together.',
  'settings.about.unavailable': 'Unavailable',
} as const

export type SettingsMessages = typeof settings
