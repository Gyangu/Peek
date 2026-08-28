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
  'settings.section.notifications': 'Notifications',
  'settings.section.keyboard': 'Keyboard',
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
  'mcp.tokenRotated':
    'A new token is live. The previous one is refused from now on; re-register your clients.',
  'mcp.reregisterRequired': 'The endpoint moved. Re-register your AI clients with the command above.',

  /* ---------------- Appearance ---------------- */
  'settings.language': 'Language',
  /* Language names are endonyms and never pass through t(); a picker written in
     a language you cannot read helps nobody. */
  'settings.languageHint': 'Applies immediately, and is remembered on this machine.',
  'settings.theme': 'Appearance',
  /* Names what follows the OS, because that is the only one of the three whose
     behaviour is not self-evident from its label. */
  'settings.themeHint': 'Following the system switches with macOS between light and dark.',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.themeSystem': 'System',
  'settings.zoom': 'Interface size',
  /* Deliberately says "everything", because that is the difference between this
     and a font-size setting: row heights and hit targets scale with the text, so
     the layout keeps its proportions instead of turning into large type in
     small boxes. */
  'settings.zoomHint':
    'Scales the whole window — text, row heights and controls together. {keys} do the same.',

  /* ---------------- Notifications ---------------- */
  'settings.notifications.system': 'System notifications',
  /* Says when they appear, not what they are: the surprising half of the rule is
     that peek stays quiet while you are looking at it. */
  'settings.notifications.systemHint':
    'Let Peek reach you through the notification centre when its window is not the one in front. ' +
    'While you are looking at Peek it shows a message in the app instead.',
  'settings.notifications.turnEnd': 'When the agent finishes',
  'settings.notifications.turnEndHint':
    'Tell you when a chat turn ends, or stops to ask permission, while you are working elsewhere. ' +
    'The agent can also notify you itself, at any point it judges worth interrupting for.',
  'settings.notifications.on': 'On',
  'settings.notifications.off': 'Off',

  /* ---------------- Queries & timeouts ---------------- */
  'settings.timeouts.intro':
    'How long a request may run before Peek gives up on it. These apply when nothing asks for a specific deadline.',
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
    'The driver-host protocol has its own internal timeouts. They protect Peek from a stuck driver process rather than expressing a preference, so they are not shown here.',

  'settings.section.packages': 'Databases',

  /* ---------------- Databases (the driver packages) ----------------
   * Names, ids, versions and capability names are all identifiers and stay
   * untranslated; only the surrounding prose is a message. */
  'settings.packages.hint':
    'Every database Peek can open, and which build of each connector this app is running.',
  'settings.packages.name': 'Database',
  'settings.packages.version': 'Connector',
  'settings.packages.capabilities': 'Capabilities',
  'settings.packages.source': 'Source',
  /*
   * Not "Bundled" / "User". The column answers whether *this build* ships a
   * package under that id, which is not the same as who put the installed copy
   * there — a user's newer PostgreSQL keeps the bundled id (design §2.5 rule 2)
   * and would then be labelled a lie by the shorter word. `sourceNote` below
   * carries the distinction in full, because this is also what decides whether
   * an uninstall is remembered.
   */
  'settings.packages.sourceBundled': 'Ships with Peek',
  'settings.packages.sourceUser': 'Added by you',
  /* The header of the button column. Visually hidden — the buttons say what they
   * do — but a row-by-row screen reader still announces which column it is in. */
  'settings.packages.manage': 'Manage',
  'settings.packages.sourceNote':
    'Source says whether this build of Peek ships a package under that id — not who put the installed copy there. Removing one Peek ships is remembered, so it stays gone after a restart; “Restore bundled packages” undoes that.',
  /*
   * The one sentence about trust, and it is a statement rather than a warning
   * (design §2.9 corollary 1). peek runs what is in the packages directory: no
   * signature check, no hash check, no sandbox. A warning with a button next to
   * it teaches people to click past warnings, so there is none — and no word
   * here may suggest anything was inspected.
   */
  'settings.packages.trustNote':
    'A package runs with your own privileges from the moment a connection opens. Peek does not inspect what is inside one — installing it is you deciding to trust it.',
  'settings.packages.install': 'Install…',
  'settings.packages.uninstall': 'Uninstall',
  'settings.packages.upgrade': 'Upgrade to {version}',
  'settings.packages.restore': 'Restore bundled packages',
  'settings.packages.reading': 'Reading…',
  'settings.packages.empty': 'Nothing is installed, so Peek cannot open any database.',
  'settings.packages.installed': 'Installed {id} {version}.',
  'settings.packages.replaced': 'Replaced {id}. {version} is installed now.',
  /*
   * "Removed", never "completely removed". The directory is gone and the
   * processes that had loaded it were killed, and that is all peek knows —
   * whatever the package wrote elsewhere while it ran is outside what this
   * button can speak for.
   */
  'settings.packages.uninstalled': 'Removed {id}.',
  'settings.packages.uninstalledClosed': {
    one: 'Removed {id}. {count} open connection was closed.',
    other: 'Removed {id}. {count} open connections were closed.',
  },
  'settings.packages.restored': 'Restored {ids}.',
  'settings.packages.restoredNone':
    'Nothing was missing — every package this build ships is already installed.',
  'settings.packages.restoreFailed': 'Could not restore {ids}.',
  'settings.packages.viewKinds': 'Views contributed by a package',
  'settings.packages.noViewKinds': 'None — every database above browses through the built-in views.',

  /* ---------------- The chat agent ---------------- */
  'settings.section.agent': 'Chat agent',
  'settings.agent.intro':
    'Which agent answers in the chat panel. Either one reaches this window through Peek’s own MCP endpoint, and every tool call still asks you first.',
  'settings.agent.backend': 'Agent',
  'settings.agent.backend.acp': 'Bundled agent',
  'settings.agent.backend.endpoint': 'Your own endpoint',
  /* Said once, at the top, because it applies to every control below it. */
  'settings.agent.restartHint':
    'Applies the next time Peek starts. Conversations you already have keep the agent they were created with — the two store history in different places, and neither can read the other’s.',
  'settings.agent.permissionMode': 'New conversations start in',
  'settings.agent.mode.default': 'Ask every time',
  'settings.agent.mode.auto': 'Let the agent judge',
  'settings.agent.mode.acceptEdits': 'Accept edits',
  'settings.agent.mode.plan': 'Plan only',
  'settings.agent.mode.dontAsk': '⚠ Never ask',
  'settings.agent.mode.bypassPermissions': '⚠ Bypass all checks',
  'settings.agent.modeHint.default': 'Every tool call waits for you. This is Peek’s default.',
  'settings.agent.modeHint.auto':
    'The agent’s own classifier approves calls instead of you. It still cannot reach anything beyond Peek’s tools.',
  'settings.agent.modeHint.acceptEdits':
    'Edits go through without asking; everything else still waits for you.',
  'settings.agent.modeHint.plan': 'The agent plans and explains, and runs nothing until you leave this mode.',
  'settings.agent.modeHint.dontAsk':
    'Tool calls run without asking. Every new conversation says “from settings” next to its mode.',
  'settings.agent.modeHint.bypassPermissions':
    'Nothing is checked and nothing is asked. Every new conversation says “from settings” next to its mode.',
  /* Says where the mode is visible, now that it can be set here. The old note
     said these two modes were deliberately absent — see the design doc §2.1 for
     why refusing to store the choice only meant re-making it every day. */
  'settings.agent.modeDangerNote':
    'The last two take you out of the loop for every new conversation. A conversation started on one of them marks it in the panel, and you can still change the mode there for that conversation alone.',
  'settings.agent.which': 'Which agent',
  'settings.agent.missing': 'not installed',
  'settings.agent.mcp': 'Your MCP servers',
  'settings.agent.mcp.none': 'None yet',
  'settings.agent.mcp.count': { one: '{count} server', other: '{count} servers' },
  'settings.agent.mcp.unnamed': 'New server',
  'settings.agent.mcp.name': 'Name',
  'settings.agent.mcp.namePlaceholder': 'lowercase-name',
  'settings.agent.mcp.transport': 'Transport',
  'settings.agent.mcp.transport.http': 'HTTP',
  'settings.agent.mcp.transport.stdio': 'Command',
  'settings.agent.mcp.enabled': 'Enabled',
  'settings.agent.mcp.target': 'Address',
  'settings.agent.mcp.targetPlaceholder.http': 'https://example.com/mcp',
  'settings.agent.mcp.targetPlaceholder.stdio': '/absolute/path/to/server',
  'settings.agent.mcp.authHeader': 'Header name',
  'settings.agent.mcp.authValue': 'Header value',
  'settings.agent.mcp.authValuePlaceholder': 'Bearer …',
  'settings.agent.mcp.add': 'Add a server',
  'settings.agent.mcp.remove': 'Remove',
  'settings.agent.mcp.discard': 'Discard changes',
  /* Names the rule rather than the field: the constraint is not arbitrary, and a
     user who knows why will not fight it. */
  'settings.agent.mcp.invalid':
    'Every server needs an address and a unique name of lowercase letters, digits, - or _. The name becomes the tool prefix the agent addresses it by.',
  'settings.agent.mcp.hint':
    'These are sent to the agent alongside Peek’s own tools. Peek does not gate what they do — a tool call still asks you, but what happens after that is between the agent and that server.',
  'settings.agent.workdir': 'Working directory',
  'settings.agent.workdirPick': 'Choose…',
  'settings.agent.workdirReset': 'Use Peek’s own',
  'settings.agent.workdirHint':
    'Where new conversations work. Point it at a project to let the agent read and edit that project; conversations already started keep the directory they were started in.',
  'settings.agent.fullTools': 'File and command tools',
  'settings.agent.fullTools.off': 'Off',
  'settings.agent.fullTools.on': 'On',
  /* States the consequence, not a warning about one. peek does not hold a gate
     here and should not sound like it does — see the design doc §2.5. */
  'settings.agent.relaxed':
    'The agent can read, write and run things on this machine, so it can also read Peek’s own MCP token and approve its own tool calls. The permission prompt is no longer a barrier — it is a notification. Peek does not stop this and cannot; you are turning it off deliberately.',
  'settings.agent.enforced':
    'Peek checks this agent’s sandbox with a probe against the real agent: no shell, no file tools, and none of your own Claude Code settings.',
  /* Names the gap rather than implying a guarantee peek has not tested. */
  'settings.agent.unverified':
    '{agent} is started in its read-only mode, but Peek has no probe that verifies it holds. Tool calls are still gated by you.',
  'settings.agent.loginHint':
    'Sign in with the agent’s own CLI. Peek reuses that login and never handles the credential.',
  'settings.agent.executable': 'Executable',
  'settings.agent.executablePlaceholder': 'Use the bundled one',
  'settings.agent.executableHint':
    'Optional. Point the agent at a binary you already have instead of the one Peek ships.',
  'settings.agent.baseUrl': 'Base URL',
  'settings.agent.model': 'Model',
  'settings.agent.modelHint':
    'The model id exactly as your endpoint spells it. It must support tool calling.',
  'settings.agent.api': 'API',
  'settings.agent.api.openai-completions': 'OpenAI-compatible',
  'settings.agent.api.anthropic-messages': 'Anthropic messages',
  'settings.agent.apiKey': 'API key',
  'settings.agent.apiKeyStored': 'Stored — type to replace',
  'settings.agent.apiKeyNone': 'None stored',
  'settings.agent.apiKeyHint':
    'Sealed by your operating system’s keychain, never written to settings.json, and never shown again.',
  'settings.agent.forgetKey': 'Forget key',
  'settings.agent.save': 'Save',
  'settings.agent.saved': 'Saved. It takes effect the next time Peek starts.',

  /* ---------------- About ---------------- */
  'settings.about.version': 'Version',
  'settings.about.configDir': 'Config folder',
  'settings.about.settingsFile': 'Settings',
  'settings.about.connectionsFile': 'Connections',
  'settings.about.mcpFile': 'MCP endpoint',
  'settings.about.pathsHint':
    'Everything Peek writes lives in these files. PEEK_CONFIG_DIR moves them all together.',
  'settings.about.unavailable': 'Unavailable',
} as const

export type SettingsMessages = typeof settings
