/**
 * One profile per ACP agent: everything peek has to know about a specific agent
 * that is not the protocol itself.
 *
 * ## Why this is not a pair of constants
 *
 * The two agents peek ships with differ in every layer where they could:
 *
 *  - **Process shape.** `claude-agent-acp` is a Node entry module, so it has to
 *    be run by the Electron binary with `ELECTRON_RUN_AS_NODE=1` (see
 *    `agent-process.ts`). `codex-acp` ships its own executable and starts the
 *    Codex App Server behind it. A single `spawn(process.execPath, [entry])`
 *    cannot express both, which is why {@link AcpAgentProfile.resolveSpawn}
 *    returns a whole command rather than a path.
 *  - **Sandbox switch.** Claude Code takes its restrictions through
 *    `_meta.claudeCode.options` on `session/new`; Codex takes its through the
 *    `INITIAL_AGENT_MODE` environment variable. Neither mechanism is part of
 *    ACP, and neither agent understands the other's.
 *  - **How much peek can promise about that sandbox.** See {@link AcpSandbox}.
 *
 * Bundling those into one object per agent means adding a third agent touches
 * this file and the profile list, and nothing else.
 */

import { createRequire } from 'node:module'
import { peekError } from '@peek/core'

/**
 * How far peek is willing to vouch for an agent's sandbox.
 *
 * `enforced` — peek has a probe that runs against the real agent and checks the
 * restrictions actually took. `scripts/verify-chat-security.mjs` is that probe
 * for Claude Code, and the claim is only as good as the probe: it is what makes
 * "the chat panel cannot run a shell" a fact rather than a hope.
 *
 * `unverified` — the switch peek sets is documented by the agent and the
 * semantics line up, but nothing here has checked that it holds. The UI says so,
 * and the permission mode cannot be relaxed to the automatic setting: an agent
 * peek cannot vouch for must not also be one nobody is watching.
 *
 * `relaxed` — **the user turned the sandbox off.** Not a third degree of peek's
 * confidence; a different kind of statement altogether. `unverified` is peek
 * claiming something it has not checked, which is a gap to be closed by writing
 * a probe. `relaxed` has nothing to check: the restrictions are not being asked
 * for. Sharing a tier with `unverified` would have said peek was still trying,
 * and the UI copy would have had nowhere honest to stand.
 *
 * Consequently `relaxed` does **not** inherit `unverified`'s restriction on the
 * automatic permission mode. That rule exists because an agent peek cannot vouch
 * for should not also be one nobody is watching — and here somebody is watching:
 * they went to settings and turned it off. See
 * `docs/design/2026-08-15-chat-panel-full-capability.md` §3.3.
 *
 * See `docs/design/2026-08-03-pluggable-agent-backends.md` §2 for the per-agent
 * account of what each sandbox rests on.
 */
export type AcpSandbox = 'enforced' | 'unverified' | 'relaxed'

/** Per-agent settings a user can change. Kept small on purpose. */
export interface AcpAgentUserConfig {
  /**
   * Overrides the agent's own idea of which underlying binary to run —
   * `CLAUDE_CODE_EXECUTABLE` for Claude Code, `CODEX_PATH` for Codex. Both
   * agents bundle a default and both accept an override, which is what makes
   * this one field rather than two.
   */
  executablePath?: string
  /**
   * Let the agent use its own file and command tools.
   *
   * Off by default, and "off" means the object every profile produced before
   * this field existed — `profiles.test.ts` pins that byte for byte.
   *
   * On, it gives up a guarantee rather than loosening one, and the guarantee is
   * larger than the tool list. `2026-08-02-agent-source-and-permission-scope.md`
   * §2.2 rests the embedded agent's isolation on *this agent having no way to
   * read a file*: the strong bearer token sits in `~/.peek/mcp.json` in the
   * clear, and an agent that can read it stops being `source: 'agent'` and can
   * answer its own permission prompts. One `Read` is the whole chain, which is
   * why there is no per-tool version of this switch — see the design doc §4.2.
   *
   * peek does not defend against that. It reports it: the tier becomes
   * `relaxed`, and the settings panel says plainly what was handed over. Same
   * trade M8 made for packages — what you install runs, and the note beside the
   * button is the whole of the protection. See the design doc §2.5.
   */
  fullTools?: boolean
}

