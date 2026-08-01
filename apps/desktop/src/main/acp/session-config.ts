/**
 * What a `session/new` call needs: a working directory, and the descriptor that
 * points the agent back at peek's own MCP server.
 *
 * The MCP descriptor is **the closed loop**. Without it the chat panel is a
 * chat panel; with it the agent can read the workspace and drive the window
 * through exactly the same Command Bus the human uses.
 */

import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PEEK_CONFIG_DIR_NAME, peekError } from '@peek/core'
import type { McpEndpointInfo } from './types'

/**
 * The server name the agent prefixes tools with.
 *
 * Tools arrive as `mcp__<name>__<tool>`, so this string is what turns
 * `read_workspace` into `mcp__peek__read_workspace` in every `tool_call` title.
 * Changing it changes what the UI has to strip and what any documentation must
 * say, so it is a constant rather than a setting.
 */
export const PEEK_MCP_SERVER_NAME = 'peek'

/** Subdirectory of `~/.peek` used as the agent's cwd. */
export const CHAT_WORKDIR_NAME = 'chat'

/**
 * The descriptor handed to `session/new` for peek's MCP endpoint.
 *
 * Structurally an ACP `McpServerHttp`, kept as a local type on purpose: the
 * bearer token flows through this object, and a local declaration makes every
 * place it is constructed or logged easy to find. `headers` is an **array of
 * `{name, value}`**, not an object, and it is required even when empty.
 */
export interface PeekMcpServerDescriptor {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/**
 * Build the descriptor, or return null when peek's MCP server is not listening.
 *
 * Null is a real outcome and callers must handle it loudly. `session/new` does
 * **not** fail when an MCP server is unreachable — it degrades and carries on —
 * so a chat created against a dead endpoint yields an agent that cannot see the
 * window, with nothing anywhere to explain why. peek checks first and says so.
 */
export function buildPeekMcpServer(endpoint: McpEndpointInfo | null): PeekMcpServerDescriptor | null {
  if (!endpoint || !endpoint.url || !endpoint.token) return null
  return {
    type: 'http',
    name: PEEK_MCP_SERVER_NAME,
    url: endpoint.url,
    headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
  }
}

/* ================================================================== */
/* The sandbox                                                         */
/* ================================================================== */

/**
 * Agent tools peek refuses outright.
 *
 * Belt to `AGENT_TOOL_PRESET`'s braces. `tools: []` already removes every
 * built-in, but the two options are merged by different rules in the agent
 * (`tools` replaces, `disallowedTools` accumulates), and a future build that
 * loosens the preset should still not be able to hand a database viewer a shell.
 * Listing them is also the readable statement of intent: these are the names a
 * reviewer greps for.
 */
export const AGENT_DISALLOWED_TOOLS: readonly string[] = [
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

/**
 * Built-in tools the session starts with: none.
 *
 * `[]` is the agent SDK's documented "disable all built-in tools". peek's chat
 * panel has exactly one job — talk about the database in front of it and drive
 * the window through peek's own MCP server — and every built-in is either
 * irrelevant to that or actively dangerous in it.
 */
const AGENT_TOOL_PRESET: readonly string[] = []

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
 * peek's MCP descriptor sees exactly twelve tools, all `mcp__peek__*`, each one
 * still going through `requestPermission`.
 *
 * ## Why each field is here
 *
 * - `settingSources: []` — the SDK's isolation mode. No `~/.claude/settings.json`,
 *   no project `.claude/`, no `CLAUDE.md`, no inherited MCP servers, no inherited
 *   permission rules. peek's panel behaves the same on every machine, which is
 *   also what makes the permission dialog mean what it says.
 * - `tools: []` — no built-in tools at all. See `AGENT_TOOL_PRESET`.
 * - `disallowedTools` — the explicit refusal, merged on top. See above.
 * - `mcpServers: {}` — the agent merges `{...options.mcpServers, ...params.mcpServers}`,
 *   so this empties the inherited side while leaving peek's own descriptor (passed
 *   as a `session/new` parameter) untouched.
 *
 * ## What it does not do
 *
 * It is not a substitute for the permission gate. The agent still asks before
 * every `mcp__peek__*` call in `default` mode; this only decides what it is able
 * to ask *for*. Both are needed: the gate without this was gating the wrong
 * surface, and this without the gate would let the agent rewrite the user's
 * layout unasked.
 */
export function buildAgentSessionMeta(): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        settingSources: [],
        tools: [...AGENT_TOOL_PRESET],
        disallowedTools: [...AGENT_DISALLOWED_TOOLS],
        mcpServers: {},
      },
    },
  }
}

/**
 * Create and return the agent's working directory.
 *
 * `cwd` is not cosmetic. It is where the agent looks for project-level
 * `CLAUDE.md`, settings and permission rules, and it is the root its own file
 * tools operate from. A directory peek owns keeps a database viewer's chat panel
 * from inheriting an unrelated project's configuration, and keeps the agent's
 * filesystem reach off the user's home directory. The agent rejects a relative
 * path, an empty string and a path that does not exist, so this creates it
 * eagerly.
 */
export function ensureChatWorkdir(configDir?: string): string {
  const base = configDir ?? join(homedir(), PEEK_CONFIG_DIR_NAME)
  const dir = join(base, CHAT_WORKDIR_NAME)
  let isDirectory: boolean
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    isDirectory = statSync(dir).isDirectory()
  } catch (raw) {
    throw peekError('INTERNAL', `Could not create the chat working directory ${dir}.`, {
      detail: raw instanceof Error ? raw.message : String(raw),
      retryable: false,
    })
  }
  if (!isDirectory) {
    throw peekError('INTERNAL', `The chat working directory ${dir} exists but is not a directory.`, {
      retryable: false,
    })
  }
  return dir
}