/** What to run, and how. */
export interface AcpSpawnCommand {
  command: string
  args: string[]
  /**
   * `true` when `command` is the Electron binary being used as Node. The process
   * layer adds `ELECTRON_RUN_AS_NODE=1`; without it, spawning `process.execPath`
   * launches a second copy of the app.
   */
  runAsNode?: boolean
}

export interface AcpAgentProfile {
  id: string
  /** Shown in the settings panel and substituted into error messages. */
  displayName: string
  /** Resolve the command that starts the agent. Throws a `PeekError` when absent. */
  resolveSpawn: (config: AcpAgentUserConfig) => AcpSpawnCommand
  /** The `_meta` handed to `session/new` and `session/load`. */
  buildSessionMeta: (config: AcpAgentUserConfig) => Record<string, unknown>
  /** Extra environment for the child process. */
  env: (config: AcpAgentUserConfig) => Record<string, string>
  /**
   * How far peek vouches for this agent **as configured**.
   *
   * A function rather than a constant since 2026-08-15: the answer stopped being
   * a property of the agent once the user could turn its restrictions off. A
   * stored constant would have gone on reporting `enforced` for a session that
   * had a shell in it.
   */
  sandbox: (config: AcpAgentUserConfig) => AcpSandbox
  /**
   * Subdirectory of `~/.peek/chat` this agent works in, or `undefined` for the
   * chat directory itself.
   *
   * Each agent needs its own, because each writes session history under its cwd
   * in its own format and reads that directory back through its own
   * `session/list`; sharing one would have every agent enumerating files written
   * by the others.
   *
   * **This separates the default only.** Since 2026-08-15 a conversation can be
   * pinned to a directory the user chose, and two agents pointed at one project
   * will see each other's session files there — the segment is not applied to a
   * chosen path (`ensureChatWorkdir`), because it is the user's directory and
   * peek does not get to lay out its insides. That is a consequence of saying
   * "work here" twice rather than a hole to plug: what it costs is unreadable
   * rows in one catalogue, and `AcpManager.listSessions` already discards rows a
   * chosen directory holds that peek did not record.
   *
   * **Claude Code deliberately has none.** It was the only agent for the whole
   * life of the chat panel, so every conversation that exists today sits in the
   * chat directory itself. Moving it into a subdirectory would mean either
   * relocating files whose layout belongs to the agent, or silently emptying
   * every user's history. Leaving it in place costs nothing: `listSessions`
   * filters on exact `cwd`, so a second agent working one level down is
   * invisible to it either way.
   */
  workdirSegment?: string
  /** Shown when authentication fails: what the user should go and do. */
  authHelp: string
}

/* ================================================================== */
/* Shared helper                                                       */
/* ================================================================== */

/**
 * Resolve a package's entry with `require.resolve`, rewriting an asar path.
 *
 * `require.resolve` rather than a hard-coded path, so the answer stays right
 * across pnpm's nested layout and a packaged build. When the resolved file sits
 * inside an asar archive the path is rewritten to `app.asar.unpacked`: a child
 * process cannot execute a file that only exists inside the archive, and the
 * packaging config has to unpack these dependencies for the same reason.
 */
export function resolvePackageEntry(specifier: string, agentName: string): string {
  const require = createRequire(import.meta.url)
  let resolved: string
  try {
    resolved = require.resolve(specifier)
  } catch {
    throw peekError('INTERNAL', `The ${agentName} agent package is not installed.`, {
      detail:
        `Could not resolve ${specifier}. ` +
        'Install it, and make sure the packaged build unpacks it from the asar archive.',
      retryable: false,
    })
  }
  return resolved.includes('app.asar') ? resolved.replace('app.asar', 'app.asar.unpacked') : resolved
}

/* ================================================================== */
/* Claude Code                                                         */
/* ================================================================== */

const CLAUDE_PACKAGE_ENTRY = '@agentclientprotocol/claude-agent-acp/dist/index.js'

/**
 * Built-in tools the session starts with: none.
 *
 * `[]` is the agent SDK's documented "disable all built-in tools". peek's chat
 * panel has exactly one job — talk about the database in front of it and drive
 * the window through peek's own MCP server — and every built-in is either
 * irrelevant to that or actively dangerous in it.
 */
const CLAUDE_TOOL_PRESET: readonly string[] = []

/**
 * Agent tools peek refuses outright.
 *
 * Belt to `CLAUDE_TOOL_PRESET`'s braces. `tools: []` already removes every
 * built-in, but the two options are merged by different rules in the agent
 * (`tools` replaces, `disallowedTools` accumulates), and a future build that
 * loosens the preset should still not be able to hand a database viewer a shell.
 * Listing them is also the readable statement of intent: these are the names a
 * reviewer greps for.
 */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
]

export const claudeCodeProfile: AcpAgentProfile = {
  id: 'claude-code',
  displayName: 'Claude Code',
  resolveSpawn: () => ({
    // In Electron, `process.execPath` is the Electron binary, not Node. It only
    // behaves as Node with `ELECTRON_RUN_AS_NODE=1`, which the process layer adds
    // when `runAsNode` is set.
    command: process.execPath,
    args: [resolvePackageEntry(CLAUDE_PACKAGE_ENTRY, 'Claude Code')],
    runAsNode: true,
  }),
  /**
   * What `session/new` must carry so the chat panel is actually a sandbox.
   *
   * ## The bug this exists to close
   *
   * Without it, `claude-agent-acp` applies its own default
   * `settingSources: ['user', 'project', 'local']`, and the session inherits the
   * **whole** of whatever Claude Code configuration the user happens to have:
   * their global `CLAUDE.md`, their MCP servers, and — the part that matters —
   * their permission allowlist. Measured on a developer machine, a chat panel
   * showing "Ask every time" in its own dropdown executed `echo peek-canary-check`
   * with no prompt at all, because the *user's* inherited allowlist had already
   * approved Bash; the same session could see `mcp__postgres__execute_sql`, which
   * is arbitrary un-gated SQL and defeats peek's read-only guarantee outright.
   *
   * With this `_meta` the same probe produces zero tool calls, and a session given
   * peek's MCP descriptor sees peek's own tools and nothing else — every one of
   * them `mcp__peek__*`, every one still going through `requestPermission`.
   *
   * ## Why each field is here
   *
   * - `settingSources: []` — the SDK's isolation mode. No `~/.claude/settings.json`,
   *   no project `.claude/`, no `CLAUDE.md`, no inherited MCP servers, no inherited
   *   permission rules. peek's panel behaves the same on every machine, which is
   *   also what makes the permission dialog mean what it says.
   * - `tools: []` — no built-in tools at all. See {@link CLAUDE_TOOL_PRESET}.
   * - `disallowedTools` — the explicit refusal, merged on top. See above.
   * - `mcpServers: {}` — the agent merges `{...options.mcpServers, ...params.mcpServers}`,
   *   so this empties the inherited side while leaving peek's own descriptor (passed
   *   as a `session/new` parameter) untouched.
   *
   * ## What it does not do
   *
   * It is not a substitute for the permission gate. The agent still asks before
   * every `mcp__peek__*` call in `default` mode; this only decides what it is able
   * to ask *for*.
   *
   * ## What `fullTools` moves, and what it cannot
   *
   * Only the two tool fields. `settingSources: []` is **not** part of the switch
   * and never becomes one: it is what keeps the panel behaving the same on every
   * machine, which is what lets the permission dialog mean what it says. The
   * thing users actually wanted from inheritance — their own MCP servers — comes
   * through peek's own list instead, which is a set of servers someone chose
   * rather than whatever happened to be configured on that machine. See
   * `docs/design/2026-08-15-chat-panel-full-capability.md` §2.3.
   */
  buildSessionMeta: (config) => ({
    claudeCode: {
      options: {
        settingSources: [],
        // Both fields together or neither. `tools` replaces and
        // `disallowedTools` accumulates, so a half-applied pair is not a middle
        // position — it is a session with tools nobody decided on.
        ...(config.fullTools
          ? {}
          : { tools: [...CLAUDE_TOOL_PRESET], disallowedTools: [...CLAUDE_DISALLOWED_TOOLS] }),
        mcpServers: {},
      },
    },
  }),
  env: (config) => {
    // The agent SDK ships a ~245 MB native binary as a platform-specific optional
    // dependency. When a build excludes those, this points the agent at a Claude
    // Code the user already has installed.
    const path = config.executablePath ?? process.env['PEEK_CLAUDE_CODE_EXECUTABLE']
    const env: Record<string, string> = {}
    if (path) env['CLAUDE_CODE_EXECUTABLE'] = path
    return env
  },
  sandbox: (config) => (config.fullTools ? 'relaxed' : 'enforced'),
  authHelp:
    'peek reuses the Claude Code login already on this machine and never handles credentials itself. ' +
    'Run `claude` in a terminal, sign in there, then send the message again.',
}

/* ================================================================== */
/* Codex                                                               */
/* ================================================================== */

const CODEX_PACKAGE_BIN = '@agentclientprotocol/codex-acp/dist/index.js'

export const codexProfile: AcpAgentProfile = {
  id: 'codex',
  displayName: 'Codex',
  resolveSpawn: () => ({
    command: process.execPath,
    args: [resolvePackageEntry(CODEX_PACKAGE_BIN, 'Codex')],
    runAsNode: true,
  }),
  /**
   * Empty, and that is not an omission.
   *
   * Codex's restrictions travel in the environment ({@link codexProfile.env}),
   * not in `session/new`. Sending Claude Code's `_meta` here would be sending an
   * agent a key to a lock it does not have.
   */
  buildSessionMeta: () => ({}),
  env: (config) => {
    const env: Record<string, string> = {
      // Codex's own sandbox tier, and the counterpart to Claude Code's `_meta`.
      //
      // `read-only` is the default and the one that matches what peek promises:
      // the panel talks about the database, it does not edit files or run
      // commands. `agent` is what the same switch buys — Codex's own tier for
      // editing and running things in a workspace.
      //
      // `agent-full-access` is **not** reachable from here at any setting. It
      // drops the workspace boundary and the network restriction both, and
      // nothing in what users asked for needs either; offering it would be
      // peek adding a rung to somebody else's ladder.
      INITIAL_AGENT_MODE: config.fullTools ? 'agent' : 'read-only',
      // peek has no terminal to run a browser login flow in, and declares no
      // `auth.terminal` capability for the same reason. Hiding the method keeps
      // the agent from offering a flow that cannot complete here.
      NO_BROWSER: '1',
    }
    if (config.executablePath) env['CODEX_PATH'] = config.executablePath
    return env
  },
  workdirSegment: 'codex',
  /**
   * `unverified` until a probe exists, and `relaxed` once the switch is on.
   *
   * `INITIAL_AGENT_MODE=read-only` is documented and the semantics match what
   * peek needs, but no equivalent of `verify-chat-security.mjs` has been written
   * for Codex yet, so nothing has *checked* that a read-only Codex session really
   * cannot reach a shell. Until it has, peek says so rather than implying a
   * guarantee it has not tested.
   *
   * `relaxed` wins over `unverified` when both apply, and the order matters:
   * "peek has not verified this sandbox" is beside the point once the sandbox is
   * the one the user asked not to have. The panel still shows both sentences —
   * see `settings.agent.relaxed` — but the tier reports the decision, not the
   * gap.
   */
  sandbox: (config) => (config.fullTools ? 'relaxed' : 'unverified'),
  authHelp:
    'peek reuses the Codex login already on this machine and never handles credentials itself. ' +
    'Run `codex` in a terminal and sign in there, or set OPENAI_API_KEY in the environment, ' +
    'then send the message again.',
}

/* ================================================================== */
/* The list                                                            */
/* ================================================================== */

export const ACP_PROFILES: readonly AcpAgentProfile[] = [claudeCodeProfile, codexProfile]

export const DEFAULT_ACP_PROFILE_ID = claudeCodeProfile.id

/**
 * Look up a profile, falling back to the default.
 *
 * A settings file naming an agent this build does not have is a wrong setting,
 * not a reason to leave the user without a chat panel. The fallback is the agent
 * whose sandbox is `enforced` at its default configuration, so a bad id can
 * never by itself land on a weaker one. Only the switch does that, and only
 * because someone set it.
 */
export function profileById(id: string | undefined): AcpAgentProfile {
  return ACP_PROFILES.find((p) => p.id === id) ?? claudeCodeProfile
}
